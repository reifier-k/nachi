import {
  resolveAttributeSchema,
  resolvePackedAttributeAddress,
  resolveTslStorageType,
} from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import { pcgRandomFloatNode, resolveModuleSlot, resolveRandomSampleSlot } from './random.js';
import {
  collectEmitterBehaviorConfigDiagnostics,
  collectEmitterLifecycleDiagnostics,
  collectEmitterModuleLabelDiagnostics,
  collectEmitterModules,
  collectParameterDeclarationDiagnostics,
} from './emitter-modules.js';
import type {
  AttributeSchema,
  AttributeType,
  BillboardOptions,
  BlendingMode,
  ColorInput,
  CollideBoxOptions,
  CollidePlaneOptions,
  CollideSceneDepthOptions,
  CollideSdfOptions,
  CollideSphereOptions,
  CollisionMode,
  CurveGenerator,
  DataReference,
  EmitterDefinition,
  EmitterLifecycle,
  EmptyParameterSchema,
  FieldRef,
  GeometryRef,
  GradientGenerator,
  InitModule,
  MeshRendererOptions,
  MeshRef,
  ModuleAccess,
  ModuleDefinition,
  ParameterGenerator,
  ParameterPath,
  ParameterSchema,
  RangeGenerator,
  ResolvedAttributeSchema,
  SpawnModule,
  TslFunctionRef,
  TslModuleDefinition,
  TslModuleFactory,
  TslParticleBindings,
  TslStorageType,
  TextureRef,
  TurbulenceOptions,
  UpdateModule,
  ValueInput,
  Vec3,
  Vec4,
  VfxDiagnostic,
  VectorFieldOptions,
  VortexOptions,
  PointAttractorOptions,
  PositionMeshSurfaceOptions,
  SdfRef,
  VelocityMeshNormalOptions,
  KillVolumeOptions,
} from './types.js';

export const DEFAULT_LUT_RESOLUTION = 256;
export const DEFAULT_WORKGROUP_SIZE = 64;
/** Measured peak magnitude of Three r185's centered snoise scalar. */
export const TURBULENCE_SIMPLEX_AMPLITUDE = 0.286;
/** Measured peak magnitude of the centered finite-difference simplex potential curl. */
export const CURL_SIMPLEX_DERIVATIVE_AMPLITUDE = 6;
export const CURL_NOISE_FINITE_DIFFERENCE = 0.1;
/** Calibrated by spike-depth for a visible but localized intersection transition. */
export const DEFAULT_SOFT_PARTICLE_FADE_DISTANCE = 0.035;

export type CompiledKernelStage = 'init' | 'update';
export type CompiledModuleStage = CompiledKernelStage | 'spawn';

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

export interface CompiledSpawnDescription {
  readonly modules: readonly CompiledSpawnModule[];
  readonly workgroupSize: number;
}

export interface CompiledSpawnModule {
  readonly access: ModuleAccess;
  readonly config: Readonly<object>;
  readonly label?: string;
  readonly path: string;
  readonly slot: number;
  readonly stage: 'spawn';
  readonly stageIndex: number;
  readonly type: string;
  readonly version: number;
}

export interface CompiledUniformDescription {
  readonly default: unknown;
  readonly path: ParameterPath;
  readonly tslType: TslStorageType;
  readonly type: AttributeType;
}

export interface CompiledEmitterMeta {
  readonly backendBudgets: {
    readonly webgl2: {
      readonly defaultSpawnVaryingLimit: 4;
      readonly spawnVaryingCount: number;
      readonly spawnVaryings: readonly string[];
    };
    readonly webgpu: {
      readonly defaultVertexStorageBufferLimit: 8;
      readonly vertexStorageBufferCount: number;
      readonly vertexStorageBuffers: readonly string[];
    };
  };
  readonly capabilities: {
    readonly webgl2: {
      readonly aliveCount: 'cpu-readback';
      readonly allocation: 'prefix-cpu-fallback';
      readonly indirectDraw: false;
    };
    readonly webgpu: {
      readonly aliveCount: 'atomic-compaction';
      readonly allocation: 'atomic-free-list';
      readonly indirectDraw: true;
    };
  };
  readonly lifecycleStorage: {
    readonly buffers: {
      readonly indirectArguments: {
        readonly fields: {
          readonly drawIndirect: LifecycleStorageFieldMeta;
          readonly spawnDispatch: LifecycleStorageFieldMeta;
        };
        readonly wordCount: number;
      };
      readonly state: {
        readonly fields: {
          readonly aliveCount: LifecycleStorageFieldMeta;
          readonly aliveIndices: LifecycleStorageFieldMeta;
          readonly freeCount: LifecycleStorageFieldMeta;
          readonly freeList: LifecycleStorageFieldMeta;
          readonly spawnOverflow: LifecycleStorageFieldMeta;
          readonly spawnSuccess: LifecycleStorageFieldMeta;
        };
        readonly wordCount: number;
      };
    };
    readonly wordCount: number;
  };
  /** M5 producer-owned, double-buffered append queues. Payload lanes are vec4-packed. */
  readonly eventQueues: readonly CompiledEventQueueDescription[];
  readonly moduleSlots: readonly {
    readonly label?: string;
    readonly path: string;
    readonly slot: number;
    readonly stage: CompiledKernelStage;
    readonly stageIndex: number;
    readonly type: string;
  }[];
  readonly storageBuffers: readonly {
    readonly attributes?: readonly {
      readonly components: number;
      readonly group: number;
      readonly logicalType: AttributeType;
      readonly name: string;
      readonly offset: number;
    }[];
    readonly count: 1;
    readonly groupCount?: number;
    readonly name: string;
    readonly packed?: boolean;
    readonly purposes: readonly string[];
    readonly storageType?: TslStorageType;
  }[];
  readonly storageBufferCount: number;
}

export interface CompiledEventPayloadField {
  readonly attribute: string;
  readonly components: number;
  readonly eventPayloadPath: DataReference;
  readonly group: number;
  readonly logicalType: AttributeType;
  readonly offset: number;
}

export interface CompiledEventHandlerDescription {
  readonly inherit: readonly string[];
  readonly path: string;
  readonly target: string;
}

export interface CompiledEventQueueDescription {
  readonly capacity: number;
  readonly eventName: string;
  readonly handlers: readonly CompiledEventHandlerDescription[];
  readonly payloadFields: readonly CompiledEventPayloadField[];
  readonly payloadGroupCount: number;
  readonly stateWordCount: 4;
}

export type EventPayloadValues = Readonly<Record<string, number | readonly number[]>>;

function eventPayloadFloatOffset(
  queue: CompiledEventQueueDescription,
  bank: 0 | 1,
  slot: number,
  group: number,
  lane = 0,
): number {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= queue.capacity) {
    throw new RangeError(`Event payload slot ${slot} is outside capacity ${queue.capacity}.`);
  }
  if (!Number.isSafeInteger(group) || group < 0 || group >= queue.payloadGroupCount) {
    throw new RangeError(
      `Event payload group ${group} is outside group count ${queue.payloadGroupCount}.`,
    );
  }
  return (
    (bank * queue.capacity * queue.payloadGroupCount + slot * queue.payloadGroupCount + group) * 4 +
    lane
  );
}

/** CPU mirror of the GPU vec4 record store, used by tooling and payload layout tests. */
export function writeEventPayloadRecord(
  storage: Float32Array,
  queue: CompiledEventQueueDescription,
  bank: 0 | 1,
  slot: number,
  values: EventPayloadValues,
): void {
  const requiredLength = queue.capacity * queue.payloadGroupCount * 2 * 4;
  if (storage.length < requiredLength) {
    throw new RangeError(`Event payload storage needs ${requiredLength} floats.`);
  }
  for (let group = 0; group < queue.payloadGroupCount; group += 1) {
    storage.fill(
      0,
      eventPayloadFloatOffset(queue, bank, slot, group),
      eventPayloadFloatOffset(queue, bank, slot, group) + 4,
    );
  }
  for (const field of queue.payloadFields) {
    const input = values[field.attribute];
    const components = typeof input === 'number' ? [input] : input;
    if (!components || components.length !== field.components) {
      throw new RangeError(
        `Event payload field "${field.attribute}" needs ${field.components} component(s).`,
      );
    }
    for (let component = 0; component < field.components; component += 1) {
      storage[eventPayloadFloatOffset(queue, bank, slot, field.group, field.offset + component)] =
        components[component] ?? 0;
    }
  }
}

/** CPU mirror of the consumer's vec4 lane unpacking. */
export function readEventPayloadRecord(
  storage: Float32Array,
  queue: CompiledEventQueueDescription,
  bank: 0 | 1,
  slot: number,
): Record<string, number | readonly number[]> {
  const values: Record<string, number | readonly number[]> = {};
  for (const field of queue.payloadFields) {
    const components = Array.from(
      { length: field.components },
      (_, component) =>
        storage[
          eventPayloadFloatOffset(queue, bank, slot, field.group, field.offset + component)
        ] ?? 0,
    );
    values[field.attribute] = field.components === 1 ? components[0]! : components;
  }
  return values;
}

export interface LifecycleStorageFieldMeta {
  readonly offsetWords: number;
  readonly wordCount: number;
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
  equal(value: KernelNodeInput): KernelNode;
  greaterThanEqual(value: KernelNodeInput): KernelNode;
  lessThanEqual(value: KernelNodeInput): KernelNode;
  lessThan(value: KernelNodeInput): KernelNode;
  and(value: KernelNodeInput): KernelNode;
  not(): KernelNode;
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
  toAtomic(): KernelStorageNode;
}

export interface KernelIndirectStorageNode extends KernelStorageNode {
  /** Backend resource passed to dispatchIndirect/drawIndirect integration. */
  readonly indirectResource: unknown;
}

export interface KernelUniformNode extends KernelNode {
  value: unknown;
}

export interface KernelComputeNode {
  setName(name: string): KernelComputeNode;
}

export interface KernelComputeBuilder {
  compute(count: number, workgroupSize: readonly [number]): KernelComputeNode;
  computeKernel(workgroupSize: readonly [number]): KernelComputeNode;
}

export interface KernelAdapterCapabilities {
  readonly atomics: boolean;
  readonly backend: 'webgl2' | 'webgpu';
  readonly indirectDispatch: boolean;
  readonly indirectDraw: boolean;
  readonly sceneDepth?: boolean;
  /** Sample count of the bound scene-depth source. Values greater than one are unsupported. */
  readonly sceneDepthSampleCount?: number;
}

export interface KernelTslAdapter {
  readonly capabilities: KernelAdapterCapabilities;
  readonly deviceLimits?: {
    readonly maxStorageBuffersPerShaderStage?: number;
    readonly maxTransformFeedbackSeparateAttribs?: number;
  };
  readonly instanceIndex: KernelNode;
  atomicAdd(target: KernelNode, value: KernelNodeInput, returnValue?: boolean): KernelNode;
  atomicLoad(target: KernelNode): KernelNode;
  atomicStore(target: KernelNode, value: KernelNodeInput): void;
  atan2(y: KernelNodeInput, x: KernelNodeInput): KernelNode;
  branch(condition: KernelNode, whenTrue: () => void, whenFalse?: () => void): void;
  constant(value: unknown, type: AttributeType): KernelNode;
  cos(value: KernelNodeInput): KernelNode;
  dataTexture(lut: BakedLut): unknown;
  fn(callback: () => void): KernelComputeBuilder;
  instancedArray(length: number, type: TslStorageType): KernelStorageNode;
  indirectArray(values: Uint32Array): KernelIndirectStorageNode;
  inverse(value: KernelNode): KernelNode;
  sampleTexture(texture: unknown, uv: KernelNode): KernelNode;
  sampleSceneDepth?(uv: KernelNode): KernelNode;
  sampleMeshSurface(
    mesh: MeshRef,
    triangleSample: KernelNode,
    barycentricA: KernelNode,
    barycentricB: KernelNode,
  ): { readonly normal: KernelNode; readonly position: KernelNode };
  sampleSdf(
    field: SdfRef,
    position: KernelNode,
  ): { readonly distance: KernelNode; readonly gradient: KernelNode };
  sampleVectorField(field: FieldRef, position: KernelNode, tiling: boolean): KernelNode;
  select(condition: KernelNode, whenTrue: KernelNodeInput, whenFalse: KernelNodeInput): KernelNode;
  simplexNoise(position: KernelNode): KernelNode;
  sin(value: KernelNodeInput): KernelNode;
  uniform(value: unknown, type: TslStorageType): KernelUniformNode;
  uint(value: KernelNodeInput): KernelNode;
  vec2(x: KernelNodeInput, y: KernelNodeInput): KernelNode;
  vec3(x: KernelNodeInput, y: KernelNodeInput, z: KernelNodeInput): KernelNode;
  vec4(x: KernelNodeInput, y: KernelNodeInput, z: KernelNodeInput, w: KernelNodeInput): KernelNode;
}

export interface BuiltEmitterKernels {
  readonly aliveCount: KernelStorageNode;
  readonly aliveIndices: KernelStorageNode;
  readonly aliveIndicesOffset: number;
  readonly capabilityPath: 'webgl2-cpu-readback' | 'webgpu-atomic-indirect';
  readonly compact?: KernelComputeNode;
  readonly counterOffsets: {
    readonly aliveCount: number;
    readonly freeCount: number;
    readonly spawnOverflow: number;
    readonly spawnSuccess: number;
  };
  /**
   * Core updates words 1-4 relative to `drawIndirectOffsetBytes`. Before first draw, the M3
   * renderer must prime relative word 0 (`indexCount`) once and bind this resource at that offset.
   */
  readonly drawIndirect?: KernelIndirectStorageNode;
  readonly drawIndirectOffsetBytes?: number;
  readonly eventInputs: readonly BuiltEventInputKernels[];
  readonly eventOutputs: Readonly<Record<string, BuiltEventOutputKernels>>;
  readonly finalizeIndirect?: KernelComputeNode;
  readonly finalizeSpawn?: KernelComputeNode;
  readonly freeCount?: KernelStorageNode;
  readonly freeListOffset: number;
  /** M1 all-slots compatibility kernel; never submit with the M2 lifecycle kernels. */
  readonly init: KernelComputeNode;
  /** Starts the M2 lifecycle path; mixing it with `init` leaves allocator counters inconsistent. */
  readonly initialize: KernelComputeNode;
  readonly luts: Readonly<Record<string, unknown>>;
  readonly prepareSpawn?: KernelComputeNode;
  readonly resetAliveCount?: KernelComputeNode;
  readonly spawn: KernelComputeNode;
  readonly spawnDispatch?: KernelIndirectStorageNode;
  readonly spawnOverflow: KernelStorageNode;
  readonly storages: Readonly<Record<string, KernelStorageNode>>;
  readonly uniforms: Readonly<Record<string, KernelUniformNode>>;
  readonly update: KernelComputeNode;
}

export interface EventQueueResources {
  readonly indirect: KernelIndirectStorageNode;
  readonly payload: KernelStorageNode;
  readonly state: KernelStorageNode;
}

