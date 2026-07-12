import type {
  KernelComputeNode,
  KernelNode,
  KernelNodeInput,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
} from './compiler.js';
import { VfxDiagnosticError } from './diagnostics.js';
import type {
  Grid3DChannelLayout,
  Grid3DDefinition,
  Grid3DMemoryEstimate,
  Grid3DRuntimeView,
  Grid3DSnapshot,
  Grid3DStageFunctionRef,
  Grid3DStageModuleDefinition,
  JsonValue,
  SimStageDefinition,
  Vec3,
  VfxDiagnostic,
} from './types.js';

export const GRID3D_WORKGROUP_SIZE = 64;
export const GRID3D_FIXED_POINT_SCALE = 4096;

export interface Grid3DStageContext {
  readonly cell: readonly [KernelNode, KernelNode, KernelNode];
  readonly deltaTime: KernelNode;
  readonly index: KernelNode;
  read(channel: string): KernelNode | readonly [KernelNode, KernelNode, KernelNode];
  sample(
    channel: string,
    cell: readonly [KernelNode, KernelNode, KernelNode],
  ): KernelNode | readonly [KernelNode, KernelNode, KernelNode];
}

export type Grid3DStageFactory = (
  context: Grid3DStageContext,
) => Readonly<Record<string, KernelNode | readonly [KernelNode, KernelNode, KernelNode]>>;

export interface Grid3DStageFunctionRegistration {
  readonly factory: Grid3DStageFactory;
  readonly kind: 'grid3d-function-registration';
  readonly ref: Grid3DStageFunctionRef;
}

export class Grid3DStageRegistry {
  readonly #factories = new Map<string, Grid3DStageFactory>();

  register(registration: Grid3DStageFunctionRegistration): this {
    const key = `${registration.ref.id}@${registration.ref.version}`;
    const existing = this.#factories.get(key);
    if (existing && existing !== registration.factory) {
      throw new Error(`Grid3D stage function registration conflict for ${key}.`);
    }
    this.#factories.set(key, registration.factory);
    return this;
  }

  resolve(reference: Grid3DStageFunctionRef): Grid3DStageFactory | undefined {
    return this.#factories.get(`${reference.id}@${reference.version}`);
  }
}

export function defineGrid3DStageFunction(
  id: string,
  factory: Grid3DStageFactory,
  version = 1,
): Grid3DStageFunctionRegistration {
  if (id.length === 0 || !Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('Grid3D stage function IDs must be non-empty and versions positive.');
  }
  return {
    factory,
    kind: 'grid3d-function-registration',
    ref: { id, kind: 'grid3d-function-ref', version },
  };
}

export function grid3DTslModule(
  source: Grid3DStageFactory | Grid3DStageFunctionRef | Grid3DStageFunctionRegistration,
): Grid3DStageModuleDefinition {
  if (typeof source === 'function') {
    const module: Grid3DStageModuleDefinition = {
      config: {},
      kind: 'grid3d-stage-module',
      source: 'inline',
      version: 1,
    };
    Object.defineProperty(module, 'factory', { enumerable: false, value: source });
    return module;
  }
  const reference = source.kind === 'grid3d-function-registration' ? source.ref : source;
  return {
    config: {},
    kind: 'grid3d-stage-module',
    source: reference,
    version: 1,
  };
}

function builtin<Config extends object>(
  source: string,
  config: Config,
): Grid3DStageModuleDefinition<Config> {
  return { config, kind: 'grid3d-stage-module', source, version: 1 };
}

export interface Grid3DAdvectOptions {
  /** Exponential decay rates in inverse seconds, keyed by channel. */
  readonly dissipation?: Readonly<Record<string, number>>;
  /** Vec3 channel measured in grid cells per second. */
  readonly velocity?: string;
}

export function grid3DAdvect(
  options: Grid3DAdvectOptions = {},
): Grid3DStageModuleDefinition<Grid3DAdvectOptions> {
  return builtin('core/grid3d-advect', options);
}

export interface Grid3DBuoyancyOptions {
  readonly density?: string;
  readonly densityWeight?: number;
  readonly temperature?: string;
  readonly temperatureBuoyancy?: number;
  readonly velocity?: string;
}

export function grid3DBuoyancy(
  options: Grid3DBuoyancyOptions = {},
): Grid3DStageModuleDefinition<Grid3DBuoyancyOptions> {
  return builtin('core/grid3d-buoyancy', options);
}

export interface Grid3DSourceOptions {
  /** Normalized coordinate in the x/y/z volume. */
  readonly center: Vec3;
  /** Radius in normalized volume coordinates. */
  readonly radius: number;
  /** Per-second additions; velocity vec3 values are grid cells per second. */
  readonly values: Readonly<Record<string, number | Vec3>>;
}

export function grid3DInject(
  options: Grid3DSourceOptions,
): Grid3DStageModuleDefinition<Grid3DSourceOptions> {
  return builtin('core/grid3d-inject', options);
}

export interface Grid3DPressureOptions {
  readonly pressure?: string;
  readonly velocity?: string;
}

export function grid3DPressureJacobi(
  options: Grid3DPressureOptions = {},
): Grid3DStageModuleDefinition<Grid3DPressureOptions> {
  return builtin('core/grid3d-pressure-jacobi', options);
}

