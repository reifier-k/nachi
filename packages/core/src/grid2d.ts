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
  Grid2DChannelLayout,
  Grid2DDefinition,
  Grid2DRuntimeView,
  Grid2DSnapshot,
  Grid2DStageFunctionRef,
  Grid2DStageModuleDefinition,
  JsonValue,
  SimStageDefinition,
  Vec2,
  VfxDiagnostic,
} from './types.js';

export const GRID2D_WORKGROUP_SIZE = 64;
export const GRID2D_FIXED_POINT_SCALE = 4096;
const MAX_U32 = 0xffff_ffff;
const GRID2D_BUILTIN_STAGE_SOURCES = new Set([
  'core/grid2d-advect',
  'core/grid2d-buoyancy',
  'core/grid2d-inject',
  'core/grid2d-pressure-jacobi',
  'core/grid2d-project-velocity',
]);

export interface Grid2DStageContext {
  readonly cell: readonly [KernelNode, KernelNode];
  readonly deltaTime: KernelNode;
  readonly index: KernelNode;
  read(channel: string): KernelNode | readonly [KernelNode, KernelNode];
  sample(
    channel: string,
    cell: readonly [KernelNode, KernelNode],
  ): KernelNode | readonly [KernelNode, KernelNode];
}

export type Grid2DStageFactory = (
  context: Grid2DStageContext,
) => Readonly<Record<string, KernelNode | readonly [KernelNode, KernelNode]>>;

export interface Grid2DStageFunctionRegistration {
  readonly factory: Grid2DStageFactory;
  readonly kind: 'grid2d-function-registration';
  readonly ref: Grid2DStageFunctionRef;
}

export class Grid2DStageRegistry {
  readonly #factories = new Map<string, Grid2DStageFactory>();

  register(registration: Grid2DStageFunctionRegistration): this {
    const key = `${registration.ref.id}@${registration.ref.version}`;
    const existing = this.#factories.get(key);
    if (existing && existing !== registration.factory) {
      throw new Error(`Grid2D stage function registration conflict for ${key}.`);
    }
    this.#factories.set(key, registration.factory);
    return this;
  }

  resolve(reference: Grid2DStageFunctionRef): Grid2DStageFactory | undefined {
    return this.#factories.get(`${reference.id}@${reference.version}`);
  }
}

export function defineGrid2DStageFunction(
  id: string,
  factory: Grid2DStageFactory,
  version = 1,
): Grid2DStageFunctionRegistration {
  if (id.length === 0 || !Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('Grid2D stage function IDs must be non-empty and versions positive.');
  }
  return {
    factory,
    kind: 'grid2d-function-registration',
    ref: { id, kind: 'grid2d-function-ref', version },
  };
}

export function gridTslModule(
  source: Grid2DStageFactory | Grid2DStageFunctionRef | Grid2DStageFunctionRegistration,
): Grid2DStageModuleDefinition {
  if (typeof source === 'function') {
    const module: Grid2DStageModuleDefinition = {
      config: {},
      kind: 'grid2d-stage-module',
      source: 'inline',
      version: 1,
    };
    Object.defineProperty(module, 'factory', { enumerable: false, value: source });
    return module;
  }
  const reference = source.kind === 'grid2d-function-registration' ? source.ref : source;
  return {
    config: {},
    kind: 'grid2d-stage-module',
    source: reference,
    version: 1,
  };
}

function builtin<Config extends object>(
  source: string,
  config: Config,
): Grid2DStageModuleDefinition<Config> {
  const diagnostics = staticStageConfigDiagnostics(
    source,
    config as Readonly<Record<string, unknown>>,
    'config',
  );
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  return { config, kind: 'grid2d-stage-module', source, version: 1 };
}

function staticStageConfigDiagnostics(
  source: string,
  config: Readonly<Record<string, unknown>>,
  basePath: string,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const add = (message: string, field: string) =>
    diagnostics.push({
      code: 'NACHI_GRID2D_STAGE_VALUE_INVALID',
      message,
      path: `${basePath}.${field}`,
      phase: 'compile',
      severity: 'error',
    });
  const finite = (value: unknown, field: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      add(`Grid2D ${field} must be finite.`, field);
    }
  };
  const finiteValue = (value: unknown): boolean =>
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item)));

  if (source === 'core/grid2d-inject') {
    const center = config.center;
    if (
      !Array.isArray(center) ||
      center.length !== 2 ||
      center.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      add('Grid2D inject center must be a finite vec2.', 'center');
    }
    finite(config.radius, 'radius');
    if (typeof config.radius === 'number' && config.radius < 0) {
      add('Grid2D inject radius must be non-negative.', 'radius');
    }
    const values = config.values;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      add('Grid2D inject values must be a channel map.', 'values');
    } else {
      for (const [name, value] of Object.entries(values)) {
        if (!finiteValue(value)) {
          add(
            `Grid2D inject value for "${name}" must be a finite scalar or vec2.`,
            `values.${name}`,
          );
        }
      }
    }
  } else if (source === 'core/grid2d-advect') {
    const dissipation = config.dissipation ?? {};
    if (typeof dissipation !== 'object' || dissipation === null || Array.isArray(dissipation)) {
      add('Grid2D dissipation must be a channel map.', 'dissipation');
    } else {
      for (const [name, value] of Object.entries(dissipation)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          add(
            `Grid2D dissipation for "${name}" must be a non-negative finite rate.`,
            `dissipation.${name}`,
          );
        }
      }
    }
  } else if (source === 'core/grid2d-buoyancy') {
    finite(config.densityWeight ?? 0.1, 'densityWeight');
    finite(config.temperatureBuoyancy ?? 1, 'temperatureBuoyancy');
  }
  return diagnostics;
}

