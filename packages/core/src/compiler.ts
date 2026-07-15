import {
  resolveAttributeSchema,
  resolvePackedAttributeAddress,
  resolveTslBindingInputType,
  resolveTslStorageType,
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
} from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import { MAX_EMITTER_CAPACITY } from './limits.js';
import { neighborGridCellCount, validateNeighborGridDefinition } from './neighbor-grid.js';
import {
  collectCoreModuleConfigDiagnostics,
  collectEmitterOffsetDiagnostics,
} from './module-validation.js';
import { pcgRandomFloatNode, resolveModuleSlot, resolveRandomSampleSlot } from './random.js';
import {
  BUILT_IN_UNIFORM_DEFINITIONS,
  MATERIALIZED_PARAMETER_PATHS,
} from './uniform-definitions.js';
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
  LightRendererOptions,
  DecalRendererOptions,
  MeshRef,
  ModuleAccess,
  ModuleDefinition,
  ParameterGenerator,
  ParameterPath,
  ParameterSchema,
  RangeGenerator,
  ResolvedAttributeSchema,
  RenderModule,
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
  LinearForceOptions,
  NeighborGridDefinition,
  BoidsOptions,
  PbdDistanceConstraintOptions,
  NeighborGridTslFactory,
} from './types.js';

export const DEFAULT_LUT_RESOLUTION = 256;
export const DEFAULT_WORKGROUP_SIZE = 64;
let webgl2KernelResourceSequence = 0;
/** Measured peak magnitude of Three r185's centered snoise scalar. */
export const TURBULENCE_SIMPLEX_AMPLITUDE = 0.286;
/** Measured peak magnitude of the centered finite-difference simplex potential curl. */
export const CURL_SIMPLEX_DERIVATIVE_AMPLITUDE = 6;
export const CURL_NOISE_FINITE_DIFFERENCE = 0.1;
/** Calibrated by spike-depth for a visible but localized intersection transition. */
export const DEFAULT_SOFT_PARTICLE_FADE_DISTANCE = 0.035;
/** Bound keeps O(log^2 n) dispatch count and two padded storage buffers explicit. */
export const MAX_SORTED_PARTICLE_CAPACITY = 65_536;

/** Reserves four deterministic random samples for each compiler-authored attribute default. */
export function defaultAttributeSampleOffset(storageIndex: number): number {
  return storageIndex * 4;
}

/** CPU scalar mirror of one side of the symmetric PBD distance correction. */
export function pbdPairCorrection(distance: number, targetDistance: number): number {
  return (targetDistance - distance) * 0.5;
}

export interface BitonicSortPass {
  readonly blockSize: number;
  readonly compareDistance: number;
}

export function paddedSortCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('Sort capacity must be a positive safe integer.');
  }
  return 2 ** Math.ceil(Math.log2(capacity));
}

export function bitonicSortPasses(capacity: number): readonly BitonicSortPass[] {
  const padded = paddedSortCapacity(capacity);
  const passes: BitonicSortPass[] = [];
  for (let blockSize = 2; blockSize <= padded; blockSize *= 2) {
    for (let compareDistance = blockSize / 2; compareDistance >= 1; compareDistance /= 2) {
      passes.push({ blockSize, compareDistance });
    }
  }
  return passes;
}

/** CPU mirror of the GPU spawn-order reservation rule, used by lifecycle regression tests. */
export function clampSpawnOrderReservation(requested: number, freeCount: number): number {
  return Math.min(Math.max(0, requested), Math.max(0, freeCount));
}

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
      readonly defaultInitializeVaryingLimit: 4;
      readonly initializeVaryingCount: number;
      readonly initializeVaryings: readonly string[];
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
          readonly birthIndices: LifecycleStorageFieldMeta;
          readonly currentSpawnBase: LifecycleStorageFieldMeta;
          readonly freeCount: LifecycleStorageFieldMeta;
          readonly freeList: LifecycleStorageFieldMeta;
          readonly spawnOverflow: LifecycleStorageFieldMeta;
          readonly spawnSuccess: LifecycleStorageFieldMeta;
          readonly nextSpawnOrder: LifecycleStorageFieldMeta;
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
    readonly maxBufferSize?: number;
    readonly maxStorageBufferBindingSize?: number;
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
  /** Optional grid-stage operations; core diagnoses adapters that omit them before submission. */
  floor?(value: KernelNodeInput): KernelNode;
  instancedArray(length: number, type: TslStorageType): KernelStorageNode;
  indirectArray(values: Uint32Array): KernelIndirectStorageNode;
  inverse(value: KernelNode): KernelNode;
  mat4(
    column0: KernelNodeInput,
    column1: KernelNodeInput,
    column2: KernelNodeInput,
    column3: KernelNodeInput,
  ): KernelNode;
  /** Optional structured GPU loop; NeighborGrid scans require this on WebGPU. */
  loop?(
    range: {
      readonly end: number;
      readonly name?: string;
      readonly start: number;
      readonly type: 'int' | 'uint';
    },
    body: (index: KernelNode) => void,
  ): void;
  mod?(value: KernelNodeInput, divisor: KernelNodeInput): KernelNode;
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
  /** Spawn-order ring, independent from non-deterministic alive compaction. */
  readonly birthIndices: KernelStorageNode;
  readonly birthIndicesOffset: number;
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
  readonly nextSpawnOrderOffset: number;
  /** M1 all-slots compatibility kernel; never submit with the M2 lifecycle kernels. */
  readonly init: KernelComputeNode;
  /** Starts the M2 lifecycle path; mixing it with `init` leaves allocator counters inconsistent. */
  readonly initialize: KernelComputeNode;
  readonly luts: Readonly<Record<string, unknown>>;
  readonly neighborGrids: Readonly<Record<string, BuiltNeighborGridKernels>>;
  readonly prepareSpawn?: KernelComputeNode;
  readonly resetAliveCount?: KernelComputeNode;
  /** Initializes padded depth/index keys from the latest alive compaction. */
  readonly prepareSort?: KernelComputeNode;
  /**
   * One dispatch per bitonic (k,j) stage. Backends must submit each stage individually; multiple
   * dispatches within one compute pass provide no full-workgroup synchronization guarantee.
   */
  readonly sortPasses?: readonly KernelComputeNode[];
  readonly sortedDepths?: KernelStorageNode;
  readonly sortedIndices?: KernelStorageNode;
  readonly sortPaddedCapacity?: number;
  readonly spawn: KernelComputeNode;
  readonly spawnDispatch?: KernelIndirectStorageNode;
  readonly spawnOverflow: KernelStorageNode;
  readonly storages: Readonly<Record<string, KernelStorageNode>>;
  readonly uniforms: Readonly<Record<string, KernelUniformNode>>;
  readonly update: KernelComputeNode;
}

export interface BuiltNeighborGridKernels {
  readonly bucket: KernelComputeNode;
  readonly clear: KernelComputeNode;
  readonly counts: KernelStorageNode;
  readonly definition: NeighborGridDefinition;
  readonly pbdIterations: readonly KernelComputeNode[];
  readonly slots: KernelStorageNode;
  /** [dropped, outOfBounds] for the latest rebuild. */
  readonly stats: KernelStorageNode;
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
  readonly validate?: (context: KernelModuleValidationContext) => void;
  readonly version: number;
}

export interface SpawnModuleImplementation {
  readonly access: ModuleAccess;
  readonly stage: 'spawn';
  readonly type: string;
  readonly validate?: (context: KernelModuleValidationContext) => void;
  readonly version: number;
}

export interface KernelModuleValidationContext {
  readonly module: CompiledKernelModule | CompiledSpawnModule;
  readonly path: string;
  diagnostic(code: string, message: string, path?: string, severity?: 'error' | 'warning'): void;
}

export interface RenderModuleCompileContext {
  readonly capacity: number;
  /** Full emitter definition for package-owned cross-module consistency validation. */
  readonly definition: EmitterDefinition<AttributeSchema, ParameterSchema>;
  readonly indirect: CompiledDrawIndirectDescription;
  readonly module: RenderModule;
  readonly path: string;
  readonly schema: ResolvedAttributeSchema;
  diagnostic(code: string, message: string, path?: string, severity?: 'error' | 'warning'): void;
  vertex(
    attributes: readonly string[],
    options?: {
      readonly additionalStorageBuffers?: readonly string[];
      readonly lifecycle?: boolean;
    },
  ): CompiledDrawVertexDescription | undefined;
}

/** External packages register render compilation without moving their public definitions to core. */
export interface RenderModuleImplementation {
  readonly access: ModuleAccess;
  readonly compileDraw: (
    context: RenderModuleCompileContext,
  ) => CompiledDrawDescription | undefined;
  readonly stage: 'render';
  readonly type: string;
  readonly version: number;
}

export type CompilerModuleImplementation =
  | KernelModuleImplementation
  | RenderModuleImplementation
  | SpawnModuleImplementation;

export class KernelModuleRegistry {
  readonly #implementations = new Map<
    string,
    KernelModuleImplementation | SpawnModuleImplementation
  >();
  readonly #renderImplementations = new Map<string, RenderModuleImplementation>();

  register(implementation: CompilerModuleImplementation): void {
    const key = registryKey(implementation.type, implementation.version);
    if (implementation.stage === 'render') {
      const registered = this.#renderImplementations.get(key);
      if (registered !== undefined && registered !== implementation) {
        throw new Error(`Render module implementation ${key} is already registered.`);
      }
      this.#renderImplementations.set(key, implementation);
      return;
    }
    const registered = this.#implementations.get(key);
    if (registered !== undefined && registered !== implementation) {
      throw new Error(`Kernel module implementation ${key} is already registered.`);
    }
    this.#implementations.set(key, implementation);
  }

  resolve(
    type: string,
    version: number,
  ): KernelModuleImplementation | SpawnModuleImplementation | undefined {
    return this.#implementations.get(registryKey(type, version));
  }

  resolveRender(type: string, version: number): RenderModuleImplementation | undefined {
    return this.#renderImplementations.get(registryKey(type, version));
  }
}