export function grid3DProjectVelocity(
  options: Grid3DPressureOptions = {},
): Grid3DStageModuleDefinition<Grid3DPressureOptions> {
  return builtin('core/grid3d-project-velocity', options);
}

function validateResolution(resolution: readonly [number, number, number]): void {
  if (resolution.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError('Grid3D resolution must contain three positive safe integers.');
  }
  const cells = resolution[0] * resolution[1] * resolution[2];
  if (!Number.isSafeInteger(cells)) {
    throw new RangeError('Grid3D cell count exceeds the safe integer range.');
  }
}

export function grid3DCellIndex(
  x: number,
  y: number,
  z: number,
  resolution: readonly [number, number, number],
): number {
  validateResolution(resolution);
  const [width, height, depth] = resolution;
  if (
    !Number.isSafeInteger(x) ||
    x < 0 ||
    x >= width ||
    !Number.isSafeInteger(y) ||
    y < 0 ||
    y >= height ||
    !Number.isSafeInteger(z) ||
    z < 0 ||
    z >= depth
  ) {
    throw new RangeError(`Grid3D cell (${x}, ${y}, ${z}) is outside ${width}x${height}x${depth}.`);
  }
  return (z * height + y) * width + x;
}

/** CPU mirror of clamp-boundary, cell-centered trilinear sampling. */
export function sampleGrid3DTrilinear(
  values: ArrayLike<number>,
  resolution: readonly [number, number, number],
  cell: readonly [number, number, number],
): number {
  validateResolution(resolution);
  const [width, height, depth] = resolution;
  if (values.length < width * height * depth)
    throw new RangeError('Grid3D sample array is too short.');
  const x = Math.min(width - 1, Math.max(0, cell[0]));
  const y = Math.min(height - 1, Math.max(0, cell[1]));
  const z = Math.min(depth - 1, Math.max(0, cell[2]));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const z1 = Math.min(depth - 1, z0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const mix = (left: number, right: number, amount: number) => left * (1 - amount) + right * amount;
  const at = (cx: number, cy: number, cz: number) =>
    values[grid3DCellIndex(cx, cy, cz, resolution)] ?? 0;
  const z0Value = mix(
    mix(at(x0, y0, z0), at(x1, y0, z0), tx),
    mix(at(x0, y1, z0), at(x1, y1, z0), tx),
    ty,
  );
  const z1Value = mix(
    mix(at(x0, y0, z1), at(x1, y0, z1), tx),
    mix(at(x0, y1, z1), at(x1, y1, z1), tx),
    ty,
  );
  return mix(z0Value, z1Value, tz);
}

/** CPU reference for nearest-cell particle deposition, used to validate GPU raster stages. */
export function rasterizeGrid3DPoints(
  points: readonly Vec3[],
  resolution: readonly [number, number, number],
  value = 1,
): Float32Array {
  validateResolution(resolution);
  const [width, height, depth] = resolution;
  const result = new Float32Array(width * height * depth);
  for (const [u, v, w] of points) {
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
    const z = Math.min(depth - 1, Math.max(0, Math.floor(w * depth)));
    result[grid3DCellIndex(x, y, z, resolution)]! += value;
  }
  return result;
}

export function resolveGrid3DChannelLayout(
  definition: Grid3DDefinition,
): readonly Grid3DChannelLayout[] {
  const diagnostics = diagnosticsForDefinition(definition);
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  const layouts: Grid3DChannelLayout[] = [];
  let group = 0;
  let offset = 0;
  for (const [name, channel] of Object.entries(definition.channels)) {
    const components = channel.type === 'vec3' ? 3 : 1;
    if (offset + components > 4) {
      group += 1;
      offset = 0;
    }
    layouts.push({
      components,
      group,
      name,
      offset: offset as 0 | 1 | 2 | 3,
      type: channel.type,
    });
    offset += components;
    if (offset === 4) {
      group += 1;
      offset = 0;
    }
  }
  return layouts;
}

export function estimateGrid3DMemory(definition: Grid3DDefinition): Grid3DMemoryEstimate {
  const layouts = resolveGrid3DChannelLayout(definition);
  const cellCount = definition.resolution.reduce((product, value) => product * value, 1);
  const channelGroups = Math.max(...layouts.map(({ group }) => group)) + 1;
  const stateBufferBytes = cellCount * channelGroups * 16;
  const scratchBufferBytes = stateBufferBytes;
  // Transfer positions deliberately use vec4 records to keep backend storage stride explicit.
  const particlePositionBytes = cellCount * 16;
  const particleSampleBytes = cellCount * 4;
  const particleAtomicBytes = cellCount * 4;
  return {
    cellCount,
    channelGroups,
    particleAtomicBytes,
    particlePositionBytes,
    particleSampleBytes,
    scratchBufferBytes,
    stateBufferBytes,
    totalBytes:
      stateBufferBytes +
      scratchBufferBytes +
      particlePositionBytes +
      particleSampleBytes +
      particleAtomicBytes,
  };
}

function diagnosticsForDefinition(definition: Grid3DDefinition): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const resolution = definition.resolution;
  if (
    resolution.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !Number.isSafeInteger(resolution[0] * resolution[1] * resolution[2])
  ) {
    diagnostics.push({
      code: 'NACHI_GRID3D_RESOLUTION_INVALID',
      message: 'Grid3D resolution must contain three positive safe integers with a safe product.',
      path: 'resolution',
      phase: 'compile',
      severity: 'error',
    });
  }
  let lanes = 0;
  for (const [name, channel] of Object.entries(definition.channels)) {
    if (name.length === 0 || (channel.type !== 'f32' && channel.type !== 'vec3')) {
      diagnostics.push({
        code: 'NACHI_GRID3D_CHANNEL_INVALID',
        message: `Grid3D channel "${name}" must use f32 or vec3.`,
        path: `channels.${name}`,
        phase: 'compile',
        severity: 'error',
      });
    }
    lanes += channel.type === 'vec3' ? 3 : 1;
  }
  if (lanes === 0) {
    diagnostics.push({
      code: 'NACHI_GRID3D_CHANNEL_INVALID',
      message: 'Grid3D requires at least one channel.',
      path: 'channels',
      phase: 'compile',
      severity: 'error',
    });
  }
  return diagnostics;
}

