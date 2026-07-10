import { resolveAttributeSchema, resolveTslStorageType } from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import { pcgRandomFloatNode, resolveModuleSlot, resolveRandomSampleSlot } from './random.js';
import {
  collectEmitterLifecycleDiagnostics,
  collectEmitterModuleLabelDiagnostics,
  collectEmitterModules,
  collectParameterDeclarationDiagnostics,
} from './emitter-modules.js';
import type {
  AttributeSchema,
  AttributeType,
  ColorInput,
  CurveGenerator,
  DataReference,
  EmitterDefinition,
  EmptyParameterSchema,
  GradientGenerator,
  InitModule,
  ModuleAccess,
  ModuleDefinition,
  ParameterGenerator,
  ParameterPath,
  ParameterSchema,
  RangeGenerator,
  ResolvedAttributeSchema,
  TslFunctionRef,
  TslModuleDefinition,
  TslModuleFactory,
  TslParticleBindings,
  TslStorageType,
  UpdateModule,
  ValueInput,
  Vec3,
  Vec4,
  VfxDiagnostic,
} from './types.js';

export const DEFAULT_LUT_RESOLUTION = 256;
export const DEFAULT_WORKGROUP_SIZE = 64;

export type CompiledKernelStage = 'init' | 'update';

export interface BakedLut {
  readonly channels: 1 | 4;
  readonly data: Float32Array;
  readonly filter: 'linear';
  readonly id: string;
  readonly kind: 'curve' | 'gradient';
  readonly width: number;
}

export interface CompiledKernelModule {
  readonly access: ModuleAccess;
  readonly config: Readonly<object>;
  readonly label?: string;
  readonly lutId?: string;
  readonly path: string;
  readonly slot: number;
  readonly source: 'author' | 'compiler';
  readonly stage: CompiledKernelStage;
  readonly stageIndex: number;
  readonly type: string;
  readonly version: number;
}

export interface CompiledKernelDescription {
  readonly modules: readonly CompiledKernelModule[];
  readonly name: 'NachiEmitterInit' | 'NachiEmitterUpdate';
  readonly stage: CompiledKernelStage;
  readonly workgroupSize: number;
}

export interface CompiledUniformDescription {
  readonly default: unknown;
  readonly path: ParameterPath;
  readonly tslType: TslStorageType;
  readonly type: AttributeType;
}

export interface CompiledEmitterMeta {
  readonly moduleSlots: readonly {
    readonly label?: string;
    readonly path: string;
    readonly slot: number;
    readonly stage: CompiledKernelStage;
    readonly stageIndex: number;
    readonly type: string;
  }[];
  readonly storageBufferCount: number;
}

export type KernelNodeInput = KernelNode | boolean | number | readonly number[];

export interface KernelNode {
  readonly a: KernelNode;
  readonly b: KernelNode;
  readonly g: KernelNode;
  readonly r: KernelNode;
  readonly rgb: KernelNode;
  readonly w: KernelNode;
  readonly x: KernelNode;
  readonly xyz: KernelNode;
  readonly y: KernelNode;
  readonly z: KernelNode;
  add(value: KernelNodeInput): KernelNode;
  addAssign(value: KernelNodeInput): KernelNode;
  assign(value: KernelNodeInput): KernelNode;
  bitXor(value: KernelNodeInput): KernelNode;
  clamp(minimum: KernelNodeInput, maximum: KernelNodeInput): KernelNode;
  div(value: KernelNodeInput): KernelNode;
  mul(value: KernelNodeInput): KernelNode;
  mulAssign(value: KernelNodeInput): KernelNode;
  pow(value: KernelNodeInput): KernelNode;
  shiftRight(value: KernelNodeInput): KernelNode;
  sqrt(): KernelNode;
  sub(value: KernelNodeInput): KernelNode;
  toFloat(): KernelNode;
}

export interface KernelStorageNode {
  readonly value: unknown;
  element(index: KernelNode): KernelNode;
  setName(name: string): KernelStorageNode;
}

export interface KernelUniformNode extends KernelNode {
  value: unknown;
}

export interface KernelComputeNode {
  setName(name: string): KernelComputeNode;
}

export interface KernelComputeBuilder {
  compute(count: number, workgroupSize: readonly [number]): KernelComputeNode;
}

export interface KernelTslAdapter {
  readonly deviceLimits?: {
    readonly maxStorageBuffersPerShaderStage?: number;
  };
  readonly instanceIndex: KernelNode;
  constant(value: unknown, type: AttributeType): KernelNode;
  cos(value: KernelNodeInput): KernelNode;
  dataTexture(lut: BakedLut): unknown;
  fn(callback: () => void): KernelComputeBuilder;
  instancedArray(length: number, type: TslStorageType): KernelStorageNode;
  sampleTexture(texture: unknown, uv: KernelNode): KernelNode;
  sin(value: KernelNodeInput): KernelNode;
  uniform(value: unknown, type: TslStorageType): KernelUniformNode;
  uint(value: KernelNodeInput): KernelNode;
  vec2(x: KernelNodeInput, y: KernelNodeInput): KernelNode;
  vec3(x: KernelNodeInput, y: KernelNodeInput, z: KernelNodeInput): KernelNode;
  vec4(x: KernelNodeInput, y: KernelNodeInput, z: KernelNodeInput, w: KernelNodeInput): KernelNode;
}

export interface BuiltEmitterKernels {
  readonly init: KernelComputeNode;
  readonly luts: Readonly<Record<string, unknown>>;
  readonly storages: Readonly<Record<string, KernelStorageNode>>;
  readonly uniforms: Readonly<Record<string, KernelUniformNode>>;
  readonly update: KernelComputeNode;
}

export interface KernelModuleBuildContext {
  readonly adapter: KernelTslAdapter;
  readonly module: CompiledKernelModule;
  attribute(name: string): KernelNode;
  random(sampleOffset?: number): KernelNode;
  sampleLut(id: string, coordinate: KernelNode): KernelNode;
  uniform(path: ParameterPath): KernelUniformNode;
  value(input: unknown, type: AttributeType, sampleOffset?: number): KernelNode;
  write(name: string, value: KernelNodeInput): void;
}