export interface GridAdvectOptions {
  /** Exponential decay rates in inverse seconds, keyed by channel. */
  readonly dissipation?: Readonly<Record<string, number>>;
  /** Vec2 channel measured in grid cells per second; advection operates in cell space. */
  readonly velocity?: string;
}

export function gridAdvect(
  options: GridAdvectOptions = {},
): Grid2DStageModuleDefinition<GridAdvectOptions> {
  return builtin('core/grid2d-advect', options);
}

export interface GridBuoyancyOptions {
  readonly density?: string;
  readonly densityWeight?: number;
  readonly temperature?: string;
  readonly temperatureBuoyancy?: number;
  readonly velocity?: string;
}

export function gridBuoyancy(
  options: GridBuoyancyOptions = {},
): Grid2DStageModuleDefinition<GridBuoyancyOptions> {
  return builtin('core/grid2d-buoyancy', options);
}

export interface GridSourceOptions {
  /** Normalized grid coordinate with a bottom-left origin, independent of grid resolution. */
  readonly center: Vec2;
  /** Radius in normalized grid coordinates. */
  readonly radius: number;
  /** Per-second additions keyed by channel; velocity vec2 values are grid cells per second. */
  readonly values: Readonly<Record<string, number | Vec2>>;
}

export function gridInject(
  options: GridSourceOptions,
): Grid2DStageModuleDefinition<GridSourceOptions> {
  return builtin('core/grid2d-inject', options);
}

export interface GridPressureOptions {
  readonly pressure?: string;
  readonly velocity?: string;
}

export function gridPressureJacobi(
  options: GridPressureOptions = {},
): Grid2DStageModuleDefinition<GridPressureOptions> {
  return builtin('core/grid2d-pressure-jacobi', options);
}

export function gridProjectVelocity(
  options: GridPressureOptions = {},
): Grid2DStageModuleDefinition<GridPressureOptions> {
  return builtin('core/grid2d-project-velocity', options);
}

export function gridCellIndex(x: number, y: number, resolution: readonly [number, number]): number {
  const [width, height] = resolution;
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(width * height)
  ) {
    throw new RangeError(
      'Grid2D resolution must contain positive safe integers with a safe product.',
    );
  }
  if (
    !Number.isSafeInteger(x) ||
    x < 0 ||
    x >= width ||
    !Number.isSafeInteger(y) ||
    y < 0 ||
    y >= height
  ) {
    throw new RangeError(`Grid2D cell (${x}, ${y}) is outside ${width}x${height}.`);
  }
  return y * width + x;
}

/** CPU mirror of clamp-boundary, cell-centered bilinear sampling. */
export function sampleGrid2DBilinear(
  values: ArrayLike<number>,
  resolution: readonly [number, number],
  cell: readonly [number, number],
): number {
  const [width, height] = resolution;
  if (values.length < width * height) throw new RangeError('Grid2D sample array is too short.');
  const x = Math.min(width - 1, Math.max(0, cell[0]));
  const y = Math.min(height - 1, Math.max(0, cell[1]));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a =
    (values[gridCellIndex(x0, y0, resolution)] ?? 0) * (1 - tx) +
    (values[gridCellIndex(x1, y0, resolution)] ?? 0) * tx;
  const b =
    (values[gridCellIndex(x0, y1, resolution)] ?? 0) * (1 - tx) +
    (values[gridCellIndex(x1, y1, resolution)] ?? 0) * tx;
  return a * (1 - ty) + b * ty;
}

/** CPU reference for nearest-cell particle deposition, used to validate GPU raster stages. */
export function rasterizeGrid2DPoints(
  points: readonly Vec2[],
  resolution: readonly [number, number],
  value = 1,
): Float32Array {
  const [width, height] = resolution;
  const result = new Float32Array(width * height);
  for (const [u, v] of points) {
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
    result[gridCellIndex(x, y, resolution)]! += value;
  }
  return result;
}

/** Normative scheduler projection: stage element order is stable inside each phase. */
export function simStageExecutionOrder(
  elements: Readonly<Record<string, { readonly kind: string; readonly phase?: string }>>,
): readonly string[] {
  const entries = Object.entries(elements);
  return [
    ...entries
      .filter(([, element]) => element.kind === 'sim-stage' && element.phase === 'before-particles')
      .map(([key]) => key),
    '$particles',
    ...entries
      .filter(([, element]) => element.kind === 'sim-stage' && element.phase === 'after-particles')
      .map(([key]) => key),
  ];
}

/** One update dispatch plus one commit dispatch per iteration. Initialization is separate. */
export function simStageSubmissionCount(stages: readonly SimStageDefinition[]): number {
  return stages.reduce((total, stage) => total + stage.iterations * 2, 0);
}