export interface BuiltEventOutputKernels extends EventQueueResources {
  readonly queue: CompiledEventQueueDescription;
  readonly reset: KernelComputeNode;
}

export interface EventInputBinding {
  readonly handler: CompiledEventHandlerDescription;
  readonly queue: CompiledEventQueueDescription;
  readonly resources: EventQueueResources;
  readonly sourceKey: string;
}

export interface BuildEmitterKernelOptions {
  readonly eventInputs?: readonly EventInputBinding[];
  readonly eventOutputs?: Readonly<Record<string, EventQueueResources>>;
}

export interface BuiltEventInputKernels {
  readonly binding: EventInputBinding;
  readonly finalize: KernelComputeNode;
  readonly prepare: KernelComputeNode;
  readonly spawn: KernelComputeNode;
}

export interface KernelModuleBuildContext {
  readonly adapter: KernelTslAdapter;
  readonly module: CompiledKernelModule;
  /** Read-only logical attribute expression. Use write() to update particle storage. */
  attribute(name: string): KernelNode;
  /** Compiler-owned append path used by built-in event producers. */
  emitEvent(eventName: 'onCollision'): void;
  random(sampleOffset?: number): KernelNode;
  sampleLut(id: string, coordinate: KernelNode): KernelNode;
  uniform(path: ParameterPath): KernelUniformNode;
  value(input: unknown, type: AttributeType, sampleOffset?: number): KernelNode;
  write(name: string, value: KernelNodeInput): void;
}