export interface KernelModuleImplementation {
  readonly access: ModuleAccess;
  readonly build: (context: KernelModuleBuildContext) => void;
  readonly stage: CompiledKernelStage;
  readonly type: string;
  readonly version: number;
}

export class KernelModuleRegistry {
  readonly #implementations = new Map<string, KernelModuleImplementation>();

  register(implementation: KernelModuleImplementation): void {
    const key = registryKey(implementation.type, implementation.version);
    const registered = this.#implementations.get(key);
    if (registered !== undefined && registered !== implementation) {
      throw new Error(`Kernel module implementation ${key} is already registered.`);
    }
    this.#implementations.set(key, implementation);
  }

  resolve(type: string, version: number): KernelModuleImplementation | undefined {
    return this.#implementations.get(registryKey(type, version));
  }
}

export interface CompileEmitterOptions {
  readonly deltaTime?: number;
  readonly emitterSeed?: number;
  readonly registry?: KernelModuleRegistry;
  readonly resolveTsl?: (reference: TslFunctionRef) => TslModuleFactory | undefined;
  readonly spawnGeneration?: number;
  readonly workgroupSize?: number;
}

export interface CompiledEmitterProgram {
  readonly attributeSchema: ResolvedAttributeSchema;
  readonly buildKernels: (adapter: KernelTslAdapter) => BuiltEmitterKernels;
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly kernels: {
    readonly init: CompiledKernelDescription;
    readonly update: CompiledKernelDescription;
  };
  readonly luts: readonly BakedLut[];
  readonly meta: CompiledEmitterMeta;
  readonly uniforms: readonly CompiledUniformDescription[];
}

type TraceResult = {
  readonly access: ModuleAccess;
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly factory?: TslModuleFactory;
};

type NormalizedModules = {
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly factories: ReadonlyMap<string, TslModuleFactory>;
  readonly init: readonly InitModule[];
  readonly update: readonly UpdateModule[];
};

const INTEGRATE_ACCESS: ModuleAccess = {
  reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
  writes: ['Particles.position'],
};

const AGE_ACCESS: ModuleAccess = {
  reads: ['Emitter.deltaTime', 'Particles.age', 'Particles.lifetime'],
  writes: ['Particles.age', 'Particles.normalizedAge'],
};

const AGE_MODULE: UpdateModule = {
  access: AGE_ACCESS,
  config: {},
  kind: 'module',
  label: '$age',
  stage: 'update',
  type: 'core/age',
  version: 1,
};

const INTEGRATE_MODULE: UpdateModule = {
  access: INTEGRATE_ACCESS,
  config: {},
  kind: 'module',
  label: '$integrate',
  stage: 'update',
  type: 'core/integrate',
  version: 1,
};

const SYSTEM_PATHS = new Set<ParameterPath>(['System.deltaTime', 'System.time']);
const EMITTER_PATHS = new Set<ParameterPath>([
  'Emitter.age',
  'Emitter.deltaTime',
  'Emitter.events.pending',
  'Emitter.localTime',
  'Emitter.loopIndex',
  'Emitter.seed',
  'Emitter.spawnCount',
  'Emitter.spawnGeneration',
  'Emitter.transform',
]);
const MATERIALIZED_PARAMETER_PATHS = new Set<ParameterPath>([
  'System.deltaTime',
  'System.time',
  'Emitter.age',
  'Emitter.deltaTime',
  'Emitter.localTime',
  'Emitter.loopIndex',
  'Emitter.seed',
  'Emitter.spawnGeneration',
  'Emitter.transform',
]);

function isKnownEmitterPath(reference: ParameterPath): boolean {
  return (
    EMITTER_PATHS.has(reference) ||
    /^Emitter\.events\..+/.test(reference) ||
    /^Emitter\.eventPayload\..+/.test(reference)
  );
}

function registryKey(type: string, version: number): string {
  return `${type}@${version}`;
}

function diagnostic(
  code: string,
  message: string,
  path: string,
  severity: 'error' | 'warning' = 'error',
): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity };
}

function hasErrors(diagnostics: readonly VfxDiagnostic[]): boolean {
  return diagnostics.some(({ severity }) => severity === 'error');
}

function includesImplementationAccess(declared: ModuleAccess, expected: ModuleAccess): boolean {
  return (
    expected.reads.every((path) => declared.reads.includes(path)) &&
    expected.writes.every((path) => declared.writes.includes(path)) &&
    (expected.optionalReads ?? []).every((path) => declared.optionalReads?.includes(path) === true)
  );
}

function bindingPath(key: string): DataReference {
  return (
    key.startsWith('custom.') ? `Particles.${key.slice('custom.'.length)}` : `Particles.${key}`
  ) as DataReference;
}

function traceExpression(): object {
  const callable = () => proxy;
  const proxy: object = new Proxy(callable, {
    apply: () => proxy,
    get: (_target, property) => (property === 'then' ? undefined : proxy),
  });
  return proxy;
}