export interface CompileEmitterOptions {
  readonly deltaTime?: number;
  readonly emitterSeed?: number;
  /** Event payload fields inherited by this emitter from effect-scoped emitTo() links. */
  readonly eventPayloadFields?: readonly string[];
  readonly registry?: KernelModuleRegistry;
  readonly neighborGrids?: Readonly<Record<string, NeighborGridDefinition>>;
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

/** Declaration-merging extension point used by renderer packages such as @nachi-vfx/trails. */
export interface CompiledDrawDescriptionMap {
  readonly billboard: CompiledSpriteDrawDescription;
  readonly decal: CompiledDecalDrawDescription;
  readonly light: CompiledLightDrawDescription;
  readonly mesh: CompiledMeshDrawDescription;
}

export type CompiledDrawDescription = CompiledDrawDescriptionMap[keyof CompiledDrawDescriptionMap];

export interface CompiledDrawIndirectDescription {
  readonly aliveIndicesOffsetWords: number;
  readonly drawArgumentsOffsetBytes: number;
  readonly instanceCount: 'alive-count';
  readonly physicalIndex: 'alive-indices' | 'sorted-indices';
  /** Power-of-two sort extent. Valid values occupy [paddedCapacity - aliveCount, end). */
  readonly sortedPaddedCapacity?: number;
}

export interface CompiledDrawVertexDescription {
  readonly attributes: readonly string[];
  readonly storageBufferCount: number;
  readonly storageBuffers: readonly string[];
}

export interface CompiledSpriteDrawDescription {
  readonly automaticRenderOrder: boolean;
  readonly coarseSortCenter: Vec3;
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
    readonly lit?: {
      readonly metalness: number;
      readonly normalMap?: TextureRef;
      readonly roughness: number;
    };
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
  readonly moduleVersion: number;
  readonly path: string;
  readonly renderOrderOffset: number;
  readonly vertex: CompiledDrawVertexDescription & {
    readonly alignment: NonNullable<BillboardOptions['alignment']>;
  };
}

export interface CompiledMeshDrawDescription {
  readonly automaticRenderOrder: boolean;
  readonly coarseSortCenter: Vec3;
  readonly fragment: { readonly blending: BlendingMode };
  readonly geometry: { readonly resource: GeometryRef; readonly topology: 'triangle-list' };
  readonly indirect: CompiledDrawIndirectDescription;
  readonly kind: 'mesh';
  readonly moduleVersion: number;
  readonly path: string;
  readonly renderOrderOffset: number;
  readonly vertex: CompiledDrawVertexDescription & {
    readonly alignment: NonNullable<MeshRendererOptions['alignment']>;
  };
}

export interface CompiledLightDrawDescription {
  readonly kind: 'light';
  readonly maxLights: number;
  readonly path: string;
  readonly priority: 'intensity' | 'intensity-radius';
  readonly radiusScale: number;
  readonly readback: {
    readonly latencyFrames: 1;
    readonly records: 'position-priority/color-intensity/radius-index-order';
  };
  readonly requiresBackend: 'webgpu';
  /** Compute selection bindings; named vertex for the common renderer budget surface. */
  readonly vertex: CompiledDrawVertexDescription;
}

export interface CompiledDecalDrawDescription {
  readonly automaticRenderOrder: boolean;
  readonly coarseSortCenter: Vec3;
  readonly fadeOverLife: boolean;
  readonly fragment: {
    readonly blending: 'alpha' | 'premultiplied';
    readonly map?: TextureRef;
  };
  readonly geometry: { readonly shape: 'projection-box'; readonly topology: 'triangle-list' };
  readonly indirect: CompiledDrawIndirectDescription;
  readonly kind: 'decal';
  readonly moduleVersion: number;
  readonly path: string;
  readonly renderOrderOffset: number;
  readonly requiresBackend: 'webgpu';
  readonly requiresSceneDepth: true;
  readonly sizeScale: number;
  readonly vertex: CompiledDrawVertexDescription;
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

const DECAL_SPAWN_ROTATION_MODULE: InitModule = {
  access: {
    reads: ['Emitter.spawnInterpolatedRotation'],
    writes: ['Particles.rotation'],
  },
  config: {},
  kind: 'module',
  label: '$decal-spawn-rotation',
  stage: 'init',
  type: 'core/decal-spawn-rotation',
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
  'Emitter.interpolationActive',
  'Emitter.previousTransform',
  'Emitter.seed',
  'Emitter.spawnCount',
  'Emitter.spawnGeneration',
  'Emitter.spawnInterpolatedTransform',
  'Emitter.spawnInterpolatedRotation',
  'Emitter.transform',
  'Emitter.updateInterpolatedTransform',
  'Emitter.updateRandomStep',
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
    allows: (module: WriteOwnershipModule) => module.source === 'compiler',
    matches: (path: DataReference) => path === 'Particles.spawnOrder',
    owner: 'spawn-order allocator',
    path: 'Particles.spawnOrder',
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
      `M7 batch 1 supports one render module per emitter; received ${renderModules.length}. Per-draw indirect argument slots remain a later M7 batch.`,
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

const tracedTslExpressions = new WeakSet<object>();

function isTslNodeLike(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (tracedTslExpressions.has(value)) return true;
  const candidate = value as { readonly getNodeType?: unknown; readonly isNode?: unknown };
  return candidate.isNode === true && typeof candidate.getNodeType === 'function';
}

function describeTslBindingInput(value: unknown): string {
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

function isPlainObject(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isInvalidTslBindingInput(value: unknown): boolean {
  if (isTslNodeLike(value)) return false;
  if (Array.isArray(value)) {
    return (
      value.every((component) => typeof component === 'number') &&
      resolveTslBindingInputType(value) === undefined
    );
  }
  return isPlainObject(value);
}

function traceExpression(
  onInvalidInput: (operation: string, index: number, value: unknown) => void,
  expressionPath: string,
): object {
  const callable = () => proxy;
  const proxy: object = new Proxy(callable, {
    apply: (_target, _thisArgument, arguments_) => {
      for (const [index, value] of arguments_.entries()) {
        if (isInvalidTslBindingInput(value)) {
          onInvalidInput(expressionPath, index, value);
        }
      }
      return proxy;
    },
    get: (_target, property) =>
      property === 'then'
        ? undefined
        : traceExpression(onInvalidInput, `${expressionPath}.${String(property)}`),
  });
  tracedTslExpressions.add(proxy);
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
        return traceExpression((operation, index, value) => {
          diagnostics.push(
            diagnostic(
              'NACHI_TSL_BINDING_INPUT_INVALID',
              `TSL binding operation input must be a supported literal, TSL node, or passthrough operation metadata; received ${describeTslBindingInput(value)}.`,
              `${path}.factory.${operation}[${index}]`,
            ),
          );
        }, property);
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
      reads.add(
        stage === 'spawn'
          ? 'Emitter.spawnGeneration'
          : stage === 'init'
            ? 'Particles.spawnOrder'
            : stage === 'update'
              ? 'Particles.spawnOrder'
              : 'Particles.spawnGeneration',
      );
      if (stage === 'update') reads.add('Emitter.updateRandomStep');
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

function withNeighborGridTransformRead<Stage extends ModuleDefinition['stage']>(
  module: ModuleDefinition<Stage, object>,
): ModuleDefinition<Stage, object> {
  if (
    module.type !== 'core/boids' &&
    module.type !== 'core/pbd-distance-constraint' &&
    module.type !== 'core/neighbor-grid-tsl'
  ) {
    return module;
  }
  const access = module.access ?? { reads: [], writes: [] };
  if (access.reads.includes('Emitter.transform')) return module;
  // Pre-H2-5 v1 documents serialized the old built-in access manifests. Compilation supplements
  // the new implementation read without mutating the loaded definition or its round-trip JSON.
  return withAccess(module, {
    ...access,
    reads: [...access.reads, 'Emitter.transform'],
  });
}

const UPDATE_INTERPOLATED_TRANSFORM_MODULES = new Set([
  'core/collide-box',
  'core/collide-plane',
  'core/collide-sphere',
  'core/kill-volume',
  'core/linear-force',
  'core/point-attractor',
  'core/vortex',
]);

function withUpdateInterpolatedTransformRead<Stage extends ModuleDefinition['stage']>(
  module: ModuleDefinition<Stage, object>,
): ModuleDefinition<Stage, object> {
  if (module.version < 2) return module;
  const path =
    module.type === 'core/velocity-cone'
      ? ('Emitter.spawnInterpolatedTransform' as const)
      : UPDATE_INTERPOLATED_TRANSFORM_MODULES.has(module.type)
        ? ('Emitter.updateInterpolatedTransform' as const)
        : undefined;
  if (path === undefined) return module;
  const access = module.access ?? { reads: [], writes: [] };
  if (access.reads.includes(path)) return module;
  // H2-6 v2 documents may retain a pre-normalized access manifest. The compiler supplements the
  // relevant virtual interpolated-transform dependency without mutating the loaded round-trip.
  return withAccess(module, {
    ...access,
    reads: [...access.reads, path],
  });
}

function defaultsModule(schema: ResolvedAttributeSchema): InitModule {
  const config = {
    attributes: schema.attributes
      .filter(({ name }) => name !== 'alive' && name !== 'spawnGeneration' && name !== 'spawnOrder')
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
      if (module.type === 'core/neighbor-grid-tsl') {
        const path = `${stage}[${index}]`;
        const factory = (
          module as ModuleDefinition<Stage, object> & {
            readonly factory?: NeighborGridTslFactory;
          }
        ).factory;
        if (factory) factories.set(path, factory as unknown as TslModuleFactory);
        else
          diagnostics.push(
            diagnostic(
              'NACHI_NEIGHBOR_GRID_FACTORY_UNRESOLVED',
              'Inline NeighborGrid TSL factory metadata is unavailable.',
              `${path}.factory`,
            ),
          );
        return withDerivedConfigReads(
          withUpdateInterpolatedTransformRead(withNeighborGridTransformRead(module)),
        );
      }
      if (module.type !== 'core/tsl-module') {
        return withDerivedConfigReads(
          withUpdateInterpolatedTransformRead(withNeighborGridTransformRead(module)),
        );
      }
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
          'core/pbd-distance-constraint',
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
  implementation.validate?.({
    diagnostic: (code, message, diagnosticPath = module.path, severity = 'error') => {
      diagnostics.push(diagnostic(code, message, diagnosticPath, severity));
    },
    module,
    path: module.path,
  });
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
    const configDiagnostics = collectCoreModuleConfigDiagnostics(
      module.type,
      module.config as Readonly<Record<string, unknown>>,
      `${module.path}.config`,
    );
    diagnostics.push(...configDiagnostics);
    if (module.type === 'core/burst') {
      const config = module.config as { count?: unknown };
      if (typeof config.count === 'object' && config.count !== null && 'kind' in config.count) {
        if (config.count.kind === 'parameter') {
          const generator = config.count as { fallback?: unknown; path?: unknown };
          const parameterDefinition =
            typeof generator.path === 'string'
              ? parameters?.[generator.path as ParameterPath]
              : undefined;
          if (
            parameterDefinition === undefined ||
            !(['f32', 'i32', 'u32'] as const).includes(
              parameterDefinition.type as 'f32' | 'i32' | 'u32',
            )
          ) {
            const parameterDiagnostic = diagnostic(
              'NACHI_BURST_COUNT_INVALID',
              'Burst count must be a non-negative finite number or a valid range/parameter generator.',
              `${module.path}.config.count`,
            );
            if (
              !configDiagnostics.some(
                (candidate) =>
                  candidate.code === parameterDiagnostic.code &&
                  candidate.path === parameterDiagnostic.path &&
                  candidate.message === parameterDiagnostic.message,
              )
            ) {
              diagnostics.push(parameterDiagnostic);
            }
          }
        }
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
  const defaultOverrides = new Map<ParameterPath, unknown>([
    ['System.deltaTime', options.deltaTime ?? 1 / 60],
    ['Emitter.deltaTime', options.deltaTime ?? 1 / 60],
    ['Emitter.seed', options.emitterSeed ?? 0],
    ['Emitter.spawnGeneration', options.spawnGeneration ?? 0],
  ]);
  const uniforms: CompiledUniformDescription[] = BUILT_IN_UNIFORM_DEFINITIONS.map(
    ({ default: defaultValue, path, type }) =>
      describe(path, defaultOverrides.get(path) ?? defaultValue, type),
  );
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
    hex.length === 3 || hex.length === 4
      ? [...hex].map((character) => character.repeat(2)).join('')
      : hex;
  if (!/^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(expanded)) {
    throw new Error(`Unsupported color "${input}". Expected #RGB, #RRGGBB, #RGBA, or #RRGGBBAA.`);
  }
  const srgbToLinear = (channel: number): number =>
    channel < 0.04045 ? channel * 0.0773993808 : (channel * 0.9478672986 + 0.0521327014) ** 2.4;
  return [
    srgbToLinear(Number.parseInt(expanded.slice(0, 2), 16) / 255),
    srgbToLinear(Number.parseInt(expanded.slice(2, 4), 16) / 255),
    srgbToLinear(Number.parseInt(expanded.slice(4, 6), 16) / 255),
    expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
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
  if (!Number.isSafeInteger(width) || width < 2) {
    throw new RangeError('Curve LUT width must be a safe integer of at least 2.');
  }
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
  if (!Number.isSafeInteger(width) || width < 2) {
    throw new RangeError('Gradient LUT width must be a safe integer of at least 2.');
  }
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
        module.type === 'core/intensity-over-life' ||
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

function lifecycleStorageLayout(capacity: number, hasSpawnOrder: boolean) {
  const indirectFields = {
    spawnDispatch: { offsetWords: 0, wordCount: 3 },
    drawIndirect: { offsetWords: 3, wordCount: 5 },
  } as const;
  const indirectWordCount =
    indirectFields.drawIndirect.offsetWords + indirectFields.drawIndirect.wordCount;
  const orderWords = hasSpawnOrder ? 2 : 0;
  const indexBase = 4 + orderWords;
  const stateFields = {
    freeCount: { offsetWords: 0, wordCount: 1 },
    aliveCount: { offsetWords: 1, wordCount: 1 },
    spawnSuccess: { offsetWords: 2, wordCount: 1 },
    spawnOverflow: { offsetWords: 3, wordCount: 1 },
    nextSpawnOrder: { offsetWords: 4, wordCount: hasSpawnOrder ? 1 : 0 },
    currentSpawnBase: { offsetWords: 5, wordCount: hasSpawnOrder ? 1 : 0 },
    freeList: { offsetWords: indexBase, wordCount: capacity },
    aliveIndices: { offsetWords: indexBase + capacity, wordCount: capacity },
    birthIndices: {
      offsetWords: indexBase + capacity * 2,
      wordCount: hasSpawnOrder ? capacity : 0,
    },
  } as const;
  const stateWordCount = stateFields.birthIndices.offsetWords + stateFields.birthIndices.wordCount;
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
    if (module.version !== 1 && module.version !== 2) {
      diagnostics.push(
        diagnostic(
          'NACHI_MODULE_UNKNOWN',
          `No renderer implementation is registered for ${module.type}@${module.version}.`,
          path,
        ),
      );
      continue;
    }
    const options = module.config as BillboardOptions;
    diagnostics.push(
      ...collectCoreModuleConfigDiagnostics(
        module.type,
        module.config as Readonly<Record<string, unknown>>,
        `${path}.config`,
        module.version,
      ),
    );
    const blending = options.blending ?? 'alpha';
    const sorted =
      options.sorted === true ||
      (options.sorted === undefined &&
        module.version === 2 &&
        (blending === 'alpha' || blending === 'premultiplied'));
    const coarseSortCenter = options.sortCenter ?? ([0, 0, 0] as const);
    if (sorted && definition.capacity > MAX_SORTED_PARTICLE_CAPACITY) {
      diagnostics.push(
        diagnostic(
          'NACHI_PARTICLE_SORT_CAPACITY_EXCEEDED',
          `Sorted particle capacity ${definition.capacity} exceeds the WebGPU limit ${MAX_SORTED_PARTICLE_CAPACITY}.`,
          `${path}.config.sorted`,
        ),
      );
    }
    const alignment = options.alignment ?? { mode: 'camera-facing' as const };
    const cutoutVertices = options.cutout?.vertices ?? 4;
    const flipbook = options.map?.kind === 'flipbook' ? options.map : undefined;
    const litOptions = typeof options.lit === 'object' ? options.lit : undefined;
    const lit = options.lit
      ? {
          metalness: litOptions?.metalness ?? 0,
          ...(litOptions?.normalMap === undefined ? {} : { normalMap: litOptions.normalMap }),
          roughness: litOptions?.roughness ?? 0.8,
        }
      : undefined;
    const softFadeDistance =
      options.soft === true
        ? DEFAULT_SOFT_PARTICLE_FADE_DISTANCE
        : typeof options.soft === 'object'
          ? options.soft.fadeDistance
          : undefined;
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
    const vertexStorageBuffers = [
      ...attributeBuffers,
      'NachiLifecycleState',
      ...(sorted ? ['NachiSortedIndices'] : []),
    ];
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
      automaticRenderOrder: blending === 'alpha' || blending === 'premultiplied',
      coarseSortCenter,
      fragment: {
        blending,
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
        ...(lit === undefined ? {} : { lit }),
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
        physicalIndex: sorted ? 'sorted-indices' : 'alive-indices',
        ...(sorted ? { sortedPaddedCapacity: paddedSortCapacity(definition.capacity) } : {}),
      },
      kind: 'billboard',
      moduleVersion: module.version,
      path,
      renderOrderOffset: module.version === 2 ? (options.renderOrderOffset ?? 0) : 0,
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
    if (module.version !== 1 && module.version !== 2) {
      diagnostics.push(
        diagnostic(
          'NACHI_MODULE_UNKNOWN',
          `No renderer implementation is registered for ${module.type}@${module.version}.`,
          path,
        ),
      );
      continue;
    }
    const options = module.config as MeshRendererOptions;
    diagnostics.push(
      ...collectCoreModuleConfigDiagnostics(
        module.type,
        module.config as Readonly<Record<string, unknown>>,
        `${path}.config`,
        module.version,
      ),
    );
    const blending = options.blending ?? 'alpha';
    const sorted =
      options.sorted === true ||
      (options.sorted === undefined &&
        module.version === 2 &&
        (blending === 'alpha' || blending === 'premultiplied'));
    const coarseSortCenter = options.sortCenter ?? ([0, 0, 0] as const);
    if (sorted && definition.capacity > MAX_SORTED_PARTICLE_CAPACITY) {
      diagnostics.push(
        diagnostic(
          'NACHI_PARTICLE_SORT_CAPACITY_EXCEEDED',
          `Sorted particle capacity ${definition.capacity} exceeds the WebGPU limit ${MAX_SORTED_PARTICLE_CAPACITY}.`,
          `${path}.config.sorted`,
        ),
      );
    }
    const alignment = options.alignment ?? { mode: 'none' as const };
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
    const vertexStorageBuffers = [
      ...attributeBuffers,
      'NachiLifecycleState',
      ...(sorted ? ['NachiSortedIndices'] : []),
    ];
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
      automaticRenderOrder: blending === 'alpha' || blending === 'premultiplied',
      coarseSortCenter,
      fragment: { blending },
      geometry: { resource: options.geometry, topology: 'triangle-list' },
      indirect: {
        aliveIndicesOffsetWords: lifecycleLayout.buffers.state.fields.aliveIndices.offsetWords,
        drawArgumentsOffsetBytes:
          lifecycleLayout.buffers.indirectArguments.fields.drawIndirect.offsetWords *
          Uint32Array.BYTES_PER_ELEMENT,
        instanceCount: 'alive-count',
        physicalIndex: sorted ? 'sorted-indices' : 'alive-indices',
        ...(sorted ? { sortedPaddedCapacity: paddedSortCapacity(definition.capacity) } : {}),
      },
      kind: 'mesh',
      moduleVersion: module.version,
      path,
      renderOrderOffset: module.version === 2 ? (options.renderOrderOffset ?? 0) : 0,
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

function compileRegisteredDraws(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  lifecycleLayout: ReturnType<typeof lifecycleStorageLayout>,
  registry: KernelModuleRegistry,
  diagnostics: VfxDiagnostic[],
): CompiledDrawDescription[] {
  const draws: CompiledDrawDescription[] = [];
  for (const { module, path } of collectEmitterModules(definition)) {
    if (
      module.stage !== 'render' ||
      module.type === 'core/billboard' ||
      module.type === 'core/mesh-renderer'
    ) {
      continue;
    }
    const implementation = registry.resolveRender(module.type, module.version);
    // Core historically permits opaque render modules so renderer-specific integrations can
    // inspect them independently. Registered packages opt into compiled draw descriptions here.
    if (!implementation) continue;
    if (
      !includesImplementationAccess(
        module.access ?? { reads: [], writes: [] },
        implementation.access,
      )
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_MODULE_ACCESS_MISMATCH',
          `Render module ${module.type} access does not include its implementation reads and writes.`,
          `${path}.access`,
        ),
      );
      continue;
    }
    const indirect: CompiledDrawIndirectDescription = {
      aliveIndicesOffsetWords: lifecycleLayout.buffers.state.fields.aliveIndices.offsetWords,
      drawArgumentsOffsetBytes:
        lifecycleLayout.buffers.indirectArguments.fields.drawIndirect.offsetWords *
        Uint32Array.BYTES_PER_ELEMENT,
      instanceCount: 'alive-count',
      physicalIndex: 'alive-indices',
    };
    const context: RenderModuleCompileContext = {
      capacity: definition.capacity,
      definition,
      diagnostic: (code, message, diagnosticPath = path, severity = 'error') => {
        diagnostics.push(diagnostic(code, message, diagnosticPath, severity));
      },
      indirect,
      module: module as RenderModule,
      path,
      schema,
      vertex: (attributes, vertexOptions = {}) => {
        if (attributes.some((name) => schema.byName[name] === undefined)) return undefined;
        const attributeBuffers = [
          ...new Set(
            attributes.map((name) => {
              const attribute = schema.byName[name];
              const storage =
                attribute === undefined
                  ? undefined
                  : schema.storageArrays[attribute.physical.bufferIndex];
              if (!attribute || !storage) {
                throw new Error(`Render attribute "${name}" has no physical storage.`);
              }
              return `Particles.${storage.name}`;
            }),
          ),
        ];
        const storageBuffers = [
          ...attributeBuffers,
          ...(vertexOptions.additionalStorageBuffers ?? []),
          ...(vertexOptions.lifecycle === false ? [] : ['NachiLifecycleState']),
        ];
        if (storageBuffers.length > 8) {
          diagnostics.push(
            diagnostic(
              'NACHI_STORAGE_BUFFER_LIMIT',
              `Render vertex stage requires ${storageBuffers.length} storage buffers (${storageBuffers.join(', ')}), exceeding the default limit of 8.`,
              `${path}.vertex.storageBufferCount`,
            ),
          );
        }
        return {
          attributes,
          storageBufferCount: storageBuffers.length,
          storageBuffers,
        };
      },
    };
    const draw = implementation.compileDraw(context);
    if (draw) draws.push(draw);
  }
  return draws;
}

function rendererAttributeBuffers(
  schema: ResolvedAttributeSchema,
  attributes: readonly string[],
): string[] | undefined {
  if (attributes.some((name) => schema.byName[name] === undefined)) return undefined;
  return [
    ...new Set(
      attributes.map((name) => {
        const attribute = schema.byName[name];
        const storage =
          attribute === undefined
            ? undefined
            : schema.storageArrays[attribute.physical.bufferIndex];
        if (!attribute || !storage) {
          throw new Error(`Render attribute "${name}" has no physical storage.`);
        }
        return `Particles.${storage.name}`;
      }),
    ),
  ];
}

function validateRendererStorageBudget(
  buffers: readonly string[],
  path: string,
  label: string,
  diagnostics: VfxDiagnostic[],
): void {
  if (buffers.length <= 8) return;
  diagnostics.push(
    diagnostic(
      'NACHI_STORAGE_BUFFER_LIMIT',
      `${label} requires ${buffers.length} storage buffers (${buffers.join(', ')}), exceeding the default limit of 8.`,
      `${path}.vertex.storageBufferCount`,
    ),
  );
}

function compileLightDraws(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  diagnostics: VfxDiagnostic[],
): CompiledLightDrawDescription[] {
  const draws: CompiledLightDrawDescription[] = [];
  for (const { module, path } of collectEmitterModules(definition)) {
    if (module.stage !== 'render' || module.type !== 'core/light-renderer') continue;
    const options = module.config as LightRendererOptions;
    const configDiagnostics = collectCoreModuleConfigDiagnostics(
      module.type,
      module.config as Readonly<Record<string, unknown>>,
      `${path}.config`,
      module.version,
    );
    diagnostics.push(...configDiagnostics);
    const maxLights = options.maxLights ?? 8;
    const radiusScale = options.radiusScale ?? 1;
    if (configDiagnostics.some(({ severity }) => severity === 'error')) continue;
    const attributes = ['alive', 'color', 'intensity', 'position', 'size', 'spawnOrder'];
    const storageBuffers = rendererAttributeBuffers(schema, attributes);
    if (!storageBuffers) continue;
    // The selector scans physical attributes directly and owns one output buffer. It never binds
    // lifecycle state in this compute stage.
    const selectionBuffers = [...storageBuffers, 'NachiLightSelection'];
    validateRendererStorageBudget(
      selectionBuffers,
      path,
      'Light selection compute stage',
      diagnostics,
    );
    draws.push({
      kind: 'light',
      maxLights,
      path,
      priority: options.priority ?? 'intensity',
      radiusScale,
      readback: {
        latencyFrames: 1,
        records: 'position-priority/color-intensity/radius-index-order',
      },
      requiresBackend: 'webgpu',
      vertex: {
        attributes,
        storageBufferCount: selectionBuffers.length,
        storageBuffers: selectionBuffers,
      },
    });
  }
  return draws;
}

function compileDecalDraws(
  definition: EmitterDefinition<AttributeSchema, ParameterSchema>,
  schema: ResolvedAttributeSchema,
  lifecycleLayout: ReturnType<typeof lifecycleStorageLayout>,
  diagnostics: VfxDiagnostic[],
): CompiledDecalDrawDescription[] {
  const draws: CompiledDecalDrawDescription[] = [];
  for (const { module, path } of collectEmitterModules(definition)) {
    if (module.stage !== 'render' || module.type !== 'core/decal-renderer') continue;
    if (module.version !== 1 && module.version !== 2) {
      diagnostics.push(
        diagnostic(
          'NACHI_MODULE_UNKNOWN',
          `No renderer implementation is registered for ${module.type}@${module.version}.`,
          path,
        ),
      );
      continue;
    }
    const options = module.config as DecalRendererOptions;
    const configDiagnostics = collectCoreModuleConfigDiagnostics(
      module.type,
      module.config as Readonly<Record<string, unknown>>,
      `${path}.config`,
      module.version,
    );
    diagnostics.push(...configDiagnostics);
    const sizeScale = options.sizeScale ?? 1;
    const sorted = module.version === 2 ? (options.sorted ?? true) : false;
    if (sorted && definition.capacity > MAX_SORTED_PARTICLE_CAPACITY) {
      diagnostics.push(
        diagnostic(
          'NACHI_PARTICLE_SORT_CAPACITY_EXCEEDED',
          `Sorted particle capacity ${definition.capacity} exceeds the WebGPU limit ${MAX_SORTED_PARTICLE_CAPACITY}.`,
          `${path}.config.sorted`,
        ),
      );
    }
    if (configDiagnostics.some(({ severity }) => severity === 'error')) continue;
    const attributes = ['color', 'normalizedAge', 'position', 'rotation', 'size'];
    const attributeBuffers = rendererAttributeBuffers(schema, attributes);
    if (!attributeBuffers) continue;
    const storageBuffers = [
      ...attributeBuffers,
      'NachiLifecycleState',
      ...(sorted ? ['NachiSortedIndices'] : []),
    ];
    validateRendererStorageBudget(storageBuffers, path, 'Decal vertex stage', diagnostics);
    draws.push({
      automaticRenderOrder: module.version === 2,
      coarseSortCenter:
        module.version === 2 ? (options.sortCenter ?? ([0, 0, 0] as const)) : [0, 0, 0],
      fadeOverLife: options.fadeOverLife ?? true,
      fragment: {
        blending: options.blending ?? 'alpha',
        ...(options.map === undefined ? {} : { map: options.map }),
      },
      geometry: { shape: 'projection-box', topology: 'triangle-list' },
      indirect: {
        aliveIndicesOffsetWords: lifecycleLayout.buffers.state.fields.aliveIndices.offsetWords,
        drawArgumentsOffsetBytes:
          lifecycleLayout.buffers.indirectArguments.fields.drawIndirect.offsetWords *
          Uint32Array.BYTES_PER_ELEMENT,
        instanceCount: 'alive-count',
        physicalIndex: sorted ? 'sorted-indices' : 'alive-indices',
        ...(sorted ? { sortedPaddedCapacity: paddedSortCapacity(definition.capacity) } : {}),
      },
      kind: 'decal',
      moduleVersion: module.version,
      path,
      renderOrderOffset: module.version === 2 ? (options.renderOrderOffset ?? 0) : 0,
      requiresBackend: 'webgpu',
      requiresSceneDepth: true,
      sizeScale,
      vertex: {
        attributes,
        storageBufferCount: storageBuffers.length,
        storageBuffers,
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
  neighborGridDefinitions: Readonly<Record<string, NeighborGridDefinition>>,
): (adapter: KernelTslAdapter, options?: BuildEmitterKernelOptions) => BuiltEmitterKernels {
  return (adapter, options = {}) => {
    const buildDiagnostics = [...program.diagnostics];
    const backend = adapter.capabilities.backend;
    // Three r185 caches WebGL fallback ProgrammableStage objects by shader source, while each
    // stage retains the transform-feedback attribute nodes from its first materialization. Embed
    // an algebraic no-op identity in each WebGL2 kernel so otherwise-identical emitter programs
    // cannot reuse a stage bound to another instance's dual buffers.
    const webgl2ResourceIdentity =
      backend === 'webgl2' ? ++webgl2KernelResourceSequence : undefined;
    const resourceSuffix =
      webgl2ResourceIdentity === undefined ? '' : `_WebGL2_${webgl2ResourceIdentity}`;
    const resourceName = (name: string) => `${name}${resourceSuffix}`;
    const kernelInstanceIndex = (): KernelNode => {
      const index = adapter.uint(adapter.instanceIndex);
      if (webgl2ResourceIdentity === undefined) return index;
      const identity = adapter.uint(adapter.constant(webgl2ResourceIdentity, 'u32'));
      return index.bitXor(identity).bitXor(identity);
    };
    if (backend === 'webgl2') {
      const kernelAttributeAccesses = new Set(
        [
          ...program.spawn.modules,
          ...program.kernels.init.modules.filter(({ type }) => type !== 'core/defaults'),
          ...program.kernels.update.modules,
        ]
          .flatMap(({ access }) => [
            ...access.reads,
            ...(access.optionalReads ?? []),
            ...access.writes,
          ])
          .filter((path) => path.startsWith('Particles.')),
      );
      for (const storage of program.attributeSchema.storageArrays) {
        if (!storage.packed || storage.groupCount <= 1) continue;
        const usedHigherGroups = storage.attributes.flatMap((name) => {
          const attribute = program.attributeSchema.byName[name];
          return attribute &&
            attribute.physical.group > 0 &&
            kernelAttributeAccesses.has(attribute.path)
            ? [{ group: attribute.physical.group, name }]
            : [];
        });
        // The compiler-authored defaults module mirrors every allocated attribute and therefore
        // only proves that the packed storage exists. Reject when a behavioral kernel actually
        // addresses a higher group, which is where Three r185 TF aliases the destination to group 0.
        if (usedHigherGroups.length === 0) continue;
        const accesses = usedHigherGroups
          .map(({ group, name }) => `${name} (group ${group})`)
          .join(', ');
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED',
          hint: 'Use the WebGPU backend or declare attributes in dedicated physical storage.',
          message: `WebGL2 transform feedback cannot preserve packed storage Particles.${storage.name} when kernel access reaches ${accesses}; higher element groups would alias group 0.`,
          path: `attributeSchema.storageArrays.${storage.index}.groupCount`,
          phase: 'compile',
          severity: 'error',
        });
      }
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
        program.meta.backendBudgets.webgl2.defaultInitializeVaryingLimit;
      if (program.meta.backendBudgets.webgl2.initializeVaryingCount > varyingLimit) {
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use the WebGPU backend. WebGL2 lifecycle spawning will be revisited with a packed transform-feedback layout.',
          message: `WebGL2 initialize writes ${program.meta.backendBudgets.webgl2.initializeVaryingCount} physical transform-feedback varyings (${program.meta.backendBudgets.webgl2.initializeVaryings.join(', ')}), but the backend limit is ${varyingLimit}.`,
          path: 'meta.backendBudgets.webgl2.initializeVaryingCount',
          phase: 'compile',
          severity: 'error',
        });
      }
      for (const storage of program.attributeSchema.storageArrays) {
        const components = TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type];
        if (components <= 4) continue;
        const attribute =
          storage.attributes.length === 1
            ? program.attributeSchema.byName[storage.attributes[0]!]
            : undefined;
        buildDiagnostics.push({
          code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
          hint: 'Use the WebGPU backend. WebGL2 SEPARATE_ATTRIBS varyings may contain at most four components.',
          message: `WebGL2 initialize varying Particles.${storage.name} has ${components} physical components (${storage.type}), exceeding the per-varying SEPARATE_ATTRIBS limit of 4.`,
          path: attribute
            ? `attributeSchema.byName.${attribute.name}.components`
            : `attributeSchema.storageArrays.${storage.index}.type`,
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
    const decalDraw = program.draws.find(
      (draw): draw is CompiledDecalDrawDescription => draw.kind === 'decal',
    );
    if (decalDraw) {
      if (backend === 'webgl2') {
        buildDiagnostics.push({
          code: 'NACHI_DECAL_WEBGL2_UNSUPPORTED',
          hint: 'Use the WebGPU backend for particle projection decals.',
          message:
            'The decal renderer requires WebGPU storage-buffer instancing and depth reconstruction.',
          path: decalDraw.path,
          phase: 'compile',
          severity: 'error',
        });
      }
      if (adapter.capabilities.sceneDepth !== true || adapter.sampleSceneDepth === undefined) {
        buildDiagnostics.push({
          code: 'NACHI_DECAL_SCENE_DEPTH_UNAVAILABLE',
          hint: 'Bind the M6 previous-frame linear float depth copy through the renderer adapter.',
          message:
            'The decal renderer requires an explicit sampleable previous-frame scene-depth texture.',
          path: decalDraw.path,
          phase: 'compile',
          severity: 'error',
        });
      }
      if ((adapter.capabilities.sceneDepthSampleCount ?? 1) > 1) {
        buildDiagnostics.push({
          code: 'NACHI_DECAL_DEPTH_MSAA_UNSUPPORTED',
          hint: 'Resolve and copy scene depth into a single-sample linear float texture.',
          message: 'The decal renderer cannot reconstruct from an MSAA depth source.',
          path: decalDraw.path,
          phase: 'compile',
          severity: 'error',
        });
      }
    }
    const lightDraw = program.draws.find(
      (draw): draw is CompiledLightDrawDescription => draw.kind === 'light',
    );
    if (lightDraw && backend === 'webgl2') {
      buildDiagnostics.push({
        code: 'NACHI_LIGHT_WEBGL2_UNSUPPORTED',
        hint: 'Use the WebGPU backend for GPU top-N light selection.',
        message: 'The light renderer requires WebGPU storage selection before bounded readback.',
        path: lightDraw.path,
        phase: 'compile',
        severity: 'error',
      });
    }
    const sortedDrawForBackend = program.draws.find(
      (draw) => 'indirect' in draw && draw.indirect.physicalIndex === 'sorted-indices',
    );
    if (sortedDrawForBackend && backend === 'webgl2') {
      buildDiagnostics.push({
        code: 'NACHI_PARTICLE_SORT_WEBGL2_UNSUPPORTED',
        hint: 'Use WebGPU or disable the render module sorted option.',
        message:
          'GPU bitonic particle sorting requires WebGPU storage buffers and ordered compute dispatches.',
        path: sortedDrawForBackend.path,
        phase: 'compile',
        severity: 'error',
      });
    }
    if (Object.keys(neighborGridDefinitions).length > 0) {
      if (backend !== 'webgpu') {
        buildDiagnostics.push({
          code: 'NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED',
          message:
            'NeighborGrid requires WebGPU atomics and arbitrary indexed storage reads; WebGL2 transform feedback is unsupported.',
          path: 'neighbor-grid',
          phase: 'compile',
          severity: 'error',
        });
      }
      if (!adapter.floor || !adapter.loop) {
        const missing = [!adapter.floor ? 'floor' : undefined, !adapter.loop ? 'loop' : undefined]
          .filter((operation): operation is string => operation !== undefined)
          .join(', ');
        buildDiagnostics.push({
          code: 'NACHI_NEIGHBOR_GRID_ADAPTER_UNSUPPORTED',
          message: `NeighborGrid requires ${missing} support from the pinned TSL adapter.`,
          path: 'neighbor-grid',
          phase: 'compile',
          severity: 'error',
        });
      }
      for (const [key, definition] of Object.entries(neighborGridDefinitions)) {
        try {
          validateNeighborGridDefinition(definition);
          const cells = neighborGridCellCount(definition.resolution);
          const largestBuffer = Math.max(
            cells * definition.cellCapacity * Uint32Array.BYTES_PER_ELEMENT,
            program.attributeSchema.capacity * 16,
          );
          const activeLimits = [
            adapter.deviceLimits?.maxStorageBufferBindingSize,
            adapter.deviceLimits?.maxBufferSize,
          ].filter((value): value is number => value !== undefined);
          const allocationLimit = activeLimits.length > 0 ? Math.min(...activeLimits) : undefined;
          if (allocationLimit !== undefined && largestBuffer > allocationLimit) {
            buildDiagnostics.push({
              code: 'NACHI_NEIGHBOR_GRID_STORAGE_LIMIT_EXCEEDED',
              message: `NeighborGrid "${key}" requires a ${largestBuffer}-byte storage binding, exceeding the active device buffer limit ${allocationLimit}.`,
              path: `neighborGrids.${key}.cellCapacity`,
              phase: 'compile',
              severity: 'error',
            });
          }
        } catch (error) {
          if (error instanceof VfxDiagnosticError) {
            buildDiagnostics.push(
              ...error.diagnostics.map((diagnostic) => ({
                ...diagnostic,
                path: `neighborGrids.${key}.${diagnostic.path ?? ''}`,
              })),
            );
          } else throw error;
        }
      }
    }
    const storageBufferLimit = adapter.deviceLimits?.maxStorageBuffersPerShaderStage;
    // Incoming queues are effect-owned and therefore absent from standalone emitter meta. Event
    // spawn reads one source state buffer and one payload buffer in addition to target resources.
    const materializedStorageBufferCount = Math.max(
      program.meta.storageBufferCount + ((options.eventInputs?.length ?? 0) > 0 ? 2 : 0),
      program.attributeSchema.storageArrays.length +
        Object.keys(neighborGridDefinitions).length * 5,
    );
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
        .setName(resourceName(`NachiParticles_${storage.name}`)),
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
    const hasSpawnOrder = program.attributeSchema.byName.spawnOrder !== undefined;
    const lifecycleLayout = lifecycleStorageLayout(capacity, hasSpawnOrder);
    const indirectLayout = lifecycleLayout.buffers.indirectArguments;
    const stateLayout = lifecycleLayout.buffers.state;
    const lifecycleIndirectStorage = gpuLifecycle
      ? adapter
          .indirectArray(new Uint32Array(indirectLayout.wordCount))
          .setName('NachiLifecycleIndirectArguments')
      : undefined;
    const lifecycleBase = adapter.instancedArray(stateLayout.wordCount, 'uint');
    const lifecycleStorage = (gpuLifecycle ? lifecycleBase.toAtomic() : lifecycleBase).setName(
      resourceName('NachiLifecycleState'),
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
    const isolateWebglComputeStage = (): void => {
      if (webgl2ResourceIdentity === undefined) return;
      const rawIndex = adapter.uint(adapter.instanceIndex);
      const isolatedIndex = kernelInstanceIndex();
      // The self-store is semantically neutral, but keeps the per-materialization identity in the
      // emitted GLSL even when WebGL lowers indexed storage access to the current vertex varying.
      adapter.branch(isolatedIndex.equal(rawIndex), () => {
        writeAttribute('alive', attributeNode('alive', rawIndex), rawIndex);
      });
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
    const mutable = (value: KernelNode): KernelNode =>
      (value as KernelNode & { toVar?(): KernelNode }).toVar?.() ?? value;
    const quaternionLength = (value: KernelNode): KernelNode =>
      value.x
        .mul(value.x)
        .add(value.y.mul(value.y))
        .add(value.z.mul(value.z))
        .add(value.w.mul(value.w))
        .sqrt();
    const normalizedQuaternion = (value: KernelNode): KernelNode =>
      value.div(quaternionLength(value).clamp(0.000001, 1e20));
    const slerpQuaternion = (
      previous: KernelNode,
      current: KernelNode,
      phase: KernelNode,
    ): KernelNode => {
      const rawDot = previous.x
        .mul(current.x)
        .add(previous.y.mul(current.y))
        .add(previous.z.mul(current.z))
        .add(previous.w.mul(current.w));
      const sign = adapter.select(rawDot.lessThan(0), constant(-1, 'f32'), constant(1, 'f32'));
      const target = current.mul(sign);
      const cosine = rawDot.mul(sign).clamp(-1, 1);
      const sine = constant(1, 'f32').sub(cosine.mul(cosine)).clamp(0, 1).sqrt();
      const angle = adapter.atan2(sine, cosine);
      const inverseSine = constant(1, 'f32').div(sine.clamp(0.000001, 1e20));
      const spherical = previous
        .mul(adapter.sin(constant(1, 'f32').sub(phase).mul(angle)))
        .add(target.mul(adapter.sin(phase.mul(angle))))
        .mul(inverseSine);
      const linear = normalizedQuaternion(
        previous.mul(constant(1, 'f32').sub(phase)).add(target.mul(phase)),
      );
      return normalizedQuaternion(adapter.select(sine.lessThan(0.00001), linear, spherical));
    };
    const quaternionTransform = (rotation: KernelNode, position: KernelNode): KernelNode => {
      const x2 = rotation.x.add(rotation.x);
      const y2 = rotation.y.add(rotation.y);
      const z2 = rotation.z.add(rotation.z);
      const xx = rotation.x.mul(x2);
      const xy = rotation.x.mul(y2);
      const xz = rotation.x.mul(z2);
      const yy = rotation.y.mul(y2);
      const yz = rotation.y.mul(z2);
      const zz = rotation.z.mul(z2);
      const wx = rotation.w.mul(x2);
      const wy = rotation.w.mul(y2);
      const wz = rotation.w.mul(z2);
      return adapter.mat4(
        adapter.vec4(constant(1, 'f32').sub(yy.add(zz)), xy.add(wz), xz.sub(wy), 0),
        adapter.vec4(xy.sub(wz), constant(1, 'f32').sub(xx.add(zz)), yz.add(wx), 0),
        adapter.vec4(xz.add(wy), yz.sub(wx), constant(1, 'f32').sub(xx.add(yy)), 0),
        adapter.vec4(position.x, position.y, position.z, 1),
      );
    };
    const interpolatedEmitterTransform = (
      phase: KernelNode,
      currentTransform = uniformNode('Emitter.transform'),
    ): KernelUniformNode => {
      const transform = mutable(currentTransform);
      adapter.branch(
        adapter.uint(uniformNode('Emitter.interpolationActive')).equal(adapter.uint(1)),
        () => {
          const previousTransform = uniformNode('Emitter.previousTransform');
          const origin = adapter.vec4(0, 0, 0, 1);
          const previousPosition = previousTransform.mul(origin).xyz;
          const currentPosition = currentTransform.mul(origin).xyz;
          const position = previousPosition
            .mul(constant(1, 'f32').sub(phase))
            .add(currentPosition.mul(phase));
          const rotation = slerpQuaternion(
            uniformNode('Emitter.previousRotation'),
            uniformNode('Emitter.rotation'),
            phase,
          );
          transform.assign(quaternionTransform(rotation, position));
        },
      );
      return transform as KernelUniformNode;
    };
    const spawnInterpolatedTransform = (spawnIndex?: KernelNode): KernelUniformNode => {
      const currentTransform = uniformNode('Emitter.transform');
      // Event spawning and the all-slots compatibility Init kernel have no rate/distance phase.
      // They intentionally retain the exact current-transform path.
      if (spawnIndex === undefined) return currentTransform;
      const phase = uniformNode('Emitter.spawnPhaseStart')
        .add(spawnIndex.toFloat().mul(uniformNode('Emitter.spawnPhaseStep')))
        .clamp(0, 1);
      return interpolatedEmitterTransform(phase, currentTransform);
    };
    const spawnInterpolatedRotation = (spawnIndex?: KernelNode): KernelUniformNode => {
      const currentRotation = uniformNode('Emitter.rotation');
      // Event spawning and the all-slots compatibility Init kernel retain the exact current
      // rotation, matching spawnInterpolatedTransform's compatibility path.
      if (spawnIndex === undefined) return currentRotation;
      const phase = uniformNode('Emitter.spawnPhaseStart')
        .add(spawnIndex.toFloat().mul(uniformNode('Emitter.spawnPhaseStep')))
        .clamp(0, 1);
      const rotation = mutable(currentRotation);
      adapter.branch(
        adapter.uint(uniformNode('Emitter.interpolationActive')).equal(adapter.uint(1)),
        () => {
          rotation.assign(
            slerpQuaternion(uniformNode('Emitter.previousRotation'), currentRotation, phase),
          );
        },
      );
      return rotation as KernelUniformNode;
    };
    let updateInterpolatedTransformNode: KernelUniformNode | undefined;
    const updateInterpolatedTransform = (): KernelUniformNode => {
      updateInterpolatedTransformNode ??= interpolatedEmitterTransform(constant(0.5, 'f32'));
      return updateInterpolatedTransformNode;
    };
    const randomNode = (
      module: CompiledKernelModule,
      particleIndex: KernelNode,
      sampleOffset: number,
      requireImplementationAccess = false,
    ): KernelNode => {
      // Init and Update randomness follow deterministic birth identity, never the physical
      // free-list slot or its allocation generation. Update additionally mixes the actual update
      // dispatch ordinal so range values evolve without leaking physical allocation order.
      const initRandom = module.stage === 'init';
      const updateRandom = module.stage === 'update';
      const implementation = requireImplementationAccess
        ? registry.resolve(module.type, module.version)
        : undefined;
      if (
        initRandom &&
        (!module.access.reads.includes('Particles.spawnOrder') ||
          (requireImplementationAccess &&
            !implementation?.access.reads.includes('Particles.spawnOrder')))
      ) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_INIT_RANDOM_SPAWN_ORDER_ACCESS_REQUIRED',
            `Init module ${module.type} called context.random() without declaring Particles.spawnOrder. Add "Particles.spawnOrder" to access.reads on the module definition and its registered implementation.`,
            `${module.path}.access.reads`,
          ),
        ]);
      }
      const updateRandomReads = [
        'Emitter.seed',
        'Particles.spawnOrder',
        'Emitter.updateRandomStep',
      ] as const;
      if (
        updateRandom &&
        updateRandomReads.some(
          (read) =>
            !module.access.reads.includes(read) ||
            (requireImplementationAccess && !implementation?.access.reads.includes(read)),
        )
      ) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_UPDATE_RANDOM_STABLE_KEY_ACCESS_REQUIRED',
            `Update module ${module.type} called context.random() without declaring Emitter.seed, Particles.spawnOrder, and Emitter.updateRandomStep. Add all stable Update random-key inputs to access.reads on the module definition and its registered implementation.`,
            `${module.path}.access.reads`,
          ),
        ]);
      }
      return pcgRandomFloatNode<KernelNode, KernelNode>(
        adapter.uint(
          initRandom || updateRandom ? attributeNode('spawnOrder', particleIndex) : particleIndex,
        ),
        adapter.uint(uniformNode('Emitter.seed')),
        resolveRandomSampleSlot(module.slot, sampleOffset),
        initRandom
          ? adapter.uint(adapter.constant(0, 'u32'))
          : updateRandom
            ? adapter.uint(uniformNode('Emitter.updateRandomStep'))
            : adapter.uint(attributeNode('spawnGeneration', particleIndex)),
      );
    };

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
      spawnIndex?: KernelNode,
    ): KernelModuleBuildContext => ({
      adapter,
      module,
      attribute: (name) => attributeNode(name, particleIndex),
      emitEvent: (eventName) => {
        const queue = program.events.find((candidate) => candidate.eventName === eventName);
        const resources = eventOutputResources[eventName];
        if (queue && resources) appendEvent(queue, resources, particleIndex);
      },
      random: (sampleOffset = 0) => randomNode(module, particleIndex, sampleOffset, true),
      sampleLut: (id, coordinate) => {
        const texture = lutTextures[id];
        const lut = program.luts.find((candidate) => candidate.id === id);
        if (!texture) throw new Error(`Compiled LUT "${id}" is missing.`);
        if (!lut) throw new Error(`Compiled LUT descriptor "${id}" is missing.`);
        const texelCentered = coordinate.mul((lut.width - 1) / lut.width).add(0.5 / lut.width);
        return adapter.sampleTexture(texture, adapter.vec2(texelCentered, 0.5));
      },
      uniform: (path) =>
        path === 'Emitter.spawnInterpolatedTransform'
          ? spawnInterpolatedTransform(spawnIndex)
          : path === 'Emitter.spawnInterpolatedRotation'
            ? spawnInterpolatedRotation(spawnIndex)
            : path === 'Emitter.updateInterpolatedTransform'
              ? updateInterpolatedTransform()
              : uniformNode(path),
      value: (input, type, sampleOffset = 0) =>
        buildValue(input, type, module, particleIndex, sampleOffset),
      write: (name, value) => {
        writeAttribute(name, value, particleIndex);
      },
    });

    const createTslBindingNodeWrapper = (modulePath: string) => {
      const cache = new WeakMap<object, KernelNode>();
      const rawNodes = new WeakMap<object, KernelNode>();
      // A Proxy passed directly to a top-level TSL helper can remain in its graph after this
      // wrapper is deactivated. It is then behaviorally transparent but still has a distinct
      // identity from the raw node; mixing both identities for one toVar() node could make
      // NodeBuilder emit duplicate variable declarations. Wrapped-method arguments and module
      // outputs are unwrapped below, but future top-level helper integration must preserve that
      // invariant.
      let active = true;
      const unwrap = (value: unknown): unknown => {
        if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
          return value;
        }
        return rawNodes.get(value) ?? value;
      };
      const wrap = (value: KernelNode, valuePath: string): KernelNode => {
        const target = value as unknown as object;
        const cached = cache.get(target);
        if (cached) return cached;
        const proxy = new Proxy(target, {
          get(current, property, receiver) {
            if (property === 'then') return undefined;
            const result = Reflect.get(current, property, receiver) as unknown;
            if (!active) return result;
            if (typeof result === 'function') {
              return (...arguments_: unknown[]) => {
                const lowered = arguments_.map((input, index) => {
                  const unwrapped = unwrap(input);
                  if (unwrapped !== input) return unwrapped;
                  const literalType = resolveTslBindingInputType(input);
                  if (literalType !== undefined) return adapter.constant(input, literalType);
                  if (isTslNodeLike(input)) return input;
                  if (isInvalidTslBindingInput(input)) {
                    throw new VfxDiagnosticError([
                      diagnostic(
                        'NACHI_TSL_BINDING_INPUT_INVALID',
                        `TSL binding operation input must be a supported literal, TSL node, or passthrough operation metadata; received ${describeTslBindingInput(input)}.`,
                        `${modulePath}.factory.${valuePath}.${String(property)}[${index}]`,
                      ),
                    ]);
                  }
                  return input;
                });
                const output = Reflect.apply(result, current, lowered) as unknown;
                return (typeof output === 'object' || typeof output === 'function') &&
                  output !== null
                  ? wrap(output as KernelNode, `${valuePath}.${String(property)}`)
                  : output;
              };
            }
            return (typeof result === 'object' || typeof result === 'function') && result !== null
              ? wrap(result as KernelNode, `${valuePath}.${String(property)}`)
              : result;
          },
        }) as unknown as KernelNode;
        cache.set(target, proxy);
        rawNodes.set(proxy as unknown as object, value);
        return proxy;
      };
      return {
        deactivate: () => {
          active = false;
        },
        unwrap,
        wrap,
      };
    };

    const buildTslModule = (module: CompiledKernelModule, particleIndex: KernelNode): void => {
      const factory = factories.get(module.path);
      if (!factory) throw new Error(`TSL factory for ${module.path} is missing.`);
      const wrapper = createTslBindingNodeWrapper(module.path);
      const bindings = new Proxy(
        {},
        {
          get: (_target, property) => {
            if (typeof property !== 'string') return undefined;
            const name = property.startsWith('custom.')
              ? property.slice('custom.'.length)
              : property;
            return wrapper.wrap(attributeNode(name, particleIndex), property);
          },
        },
      );
      let outputs: ReturnType<TslModuleFactory>;
      try {
        outputs = factory(bindings as TslParticleBindings);
      } finally {
        wrapper.deactivate();
      }
      for (const [key, value] of Object.entries(outputs)) {
        const name = key.startsWith('custom.') ? key.slice('custom.'.length) : key;
        writeAttribute(name, wrapper.unwrap(value) as KernelNode, particleIndex);
      }
    };

    type MutableNeighborGrid = Omit<BuiltNeighborGridKernels, 'pbdIterations'> & {
      pbdIterations: KernelComputeNode[];
      readonly positionSnapshot: KernelStorageNode;
      readonly velocitySnapshot: KernelStorageNode;
    };
    const neighborGridCellCoordinates = (
      definition: NeighborGridDefinition,
      worldPosition: KernelNode,
    ): { readonly x: KernelNode; readonly y: KernelNode; readonly z: KernelNode } => {
      // Particle snapshots and pairwise distance math remain world-space. Only hashing enters the
      // emitter frame, whose transform already composes the instance transform and emitter offset.
      const inverseEmitterTransform = adapter.inverse(uniformNode('Emitter.transform'));
      const localPosition = inverseEmitterTransform.mul(
        adapter.vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1),
      ).xyz;
      return {
        x: adapter.floor!(localPosition.x.sub(definition.origin[0]).div(definition.cellSize)),
        y: adapter.floor!(localPosition.y.sub(definition.origin[1]).div(definition.cellSize)),
        z: adapter.floor!(localPosition.z.sub(definition.origin[2]).div(definition.cellSize)),
      };
    };
    const neighborGrids: Record<string, MutableNeighborGrid> = {};
    for (const [key, definition] of Object.entries(neighborGridDefinitions)) {
      const cells = neighborGridCellCount(definition.resolution);
      const slotCount = cells * definition.cellCapacity;
      const counts = adapter
        .instancedArray(cells, 'uint')
        .setName(`NachiNeighborGridCounts_${key}`)
        .toAtomic();
      const slots = adapter
        .instancedArray(slotCount, 'uint')
        .setName(`NachiNeighborGridSlots_${key}`);
      const stats = adapter
        .instancedArray(2, 'uint')
        .setName(`NachiNeighborGridStats_${key}`)
        .toAtomic();
      const positionSnapshot = adapter
        .instancedArray(capacity, 'vec4')
        .setName(`NachiNeighborGridPosition_${key}`);
      const velocitySnapshot = adapter
        .instancedArray(capacity, 'vec4')
        .setName(`NachiNeighborGridVelocity_${key}`);
      const [width, height, depth] = definition.resolution;
      const clear = adapter
        .fn(() => {
          const invocation = adapter.uint(adapter.instanceIndex);
          adapter.branch(invocation.lessThan(slotCount), () => {
            slots.element(invocation).assign(adapter.uint(0xffff_ffff));
          });
          adapter.branch(invocation.lessThan(cells), () => {
            adapter.atomicStore(counts.element(invocation), adapter.uint(0));
          });
          adapter.branch(invocation.lessThan(2), () => {
            adapter.atomicStore(stats.element(invocation), adapter.uint(0));
          });
        })
        .compute(Math.max(slotCount, 2), [program.kernels.update.workgroupSize])
        .setName(`NachiNeighborGridClear_${key}`);
      const bucket = adapter
        .fn(() => {
          const particleIndex = adapter.uint(adapter.instanceIndex);
          adapter.branch(particleIndex.lessThan(capacity), () => {
            const position = attributeNode('position', particleIndex);
            const velocity = program.attributeSchema.byName.velocity
              ? attributeNode('velocity', particleIndex)
              : adapter.vec3(0, 0, 0);
            positionSnapshot
              .element(particleIndex)
              .assign(adapter.vec4(position.x, position.y, position.z, 0));
            velocitySnapshot
              .element(particleIndex)
              .assign(adapter.vec4(velocity.x, velocity.y, velocity.z, 0));
            adapter.branch(attributeNode('alive', particleIndex).equal(adapter.uint(1)), () => {
              const { x, y, z } = neighborGridCellCoordinates(definition, position);
              const zero = adapter.constant(0, 'f32');
              const inside = x
                .greaterThanEqual(zero)
                .and(x.lessThan(width))
                .and(y.greaterThanEqual(zero))
                .and(y.lessThan(height))
                .and(z.greaterThanEqual(zero))
                .and(z.lessThan(depth));
              adapter.branch(
                inside,
                () => {
                  const cellIndex = adapter
                    .uint(z)
                    .mul(height)
                    .add(adapter.uint(y))
                    .mul(width)
                    .add(adapter.uint(x));
                  const reserved = adapter.atomicAdd(
                    counts.element(cellIndex),
                    adapter.uint(1),
                    true,
                  );
                  adapter.branch(
                    reserved.lessThan(definition.cellCapacity),
                    () => {
                      slots
                        .element(cellIndex.mul(definition.cellCapacity).add(reserved))
                        .assign(particleIndex);
                    },
                    () => {
                      adapter.atomicAdd(stats.element(adapter.uint(0)), adapter.uint(1));
                    },
                  );
                },
                () => {
                  adapter.atomicAdd(stats.element(adapter.uint(1)), adapter.uint(1));
                },
              );
            });
          });
        })
        .compute(capacity, [program.kernels.update.workgroupSize])
        .setName(`NachiNeighborGridBucket_${key}`);
      neighborGrids[key] = {
        bucket,
        clear,
        counts,
        definition,
        pbdIterations: [],
        positionSnapshot,
        slots,
        stats,
        velocitySnapshot,
      };
    }

    const forEachNeighbor = (
      grid: MutableNeighborGrid,
      particleIndex: KernelNode,
      position: KernelNode,
      radius: number,
      callback: (
        neighborIndex: KernelNode,
        neighborPosition: KernelNode,
        neighborVelocity: KernelNode,
      ) => void,
    ): void => {
      const { definition } = grid;
      const [width, height, depth] = definition.resolution;
      const { x: baseX, y: baseY, z: baseZ } = neighborGridCellCoordinates(definition, position);
      const zero = adapter.constant(0, 'f32');
      const loop = adapter.loop!;
      const offsetRange = { end: radius + 1, start: -radius, type: 'int' as const };
      loop({ ...offsetRange, name: 'neighborZ' }, (dz) => {
        loop({ ...offsetRange, name: 'neighborY' }, (dy) => {
          loop({ ...offsetRange, name: 'neighborX' }, (dx) => {
            // Keep signed offsets until the bounds branch. Explicit float conversion avoids
            // TSL's left-operand type inheritance turning a negative offset into uint.
            const x = baseX.add(dx.toFloat());
            const y = baseY.add(dy.toFloat());
            const z = baseZ.add(dz.toFloat());
            const inside = x
              .greaterThanEqual(zero)
              .and(x.lessThan(width))
              .and(y.greaterThanEqual(zero))
              .and(y.lessThan(height))
              .and(z.greaterThanEqual(zero))
              .and(z.lessThan(depth));
            adapter.branch(inside, () => {
              // Conversion is emitted inside the guard, so negative/out-of-range coordinates
              // never participate in an unsigned storage address.
              const cellIndex = adapter
                .uint(z)
                .mul(height)
                .add(adapter.uint(y))
                .mul(width)
                .add(adapter.uint(x));
              const count = adapter.atomicLoad(grid.counts.element(cellIndex));
              loop(
                {
                  end: definition.cellCapacity,
                  name: 'neighborSlot',
                  start: 0,
                  type: 'uint',
                },
                (slot) => {
                  adapter.branch(slot.lessThan(count), () => {
                    const neighborIndex = grid.slots.element(
                      cellIndex.mul(definition.cellCapacity).add(slot),
                    );
                    adapter.branch(neighborIndex.equal(particleIndex).not(), () => {
                      callback(
                        neighborIndex,
                        grid.positionSnapshot.element(neighborIndex).xyz,
                        grid.velocitySnapshot.element(neighborIndex).xyz,
                      );
                    });
                  });
                },
              );
            });
          });
        });
      });
    };

    const buildModule = (
      module: CompiledKernelModule,
      particleIndex: KernelNode,
      spawnIndex?: KernelNode,
    ): void => {
      if (module.type === 'core/tsl-module') {
        buildTslModule(module, particleIndex);
        return;
      }
      if (module.type === 'core/boids') {
        const config = module.config as BoidsOptions;
        const grid = neighborGrids[config.grid];
        if (!grid) throw new Error(`Boids NeighborGrid "${config.grid}" is missing.`);
        const radius = config.radius ?? 1;
        const position = attributeNode('position', particleIndex);
        const velocity = attributeNode('velocity', particleIndex);
        const alignment = mutable(adapter.vec3(0, 0, 0));
        const cohesion = mutable(adapter.vec3(0, 0, 0));
        const separation = mutable(adapter.vec3(0, 0, 0));
        const count = mutable(adapter.constant(0, 'f32'));
        const searchDistanceSquared = (radius * grid.definition.cellSize) ** 2;
        const separationDistanceSquared =
          ((config.separationRadius ?? 0.5) * grid.definition.cellSize) ** 2;
        forEachNeighbor(
          grid,
          particleIndex,
          position,
          radius,
          (_neighbor, otherPosition, otherVelocity) => {
            const delta = position.sub(otherPosition);
            const distanceSquared = dot3(delta, delta);
            adapter.branch(distanceSquared.lessThanEqual(searchDistanceSquared), () => {
              alignment.addAssign(otherVelocity);
              cohesion.addAssign(otherPosition);
              count.addAssign(1);
              adapter.branch(distanceSquared.lessThan(separationDistanceSquared), () => {
                separation.addAssign(delta.div(distanceSquared.add(1e-6)));
              });
            });
          },
        );
        adapter.branch(adapter.constant(0, 'f32').lessThan(count), () => {
          let acceleration = alignment
            .div(count)
            .sub(velocity)
            .mul(config.alignment ?? 1)
            .add(
              cohesion
                .div(count)
                .sub(position)
                .mul(config.cohesion ?? 1),
            )
            .add(separation.div(count).mul(config.separation ?? 1.5));
          const magnitude = length3(acceleration);
          const maximum = config.maxAcceleration ?? 10;
          acceleration = adapter.select(
            adapter.constant(maximum, 'f32').lessThan(magnitude),
            acceleration.mul(maximum).div(magnitude.clamp(1e-6, 1e20)),
            acceleration,
          );
          writeAttribute(
            'velocity',
            velocity.add(acceleration.mul(uniformNode('Emitter.deltaTime'))),
            particleIndex,
          );
        });
        return;
      }
      if (module.type === 'core/neighbor-grid-tsl') {
        const config = module.config as { readonly grid: string; readonly radius: number };
        const grid = neighborGrids[config.grid];
        const factory = factories.get(module.path) as unknown as NeighborGridTslFactory | undefined;
        if (!grid || !factory) {
          throw new Error(`NeighborGrid TSL binding "${config.grid}" is missing.`);
        }
        const position = attributeNode('position', particleIndex);
        const velocity = attributeNode('velocity', particleIndex);
        const outputs = factory({
          forEachNeighbor(visitor) {
            forEachNeighbor(
              grid,
              particleIndex,
              position,
              config.radius,
              (index, neighborPosition, neighborVelocity) => {
                visitor({
                  index: index as never,
                  position: neighborPosition as never,
                  velocity: neighborVelocity as never,
                });
              },
            );
          },
          index: particleIndex as never,
          position: position as never,
          velocity: velocity as never,
        });
        for (const [name, value] of Object.entries(outputs)) {
          writeAttribute(
            name.startsWith('custom.') ? name.slice('custom.'.length) : name,
            value as never,
            particleIndex,
          );
        }
        return;
      }
      const implementation = registry.resolve(module.type, module.version);
      if (!implementation || implementation.stage === 'spawn') {
        throw new Error(`Kernel implementation for ${module.type} is missing.`);
      }
      implementation.build(buildContext(module, particleIndex, spawnIndex));
    };

    const initModules = program.kernels.init.modules;
    const ageModule = program.kernels.update.modules.find(({ type }) => type === 'core/age');
    const updateModules = program.kernels.update.modules.filter(
      ({ type }) => type !== 'core/age' && type !== 'core/pbd-distance-constraint',
    );

    for (const module of program.kernels.update.modules.filter(
      ({ type }) => type === 'core/pbd-distance-constraint',
    )) {
      const config = module.config as PbdDistanceConstraintOptions;
      const grid = neighborGrids[config.grid];
      if (!grid) throw new Error(`PBD NeighborGrid "${config.grid}" is missing.`);
      const radius = config.radius ?? Math.ceil(config.distance / grid.definition.cellSize);
      const kernel = adapter
        .fn(() => {
          const particleIndex = adapter.uint(adapter.instanceIndex);
          adapter.branch(
            particleIndex
              .lessThan(capacity)
              .and(attributeNode('alive', particleIndex).equal(adapter.uint(1))),
            () => {
              const position = grid.positionSnapshot.element(particleIndex).xyz;
              const correction = mutable(adapter.vec3(0, 0, 0));
              const count = mutable(adapter.constant(0, 'f32'));
              forEachNeighbor(grid, particleIndex, position, radius, (_neighbor, otherPosition) => {
                const delta = position.sub(otherPosition);
                const distance = length3(delta);
                adapter.branch(distance.lessThan(config.distance), () => {
                  correction.addAssign(
                    delta
                      .div(distance.clamp(1e-6, 1e20))
                      .mul(config.distance)
                      .sub(delta)
                      .mul(pbdPairCorrection(0, 1)),
                  );
                  count.addAssign(1);
                });
              });
              adapter.branch(adapter.constant(0, 'f32').lessThan(count), () => {
                writeAttribute(
                  'position',
                  position.add(correction.div(count).mul(config.stiffness ?? 1)),
                  particleIndex,
                );
              });
            },
          );
        })
        .compute(capacity, [program.kernels.update.workgroupSize])
        .setName(`NachiNeighborGridPbd_${config.grid}`);
      const iterations = config.iterations ?? 1;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        grid.pbdIterations.push(kernel);
      }
    }

    const initialize = adapter
      .fn(() => {
        isolateWebglComputeStage();
        const particleIndex = kernelInstanceIndex();
        for (const attribute of program.attributeSchema.attributes) {
          const components = attribute.components;
          const resetValue =
            attribute.logicalType === 'bool'
              ? false
              : components === 1
                ? 0
                : Array.from({ length: components }, () => 0);
          writeAttribute(
            attribute.name,
            adapter.constant(resetValue, attribute.logicalType),
            particleIndex,
          );
        }
        writeAttribute('alive', adapter.constant(false, 'bool'), particleIndex);
        writeAttribute('spawnGeneration', adapter.constant(0, 'u32'), particleIndex);
        if (hasSpawnOrder) {
          writeAttribute('spawnOrder', adapter.constant(0, 'u32'), particleIndex);
          writeLifecycle(
            stateLayout.fields.birthIndices.offsetWords,
            adapter.uint(0xffff_ffff),
            particleIndex,
          );
        }
        writeLifecycle(stateLayout.fields.freeList.offsetWords, particleIndex, particleIndex);
        adapter.branch(particleIndex.equal(adapter.uint(0)), () => {
          writeLifecycle(counterOffsets.freeCount, adapter.uint(capacity));
          writeLifecycle(counterOffsets.aliveCount, adapter.uint(0));
          writeLifecycle(counterOffsets.spawnSuccess, adapter.uint(0));
          writeLifecycle(counterOffsets.spawnOverflow, adapter.uint(0));
          if (hasSpawnOrder) {
            writeLifecycle(stateLayout.fields.nextSpawnOrder.offsetWords, adapter.uint(0));
            writeLifecycle(stateLayout.fields.currentSpawnBase.offsetWords, adapter.uint(0));
          }
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
        isolateWebglComputeStage();
        const particleIndex = kernelInstanceIndex();
        if (hasSpawnOrder) writeAttribute('spawnOrder', particleIndex);
        if (hasSpawnOrder) {
          writeLifecycle(stateLayout.fields.birthIndices.offsetWords, particleIndex, particleIndex);
        }
        for (const module of initModules) buildModule(module, particleIndex);
        writeAttribute('alive', adapter.constant(true, 'bool'), particleIndex);
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
        isolateWebglComputeStage();
        const particleIndex = kernelInstanceIndex();
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
      isolateWebglComputeStage();
      const invocation = kernelInstanceIndex();
      const requested = adapter.uint(uniformNode('Emitter.spawnCount'));
      adapter.branch(invocation.lessThan(requested), () => {
        if (gpuLifecycle) {
          const freeCount = adapter.atomicLoad(counter(counterOffsets.freeCount));
          const occupiedCount = adapter.uint(capacity).sub(freeCount);
          const logicalCapacity = adapter.uint(uniformNode('Emitter.logicalCapacity'));
          const logicalRemaining = adapter.select(
            occupiedCount.lessThan(logicalCapacity),
            logicalCapacity.sub(occupiedCount),
            adapter.uint(0),
          );
          const available = freeCount.clamp(adapter.uint(0), logicalRemaining);
          adapter.branch(
            invocation.lessThan(available),
            () => {
              const freeSlot = freeCount.sub(adapter.uint(1)).sub(invocation);
              const particleIndex = readLifecycle(
                stateLayout.fields.freeList.offsetWords,
                freeSlot,
              );
              writeAttribute(
                'spawnGeneration',
                attributeNode('spawnGeneration', particleIndex).add(adapter.uint(1)),
                particleIndex,
              );
              if (hasSpawnOrder) {
                const spawnOrder = readLifecycle(
                  stateLayout.fields.currentSpawnBase.offsetWords,
                ).add(invocation);
                writeAttribute('spawnOrder', spawnOrder, particleIndex);
                const birthSlot = spawnOrder.sub(
                  spawnOrder.div(adapter.uint(capacity)).mul(adapter.uint(capacity)),
                );
                writeLifecycle(
                  stateLayout.fields.birthIndices.offsetWords,
                  adapter.uint(particleIndex),
                  birthSlot,
                );
              }
              const spawnIndex = hasSpawnOrder
                ? attributeNode('spawnOrder', particleIndex).sub(
                    readLifecycle(stateLayout.fields.currentSpawnBase.offsetWords),
                  )
                : invocation;
              for (const module of initModules) buildModule(module, particleIndex, spawnIndex);
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
          if (hasSpawnOrder) {
            writeAttribute('spawnOrder', invocation, particleIndex);
            writeLifecycle(
              stateLayout.fields.birthIndices.offsetWords,
              adapter.uint(particleIndex),
              invocation,
            );
          }
          for (const module of initModules) buildModule(module, particleIndex, invocation);
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
    let prepareSort: KernelComputeNode | undefined;
    let sortedDepths: KernelStorageNode | undefined;
    let sortedIndices: KernelStorageNode | undefined;
    let sortPaddedCapacity: number | undefined;
    let sortPassNodes: KernelComputeNode[] = [];

    if (gpuLifecycle) {
      spawnDispatch = lifecycleIndirectStorage as KernelIndirectStorageNode;
      drawIndirect = lifecycleIndirectStorage as KernelIndirectStorageNode;
      prepareSpawn = adapter
        .fn(() => {
          adapter.atomicStore(counter(counterOffsets.spawnSuccess), adapter.uint(0));
          const requested = adapter.uint(uniformNode('Emitter.spawnCount'));
          const freeCount = adapter.atomicLoad(counter(counterOffsets.freeCount));
          const occupiedCount = adapter.uint(capacity).sub(freeCount);
          const logicalCapacity = adapter.uint(uniformNode('Emitter.logicalCapacity'));
          const logicalRemaining = adapter.select(
            occupiedCount.lessThan(logicalCapacity),
            logicalCapacity.sub(occupiedCount),
            adapter.uint(0),
          );
          const reservation = requested.clamp(
            adapter.uint(0),
            freeCount.clamp(adapter.uint(0), logicalRemaining),
          );
          if (hasSpawnOrder) {
            const spawnBase = adapter.atomicAdd(
              counter(stateLayout.fields.nextSpawnOrder.offsetWords),
              reservation,
              true,
            );
            adapter.atomicStore(
              counter(stateLayout.fields.currentSpawnBase.offsetWords),
              spawnBase,
            );
          }
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

    const particleSortedDraw = program.draws.find(
      (
        draw,
      ): draw is
        | CompiledSpriteDrawDescription
        | CompiledMeshDrawDescription
        | CompiledDecalDrawDescription =>
        (draw.kind === 'billboard' || draw.kind === 'mesh' || draw.kind === 'decal') &&
        draw.indirect.physicalIndex === 'sorted-indices',
    );
    if (gpuLifecycle && particleSortedDraw) {
      const padded = particleSortedDraw.indirect.sortedPaddedCapacity!;
      sortPaddedCapacity = padded;
      sortedDepths = adapter.instancedArray(padded, 'float').setName('NachiSortedDepths');
      sortedIndices = adapter.instancedArray(padded, 'uint').setName('NachiSortedIndices');
      const depths = sortedDepths;
      const indices = sortedIndices;
      // A capacity-one draw can only address physical index zero. Its zero-initialized sorted
      // indirection is already exact, so avoid a permanent per-frame depth-preparation submission.
      if (padded > 1) {
        prepareSort = adapter
          .fn(() => {
            const outputIndex = adapter.uint(adapter.instanceIndex);
            const aliveCount = readLifecycle(counterOffsets.aliveCount);
            const paddingCount = adapter.uint(padded).sub(aliveCount);
            adapter.branch(
              outputIndex.lessThan(paddingCount),
              () => {
                // Padding lives at the front after sorting. Vertex fetch skips it dynamically.
                depths.element(outputIndex).assign(adapter.constant(-3.402823466e38, 'f32'));
                // Its outputIndex is reused as a harmless index; depth=-FLT_MAX identifies it.
                indices.element(outputIndex).assign(outputIndex);
              },
              () => {
                const compactIndex = outputIndex.sub(paddingCount);
                const physicalIndex = readLifecycle(
                  stateLayout.fields.aliveIndices.offsetWords,
                  compactIndex,
                );
                const position = attributeNode('position', physicalIndex);
                const viewPosition = uniformNode('System.viewMatrix').mul(
                  adapter.vec4(position.x, position.y, position.z, adapter.constant(1, 'f32')),
                );
                depths.element(outputIndex).assign(viewPosition.z);
                indices.element(outputIndex).assign(physicalIndex);
              },
            );
          })
          .compute(padded, [program.kernels.update.workgroupSize])
          .setName('NachiEmitterPrepareDepthSort');

        sortPassNodes = bitonicSortPasses(padded).map(({ blockSize, compareDistance }) =>
          adapter
            .fn(() => {
              const invocation = adapter.uint(adapter.instanceIndex);
              const group = invocation.div(adapter.uint(compareDistance));
              const local = invocation.sub(group.mul(adapter.uint(compareDistance)));
              const left = group.mul(adapter.uint(compareDistance * 2)).add(local);
              const right = left.add(adapter.uint(compareDistance));
              const leftDepth =
                (depths.element(left) as KernelNode & { toVar?(): KernelNode }).toVar?.() ??
                depths.element(left);
              const rightDepth =
                (depths.element(right) as KernelNode & { toVar?(): KernelNode }).toVar?.() ??
                depths.element(right);
              const leftIndex =
                (indices.element(left) as KernelNode & { toVar?(): KernelNode }).toVar?.() ??
                indices.element(left);
              const rightIndex =
                (indices.element(right) as KernelNode & { toVar?(): KernelNode }).toVar?.() ??
                indices.element(right);
              const block = left.div(adapter.uint(blockSize));
              const ascending = block
                .sub(block.div(adapter.uint(2)).mul(adapter.uint(2)))
                .equal(adapter.uint(0));
              const depthSwap = adapter.select(
                ascending,
                rightDepth.lessThan(leftDepth),
                leftDepth.lessThan(rightDepth),
              );
              const tieSwap = adapter.select(
                ascending,
                rightIndex.lessThan(leftIndex),
                leftIndex.lessThan(rightIndex),
              );
              const swap = adapter.select(leftDepth.equal(rightDepth), tieSwap, depthSwap);
              adapter.branch(swap, () => {
                depths.element(left).assign(rightDepth);
                depths.element(right).assign(leftDepth);
                indices.element(left).assign(rightIndex);
                indices.element(right).assign(leftIndex);
              });
            })
            .compute(padded / 2, [program.kernels.update.workgroupSize])
            .setName(`NachiBitonicSort_k${blockSize}_j${compareDistance}`),
        );
      }
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
          const freeCount = adapter.atomicLoad(counter(counterOffsets.freeCount));
          const occupiedCount = adapter.uint(capacity).sub(freeCount);
          const logicalCapacity = adapter.uint(uniformNode('Emitter.logicalCapacity'));
          const logicalRemaining = adapter.select(
            occupiedCount.lessThan(logicalCapacity),
            logicalCapacity.sub(occupiedCount),
            adapter.uint(0),
          );
          const reservation = count.clamp(
            adapter.uint(0),
            freeCount.clamp(adapter.uint(0), logicalRemaining),
          );
          if (hasSpawnOrder) {
            const spawnBase = adapter.atomicAdd(
              counter(stateLayout.fields.nextSpawnOrder.offsetWords),
              reservation,
              true,
            );
            adapter.atomicStore(
              counter(stateLayout.fields.currentSpawnBase.offsetWords),
              spawnBase,
            );
          }
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
            const freeCount = adapter.atomicLoad(counter(counterOffsets.freeCount));
            const occupiedCount = adapter.uint(capacity).sub(freeCount);
            const logicalCapacity = adapter.uint(uniformNode('Emitter.logicalCapacity'));
            const logicalRemaining = adapter.select(
              occupiedCount.lessThan(logicalCapacity),
              logicalCapacity.sub(occupiedCount),
              adapter.uint(0),
            );
            const available = freeCount.clamp(adapter.uint(0), logicalRemaining);
            adapter.branch(
              invocation.lessThan(available),
              () => {
                const freeSlot = freeCount.sub(adapter.uint(1)).sub(invocation);
                const particleIndex = readLifecycle(
                  stateLayout.fields.freeList.offsetWords,
                  freeSlot,
                );
                writeAttribute(
                  'spawnGeneration',
                  attributeNode('spawnGeneration', particleIndex).add(adapter.uint(1)),
                  particleIndex,
                );
                if (hasSpawnOrder) {
                  const spawnOrder = readLifecycle(
                    stateLayout.fields.currentSpawnBase.offsetWords,
                  ).add(invocation);
                  writeAttribute('spawnOrder', spawnOrder, particleIndex);
                  const birthSlot = spawnOrder.sub(
                    spawnOrder.div(adapter.uint(capacity)).mul(adapter.uint(capacity)),
                  );
                  writeLifecycle(
                    stateLayout.fields.birthIndices.offsetWords,
                    adapter.uint(particleIndex),
                    birthSlot,
                  );
                }
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
      birthIndices: lifecycleStorage,
      birthIndicesOffset: stateLayout.fields.birthIndices.offsetWords,
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
      nextSpawnOrderOffset: stateLayout.fields.nextSpawnOrder.offsetWords,
      init,
      initialize,
      luts: lutTextures,
      neighborGrids,
      ...(prepareSpawn === undefined ? {} : { prepareSpawn }),
      ...(prepareSort === undefined ? {} : { prepareSort }),
      ...(resetAliveCount === undefined ? {} : { resetAliveCount }),
      spawn,
      ...(spawnDispatch === undefined ? {} : { spawnDispatch }),
      spawnOverflow: lifecycleStorage,
      sortPasses: sortPassNodes,
      ...(sortedDepths === undefined ? {} : { sortedDepths }),
      ...(sortedIndices === undefined ? {} : { sortedIndices }),
      ...(sortPaddedCapacity === undefined ? {} : { sortPaddedCapacity }),
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
  if (!Number.isSafeInteger(definition.capacity) || definition.capacity <= 0) {
    diagnostics.push({
      code: 'NACHI_EMITTER_CAPACITY_INVALID',
      message: 'Emitter capacity must be a positive safe integer.',
      path: 'capacity',
      phase: 'compile',
      severity: 'error',
    });
  } else if (definition.capacity > MAX_EMITTER_CAPACITY) {
    diagnostics.push({
      code: 'NACHI_EMITTER_CAPACITY_LIMIT_EXCEEDED',
      message: `Emitter capacity ${definition.capacity} exceeds the defensive limit ${MAX_EMITTER_CAPACITY}.`,
      path: 'capacity',
      phase: 'compile',
      severity: 'error',
    });
  }
  diagnostics.push(...collectEmitterLifecycleDiagnostics(untypedDefinition));
  diagnostics.push(...collectEmitterOffsetDiagnostics(untypedDefinition.offset));
  diagnostics.push(...collectEmitterBehaviorConfigDiagnostics(untypedDefinition));
  diagnostics.push(...collectEmitterModuleLabelDiagnostics(untypedDefinition));
  diagnostics.push(...collectParameterDeclarationDiagnostics(untypedDefinition.parameters));
  diagnostics.push(...validateRenderModuleLimit(untypedDefinition));
  const normalized = normalizeModules(untypedDefinition, options);
  diagnostics.push(...normalized.diagnostics);
  for (const [index, module] of normalized.update.entries()) {
    if (
      module.type !== 'core/boids' &&
      module.type !== 'core/pbd-distance-constraint' &&
      module.type !== 'core/neighbor-grid-tsl'
    )
      continue;
    const config = module.config as Partial<BoidsOptions & PbdDistanceConstraintOptions>;
    diagnostics.push(
      ...collectCoreModuleConfigDiagnostics(
        module.type,
        module.config as Readonly<Record<string, unknown>>,
        `update[${index}].config`,
      ),
    );
    if (typeof config.grid !== 'string' || options.neighborGrids?.[config.grid] === undefined) {
      diagnostics.push({
        code: 'NACHI_NEIGHBOR_GRID_TARGET_UNKNOWN',
        message: `Neighbor module targets missing NeighborGrid "${String(config.grid)}".`,
        path: `update[${index}].config.grid`,
        phase: 'compile',
        severity: 'error',
      });
    }
    if (module.type === 'core/pbd-distance-constraint') {
      const pbd = module.config as PbdDistanceConstraintOptions;
      const grid = typeof pbd.grid === 'string' ? options.neighborGrids?.[pbd.grid] : undefined;
      if (
        grid !== undefined &&
        pbd.radius !== undefined &&
        Number.isSafeInteger(pbd.radius) &&
        pbd.radius >= 0 &&
        Number.isFinite(pbd.distance) &&
        pbd.distance > 0 &&
        Number.isFinite(grid.cellSize) &&
        grid.cellSize > 0 &&
        pbd.radius < Math.ceil(pbd.distance / grid.cellSize)
      ) {
        diagnostics.push({
          code: 'NACHI_PBD_RADIUS_MISSES_PAIRS',
          message: `PBD radius ${pbd.radius} is smaller than ceil(distance / cellSize) ${Math.ceil(pbd.distance / grid.cellSize)}; qualifying pairs can be omitted.`,
          path: `update[${index}].config.radius`,
          phase: 'compile',
          severity: 'warning',
        });
      }
    }
  }

  const authorDefinition = {
    ...definition,
    init: normalized.init,
    update: normalized.update,
  } as EmitterDefinition<AttributeSchema, ParameterSchema>;
  const authorAttributeResult = resolveAttributeSchema(authorDefinition);
  const includeAgeModule =
    authorAttributeResult.value?.byName.age !== undefined &&
    authorAttributeResult.value.byName.lifetime !== undefined;
  if (
    authorAttributeResult.value?.byName.lifetime !== undefined &&
    authorAttributeResult.value.byName.age === undefined &&
    definition.lifecycle === undefined
  ) {
    diagnostics.push({
      code: 'NACHI_LIFETIME_WITHOUT_AGE',
      hint: 'Add an emitter lifecycle declaration or declare a Particles.age write alongside Particles.lifetime.',
      message:
        'Particles.lifetime is allocated without Particles.age, so particle aging and death are disabled. Add a lifecycle declaration or an age write.',
      path: 'attributeSchema.byName.lifetime',
      phase: 'compile',
      severity: 'warning',
    });
  }
  const authorModules = collectEmitterModules(authorDefinition);
  const readsNormalizedAge = authorModules.some(({ module }) =>
    module.access?.reads.includes('Particles.normalizedAge'),
  );
  const authoredWrites = new Set(
    authorModules.flatMap(({ module }) => [...(module.access?.writes ?? [])]),
  );
  const ownsNormalizedAge = authoredWrites.has('Particles.normalizedAge');
  const ownsAgeDrivenNormalizedAge =
    authoredWrites.has('Particles.age') && authoredWrites.has('Particles.lifetime');
  if (readsNormalizedAge && !ownsNormalizedAge && !ownsAgeDrivenNormalizedAge) {
    diagnostics.push({
      code: 'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME',
      hint: 'Add a lifetime() initializer, declare both Particles.age and Particles.lifetime writes, or write Particles.normalizedAge explicitly.',
      message:
        'Particles.normalizedAge is read without age/lifetime write ownership or an explicit normalizedAge writer.',
      path: 'attributeSchema.byName.normalizedAge',
      phase: 'compile',
      severity: 'warning',
    });
  }
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
  const includeDecalSpawnRotation = collectEmitterModules(normalizedDefinition).some(
    ({ module }) =>
      module.stage === 'render' && module.type === 'core/decal-renderer' && module.version === 2,
  );

  const initialModules: CompiledKernelModule[] = [
    moduleDescriptor(defaultsModule(attributeSchema), 'init[$defaults]', 0, 'compiler'),
    ...(includeDecalSpawnRotation
      ? [
          moduleDescriptor(
            DECAL_SPAWN_ROTATION_MODULE,
            'init[$decal-spawn-rotation]',
            1,
            'compiler',
          ),
        ]
      : []),
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
  const webgl2InitializeVaryings = attributeSchema.storageArrays.map(
    ({ name }) => `Particles.${name}`,
  );
  const lifecycleLayout = lifecycleStorageLayout(
    definition.capacity,
    attributeSchema.byName.spawnOrder !== undefined,
  );
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
  const lightDraws = compileLightDraws(normalizedDefinition, attributeSchema, diagnostics);
  const decalDraws = compileDecalDraws(
    normalizedDefinition,
    attributeSchema,
    lifecycleLayout,
    diagnostics,
  );
  const registeredDraws = compileRegisteredDraws(
    normalizedDefinition,
    attributeSchema,
    lifecycleLayout,
    registry,
    diagnostics,
  );
  const drawsByPath = new Map(
    [...spriteDraws, ...meshDraws, ...lightDraws, ...decalDraws, ...registeredDraws].map(
      (draw) => [draw.path, draw] as const,
    ),
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
        ...(attributeSchema.byName.spawnOrder === undefined
          ? []
          : ['deterministic spawn-order counters and birth-index ring']),
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
        defaultInitializeVaryingLimit: 4,
        initializeVaryingCount: webgl2InitializeVaryings.length,
        initializeVaryings: webgl2InitializeVaryings,
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
      options.neighborGrids ?? {},
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
): {
  readonly position: KernelNode;
  readonly transform?: KernelNode;
  readonly velocity: KernelNode;
} {
  const position = context.attribute('position');
  const velocity = context.attribute('velocity');
  if ((space ?? 'emitter') === 'world') return { position, velocity };
  const transform = context.uniform(
    context.module.version >= 2 ? 'Emitter.updateInterpolatedTransform' : 'Emitter.transform',
  );
  const inverseTransform = context.adapter.inverse(transform);
  return {
    position: inverseTransform.mul(context.adapter.vec4(position.x, position.y, position.z, 1)).xyz,
    transform,
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
  emitterTransform?: KernelNode,
): void {
  context.adapter.branch(collided, () => {
    const space = config.space ?? 'emitter';
    const transform = space === 'emitter' ? emitterTransform : undefined;
    if (space === 'emitter' && transform === undefined) {
      throw new Error('Emitter-space collision response is missing its sampled update transform.');
    }
    const worldPosition =
      space === 'emitter'
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
      space === 'emitter'
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
      reads: ['Emitter.previousTransform', 'Emitter.transform'],
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
          context.value(
            attribute.default,
            attribute.logicalType,
            defaultAttributeSampleOffset(attribute.storageIndex),
          ),
        );
      }
    },
    stage: 'init',
    type: 'core/defaults',
    version: 1,
  });
  registry.register({
    access: DECAL_SPAWN_ROTATION_MODULE.access!,
    build(context) {
      const rotation = context.uniform('Emitter.spawnInterpolatedRotation');
      const length = rotation.x
        .mul(rotation.x)
        .add(rotation.y.mul(rotation.y))
        .add(rotation.z.mul(rotation.z))
        .add(rotation.w.mul(rotation.w))
        .sqrt()
        .clamp(0.000001, 1e20);
      context.write('rotation', rotation.div(length));
    },
    stage: 'init',
    type: 'core/decal-spawn-rotation',
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
      reads: ['Emitter.spawnInterpolatedTransform', 'Emitter.seed', 'Particles.spawnOrder'],
      writes: ['Particles.position'],
    },
    build(context) {
      const config = context.module.config as {
        arc?: { axis?: Vec3; thetaMax: ValueInput<number> };
        center?: ValueInput<Vec3>;
        radius: ValueInput<number>;
        surfaceOnly?: boolean;
      };
      let direction: KernelNode;
      if (config.arc === undefined) {
        // Keep the legacy full-sphere graph byte-for-byte stable when arc is omitted.
        const z = context.random(1).mul(2).sub(1);
        const azimuth = context.random(2).mul(Math.PI * 2);
        const horizontal = context.adapter.constant(1, 'f32').sub(z.mul(z)).clamp(0, 1).sqrt();
        direction = context.adapter.vec3(
          context.adapter.cos(azimuth).mul(horizontal),
          z,
          context.adapter.sin(azimuth).mul(horizontal),
        );
      } else {
        const basis = normalizedBasis(config.arc.axis ?? [0, 1, 0]);
        const thetaMax = context.value(config.arc.thetaMax, 'f32', 5).mul(Math.PI / 180);
        const cosLimit = context.adapter.cos(thetaMax);
        // Uniform cos(theta) preserves area measure over the spherical cap.
        const cosTheta = cosLimit.add(
          context.random(1).mul(context.adapter.constant(1, 'f32').sub(cosLimit)),
        );
        const sinTheta = context.adapter
          .constant(1, 'f32')
          .sub(cosTheta.mul(cosTheta))
          .clamp(0, 1)
          .sqrt();
        const azimuth = context.random(2).mul(Math.PI * 2);
        const radialX = context.adapter.cos(azimuth).mul(sinTheta);
        const radialZ = context.adapter.sin(azimuth).mul(sinTheta);
        const component = (axis: 0 | 1 | 2) =>
          radialX
            .mul(basis.right[axis])
            .add(cosTheta.mul(basis.up[axis]))
            .add(radialZ.mul(basis.forward[axis]));
        direction = context.adapter.vec3(component(0), component(1), component(2));
      }
      const radius = context.value(config.radius, 'f32', 3);
      const distance = config.surfaceOnly ? radius : radius.mul(context.random(4).pow(1 / 3));
      let local = direction.mul(distance);
      if (config.center !== undefined) {
        local = local.add(context.value(config.center, 'vec3', 6));
      }
      const world = context
        .uniform('Emitter.spawnInterpolatedTransform')
        .mul(context.adapter.vec4(local.x, local.y, local.z, 1)).xyz;
      context.write('position', world);
    },
    stage: 'init',
    type: 'core/position-sphere',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.seed', 'Emitter.spawnInterpolatedTransform', 'Particles.spawnOrder'],
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
      const transform = context.uniform('Emitter.spawnInterpolatedTransform');
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
      reads: ['Emitter.seed', 'Emitter.spawnInterpolatedTransform', 'Particles.spawnOrder'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as {
        angle: ValueInput<number>;
        direction: Vec3;
        space?: 'emitter' | 'world';
        speed: ValueInput<number>;
      };
      const space = context.module.version >= 2 ? (config.space ?? 'world') : 'world';
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
      const sampledDirection = context.adapter.vec3(component(0), component(1), component(2));
      const direction =
        space === 'emitter'
          ? context
              .uniform('Emitter.spawnInterpolatedTransform')
              .mul(
                context.adapter.vec4(sampledDirection.x, sampledDirection.y, sampledDirection.z, 0),
              ).xyz
          : sampledDirection;
      context.write('velocity', direction.mul(speed));
    },
    stage: 'init',
    type: 'core/velocity-cone',
    version: 2,
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
      reads: [
        'Emitter.deltaTime',
        'Emitter.updateInterpolatedTransform',
        'Particles.position',
        'Particles.velocity',
      ],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as VortexOptions;
      const space = config.space ?? 'emitter';
      const basis = normalizedBasis(config.axis);
      const center = context.value(config.center ?? [0, 0, 0], 'vec3', 1);
      const position = context.attribute('position');
      const transform =
        space === 'emitter'
          ? context.uniform(
              context.module.version >= 2
                ? 'Emitter.updateInterpolatedTransform'
                : 'Emitter.transform',
            )
          : undefined;
      const samplePosition =
        space === 'emitter'
          ? context.adapter
              .inverse(transform!)
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
        space === 'emitter'
          ? transform!.mul(
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
    version: 2,
  });
  registry.register({
    access: {
      reads: [
        'Emitter.deltaTime',
        'Emitter.updateInterpolatedTransform',
        'Particles.position',
        'Particles.velocity',
      ],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as PointAttractorOptions;
      const space = config.space ?? 'emitter';
      const target = context.value(config.position, 'vec3', 1);
      const position = context.attribute('position');
      const transform =
        space === 'emitter'
          ? context.uniform(
              context.module.version >= 2
                ? 'Emitter.updateInterpolatedTransform'
                : 'Emitter.transform',
            )
          : undefined;
      const samplePosition =
        space === 'emitter'
          ? context.adapter
              .inverse(transform!)
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
        space === 'emitter'
          ? transform!.mul(
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
    version: 2,
  });
  registry.register({
    access: {
      reads: ['Emitter.deltaTime', 'Emitter.updateInterpolatedTransform', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    build(context) {
      const config = context.module.config as LinearForceOptions;
      const space = context.module.version >= 2 ? (config.space ?? 'world') : 'world';
      const sampledForce = context.value(config.force, 'vec3', 1);
      const force =
        space === 'emitter'
          ? context
              .uniform('Emitter.updateInterpolatedTransform')
              .mul(context.adapter.vec4(sampledForce.x, sampledForce.y, sampledForce.z, 0)).xyz
          : sampledForce;
      context.write(
        'velocity',
        context.attribute('velocity').add(force.mul(context.uniform('Emitter.deltaTime'))),
      );
    },
    stage: 'update',
    type: 'core/linear-force',
    version: 2,
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
      reads: ['Emitter.updateInterpolatedTransform', 'Particles.position', 'Particles.velocity'],
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
        frame.transform,
      );
    },
    stage: 'update',
    type: 'core/collide-plane',
    version: 2,
  });
  registry.register({
    access: {
      reads: ['Emitter.updateInterpolatedTransform', 'Particles.position', 'Particles.velocity'],
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
        frame.transform,
      );
    },
    stage: 'update',
    type: 'core/collide-sphere',
    version: 2,
  });
  registry.register({
    access: {
      reads: ['Emitter.updateInterpolatedTransform', 'Particles.position', 'Particles.velocity'],
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
        frame.transform,
      );
    },
    stage: 'update',
    type: 'core/collide-box',
    version: 2,
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
      // Three r185 screen/depth texture UVs use a top-left origin (v grows down), while WebGPU
      // NDC y grows up. This one-minus is required in both projection and reconstruction.
      const uv = context.adapter.vec2(
        ndc.x.mul(0.5).add(0.5),
        context.adapter.constant(0.5, 'f32').sub(ndc.y.mul(0.5)),
      );
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
          context.adapter.constant(1, 'f32').sub(sampleUv.y.mul(2)),
          depth,
          1,
        );
        const homogeneous = context.adapter.inverse(projectionMatrix).mul(clip);
        return homogeneous.xyz.div(homogeneous.w.mul(homogeneous.w).sqrt().clamp(0.000001, 1e20));
      };
      const leftUv = context.adapter.vec2(uv.x.sub(texel.x), uv.y).clamp(0, 1);
      const rightUv = context.adapter.vec2(uv.x.add(texel.x), uv.y).clamp(0, 1);
      const upUv = context.adapter.vec2(uv.x, uv.y.sub(texel.y)).clamp(0, 1);
      const downUv = context.adapter.vec2(uv.x, uv.y.add(texel.y)).clamp(0, 1);
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
    access: { reads: [], writes: ['Particles.intensity'] },
    build(context) {
      const config = context.module.config as { readonly value: ValueInput<number> };
      context.write('intensity', context.value(config.value, 'f32'));
    },
    stage: 'init',
    type: 'core/light-intensity',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.intensity'],
    },
    build(context) {
      if (!context.module.lutId) throw new Error('intensityOverLife LUT is missing.');
      context.write(
        'intensity',
        context.sampleLut(context.module.lutId, context.attribute('normalizedAge')).r,
      );
    },
    stage: 'update',
    type: 'core/intensity-over-life',
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
      reads: ['Emitter.updateInterpolatedTransform', 'Particles.position'],
      writes: ['Particles.alive'],
    },
    build(context) {
      const config = context.module.config as KillVolumeOptions;
      const position = context.attribute('position');
      const local = context.adapter
        .inverse(
          context.uniform(
            context.module.version >= 2
              ? 'Emitter.updateInterpolatedTransform'
              : 'Emitter.transform',
          ),
        )
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
    version: 2,
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
    access: {
      reads: [
        'Emitter.deltaTime',
        'Emitter.transform',
        'Particles.alive',
        'Particles.position',
        'Particles.velocity',
      ],
      writes: ['Particles.velocity'],
    },
    build() {
      // Materialization intercepts this implementation to bind effect-owned NeighborGrid storage.
    },
    stage: 'update',
    type: 'core/boids',
    version: 1,
  });
  registry.register({
    access: {
      reads: ['Emitter.transform', 'Particles.alive', 'Particles.position'],
      writes: ['Particles.position'],
    },
    build() {
      // Materialized as submit-separated Jacobi kernels, not inside the ordinary update kernel.
    },
    stage: 'update',
    type: 'core/pbd-distance-constraint',
    version: 1,
  });
  registry.register({
    access: { reads: ['Emitter.transform'], writes: [] },
    build() {},
    stage: 'update',
    type: 'core/neighbor-grid-tsl',
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

  const legacyH26Access: Readonly<Record<string, ModuleAccess>> = {
    'core/collide-box': {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    'core/collide-plane': {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    'core/collide-sphere': {
      reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
    },
    'core/kill-volume': {
      reads: ['Emitter.transform', 'Particles.position'],
      writes: ['Particles.alive'],
    },
    'core/linear-force': {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    'core/point-attractor': {
      reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
    'core/velocity-cone': {
      reads: ['Emitter.seed', 'Particles.spawnOrder'],
      writes: ['Particles.velocity'],
    },
    'core/vortex': {
      reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
  };
  for (const [type, access] of Object.entries(legacyH26Access)) {
    const current = registry.resolve(type, 2);
    if (current === undefined || current.stage === 'spawn') {
      throw new Error(`Missing H2-6 module implementation ${type}@2.`);
    }
    registry.register({ ...current, access, version: 1 });
  }
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
      'core/light-intensity',
      'core/intensity-over-life',
      'core/size-over-life',
      'core/rotation-over-life',
      'core/velocity-over-life',
      'core/kill-volume',
      'core/color-over-life',
      'core/boids',
      'core/pbd-distance-constraint',
      'core/neighbor-grid-tsl',
      'core/integrate',
    ].map((type) => [
      type,
      registry.resolve(
        type,
        UPDATE_INTERPOLATED_TRANSFORM_MODULES.has(type) || type === 'core/velocity-cone' ? 2 : 1,
      )?.access,
    ]),
  ) as Readonly<Record<string, ModuleAccess>>;
}