function readOnlyAttributeNode(node: KernelNode, name: string): KernelNode {
  const mutations = new Set<PropertyKey>(['addAssign', 'assign', 'mulAssign']);
  const components = new Set<PropertyKey>(['a', 'b', 'g', 'r', 'rgb', 'w', 'x', 'xyz', 'y', 'z']);
  const cache = new WeakMap<object, KernelNode>();
  const wrap = (value: KernelNode): KernelNode => {
    const target = value as unknown as object;
    const cached = cache.get(target);
    if (cached) return cached;
    const proxy = new Proxy(target, {
      get(current, property, receiver) {
        if (mutations.has(property)) {
          return () => {
            throw new Error(
              `Attribute "${name}" is read-only in KernelModuleBuildContext; use context.write().`,
            );
          };
        }
        const result = Reflect.get(current, property, receiver) as unknown;
        if (
          components.has(property) &&
          (typeof result === 'object' || typeof result === 'function') &&
          result !== null
        ) {
          return wrap(result as KernelNode);
        }
        return result;
      },
    }) as unknown as KernelNode;
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(node);
}

export interface KernelModuleImplementation {
  readonly access: ModuleAccess;
  readonly build: (context: KernelModuleBuildContext) => void;
  readonly stage: CompiledKernelStage;
  readonly type: string;
  readonly version: number;
}

export interface SpawnModuleImplementation {
  readonly access: ModuleAccess;
  readonly stage: 'spawn';
  readonly type: string;
  readonly version: number;
}

export type CompilerModuleImplementation = KernelModuleImplementation | SpawnModuleImplementation;

export class KernelModuleRegistry {
  readonly #implementations = new Map<string, CompilerModuleImplementation>();

  register(implementation: CompilerModuleImplementation): void {
    const key = registryKey(implementation.type, implementation.version);
    const registered = this.#implementations.get(key);
    if (registered !== undefined && registered !== implementation) {
      throw new Error(`Kernel module implementation ${key} is already registered.`);
    }
    this.#implementations.set(key, implementation);
  }

  resolve(type: string, version: number): CompilerModuleImplementation | undefined {
    return this.#implementations.get(registryKey(type, version));
  }
}

export interface CompileEmitterOptions {
  readonly deltaTime?: number;
  readonly emitterSeed?: number;
  /** Event payload fields inherited by this emitter from effect-scoped emitTo() links. */
  readonly eventPayloadFields?: readonly string[];
  readonly registry?: KernelModuleRegistry;
  readonly resolveTsl?: (reference: TslFunctionRef) => TslModuleFactory | undefined;
  readonly spawnGeneration?: number;
  readonly workgroupSize?: number;
}

export interface CompiledEmitterProgram {
  readonly attributeSchema: ResolvedAttributeSchema;
  readonly buildKernels: (
    adapter: KernelTslAdapter,
    options?: BuildEmitterKernelOptions,
  ) => BuiltEmitterKernels;
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly draws: readonly CompiledDrawDescription[];
  readonly events: readonly CompiledEventQueueDescription[];
  readonly kernels: {
    readonly init: CompiledKernelDescription;
    readonly update: CompiledKernelDescription;
  };
  readonly luts: readonly BakedLut[];
  readonly meta: CompiledEmitterMeta;
  readonly spawn: CompiledSpawnDescription;
  readonly uniforms: readonly CompiledUniformDescription[];
}

export type CompiledDrawDescription = CompiledMeshDrawDescription | CompiledSpriteDrawDescription;

export interface CompiledDrawIndirectDescription {
  readonly aliveIndicesOffsetWords: number;
  readonly drawArgumentsOffsetBytes: number;
  readonly instanceCount: 'alive-count';
  readonly physicalIndex: 'alive-indices';
}

export interface CompiledDrawVertexDescription {
  readonly attributes: readonly string[];
  readonly storageBufferCount: number;
  readonly storageBuffers: readonly string[];
}

export interface CompiledSpriteDrawDescription {
  readonly fragment: {
    readonly blending: BlendingMode;
    readonly flipbook?: {
      readonly cols: number;
      readonly interpolate: boolean;
      readonly motionVectors?: TextureRef;
      readonly progressAttribute: 'normalizedAge';
      readonly rowOrder: 'top-left';
      readonly rows: number;
    };
    readonly map?: TextureRef;
    readonly soft?: { readonly fadeDistance: number };
  };
  readonly geometry: {
    readonly indexCount: number;
    readonly shape: 'cutout' | 'quad';
    readonly topology: 'triangle-list';
    readonly vertexCount: 4 | 5 | 6 | 7 | 8;
  };
  readonly indirect: CompiledDrawIndirectDescription;
  readonly kind: 'billboard';
  readonly path: string;
  readonly vertex: CompiledDrawVertexDescription & {
    readonly alignment: NonNullable<BillboardOptions['alignment']>;
  };
}

export interface CompiledMeshDrawDescription {
  readonly fragment: { readonly blending: BlendingMode };
  readonly geometry: { readonly resource: GeometryRef; readonly topology: 'triangle-list' };
  readonly indirect: CompiledDrawIndirectDescription;
  readonly kind: 'mesh';
  readonly path: string;
  readonly vertex: CompiledDrawVertexDescription & {
    readonly alignment: NonNullable<MeshRendererOptions['alignment']>;
  };
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

const SYSTEM_PATHS = new Set<ParameterPath>([
  'System.deltaTime',
  'System.projectionMatrix',
  'System.time',
  'System.viewMatrix',
  'System.viewportSize',
]);
const EMITTER_PATHS = new Set<ParameterPath>([
  'Emitter.age',
  'Emitter.deltaTime',
  'Emitter.eventReadBank',
  'Emitter.eventWriteBank',
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
  'System.projectionMatrix',
  'System.time',
  'System.viewMatrix',
  'System.viewportSize',
  'Emitter.age',
  'Emitter.deltaTime',
  'Emitter.eventReadBank',
  'Emitter.eventWriteBank',
  'Emitter.localTime',
  'Emitter.loopIndex',
  'Emitter.seed',
  'Emitter.spawnGeneration',
  'Emitter.transform',
]);

type WriteOwnershipModule = {
  readonly source?: 'author' | 'compiler';
  readonly stage: CompiledModuleStage | 'event' | 'render';
  readonly type: string;
};

const COMPILER_OWNED_WRITE_PATHS = [
  {
    allows: (module: WriteOwnershipModule) => module.source === 'compiler',
    matches: (path: DataReference) => path === 'Particles.spawnGeneration',
    owner: 'particle allocator',
    path: 'Particles.spawnGeneration',
  },
  {
    allows: (module: WriteOwnershipModule) =>
      module.source === 'compiler' ||
      (module.stage === 'spawn' &&
        ['core/burst', 'core/rate', 'core/per-distance'].includes(module.type)),
    matches: (path: DataReference) => path === 'Emitter.spawnCount',
    owner: 'spawn allocator',
    path: 'Emitter.spawnCount',
  },
  {
    allows: (module: WriteOwnershipModule) => module.source === 'compiler',
    matches: (path: DataReference) => path.startsWith('Emitter.allocation.'),
    owner: 'spawn allocator',
    path: 'Emitter.allocation.*',
  },
  {
    allows: (module: WriteOwnershipModule) => module.source === 'compiler',
    matches: (path: DataReference) =>
      path === 'Emitter.eventReadBank' || path === 'Emitter.eventWriteBank',
    owner: 'event scheduler',
    path: 'Emitter.event*Bank',
  },
  {
    allows: (module: WriteOwnershipModule) => module.source === 'compiler',
    matches: (path: DataReference) => path.startsWith('Emitter.eventPayload.'),
    owner: 'event payload binding',
    path: 'Emitter.eventPayload.*',
  },
  {
    allows: (module: WriteOwnershipModule) => module.stage === 'event',
    matches: (path: DataReference) => path.startsWith('Emitter.events.'),
    owner: 'event stage',
    path: 'Emitter.events.*',
  },
] as const;

function isKnownEmitterPath(
  reference: ParameterPath,
  eventPayloadFields: ReadonlySet<string>,
): boolean {
  return (
    EMITTER_PATHS.has(reference) ||
    /^Emitter\.allocation\..+/.test(reference) ||
    /^Emitter\.events\..+/.test(reference) ||
    (reference.startsWith('Emitter.eventPayload.') &&
      eventPayloadFields.has(reference.slice('Emitter.eventPayload.'.length)))
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

function validateRenderModuleLimit(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
): VfxDiagnostic[] {
  const renderModules = collectEmitterModules(definition).filter(
    ({ module }) => module.stage === 'render',
  );
  if (renderModules.length <= 1) return [];
  return [
    diagnostic(
      'NACHI_RENDER_MODULE_LIMIT',
      `M3 supports one render module per emitter; received ${renderModules.length}. Per-draw indirect argument slots are planned for M7.`,
      renderModules[1]!.path,
    ),
  ];
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

function withAccess<Stage extends ModuleDefinition['stage']>(
  module: ModuleDefinition<Stage, object>,
  access: ModuleAccess,
): ModuleDefinition<Stage, object> {
  return { ...module, access };
}

function deriveConfigReads(config: object, stage: ModuleDefinition['stage']): DataReference[] {
  const reads = new Set<DataReference>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    visited.add(value);
    const kind = 'kind' in value ? value.kind : undefined;
    if (kind === 'range') {
      reads.add('Emitter.seed');
      reads.add(stage === 'spawn' ? 'Emitter.spawnGeneration' : 'Particles.spawnGeneration');
    } else if (kind === 'parameter' && 'path' in value && typeof value.path === 'string') {
      reads.add(value.path as DataReference);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(config);
  return [...reads];
}

function withDerivedConfigReads<Stage extends ModuleDefinition['stage']>(
  module: ModuleDefinition<Stage, object>,
): ModuleDefinition<Stage, object> {
  const derivedReads = deriveConfigReads(module.config, module.stage);
  if (derivedReads.length === 0) return module;
  const access = module.access ?? { reads: [], writes: [] };
  return withAccess(module, {
    ...access,
    reads: [...new Set([...access.reads, ...derivedReads])],
  });
}

function defaultsModule(schema: ResolvedAttributeSchema): InitModule {
  const config = {
    attributes: schema.attributes
      .filter(({ name }) => name !== 'alive' && name !== 'spawnGeneration')
      .map(({ default: defaultValue, logicalType, name, storageIndex }) => ({
        default: defaultValue,
        logicalType,
        name,
        storageIndex,
      })),
  };
  return {
    access: {
      reads: deriveConfigReads(config, 'init'),
      writes: config.attributes.map(({ name }) => `Particles.${name}` as const),
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
      if (
        module.access?.writes.includes('Particles.position') &&
        ![
          'core/collide-box',
          'core/collide-plane',
          'core/collide-scene-depth',
          'core/collide-sdf',
          'core/collide-sphere',
        ].includes(module.type)
      ) {
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

function spawnModuleDescriptor(
  module: SpawnModule,
  path: string,
  stageIndex: number,
): CompiledSpawnModule {
  const base = {
    access: module.access ?? { reads: [], writes: [] },
    config: module.config,
    path,
    slot: resolveModuleSlot(module, stageIndex),
    stage: 'spawn',
    stageIndex,
    type: module.type,
    version: module.version,
  } as const;
  return module.label === undefined ? base : { ...base, label: module.label };
}

function validateModule(
  module: CompiledKernelModule | CompiledSpawnModule,
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
  modules: readonly {
    readonly access: ModuleAccess;
    readonly path: string;
  }[],
  parameters: ParameterSchema | undefined,
  eventPayloadFields: readonly string[],
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const declaredParameters = new Set(Object.keys(parameters ?? {}));
  const declaredEventPayloadFields = new Set(eventPayloadFields);
  for (const module of modules) {
    for (const [kind, references] of [
      ['reads', module.access.reads],
      ['writes', module.access.writes],
    ] as const) {
      for (const [index, reference] of references.entries()) {
        if (reference.startsWith('Particles.')) continue;
        const known =
          SYSTEM_PATHS.has(reference) ||
          isKnownEmitterPath(reference, declaredEventPayloadFields) ||
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
    for (const [index, reference] of (module.access.optionalReads ?? []).entries()) {
      if (
        reference.startsWith('Emitter.eventPayload.') &&
        !isKnownEmitterPath(reference, declaredEventPayloadFields)
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_PARAMETER_UNKNOWN_REFERENCE',
            `Module optionally reads unknown parameter path "${reference}".`,
            `${module.path}.access.optionalReads[${index}]`,
          ),
        );
      }
    }
    // Other optionalReads deliberately do not diagnose absence; materializers provide fallbacks.
  }
  return diagnostics;
}

function validateStageWrites(
  modules: readonly {
    readonly access: ModuleAccess;
    readonly path: string;
    readonly source?: 'author' | 'compiler';
    readonly stage: CompiledModuleStage | 'event' | 'render';
    readonly type: string;
  }[],
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  for (const module of modules) {
    for (const [index, reference] of module.access.writes.entries()) {
      const ownership = COMPILER_OWNED_WRITE_PATHS.find(({ matches }) => matches(reference));
      if (ownership && !ownership.allows(module)) {
        diagnostics.push(
          diagnostic(
            'NACHI_COMPILER_OWNED_WRITE',
            `Only the ${ownership.owner} may write "${reference}" (protected path ${ownership.path}).`,
            `${module.path}.access.writes[${index}]`,
          ),
        );
        continue;
      }
      const allowed =
        module.stage === 'spawn'
          ? reference === 'Emitter.spawnCount' || reference.startsWith('Emitter.allocation.')
          : module.stage === 'init'
            ? reference.startsWith('Particles.')
            : module.stage === 'update'
              ? reference.startsWith('Particles.') || reference.startsWith('Emitter.')
              : module.stage === 'event'
                ? reference.startsWith('Particles.') || reference.startsWith('Emitter.events.')
                : false;
      if (!allowed) {
        diagnostics.push(
          diagnostic(
            'NACHI_STAGE_WRITE_FORBIDDEN',
            `${module.stage} modules may not write "${reference}".`,
            `${module.path}.access.writes[${index}]`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function validateSpawnConfigs(
  modules: readonly CompiledSpawnModule[],
  parameters: ParameterSchema | undefined,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  for (const module of modules) {
    if (module.type === 'core/rate' || module.type === 'core/per-distance') {
      const value = (module.config as { rate?: unknown }).rate;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        diagnostics.push(
          diagnostic(
            'NACHI_SPAWN_RATE_INVALID',
            `${module.type} rate must be a non-negative finite number.`,
            `${module.path}.config.rate`,
          ),
        );
      }
    }
    if (module.type === 'core/burst') {
      const config = module.config as { count?: unknown; cycles?: unknown; interval?: unknown };
      const invalidCount = (value: unknown): boolean =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0;
      let countInvalid = false;
      if (typeof config.count === 'object' && config.count !== null && 'kind' in config.count) {
        if (config.count.kind === 'range') {
          const range = config.count as { max?: unknown; min?: unknown };
          countInvalid =
            invalidCount(range.min) ||
            invalidCount(range.max) ||
            (range.min as number) > (range.max as number);
        } else if (config.count.kind === 'parameter') {
          const generator = config.count as { fallback?: unknown; path?: unknown };
          const parameterDefinition =
            typeof generator.path === 'string'
              ? parameters?.[generator.path as ParameterPath]
              : undefined;
          countInvalid =
            (generator.fallback !== undefined && invalidCount(generator.fallback)) ||
            parameterDefinition === undefined ||
            !(['f32', 'i32', 'u32'] as const).includes(
              parameterDefinition.type as 'f32' | 'i32' | 'u32',
            );
        }
      } else {
        countInvalid = invalidCount(config.count);
      }
      if (countInvalid) {
        diagnostics.push(
          diagnostic(
            'NACHI_BURST_COUNT_INVALID',
            'Burst count must be a non-negative finite number or a valid range/parameter generator.',
            `${module.path}.config.count`,
          ),
        );
      }
      if (
        config.cycles !== undefined &&
        (!Number.isSafeInteger(config.cycles) || (config.cycles as number) <= 0)
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_BURST_CYCLES_INVALID',
            'Burst cycles must be a positive safe integer.',
            `${module.path}.config.cycles`,
          ),
        );
      }
      if (
        config.interval !== undefined &&
        (typeof config.interval !== 'number' ||
          !Number.isFinite(config.interval) ||
          config.interval <= 0)
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_BURST_INTERVAL_INVALID',
            'Burst interval must be a positive finite number.',
            `${module.path}.config.interval`,
          ),
        );
      }
      if (
        (config.cycles as number | undefined) !== undefined &&
        config.cycles !== 1 &&
        config.interval === undefined
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_BURST_INTERVAL_REQUIRED',
            'Burst interval is required when cycles is greater than one.',
            `${module.path}.config.interval`,
          ),
        );
      }
    }
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
    describe('System.projectionMatrix', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'mat4'),
    describe('System.viewMatrix', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'mat4'),
    describe('System.viewportSize', [1, 1], 'vec2'),
    describe('Emitter.age', 0, 'f32'),
    describe('Emitter.deltaTime', options.deltaTime ?? 1 / 60, 'f32'),
    describe('Emitter.eventReadBank', 1, 'u32'),
    describe('Emitter.eventWriteBank', 0, 'u32'),
    describe('Emitter.localTime', 0, 'f32'),
    describe('Emitter.loopIndex', 0, 'u32'),
    describe('Emitter.seed', options.emitterSeed ?? 0, 'u32'),
    describe('Emitter.spawnCount', 0, 'u32'),
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
      if (
        module.type === 'core/size-over-life' ||
        module.type === 'core/rotation-over-life' ||
        module.type === 'core/velocity-over-life'
      ) {
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

function lifecycleStorageLayout(capacity: number) {
  const indirectFields = {
    spawnDispatch: { offsetWords: 0, wordCount: 3 },
    drawIndirect: { offsetWords: 3, wordCount: 5 },
  } as const;
  const indirectWordCount =
    indirectFields.drawIndirect.offsetWords + indirectFields.drawIndirect.wordCount;
  const stateFields = {
    freeCount: { offsetWords: 0, wordCount: 1 },
    aliveCount: { offsetWords: 1, wordCount: 1 },
    spawnSuccess: { offsetWords: 2, wordCount: 1 },
    spawnOverflow: { offsetWords: 3, wordCount: 1 },
    freeList: { offsetWords: 4, wordCount: capacity },
    aliveIndices: { offsetWords: 4 + capacity, wordCount: capacity },
  } as const;
  const stateWordCount = stateFields.aliveIndices.offsetWords + stateFields.aliveIndices.wordCount;
  return {
    buffers: {
      indirectArguments: { fields: indirectFields, wordCount: indirectWordCount },
      state: { fields: stateFields, wordCount: stateWordCount },
    },
    wordCount: indirectWordCount + stateWordCount,
  } as const;
}

function compileEventQueues(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  diagnostics: VfxDiagnostic[],
): CompiledEventQueueDescription[] {
  const queues: CompiledEventQueueDescription[] = [];
  for (const [eventName, value] of Object.entries(definition.events ?? {})) {
    const handlers = (Array.isArray(value) ? value : [value]).filter(
      (module): module is NonNullable<typeof module> => module !== undefined,
    );
    if (eventName === 'onCustom') {
      diagnostics.push(
        diagnostic(
          'NACHI_EVENT_ON_CUSTOM_UNIMPLEMENTED',
          'onCustom requires a tslModule emitEvent(condition) producer; the v1 context is reserved but not materialized yet.',
          `events.${eventName}`,
        ),
      );
      continue;
    }
    if (eventName !== 'onCollision' && eventName !== 'onDeath') {
      diagnostics.push(
        diagnostic(
          'NACHI_EVENT_KIND_UNIMPLEMENTED',
          `Event "${eventName}" is not implemented by the M5 GPU producer.`,
          `events.${eventName}`,
        ),
      );
      continue;
    }

    const compiledHandlers: CompiledEventHandlerDescription[] = [];
    const inherited = new Set<string>();
    for (const [index, module] of handlers.entries()) {
      const path = `events.${eventName}[${index}]`;
      if (module.type !== 'core/emit-to') {
        // Registry-backed Event modules remain valid metadata. M5 only materializes emitTo;
        // their execution contract is owned by the registering package.
        continue;
      }
      const config = module.config as { inherit?: unknown; target?: unknown };
      if (typeof config.target !== 'string' || config.target.length === 0) {
        diagnostics.push(
          diagnostic(
            'NACHI_EVENT_TARGET_INVALID',
            'emitTo() target must be a non-empty effect element name.',
            `${path}.config.target`,
          ),
        );
        continue;
      }
      const rawInherit = config.inherit;
      const inherit = Array.isArray(rawInherit)
        ? rawInherit.filter((name): name is string => typeof name === 'string')
        : [];
      if (
        rawInherit !== undefined &&
        (!Array.isArray(rawInherit) || inherit.length !== rawInherit.length)
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_EVENT_INHERIT_INVALID',
            'emitTo() inherit entries must be particle attribute names.',
            `${path}.config.inherit`,
          ),
        );
      }
      for (const [inheritIndex, name] of inherit.entries()) {
        const attribute = schema.byName[name];
        if (!attribute) {
          diagnostics.push(
            diagnostic(
              'NACHI_EVENT_INHERIT_UNKNOWN',
              `Inherited particle attribute "${name}" is not declared by the producer.`,
              `${path}.config.inherit[${inheritIndex}]`,
            ),
          );
          continue;
        }
        if (
          attribute.components > 4 ||
          !['color', 'f32', 'quat', 'vec2', 'vec3', 'vec4'].includes(attribute.logicalType)
        ) {
          diagnostics.push(
            diagnostic(
              'NACHI_EVENT_PAYLOAD_TYPE_UNSUPPORTED',
              `Inherited attribute "${name}" uses ${attribute.logicalType}; M5 vec4 payload fields support float-domain types with up to four components.`,
              `${path}.config.inherit[${inheritIndex}]`,
            ),
          );
          continue;
        }
        inherited.add(name);
      }
      compiledHandlers.push({ inherit, path, target: config.target });
    }

    let lane = 0;
    const payloadFields = [...inherited].map((name) => {
      const attribute = schema.byName[name]!;
      if ((lane % 4) + attribute.components > 4) lane = Math.ceil(lane / 4) * 4;
      const field = {
        attribute: name,
        components: attribute.components,
        eventPayloadPath: `Emitter.eventPayload.${name}` as DataReference,
        group: Math.floor(lane / 4),
        logicalType: attribute.logicalType,
        offset: lane % 4,
      } as const;
      lane += attribute.components;
      return field;
    });
    if (compiledHandlers.length === 0) continue;
    queues.push({
      capacity: definition.capacity,
      eventName,
      handlers: compiledHandlers,
      payloadFields,
      payloadGroupCount: Math.max(1, Math.ceil(lane / 4)),
      stateWordCount: 4,
    });
  }
  return queues;
}

export function allocateEventQueueResources(
  adapter: KernelTslAdapter,
  queue: CompiledEventQueueDescription,
  emitterKey = 'Emitter',
): EventQueueResources {
  if (adapter.capabilities.backend !== 'webgpu') {
    throw new VfxDiagnosticError([
      diagnostic(
        'NACHI_BACKEND_EVENT_UNSUPPORTED',
        'GPU event queues require WebGPU atomics and indirect dispatch.',
        `events.${queue.eventName}`,
      ),
    ]);
  }
  const state = adapter
    .instancedArray(queue.stateWordCount, 'uint')
    .toAtomic()
    .setName(`NachiEventState_${emitterKey}_${queue.eventName}`);
  const payload = adapter
    .instancedArray(queue.capacity * queue.payloadGroupCount * 2, 'vec4')
    .setName(`NachiEventPayload_${emitterKey}_${queue.eventName}`);
  const indirect = adapter
    .indirectArray(new Uint32Array(3))
    .setName(`NachiEventIndirect_${emitterKey}_${queue.eventName}`) as KernelIndirectStorageNode;
  return { indirect, payload, state };
}

function compileSpriteDraws(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  lifecycleLayout: ReturnType<typeof lifecycleStorageLayout>,
  diagnostics: VfxDiagnostic[],
): CompiledSpriteDrawDescription[] {
  const renderModules = collectEmitterModules(definition).filter(
    ({ module }) => module.stage === 'render',
  );
  const draws: CompiledSpriteDrawDescription[] = [];
  for (const { module, path } of renderModules) {
    if (module.type !== 'core/billboard') continue;
    const options = module.config as BillboardOptions;
    const alignment = options.alignment ?? { mode: 'camera-facing' as const };
    if (alignment.mode === 'custom-axis') {
      if (
        alignment.axis.length !== 3 ||
        alignment.axis.some((component) => !Number.isFinite(component)) ||
        alignment.axis.every((component) => component === 0)
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_BILLBOARD_AXIS_INVALID',
            'Billboard custom alignment axis must be a finite, non-zero vec3.',
            `${path}.config.alignment.axis`,
          ),
        );
      }
    }
    if (
      alignment.mode === 'velocity-stretch' &&
      alignment.factor !== undefined &&
      (!Number.isFinite(alignment.factor) || alignment.factor < 0)
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_BILLBOARD_STRETCH_INVALID',
          'Billboard velocity stretch factor must be a non-negative finite number.',
          `${path}.config.alignment.factor`,
        ),
      );
    }
    const cutoutVertices = options.cutout?.vertices ?? 4;
    if (!Number.isInteger(cutoutVertices) || cutoutVertices < 4 || cutoutVertices > 8) {
      diagnostics.push(
        diagnostic(
          'NACHI_BILLBOARD_CUTOUT_VERTICES_INVALID',
          'Billboard cutout vertices must be an integer from 4 through 8.',
          `${path}.config.cutout.vertices`,
        ),
      );
    }
    const flipbook = options.map?.kind === 'flipbook' ? options.map : undefined;
    if (
      flipbook &&
      (!Number.isSafeInteger(flipbook.cols) ||
        flipbook.cols <= 0 ||
        !Number.isSafeInteger(flipbook.rows) ||
        flipbook.rows <= 0)
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_FLIPBOOK_GRID_INVALID',
          'Flipbook cols and rows must be positive safe integers.',
          `${path}.config.map`,
        ),
      );
    }
    if (flipbook?.motionVectors === true && flipbook.interpolate !== false) {
      diagnostics.push(
        diagnostic(
          'NACHI_FLIPBOOK_MOTION_VECTOR_FALLBACK',
          'Flipbook motion-vector blending was requested without a motion-vector TextureRef; using plain frame interpolation.',
          `${path}.config.map.motionVectors`,
          'warning',
        ),
      );
    }
    if (flipbook?.motionVectors && flipbook.interpolate === false) {
      diagnostics.push(
        diagnostic(
          'NACHI_FLIPBOOK_MOTION_VECTORS_IGNORED',
          'Flipbook motion vectors require frame interpolation and are ignored when interpolate is false.',
          `${path}.config.map.motionVectors`,
          'warning',
        ),
      );
    }
    const softFadeDistance =
      options.soft === true
        ? DEFAULT_SOFT_PARTICLE_FADE_DISTANCE
        : typeof options.soft === 'object'
          ? options.soft.fadeDistance
          : undefined;
    if (
      softFadeDistance !== undefined &&
      (!Number.isFinite(softFadeDistance) || softFadeDistance <= 0)
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_BILLBOARD_SOFT_DISTANCE_INVALID',
          'Billboard soft fadeDistance must be a positive finite number.',
          `${path}.config.soft.fadeDistance`,
        ),
      );
    }
    const attributes = [
      'position',
      'size',
      'color',
      'spriteRotation',
      ...(alignment.mode === 'velocity-aligned' || alignment.mode === 'velocity-stretch'
        ? ['velocity']
        : []),
      ...(flipbook ? ['normalizedAge'] : []),
    ];
    if (attributes.some((name) => schema.byName[name] === undefined)) continue;
    const attributeBuffers = [
      ...new Set(
        attributes.map((name) => {
          const attribute = schema.byName[name];
          const storage =
            attribute === undefined
              ? undefined
              : schema.storageArrays[attribute.physical.bufferIndex];
          if (!attribute || !storage) {
            throw new Error(`Billboard attribute "${name}" has no physical storage.`);
          }
          return `Particles.${storage.name}`;
        }),
      ),
    ];
    const vertexStorageBuffers = [...attributeBuffers, 'NachiLifecycleState'];
    if (vertexStorageBuffers.length > 8) {
      diagnostics.push(
        diagnostic(
          'NACHI_STORAGE_BUFFER_LIMIT',
          `Billboard vertex stage requires ${vertexStorageBuffers.length} storage buffers (${vertexStorageBuffers.join(', ')}), exceeding the default limit of 8.`,
          `${path}.vertex.storageBufferCount`,
        ),
      );
    }
    const map = flipbook
      ? flipbook.texture
      : options.map?.kind === 'asset-ref'
        ? options.map
        : undefined;
    const motionVectors =
      flipbook && flipbook.interpolate !== false && typeof flipbook.motionVectors === 'object'
        ? flipbook.motionVectors
        : undefined;
    const geometryVertexCount = cutoutVertices as 4 | 5 | 6 | 7 | 8;
    draws.push({
      fragment: {
        blending: options.blending ?? 'alpha',
        ...(flipbook === undefined
          ? {}
          : {
              flipbook: {
                cols: flipbook.cols,
                interpolate: flipbook.interpolate ?? true,
                ...(motionVectors === undefined ? {} : { motionVectors }),
                progressAttribute: 'normalizedAge' as const,
                rowOrder: 'top-left' as const,
                rows: flipbook.rows,
              },
            }),
        ...(map === undefined ? {} : { map }),
        ...(softFadeDistance === undefined ? {} : { soft: { fadeDistance: softFadeDistance } }),
      },
      geometry: {
        indexCount: (geometryVertexCount - 2) * 3,
        shape: geometryVertexCount === 4 ? 'quad' : 'cutout',
        topology: 'triangle-list',
        vertexCount: geometryVertexCount,
      },
      indirect: {
        aliveIndicesOffsetWords: lifecycleLayout.buffers.state.fields.aliveIndices.offsetWords,
        drawArgumentsOffsetBytes:
          lifecycleLayout.buffers.indirectArguments.fields.drawIndirect.offsetWords *
          Uint32Array.BYTES_PER_ELEMENT,
        instanceCount: 'alive-count',
        physicalIndex: 'alive-indices',
      },
      kind: 'billboard',
      path,
      vertex: {
        alignment,
        attributes,
        storageBufferCount: vertexStorageBuffers.length,
        storageBuffers: vertexStorageBuffers,
      },
    });
  }
  return draws;
}

function compileMeshDraws(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  lifecycleLayout: ReturnType<typeof lifecycleStorageLayout>,
  diagnostics: VfxDiagnostic[],
): CompiledMeshDrawDescription[] {
  const renderModules = collectEmitterModules(definition).filter(
    ({ module }) => module.stage === 'render',
  );
  const draws: CompiledMeshDrawDescription[] = [];
  for (const { module, path } of renderModules) {
    if (module.type !== 'core/mesh-renderer') continue;
    const options = module.config as MeshRendererOptions;
    const alignment = options.alignment ?? { mode: 'none' as const };
    if (
      alignment.mode === 'custom-axis' &&
      (alignment.axis.length !== 3 ||
        alignment.axis.some((component) => !Number.isFinite(component)) ||
        alignment.axis.every((component) => component === 0))
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_MESH_AXIS_INVALID',
          'Mesh renderer custom alignment axis must be a finite, non-zero vec3.',
          `${path}.config.alignment.axis`,
        ),
      );
    }
    if (
      options.geometry.kind !== 'asset-ref' ||
      options.geometry.assetType !== 'geometry' ||
      options.geometry.uri.length === 0
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_MESH_GEOMETRY_INVALID',
          'Mesh renderer geometry must be a non-empty GeometryRef.',
          `${path}.config.geometry`,
        ),
      );
    }
    const attributes = [
      'position',
      'scale',
      'color',
      ...(alignment.mode === 'velocity' ? ['velocity'] : []),
      ...(alignment.mode === 'quaternion' ? ['rotation'] : []),
    ];
    if (attributes.some((name) => schema.byName[name] === undefined)) continue;
    const attributeBuffers = [
      ...new Set(
        attributes.map((name) => {
          const attribute = schema.byName[name];
          const storage =
            attribute === undefined
              ? undefined
              : schema.storageArrays[attribute.physical.bufferIndex];
          if (!attribute || !storage) {
            throw new Error(`Mesh renderer attribute "${name}" has no physical storage.`);
          }
          return `Particles.${storage.name}`;
        }),
      ),
    ];
    const vertexStorageBuffers = [...attributeBuffers, 'NachiLifecycleState'];
    if (vertexStorageBuffers.length > 8) {
      diagnostics.push(
        diagnostic(
          'NACHI_STORAGE_BUFFER_LIMIT',
          `Mesh renderer vertex stage requires ${vertexStorageBuffers.length} storage buffers (${vertexStorageBuffers.join(', ')}), exceeding the default limit of 8.`,
          `${path}.vertex.storageBufferCount`,
        ),
      );
    }
    draws.push({
      fragment: { blending: options.blending ?? 'alpha' },
      geometry: { resource: options.geometry, topology: 'triangle-list' },
      indirect: {
        aliveIndicesOffsetWords: lifecycleLayout.buffers.state.fields.aliveIndices.offsetWords,
        drawArgumentsOffsetBytes:
          lifecycleLayout.buffers.indirectArguments.fields.drawIndirect.offsetWords *
          Uint32Array.BYTES_PER_ELEMENT,
        instanceCount: 'alive-count',
        physicalIndex: 'alive-indices',
      },
      kind: 'mesh',
      path,
      vertex: {
        alignment,
        attributes,
        storageBufferCount: vertexStorageBuffers.length,
        storageBuffers: vertexStorageBuffers,
      },
    });
  }
  return draws;
}