function traceTslModule(
  module: TslModuleDefinition,
  path: string,
  options: CompileEmitterOptions,
): TraceResult {
  const diagnostics: VfxDiagnostic[] = [];
  const reads = new Set<DataReference>();
  const writes = new Set<DataReference>();
  const source = module.config.source;
  const factory =
    module.factory ?? (source.kind === 'function-ref' ? options.resolveTsl?.(source) : undefined);
  if (factory === undefined) {
    diagnostics.push(
      diagnostic(
        'NACHI_TSL_FACTORY_MISSING',
        'TSL module factory could not be resolved for tracing.',
        `${path}.config.source`,
      ),
    );
    return { access: module.access ?? { reads: [], writes: [] }, diagnostics };
  }

  const bindings = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        reads.add(bindingPath(property));
        return traceExpression();
      },
    },
  );

  try {
    const output = factory(bindings as TslParticleBindings);
    for (const key of Object.keys(output)) writes.add(bindingPath(key));
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'NACHI_TSL_TRACE_FAILED',
        `TSL module tracing failed: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ),
    );
  }

  const traced: ModuleAccess = { reads: [...reads], writes: [...writes] };
  if (module.access === undefined) return { access: traced, diagnostics, factory };

  const declaredReads = new Set([...module.access.reads, ...(module.access.optionalReads ?? [])]);
  for (const read of traced.reads) {
    if (!declaredReads.has(read)) {
      diagnostics.push(
        diagnostic(
          'NACHI_TSL_UNDECLARED_READ',
          `Traced TSL read "${read}" is absent from the declared access manifest.`,
          `${path}.access.reads`,
        ),
      );
    }
  }
  for (const write of traced.writes) {
    if (!module.access.writes.includes(write)) {
      diagnostics.push(
        diagnostic(
          'NACHI_TSL_UNDECLARED_WRITE',
          `Traced TSL write "${write}" is absent from the declared access manifest.`,
          `${path}.access.writes`,
        ),
      );
    }
  }
  return { access: module.access, diagnostics, factory };
}

function withAccess<Stage extends 'init' | 'update'>(
  module: ModuleDefinition<Stage, object>,
  access: ModuleAccess,
): ModuleDefinition<Stage, object> {
  return { ...module, access };
}

function deriveConfigReads(config: object): DataReference[] {
  const reads = new Set<DataReference>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    visited.add(value);
    const kind = 'kind' in value ? value.kind : undefined;
    if (kind === 'range') {
      reads.add('Emitter.seed');
      reads.add('Emitter.spawnGeneration');
    } else if (kind === 'parameter' && 'path' in value && typeof value.path === 'string') {
      reads.add(value.path as DataReference);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(config);
  return [...reads];
}

function withDerivedConfigReads<Stage extends 'init' | 'update'>(
  module: ModuleDefinition<Stage, object>,
): ModuleDefinition<Stage, object> {
  const derivedReads = deriveConfigReads(module.config);
  if (derivedReads.length === 0) return module;
  const access = module.access ?? { reads: [], writes: [] };
  return withAccess(module, {
    ...access,
    reads: [...new Set([...access.reads, ...derivedReads])],
  });
}

function defaultsModule(schema: ResolvedAttributeSchema): InitModule {
  const config = {
    attributes: schema.attributes.map(
      ({ default: defaultValue, logicalType, name, storageIndex }) => ({
        default: defaultValue,
        logicalType,
        name,
        storageIndex,
      }),
    ),
  };
  return {
    access: {
      reads: deriveConfigReads(config),
      writes: schema.attributes.map(({ path }) => path),
    },
    config,
    kind: 'module',
    label: '$defaults',
    stage: 'init',
    type: 'core/defaults',
    version: 1,
  };
}

function normalizeModules(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  options: CompileEmitterOptions,
): NormalizedModules {
  const diagnostics: VfxDiagnostic[] = [];
  const factories = new Map<string, TslModuleFactory>();
  const normalize = <Stage extends 'init' | 'update'>(
    modules: readonly ModuleDefinition<Stage, object>[],
    stage: Stage,
  ): ModuleDefinition<Stage, object>[] =>
    modules.map((module, index) => {
      if (module.type !== 'core/tsl-module') return withDerivedConfigReads(module);
      const path = `${stage}[${index}]`;
      const trace = traceTslModule(module as TslModuleDefinition, path, options);
      diagnostics.push(...trace.diagnostics);
      if (trace.factory) factories.set(path, trace.factory);
      return withDerivedConfigReads(withAccess(module, trace.access));
    });

  const init = normalize(definition.init ?? [], 'init') as InitModule[];
  const update = normalize(definition.update ?? [], 'update') as UpdateModule[];
  if (definition.integration !== 'none') {
    for (const [index, module] of update.entries()) {
      if (module.access?.writes.includes('Particles.position')) {
        diagnostics.push(
          diagnostic(
            'NACHI_INTEGRATION_DOUBLE_APPLY',
            'An author update module writes Particles.position while compiler integration is enabled; select integration: "none" to provide a custom integrator.',
            `update[${index}].access.writes`,
          ),
        );
      }
    }
    update.push(INTEGRATE_MODULE);
  }
  return { diagnostics, factories, init, update };
}

function emptyAttributeSchema(capacity: number): ResolvedAttributeSchema {
  return {
    attributes: [],
    byName: {},
    capacity,
    kind: 'resolved-attribute-schema',
    layout: 'soa',
    storageArrays: [],
  };
}

function moduleDescriptor(
  module: ModuleDefinition<'init' | 'update', object>,
  path: string,
  stageIndex: number,
  source: 'author' | 'compiler',
): CompiledKernelModule {
  const base = {
    access: module.access ?? { reads: [], writes: [] },
    config: module.config,
    path,
    slot: resolveModuleSlot(module, stageIndex),
    source,
    stage: module.stage,
    stageIndex,
    type: module.type,
    version: module.version,
  } as const;
  return module.label === undefined ? base : { ...base, label: module.label };
}

function validateModule(
  module: CompiledKernelModule,
  registry: KernelModuleRegistry,
): VfxDiagnostic[] {
  if (module.type === 'core/tsl-module') return [];
  const implementation = registry.resolve(module.type, module.version);
  if (implementation === undefined) {
    return [
      diagnostic(
        'NACHI_MODULE_UNKNOWN',
        `No kernel implementation is registered for ${module.type}@${module.version}.`,
        module.path,
      ),
    ];
  }
  const diagnostics: VfxDiagnostic[] = [];
  if (implementation.stage !== module.stage) {
    diagnostics.push(
      diagnostic(
        'NACHI_MODULE_STAGE_MISMATCH',
        `Module ${module.type} is registered for ${implementation.stage}, not ${module.stage}.`,
        `${module.path}.stage`,
      ),
    );
  }
  if (!includesImplementationAccess(module.access, implementation.access)) {
    diagnostics.push(
      diagnostic(
        'NACHI_MODULE_ACCESS_MISMATCH',
        `Module ${module.type} access does not include its implementation reads and writes.`,
        `${module.path}.access`,
      ),
    );
  }
  return diagnostics;
}

function validateReferences(
  modules: readonly CompiledKernelModule[],
  parameters: ParameterSchema | undefined,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const declaredParameters = new Set(Object.keys(parameters ?? {}));
  for (const module of modules) {
    for (const [kind, references] of [
      ['reads', module.access.reads],
      ['writes', module.access.writes],
    ] as const) {
      for (const [index, reference] of references.entries()) {
        if (reference.startsWith('Particles.')) continue;
        const known =
          SYSTEM_PATHS.has(reference) ||
          isKnownEmitterPath(reference) ||
          (reference.startsWith('User.') && declaredParameters.has(reference));
        if (!known) {
          diagnostics.push(
            diagnostic(
              'NACHI_PARAMETER_UNKNOWN_REFERENCE',
              `Module ${kind} unknown parameter path "${reference}".`,
              `${module.path}.access.${kind}[${index}]`,
            ),
          );
        }
      }
    }
    // optionalReads deliberately do not diagnose absence; materializers provide fallbacks.
  }
  return diagnostics;
}

function validateValueGenerators(
  modules: readonly Pick<CompiledKernelModule, 'config' | 'path'>[],
  parameters: ParameterSchema | undefined,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const declaredParameters = new Set(Object.keys(parameters ?? {}));

  for (const module of modules) {
    const visited = new WeakSet<object>();
    const visit = (value: unknown, path: string): void => {
      if (typeof value !== 'object' || value === null || visited.has(value)) return;
      visited.add(value);
      const kind = 'kind' in value ? value.kind : undefined;

      if (kind === 'curve' && 'keys' in value && Array.isArray(value.keys)) {
        if (value.keys.length < 2) {
          diagnostics.push(
            diagnostic(
              'NACHI_CURVE_POINT_COUNT_INVALID',
              `Curve generators require at least two keys; received ${value.keys.length}.`,
              `${path}.keys`,
            ),
          );
        }
        for (const [index, key] of value.keys.entries()) {
          if (typeof key !== 'object' || key === null || !('interpolation' in key)) continue;
          const interpolation = key.interpolation;
          if (interpolation !== undefined && interpolation !== 'linear') {
            diagnostics.push(
              diagnostic(
                'NACHI_CURVE_INTERPOLATION_UNSUPPORTED',
                `Curve interpolation "${String(interpolation)}" is not supported; use "linear".`,
                `${path}.keys[${index}].interpolation`,
              ),
            );
          }
        }
      } else if (kind === 'gradient' && 'stops' in value && Array.isArray(value.stops)) {
        if (value.stops.length < 2) {
          diagnostics.push(
            diagnostic(
              'NACHI_GRADIENT_STOP_COUNT_INVALID',
              `Gradient generators require at least two stops; received ${value.stops.length}.`,
              `${path}.stops`,
            ),
          );
        }
      } else if (kind === 'parameter' && 'path' in value && typeof value.path === 'string') {
        const generatorPath = value.path as ParameterPath;
        const supported =
          MATERIALIZED_PARAMETER_PATHS.has(generatorPath) ||
          (generatorPath.startsWith('User.') && declaredParameters.has(generatorPath));
        if (!supported && !generatorPath.startsWith('User.')) {
          diagnostics.push(
            diagnostic(
              'NACHI_PARAMETER_GENERATOR_UNSUPPORTED_TARGET',
              `parameter() target "${generatorPath}" is not materialized as an M1 kernel uniform.`,
              `${path}.path`,
            ),
          );
        }
      }

      for (const [key, nested] of Object.entries(value)) visit(nested, `${path}.${key}`);
    };
    visit(module.config, `${module.path}.config`);
  }

  return diagnostics;
}

function unusedAttributeWarnings(
  schema: ResolvedAttributeSchema,
  modules: readonly Pick<ModuleDefinition, 'access'>[],
): VfxDiagnostic[] {
  const used = new Set(
    modules
      .flatMap(({ access }) =>
        access ? [...access.reads, ...(access.optionalReads ?? []), ...access.writes] : [],
      )
      .filter((path) => path.startsWith('Particles.')),
  );
  return schema.attributes
    .filter(({ path, source }) => source === 'custom' && !used.has(path))
    .map(({ name }) =>
      diagnostic(
        'NACHI_ATTRIBUTE_UNUSED',
        `Custom attribute "${name}" is declared but unused.`,
        `attributes.${name}`,
        'warning',
      ),
    );
}

function uniformDescriptions(
  parameters: ParameterSchema | undefined,
  options: CompileEmitterOptions,
): CompiledUniformDescription[] {
  const describe = (
    path: ParameterPath,
    defaultValue: unknown,
    type: AttributeType,
  ): CompiledUniformDescription => ({
    default: defaultValue,
    path,
    tslType: resolveTslStorageType(type),
    type,
  });
  const uniforms: CompiledUniformDescription[] = [
    describe('System.time', 0, 'f32'),
    describe('System.deltaTime', options.deltaTime ?? 1 / 60, 'f32'),
    describe('Emitter.age', 0, 'f32'),
    describe('Emitter.deltaTime', options.deltaTime ?? 1 / 60, 'f32'),
    describe('Emitter.localTime', 0, 'f32'),
    describe('Emitter.loopIndex', 0, 'u32'),
    describe('Emitter.seed', options.emitterSeed ?? 0, 'u32'),
    describe('Emitter.spawnGeneration', options.spawnGeneration ?? 0, 'u32'),
    describe('Emitter.transform', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'mat4'),
  ];
  for (const [path, definition] of Object.entries(parameters ?? {})) {
    if (path.startsWith('User.')) {
      uniforms.push(describe(path as ParameterPath, definition.default, definition.type));
    }
  }
  return uniforms;
}

function normalizeColor(input: ColorInput): Vec4 {
  if (typeof input !== 'string') {
    return input.length === 4 ? input : [input[0], input[1], input[2], 1];
  }
  const hex = input.startsWith('#') ? input.slice(1) : input;
  const expanded =
    hex.length === 3 ? [...hex].map((character) => character.repeat(2)).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) throw new Error(`Unsupported color "${input}".`);
  const srgbToLinear = (channel: number): number =>
    channel < 0.04045
      ? channel * 0.0773993808
      : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
  return [
    srgbToLinear(Number.parseInt(expanded.slice(0, 2), 16) / 255),
    srgbToLinear(Number.parseInt(expanded.slice(2, 4), 16) / 255),
    srgbToLinear(Number.parseInt(expanded.slice(4, 6), 16) / 255),
    1,
  ];
}

export function sampleCurve(curve: CurveGenerator<number>, time: number): number {
  if (curve.keys.length < 2) throw new Error('Curve requires at least two keys.');
  const unsupported = curve.keys.find(
    ({ interpolation }) => interpolation !== undefined && interpolation !== 'linear',
  )?.interpolation;
  if (unsupported !== undefined) {
    throw new Error(`Curve interpolation "${unsupported}" is not supported.`);
  }
  const keys = [...curve.keys].sort((left, right) => left.time - right.time);
  if (time <= (keys[0]?.time ?? 0)) return keys[0]?.value ?? 0;
  const last = keys.at(-1);
  if (last && time >= last.time) return last.value;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index];
    const right = keys[index + 1];
    if (!left || !right || time > right.time) continue;
    const alpha = (time - left.time) / (right.time - left.time);
    return left.value + (right.value - left.value) * alpha;
  }
  return last?.value ?? 0;
}

export function bakeCurveLut(
  curve: CurveGenerator<number>,
  id = 'curve',
  width = DEFAULT_LUT_RESOLUTION,
): BakedLut {
  const data = new Float32Array(width);
  for (let index = 0; index < width; index += 1) {
    data[index] = sampleCurve(curve, index / (width - 1));
  }
  return { channels: 1, data, filter: 'linear', id, kind: 'curve', width };
}

function sampleGradient(gradient: GradientGenerator, time: number): Vec4 {
  if (gradient.stops.length < 2) throw new Error('Gradient requires at least two stops.');
  const stops = [...gradient.stops].sort((left, right) => left.position - right.position);
  const first = stops[0];
  if (first && time <= first.position) return normalizeColor(first.color);
  const last = stops.at(-1);
  if (last && time >= last.position) return normalizeColor(last.color);
  for (let index = 0; index < stops.length - 1; index += 1) {
    const left = stops[index];
    const right = stops[index + 1];
    if (!left || !right || time > right.position) continue;
    const alpha = (time - left.position) / (right.position - left.position);
    const leftColor = normalizeColor(left.color);
    const rightColor = normalizeColor(right.color);
    return [0, 1, 2, 3].map(
      (channel) =>
        (leftColor[channel] ?? 0) +
        ((rightColor[channel] ?? 0) - (leftColor[channel] ?? 0)) * alpha,
    ) as unknown as Vec4;
  }
  return last ? normalizeColor(last.color) : [0, 0, 0, 1];
}

export function bakeGradientLut(
  gradient: GradientGenerator,
  id = 'gradient',
  width = DEFAULT_LUT_RESOLUTION,
): BakedLut {
  const data = new Float32Array(width * 4);
  for (let index = 0; index < width; index += 1) {
    data.set(sampleGradient(gradient, index / (width - 1)), index * 4);
  }
  return { channels: 4, data, filter: 'linear', id, kind: 'gradient', width };
}

function bakeModuleLuts(
  modules: readonly CompiledKernelModule[],
  diagnostics: VfxDiagnostic[],
): { readonly luts: BakedLut[]; readonly modules: CompiledKernelModule[] } {
  const luts: BakedLut[] = [];
  const normalized = modules.map((module) => {
    try {
      if (module.type === 'core/size-over-life') {
        const curve = (module.config as { value: CurveGenerator<number> }).value;
        if (
          curve.keys.length < 2 ||
          curve.keys.some(
            ({ interpolation }) => interpolation !== undefined && interpolation !== 'linear',
          )
        ) {
          return module;
        }
        const id = `${module.path}:curve`;
        luts.push(bakeCurveLut(curve, id));
        return { ...module, lutId: id };
      }
      if (module.type === 'core/color-over-life') {
        const gradient = (module.config as { value: GradientGenerator }).value;
        if (gradient.stops.length < 2) return module;
        const id = `${module.path}:gradient`;
        luts.push(bakeGradientLut(gradient, id));
        return { ...module, lutId: id };
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'NACHI_LUT_BAKE_FAILED',
          `LUT baking failed: ${error instanceof Error ? error.message : String(error)}`,
          module.path,
        ),
      );
    }
    return module;
  });
  return { luts, modules: normalized };
}

function valueGeneratorKind(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'kind' in value
    ? String(value.kind)
    : undefined;
}

function createBuildKernels(
  program: Omit<CompiledEmitterProgram, 'buildKernels'>,
  registry: KernelModuleRegistry,
  factories: ReadonlyMap<string, TslModuleFactory>,
): (adapter: KernelTslAdapter) => BuiltEmitterKernels {
  return (adapter) => {
    const buildDiagnostics = [...program.diagnostics];
    const storageBufferLimit = adapter.deviceLimits?.maxStorageBuffersPerShaderStage;
    if (
      storageBufferLimit !== undefined &&
      program.meta.storageBufferCount > storageBufferLimit &&
      !buildDiagnostics.some(({ code }) => code === 'NACHI_STORAGE_BUFFER_LIMIT')
    ) {
      buildDiagnostics.push({
        code: 'NACHI_STORAGE_BUFFER_LIMIT',
        hint: 'Request a higher device limit or reduce the resolved attribute schema.',
        message: `Emitter requires ${program.meta.storageBufferCount} storage buffers, but the device exposes ${storageBufferLimit} per shader stage.`,
        path: 'meta.storageBufferCount',
        phase: 'compile',
        severity: 'error',
      });
    }
    if (hasErrors(buildDiagnostics)) throw new VfxDiagnosticError(buildDiagnostics);

    const storages = Object.fromEntries(
      program.attributeSchema.storageArrays.map((storage) => [
        storage.attribute,
        adapter
          .instancedArray(storage.length, storage.type)
          .setName(`NachiParticles_${storage.attribute}`),
      ]),
    ) as Record<string, KernelStorageNode>;
    const uniforms = Object.fromEntries(
      program.uniforms.map((description) => [
        description.path,
        adapter.uniform(description.default, description.tslType),
      ]),
    ) as Record<string, KernelUniformNode>;
    const lutTextures = Object.fromEntries(
      program.luts.map((lut) => [lut.id, adapter.dataTexture(lut)]),
    );

    const attributeNode = (name: string): KernelNode => {
      const storage = storages[name];
      if (!storage) throw new Error(`Compiled storage for attribute "${name}" is missing.`);
      return storage.element(adapter.instanceIndex);
    };
    const uniformNode = (path: ParameterPath): KernelUniformNode => {
      const uniform = uniforms[path];
      if (!uniform) throw new Error(`Compiled uniform "${path}" is missing.`);
      return uniform;
    };
    const constant = (value: unknown, type: AttributeType): KernelNode =>
      adapter.constant(value, type);
    const randomNode = (module: CompiledKernelModule, sampleOffset: number): KernelNode =>
      pcgRandomFloatNode<KernelNode, KernelNode>(
        adapter.uint(adapter.instanceIndex),
        adapter.uint(uniformNode('Emitter.seed')),
        resolveRandomSampleSlot(module.slot, sampleOffset),
        adapter.uint(uniformNode('Emitter.spawnGeneration')),
      );

    const buildValue = (
      input: unknown,
      type: AttributeType,
      module: CompiledKernelModule,
      sampleOffset = 0,
    ): KernelNode => {
      const kind = valueGeneratorKind(input);
      if (kind === 'parameter') {
        const generator = input as ParameterGenerator;
        return uniforms[generator.path] ?? constant(generator.fallback ?? 0, type);
      }
      if (kind === 'range') {
        const range = input as RangeGenerator<number | readonly number[]>;
        const componentCount =
          type === 'vec2'
            ? 2
            : type === 'vec3'
              ? 3
              : type === 'vec4' || type === 'color' || type === 'quat'
                ? 4
                : undefined;
        const rangeMinimum = range.min;
        const rangeMaximum = range.max;
        if (
          componentCount !== undefined &&
          Array.isArray(rangeMinimum) &&
          Array.isArray(rangeMaximum)
        ) {
          const components = Array.from({ length: componentCount }, (_, index) => {
            const minimum = constant(rangeMinimum[index], 'f32');
            const maximum = constant(rangeMaximum[index], 'f32');
            return minimum.add(maximum.sub(minimum).mul(randomNode(module, sampleOffset + index)));
          });
          if (componentCount === 2) return adapter.vec2(components[0]!, components[1]!);
          if (componentCount === 3) {
            return adapter.vec3(components[0]!, components[1]!, components[2]!);
          }
          return adapter.vec4(components[0]!, components[1]!, components[2]!, components[3]!);
        }
        const random = randomNode(module, sampleOffset);
        const minimum = constant(range.min, type);
        const maximum = constant(range.max, type);
        return minimum.add(maximum.sub(minimum).mul(random));
      }
      return constant(input, type);
    };

    const buildContext = (module: CompiledKernelModule): KernelModuleBuildContext => ({
      adapter,
      module,
      attribute: attributeNode,
      random: (sampleOffset = 0) => randomNode(module, sampleOffset),
      sampleLut: (id, coordinate) => {
        const texture = lutTextures[id];
        const lut = program.luts.find((candidate) => candidate.id === id);
        if (!texture) throw new Error(`Compiled LUT "${id}" is missing.`);
        if (!lut) throw new Error(`Compiled LUT descriptor "${id}" is missing.`);
        const texelCentered = coordinate.mul((lut.width - 1) / lut.width).add(0.5 / lut.width);
        return adapter.sampleTexture(texture, adapter.vec2(texelCentered, 0.5));
      },
      uniform: uniformNode,
      value: (input, type, sampleOffset = 0) => buildValue(input, type, module, sampleOffset),
      write: (name, value) => {
        attributeNode(name).assign(value);
      },
    });

    const buildTslModule = (module: CompiledKernelModule): void => {
      const factory = factories.get(module.path);
      if (!factory) throw new Error(`TSL factory for ${module.path} is missing.`);
      const bindings = new Proxy(
        {},
        {
          get: (_target, property) => {
            if (typeof property !== 'string') return undefined;
            const name = property.startsWith('custom.')
              ? property.slice('custom.'.length)
              : property;
            return attributeNode(name);
          },
        },
      );
      const outputs = factory(bindings as TslParticleBindings);
      for (const [key, value] of Object.entries(outputs)) {
        const name = key.startsWith('custom.') ? key.slice('custom.'.length) : key;
        attributeNode(name).assign(value as unknown as KernelNode);
      }
    };

    const buildModule = (module: CompiledKernelModule): void => {
      if (module.type === 'core/tsl-module') {
        buildTslModule(module);
        return;
      }
      const implementation = registry.resolve(module.type, module.version);
      if (!implementation) throw new Error(`Kernel implementation for ${module.type} is missing.`);
      implementation.build(buildContext(module));
    };

    const init = adapter
      .fn(() => {
        for (const module of program.kernels.init.modules) buildModule(module);
      })
      .compute(program.attributeSchema.capacity, [program.kernels.init.workgroupSize])
      .setName(program.kernels.init.name);

    const update = adapter
      .fn(() => {
        for (const module of program.kernels.update.modules) buildModule(module);
      })
      .compute(program.attributeSchema.capacity, [program.kernels.update.workgroupSize])
      .setName(program.kernels.update.name);

    return { init, luts: lutTextures, storages, uniforms, update };
  };
}

export function compileEmitter<
  const Attributes extends AttributeSchema = AttributeSchema,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(
  definition: EmitterDefinition<Attributes, Parameters>,
  options: CompileEmitterOptions = {},
): CompiledEmitterProgram {
  const diagnostics: VfxDiagnostic[] = [];
  const registry = options.registry ?? createCoreKernelModuleRegistry();
  const untypedDefinition = definition as EmitterDefinition<AttributeSchema, ParameterSchema>;
  diagnostics.push(...collectEmitterLifecycleDiagnostics(untypedDefinition));
  diagnostics.push(...collectEmitterModuleLabelDiagnostics(untypedDefinition));
  diagnostics.push(...collectParameterDeclarationDiagnostics(untypedDefinition.parameters));
  const normalized = normalizeModules(untypedDefinition, options);
  diagnostics.push(...normalized.diagnostics);

  const authorDefinition = {
    ...definition,
    init: normalized.init,
    update: normalized.update,
  } as EmitterDefinition<AttributeSchema, ParameterSchema>;
  const authorAttributeResult = resolveAttributeSchema(authorDefinition);
  const includeAgeModule =
    authorAttributeResult.value?.byName.age !== undefined &&
    authorAttributeResult.value.byName.lifetime !== undefined;
  const normalizedDefinition = includeAgeModule
    ? ({
        ...authorDefinition,
        update: [AGE_MODULE, ...normalized.update],
      } as EmitterDefinition<AttributeSchema, ParameterSchema>)
    : authorDefinition;
  const attributeResult = includeAgeModule
    ? resolveAttributeSchema(normalizedDefinition)
    : authorAttributeResult;
  diagnostics.push(...attributeResult.diagnostics);
  const attributeSchema = attributeResult.value ?? emptyAttributeSchema(definition.capacity);
  const updateStageOffset = includeAgeModule ? 1 : 0;

  const initialModules: CompiledKernelModule[] = [
    moduleDescriptor(defaultsModule(attributeSchema), 'init[$defaults]', 0, 'compiler'),
    ...normalized.init.map((module, index) =>
      moduleDescriptor(module, `init[${index}]`, index + 1, 'author'),
    ),
    ...(includeAgeModule ? [moduleDescriptor(AGE_MODULE, 'update[$age]', 0, 'compiler')] : []),
    ...normalized.update.map((module, index) =>
      moduleDescriptor(
        module,
        module === INTEGRATE_MODULE ? 'update[$integrate]' : `update[${index}]`,
        index + updateStageOffset,
        module === INTEGRATE_MODULE ? 'compiler' : 'author',
      ),
    ),
  ];
  for (const module of initialModules) diagnostics.push(...validateModule(module, registry));
  diagnostics.push(...validateReferences(initialModules, definition.parameters));
  const nonKernelModules = collectEmitterModules(normalizedDefinition)
    .filter(({ module }) => module.stage !== 'init' && module.stage !== 'update')
    .map(({ module, path }) => ({ config: module.config, path }));
  diagnostics.push(
    ...validateValueGenerators([...initialModules, ...nonKernelModules], definition.parameters),
  );

  const baked = bakeModuleLuts(initialModules, diagnostics);
  diagnostics.push(
    ...unusedAttributeWarnings(
      attributeSchema,
      collectEmitterModules(normalizedDefinition).map(({ module }) => module),
    ),
  );
  const workgroupSize = options.workgroupSize ?? DEFAULT_WORKGROUP_SIZE;
  const initModules = baked.modules.filter(({ stage }) => stage === 'init');
  const updateModules = baked.modules.filter(({ stage }) => stage === 'update');
  const kernels = {
    init: {
      modules: initModules,
      name: 'NachiEmitterInit',
      stage: 'init',
      workgroupSize,
    },
    update: {
      modules: updateModules,
      name: 'NachiEmitterUpdate',
      stage: 'update',
      workgroupSize,
    },
  } as const;
  const uniforms = uniformDescriptions(definition.parameters, options);
  const meta: CompiledEmitterMeta = {
    moduleSlots: baked.modules.map((module) => {
      const base = {
        path: module.path,
        slot: module.slot,
        stage: module.stage,
        stageIndex: module.stageIndex,
        type: module.type,
      } as const;
      return module.label === undefined ? base : { ...base, label: module.label };
    }),
    storageBufferCount: attributeSchema.storageArrays.length,
  };
  const description = {
    attributeSchema,
    diagnostics,
    kernels,
    luts: baked.luts,
    meta,
    uniforms,
  };
  return {
    ...description,
    buildKernels: createBuildKernels(description, registry, normalized.factories),
  };
}

function inputIsVector(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (valueGeneratorKind(value) === 'range') {
    return Array.isArray((value as RangeGenerator<number | readonly number[]>).min);
  }
  if (valueGeneratorKind(value) === 'parameter') {
    return Array.isArray((value as ParameterGenerator).fallback);
  }
  return false;
}

function normalizedBasis(direction: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const length = Math.hypot(...direction) || 1;
  const up = direction.map((component) => component / length) as unknown as Vec3;
  const reference: Vec3 = Math.abs(up[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const cross = (left: Vec3, right: Vec3): Vec3 => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const rawRight = cross(reference, up);
  const rightLength = Math.hypot(...rawRight) || 1;
  const right = rawRight.map((component) => component / rightLength) as unknown as Vec3;
  return { forward: cross(up, right), right, up };
}

export function createCoreKernelModuleRegistry(): KernelModuleRegistry {
  const registry = new KernelModuleRegistry();
  registry.register({
    access: { reads: [], writes: [] },
    build(context) {
      const config = context.module.config as {
        attributes: readonly {
          default: unknown;
          logicalType: AttributeType;
          name: string;
          storageIndex: number;
        }[];
      };
      for (const attribute of config.attributes) {
        context.write(
          attribute.name,
          context.value(attribute.default, attribute.logicalType, attribute.storageIndex),
        );
      }
    },
    stage: 'init',
    type: 'core/defaults',
    version: 1,
  });
  registry.register({
    access: AGE_ACCESS,
    build(context) {
      const age = context.attribute('age').add(context.uniform('Emitter.deltaTime'));
      context.write('age', age);
      context.write('normalizedAge', age.div(context.attribute('lifetime')).clamp(0, 1));
    },
    stage: 'update',
    type: 'core/age',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Emitter.seed', 'Emitter.spawnGeneration'],
      writes: ['Particles.position'],
    },
    build(context) {
      const config = context.module.config as {
        radius: ValueInput<number>;
        surfaceOnly?: boolean;
      };
      const z = context.random(1).mul(2).sub(1);
      const azimuth = context.random(2).mul(Math.PI * 2);
      const horizontal = context.adapter.constant(1, 'f32').sub(z.mul(z)).clamp(0, 1).sqrt();
      const radius = context.value(config.radius, 'f32', 3);
      const distance = config.surfaceOnly ? radius : radius.mul(context.random(4).pow(1 / 3));
      const local = context.adapter
        .vec3(
          context.adapter.cos(azimuth).mul(horizontal),
          z,
          context.adapter.sin(azimuth).mul(horizontal),
        )
        .mul(distance);
      const world = context
        .uniform('Emitter.transform')
        .mul(context.adapter.vec4(local.x, local.y, local.z, 1)).xyz;
      context.write('position', world);
    },
    stage: 'init',
    type: 'core/position-sphere',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.seed', 'Emitter.spawnGeneration'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as {
        angle: ValueInput<number>;
        direction: Vec3;
        speed: ValueInput<number>;
      };
      const basis = normalizedBasis(config.direction);
      const angle = context.value(config.angle, 'f32', 1).mul(Math.PI / 180);
      const cosLimit = context.adapter.cos(angle);
      const cosTheta = context.adapter
        .constant(1, 'f32')
        .sub(context.random(2).mul(context.adapter.constant(1, 'f32').sub(cosLimit)));
      const sinTheta = context.adapter
        .constant(1, 'f32')
        .sub(cosTheta.mul(cosTheta))
        .clamp(0, 1)
        .sqrt();
      const azimuth = context.random(3).mul(Math.PI * 2);
      const radialX = context.adapter.cos(azimuth).mul(sinTheta);
      const radialZ = context.adapter.sin(azimuth).mul(sinTheta);
      const component = (axis: 0 | 1 | 2) =>
        radialX
          .mul(basis.right[axis])
          .add(cosTheta.mul(basis.up[axis]))
          .add(radialZ.mul(basis.forward[axis]));
      const speed = context.value(config.speed, 'f32', 4);
      context.write(
        'velocity',
        context.adapter.vec3(component(0), component(1), component(2)).mul(speed),
      );
    },
    stage: 'init',
    type: 'core/velocity-cone',
    version: 1,
  });
  registry.register({
    access: {
      reads: [],
      writes: ['Particles.age', 'Particles.lifetime'],
    },
    build(context) {
      const value = (context.module.config as { value: ValueInput<number> }).value;
      context.write('age', context.adapter.constant(0, 'f32'));
      context.write('lifetime', context.value(value, 'f32'));
      if (context.module.access.writes.includes('Particles.normalizedAge')) {
        context.write('normalizedAge', context.adapter.constant(0, 'f32'));
      }
    },
    stage: 'init',
    type: 'core/lifetime',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const input = (context.module.config as { value: unknown }).value;
      const gravity = inputIsVector(input)
        ? context.value(input, 'vec3')
        : context.adapter.vec3(0, context.value(input, 'f32'), 0);
      context.attribute('velocity').addAssign(gravity.mul(context.uniform('Emitter.deltaTime')));
    },
    stage: 'update',
    type: 'core/gravity',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const drag = context.value((context.module.config as { value: unknown }).value, 'f32');
      const damping = context.adapter
        .constant(1, 'f32')
        .sub(drag.mul(context.uniform('Emitter.deltaTime')))
        .clamp(0, 1);
      context.attribute('velocity').mulAssign(damping);
    },
    stage: 'update',
    type: 'core/drag',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as { frequency: unknown; strength: unknown };
      const position = context.attribute('position');
      const frequency = context.value(config.frequency, 'f32');
      const field = context.adapter.vec3(
        context.adapter
          .sin(position.y.mul(frequency))
          .sub(context.adapter.cos(position.z.mul(frequency))),
        context.adapter
          .sin(position.z.mul(frequency))
          .sub(context.adapter.cos(position.x.mul(frequency))),
        context.adapter
          .sin(position.x.mul(frequency))
          .sub(context.adapter.cos(position.y.mul(frequency))),
      );
      context
        .attribute('velocity')
        .addAssign(
          field
            .mul(context.value(config.strength, 'f32'))
            .mul(context.uniform('Emitter.deltaTime')),
        );
    },
    stage: 'update',
    type: 'core/curl-noise',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.size'],
    },
    build(context) {
      if (!context.module.lutId) throw new Error('sizeOverLife LUT is missing.');
      context.write(
        'size',
        context.sampleLut(context.module.lutId, context.attribute('normalizedAge')).r,
      );
    },
    stage: 'update',
    type: 'core/size-over-life',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.color'],
    },
    build(context) {
      if (!context.module.lutId) throw new Error('colorOverLife LUT is missing.');
      context.write(
        'color',
        context.sampleLut(context.module.lutId, context.attribute('normalizedAge')),
      );
    },
    stage: 'update',
    type: 'core/color-over-life',
    version: 1,
  });
  registry.register({
    access: INTEGRATE_ACCESS,
    build(context) {
      context
        .attribute('position')
        .addAssign(context.attribute('velocity').mul(context.uniform('Emitter.deltaTime')));
    },
    stage: 'update',
    type: 'core/integrate',
    version: 1,
  });
  return registry;
}

export function coreModuleImplementationAccess(): Readonly<Record<string, ModuleAccess>> {
  const registry = createCoreKernelModuleRegistry();
  return Object.fromEntries(
    [
      'core/defaults',
      'core/age',
      'core/position-sphere',
      'core/velocity-cone',
      'core/lifetime',
      'core/gravity',
      'core/drag',
      'core/curl-noise',
      'core/size-over-life',
      'core/color-over-life',
      'core/integrate',
    ].map((type) => [type, registry.resolve(type, 1)?.access]),
  ) as Readonly<Record<string, ModuleAccess>>;
}