type GridRenderer = {
  readonly kernelAdapter: KernelTslAdapter;
  readStorage?(storage: KernelStorageNode): Promise<ArrayBuffer>;
  releaseStorage?(storage: KernelStorageNode): void;
  setUniformValue?(uniform: KernelUniformNode, path: 'System.deltaTime', value: unknown): void;
  submitCompute(kernel: KernelComputeNode): Promise<void> | void;
  writeStorage?(storage: KernelStorageNode, data: ArrayBufferView, byteOffset?: number): void;
  flushStorageWrites?(): Promise<void> | void;
};

type BuiltGridStage = {
  readonly commit: KernelComputeNode;
  readonly deltaTime: KernelUniformNode;
  readonly stage: KernelComputeNode;
};

function lane(node: KernelNode, offset: number): KernelNode {
  return offset === 0 ? node.x : offset === 1 ? node.y : offset === 2 ? node.z : node.w;
}

function vector(adapter: KernelTslAdapter, values: readonly KernelNode[]): KernelNode {
  return adapter.vec4(values[0]!, values[1]!, values[2]!, values[3]!);
}

function requireGridOperations(adapter: KernelTslAdapter): asserts adapter is KernelTslAdapter & {
  floor(value: KernelNodeInput): KernelNode;
  mod(value: KernelNodeInput, divisor: KernelNodeInput): KernelNode;
} {
  if (!adapter.floor || !adapter.mod) {
    throw new Error('Grid3D requires floor/mod support from the pinned TSL adapter.');
  }
}

function stageFactory(
  module: Grid3DStageModuleDefinition,
  registry: Grid3DStageRegistry | undefined,
): Grid3DStageFactory | undefined {
  if (typeof module.source === 'object') return registry?.resolve(module.source);
  if (module.source !== 'inline') return undefined;
  return (module as Grid3DStageModuleDefinition & { readonly factory?: Grid3DStageFactory })
    .factory;
}