function diagnosticsForDefinition(definition: Grid2DDefinition): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const [width, height] = definition.resolution;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    diagnostics.push({
      code: 'NACHI_GRID2D_RESOLUTION_INVALID',
      message: 'Grid2D resolution must contain two positive safe integers with a safe product.',
      path: 'resolution',
      phase: 'compile',
      severity: 'error',
    });
  } else if (!Number.isSafeInteger(width * height)) {
    diagnostics.push({
      code: 'NACHI_GRID2D_RESOLUTION_INVALID',
      message: 'Grid2D resolution product exceeds the safe integer range.',
      path: 'resolution',
      phase: 'compile',
      severity: 'error',
    });
  }
  let lanes = 0;
  for (const [name, channel] of Object.entries(definition.channels)) {
    if (name.length === 0 || (channel.type !== 'f32' && channel.type !== 'vec2')) {
      diagnostics.push({
        code: 'NACHI_GRID2D_CHANNEL_INVALID',
        message: `Grid2D channel "${name}" must use f32 or vec2.`,
        path: `channels.${name}`,
        phase: 'compile',
        severity: 'error',
      });
    }
    lanes += channel.type === 'vec2' ? 2 : 1;
  }
  if (lanes === 0) {
    diagnostics.push({
      code: 'NACHI_GRID2D_CHANNEL_INVALID',
      message: 'Grid2D requires at least one channel.',
      path: 'channels',
      phase: 'compile',
      severity: 'error',
    });
  }
  return diagnostics;
}

export function resolveGrid2DChannelLayout(
  definition: Grid2DDefinition,
): readonly Grid2DChannelLayout[] {
  const diagnostics = diagnosticsForDefinition(definition);
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  const layouts: Grid2DChannelLayout[] = [];
  let group = 0;
  let offset = 0;
  for (const [name, channel] of Object.entries(definition.channels)) {
    const components = channel.type === 'vec2' ? 2 : 1;
    if (offset + components > 4) {
      group += 1;
      offset = 0;
    }
    layouts.push({ components, group, name, offset: offset as 0 | 1 | 2 | 3, type: channel.type });
    offset += components;
    if (offset === 4) {
      group += 1;
      offset = 0;
    }
  }
  return layouts;
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
    throw new Error('Grid2D requires floor/mod support from the pinned TSL adapter.');
  }
}

function stageFactory(
  module: Grid2DStageModuleDefinition,
  registry: Grid2DStageRegistry | undefined,
): Grid2DStageFactory | undefined {
  if (typeof module.source === 'object') return registry?.resolve(module.source);
  if (module.source !== 'inline') return undefined;
  return (module as Grid2DStageModuleDefinition & { readonly factory?: Grid2DStageFactory })
    .factory;
}

function isGrid2DStage(
  stage: SimStageDefinition,
): stage is SimStageDefinition & { readonly update: Grid2DStageModuleDefinition } {
  return stage.update.kind === 'grid2d-stage-module';
}

function stageConfigDiagnostics(
  definition: Grid2DDefinition,
  stage: SimStageDefinition & { readonly update: Grid2DStageModuleDefinition },
  stageIndex: number,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const source = stage.update.source;
  const config = stage.update.config as Record<string, unknown>;
  const path = (field: string) => `stages[${stageIndex}].update.config.${field}`;
  const add = (code: string, message: string, field: string) =>
    diagnostics.push({ code, message, path: path(field), phase: 'compile', severity: 'error' });
  const channel = (name: unknown, type: 'f32' | 'vec2', field: string) => {
    const declaration = typeof name === 'string' ? definition.channels[name] : undefined;
    if (!declaration || declaration.type !== type) {
      add(
        'NACHI_GRID2D_STAGE_CHANNEL_TYPE_INVALID',
        `Grid2D ${field} must name a declared ${type} channel.`,
        field,
      );
    }
  };
  if (
    typeof source === 'string' &&
    source !== 'inline' &&
    !GRID2D_BUILTIN_STAGE_SOURCES.has(source)
  ) {
    diagnostics.push({
      code: 'NACHI_GRID2D_STAGE_SOURCE_UNKNOWN',
      message: `Unknown Grid2D built-in stage source "${source}".`,
      path: `stages[${stageIndex}].update.source`,
      phase: 'compile',
      severity: 'error',
    });
    return diagnostics;
  }
  diagnostics.push(
    ...(typeof source === 'string'
      ? staticStageConfigDiagnostics(source, config, `stages[${stageIndex}].update.config`)
      : []),
  );
  if (source === 'core/grid2d-inject') {
    const values = config.values;
    if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
      for (const [name, value] of Object.entries(values)) {
        const type = definition.channels[name]?.type;
        const staticallyValid =
          (typeof value === 'number' && Number.isFinite(value)) ||
          (Array.isArray(value) &&
            value.length === 2 &&
            value.every((item) => typeof item === 'number' && Number.isFinite(item)));
        const valid =
          type === 'f32'
            ? typeof value === 'number' && Number.isFinite(value)
            : type === 'vec2' &&
              Array.isArray(value) &&
              value.length === 2 &&
              value.every((item) => typeof item === 'number' && Number.isFinite(item));
        if (staticallyValid && !valid)
          add(
            'NACHI_GRID2D_STAGE_VALUE_INVALID',
            `Grid2D inject value for "${name}" must match its declared channel type and contain only finite components.`,
            `values.${name}`,
          );
      }
    }
  } else if (source === 'core/grid2d-advect') {
    channel(config.velocity ?? 'velocity', 'vec2', 'velocity');
    const dissipation = config.dissipation ?? {};
    if (typeof dissipation === 'object' && dissipation !== null && !Array.isArray(dissipation)) {
      for (const [name, value] of Object.entries(dissipation)) {
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          !definition.channels[name]
        ) {
          add(
            'NACHI_GRID2D_STAGE_VALUE_INVALID',
            `Grid2D dissipation for "${name}" must target a declared channel with a non-negative finite rate.`,
            `dissipation.${name}`,
          );
        }
      }
    }
  } else if (source === 'core/grid2d-buoyancy') {
    channel(config.velocity ?? 'velocity', 'vec2', 'velocity');
    channel(config.density ?? 'density', 'f32', 'density');
    channel(config.temperature ?? 'temperature', 'f32', 'temperature');
  }
  return diagnostics;
}