function createBuildKernels(
  program: Omit<CompiledEmitterProgram, 'buildKernels'>,
  registry: KernelModuleRegistry,
  factories: ReadonlyMap<string, TslModuleFactory>,
  lifecycle: EmitterLifecycle | undefined,
): (adapter: KernelTslAdapter, options?: BuildEmitterKernelOptions) => BuiltEmitterKernels {
  return (adapter, options = {}) => {
    const buildDiagnostics = [...program.diagnostics];
    const backend = adapter.capabilities.backend;
    if (backend === 'webgl2') {
      if (program.events.length > 0 || (options.eventInputs?.length ?? 0) > 0) {
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_EVENT_UNSUPPORTED',
          hint: 'Use the WebGPU backend for M5 event append and indirect consumption.',
          message: 'GPU event queues require WebGPU atomics and indirect dispatch.',
          path: 'events',
          phase: 'compile',
          severity: 'error',
        });
      }
      for (const module of program.spawn.modules) {
        if (module.type !== 'core/rate' && module.type !== 'core/per-distance') continue;
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use core/burst on WebGL2 or select the WebGPU backend.',
          message: `${module.type} requires the WebGPU free-list path; WebGL2 supports burst spawning only.`,
          path: module.path,
          phase: 'compile',
          severity: 'error',
        });
      }
      const varyingLimit =
        adapter.deviceLimits?.maxTransformFeedbackSeparateAttribs ??
        program.meta.backendBudgets.webgl2.defaultSpawnVaryingLimit;
      if (program.meta.backendBudgets.webgl2.spawnVaryingCount > varyingLimit) {
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use the WebGPU backend. WebGL2 lifecycle spawning will be revisited with a packed transform-feedback layout.',
          message: `WebGL2 spawn/init requires ${program.meta.backendBudgets.webgl2.spawnVaryingCount} transform-feedback varyings (${program.meta.backendBudgets.webgl2.spawnVaryings.join(', ')}), but the backend limit is ${varyingLimit}.`,
          path: 'meta.backendBudgets.webgl2.spawnVaryingCount',
          phase: 'compile',
          severity: 'error',
        });
      }
      for (const varying of program.meta.backendBudgets.webgl2.spawnVaryings) {
        const attribute = program.attributeSchema.byName[varying.slice('Particles.'.length)];
        if (!attribute || attribute.components <= 4) continue;
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use the WebGPU backend. WebGL2 SEPARATE_ATTRIBS varyings may contain at most four components.',
          message: `WebGL2 spawn/init varying ${varying} has ${attribute.components} components (${attribute.logicalType}), exceeding the per-varying SEPARATE_ATTRIBS limit of 4.`,
          path: `attributeSchema.byName.${attribute.name}.components`,
          phase: 'compile',
          severity: 'error',
        });
      }
      for (const module of program.spawn.modules) {
        if (module.type !== 'core/burst') continue;
        const cycles = (module.config as { cycles?: unknown }).cycles;
        if (typeof cycles === 'number' && cycles > 1) {
          buildDiagnostics.push({
            code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
            hint: 'Use a single-cycle burst on WebGL2 or select the WebGPU backend.',
            message:
              'WebGL2 prefix spawning cannot safely re-fire a burst because later dispatches overwrite the same particle prefix.',
            path: `${module.path}.config.cycles`,
            phase: 'compile',
            severity: 'error',
          });
        }
      }
      const loopCount = lifecycle?.loopCount ?? 1;
      if (
        program.spawn.modules.some(({ type }) => type === 'core/burst') &&
        (loopCount === 'infinite' || loopCount > 1)
      ) {
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use a one-loop burst emitter on WebGL2 or select the WebGPU backend.',
          message:
            'WebGL2 prefix spawning cannot safely re-activate burst emission because each loop overwrites the same particle prefix.',
          path: 'lifecycle.loopCount',
          phase: 'compile',
          severity: 'error',
        });
      }
    } else {
      const capabilities = adapter.capabilities;
      const missing = [
        capabilities.atomics ? undefined : 'atomics',
        capabilities.indirectDispatch ? undefined : 'indirectDispatch',
        capabilities.indirectDraw ? undefined : 'indirectDraw',
      ].filter((value): value is string => value !== undefined);
      if (missing.length > 0) {
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_CAPABILITY_MISSING',
          hint: 'Select a WebGPU adapter exposing atomics, indirect dispatch, and indirect draw.',
          message: `The WebGPU lifecycle path requires missing capability ${missing.join(', ')}; semantic fallback to WebGL2 is disabled.`,
          path: 'meta.capabilities.webgpu',
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    const usesSceneDepth = program.kernels.update.modules.some(
      ({ type }) => type === 'core/collide-scene-depth',
    );
    if (usesSceneDepth) {
      if (backend === 'webgl2') {
        buildDiagnostics.push({
          code: 'NACHI_SCENE_DEPTH_BACKEND_UNSUPPORTED',
          hint: 'Use the WebGPU backend for scene-depth collision.',
          message: 'collideSceneDepth() is not supported by the WebGL2 backend.',
          path: 'update',
          phase: 'compile',
          severity: 'error',
        });
      }
      if ((adapter.capabilities.sceneDepthSampleCount ?? 1) > 1) {
        buildDiagnostics.push({
          code: 'NACHI_SCENE_DEPTH_MSAA_UNSUPPORTED',
          hint: 'Resolve and copy scene depth into a single-sample linear float texture.',
          message: 'collideSceneDepth() cannot sample an MSAA depth texture directly.',
          path: 'update',
          phase: 'compile',
          severity: 'error',
        });
      }
      if (adapter.capabilities.sceneDepth !== true || adapter.sampleSceneDepth === undefined) {
        buildDiagnostics.push({
          code: 'NACHI_SCENE_DEPTH_UNAVAILABLE',
          hint: 'Bind a previous-frame depth copy through the renderer kernel adapter.',
          message:
            'collideSceneDepth() requires an explicit sampleable previous-frame scene-depth texture.',
          path: 'update',
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    const storageBufferLimit = adapter.deviceLimits?.maxStorageBuffersPerShaderStage;
    // Incoming queues are effect-owned and therefore absent from standalone emitter meta. Event
    // spawn reads one source state buffer and one payload buffer in addition to target resources.
    const materializedStorageBufferCount =
      program.meta.storageBufferCount + ((options.eventInputs?.length ?? 0) > 0 ? 2 : 0);
    if (
      storageBufferLimit !== undefined &&
      materializedStorageBufferCount > storageBufferLimit &&
      !buildDiagnostics.some(({ code }) => code === 'NACHI_STORAGE_BUFFER_LIMIT')
    ) {
      buildDiagnostics.push({
        code: 'NACHI_STORAGE_BUFFER_LIMIT',
        hint: 'Request a higher device limit or reduce the resolved attribute schema.',
        message: `Emitter materialization requires ${materializedStorageBufferCount} storage buffers, but the device exposes ${storageBufferLimit} per shader stage.`,
        path: 'meta.storageBufferCount',
        phase: 'compile',
        severity: 'error',
      });
    }
    if (hasErrors(buildDiagnostics)) throw new VfxDiagnosticError(buildDiagnostics);

    const storageByIndex = program.attributeSchema.storageArrays.map((storage) =>
      adapter
        .instancedArray(storage.length, storage.type)
        .setName(`NachiParticles_${storage.name}`),
    );
    const storages: Record<string, KernelStorageNode> = {};
    for (const storage of program.attributeSchema.storageArrays) {
      const node = storageByIndex[storage.index];
      if (!node) throw new Error(`Compiled storage ${storage.index} is missing.`);
      storages[storage.name] = node;
      for (const attribute of storage.attributes) storages[attribute] = node;
    }
    const uniforms = Object.fromEntries(
      program.uniforms.map((description) => [
        description.path,
        adapter.uniform(description.default, description.tslType),
      ]),
    ) as Record<string, KernelUniformNode>;
    const lutTextures = Object.fromEntries(
      program.luts.map((lut) => [lut.id, adapter.dataTexture(lut)]),
    );
    const eventOutputResources = Object.fromEntries(
      program.events.map((queue) => [
        queue.eventName,
        options.eventOutputs?.[queue.eventName] ?? allocateEventQueueResources(adapter, queue),
      ]),
    ) as Readonly<Record<string, EventQueueResources>>;
    const eventInputs = options.eventInputs ?? [];

    const capacity = program.attributeSchema.capacity;
    const gpuLifecycle = backend === 'webgpu';
    const lifecycleLayout = lifecycleStorageLayout(capacity);
    const indirectLayout = lifecycleLayout.buffers.indirectArguments;
    const stateLayout = lifecycleLayout.buffers.state;
    const lifecycleIndirectStorage = gpuLifecycle
      ? adapter
          .indirectArray(new Uint32Array(indirectLayout.wordCount))
          .setName('NachiLifecycleIndirectArguments')
      : undefined;
    const lifecycleBase = adapter.instancedArray(stateLayout.wordCount, 'uint');
    const lifecycleStorage = (gpuLifecycle ? lifecycleBase.toAtomic() : lifecycleBase).setName(
      'NachiLifecycleState',
    );
    const counterOffsets = {
      aliveCount: stateLayout.fields.aliveCount.offsetWords,
      freeCount: stateLayout.fields.freeCount.offsetWords,
      spawnOverflow: stateLayout.fields.spawnOverflow.offsetWords,
      spawnSuccess: stateLayout.fields.spawnSuccess.offsetWords,
    } as const;
    const counter = (offset: number): KernelNode =>
      lifecycleStorage.element(adapter.uint(adapter.constant(offset, 'u32')));
    const lifecycleElement = (offset: number, index?: KernelNode): KernelNode => {
      const base = adapter.uint(adapter.constant(offset, 'u32'));
      return lifecycleStorage.element(index === undefined ? base : base.add(adapter.uint(index)));
    };
    const readLifecycle = (offset: number, index?: KernelNode): KernelNode => {
      const element = lifecycleElement(offset, index);
      return gpuLifecycle ? adapter.atomicLoad(element) : element;
    };
    const writeLifecycle = (offset: number, value: KernelNodeInput, index?: KernelNode): void => {
      const element = lifecycleElement(offset, index);
      if (gpuLifecycle) adapter.atomicStore(element, value);
      else element.assign(value);
    };
    const writeIndirect = (offset: number, value: KernelNodeInput): void => {
      if (!lifecycleIndirectStorage) return;
      lifecycleIndirectStorage.element(adapter.uint(adapter.constant(offset, 'u32'))).assign(value);
    };

    const packedLanes = (name: string, index: KernelNode): readonly KernelNode[] => {
      const attribute = program.attributeSchema.byName[name];
      if (!attribute) throw new Error(`Compiled attribute "${name}" is missing.`);
      const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
      const storageNode = storageByIndex[attribute.physical.bufferIndex];
      if (!storage || !storageNode) {
        throw new Error(`Compiled storage for attribute "${name}" is missing.`);
      }
      const address = resolvePackedAttributeAddress(attribute, storage);
      const physicalIndex = storage.packed
        ? index
            .mul(adapter.uint(adapter.constant(address.particleStride, 'u32')))
            .add(adapter.uint(adapter.constant(address.group, 'u32')))
        : index;
      const element = storageNode.element(physicalIndex);
      return [element.x, element.y, element.z, element.w];
    };
    const attributeNode = (name: string, index = adapter.instanceIndex): KernelNode => {
      const attribute = program.attributeSchema.byName[name];
      if (!attribute) throw new Error(`Compiled attribute "${name}" is missing.`);
      const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
      const storageNode = storageByIndex[attribute.physical.bufferIndex];
      if (!storage || !storageNode) {
        throw new Error(`Compiled storage for attribute "${name}" is missing.`);
      }
      if (!storage.packed) return readOnlyAttributeNode(storageNode.element(index), name);
      const address = resolvePackedAttributeAddress(attribute, storage);
      const lanes = packedLanes(name, index).slice(
        address.offset,
        address.offset + attribute.components,
      );
      if (attribute.components === 1) return readOnlyAttributeNode(lanes[0]!, name);
      if (attribute.components === 2) {
        return readOnlyAttributeNode(adapter.vec2(lanes[0]!, lanes[1]!), name);
      }
      if (attribute.components === 3) {
        return readOnlyAttributeNode(adapter.vec3(lanes[0]!, lanes[1]!, lanes[2]!), name);
      }
      throw new Error(`Packed attribute "${name}" has unsupported width ${attribute.components}.`);
    };
    const writeAttribute = (
      name: string,
      value: KernelNodeInput,
      index = adapter.instanceIndex,
    ): void => {
      const attribute = program.attributeSchema.byName[name];
      if (!attribute) throw new Error(`Compiled attribute "${name}" is missing.`);
      const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
      const storageNode = storageByIndex[attribute.physical.bufferIndex];
      if (!storage || !storageNode) {
        throw new Error(`Compiled storage for attribute "${name}" is missing.`);
      }
      if (!storage.packed) {
        storageNode.element(index).assign(value);
        return;
      }
      const valueNode =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as KernelNode)
          : adapter.constant(value, attribute.logicalType);
      // Packed vector writes are split into scalar lane stores. Materialize the RHS once so a
      // self-referential swizzle/expression cannot observe lanes already written earlier here.
      const stableValue =
        attribute.components === 1
          ? valueNode
          : ((valueNode as KernelNode & { toVar?(): KernelNode }).toVar?.() ?? valueNode);
      const sources = [stableValue.x, stableValue.y, stableValue.z, stableValue.w];
      const address = resolvePackedAttributeAddress(attribute, storage);
      const lanes = packedLanes(name, index).slice(
        address.offset,
        address.offset + attribute.components,
      );
      if (attribute.components === 1) {
        lanes[0]!.assign(stableValue);
        return;
      }
      for (let component = 0; component < attribute.components; component += 1) {
        lanes[component]!.assign(sources[component]!);
      }
    };
    const eventStateElement = (resources: EventQueueResources, offset: KernelNodeInput) =>
      resources.state.element(adapter.uint(offset));
    const payloadElement = (
      resources: EventQueueResources,
      queue: CompiledEventQueueDescription,
      bank: KernelNode,
      slot: KernelNode,
      group: number,
    ) =>
      resources.payload.element(
        bank
          .mul(adapter.uint(queue.capacity * queue.payloadGroupCount))
          .add(slot.mul(adapter.uint(queue.payloadGroupCount)))
          .add(adapter.uint(group)),
      );
    const appendEvent = (
      queue: CompiledEventQueueDescription,
      resources: EventQueueResources,
      particleIndex: KernelNode,
    ): void => {
      const bank = adapter.uint(uniformNode('Emitter.eventWriteBank'));
      const slot = adapter.atomicAdd(eventStateElement(resources, bank), adapter.uint(1), true);
      adapter.atomicAdd(eventStateElement(resources, 3), adapter.uint(1));
      adapter.branch(
        slot.lessThan(adapter.uint(queue.capacity)),
        () => {
          // Store a complete vec4 record so producer and consumer graphs share one unambiguous
          // write and unused lanes cannot retain data from an earlier event.
          for (let group = 0; group < queue.payloadGroupCount; group += 1) {
            const lanes: KernelNodeInput[] = [0, 0, 0, 0];
            for (const field of queue.payloadFields) {
              if (field.group !== group) continue;
              const value = attributeNode(field.attribute, particleIndex);
              const sources = [value.x, value.y, value.z, value.w];
              for (let component = 0; component < field.components; component += 1) {
                lanes[field.offset + component] =
                  field.components === 1 ? value : sources[component]!;
              }
            }
            payloadElement(resources, queue, bank, slot, group).assign(
              adapter.vec4(lanes[0]!, lanes[1]!, lanes[2]!, lanes[3]!),
            );
          }
        },
        () => {
          adapter.atomicAdd(eventStateElement(resources, 2), adapter.uint(1));
        },
      );
    };
    const uniformNode = (path: ParameterPath): KernelUniformNode => {
      const uniform = uniforms[path];
      if (!uniform) throw new Error(`Compiled uniform "${path}" is missing.`);
      return uniform;
    };
    const constant = (value: unknown, type: AttributeType): KernelNode =>
      adapter.constant(value, type);
    const randomNode = (
      module: CompiledKernelModule,
      particleIndex: KernelNode,
      sampleOffset: number,
    ): KernelNode =>
      pcgRandomFloatNode<KernelNode, KernelNode>(
        adapter.uint(particleIndex),
        adapter.uint(uniformNode('Emitter.seed')),
        resolveRandomSampleSlot(module.slot, sampleOffset),
        adapter.uint(attributeNode('spawnGeneration', particleIndex)),
      );

    const buildValue = (
      input: unknown,
      type: AttributeType,
      module: CompiledKernelModule,
      particleIndex: KernelNode,
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
            return minimum.add(
              maximum.sub(minimum).mul(randomNode(module, particleIndex, sampleOffset + index)),
            );
          });
          if (componentCount === 2) return adapter.vec2(components[0]!, components[1]!);
          if (componentCount === 3) {
            return adapter.vec3(components[0]!, components[1]!, components[2]!);
          }
          return adapter.vec4(components[0]!, components[1]!, components[2]!, components[3]!);
        }
        const random = randomNode(module, particleIndex, sampleOffset);
        const minimum = constant(range.min, type);
        const maximum = constant(range.max, type);
        return minimum.add(maximum.sub(minimum).mul(random));
      }
      return constant(input, type);
    };

    const buildContext = (
      module: CompiledKernelModule,
      particleIndex: KernelNode,
    ): KernelModuleBuildContext => ({
      adapter,
      module,
      attribute: (name) => attributeNode(name, particleIndex),
      emitEvent: (eventName) => {
        const queue = program.events.find((candidate) => candidate.eventName === eventName);
        const resources = eventOutputResources[eventName];
        if (queue && resources) appendEvent(queue, resources, particleIndex);
      },
      random: (sampleOffset = 0) => randomNode(module, particleIndex, sampleOffset),
      sampleLut: (id, coordinate) => {
        const texture = lutTextures[id];
        const lut = program.luts.find((candidate) => candidate.id === id);
        if (!texture) throw new Error(`Compiled LUT "${id}" is missing.`);
        if (!lut) throw new Error(`Compiled LUT descriptor "${id}" is missing.`);
        const texelCentered = coordinate.mul((lut.width - 1) / lut.width).add(0.5 / lut.width);
        return adapter.sampleTexture(texture, adapter.vec2(texelCentered, 0.5));
      },
      uniform: uniformNode,
      value: (input, type, sampleOffset = 0) =>
        buildValue(input, type, module, particleIndex, sampleOffset),
      write: (name, value) => {
        writeAttribute(name, value, particleIndex);
      },
    });

    const buildTslModule = (module: CompiledKernelModule, particleIndex: KernelNode): void => {
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
            return attributeNode(name, particleIndex);
          },
        },
      );
      const outputs = factory(bindings as TslParticleBindings);
      for (const [key, value] of Object.entries(outputs)) {
        const name = key.startsWith('custom.') ? key.slice('custom.'.length) : key;
        writeAttribute(name, value as unknown as KernelNode, particleIndex);
      }
    };

    const buildModule = (module: CompiledKernelModule, particleIndex: KernelNode): void => {
      if (module.type === 'core/tsl-module') {
        buildTslModule(module, particleIndex);
        return;
      }
      const implementation = registry.resolve(module.type, module.version);
      if (!implementation || implementation.stage === 'spawn') {
        throw new Error(`Kernel implementation for ${module.type} is missing.`);
      }
      implementation.build(buildContext(module, particleIndex));
    };

    const initModules = program.kernels.init.modules;
    const ageModule = program.kernels.update.modules.find(({ type }) => type === 'core/age');
    const updateModules = program.kernels.update.modules.filter(({ type }) => type !== 'core/age');

    const initialize = adapter
      .fn(() => {
        writeAttribute('alive', adapter.constant(false, 'bool'));
        writeAttribute('spawnGeneration', adapter.constant(0, 'u32'));
        writeLifecycle(
          stateLayout.fields.freeList.offsetWords,
          adapter.uint(adapter.instanceIndex),
          adapter.instanceIndex,
        );
        adapter.branch(adapter.instanceIndex.equal(adapter.uint(0)), () => {
          writeLifecycle(counterOffsets.freeCount, adapter.uint(capacity));
          writeLifecycle(counterOffsets.aliveCount, adapter.uint(0));
          writeLifecycle(counterOffsets.spawnSuccess, adapter.uint(0));
          writeLifecycle(counterOffsets.spawnOverflow, adapter.uint(0));
          for (const queue of program.events) {
            const resources = eventOutputResources[queue.eventName];
            if (!resources) continue;
            for (let word = 0; word < queue.stateWordCount; word += 1) {
              adapter.atomicStore(eventStateElement(resources, word), adapter.uint(0));
            }
          }
        });
      })
      .compute(capacity, [program.spawn.workgroupSize])
      .setName('NachiEmitterInitialize');

    // M1 compatibility only: this all-slots init kernel MUST NOT be mixed with the M2 lifecycle
    // path (initialize -> spawn -> update -> compact). It marks every slot alive without updating
    // free/alive counters, so submitting both paths can make allocator counters inconsistent.
    const init = adapter
      .fn(() => {
        for (const module of initModules) buildModule(module, adapter.instanceIndex);
        writeAttribute('alive', adapter.constant(true, 'bool'));
      })
      .compute(program.attributeSchema.capacity, [program.kernels.init.workgroupSize])
      .setName(program.kernels.init.name);

    const recycleParticle = (particleIndex: KernelNode): void => {
      if (gpuLifecycle) {
        const freeSlot = adapter.atomicAdd(
          counter(counterOffsets.freeCount),
          adapter.uint(1),
          true,
        );
        writeLifecycle(
          stateLayout.fields.freeList.offsetWords,
          adapter.uint(particleIndex),
          freeSlot,
        );
      }
    };

    const update = adapter
      .fn(() => {
        const particleIndex = adapter.instanceIndex;
        adapter.branch(attributeNode('alive', particleIndex).equal(adapter.uint(1)), () => {
          if (ageModule) {
            buildModule(ageModule, particleIndex);
            adapter.branch(
              attributeNode('age', particleIndex).greaterThanEqual(
                attributeNode('lifetime', particleIndex),
              ),
              () => {
                writeAttribute('alive', adapter.constant(false, 'bool'), particleIndex);
              },
              () => {
                for (const module of updateModules) buildModule(module, particleIndex);
              },
            );
          } else {
            for (const module of updateModules) buildModule(module, particleIndex);
          }
          // Any declared update module may kill by writing Particles.alive. Recycling remains a
          // compiler-owned epilogue so every scattered death appends its physical slot once.
          adapter.branch(attributeNode('alive', particleIndex).equal(adapter.uint(0)), () => {
            for (const queue of program.events) {
              if (queue.eventName !== 'onDeath') continue;
              const resources = eventOutputResources[queue.eventName];
              if (resources) appendEvent(queue, resources, particleIndex);
            }
            recycleParticle(particleIndex);
          });
        });
      })
      .compute(program.attributeSchema.capacity, [program.kernels.update.workgroupSize])
      .setName(program.kernels.update.name);

    const spawnBody = (): void => {
      const invocation = adapter.instanceIndex;
      const requested = adapter.uint(uniformNode('Emitter.spawnCount'));
      adapter.branch(invocation.lessThan(requested), () => {
        if (gpuLifecycle) {
          const available = adapter.atomicLoad(counter(counterOffsets.freeCount));
          adapter.branch(
            invocation.lessThan(available),
            () => {
              const freeSlot = available.sub(adapter.uint(1)).sub(invocation);
              const particleIndex = readLifecycle(
                stateLayout.fields.freeList.offsetWords,
                freeSlot,
              );
              writeAttribute(
                'spawnGeneration',
                attributeNode('spawnGeneration', particleIndex).add(adapter.uint(1)),
                particleIndex,
              );
              for (const module of initModules) buildModule(module, particleIndex);
              writeAttribute('alive', adapter.uint(1), particleIndex);
              adapter.atomicAdd(counter(counterOffsets.spawnSuccess), adapter.uint(1));
            },
            () => {
              adapter.atomicAdd(counter(counterOffsets.spawnOverflow), adapter.uint(1));
            },
          );
        } else {
          const particleIndex = invocation;
          writeAttribute(
            'spawnGeneration',
            attributeNode('spawnGeneration', particleIndex).add(adapter.uint(1)),
            particleIndex,
          );
          for (const module of initModules) buildModule(module, particleIndex);
          writeAttribute('alive', adapter.uint(1), particleIndex);
        }
      });
    };

    const spawnBuilder = adapter.fn(spawnBody);
    const spawn = (
      gpuLifecycle
        ? spawnBuilder.computeKernel([program.spawn.workgroupSize])
        : spawnBuilder.compute(capacity, [program.spawn.workgroupSize])
    ).setName('NachiEmitterSpawn');

    let prepareSpawn: KernelComputeNode | undefined;
    let finalizeSpawn: KernelComputeNode | undefined;
    let resetAliveCount: KernelComputeNode | undefined;
    let compact: KernelComputeNode | undefined;
    let finalizeIndirect: KernelComputeNode | undefined;
    let spawnDispatch: KernelIndirectStorageNode | undefined;
    let drawIndirect: KernelIndirectStorageNode | undefined;

    if (gpuLifecycle) {
      spawnDispatch = lifecycleIndirectStorage as KernelIndirectStorageNode;
      drawIndirect = lifecycleIndirectStorage as KernelIndirectStorageNode;
      prepareSpawn = adapter
        .fn(() => {
          adapter.atomicStore(counter(counterOffsets.spawnSuccess), adapter.uint(0));
          const requested = adapter.uint(uniformNode('Emitter.spawnCount'));
          writeIndirect(
            indirectLayout.fields.spawnDispatch.offsetWords,
            requested
              .add(adapter.uint(program.spawn.workgroupSize - 1))
              .div(adapter.uint(program.spawn.workgroupSize)),
          );
          writeIndirect(indirectLayout.fields.spawnDispatch.offsetWords + 1, adapter.uint(1));
          writeIndirect(indirectLayout.fields.spawnDispatch.offsetWords + 2, adapter.uint(1));
        })
        .compute(1, [1])
        .setName('NachiEmitterPrepareSpawn');
      finalizeSpawn = adapter
        .fn(() => {
          const successful = adapter.atomicLoad(counter(counterOffsets.spawnSuccess));
          adapter.atomicAdd(counter(counterOffsets.freeCount), adapter.uint(0).sub(successful));
        })
        .compute(1, [1])
        .setName('NachiEmitterFinalizeSpawn');
      resetAliveCount = adapter
        .fn(() => {
          adapter.atomicStore(counter(counterOffsets.aliveCount), adapter.uint(0));
        })
        .compute(1, [1])
        .setName('NachiEmitterResetAliveCount');
      compact = adapter
        .fn(() => {
          adapter.branch(attributeNode('alive').equal(adapter.uint(1)), () => {
            const compactIndex = adapter.atomicAdd(
              counter(counterOffsets.aliveCount),
              adapter.uint(1),
              true,
            );
            writeLifecycle(
              stateLayout.fields.aliveIndices.offsetWords,
              adapter.uint(adapter.instanceIndex),
              compactIndex,
            );
          });
        })
        .compute(capacity, [program.kernels.update.workgroupSize])
        .setName('NachiEmitterCompactAlive');
      finalizeIndirect = adapter
        .fn(() => {
          const count = adapter.atomicLoad(counter(counterOffsets.aliveCount));
          writeIndirect(indirectLayout.fields.drawIndirect.offsetWords + 1, count);
          writeIndirect(indirectLayout.fields.drawIndirect.offsetWords + 2, adapter.uint(0));
          writeIndirect(indirectLayout.fields.drawIndirect.offsetWords + 3, adapter.uint(0));
          writeIndirect(indirectLayout.fields.drawIndirect.offsetWords + 4, adapter.uint(0));
        })
        .compute(1, [1])
        .setName('NachiEmitterFinalizeIndirect');
    }

    const builtEventOutputs = Object.fromEntries(
      program.events.map((queue) => {
        const resources = eventOutputResources[queue.eventName];
        if (!resources) throw new Error(`Event resources for ${queue.eventName} are missing.`);
        const reset = adapter
          .fn(() => {
            const bank = adapter.uint(uniformNode('Emitter.eventWriteBank'));
            adapter.atomicStore(eventStateElement(resources, bank), adapter.uint(0));
          })
          .compute(1, [1])
          .setName(`NachiEventReset_${queue.eventName}`);
        return [queue.eventName, { ...resources, queue, reset }] as const;
      }),
    );

    const builtEventInputs: BuiltEventInputKernels[] = eventInputs.map((binding, inputIndex) => {
      const { handler, queue, resources } = binding;
      const readCount = () => {
        const bank = adapter.uint(uniformNode('Emitter.eventReadBank'));
        return adapter
          .atomicLoad(eventStateElement(resources, bank))
          .clamp(adapter.uint(0), adapter.uint(queue.capacity));
      };
      const prepare = adapter
        .fn(() => {
          adapter.atomicStore(counter(counterOffsets.spawnSuccess), adapter.uint(0));
          const count = readCount();
          resources.indirect
            .element(adapter.uint(0))
            .assign(
              count
                .add(adapter.uint(program.spawn.workgroupSize - 1))
                .div(adapter.uint(program.spawn.workgroupSize)),
            );
          resources.indirect.element(adapter.uint(1)).assign(adapter.uint(1));
          resources.indirect.element(adapter.uint(2)).assign(adapter.uint(1));
        })
        .compute(1, [1])
        .setName(`NachiEventPrepare_${binding.sourceKey}_${queue.eventName}_${inputIndex}`);
      const spawn = adapter
        .fn(() => {
          const invocation = adapter.instanceIndex;
          adapter.branch(invocation.lessThan(readCount()), () => {
            const available = adapter.atomicLoad(counter(counterOffsets.freeCount));
            adapter.branch(
              invocation.lessThan(available),
              () => {
                const freeSlot = available.sub(adapter.uint(1)).sub(invocation);
                const particleIndex = readLifecycle(
                  stateLayout.fields.freeList.offsetWords,
                  freeSlot,
                );
                writeAttribute(
                  'spawnGeneration',
                  attributeNode('spawnGeneration', particleIndex).add(adapter.uint(1)),
                  particleIndex,
                );
                for (const module of initModules) buildModule(module, particleIndex);
                const bank = adapter.uint(uniformNode('Emitter.eventReadBank'));
                for (const name of handler.inherit) {
                  const field = queue.payloadFields.find(
                    (candidate) => candidate.attribute === name,
                  );
                  if (!field) continue;
                  const payload = payloadElement(resources, queue, bank, invocation, field.group);
                  const lanes = [payload.x, payload.y, payload.z, payload.w].slice(
                    field.offset,
                    field.offset + field.components,
                  );
                  const value =
                    field.components === 1
                      ? lanes[0]!
                      : field.components === 2
                        ? adapter.vec2(lanes[0]!, lanes[1]!)
                        : field.components === 3
                          ? adapter.vec3(lanes[0]!, lanes[1]!, lanes[2]!)
                          : adapter.vec4(lanes[0]!, lanes[1]!, lanes[2]!, lanes[3]!);
                  writeAttribute(name, value, particleIndex);
                }
                writeAttribute('alive', adapter.uint(1), particleIndex);
                adapter.atomicAdd(counter(counterOffsets.spawnSuccess), adapter.uint(1));
              },
              () => {
                adapter.atomicAdd(counter(counterOffsets.spawnOverflow), adapter.uint(1));
              },
            );
          });
        })
        .computeKernel([program.spawn.workgroupSize])
        .setName(`NachiEventSpawn_${binding.sourceKey}_${queue.eventName}_${inputIndex}`);
      const finalize = adapter
        .fn(() => {
          const successful = adapter.atomicLoad(counter(counterOffsets.spawnSuccess));
          adapter.atomicAdd(counter(counterOffsets.freeCount), adapter.uint(0).sub(successful));
        })
        .compute(1, [1])
        .setName(`NachiEventFinalize_${binding.sourceKey}_${queue.eventName}_${inputIndex}`);
      return { binding, finalize, prepare, spawn };
    });

    return {
      aliveCount: lifecycleStorage,
      aliveIndices: lifecycleStorage,
      aliveIndicesOffset: stateLayout.fields.aliveIndices.offsetWords,
      capabilityPath: gpuLifecycle ? 'webgpu-atomic-indirect' : 'webgl2-cpu-readback',
      ...(compact === undefined ? {} : { compact }),
      counterOffsets,
      ...(drawIndirect === undefined ? {} : { drawIndirect }),
      eventInputs: builtEventInputs,
      eventOutputs: builtEventOutputs,
      ...(drawIndirect === undefined
        ? {}
        : {
            drawIndirectOffsetBytes:
              indirectLayout.fields.drawIndirect.offsetWords * Uint32Array.BYTES_PER_ELEMENT,
          }),
      ...(finalizeIndirect === undefined ? {} : { finalizeIndirect }),
      ...(finalizeSpawn === undefined ? {} : { finalizeSpawn }),
      freeCount: lifecycleStorage,
      freeListOffset: stateLayout.fields.freeList.offsetWords,
      init,
      initialize,
      luts: lutTextures,
      ...(prepareSpawn === undefined ? {} : { prepareSpawn }),
      ...(resetAliveCount === undefined ? {} : { resetAliveCount }),
      spawn,
      ...(spawnDispatch === undefined ? {} : { spawnDispatch }),
      spawnOverflow: lifecycleStorage,
      storages,
      uniforms,
      update,
    };
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
  diagnostics.push(...collectEmitterBehaviorConfigDiagnostics(untypedDefinition));
  diagnostics.push(...collectEmitterModuleLabelDiagnostics(untypedDefinition));
  diagnostics.push(...collectParameterDeclarationDiagnostics(untypedDefinition.parameters));
  diagnostics.push(...validateRenderModuleLimit(untypedDefinition));
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
  const events = compileEventQueues(untypedDefinition, attributeSchema, diagnostics);
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
  const authoredSpawn = Array.isArray(definition.spawn) ? definition.spawn : [definition.spawn];
  const spawnModules = authoredSpawn.map((module, index) =>
    spawnModuleDescriptor(withDerivedConfigReads(module), `spawn[${index}]`, index),
  );
  for (const module of [...spawnModules, ...initialModules]) {
    diagnostics.push(...validateModule(module, registry));
  }
  diagnostics.push(
    ...validateReferences(
      [...spawnModules, ...initialModules],
      definition.parameters,
      options.eventPayloadFields ?? [],
    ),
  );
  diagnostics.push(...validateSpawnConfigs(spawnModules, definition.parameters));
  const locatedNonKernelModules = collectEmitterModules(normalizedDefinition).filter(
    ({ module }) =>
      module.stage !== 'init' && module.stage !== 'update' && module.stage !== 'spawn',
  );
  const nonKernelModules = locatedNonKernelModules.map(({ module, path }) => ({
    config: module.config,
    path,
  }));
  diagnostics.push(
    ...validateReferences(
      locatedNonKernelModules.map(({ module, path }) => ({
        access: module.access ?? { reads: [], writes: [] },
        path,
      })),
      definition.parameters,
      options.eventPayloadFields ?? [],
    ),
  );
  diagnostics.push(
    ...validateValueGenerators([...initialModules, ...nonKernelModules], definition.parameters),
  );
  diagnostics.push(
    ...validateStageWrites([
      ...spawnModules,
      ...initialModules,
      ...locatedNonKernelModules.map(({ module, path }) => ({
        access: module.access ?? { reads: [], writes: [] },
        path,
        stage: module.stage,
        type: module.type,
      })),
    ]),
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
  const webgl2SpawnVaryings = [
    ...new Set([
      ...initModules.flatMap(({ access }) =>
        access.writes.filter((path) => path.startsWith('Particles.')),
      ),
      'Particles.alive',
      'Particles.spawnGeneration',
    ]),
  ].sort();
  const lifecycleLayout = lifecycleStorageLayout(definition.capacity);
  const spriteDraws = compileSpriteDraws(
    normalizedDefinition,
    attributeSchema,
    lifecycleLayout,
    diagnostics,
  );
  const meshDraws = compileMeshDraws(
    normalizedDefinition,
    attributeSchema,
    lifecycleLayout,
    diagnostics,
  );
  const drawsByPath = new Map(
    [...spriteDraws, ...meshDraws].map((draw) => [draw.path, draw] as const),
  );
  const draws = collectEmitterModules(normalizedDefinition).flatMap(({ module, path }) => {
    if (module.stage !== 'render') return [];
    const draw = drawsByPath.get(path);
    return draw === undefined ? [] : [draw];
  });
  const vertexStorageBuffers = [...new Set(draws.flatMap(({ vertex }) => vertex.storageBuffers))];
  const storageBuffers: CompiledEmitterMeta['storageBuffers'] = [
    ...attributeSchema.storageArrays.map((storage) => ({
      attributes: storage.attributes.map((name) => {
        const attribute = attributeSchema.byName[name];
        if (!attribute) throw new Error(`Storage attribute "${name}" is missing.`);
        return {
          components: attribute.components,
          group: attribute.physical.group,
          logicalType: attribute.logicalType,
          name,
          offset: attribute.physical.offset,
        };
      }),
      count: 1 as const,
      groupCount: storage.groupCount,
      name: `Particles.${storage.name}`,
      packed: storage.packed,
      purposes: storage.attributes.map((attribute) => `particle attribute ${attribute}`),
      storageType: storage.type,
    })),
    {
      count: 1,
      name: 'NachiLifecycleIndirectArguments',
      purposes: ['spawn dispatch indirect arguments', 'draw indirect arguments'],
    },
    {
      count: 1,
      name: 'NachiLifecycleState',
      purposes: [
        'free/alive/success/overflow counters',
        'free-list indices',
        'compacted alive indices',
      ],
    },
    ...events.flatMap((queue) => [
      {
        count: 1 as const,
        name: `NachiEventState.${queue.eventName}`,
        purposes: ['double-buffered append counters', 'event overflow and aggregate counters'],
      },
      {
        count: 1 as const,
        groupCount: queue.payloadGroupCount,
        name: `NachiEventPayload.${queue.eventName}`,
        purposes: ['double-buffered inherited event payload'],
        storageType: 'vec4' as const,
      },
      {
        count: 1 as const,
        name: `NachiEventIndirect.${queue.eventName}`,
        purposes: ['event spawn dispatch indirect arguments'],
      },
    ]),
  ];
  const meta: CompiledEmitterMeta = {
    backendBudgets: {
      webgl2: {
        defaultSpawnVaryingLimit: 4,
        spawnVaryingCount: webgl2SpawnVaryings.length,
        spawnVaryings: webgl2SpawnVaryings,
      },
      webgpu: {
        defaultVertexStorageBufferLimit: 8,
        vertexStorageBufferCount: vertexStorageBuffers.length,
        vertexStorageBuffers,
      },
    },
    capabilities: {
      webgl2: {
        aliveCount: 'cpu-readback',
        allocation: 'prefix-cpu-fallback',
        indirectDraw: false,
      },
      webgpu: {
        aliveCount: 'atomic-compaction',
        allocation: 'atomic-free-list',
        indirectDraw: true,
      },
    },
    lifecycleStorage: {
      buffers: lifecycleLayout.buffers,
      wordCount: lifecycleLayout.wordCount,
    },
    eventQueues: events,
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
    storageBuffers,
    storageBufferCount: storageBuffers.length,
  };
  const description = {
    attributeSchema,
    diagnostics,
    draws,
    events,
    kernels,
    luts: baked.luts,
    meta,
    spawn: { modules: spawnModules, workgroupSize },
    uniforms,
  };
  return {
    ...description,
    buildKernels: createBuildKernels(
      description,
      registry,
      normalized.factories,
      definition.lifecycle,
    ),
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

type CollisionResponseConfig = {
  readonly bounce?: unknown;
  readonly friction?: unknown;
  readonly mode?: CollisionMode;
  readonly space?: 'emitter' | 'world';
};

function dot3(left: KernelNode, right: KernelNode): KernelNode {
  return left.x.mul(right.x).add(left.y.mul(right.y)).add(left.z.mul(right.z));
}

function length3(value: KernelNode): KernelNode {
  return dot3(value, value).sqrt();
}

function normalized3(
  context: KernelModuleBuildContext,
  value: KernelNode,
  fallback: Vec3 = [0, 1, 0],
): KernelNode {
  const length = length3(value);
  return context.adapter.select(
    length.lessThan(context.adapter.constant(0.000001, 'f32')),
    context.adapter.vec3(...fallback),
    value.div(length.clamp(0.000001, 1e20)),
  );
}

function collisionFrame(
  context: KernelModuleBuildContext,
  space: 'emitter' | 'world' | undefined,
): { readonly position: KernelNode; readonly velocity: KernelNode } {
  const position = context.attribute('position');
  const velocity = context.attribute('velocity');
  if (space !== 'emitter') return { position, velocity };
  const inverseTransform = context.adapter.inverse(context.uniform('Emitter.transform'));
  return {
    position: inverseTransform.mul(context.adapter.vec4(position.x, position.y, position.z, 1)).xyz,
    velocity: inverseTransform.mul(context.adapter.vec4(velocity.x, velocity.y, velocity.z, 0)).xyz,
  };
}

function writeCollisionResponse(
  context: KernelModuleBuildContext,
  config: CollisionResponseConfig,
  collided: KernelNode,
  correctedPosition: KernelNode,
  normal: KernelNode,
  velocity: KernelNode,
): void {
  context.adapter.branch(collided, () => {
    const transform = config.space === 'emitter' ? context.uniform('Emitter.transform') : undefined;
    const worldPosition =
      config.space === 'emitter'
        ? transform!.mul(
            context.adapter.vec4(correctedPosition.x, correctedPosition.y, correctedPosition.z, 1),
          ).xyz
        : correctedPosition;
    context.write('position', worldPosition);

    let responseVelocity: KernelNode;
    if (config.mode === 'kill') {
      responseVelocity = velocity;
    } else if (config.mode === 'stick') {
      responseVelocity = context.adapter.vec3(0, 0, 0);
    } else {
      const normalSpeed = dot3(velocity, normal);
      const tangent = velocity.sub(normal.mul(normalSpeed));
      const bounce = context.value(config.bounce ?? 1, 'f32', 20).clamp(0, 1);
      const friction = context.value(config.friction ?? 0, 'f32', 21).clamp(0, 1);
      const outgoingNormalSpeed = context.adapter.select(
        normalSpeed.lessThan(context.adapter.constant(0, 'f32')),
        normalSpeed.mul(bounce).mul(-1),
        normalSpeed,
      );
      responseVelocity = tangent
        .mul(context.adapter.constant(1, 'f32').sub(friction))
        .add(normal.mul(outgoingNormalSpeed));
    }
    const worldVelocity =
      config.space === 'emitter'
        ? transform!.mul(
            context.adapter.vec4(responseVelocity.x, responseVelocity.y, responseVelocity.z, 0),
          ).xyz
        : responseVelocity;
    context.write('velocity', worldVelocity);
    context.emitEvent('onCollision');
    if (config.mode === 'kill') {
      context.write('alive', context.adapter.constant(false, 'bool'));
    }
  });
}

export function createCoreKernelModuleRegistry(): KernelModuleRegistry {
  const registry = new KernelModuleRegistry();
  registry.register({
    access: {
      reads: ['Emitter.localTime'],
      writes: ['Emitter.spawnCount'],
    },
    stage: 'spawn',
    type: 'core/burst',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime'],
      writes: ['Emitter.spawnCount'],
    },
    stage: 'spawn',
    type: 'core/rate',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform'],
      writes: ['Emitter.spawnCount'],
    },
    stage: 'spawn',
    type: 'core/per-distance',
    version: 1,
  });
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
      reads: ['Emitter.transform', 'Emitter.seed', 'Particles.spawnGeneration'],
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
      reads: ['Emitter.seed', 'Emitter.transform', 'Particles.spawnGeneration'],
      writes: ['Particles.position', 'Particles.surfaceNormal'],
    },
    build(context) {
      const config = context.module.config as PositionMeshSurfaceOptions;
      const sample = context.adapter.sampleMeshSurface(
        config.mesh,
        context.random(1),
        context.random(2),
        context.random(3),
      );
      const transform = context.uniform('Emitter.transform');
      const worldPosition = transform.mul(
        context.adapter.vec4(sample.position.x, sample.position.y, sample.position.z, 1),
      ).xyz;
      const worldNormal = normalized3(
        context,
        transform.mul(context.adapter.vec4(sample.normal.x, sample.normal.y, sample.normal.z, 0))
          .xyz,
      );
      context.write('position', worldPosition);
      context.write('surfaceNormal', worldNormal);
    },
    stage: 'init',
    type: 'core/position-mesh-surface',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.seed', 'Particles.spawnGeneration'],
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
      reads: ['Particles.surfaceNormal'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as VelocityMeshNormalOptions;
      context.write(
        'velocity',
        context.attribute('surfaceNormal').mul(context.value(config.speed, 'f32', 1)),
      );
    },
    stage: 'init',
    type: 'core/velocity-mesh-normal',
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
      const velocity = context.attribute('velocity');
      context.write('velocity', velocity.add(gravity.mul(context.uniform('Emitter.deltaTime'))));
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
      context.write('velocity', context.attribute('velocity').mul(damping));
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
      const frequency = context.value(config.frequency, 'f32', 1);
      const base = context.adapter.vec3(position.x, position.y, position.z).mul(frequency);
      const epsilon = CURL_NOISE_FINITE_DIFFERENCE;
      const potential = (sample: KernelNode) =>
        context.adapter.vec3(
          context.adapter.simplexNoise(sample).sub(0.5),
          context.adapter
            .simplexNoise(sample.add(context.adapter.vec3(31.416, -47.853, 12.793)))
            .sub(0.5),
          context.adapter
            .simplexNoise(sample.add(context.adapter.vec3(-19.271, 73.157, 41.039)))
            .sub(0.5),
        );
      const dx = context.adapter.vec3(epsilon, 0, 0);
      const dy = context.adapter.vec3(0, epsilon, 0);
      const dz = context.adapter.vec3(0, 0, epsilon);
      const x0 = potential(base.sub(dx));
      const x1 = potential(base.add(dx));
      const y0 = potential(base.sub(dy));
      const y1 = potential(base.add(dy));
      const z0 = potential(base.sub(dz));
      const z1 = potential(base.add(dz));
      const field = context.adapter
        .vec3(
          y1.z.sub(y0.z).sub(z1.y).add(z0.y),
          z1.x.sub(z0.x).sub(x1.z).add(x0.z),
          x1.y.sub(x0.y).sub(y1.x).add(y0.x),
        )
        .mul(1 / (2 * epsilon * CURL_SIMPLEX_DERIVATIVE_AMPLITUDE));
      context.write(
        'velocity',
        context
          .attribute('velocity')
          .add(
            field
              .mul(context.value(config.strength, 'f32', 2))
              .mul(context.uniform('Emitter.deltaTime')),
          ),
      );
    },
    stage: 'update',
    type: 'core/curl-noise',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as VortexOptions;
      const basis = normalizedBasis(config.axis);
      const center = context.value(config.center ?? [0, 0, 0], 'vec3', 1);
      const position = context.attribute('position');
      const transform = context.uniform('Emitter.transform');
      const samplePosition =
        config.space === 'emitter'
          ? context.adapter
              .inverse(transform)
              .mul(context.adapter.vec4(position.x, position.y, position.z, 1)).xyz
          : position;
      const offset = context.adapter.vec3(
        samplePosition.x.sub(center.x),
        samplePosition.y.sub(center.y),
        samplePosition.z.sub(center.z),
      );
      const axial = offset.x
        .mul(basis.up[0])
        .add(offset.y.mul(basis.up[1]))
        .add(offset.z.mul(basis.up[2]));
      const radial = context.adapter.vec3(
        offset.x.sub(axial.mul(basis.up[0])),
        offset.y.sub(axial.mul(basis.up[1])),
        offset.z.sub(axial.mul(basis.up[2])),
      );
      const radialLength = radial.x
        .mul(radial.x)
        .add(radial.y.mul(radial.y))
        .add(radial.z.mul(radial.z))
        .sqrt()
        .clamp(0.000001, 1e20);
      const tangentDirection = context.adapter.vec3(
        radial.z.mul(basis.up[1]).sub(radial.y.mul(basis.up[2])),
        radial.x.mul(basis.up[2]).sub(radial.z.mul(basis.up[0])),
        radial.y.mul(basis.up[0]).sub(radial.x.mul(basis.up[1])),
      );
      const tangential = tangentDirection
        .div(radialLength)
        .mul(context.value(config.strength, 'f32', 4));
      const inward = radial
        .div(radialLength)
        .mul(context.value(config.inwardStrength ?? 0, 'f32', 5));
      const localAcceleration = tangential.sub(inward);
      const acceleration =
        config.space === 'emitter'
          ? transform.mul(
              context.adapter.vec4(
                localAcceleration.x,
                localAcceleration.y,
                localAcceleration.z,
                0,
              ),
            ).xyz
          : localAcceleration;
      context.write(
        'velocity',
        context.attribute('velocity').add(acceleration.mul(context.uniform('Emitter.deltaTime'))),
      );
    },
    stage: 'update',
    type: 'core/vortex',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as PointAttractorOptions;
      const target = context.value(config.position, 'vec3', 1);
      const position = context.attribute('position');
      const transform = context.uniform('Emitter.transform');
      const samplePosition =
        config.space === 'emitter'
          ? context.adapter
              .inverse(transform)
              .mul(context.adapter.vec4(position.x, position.y, position.z, 1)).xyz
          : position;
      const outward = context.adapter.vec3(
        samplePosition.x.sub(target.x),
        samplePosition.y.sub(target.y),
        samplePosition.z.sub(target.z),
      );
      const distance = outward.x
        .mul(outward.x)
        .add(outward.y.mul(outward.y))
        .add(outward.z.mul(outward.z))
        .sqrt()
        .clamp(0.000001, 1e20);
      const magnitude = context
        .value(config.strength, 'f32', 4)
        .div(distance.pow(context.value(config.falloff ?? 2, 'f32', 5)));
      const localAcceleration = outward.div(distance).mul(magnitude).mul(-1);
      const acceleration =
        config.space === 'emitter'
          ? transform.mul(
              context.adapter.vec4(
                localAcceleration.x,
                localAcceleration.y,
                localAcceleration.z,
                0,
              ),
            ).xyz
          : localAcceleration;
      const apply = () => {
        context.write(
          'velocity',
          context.attribute('velocity').add(acceleration.mul(context.uniform('Emitter.deltaTime'))),
        );
      };
      if (config.radius === undefined) apply();
      else context.adapter.branch(distance.lessThan(context.value(config.radius, 'f32', 6)), apply);
    },
    stage: 'update',
    type: 'core/point-attractor',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const force = context.value(
        (context.module.config as { force: ValueInput<Vec3> }).force,
        'vec3',
        1,
      );
      context.write(
        'velocity',
        context.attribute('velocity').add(force.mul(context.uniform('Emitter.deltaTime'))),
      );
    },
    stage: 'update',
    type: 'core/linear-force',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as TurbulenceOptions;
      const position = context.attribute('position');
      const base = context.adapter
        .vec3(position.x, position.y, position.z)
        .mul(context.value(config.frequency, 'f32', 1));
      const octaves = Math.max(1, Math.min(4, Math.floor(config.octaves ?? 3)));
      let amplitude = 1;
      let amplitudeSum = 0;
      let frequency = 1;
      let x = context.adapter.constant(0, 'f32');
      let y = context.adapter.constant(0, 'f32');
      let z = context.adapter.constant(0, 'f32');
      for (let octave = 0; octave < octaves; octave += 1) {
        const sample = base.mul(frequency);
        x = x.add(context.adapter.simplexNoise(sample).sub(0.5).mul(amplitude));
        y = y.add(
          context.adapter
            .simplexNoise(sample.add(context.adapter.vec3(31.416, -47.853, 12.793)))
            .sub(0.5)
            .mul(amplitude),
        );
        z = z.add(
          context.adapter
            .simplexNoise(sample.add(context.adapter.vec3(-19.271, 73.157, 41.039)))
            .sub(0.5)
            .mul(amplitude),
        );
        amplitudeSum += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
      }
      const normalizedField = context.adapter
        .vec3(x, y, z)
        .mul(1 / (TURBULENCE_SIMPLEX_AMPLITUDE * amplitudeSum));
      const fieldLength = normalizedField.x
        .mul(normalizedField.x)
        .add(normalizedField.y.mul(normalizedField.y))
        .add(normalizedField.z.mul(normalizedField.z))
        .sqrt();
      const acceleration = normalizedField
        .div(fieldLength.clamp(1, 1e20))
        .mul(context.value(config.strength, 'f32', 2));
      context.write(
        'velocity',
        context.attribute('velocity').add(acceleration.mul(context.uniform('Emitter.deltaTime'))),
      );
    },
    stage: 'update',
    type: 'core/turbulence',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as VectorFieldOptions;
      const position = context.attribute('position');
      const sampled = context.adapter.sampleVectorField(
        config.field,
        context.adapter.vec3(position.x, position.y, position.z),
        config.tiling ?? false,
      );
      context.write(
        'velocity',
        context
          .attribute('velocity')
          .add(
            sampled
              .mul(context.value(config.strength, 'f32', 1))
              .mul(context.uniform('Emitter.deltaTime')),
          ),
      );
    },
    stage: 'update',
    type: 'core/vector-field',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as CollidePlaneOptions;
      const frame = collisionFrame(context, config.space);
      const basis = normalizedBasis(config.normal);
      const normal = context.adapter.vec3(...basis.up);
      const signedDistance = dot3(frame.position, normal).sub(
        context.value(config.offset, 'f32', 1),
      );
      writeCollisionResponse(
        context,
        config,
        signedDistance.lessThan(context.adapter.constant(0, 'f32')),
        frame.position.sub(normal.mul(signedDistance)),
        normal,
        frame.velocity,
      );
    },
    stage: 'update',
    type: 'core/collide-plane',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as CollideSphereOptions;
      const frame = collisionFrame(context, config.space);
      const center = context.value(config.center, 'vec3', 1);
      const delta = context.adapter.vec3(
        frame.position.x.sub(center.x),
        frame.position.y.sub(center.y),
        frame.position.z.sub(center.z),
      );
      const radius = context.value(config.radius, 'f32', 4);
      const distance = length3(delta);
      const normal = normalized3(context, delta);
      writeCollisionResponse(
        context,
        config,
        distance.lessThan(radius),
        center.add(normal.mul(radius)),
        normal,
        frame.velocity,
      );
    },
    stage: 'update',
    type: 'core/collide-sphere',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as CollideBoxOptions;
      const frame = collisionFrame(context, config.space);
      const center = context.value(config.center, 'vec3', 1);
      const halfSize = context.value(config.size, 'vec3', 4).mul(0.5);
      const delta = context.adapter.vec3(
        frame.position.x.sub(center.x),
        frame.position.y.sub(center.y),
        frame.position.z.sub(center.z),
      );
      const absolute = context.adapter.vec3(
        delta.x.mul(delta.x).sqrt(),
        delta.y.mul(delta.y).sqrt(),
        delta.z.mul(delta.z).sqrt(),
      );
      const penetrationX = halfSize.x.sub(absolute.x);
      const penetrationY = halfSize.y.sub(absolute.y);
      const penetrationZ = halfSize.z.sub(absolute.z);
      const sign = (component: KernelNode) =>
        context.adapter.select(
          context.adapter.constant(0, 'f32').lessThanEqual(component),
          context.adapter.constant(1, 'f32'),
          context.adapter.constant(-1, 'f32'),
        );
      const normalX = context.adapter.vec3(sign(delta.x), 0, 0);
      const normalY = context.adapter.vec3(0, sign(delta.y), 0);
      const normalZ = context.adapter.vec3(0, 0, sign(delta.z));
      const useX = penetrationX.lessThanEqual(penetrationY);
      const xyPenetration = context.adapter.select(useX, penetrationX, penetrationY);
      const xyNormal = context.adapter.select(useX, normalX, normalY);
      const useXY = xyPenetration.lessThanEqual(penetrationZ);
      const penetration = context.adapter.select(useXY, xyPenetration, penetrationZ);
      const normal = context.adapter.select(useXY, xyNormal, normalZ);
      const inside = absolute.x
        .lessThan(halfSize.x)
        .and(absolute.y.lessThan(halfSize.y))
        .and(absolute.z.lessThan(halfSize.z));
      writeCollisionResponse(
        context,
        config,
        inside,
        frame.position.add(normal.mul(penetration)),
        normal,
        frame.velocity,
      );
    },
    stage: 'update',
    type: 'core/collide-box',
    version: 1,
  });
  registry.register({
    access: {
      reads: [
        'System.projectionMatrix',
        'System.viewMatrix',
        'System.viewportSize',
        'Particles.position',
        'Particles.velocity',
      ],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    build(context) {
      const sampleDepth = context.adapter.sampleSceneDepth;
      if (!sampleDepth) throw new Error('Scene-depth sampler is missing.');
      const config = context.module.config as CollideSceneDepthOptions;
      const position = context.attribute('position');
      const viewMatrix = context.uniform('System.viewMatrix');
      const projectionMatrix = context.uniform('System.projectionMatrix');
      const viewPosition = viewMatrix.mul(
        context.adapter.vec4(position.x, position.y, position.z, 1),
      );
      const clipPosition = projectionMatrix.mul(viewPosition);
      const inverseW = context.adapter
        .constant(1, 'f32')
        .div(clipPosition.w.mul(clipPosition.w).sqrt().clamp(0.000001, 1e20));
      const ndc = clipPosition.xyz.mul(inverseW);
      const uv = context.adapter.vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(0.5).add(0.5));
      // WebGPURenderer supplies a WebGPU projection matrix, whose NDC z is already [0, 1].
      const particleDepth = ndc.z;
      const sceneDepth = sampleDepth(uv);
      const viewport = context.uniform('System.viewportSize');
      const texel = context.adapter.vec2(
        context.adapter.constant(1, 'f32').div(viewport.x.clamp(1, 1e20)),
        context.adapter.constant(1, 'f32').div(viewport.y.clamp(1, 1e20)),
      );
      const reconstructView = (sampleUv: KernelNode, depth: KernelNode): KernelNode => {
        const clip = context.adapter.vec4(
          sampleUv.x.mul(2).sub(1),
          sampleUv.y.mul(2).sub(1),
          depth,
          1,
        );
        const homogeneous = context.adapter.inverse(projectionMatrix).mul(clip);
        return homogeneous.xyz.div(homogeneous.w.mul(homogeneous.w).sqrt().clamp(0.000001, 1e20));
      };
      const leftUv = context.adapter.vec2(uv.x.sub(texel.x), uv.y).clamp(0, 1);
      const rightUv = context.adapter.vec2(uv.x.add(texel.x), uv.y).clamp(0, 1);
      const downUv = context.adapter.vec2(uv.x, uv.y.sub(texel.y)).clamp(0, 1);
      const upUv = context.adapter.vec2(uv.x, uv.y.add(texel.y)).clamp(0, 1);
      const left = reconstructView(leftUv, sampleDepth(leftUv));
      const right = reconstructView(rightUv, sampleDepth(rightUv));
      const down = reconstructView(downUv, sampleDepth(downUv));
      const up = reconstructView(upUv, sampleDepth(upUv));
      const horizontal = right.sub(left);
      const vertical = up.sub(down);
      const rawNormal = context.adapter.vec3(
        horizontal.y.mul(vertical.z).sub(horizontal.z.mul(vertical.y)),
        horizontal.z.mul(vertical.x).sub(horizontal.x.mul(vertical.z)),
        horizontal.x.mul(vertical.y).sub(horizontal.y.mul(vertical.x)),
      );
      const surfaceView = reconstructView(uv, sceneDepth);
      const normalized = normalized3(context, rawNormal, [0, 0, 1]);
      const viewNormal = context.adapter.select(
        context.adapter.constant(0, 'f32').lessThan(dot3(normalized, surfaceView)),
        normalized.mul(-1),
        normalized,
      );
      const inverseView = context.adapter.inverse(viewMatrix);
      const worldNormal = normalized3(
        context,
        inverseView.mul(context.adapter.vec4(viewNormal.x, viewNormal.y, viewNormal.z, 0)).xyz,
        [0, 1, 0],
      );
      const surfaceOffset = context.value(config.surfaceOffset ?? 0.001, 'f32', 1);
      const correctedView = surfaceView.add(viewNormal.mul(surfaceOffset));
      const correctedWorld = inverseView.mul(
        context.adapter.vec4(correctedView.x, correctedView.y, correctedView.z, 1),
      ).xyz;
      const zero = context.adapter.constant(0, 'f32');
      const one = context.adapter.constant(1, 'f32');
      const visible = zero
        .lessThan(clipPosition.w)
        .and(zero.lessThanEqual(uv.x))
        .and(uv.x.lessThanEqual(one))
        .and(zero.lessThanEqual(uv.y))
        .and(uv.y.lessThanEqual(one));
      const collided = visible
        .and(sceneDepth.lessThan(0.999999))
        .and(sceneDepth.lessThan(particleDepth))
        .and(
          surfaceView.z
            .sub(viewPosition.z)
            .lessThanEqual(context.value(config.thickness ?? 0.1, 'f32', 2)),
        );
      writeCollisionResponse(
        context,
        { ...config, mode: config.mode ?? 'bounce', space: 'world' },
        collided,
        correctedWorld,
        worldNormal,
        context.attribute('velocity'),
      );
    },
    stage: 'update',
    type: 'core/collide-scene-depth',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as CollideSdfOptions;
      const position = context.attribute('position');
      const sampled = context.adapter.sampleSdf(
        config.field,
        context.adapter.vec3(position.x, position.y, position.z),
      );
      const normal = normalized3(context, sampled.gradient);
      const penetration = sampled.distance.mul(-1);
      const collided = sampled.distance
        .lessThan(context.adapter.constant(0, 'f32'))
        .and(
          config.thickness === undefined
            ? context.adapter.constant(true, 'bool')
            : penetration.lessThanEqual(context.value(config.thickness, 'f32', 1)),
        );
      writeCollisionResponse(
        context,
        { ...config, space: 'world' },
        collided,
        position.sub(normal.mul(sampled.distance)),
        normal,
        context.attribute('velocity'),
      );
    },
    stage: 'update',
    type: 'core/collide-sdf',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Particles.rotation', 'Particles.spriteRotation', 'Particles.velocity'],
      writes: ['Particles.rotation', 'Particles.spriteRotation'],
    },
    build(context) {
      const velocity = context.attribute('velocity');
      const speed = velocity.x
        .mul(velocity.x)
        .add(velocity.y.mul(velocity.y))
        .add(velocity.z.mul(velocity.z))
        .sqrt();
      const safeSpeed = speed.clamp(0.000001, 1e20);
      const direction = context.adapter.vec3(
        velocity.x.div(safeSpeed),
        velocity.y.div(safeSpeed),
        velocity.z.div(safeSpeed),
      );
      const quaternion = context.adapter.vec4(
        direction.z,
        0,
        direction.x.mul(-1),
        direction.y.add(1),
      );
      const quaternionLength = quaternion.x
        .mul(quaternion.x)
        .add(quaternion.y.mul(quaternion.y))
        .add(quaternion.z.mul(quaternion.z))
        .add(quaternion.w.mul(quaternion.w))
        .sqrt();
      const alignedQuaternion = context.adapter.select(
        quaternionLength.lessThan(0.000001),
        context.adapter.vec4(1, 0, 0, 0),
        quaternion.div(quaternionLength.clamp(0.000001, 1e20)),
      );
      const moving = speed.greaterThanEqual(0.000001);
      context.write(
        'rotation',
        context.adapter.select(moving, alignedQuaternion, context.attribute('rotation')),
      );
      const angle = context.adapter.atan2(velocity.x.mul(-1), velocity.y);
      context.write(
        'spriteRotation',
        context.adapter.select(moving, angle, context.attribute('spriteRotation')),
      );
    },
    stage: 'update',
    type: 'core/orient-to-velocity',
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
      writes: ['Particles.spriteRotation'],
    },
    build(context) {
      if (!context.module.lutId) throw new Error('rotationOverLife LUT is missing.');
      context.write(
        'spriteRotation',
        context.sampleLut(context.module.lutId, context.attribute('normalizedAge')).r,
      );
    },
    stage: 'update',
    type: 'core/rotation-over-life',
    version: 1,
  });
  registry.register({
    access: {
      reads: [
        'Emitter.deltaTime',
        'Particles.lifetime',
        'Particles.normalizedAge',
        'Particles.velocity',
      ],
      writes: ['Particles.velocity'],
    },
    build(context) {
      if (!context.module.lutId) throw new Error('velocityOverLife LUT is missing.');
      const normalizedAge = context.attribute('normalizedAge');
      const previousAge = normalizedAge
        .sub(
          context
            .uniform('Emitter.deltaTime')
            .div(context.attribute('lifetime').clamp(0.000001, 1e20)),
        )
        .clamp(0, 1);
      const currentScale = context.sampleLut(context.module.lutId, normalizedAge).r;
      const previousScale = context.sampleLut(context.module.lutId, previousAge).r;
      const scale = context.adapter.select(
        previousScale.mul(previousScale).greaterThanEqual(1e-12),
        currentScale.div(previousScale),
        currentScale,
      );
      context.write('velocity', context.attribute('velocity').mul(scale));
    },
    stage: 'update',
    type: 'core/velocity-over-life',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Particles.position'],
      writes: ['Particles.alive'],
    },
    build(context) {
      const config = context.module.config as KillVolumeOptions;
      const position = context.attribute('position');
      const local = context.adapter
        .inverse(context.uniform('Emitter.transform'))
        .mul(context.adapter.vec4(position.x, position.y, position.z, 1)).xyz;
      let inside: KernelNode;
      if (config.shape === 'sphere') {
        const center = context.value(config.center ?? [0, 0, 0], 'vec3', 1);
        const delta = context.adapter.vec3(
          local.x.sub(center.x),
          local.y.sub(center.y),
          local.z.sub(center.z),
        );
        const radius = context.value(config.radius, 'f32', 4);
        inside = delta.x
          .mul(delta.x)
          .add(delta.y.mul(delta.y))
          .add(delta.z.mul(delta.z))
          .lessThanEqual(radius.mul(radius));
      } else if (config.shape === 'box') {
        const center = context.value(config.center ?? [0, 0, 0], 'vec3', 1);
        const halfSize = context.value(config.size, 'vec3', 4).mul(0.5);
        const delta = context.adapter.vec3(
          local.x.sub(center.x),
          local.y.sub(center.y),
          local.z.sub(center.z),
        );
        inside = delta.x
          .mul(delta.x)
          .lessThanEqual(halfSize.x.mul(halfSize.x))
          .and(delta.y.mul(delta.y).lessThanEqual(halfSize.y.mul(halfSize.y)))
          .and(delta.z.mul(delta.z).lessThanEqual(halfSize.z.mul(halfSize.z)));
      } else {
        const basis = normalizedBasis(config.normal);
        const signed = local.x
          .mul(basis.up[0])
          .add(local.y.mul(basis.up[1]))
          .add(local.z.mul(basis.up[2]));
        inside = signed.lessThanEqual(context.value(config.offset ?? 0, 'f32', 1));
      }
      context.adapter.branch(config.mode === 'inside' ? inside : inside.not(), () => {
        context.write('alive', context.adapter.constant(false, 'bool'));
      });
    },
    stage: 'update',
    type: 'core/kill-volume',
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
      context.write(
        'position',
        context
          .attribute('position')
          .add(context.attribute('velocity').mul(context.uniform('Emitter.deltaTime'))),
      );
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
      'core/burst',
      'core/rate',
      'core/per-distance',
      'core/defaults',
      'core/age',
      'core/position-sphere',
      'core/position-mesh-surface',
      'core/velocity-cone',
      'core/velocity-mesh-normal',
      'core/lifetime',
      'core/gravity',
      'core/drag',
      'core/curl-noise',
      'core/vortex',
      'core/point-attractor',
      'core/linear-force',
      'core/turbulence',
      'core/vector-field',
      'core/collide-plane',
      'core/collide-sphere',
      'core/collide-box',
      'core/collide-scene-depth',
      'core/collide-sdf',
      'core/orient-to-velocity',
      'core/size-over-life',
      'core/rotation-over-life',
      'core/velocity-over-life',
      'core/kill-volume',
      'core/color-over-life',
      'core/integrate',
    ].map((type) => [type, registry.resolve(type, 1)?.access]),
  ) as Readonly<Record<string, ModuleAccess>>;
}