function buildStage(
  adapter: KernelTslAdapter,
  definition: Grid3DDefinition,
  layouts: readonly Grid3DChannelLayout[],
  state: KernelStorageNode,
  scratch: KernelStorageNode,
  declaration: SimStageDefinition & { readonly update: Grid3DStageModuleDefinition },
  registry: Grid3DStageRegistry | undefined,
  stageIndex: number,
): BuiltGridStage {
  requireGridOperations(adapter);
  const [width, height, depth] = definition.resolution;
  const cells = width * height * depth;
  const groupCount = Math.max(...layouts.map(({ group }) => group)) + 1;
  const byName = new Map(layouts.map((layout) => [layout.name, layout] as const));
  const stageDiagnostic = (code: string, message: string, path: string): never => {
    throw new VfxDiagnosticError([
      {
        code,
        message,
        path: `stages[${stageIndex}].update.${path}`,
        phase: 'compile',
        severity: 'error',
      },
    ]);
  };
  const deltaTime = adapter.uniform(0, 'float');
  const index = adapter.instanceIndex;
  const x = adapter.mod(index, width);
  const yz = index.div(width);
  const y = adapter.mod(yz, height);
  const z = yz.div(height);
  const cellIndex = (cx: KernelNode, cy: KernelNode, cz: KernelNode) =>
    adapter.uint(cz).mul(height).add(adapter.uint(cy)).mul(width).add(adapter.uint(cx));
  const stateElement = (address: KernelNode, group: number) =>
    state.element(address.mul(groupCount).add(group));
  const read = (
    channel: string,
    address = index,
  ): KernelNode | readonly [KernelNode, KernelNode, KernelNode] => {
    const layout = byName.get(channel);
    if (!layout) {
      return stageDiagnostic(
        'NACHI_GRID3D_STAGE_CHANNEL_UNDECLARED',
        `Grid3D channel "${channel}" is not declared.`,
        `read.${channel}`,
      );
    }
    const record = stateElement(address, layout.group);
    return layout.components === 1
      ? lane(record, layout.offset)
      : [
          lane(record, layout.offset),
          lane(record, layout.offset + 1),
          lane(record, layout.offset + 2),
        ];
  };
  const sample = (channel: string, cell: readonly [KernelNode, KernelNode, KernelNode]) => {
    const sx = cell[0].clamp(0, width - 1);
    const sy = cell[1].clamp(0, height - 1);
    const sz = cell[2].clamp(0, depth - 1);
    const x0 = adapter.floor(sx);
    const y0 = adapter.floor(sy);
    const z0 = adapter.floor(sz);
    const x1 = x0.add(1).clamp(0, width - 1);
    const y1 = y0.add(1).clamp(0, height - 1);
    const z1 = z0.add(1).clamp(0, depth - 1);
    const tx = sx.sub(x0);
    const ty = sy.sub(y0);
    const tz = sz.sub(z0);
    const one = adapter.constant(1, 'f32');
    const mixOne = (component: number): KernelNode => {
      const at = (cx: KernelNode, cy: KernelNode, cz: KernelNode) => {
        const value = read(channel, cellIndex(cx, cy, cz));
        return Array.isArray(value) ? value[component]! : value;
      };
      const mixX = (cy: KernelNode, cz: KernelNode) =>
        at(x0, cy, cz)
          .mul(one.sub(tx))
          .add(at(x1, cy, cz).mul(tx));
      const mixY = (cz: KernelNode) => mixX(y0, cz).mul(one.sub(ty)).add(mixX(y1, cz).mul(ty));
      return mixY(z0).mul(one.sub(tz)).add(mixY(z1).mul(tz));
    };
    return byName.get(channel)!.components === 1
      ? mixOne(0)
      : ([mixOne(0), mixOne(1), mixOne(2)] as const);
  };
  const customFactory = stageFactory(declaration.update, registry);
  const moduleConfig = declaration.update.config as Record<string, unknown>;
  const kernel = adapter
    .fn(() => {
      adapter.branch(index.lessThan(cells), () => {
        const changed = new Map<string, readonly KernelNode[]>();
        const set = (name: string, value: KernelNode | readonly KernelNode[]) => {
          const layout = byName.get(name);
          if (!layout) {
            return stageDiagnostic(
              'NACHI_GRID3D_STAGE_WRITE_CHANNEL_UNDECLARED',
              `Grid3D stage writes undeclared channel "${name}".`,
              `result.${name}`,
            );
          }
          const values = Array.isArray(value) ? value : [value];
          if (values.length !== layout.components) {
            stageDiagnostic(
              'NACHI_GRID3D_STAGE_WRITE_COMPONENTS_INVALID',
              `Grid3D stage channel "${name}" requires ${layout.components} component(s); received ${values.length}.`,
              `result.${name}`,
            );
          }
          changed.set(name, values);
        };
        const source = declaration.update.source;
        if (customFactory) {
          const result = customFactory({
            cell: [x.toFloat(), y.toFloat(), z.toFloat()],
            deltaTime,
            index,
            read,
            sample,
          });
          for (const [name, value] of Object.entries(result)) set(name, value);
        } else if (source === 'core/grid3d-inject') {
          const center = moduleConfig.center as Vec3;
          const radius = Number(moduleConfig.radius);
          const nx = x.toFloat().add(0.5).div(width);
          const ny = y.toFloat().add(0.5).div(height);
          const nz = z.toFloat().add(0.5).div(depth);
          const inside = nx
            .sub(center[0])
            .mul(nx.sub(center[0]))
            .add(ny.sub(center[1]).mul(ny.sub(center[1])))
            .add(nz.sub(center[2]).mul(nz.sub(center[2])))
            .lessThanEqual(radius * radius);
          for (const [name, authored] of Object.entries(
            moduleConfig.values as Record<string, number | Vec3>,
          )) {
            const current = read(name);
            if (Array.isArray(current)) {
              const value = authored as Vec3;
              set(name, [
                current[0].add(adapter.select(inside, value[0], 0).mul(deltaTime)),
                current[1].add(adapter.select(inside, value[1], 0).mul(deltaTime)),
                current[2].add(adapter.select(inside, value[2], 0).mul(deltaTime)),
              ]);
            } else {
              set(
                name,
                (current as KernelNode).add(
                  adapter.select(inside, Number(authored), 0).mul(deltaTime),
                ),
              );
            }
          }
        } else if (source === 'core/grid3d-advect') {
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode, KernelNode];
          const back = [
            x.toFloat().sub(velocity[0].mul(deltaTime)),
            y.toFloat().sub(velocity[1].mul(deltaTime)),
            z.toFloat().sub(velocity[2].mul(deltaTime)),
          ] as const;
          const dissipation = (moduleConfig.dissipation ?? {}) as Record<string, number>;
          for (const layout of layouts) {
            const sampled = sample(layout.name, back);
            const decay = adapter
              .constant(Math.E, 'f32')
              .pow(deltaTime.mul(-(dissipation[layout.name] ?? 0)));
            set(
              layout.name,
              Array.isArray(sampled)
                ? [sampled[0].mul(decay), sampled[1].mul(decay), sampled[2].mul(decay)]
                : (sampled as KernelNode).mul(decay),
            );
          }
        } else if (source === 'core/grid3d-buoyancy') {
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode, KernelNode];
          const density = read(String(moduleConfig.density ?? 'density')) as KernelNode;
          const temperature = read(String(moduleConfig.temperature ?? 'temperature')) as KernelNode;
          const force = temperature
            .mul(Number(moduleConfig.temperatureBuoyancy ?? 1))
            .sub(density.mul(Number(moduleConfig.densityWeight ?? 0.1)));
          set(velocityName, [velocity[0], velocity[1].add(force.mul(deltaTime)), velocity[2]]);
        } else if (source === 'core/grid3d-pressure-jacobi') {
          const pressureName = String(moduleConfig.pressure ?? 'pressure');
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const left = x
            .toFloat()
            .sub(1)
            .clamp(0, width - 1);
          const right = x
            .toFloat()
            .add(1)
            .clamp(0, width - 1);
          const down = y
            .toFloat()
            .sub(1)
            .clamp(0, height - 1);
          const up = y
            .toFloat()
            .add(1)
            .clamp(0, height - 1);
          const back = z
            .toFloat()
            .sub(1)
            .clamp(0, depth - 1);
          const front = z
            .toFloat()
            .add(1)
            .clamp(0, depth - 1);
          const at = (cx: KernelNode, cy: KernelNode, cz: KernelNode, channel: string) =>
            read(channel, cellIndex(cx, cy, cz));
          const pL = at(left, y.toFloat(), z.toFloat(), pressureName) as KernelNode;
          const pR = at(right, y.toFloat(), z.toFloat(), pressureName) as KernelNode;
          const pD = at(x.toFloat(), down, z.toFloat(), pressureName) as KernelNode;
          const pU = at(x.toFloat(), up, z.toFloat(), pressureName) as KernelNode;
          const pB = at(x.toFloat(), y.toFloat(), back, pressureName) as KernelNode;
          const pF = at(x.toFloat(), y.toFloat(), front, pressureName) as KernelNode;
          const vL = at(left, y.toFloat(), z.toFloat(), velocityName) as readonly KernelNode[];
          const vR = at(right, y.toFloat(), z.toFloat(), velocityName) as readonly KernelNode[];
          const vD = at(x.toFloat(), down, z.toFloat(), velocityName) as readonly KernelNode[];
          const vU = at(x.toFloat(), up, z.toFloat(), velocityName) as readonly KernelNode[];
          const vB = at(x.toFloat(), y.toFloat(), back, velocityName) as readonly KernelNode[];
          const vF = at(x.toFloat(), y.toFloat(), front, velocityName) as readonly KernelNode[];
          const divergence = vR[0]!
            .sub(vL[0]!)
            .add(vU[1]!.sub(vD[1]!))
            .add(vF[2]!.sub(vB[2]!))
            .mul(0.5);
          set(pressureName, pL.add(pR).add(pD).add(pU).add(pB).add(pF).sub(divergence).div(6));
        } else if (source === 'core/grid3d-project-velocity') {
          const pressureName = String(moduleConfig.pressure ?? 'pressure');
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const pressureAt = (cx: KernelNode, cy: KernelNode, cz: KernelNode) =>
            read(pressureName, cellIndex(cx, cy, cz)) as KernelNode;
          const pL = pressureAt(
            x
              .toFloat()
              .sub(1)
              .clamp(0, width - 1),
            y.toFloat(),
            z.toFloat(),
          );
          const pR = pressureAt(
            x
              .toFloat()
              .add(1)
              .clamp(0, width - 1),
            y.toFloat(),
            z.toFloat(),
          );
          const pD = pressureAt(
            x.toFloat(),
            y
              .toFloat()
              .sub(1)
              .clamp(0, height - 1),
            z.toFloat(),
          );
          const pU = pressureAt(
            x.toFloat(),
            y
              .toFloat()
              .add(1)
              .clamp(0, height - 1),
            z.toFloat(),
          );
          const pB = pressureAt(
            x.toFloat(),
            y.toFloat(),
            z
              .toFloat()
              .sub(1)
              .clamp(0, depth - 1),
          );
          const pF = pressureAt(
            x.toFloat(),
            y.toFloat(),
            z
              .toFloat()
              .add(1)
              .clamp(0, depth - 1),
          );
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode, KernelNode];
          set(velocityName, [
            velocity[0].sub(pR.sub(pL).mul(0.5)),
            velocity[1].sub(pU.sub(pD).mul(0.5)),
            velocity[2].sub(pF.sub(pB).mul(0.5)),
          ]);
        } else {
          throw new Error(
            `Unknown Grid3D stage source ${typeof source === 'string' ? source : `${source.id}@${source.version}`}.`,
          );
        }
        for (let group = 0; group < groupCount; group += 1) {
          const input = stateElement(index, group);
          const lanes: KernelNode[] = [input.x, input.y, input.z, input.w];
          for (const layout of layouts.filter((candidate) => candidate.group === group)) {
            const values = changed.get(layout.name);
            if (!values) continue;
            for (let component = 0; component < layout.components; component += 1) {
              lanes[layout.offset + component] = values[component]!;
            }
          }
          scratch.element(index.mul(groupCount).add(group)).assign(vector(adapter, lanes));
        }
      });
    })
    .compute(cells, [GRID3D_WORKGROUP_SIZE])
    .setName('NachiGrid3DStage');
  const commit = adapter
    .fn(() => {
      adapter.branch(index.lessThan(cells), () => {
        for (let group = 0; group < groupCount; group += 1) {
          const address = index.mul(groupCount).add(group);
          state.element(address).assign(scratch.element(address));
        }
      });
    })
    .compute(cells, [GRID3D_WORKGROUP_SIZE])
    .setName('NachiGrid3DCommit');
  return { commit, deltaTime, stage: kernel };
}