function buildStage(
  adapter: KernelTslAdapter,
  definition: Grid2DDefinition,
  layouts: readonly Grid2DChannelLayout[],
  state: KernelStorageNode,
  scratch: KernelStorageNode,
  declaration: SimStageDefinition & { readonly update: Grid2DStageModuleDefinition },
  registry: Grid2DStageRegistry | undefined,
  stageIndex: number,
): BuiltGridStage {
  requireGridOperations(adapter);
  const [width, height] = definition.resolution;
  const cells = width * height;
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
  const y = index.div(width);
  const stateElement = (cellIndex: KernelNode, group: number) =>
    state.element(cellIndex.mul(groupCount).add(group));
  const read = (
    channel: string,
    cellIndex = index,
  ): KernelNode | readonly [KernelNode, KernelNode] => {
    const layout = byName.get(channel);
    if (!layout) {
      return stageDiagnostic(
        'NACHI_GRID2D_STAGE_CHANNEL_UNDECLARED',
        `Grid2D channel "${channel}" is not declared.`,
        `read.${channel}`,
      );
    }
    const record = stateElement(cellIndex, layout.group);
    return layout.components === 1
      ? lane(record, layout.offset)
      : [lane(record, layout.offset), lane(record, layout.offset + 1)];
  };
  const sample = (channel: string, cell: readonly [KernelNode, KernelNode]) => {
    const layout = byName.get(channel);
    if (!layout) {
      return stageDiagnostic(
        'NACHI_GRID2D_STAGE_CHANNEL_UNDECLARED',
        `Grid2D channel "${channel}" is not declared.`,
        `sample.${channel}`,
      );
    }
    const sx = cell[0].clamp(0, width - 1);
    const sy = cell[1].clamp(0, height - 1);
    const x0f = adapter.floor(sx);
    const y0f = adapter.floor(sy);
    const x1f = x0f.add(1).clamp(0, width - 1);
    const y1f = y0f.add(1).clamp(0, height - 1);
    const tx = sx.sub(x0f);
    const ty = sy.sub(y0f);
    const cellIndex = (cx: KernelNode, cy: KernelNode) =>
      adapter.uint(cy).mul(width).add(adapter.uint(cx));
    const mixOne = (component: number): KernelNode => {
      const componentAt = (cx: KernelNode, cy: KernelNode) => {
        const value = read(channel, cellIndex(cx, cy));
        return Array.isArray(value) ? value[component]! : value;
      };
      const a = componentAt(x0f, y0f)
        .mul(adapter.constant(1, 'f32').sub(tx))
        .add(componentAt(x1f, y0f).mul(tx));
      const b = componentAt(x0f, y1f)
        .mul(adapter.constant(1, 'f32').sub(tx))
        .add(componentAt(x1f, y1f).mul(tx));
      return a.mul(adapter.constant(1, 'f32').sub(ty)).add(b.mul(ty));
    };
    return layout.components === 1 ? mixOne(0) : ([mixOne(0), mixOne(1)] as const);
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
              'NACHI_GRID2D_STAGE_WRITE_CHANNEL_UNDECLARED',
              `Grid2D stage writes undeclared channel "${name}".`,
              `result.${name}`,
            );
          }
          const values = Array.isArray(value) ? value : [value];
          if (values.length !== layout.components) {
            stageDiagnostic(
              'NACHI_GRID2D_STAGE_WRITE_COMPONENTS_INVALID',
              `Grid2D stage channel "${name}" requires ${layout.components} component${layout.components === 1 ? '' : 's'}; received ${values.length}.`,
              `result.${name}`,
            );
          }
          changed.set(name, values);
        };
        const source = declaration.update.source;
        if (customFactory) {
          const result = customFactory({
            cell: [x.toFloat(), y.toFloat()],
            deltaTime,
            index,
            read,
            sample,
          });
          for (const [name, value] of Object.entries(result)) set(name, value);
        } else if (source === 'core/grid2d-inject') {
          const center = moduleConfig.center as Vec2;
          const radius = Number(moduleConfig.radius);
          const nx = x.toFloat().add(0.5).div(width);
          const ny = y.toFloat().add(0.5).div(height);
          const inside = nx
            .sub(center[0])
            .mul(nx.sub(center[0]))
            .add(ny.sub(center[1]).mul(ny.sub(center[1])))
            .lessThanEqual(radius * radius);
          for (const [name, authored] of Object.entries(
            moduleConfig.values as Record<string, number | Vec2>,
          )) {
            const current = read(name);
            if (Array.isArray(current)) {
              const value = authored as Vec2;
              set(name, [
                current[0].add(adapter.select(inside, value[0] * 1, 0).mul(deltaTime)),
                current[1].add(adapter.select(inside, value[1] * 1, 0).mul(deltaTime)),
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
        } else if (source === 'core/grid2d-advect') {
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode];
          const back: readonly [KernelNode, KernelNode] = [
            x.toFloat().sub(velocity[0].mul(deltaTime)),
            y.toFloat().sub(velocity[1].mul(deltaTime)),
          ];
          const dissipation = (moduleConfig.dissipation ?? {}) as Record<string, number>;
          for (const layout of layouts) {
            const sampled = sample(layout.name, back);
            const decay = adapter
              .constant(Math.E, 'f32')
              .pow(deltaTime.mul(-(dissipation[layout.name] ?? 0)));
            set(
              layout.name,
              Array.isArray(sampled)
                ? [sampled[0].mul(decay), sampled[1].mul(decay)]
                : (sampled as KernelNode).mul(decay),
            );
          }
        } else if (source === 'core/grid2d-buoyancy') {
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode];
          const density = read(String(moduleConfig.density ?? 'density')) as KernelNode;
          const temperature = read(String(moduleConfig.temperature ?? 'temperature')) as KernelNode;
          const force = temperature
            .mul(Number(moduleConfig.temperatureBuoyancy ?? 1))
            .sub(density.mul(Number(moduleConfig.densityWeight ?? 0.1)));
          set(velocityName, [velocity[0], velocity[1].add(force.mul(deltaTime))]);
        } else if (source === 'core/grid2d-pressure-jacobi') {
          const pressureName = String(moduleConfig.pressure ?? 'pressure');
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const at = (cx: KernelNode, cy: KernelNode, channel: string) =>
            read(channel, adapter.uint(cy).mul(width).add(adapter.uint(cx)));
          const leftX = x
            .toFloat()
            .sub(1)
            .clamp(0, width - 1);
          const rightX = x
            .toFloat()
            .add(1)
            .clamp(0, width - 1);
          const downY = y
            .toFloat()
            .sub(1)
            .clamp(0, height - 1);
          const upY = y
            .toFloat()
            .add(1)
            .clamp(0, height - 1);
          const l = at(leftX, y.toFloat(), pressureName) as KernelNode;
          const r = at(rightX, y.toFloat(), pressureName) as KernelNode;
          const d = at(x.toFloat(), downY, pressureName) as KernelNode;
          const u = at(x.toFloat(), upY, pressureName) as KernelNode;
          const vl = at(leftX, y.toFloat(), velocityName) as readonly [KernelNode, KernelNode];
          const vr = at(rightX, y.toFloat(), velocityName) as readonly [KernelNode, KernelNode];
          const vd = at(x.toFloat(), downY, velocityName) as readonly [KernelNode, KernelNode];
          const vu = at(x.toFloat(), upY, velocityName) as readonly [KernelNode, KernelNode];
          const divergence = vr[0].sub(vl[0]).add(vu[1].sub(vd[1])).mul(0.5);
          set(pressureName, l.add(r).add(d).add(u).sub(divergence).mul(0.25));
        } else if (source === 'core/grid2d-project-velocity') {
          const pressureName = String(moduleConfig.pressure ?? 'pressure');
          const velocityName = String(moduleConfig.velocity ?? 'velocity');
          const pressureAt = (cx: KernelNode, cy: KernelNode) =>
            read(pressureName, adapter.uint(cy).mul(width).add(adapter.uint(cx))) as KernelNode;
          const l = pressureAt(
            x
              .toFloat()
              .sub(1)
              .clamp(0, width - 1),
            y.toFloat(),
          );
          const r = pressureAt(
            x
              .toFloat()
              .add(1)
              .clamp(0, width - 1),
            y.toFloat(),
          );
          const d = pressureAt(
            x.toFloat(),
            y
              .toFloat()
              .sub(1)
              .clamp(0, height - 1),
          );
          const u = pressureAt(
            x.toFloat(),
            y
              .toFloat()
              .add(1)
              .clamp(0, height - 1),
          );
          const velocity = read(velocityName) as readonly [KernelNode, KernelNode];
          set(velocityName, [
            velocity[0].sub(r.sub(l).mul(0.5)),
            velocity[1].sub(u.sub(d).mul(0.5)),
          ]);
        } else {
          throw new Error(
            `Unknown Grid2D stage source ${typeof source === 'string' ? source : `${source.id}@${source.version}`}.`,
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
    .compute(cells, [GRID2D_WORKGROUP_SIZE])
    .setName('NachiGrid2DStage');
  const commit = adapter
    .fn(() => {
      adapter.branch(index.lessThan(cells), () => {
        for (let group = 0; group < groupCount; group += 1) {
          const address = index.mul(groupCount).add(group);
          state.element(address).assign(scratch.element(address));
        }
      });
    })
    .compute(cells, [GRID2D_WORKGROUP_SIZE])
    .setName('NachiGrid2DCommit');
  return { commit, deltaTime, stage: kernel };
}

export class Grid2DRuntime implements Grid2DRuntimeView {
  readonly #clear: KernelComputeNode;
  readonly #layouts: readonly Grid2DChannelLayout[];
  readonly #renderer: GridRenderer;
  readonly #scratch: KernelStorageNode;
  readonly #stages: readonly {
    readonly declaration: SimStageDefinition;
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
  readonly #wrapSubmissionError: ((error: unknown) => unknown) | undefined;
  #initialized = false;
  #submissionCount = 0;

  constructor(
    readonly definition: Grid2DDefinition,
    renderer: GridRenderer,
    stages: readonly SimStageDefinition[],
    registry?: Grid2DStageRegistry,
    wrapSubmissionError?: (error: unknown) => unknown,
  ) {
    this.#wrapSubmissionError = wrapSubmissionError;
    const definitionDiagnostics = diagnosticsForDefinition(definition);
    const diagnostics = [...definitionDiagnostics];
    if (renderer.kernelAdapter.capabilities.backend !== 'webgpu') {
      diagnostics.push({
        code: 'NACHI_GRID2D_WEBGL2_UNSUPPORTED',
        message:
          'Grid2D storage-buffer simulation requires WebGPU; WebGL2 transform feedback cannot provide arbitrary cell read/write or atomics.',
        path: 'grid2d',
        phase: 'compile',
        severity: 'error',
      });
    }
    if (definitionDiagnostics.length === 0) {
      const layouts = resolveGrid2DChannelLayout(definition);
      const groups = Math.max(...layouts.map(({ group }) => group)) + 1;
      const cells = definition.resolution[0] * definition.resolution[1];
      const largestBuffer = Math.max(cells * groups * 16, cells * 8);
      const limits = renderer.kernelAdapter.deviceLimits;
      const activeLimits = [limits?.maxStorageBufferBindingSize, limits?.maxBufferSize].filter(
        (value): value is number => value !== undefined,
      );
      const allocationLimit = activeLimits.length > 0 ? Math.min(...activeLimits) : undefined;
      if (allocationLimit !== undefined && largestBuffer > allocationLimit) {
        diagnostics.push({
          code: 'NACHI_GRID2D_STORAGE_LIMIT_EXCEEDED',
          message: `Grid2D requires a ${largestBuffer}-byte storage binding, exceeding the active device buffer limit ${allocationLimit}.`,
          path: 'grid2d.resolution',
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    for (const [index, stage] of stages.entries()) {
      if (!isGrid2DStage(stage)) {
        diagnostics.push({
          code: 'NACHI_SIM_STAGE_TARGET_KIND_MISMATCH',
          message: 'A Grid2D target requires a grid2d-stage-module update.',
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
          code: 'NACHI_GRID2D_STAGE_FUNCTION_UNRESOLVED',
          message: `Grid2D stage function "${stage.update.source.id}@${stage.update.source.version}" is not registered.`,
          path: `stages[${index}].update.source`,
          phase: 'compile',
          severity: 'error',
        });
      }
      if (stage.update.source === 'inline' && stageFactory(stage.update, registry) === undefined) {
        diagnostics.push({
          code: 'NACHI_GRID2D_STAGE_FUNCTION_UNRESOLVED',
          message: 'Inline Grid2D stage factory metadata is unavailable.',
          path: `stages[${index}].update.source`,
          phase: 'compile',
          severity: 'error',
        });
      }
      diagnostics.push(...stageConfigDiagnostics(definition, stage, index));
    }
    if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
    this.#renderer = renderer;
    this.#layouts = resolveGrid2DChannelLayout(definition);
    const groups = Math.max(...this.#layouts.map(({ group }) => group)) + 1;
    const [width, height] = definition.resolution;
    const cells = width * height;
    this.#state = renderer.kernelAdapter
      .instancedArray(cells * groups, 'vec4')
      .setName('NachiGrid2DState');
    this.#scratch = renderer.kernelAdapter
      .instancedArray(cells * groups, 'vec4')
      .setName('NachiGrid2DScratch');
    this.#particlePositions = renderer.kernelAdapter
      .instancedArray(cells, 'vec2')
      .setName('NachiGrid2DParticlePositions');
    this.#particleSamples = renderer.kernelAdapter
      .instancedArray(cells, 'float')
      .setName('NachiGrid2DParticleSamples');
    this.#particleAtomic = renderer.kernelAdapter
      .instancedArray(cells, 'uint')
      .setName('NachiGrid2DParticleAtomic')
      .toAtomic();
    this.#particleCount = renderer.kernelAdapter.uniform(0, 'uint');
    this.#particleValue = renderer.kernelAdapter.uniform(1, 'float');
    const index = renderer.kernelAdapter.instanceIndex;
    const defaults = new Map<string, readonly number[]>();
    for (const layout of this.#layouts) {
      const authored = definition.channels[layout.name]!.default;
      defaults.set(layout.name, Array.isArray(authored) ? authored : [Number(authored ?? 0)]);
    }
    this.#clear = renderer.kernelAdapter
      .fn(() => {
        renderer.kernelAdapter.branch(index.lessThan(cells), () => {
          for (let group = 0; group < groups; group += 1) {
            const lanes = [0, 0, 0, 0];
            for (const layout of this.#layouts.filter((candidate) => candidate.group === group)) {
              const values = defaults.get(layout.name)!;
              for (let component = 0; component < layout.components; component += 1)
                lanes[layout.offset + component] = values[component] ?? 0;
            }
            const value = renderer.kernelAdapter.constant(lanes, 'vec4');
            const address = index.mul(groups).add(group);
            this.#state.element(address).assign(value);
            this.#scratch.element(address).assign(value);
          }
        });
      })
      .compute(cells, [GRID2D_WORKGROUP_SIZE])
      .setName('NachiGrid2DClear');
    requireGridOperations(renderer.kernelAdapter);
    this.#particleReset = renderer.kernelAdapter
      .fn(() => {
        renderer.kernelAdapter.branch(index.lessThan(cells), () => {
          renderer.kernelAdapter.atomicStore(this.#particleAtomic.element(index), 0);
        });
      })
      .compute(cells, [GRID2D_WORKGROUP_SIZE])
      .setName('NachiGrid2DParticleReset');
    this.#particleRasterize = renderer.kernelAdapter
      .fn(() => {
        renderer.kernelAdapter.branch(
          index.lessThan(cells).and(index.lessThan(this.#particleCount)),
          () => {
            const point = this.#particlePositions.element(index);
            const px = renderer.kernelAdapter.floor!(
              point.x.clamp(0, 0.999999).mul(definition.resolution[0]),
            );
            const py = renderer.kernelAdapter.floor!(
              point.y.clamp(0, 0.999999).mul(definition.resolution[1]),
            );
            const target = this.#particleAtomic.element(
              renderer.kernelAdapter
                .uint(py)
                .mul(definition.resolution[0])
                .add(renderer.kernelAdapter.uint(px)),
            );
            renderer.kernelAdapter.atomicAdd(
              target,
              renderer.kernelAdapter.uint(this.#particleValue.mul(GRID2D_FIXED_POINT_SCALE)),
            );
          },
        );
      })
      .compute(cells, [GRID2D_WORKGROUP_SIZE])
      .setName('NachiGrid2DParticleRasterize');
    const scalarLayouts = this.#layouts.filter(({ components }) => components === 1);
    for (const layout of scalarLayouts) {
      this.#particleResolve.set(
        layout.name,
        renderer.kernelAdapter
          .fn(() => {
            renderer.kernelAdapter.branch(index.lessThan(cells), () => {
              const record = this.#state.element(index.mul(groups).add(layout.group));
              lane(record, layout.offset).addAssign(
                renderer.kernelAdapter
                  .atomicLoad(this.#particleAtomic.element(index))
                  .toFloat()
                  .div(GRID2D_FIXED_POINT_SCALE),
              );
            });
          })
          .compute(cells, [GRID2D_WORKGROUP_SIZE])
          .setName(`NachiGrid2DParticleResolve_${layout.name}`),
      );
      this.#particleSample.set(
        layout.name,
        renderer.kernelAdapter
          .fn(() => {
            renderer.kernelAdapter.branch(
              index.lessThan(cells).and(index.lessThan(this.#particleCount)),
              () => {
                const point = this.#particlePositions.element(index);
                const sx = point.x
                  .mul(width)
                  .sub(0.5)
                  .clamp(0, width - 1);
                const sy = point.y
                  .mul(height)
                  .sub(0.5)
                  .clamp(0, height - 1);
                const x0f = renderer.kernelAdapter.floor!(sx);
                const y0f = renderer.kernelAdapter.floor!(sy);
                const x1f = x0f.add(1).clamp(0, width - 1);
                const y1f = y0f.add(1).clamp(0, height - 1);
                const tx = sx.sub(x0f);
                const ty = sy.sub(y0f);
                const at = (cx: KernelNode, cy: KernelNode) =>
                  lane(
                    this.#state.element(
                      renderer.kernelAdapter
                        .uint(cy)
                        .mul(width)
                        .add(renderer.kernelAdapter.uint(cx))
                        .mul(groups)
                        .add(layout.group),
                    ),
                    layout.offset,
                  );
                const a = at(x0f, y0f)
                  .mul(renderer.kernelAdapter.constant(1, 'f32').sub(tx))
                  .add(at(x1f, y0f).mul(tx));
                const b = at(x0f, y1f)
                  .mul(renderer.kernelAdapter.constant(1, 'f32').sub(tx))
                  .add(at(x1f, y1f).mul(tx));
                this.#particleSamples
                  .element(index)
                  .assign(a.mul(renderer.kernelAdapter.constant(1, 'f32').sub(ty)).add(b.mul(ty)));
              },
            );
          })
          .compute(cells, [GRID2D_WORKGROUP_SIZE])
          .setName(`NachiGrid2DParticleSample_${layout.name}`),
      );
    }
    this.#stages = stages.filter(isGrid2DStage).map((declaration, stageIndex) => ({
      declaration,
      kernels: buildStage(
        renderer.kernelAdapter,
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
      if (this.#renderer.setUniformValue)
        this.#renderer.setUniformValue(kernels.deltaTime, 'System.deltaTime', deltaTime);
      else kernels.deltaTime.value = deltaTime;
      for (let iteration = 0; iteration < declaration.iterations; iteration += 1) {
        // Three r185 did not preserve the dependent-dispatch behavior required by the M10 sorting
        // experiments, so stage and commit conservatively use independent backend submissions.
        await this.#submit(kernels.stage);
        await this.#submit(kernels.commit);
      }
    }
  }

  async capture(): Promise<Grid2DSnapshot> {
    if (!this.#renderer.readStorage) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_GRID2D_READBACK_UNSUPPORTED',
          message: 'Grid2D capture requires renderer storage readback support.',
          path: 'renderer.readStorage',
          phase: 'runtime',
          severity: 'error',
        },
      ]);
    }
    await this.initialize();
    return {
      channels: this.#layouts,
      data: new Float32Array(await this.#renderer.readStorage(this.#state)),
      resolution: this.definition.resolution,
    };
  }

  async rasterizeParticles(points: readonly Vec2[], channel: string, value = 1): Promise<void> {
    const resolve = this.#particleResolve.get(channel);
    if (!resolve)
      throw new RangeError(
        `Particle rasterization requires a scalar Grid2D channel; received "${channel}".`,
      );
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Particle rasterization value must be finite and non-negative.');
    }
    if (value * GRID2D_FIXED_POINT_SCALE > MAX_U32) {
      throw new RangeError(
        'Particle rasterization value exceeds the Grid2D fixed-point u32 range.',
      );
    }
    this.#uploadParticles(points);
    this.#particleValue.value = value;
    await this.#renderer.flushStorageWrites?.();
    await this.initialize();
    await this.#submit(this.#particleReset);
    await this.#submit(this.#particleRasterize);
    await this.#submit(resolve);
  }

  async sampleParticles(points: readonly Vec2[], channel: string): Promise<Float32Array> {
    const sample = this.#particleSample.get(channel);
    if (!sample)
      throw new RangeError(
        `Particle sampling requires a scalar Grid2D channel; received "${channel}".`,
      );
    const invalidPoint = points.findIndex(
      (point) => point.length !== 2 || point.some((component) => !Number.isFinite(component)),
    );
    if (invalidPoint >= 0) {
      throw new RangeError(
        `Grid2D particle point ${invalidPoint} must contain two finite coordinates.`,
      );
    }
    if (!this.#renderer.readStorage)
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_GRID2D_READBACK_UNSUPPORTED',
          message: 'Grid2D particle sampling requires storage readback support.',
          path: 'renderer.readStorage',
          phase: 'runtime',
          severity: 'error',
        },
      ]);
    this.#uploadParticles(points);
    await this.#renderer.flushStorageWrites?.();
    await this.initialize();
    await this.#submit(sample);
    const values = new Float32Array(await this.#renderer.readStorage(this.#particleSamples));
    return values.slice(0, points.length);
  }

  release(): void {
    this.#initialized = false;
    this.#renderer.releaseStorage?.(this.#state);
    this.#renderer.releaseStorage?.(this.#scratch);
    this.#renderer.releaseStorage?.(this.#particleAtomic);
    this.#renderer.releaseStorage?.(this.#particlePositions);
    this.#renderer.releaseStorage?.(this.#particleSamples);
  }

  #uploadParticles(points: readonly Vec2[]): void {
    const capacity = this.definition.resolution[0] * this.definition.resolution[1];
    if (points.length > capacity)
      throw new RangeError(
        `Grid2D particle transfer supports at most ${capacity} points per call.`,
      );
    for (const [index, point] of points.entries()) {
      if (point.length !== 2 || point.some((component) => !Number.isFinite(component))) {
        throw new RangeError(`Grid2D particle point ${index} must contain two finite coordinates.`);
      }
    }
    if (!this.#renderer.writeStorage)
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_GRID2D_UPLOAD_UNSUPPORTED',
          message: 'Grid2D particle transfer requires renderer storage upload support.',
          path: 'renderer.writeStorage',
          phase: 'runtime',
          severity: 'error',
        },
      ]);
    const data = new Float32Array(capacity * 2);
    points.forEach(([x, y], index) => {
      data[index * 2] = x;
      data[index * 2 + 1] = y;
    });
    this.#renderer.writeStorage(this.#particlePositions, data);
    this.#particleCount.value = points.length;
  }

  async #submit(kernel: KernelComputeNode): Promise<void> {
    this.#submissionCount += 1;
    try {
      await this.#renderer.submitCompute(kernel);
    } catch (error) {
      throw this.#wrapSubmissionError?.(error) ?? error;
    }
  }
}

export function grid2DSnapshotChannel(snapshot: Grid2DSnapshot, channel: string): Float32Array {
  const layout = snapshot.channels.find(({ name }) => name === channel);
  if (!layout) throw new RangeError(`Grid2D snapshot has no channel "${channel}".`);
  const groups = Math.max(...snapshot.channels.map(({ group }) => group)) + 1;
  const cells = snapshot.resolution[0] * snapshot.resolution[1];
  const result = new Float32Array(cells * layout.components);
  for (let cell = 0; cell < cells; cell += 1) {
    for (let component = 0; component < layout.components; component += 1) {
      result[cell * layout.components + component] =
        snapshot.data[(cell * groups + layout.group) * 4 + layout.offset + component] ?? 0;
    }
  }
  return result;
}

export type Grid2DJsonConfig = Readonly<Record<string, JsonValue>>;