function isGrid3DStage(
  stage: SimStageDefinition,
): stage is SimStageDefinition & { readonly update: Grid3DStageModuleDefinition } {
  return stage.update.kind === 'grid3d-stage-module';
}

export class Grid3DRuntime implements Grid3DRuntimeView {
  readonly #clear: KernelComputeNode;
  readonly #layouts: readonly Grid3DChannelLayout[];
  readonly #renderer: GridRenderer;
  readonly #scratch: KernelStorageNode;
  readonly #stages: readonly {
    readonly declaration: SimStageDefinition & { readonly update: Grid3DStageModuleDefinition };
    readonly kernels: BuiltGridStage;
  }[];
  readonly #state: KernelStorageNode;
  readonly #particleAtomic: KernelStorageNode;
  readonly #particleCount: KernelUniformNode;
  readonly #particlePositions: KernelStorageNode;
  readonly #particleSamples: KernelStorageNode;
  readonly #particleReset: KernelComputeNode;
  readonly #particleRasterize: KernelComputeNode;
  readonly #particleValue: KernelUniformNode;
  readonly #particleResolve = new Map<string, KernelComputeNode>();
  readonly #particleSample = new Map<string, KernelComputeNode>();
  readonly memoryEstimate: Grid3DMemoryEstimate;
  #initialized = false;
  #submissionCount = 0;

  constructor(
    readonly definition: Grid3DDefinition,
    renderer: GridRenderer,
    stages: readonly SimStageDefinition[],
    registry?: Grid3DStageRegistry,
  ) {
    const definitionDiagnostics = diagnosticsForDefinition(definition);
    const diagnostics = [...definitionDiagnostics];
    if (renderer.kernelAdapter.capabilities.backend !== 'webgpu') {
      diagnostics.push({
        code: 'NACHI_GRID3D_WEBGL2_UNSUPPORTED',
        message:
          'Grid3D storage-buffer simulation requires WebGPU; WebGL2 transform feedback cannot provide arbitrary volume read/write or atomics.',
        path: 'grid3d',
        phase: 'compile',
        severity: 'error',
      });
    }
    let memoryEstimate: Grid3DMemoryEstimate | undefined;
    if (definitionDiagnostics.length === 0) {
      memoryEstimate = estimateGrid3DMemory(definition);
      const limits = renderer.kernelAdapter.deviceLimits;
      const bindingLimit = limits?.maxStorageBufferBindingSize;
      const bufferLimit = limits?.maxBufferSize;
      const largestBuffer = Math.max(
        memoryEstimate.stateBufferBytes,
        memoryEstimate.particlePositionBytes,
      );
      const activeLimits = [bindingLimit, bufferLimit].filter(
        (value): value is number => value !== undefined,
      );
      const allocationLimit = activeLimits.length > 0 ? Math.min(...activeLimits) : undefined;
      if (allocationLimit !== undefined && largestBuffer > allocationLimit) {
        diagnostics.push({
          code: 'NACHI_GRID3D_STORAGE_LIMIT_EXCEEDED',
          message: `Grid3D requires a ${largestBuffer}-byte storage binding, exceeding the active device buffer limit ${allocationLimit}.`,
          path: 'grid3d.resolution',
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    for (const [index, stage] of stages.entries()) {
      if (!isGrid3DStage(stage)) {
        diagnostics.push({
          code: 'NACHI_SIM_STAGE_TARGET_KIND_MISMATCH',
          message: 'A Grid3D target requires a grid3d-stage-module update.',
          path: `stages[${index}].update.kind`,
          phase: 'compile',
          severity: 'error',
        });
        continue;
      }
      if (!Number.isSafeInteger(stage.iterations) || stage.iterations <= 0) {
        diagnostics.push({
          code: 'NACHI_SIM_STAGE_ITERATIONS_INVALID',
          message: 'Simulation-stage iterations must be a positive safe integer.',
          path: `stages[${index}].iterations`,
          phase: 'compile',
          severity: 'error',
        });
      }
      if (
        typeof stage.update.source === 'object' &&
        registry?.resolve(stage.update.source) === undefined
      ) {
        diagnostics.push({
          code: 'NACHI_GRID3D_STAGE_FUNCTION_UNRESOLVED',
          message: `Grid3D stage function "${stage.update.source.id}@${stage.update.source.version}" is not registered.`,
          path: `stages[${index}].update.source`,
          phase: 'compile',
          severity: 'error',
        });
      }
      if (stage.update.source === 'inline' && stageFactory(stage.update, registry) === undefined) {
        diagnostics.push({
          code: 'NACHI_GRID3D_STAGE_FUNCTION_UNRESOLVED',
          message: 'Inline Grid3D stage factory metadata is unavailable.',
          path: `stages[${index}].update.source`,
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
    this.memoryEstimate = memoryEstimate!;
    this.#renderer = renderer;
    this.#layouts = resolveGrid3DChannelLayout(definition);
    const groups = this.memoryEstimate.channelGroups;
    const cells = this.memoryEstimate.cellCount;
    const [width, height, depth] = definition.resolution;
    const adapter = renderer.kernelAdapter;
    this.#state = adapter.instancedArray(cells * groups, 'vec4').setName('NachiGrid3DState');
    this.#scratch = adapter.instancedArray(cells * groups, 'vec4').setName('NachiGrid3DScratch');
    this.#particlePositions = adapter
      .instancedArray(cells, 'vec4')
      .setName('NachiGrid3DParticlePositions');
    this.#particleSamples = adapter
      .instancedArray(cells, 'float')
      .setName('NachiGrid3DParticleSamples');
    this.#particleAtomic = adapter
      .instancedArray(cells, 'uint')
      .setName('NachiGrid3DParticleAtomic')
      .toAtomic();
    this.#particleCount = adapter.uniform(0, 'uint');
    this.#particleValue = adapter.uniform(1, 'float');
    const index = adapter.instanceIndex;
    const defaults = new Map<string, readonly number[]>();
    for (const layout of this.#layouts) {
      const authored = definition.channels[layout.name]!.default;
      defaults.set(layout.name, Array.isArray(authored) ? authored : [Number(authored ?? 0)]);
    }
    this.#clear = adapter
      .fn(() => {
        adapter.branch(index.lessThan(cells), () => {
          for (let group = 0; group < groups; group += 1) {
            const lanes = [0, 0, 0, 0];
            for (const layout of this.#layouts.filter((candidate) => candidate.group === group)) {
              const values = defaults.get(layout.name)!;
              for (let component = 0; component < layout.components; component += 1) {
                lanes[layout.offset + component] = values[component] ?? 0;
              }
            }
            const value = adapter.constant(lanes, 'vec4');
            const address = index.mul(groups).add(group);
            this.#state.element(address).assign(value);
            this.#scratch.element(address).assign(value);
          }
        });
      })
      .compute(cells, [GRID3D_WORKGROUP_SIZE])
      .setName('NachiGrid3DClear');
    requireGridOperations(adapter);
    this.#particleReset = adapter
      .fn(() => {
        adapter.branch(index.lessThan(cells), () => {
          adapter.atomicStore(this.#particleAtomic.element(index), 0);
        });
      })
      .compute(cells, [GRID3D_WORKGROUP_SIZE])
      .setName('NachiGrid3DParticleReset');
    this.#particleRasterize = adapter
      .fn(() => {
        adapter.branch(index.lessThan(cells).and(index.lessThan(this.#particleCount)), () => {
          const point = this.#particlePositions.element(index);
          const px = adapter.floor!(point.x.clamp(0, 0.999999).mul(width));
          const py = adapter.floor!(point.y.clamp(0, 0.999999).mul(height));
          const pz = adapter.floor!(point.z.clamp(0, 0.999999).mul(depth));
          const target = this.#particleAtomic.element(
            adapter.uint(pz).mul(height).add(adapter.uint(py)).mul(width).add(adapter.uint(px)),
          );
          adapter.atomicAdd(
            target,
            adapter.uint(this.#particleValue.mul(GRID3D_FIXED_POINT_SCALE)),
          );
        });
      })
      .compute(cells, [GRID3D_WORKGROUP_SIZE])
      .setName('NachiGrid3DParticleRasterize');
    for (const layout of this.#layouts.filter(({ components }) => components === 1)) {
      this.#particleResolve.set(
        layout.name,
        adapter
          .fn(() => {
            adapter.branch(index.lessThan(cells), () => {
              const record = this.#state.element(index.mul(groups).add(layout.group));
              lane(record, layout.offset).addAssign(
                adapter
                  .atomicLoad(this.#particleAtomic.element(index))
                  .toFloat()
                  .div(GRID3D_FIXED_POINT_SCALE),
              );
            });
          })
          .compute(cells, [GRID3D_WORKGROUP_SIZE])
          .setName(`NachiGrid3DParticleResolve_${layout.name}`),
      );
      this.#particleSample.set(
        layout.name,
        adapter
          .fn(() => {
            adapter.branch(index.lessThan(cells).and(index.lessThan(this.#particleCount)), () => {
              const point = this.#particlePositions.element(index);
              const sx = point.x
                .mul(width)
                .sub(0.5)
                .clamp(0, width - 1);
              const sy = point.y
                .mul(height)
                .sub(0.5)
                .clamp(0, height - 1);
              const sz = point.z
                .mul(depth)
                .sub(0.5)
                .clamp(0, depth - 1);
              const x0 = adapter.floor!(sx);
              const y0 = adapter.floor!(sy);
              const z0 = adapter.floor!(sz);
              const x1 = x0.add(1).clamp(0, width - 1);
              const y1 = y0.add(1).clamp(0, height - 1);
              const z1 = z0.add(1).clamp(0, depth - 1);
              const tx = sx.sub(x0);
              const ty = sy.sub(y0);
              const tz = sz.sub(z0);
              const one = adapter.constant(1, 'f32');
              const at = (cx: KernelNode, cy: KernelNode, cz: KernelNode) =>
                lane(
                  this.#state.element(
                    adapter
                      .uint(cz)
                      .mul(height)
                      .add(adapter.uint(cy))
                      .mul(width)
                      .add(adapter.uint(cx))
                      .mul(groups)
                      .add(layout.group),
                  ),
                  layout.offset,
                );
              const mixX = (cy: KernelNode, cz: KernelNode) =>
                at(x0, cy, cz)
                  .mul(one.sub(tx))
                  .add(at(x1, cy, cz).mul(tx));
              const mixY = (cz: KernelNode) =>
                mixX(y0, cz).mul(one.sub(ty)).add(mixX(y1, cz).mul(ty));
              this.#particleSamples
                .element(index)
                .assign(mixY(z0).mul(one.sub(tz)).add(mixY(z1).mul(tz)));
            });
          })
          .compute(cells, [GRID3D_WORKGROUP_SIZE])
          .setName(`NachiGrid3DParticleSample_${layout.name}`),
      );
    }
    const gridStages = stages.filter(isGrid3DStage);
    this.#stages = gridStages.map((declaration, stageIndex) => ({
      declaration,
      kernels: buildStage(
        adapter,
        definition,
        this.#layouts,
        this.#state,
        this.#scratch,
        declaration,
        registry,
        stageIndex,
      ),
    }));
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get submissionCount(): number {
    return this.#submissionCount;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#submit(this.#clear);
    this.#initialized = true;
  }

  async run(phase: SimStageDefinition['phase'], deltaTime: number): Promise<void> {
    await this.initialize();
    for (const { declaration, kernels } of this.#stages) {
      if (declaration.phase !== phase) continue;
      if (this.#renderer.setUniformValue) {
        this.#renderer.setUniformValue(kernels.deltaTime, 'System.deltaTime', deltaTime);
      } else {
        kernels.deltaTime.value = deltaTime;
      }
      for (let iteration = 0; iteration < declaration.iterations; iteration += 1) {
        await this.#submit(kernels.stage);
        await this.#submit(kernels.commit);
      }
    }
  }

  async capture(): Promise<Grid3DSnapshot> {
    if (!this.#renderer.readStorage) {
      throw new Error('Grid3D capture requires renderer storage readback support.');
    }
    await this.initialize();
    return {
      channels: this.#layouts,
      data: new Float32Array(await this.#renderer.readStorage(this.#state)),
      resolution: this.definition.resolution,
    };
  }

  async rasterizeParticles(points: readonly Vec3[], channel: string, value = 1): Promise<void> {
    const resolve = this.#particleResolve.get(channel);
    if (!resolve) {
      throw new RangeError(
        `Particle rasterization requires a scalar Grid3D channel; received "${channel}".`,
      );
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Particle rasterization value must be finite and non-negative.');
    }
    this.#uploadParticles(points);
    this.#particleValue.value = value;
    await this.#renderer.flushStorageWrites?.();
    await this.initialize();
    await this.#submit(this.#particleReset);
    await this.#submit(this.#particleRasterize);
    await this.#submit(resolve);
  }

  async sampleParticles(points: readonly Vec3[], channel: string): Promise<Float32Array> {
    const sample = this.#particleSample.get(channel);
    if (!sample) {
      throw new RangeError(
        `Particle sampling requires a scalar Grid3D channel; received "${channel}".`,
      );
    }
    if (!this.#renderer.readStorage) {
      throw new Error('Grid3D particle sampling requires storage readback support.');
    }
    this.#uploadParticles(points);
    await this.#renderer.flushStorageWrites?.();
    await this.initialize();
    await this.#submit(sample);
    const values = new Float32Array(await this.#renderer.readStorage(this.#particleSamples));
    return values.slice(0, points.length);
  }

  release(): void {
    this.#renderer.releaseStorage?.(this.#state);
    this.#renderer.releaseStorage?.(this.#scratch);
    this.#renderer.releaseStorage?.(this.#particleAtomic);
    this.#renderer.releaseStorage?.(this.#particlePositions);
    this.#renderer.releaseStorage?.(this.#particleSamples);
  }

  #uploadParticles(points: readonly Vec3[]): void {
    const capacity = this.memoryEstimate.cellCount;
    if (points.length > capacity) {
      throw new RangeError(
        `Grid3D particle transfer supports at most ${capacity} points per call.`,
      );
    }
    if (!this.#renderer.writeStorage) {
      throw new Error('Grid3D particle transfer requires renderer storage upload support.');
    }
    const data = new Float32Array(capacity * 4);
    points.forEach(([x, y, z], index) => {
      data[index * 4] = x;
      data[index * 4 + 1] = y;
      data[index * 4 + 2] = z;
    });
    this.#renderer.writeStorage(this.#particlePositions, data);
    this.#particleCount.value = points.length;
  }

  async #submit(kernel: KernelComputeNode): Promise<void> {
    this.#submissionCount += 1;
    await this.#renderer.submitCompute(kernel);
  }
}

export function grid3DSnapshotChannel(snapshot: Grid3DSnapshot, channel: string): Float32Array {
  const layout = snapshot.channels.find(({ name }) => name === channel);
  if (!layout) throw new RangeError(`Grid3D snapshot has no channel "${channel}".`);
  const groups = Math.max(...snapshot.channels.map(({ group }) => group)) + 1;
  const cells = snapshot.resolution.reduce((product, value) => product * value, 1);
  const result = new Float32Array(cells * layout.components);
  for (let cell = 0; cell < cells; cell += 1) {
    for (let component = 0; component < layout.components; component += 1) {
      result[cell * layout.components + component] =
        snapshot.data[(cell * groups + layout.group) * 4 + layout.offset + component] ?? 0;
    }
  }
  return result;
}

export type Grid3DJsonConfig = Readonly<Record<string, JsonValue>>;
