import {
  allocateEventQueueResources,
  compileEmitter,
  type BuiltEmitterKernels,
  type CompiledSpawnModule,
  type CompiledEmitterProgram,
  type KernelComputeNode,
  type KernelModuleRegistry,
  type KernelStorageNode,
  type KernelTslAdapter,
  type KernelUniformNode,
  type EventInputBinding,
  type EventQueueResources,
} from './compiler.js';
import { attributeStorageComponentIndex } from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import {
  aggregateProfileFrame,
  captureEmitterAttributes,
  type CaptureProfileOptions,
  type EmitterProfileCounters,
  type VfxSystemDebug,
} from './debug.js';
import { collectEmitterModules } from './emitter-modules.js';
import { hashModuleLabel, pcgRandomFloat, resolveRandomSampleSlot } from './random.js';
import {
  applyEmitterQualityTier,
  mergeBoundingSpheres,
  qualityStructuralKey,
  resolveEmitterQuality,
  selectDeviceQualityTier,
  significanceScore,
  sphereIntersectsFrustum,
  transformBoundingSphere,
  type BoundingSphere,
  type DeviceQualityProfile,
  type QualityTierSelection,
} from './scalability.js';
import type {
  AttributeType,
  CaptureAttributesOptions,
  DefinitionParameterValue,
  EffectDefinition,
  EffectElements,
  EffectInstance,
  EffectInstanceDebug,
  EffectEventCallback,
  EffectEventSummary,
  EffectInstanceState,
  EffectScalabilityStatus,
  EffectScalabilityConfig,
  EffectSpawnOptions,
  EffectTransformSource,
  EmitterDefinition,
  EmitterLifecycle,
  ParameterPath,
  ParameterSchema,
  PositionInput,
  RotationInput,
  QualityTier,
  AttributeSnapshot,
  UserParameterKeys,
  VfxDiagnostic,
} from './types.js';

const DEFAULT_MAX_SUB_STEPS = 8;
const DEFAULT_MAX_POOL_SIZE = 16;
const DEFAULT_PREWARM_STEP_SECONDS = 1 / 60;
const BUDGET_HYSTERESIS_SCORE = 0.05;
const TIME_EPSILON = 1e-10;
export const SPAWN_ORDER_WRAP_WARNING_THRESHOLD = 0x8000_0000;

export function crossesSpawnOrderWarningThreshold(previous: number, increment: number): boolean {
  return (
    previous < SPAWN_ORDER_WRAP_WARNING_THRESHOLD &&
    previous + increment >= SPAWN_ORDER_WRAP_WARNING_THRESHOLD
  );
}

export interface VfxDeviceLossInfo {
  readonly message?: string;
  readonly reason?: string;
}

/** Renderer integration boundary. Core owns scheduling; backend packages own submission and nodes. */
export interface VfxRuntimeRenderer {
  readonly deviceLost?: Promise<VfxDeviceLossInfo>;
  readonly kernelAdapter: KernelTslAdapter;
  /** Synchronously makes retained kernels non-drawable before ownership moves into the pool. */
  prepareKernelsForPooling?(kernels: BuiltEmitterKernels): void;
  readStorage?(storage: BuiltEmitterKernels['aliveCount']): Promise<ArrayBuffer>;
  releaseKernels?(kernels: BuiltEmitterKernels): void;
  setUniformValue?(uniform: KernelUniformNode, path: ParameterPath, value: unknown): void;
  setInstanceCount?(kernels: BuiltEmitterKernels, count: number): void;
  /** Hides materialized draw objects when a fully culled instance skips rendering. */
  setVisibility?(kernels: BuiltEmitterKernels, visible: boolean): void;
  /** Returns the currently materialized indirect draw records owned by these kernels. */
  getRenderableIndirectDrawCount?(kernels: BuiltEmitterKernels): number;
  /** Applies VFXSystem's stable far-to-near emitter order to backend draw objects. */
  setRenderOrder?(kernels: BuiltEmitterKernels, order: number): void;
  /** Uploads cache replay bytes into an existing materialized storage resource. */
  writeStorage?(storage: KernelStorageNode, data: ArrayBufferView, byteOffset?: number): void;
  /** Makes preceding writeStorage calls visible to immediate storage readback/compute submission. */
  flushStorageWrites?(): Promise<void> | void;
  /** Marks cache-uploaded kernels as coherent for immediate readback. */
  markStorageReplayReady?(kernels: BuiltEmitterKernels): void;
  /** Clears replay ownership when kernels are assigned to a fresh live instance. */
  clearStorageReplayReady?(kernels: BuiltEmitterKernels): void;
  /** Reports whether cache uploads, rather than simulation initialization, own current storage. */
  isStorageReplayReady?(kernels: BuiltEmitterKernels): boolean;
  submitCompute(kernel: KernelComputeNode): Promise<void> | void;
  submitComputeIndirect?(
    kernel: KernelComputeNode,
    indirectResource: unknown,
  ): Promise<void> | void;
}

export interface VfxFixedTimeStepOptions {
  readonly maxSubSteps?: number;
  readonly stepSeconds: number;
}

export interface VfxSystemOptions {
  /**
   * Read exact GPU alive count every N compactions. Omission uses maximum-lifetime estimates for
   * completion and scaled logical capacity; WebGL2 still performs its required full readback.
   */
  readonly aliveCountReadbackInterval?: number;
  readonly fixedTimeStep?: VfxFixedTimeStepOptions;
  /** Maximum released resource bundles retained per effect definition. Defaults to 16. */
  readonly maxPoolSize?: number;
  readonly now?: () => number;
  readonly prewarmStepSeconds?: number;
  /** Defaults to epic for backward compatibility; pass auto to use device heuristics. */
  readonly qualityTier?: QualityTier | 'auto';
  /**
   * Optional navigator.gpu snapshot used for synchronous automatic tier selection. Without it,
   * auto selection can inspect backend limits but not optional features, so it tops out at medium.
   */
  readonly deviceProfile?: DeviceQualityProfile;
  readonly significanceBudget?: VfxSignificanceBudget;
  /** Module/render compiler registrations supplied by optional packages. */
  readonly registry?: KernelModuleRegistry;
}

export interface VfxSignificanceBudget {
  readonly maxActiveInstances?: number;
  readonly maxParticles?: number;
}

export interface VfxCameraState {
  /** Clip-space depth convention used by projectionMatrix. Defaults to WebGPU. */
  readonly coordinateSystem?: 'webgl' | 'webgpu';
  /** World-to-view matrix in column-major order. */
  readonly viewMatrix: readonly number[];
  /** View-to-clip matrix using coordinateSystem's WebGPU or WebGL NDC z convention. */
  readonly projectionMatrix: readonly number[];
  /** Width and height of the bound previous-frame depth texture. */
  readonly viewportSize: readonly [number, number];
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const DEFAULT_CAMERA_STATE: VfxCameraState = {
  coordinateSystem: 'webgpu',
  projectionMatrix: IDENTITY_MATRIX,
  viewMatrix: IDENTITY_MATRIX,
  viewportSize: [1, 1],
};

export interface CoarseTransparencyEntry<T = unknown> {
  readonly stableKey: string;
  readonly value: T;
  readonly worldPosition: readonly [number, number, number];
}

/** Stable far-to-near ordering using the same column-major view matrix accepted by setCamera(). */
export function sortEmittersBackToFront<T>(
  entries: readonly CoarseTransparencyEntry<T>[],
  viewMatrix: readonly number[],
): readonly CoarseTransparencyEntry<T>[] {
  const depth = ({ worldPosition: [x, y, z] }: CoarseTransparencyEntry<T>) =>
    -(viewMatrix[2]! * x + viewMatrix[6]! * y + viewMatrix[10]! * z + viewMatrix[14]!);
  return [...entries].sort((left, right) => {
    const difference = depth(right) - depth(left);
    return difference === 0
      ? left.stableKey < right.stableKey
        ? -1
        : left.stableKey > right.stableKey
          ? 1
          : 0
      : difference;
  });
}

function validateCameraState(camera: VfxCameraState): VfxCameraState {
  const matrix = (value: readonly number[], name: string) => {
    if (value.length !== 16 || value.some((component) => !Number.isFinite(component))) {
      throw new RangeError(`${name} must contain 16 finite column-major components.`);
    }
    return [...value];
  };
  const [width, height] = camera.viewportSize;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('viewportSize must contain positive finite dimensions.');
  }
  if (
    camera.coordinateSystem !== undefined &&
    camera.coordinateSystem !== 'webgl' &&
    camera.coordinateSystem !== 'webgpu'
  ) {
    throw new RangeError('coordinateSystem must be "webgl" or "webgpu".');
  }
  return {
    coordinateSystem: camera.coordinateSystem ?? 'webgpu',
    projectionMatrix: matrix(camera.projectionMatrix, 'projectionMatrix'),
    viewMatrix: matrix(camera.viewMatrix, 'viewMatrix'),
    viewportSize: [width, height],
  };
}

export type EmitterLifecycleState = 'active' | 'completed' | 'delayed';

export type EmitterLifecycleCommand =
  | {
      readonly kind: 'activate';
      readonly loopIndex: number;
      readonly spawnGeneration: number;
    }
  | { readonly kind: 'complete' }
  | {
      readonly deltaSeconds: number;
      readonly kind: 'update';
      readonly loopIndex: number;
      readonly phase: 'active' | 'drain';
      readonly prewarm: boolean;
    };

export interface NormalizedEmitterLifecycle {
  readonly duration: number;
  readonly loopCount: number | 'infinite';
  readonly prewarm: number;
  readonly startDelay: number;
}

function requireNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

export function normalizeEmitterLifecycle(
  lifecycle: EmitterLifecycle | undefined,
): NormalizedEmitterLifecycle {
  const duration = requireNonNegativeFinite(lifecycle?.duration ?? 0, 'duration');
  const prewarm = requireNonNegativeFinite(lifecycle?.prewarm ?? 0, 'prewarm');
  const startDelay = requireNonNegativeFinite(lifecycle?.startDelay ?? 0, 'startDelay');
  const loopCount = lifecycle?.loopCount ?? 1;
  if (loopCount !== 'infinite' && (!Number.isSafeInteger(loopCount) || loopCount <= 0)) {
    throw new RangeError('loopCount must be a positive safe integer or "infinite".');
  }
  if (duration === 0 && loopCount !== 1) {
    throw new RangeError('A looping emitter requires a positive duration.');
  }
  return { duration, loopCount, prewarm, startDelay };
}

/** Pure lifecycle state machine. It emits ordered commands but has no renderer dependency. */
export class EmitterLifecycleController {
  readonly lifecycle: NormalizedEmitterLifecycle;
  #activated = false;
  #delayElapsed = 0;
  #loopAge = 0;
  #loopIndex = 0;
  #prewarmPending: number;
  #state: EmitterLifecycleState;

  constructor(lifecycle?: EmitterLifecycle) {
    this.lifecycle = normalizeEmitterLifecycle(lifecycle);
    this.#prewarmPending = this.lifecycle.prewarm;
    this.#state = this.lifecycle.startDelay > 0 ? 'delayed' : 'active';
  }

  get age(): number {
    return this.#loopAge;
  }

  get loopIndex(): number {
    return this.#loopIndex;
  }

  get spawnGeneration(): number {
    return this.#loopIndex;
  }

  get state(): EmitterLifecycleState {
    return this.#state;
  }

  advance(deltaSeconds: number): readonly EmitterLifecycleCommand[] {
    requireNonNegativeFinite(deltaSeconds, 'deltaSeconds');
    const commands: EmitterLifecycleCommand[] = [];
    let remaining = deltaSeconds;

    if (!this.#activated) {
      if (this.#state === 'delayed') {
        const delayRemaining = this.lifecycle.startDelay - this.#delayElapsed;
        const consumed = Math.min(delayRemaining, remaining);
        this.#delayElapsed += consumed;
        remaining -= consumed;
        if (this.#delayElapsed + TIME_EPSILON < this.lifecycle.startDelay) return commands;
        this.#state = 'active';
      }
      this.#activate(commands);
      const prewarm = this.#prewarmPending;
      this.#prewarmPending = 0;
      if (prewarm > 0 || this.lifecycle.duration === 0) {
        this.#advanceActive(prewarm, true, commands);
      }
    }

    if (remaining > TIME_EPSILON) {
      if (this.#state === 'active') this.#advanceActive(remaining, false, commands);
      else this.#pushUpdate(remaining, false, 'drain', commands);
    }
    return commands;
  }

  #activate(commands: EmitterLifecycleCommand[]): void {
    this.#activated = true;
    this.#loopAge = 0;
    commands.push({
      kind: 'activate',
      loopIndex: this.#loopIndex,
      spawnGeneration: this.#loopIndex,
    });
  }

  #advanceActive(
    deltaSeconds: number,
    prewarm: boolean,
    commands: EmitterLifecycleCommand[],
  ): void {
    let remaining = deltaSeconds;
    while (this.#state === 'active') {
      if (this.lifecycle.duration === 0) {
        this.#finishLoop(commands);
        break;
      }
      if (remaining <= TIME_EPSILON) break;
      const loopRemaining = this.lifecycle.duration - this.#loopAge;
      const consumed = Math.min(loopRemaining, remaining);
      this.#pushUpdate(consumed, prewarm, 'active', commands);
      this.#loopAge += consumed;
      remaining -= consumed;
      if (this.#loopAge + TIME_EPSILON >= this.lifecycle.duration) {
        this.#finishLoop(commands);
      }
    }
    if (remaining > TIME_EPSILON && this.#state === 'completed') {
      this.#pushUpdate(remaining, prewarm, 'drain', commands);
    }
  }

  #finishLoop(commands: EmitterLifecycleCommand[]): void {
    const hasNextLoop =
      this.lifecycle.loopCount === 'infinite' || this.#loopIndex + 1 < this.lifecycle.loopCount;
    if (hasNextLoop) {
      this.#loopIndex += 1;
      this.#activate(commands);
      return;
    }
    this.#state = 'completed';
    commands.push({ kind: 'complete' });
  }

  #pushUpdate(
    deltaSeconds: number,
    prewarm: boolean,
    phase: 'active' | 'drain',
    commands: EmitterLifecycleCommand[],
  ): void {
    if (deltaSeconds > TIME_EPSILON) {
      commands.push({
        deltaSeconds,
        kind: 'update',
        loopIndex: this.#loopIndex,
        phase,
        prewarm,
      });
    }
  }
}

export class EffectClock {
  #hitStopRemaining = 0;
  #hitStopTimeScale = 0;
  #localTime = 0;
  #timeScale: number;

  constructor(timeScale = 1) {
    this.#timeScale = EffectClock.validateTimeScale(timeScale);
  }

  get hitStopRemaining(): number {
    return this.#hitStopRemaining;
  }

  get localTime(): number {
    return this.#localTime;
  }

  get timeScale(): number {
    return this.#timeScale;
  }

  advance(deltaSeconds: number): number {
    requireNonNegativeFinite(deltaSeconds, 'deltaSeconds');
    const hitStopPortion = Math.min(deltaSeconds, this.#hitStopRemaining);
    const normalPortion = deltaSeconds - hitStopPortion;
    this.#hitStopRemaining = Math.max(0, this.#hitStopRemaining - deltaSeconds);
    const localDelta = this.#timeScale * (hitStopPortion * this.#hitStopTimeScale + normalPortion);
    this.#localTime += localDelta;
    return localDelta;
  }

  applyHitStop(durationMs: number, timeScale = 0): void {
    requireNonNegativeFinite(durationMs, 'durationMs');
    this.#hitStopRemaining = durationMs / 1000;
    this.#hitStopTimeScale = EffectClock.validateTimeScale(timeScale);
  }

  setTimeScale(timeScale: number): void {
    this.#timeScale = EffectClock.validateTimeScale(timeScale);
  }

  static validateTimeScale(timeScale: number): number {
    if (!Number.isFinite(timeScale) || timeScale < 0) {
      throw new RangeError('timeScale must be a non-negative finite number.');
    }
    return timeScale;
  }
}

export class FixedStepAccumulator {
  readonly maxSubSteps: number;
  readonly stepSeconds: number;
  #accumulator = 0;
  #droppedSeconds = 0;

  constructor(options: VfxFixedTimeStepOptions) {
    this.stepSeconds = requireNonNegativeFinite(options.stepSeconds, 'stepSeconds');
    if (this.stepSeconds === 0) throw new RangeError('stepSeconds must be greater than zero.');
    this.maxSubSteps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
    if (!Number.isSafeInteger(this.maxSubSteps) || this.maxSubSteps <= 0) {
      throw new RangeError('maxSubSteps must be a positive safe integer.');
    }
  }

  get accumulator(): number {
    return this.#accumulator;
  }

  get droppedSeconds(): number {
    return this.#droppedSeconds;
  }

  advance(deltaSeconds: number): readonly number[] {
    requireNonNegativeFinite(deltaSeconds, 'deltaSeconds');
    const maximum = this.stepSeconds * this.maxSubSteps;
    const accumulated = this.#accumulator + deltaSeconds;
    this.#droppedSeconds += Math.max(0, accumulated - maximum);
    this.#accumulator = Math.min(accumulated, maximum);
    const stepCount = Math.min(
      Math.floor((this.#accumulator + TIME_EPSILON) / this.stepSeconds),
      this.maxSubSteps,
    );
    this.#accumulator = Math.max(0, this.#accumulator - stepCount * this.stepSeconds);
    return Array.from({ length: stepCount }, () => this.stepSeconds);
  }
}

type CompiledEmitterEntry = {
  readonly definition: EmitterDefinition;
  readonly key: string;
  readonly maxLifetime: number;
  readonly program: CompiledEmitterProgram;
};

type CompiledEffect = {
  readonly emitters: readonly CompiledEmitterEntry[];
  readonly eventDrainFrames: number;
  readonly eventLinks: readonly {
    readonly handler: CompiledEmitterProgram['events'][number]['handlers'][number];
    readonly queue: CompiledEmitterProgram['events'][number];
    readonly sourceKey: string;
    readonly targetKey: string;
  }[];
};

type PooledEffectResources = {
  readonly kernelsByEmitter: ReadonlyMap<string, BuiltEmitterKernels>;
};

type EffectResourcePool = {
  readonly resources: PooledEffectResources[];
};

type RuntimeEffectDefinition = {
  readonly elements: EffectElements;
  readonly kind: 'effect';
  readonly parameters?: ParameterSchema;
  readonly scalability?: EffectScalabilityConfig;
};

type AdvanceContext = {
  readonly prewarmStepSeconds: number;
  readonly systemDelta: number;
  readonly systemTime: number;
};

export interface VfxEmitterRuntimeView {
  readonly aliveCount: number | undefined;
  readonly definition: EmitterDefinition;
  readonly initialized: boolean;
  readonly kernels: BuiltEmitterKernels;
  readonly lifecycleState: EmitterLifecycleState;
  readonly loopIndex: number;
  readonly program: CompiledEmitterProgram;
  readonly spawnGeneration: number;
}

function asRuntimeRenderer(renderer: unknown): VfxRuntimeRenderer | undefined {
  if (typeof renderer !== 'object' || renderer === null) return undefined;
  const candidate = renderer as Partial<VfxRuntimeRenderer>;
  return candidate.kernelAdapter && typeof candidate.submitCompute === 'function'
    ? (candidate as VfxRuntimeRenderer)
    : undefined;
}

function runtimeDiagnostic(
  code: string,
  message: string,
  path?: string,
  severity: 'error' | 'warning' = 'error',
): VfxDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase: 'runtime',
    severity,
  };
}

function reverseZCameraDiagnostic(camera: VfxCameraState): VfxDiagnostic | undefined {
  // three.js WebGPU perspective and orthographic projections both store the depth scale and
  // offset at column-major elements 10 and 14. Both switch from negative to positive for reverse-z.
  if ((camera.projectionMatrix[10] ?? 0) <= 0 || (camera.projectionMatrix[14] ?? 0) <= 0) {
    return undefined;
  }
  return runtimeDiagnostic(
    'NACHI_SCENE_DEPTH_REVERSE_Z_UNSUPPORTED',
    'collideSceneDepth() does not support a reverse-z projection matrix.',
    'System.projectionMatrix',
    'warning',
  );
}

function setUniform(
  renderer: VfxRuntimeRenderer,
  uniforms: Readonly<Record<string, KernelUniformNode>>,
  path: ParameterPath,
  value: unknown,
): void {
  const uniform = uniforms[path];
  if (!uniform) return;
  if (renderer.setUniformValue) renderer.setUniformValue(uniform, path, value);
  else uniform.value = value;
}

function splitDuration(duration: number, stepSeconds: number): number[] {
  const steps: number[] = [];
  let remaining = duration;
  while (remaining > stepSeconds + TIME_EPSILON) {
    steps.push(stepSeconds);
    remaining -= stepSeconds;
  }
  if (remaining > TIME_EPSILON) steps.push(remaining);
  return steps;
}

function maximumLifetime(program: CompiledEmitterProgram, definition: EmitterDefinition): number {
  let maximum = 0;
  const writers = [program.kernels.init, program.kernels.update]
    .flatMap(({ modules }) => modules)
    .filter(
      (module) => module.source === 'author' && module.access.writes.includes('Particles.lifetime'),
    );
  const nonKernelWriter = collectEmitterModules(definition).some(
    ({ module }) =>
      module.stage !== 'init' &&
      module.stage !== 'update' &&
      module.access?.writes.includes('Particles.lifetime') === true,
  );
  // An undeclared lifetime means an emitter may remain alive indefinitely. Likewise, an
  // arbitrary lifetime writer cannot be bounded safely from core/lifetime's known config.
  if (
    writers.length === 0 ||
    nonKernelWriter ||
    writers.some(({ type }) => type !== 'core/lifetime')
  ) {
    return Infinity;
  }
  for (const module of writers) {
    const input = (module.config as { value?: unknown }).value;
    if (typeof input === 'number' && Number.isFinite(input)) {
      maximum = Math.max(maximum, input);
      continue;
    }
    if (typeof input !== 'object' || input === null || !('kind' in input)) return Infinity;
    if (input.kind === 'range' && 'max' in input && typeof input.max === 'number') {
      maximum = Math.max(maximum, input.max);
      continue;
    }
    // Parameter generators may be overridden at spawn time or through a mutable User.* path,
    // so their upper bound is not statically provable from the emitter definition.
    if (input.kind === 'parameter') return Infinity;
    return Infinity;
  }
  return Math.max(0, maximum);
}

function vector3(input: PositionInput | undefined): readonly [number, number, number] {
  if (input === undefined) return [0, 0, 0];
  return 'x' in input ? [input.x, input.y, input.z] : input;
}

function quaternion(input: RotationInput | undefined): readonly [number, number, number, number] {
  if (input === undefined) return [0, 0, 0, 1];
  if (!('x' in input) && input.length === 4) return input;
  const euler = 'x' in input ? [input.x, input.y, input.z] : input;
  const [x, y, z] = euler.map((value) => value / 2);
  const sx = Math.sin(x!);
  const cx = Math.cos(x!);
  const sy = Math.sin(y!);
  const cy = Math.cos(y!);
  const sz = Math.sin(z!);
  const cz = Math.cos(z!);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function transformMatrix(
  position: PositionInput | undefined,
  rotation: RotationInput | undefined,
): readonly number[] {
  const [x, y, z, w] = quaternion(rotation);
  const [tx, ty, tz] = vector3(position);
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    1 - (yy + zz),
    xy + wz,
    xz - wy,
    0,
    xy - wz,
    1 - (xx + zz),
    yz + wx,
    0,
    xz + wy,
    yz - wx,
    1 - (xx + yy),
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function isParameterValue(type: AttributeType, value: unknown): boolean {
  const lengths: Partial<Record<AttributeType, number>> = {
    color: 4,
    mat3: 9,
    mat4: 16,
    quat: 4,
    vec2: 2,
    vec3: 3,
    vec4: 4,
  };
  if (type === 'bool') return typeof value === 'boolean';
  const length = lengths[type];
  if (length !== undefined) {
    return (
      Array.isArray(value) &&
      value.length === length &&
      value.every((component) => typeof component === 'number' && Number.isFinite(component))
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (type === 'i32')
    return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
  if (type === 'u32') return Number.isInteger(value) && value >= 0 && value <= 4_294_967_295;
  return true;
}

/** @internal Shared with composition runtimes that expose the core parameter contract. */
export function validateRuntimeParameter(
  definitions: ParameterSchema,
  path: string,
  value: unknown,
  requireMutable: boolean,
): VfxDiagnostic | undefined {
  const definition = definitions[path as ParameterPath];
  if (!definition) {
    return runtimeDiagnostic('NACHI_PARAMETER_UNKNOWN', `Unknown runtime parameter "${path}".`);
  }
  if (requireMutable && definition.mutable !== true) {
    return runtimeDiagnostic(
      'NACHI_PARAMETER_IMMUTABLE',
      `Runtime parameter "${path}" is immutable.`,
    );
  }
  if (!isParameterValue(definition.type, value)) {
    return runtimeDiagnostic(
      'NACHI_PARAMETER_TYPE_MISMATCH',
      `Runtime parameter "${path}" does not match ${definition.type}.`,
    );
  }
  return undefined;
}

function validateSpawnParameterOverrides(
  definitions: ParameterSchema,
  overrides: Readonly<Record<string, unknown>> | undefined,
): VfxDiagnostic[] {
  if (!overrides) return [];
  return Object.entries(overrides).flatMap(([path, value]) => {
    const parameterDiagnostic = validateRuntimeParameter(definitions, path, value, false);
    return parameterDiagnostic ? [parameterDiagnostic] : [];
  });
}

type SpawnAccumulator = { burstCycles: number; remainder: number };
type LogicalSpawnBatch = { readonly count: number; readonly expiresAt: number };

class RuntimeEmitter implements VfxEmitterRuntimeView {
  readonly controller: EmitterLifecycleController;
  readonly kernels: BuiltEmitterKernels;
  readonly program: CompiledEmitterProgram;
  readonly #aliveCountReadbackInterval: number | undefined;
  readonly #maxLifetime: number;
  readonly #onDiagnostic: (diagnostic: VfxDiagnostic) => void;
  readonly #onEventAggregate: (summary: EffectEventSummary) => void;
  readonly #parameters: Record<string, unknown>;
  readonly #renderer: VfxRuntimeRenderer;
  readonly #seed: number;
  readonly #spawnAccumulators = new Map<string, SpawnAccumulator>();
  #compactSequence = 0;
  #drainRemaining = 0;
  #emitterAge = 0;
  #emissionCompletedSequence: number | undefined;
  #exactAliveCount: number | undefined;
  #exactAliveSequence: number | undefined;
  #forceReadbackThisFrame = false;
  #initialized = false;
  #lastOverflowCount = 0;
  readonly #lastEventOverflow = new Map<string, number>();
  readonly #lastEventTotal = new Map<string, number>();
  #pendingDistance = 0;
  #pendingGpuSpawnRequested = 0;
  #logicalAliveEstimate = 0;
  readonly #logicalSpawnBatches: LogicalSpawnBatch[] = [];
  #simulationTime = 0;
  #spawnOrderRequestTotal = 0;
  #spawnOrderWrapWarned = false;
  #spawnGeneration = 0;
  #capacityScale = 1;
  #profileComputeDispatches = 0;
  #profileCpuUpdateMs = 0;
  // Draw materialization is observed by the following scheduler frame. This keeps captureProfile(),
  // which is FIFO-serialized immediately after update(), on the last completed render frame.
  #profileIndirectDraws: number | undefined;
  #profileSpawnCount = 0;
  #spawnRateScale = 1;
  #spawnSuppressed = false;
  #transform: readonly number[];

  constructor(
    readonly definition: EmitterDefinition,
    program: CompiledEmitterProgram,
    renderer: VfxRuntimeRenderer,
    seed: number,
    transform: readonly number[],
    parameters: Readonly<Record<string, unknown>>,
    maxLifetime: number,
    aliveCountReadbackInterval: number | undefined,
    onDiagnostic: (diagnostic: VfxDiagnostic) => void,
    eventOutputs: Readonly<Record<string, EventQueueResources>> = {},
    eventInputs: readonly EventInputBinding[] = [],
    onEventAggregate: (summary: EffectEventSummary) => void = () => undefined,
    reusedKernels?: BuiltEmitterKernels,
    qualityTier: QualityTier = 'epic',
  ) {
    this.program = program;
    this.#renderer = renderer;
    this.#seed = seed >>> 0;
    this.#transform = transform;
    this.#parameters = { ...parameters };
    this.#maxLifetime = maxLifetime;
    this.#aliveCountReadbackInterval = aliveCountReadbackInterval;
    this.#onDiagnostic = onDiagnostic;
    this.#onEventAggregate = onEventAggregate;
    this.controller = new EmitterLifecycleController(definition.lifecycle);
    this.kernels =
      reusedKernels ?? program.buildKernels(renderer.kernelAdapter, { eventInputs, eventOutputs });
    renderer.clearStorageReplayReady?.(this.kernels);
    this.setQualityTier(qualityTier);
    setUniform(renderer, this.kernels.uniforms, 'Emitter.seed', this.#seed);
    setUniform(renderer, this.kernels.uniforms, 'Emitter.transform', transform);
    for (const [path, value] of Object.entries(parameters)) {
      setUniform(renderer, this.kernels.uniforms, path as ParameterPath, value);
    }
  }

  get aliveCount(): number | undefined {
    return this.#exactAliveCount;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get lifecycleState(): EmitterLifecycleState {
    return this.controller.state;
  }

  get loopIndex(): number {
    return this.controller.loopIndex;
  }

  get spawnGeneration(): number {
    return this.#spawnGeneration;
  }

  get complete(): boolean {
    if (this.controller.state !== 'completed') return false;
    if (this.#aliveCountReadbackInterval !== undefined && this.#renderer.readStorage) {
      return (
        this.#exactAliveCount === 0 &&
        this.#exactAliveSequence !== undefined &&
        this.#emissionCompletedSequence !== undefined &&
        this.#exactAliveSequence >= this.#emissionCompletedSequence
      );
    }
    return this.#drainRemaining <= TIME_EPSILON;
  }

  get hasEventPipeline(): boolean {
    return this.program.events.length > 0 || this.kernels.eventInputs.length > 0;
  }

  get usesSceneDepth(): boolean {
    return this.program.kernels.update.modules.some(
      ({ type }) => type === 'core/collide-scene-depth',
    );
  }

  get alphaBlended(): boolean {
    return this.program.draws.some(
      (draw) =>
        (draw.kind === 'billboard' || draw.kind === 'mesh') &&
        (draw.fragment.blending === 'alpha' || draw.fragment.blending === 'premultiplied'),
    );
  }

  get particleSorted(): boolean {
    return this.program.draws.some(
      (draw) =>
        (draw.kind === 'billboard' || draw.kind === 'mesh') &&
        draw.indirect.physicalIndex === 'sorted-indices',
    );
  }

  get worldPosition(): readonly [number, number, number] {
    const draw = this.program.draws.find(
      (candidate) => candidate.kind === 'billboard' || candidate.kind === 'mesh',
    );
    const [x, y, z] = draw?.coarseSortCenter ?? [0, 0, 0];
    return [
      this.#transform[0]! * x +
        this.#transform[4]! * y +
        this.#transform[8]! * z +
        this.#transform[12]!,
      this.#transform[1]! * x +
        this.#transform[5]! * y +
        this.#transform[9]! * z +
        this.#transform[13]!,
      this.#transform[2]! * x +
        this.#transform[6]! * y +
        this.#transform[10]! * z +
        this.#transform[14]!,
    ];
  }

  get boundingSphere(): BoundingSphere {
    const bounds = this.definition.bounds ?? { center: [0, 0, 0] as const, radius: 1_000 };
    return transformBoundingSphere(
      { center: bounds.center ?? [0, 0, 0], radius: bounds.radius },
      this.#transform,
    );
  }

  get estimatedParticleCost(): number {
    return Math.max(0, Math.floor(this.definition.capacity * this.#capacityScale));
  }

  beginProfileFrame(): void {
    this.#profileComputeDispatches = 0;
    this.#profileCpuUpdateMs = 0;
    this.#profileSpawnCount = 0;
    this.#profileIndirectDraws =
      this.#renderer.kernelAdapter.capabilities.backend === 'webgpu' ? 0 : undefined;
  }

  markRenderable(): void {
    if (this.#profileIndirectDraws !== undefined) {
      // Draw objects are materialized by the host render integration between top-level updates, so
      // this sample describes the render frame completed before the current update/capture pair.
      this.#profileIndirectDraws = Math.max(
        0,
        this.#renderer.getRenderableIndirectDrawCount?.(this.kernels) ?? 0,
      );
    }
  }

  markNotRenderable(): void {
    if (this.#profileIndirectDraws !== undefined) this.#profileIndirectDraws = 0;
  }

  recordCpuUpdate(milliseconds: number): void {
    this.#profileCpuUpdateMs += milliseconds;
  }

  profileCounters(instanceId: string, emitterId: string): EmitterProfileCounters {
    return {
      aliveCount: this.#exactAliveCount,
      aliveReadbackEnabled:
        this.#aliveCountReadbackInterval !== undefined && this.#renderer.readStorage !== undefined,
      capacity: this.estimatedParticleCost,
      computeDispatches: this.#profileComputeDispatches,
      cpuUpdateMs: this.#profileCpuUpdateMs,
      emitterId,
      indirectDraws: this.#profileIndirectDraws,
      instanceId,
      spawnCount: this.#profileSpawnCount,
    };
  }

  captureAttributes(
    emitterId: string,
    options?: CaptureAttributesOptions,
  ): Promise<AttributeSnapshot> {
    return captureEmitterAttributes(this.#renderer, this, emitterId, options);
  }

  setRenderOrder(order: number): void {
    this.#renderer.setRenderOrder?.(this.kernels, order);
  }

  setQualityTier(tier: QualityTier): void {
    const quality = resolveEmitterQuality(this.definition, tier);
    this.#capacityScale = quality.capacityScale;
    this.#spawnRateScale = quality.spawnRateScale;
    setUniform(
      this.#renderer,
      this.kernels.uniforms,
      'Emitter.logicalCapacity',
      this.estimatedParticleCost,
    );
  }

  setScalability(spawnSuppressed: boolean, fade: number): void {
    this.#spawnSuppressed = spawnSuppressed;
    this.#renderer.setVisibility?.(this.kernels, fade > 0);
    setUniform(
      this.#renderer,
      this.kernels.uniforms,
      'System.visibility',
      Math.min(1, Math.max(0, fade)),
    );
  }

  beginFinalEventDrain(): void {
    if (this.kernels.eventInputs.length > 0 && this.#aliveCountReadbackInterval === undefined) {
      this.#drainRemaining = Math.max(this.#drainRemaining, this.#maxLifetime);
    }
  }

  setParameter(path: ParameterPath, value: unknown): void {
    this.#parameters[path] = value;
    setUniform(this.#renderer, this.kernels.uniforms, path, value);
  }

  setTransform(transform: readonly number[]): void {
    const dx = (transform[12] ?? 0) - (this.#transform[12] ?? 0);
    const dy = (transform[13] ?? 0) - (this.#transform[13] ?? 0);
    const dz = (transform[14] ?? 0) - (this.#transform[14] ?? 0);
    this.#pendingDistance += Math.hypot(dx, dy, dz);
    this.#transform = transform;
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.transform', transform);
  }

  setCamera(camera: VfxCameraState): void {
    setUniform(
      this.#renderer,
      this.kernels.uniforms,
      'System.projectionMatrix',
      camera.projectionMatrix,
    );
    setUniform(this.#renderer, this.kernels.uniforms, 'System.viewMatrix', camera.viewMatrix);
    setUniform(this.#renderer, this.kernels.uniforms, 'System.viewportSize', camera.viewportSize);
  }

  release(): void {
    this.#renderer.releaseKernels?.(this.kernels);
  }

  detachKernels(): BuiltEmitterKernels {
    return this.kernels;
  }

  prepareForPooling(): void {
    this.#renderer.setInstanceCount?.(this.kernels, 0);
    this.#renderer.prepareKernelsForPooling?.(this.kernels);
  }

  async #submitCompute(kernel: KernelComputeNode): Promise<void> {
    this.#profileComputeDispatches += 1;
    await this.#renderer.submitCompute(kernel);
  }

  async #submitComputeIndirect(kernel: KernelComputeNode, resource: unknown): Promise<void> {
    const submit = this.#renderer.submitComputeIndirect;
    if (!submit) throw new Error('Indirect compute submission is unavailable.');
    this.#profileComputeDispatches += 1;
    await submit.call(this.#renderer, kernel, resource);
  }

  async prepareEventFrame(writeBank: 0 | 1): Promise<void> {
    this.#forceReadbackThisFrame = false;
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.eventWriteBank', writeBank);
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.eventReadBank', 1 - writeBank);
    for (const output of Object.values(this.kernels.eventOutputs)) {
      await this.#submitCompute(output.reset);
    }
  }

  async consumeEvents(): Promise<void> {
    if (this.kernels.eventInputs.length > 0) this.#forceReadbackThisFrame = true;
    for (const input of this.kernels.eventInputs) {
      if (!this.#renderer.submitComputeIndirect) {
        throw new Error('M5 event consumption requires indirect compute submission.');
      }
      await this.#submitCompute(input.prepare);
      await this.#submitComputeIndirect(
        input.spawn,
        input.binding.resources.indirect.indirectResource,
      );
      await this.#submitCompute(input.finalize);
      this.#pendingGpuSpawnRequested += input.binding.queue.capacity;
    }
    if (this.kernels.eventInputs.length > 0) await this.#compactAlive();
  }

  async advance(deltaSeconds: number, context: AdvanceContext): Promise<void> {
    if (!this.#initialized) {
      await this.#submitCompute(this.kernels.initialize);
      this.#initialized = true;
      await this.#compactAlive();
    }
    const commands = this.controller.advance(deltaSeconds);
    let updated = false;
    for (const command of commands) {
      if (command.kind === 'activate') {
        this.#spawnGeneration = command.spawnGeneration;
        this.#emitterAge = 0;
        this.#drainRemaining = 0;
        this.#emissionCompletedSequence = undefined;
        this.#pendingDistance = 0;
        this.#resetSpawnAccumulators();
        this.#setFrameUniforms(0, context, command.loopIndex);
        setUniform(
          this.#renderer,
          this.kernels.uniforms,
          'Emitter.spawnGeneration',
          command.spawnGeneration,
        );
        await this.#dispatchSpawn(this.#activationSpawnCount());
        await this.#compactAlive();
      } else if (command.kind === 'complete') {
        this.#drainRemaining = this.#maxLifetime;
        this.#emissionCompletedSequence = this.#compactSequence;
        await this.#compactAlive(true);
      } else {
        const steps = command.prewarm
          ? splitDuration(command.deltaSeconds, context.prewarmStepSeconds)
          : [command.deltaSeconds];
        for (const requestedStep of steps) {
          const step =
            command.phase === 'drain'
              ? Math.min(requestedStep, this.#drainRemaining)
              : requestedStep;
          if (step <= TIME_EPSILON) continue;
          this.#setFrameUniforms(
            step,
            context,
            command.loopIndex,
            command.prewarm ? step : context.systemDelta,
          );
          if (command.phase === 'active') {
            await this.#dispatchSpawn(this.#stepSpawnCount(step, this.#pendingDistance));
            this.#pendingDistance = 0;
          }
          await this.#submitCompute(this.kernels.update);
          updated = true;
          this.#emitterAge += step;
          this.#simulationTime += step;
          setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.age', this.#emitterAge);
          setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.localTime', this.#emitterAge);
          if (command.phase === 'drain') {
            this.#drainRemaining = Math.max(0, this.#drainRemaining - step);
          }
          await this.#compactAlive();
        }
      }
    }
    // Event targets keep simulating records received after their authored spawn lifecycle has
    // entered drain/completed state. Event consumption above compacts births even for dt=0.
    if (!updated && this.kernels.eventInputs.length > 0 && deltaSeconds > TIME_EPSILON) {
      this.#setFrameUniforms(deltaSeconds, context, this.controller.loopIndex);
      await this.#submitCompute(this.kernels.update);
      this.#emitterAge += deltaSeconds;
      this.#simulationTime += deltaSeconds;
      this.#drainRemaining = Math.max(0, this.#drainRemaining - deltaSeconds);
      await this.#compactAlive();
    }
  }

  #activationSpawnCount(): number {
    let count = 0;
    for (const module of this.program.spawn.modules) {
      if (module.type !== 'core/burst') continue;
      count += Math.floor(this.#burstCount(module) * this.#spawnRateScale);
      const accumulator = this.#accumulator(module);
      accumulator.burstCycles = 1;
    }
    return count;
  }

  #stepSpawnCount(deltaSeconds: number, distance: number): number {
    let count = 0;
    const nextAge = this.#emitterAge + deltaSeconds;
    for (const module of this.program.spawn.modules) {
      const accumulator = this.#accumulator(module);
      if (module.type === 'core/rate') {
        const rate = (module.config as { rate: number }).rate * this.#spawnRateScale;
        const exact = accumulator.remainder + rate * deltaSeconds;
        const emitted = Math.floor(exact + TIME_EPSILON);
        accumulator.remainder = exact - emitted;
        count += emitted;
      } else if (module.type === 'core/per-distance') {
        const rate = (module.config as { rate: number }).rate * this.#spawnRateScale;
        const exact = accumulator.remainder + rate * distance;
        const emitted = Math.floor(exact + TIME_EPSILON);
        accumulator.remainder = exact - emitted;
        count += emitted;
      } else if (module.type === 'core/burst') {
        const config = module.config as { cycles?: number; interval?: number };
        const cycles = config.cycles ?? 1;
        const interval = config.interval ?? Infinity;
        while (
          accumulator.burstCycles < cycles &&
          accumulator.burstCycles * interval <= nextAge + TIME_EPSILON
        ) {
          count += Math.floor(this.#burstCount(module) * this.#spawnRateScale);
          accumulator.burstCycles += 1;
        }
      }
    }
    return count;
  }

  #burstCount(module: CompiledSpawnModule): number {
    const input = (module.config as { count: unknown }).count;
    let value = 0;
    if (typeof input === 'number') value = input;
    else if (typeof input === 'object' && input !== null && 'kind' in input) {
      if (input.kind === 'parameter' && 'path' in input && typeof input.path === 'string') {
        const resolved = this.#parameters[input.path];
        const fallback = 'fallback' in input ? input.fallback : undefined;
        value =
          typeof resolved === 'number' ? resolved : typeof fallback === 'number' ? fallback : 0;
      } else if (
        input.kind === 'range' &&
        'min' in input &&
        'max' in input &&
        typeof input.min === 'number' &&
        typeof input.max === 'number'
      ) {
        const random = pcgRandomFloat(
          0,
          this.#seed,
          resolveRandomSampleSlot(module.slot),
          this.#spawnGeneration,
        );
        value = input.min + (input.max - input.min) * random;
      }
    }
    return Math.max(0, Math.floor(value));
  }

  #accumulator(module: CompiledSpawnModule): SpawnAccumulator {
    let value = this.#spawnAccumulators.get(module.path);
    if (!value) {
      value = { burstCycles: 0, remainder: 0 };
      this.#spawnAccumulators.set(module.path, value);
    }
    return value;
  }

  #resetSpawnAccumulators(): void {
    this.#spawnAccumulators.clear();
  }

  async #dispatchSpawn(requestedCount: number): Promise<void> {
    if (requestedCount <= 0 || this.#spawnSuppressed) return;
    // Never encode more spawn invocations than physical slots. The GPU overflow counter handles
    // lower free-list availability; this clamp also makes malformed/extreme requests safe.
    const logicalCapacity = Math.floor(this.definition.capacity * this.#capacityScale);
    this.#expireLogicalSpawnBatches();
    // Full-quality behavior remains the physical allocator contract. In particular, an opt-in
    // alive readback from an earlier frame must never reject a valid request at physical capacity.
    const logicalAvailability =
      logicalCapacity === this.definition.capacity
        ? this.definition.capacity
        : Math.max(0, logicalCapacity - this.#logicalAliveEstimate);
    const dispatchCount = Math.min(requestedCount, this.definition.capacity, logicalAvailability);
    if (dispatchCount <= 0) return;
    this.#profileSpawnCount += dispatchCount;
    this.#recordLogicalSpawn(dispatchCount);
    const cpuOverflow = Math.max(0, requestedCount - dispatchCount);
    if (cpuOverflow > 0 && logicalCapacity === this.definition.capacity) {
      this.#reportOverflow(requestedCount, cpuOverflow);
    }
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.spawnCount', dispatchCount);
    if (this.kernels.capabilityPath === 'webgpu-atomic-indirect') {
      const { finalizeSpawn, prepareSpawn, spawnDispatch } = this.kernels;
      if (
        !prepareSpawn ||
        !finalizeSpawn ||
        !spawnDispatch ||
        !this.#renderer.submitComputeIndirect
      ) {
        throw new Error('WebGPU lifecycle kernels require indirect compute submission.');
      }
      await this.#submitCompute(prepareSpawn);
      await this.#submitComputeIndirect(this.kernels.spawn, spawnDispatch.indirectResource);
      await this.#submitCompute(finalizeSpawn);
      this.#pendingGpuSpawnRequested += dispatchCount;
      if (this.program.attributeSchema.byName.spawnOrder !== undefined) {
        this.#trackSpawnOrderRequests(dispatchCount);
      }
    } else {
      await this.#submitCompute(this.kernels.spawn);
    }
  }

  #expireLogicalSpawnBatches(): void {
    while ((this.#logicalSpawnBatches[0]?.expiresAt ?? Infinity) <= this.#simulationTime) {
      const batch = this.#logicalSpawnBatches.shift()!;
      this.#logicalAliveEstimate = Math.max(0, this.#logicalAliveEstimate - batch.count);
    }
  }

  #recordLogicalSpawn(count: number): void {
    this.#logicalAliveEstimate += count;
    this.#logicalSpawnBatches.push({
      count,
      expiresAt: this.#simulationTime + this.#maxLifetime,
    });
  }

  #resetLogicalAliveEstimate(count: number): void {
    this.#logicalAliveEstimate = count;
    this.#logicalSpawnBatches.length = 0;
    if (count > 0) {
      this.#logicalSpawnBatches.push({
        count,
        expiresAt: this.#simulationTime + this.#maxLifetime,
      });
    }
  }

  #reportOverflow(requestedCount: number, overflow: number): void {
    this.#onDiagnostic({
      code: 'NACHI_SPAWN_CAPACITY_EXCEEDED',
      message: `Spawn requests of up to ${requestedCount} exceeded available capacity; ${overflow} particle(s) were safely dropped.`,
      phase: 'runtime',
      severity: 'warning',
    });
  }

  async #compactAlive(forceReadback = this.#forceReadbackThisFrame): Promise<void> {
    this.#compactSequence += 1;
    if (this.kernels.capabilityPath === 'webgpu-atomic-indirect') {
      const { compact, finalizeIndirect, resetAliveCount } = this.kernels;
      if (!compact || !finalizeIndirect || !resetAliveCount) {
        throw new Error('WebGPU lifecycle compaction kernels are missing.');
      }
      await this.#submitCompute(resetAliveCount);
      await this.#submitCompute(compact);
      await this.#submitCompute(finalizeIndirect);
      if (this.kernels.prepareSort) {
        await this.#submitCompute(this.kernels.prepareSort);
        // Each bitonic stage depends on all writes from the preceding stage. Keep stage boundaries
        // as distinct backend submissions: a single Three.js compute group records every dispatch
        // into one compute pass and provides no whole-grid storage barrier between them.
        for (const pass of this.kernels.sortPasses ?? []) {
          await this.#submitCompute(pass);
        }
      }
      if (
        this.#renderer.readStorage &&
        this.#aliveCountReadbackInterval !== undefined &&
        (forceReadback || this.#compactSequence % this.#aliveCountReadbackInterval === 0)
      ) {
        const counters = new Uint32Array(await this.#renderer.readStorage(this.kernels.aliveCount));
        this.#exactAliveCount = counters[this.kernels.counterOffsets.aliveCount] ?? 0;
        this.#resetLogicalAliveEstimate(this.#exactAliveCount);
        this.#exactAliveSequence = this.#compactSequence;
        const overflowCount = counters[this.kernels.counterOffsets.spawnOverflow] ?? 0;
        const overflow = (overflowCount - this.#lastOverflowCount) >>> 0;
        this.#lastOverflowCount = overflowCount;
        if (overflow > 0) {
          this.#reportOverflow(this.#pendingGpuSpawnRequested, overflow);
        }
        this.#pendingGpuSpawnRequested = 0;
        if (
          this.program.attributeSchema.byName.spawnOrder !== undefined &&
          (counters[this.kernels.nextSpawnOrderOffset] ?? 0) >= SPAWN_ORDER_WRAP_WARNING_THRESHOLD
        ) {
          this.#warnSpawnOrderWrapRisk();
        }
        for (const [eventName, output] of Object.entries(this.kernels.eventOutputs)) {
          const state = new Uint32Array(await this.#renderer.readStorage(output.state));
          const total = state[3] ?? 0;
          const previousTotal = this.#lastEventTotal.get(eventName) ?? 0;
          const emitted = (total - previousTotal) >>> 0;
          this.#lastEventTotal.set(eventName, total);
          if (emitted > 0) {
            this.#onEventAggregate({
              count: emitted,
              event:
                eventName === 'onDeath'
                  ? 'death'
                  : eventName === 'onCollision'
                    ? 'collision'
                    : eventName,
            });
          }
          const overflowTotal = state[2] ?? 0;
          const previousOverflow = this.#lastEventOverflow.get(eventName) ?? 0;
          const eventOverflow = (overflowTotal - previousOverflow) >>> 0;
          this.#lastEventOverflow.set(eventName, overflowTotal);
          if (eventOverflow > 0) {
            this.#onDiagnostic({
              code: 'NACHI_EVENT_QUEUE_OVERFLOW',
              message: `${eventName} append queue reached capacity ${output.queue.capacity}; ${eventOverflow} event(s) were safely dropped.`,
              path: `events.${eventName}`,
              phase: 'runtime',
              severity: 'warning',
            });
          }
        }
      }
    } else if (this.#renderer.readStorage) {
      const alive = this.kernels.storages.alive;
      if (!alive) return;
      const flags = new Uint32Array(await this.#renderer.readStorage(alive));
      const aliveAttribute = this.program.attributeSchema.byName.alive;
      if (!aliveAttribute) throw new Error('Compiled logical attribute alive is missing.');
      const aliveStorage =
        this.program.attributeSchema.storageArrays[aliveAttribute.physical.bufferIndex];
      if (!aliveStorage) throw new Error('Compiled physical storage for alive is missing.');
      let count = 0;
      for (let particle = 0; particle < this.program.attributeSchema.capacity; particle += 1) {
        if (
          (flags[
            attributeStorageComponentIndex(aliveAttribute, aliveStorage, 'webgl2', particle, 0)
          ] ?? 0) !== 0
        ) {
          count += 1;
        }
      }
      this.#exactAliveCount = count;
      this.#resetLogicalAliveEstimate(count);
      this.#exactAliveSequence = this.#compactSequence;
      this.#renderer.setInstanceCount?.(this.kernels, count);
    }
  }

  #setFrameUniforms(
    deltaSeconds: number,
    context: AdvanceContext,
    loopIndex: number,
    systemDelta = context.systemDelta,
  ): void {
    setUniform(this.#renderer, this.kernels.uniforms, 'System.time', context.systemTime);
    setUniform(this.#renderer, this.kernels.uniforms, 'System.deltaTime', systemDelta);
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.age', this.#emitterAge);
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.deltaTime', deltaSeconds);
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.localTime', this.#emitterAge);
    setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.loopIndex', loopIndex);
  }

  #trackSpawnOrderRequests(requested: number): void {
    const previous = this.#spawnOrderRequestTotal;
    this.#spawnOrderRequestTotal = Math.min(Number.MAX_SAFE_INTEGER, previous + requested);
    if (crossesSpawnOrderWarningThreshold(previous, requested)) this.#warnSpawnOrderWrapRisk();
  }

  #warnSpawnOrderWrapRisk(): void {
    if (this.#spawnOrderWrapWarned) return;
    this.#spawnOrderWrapWarned = true;
    this.#onDiagnostic({
      code: 'NACHI_SPAWN_ORDER_WRAP_RISK',
      message:
        'Spawn-order usage has reached the conservative u32 half-range safety threshold; restart this emitter before wrap can invalidate birth-ring ordering.',
      path: 'Particles.spawnOrder',
      phase: 'runtime',
      severity: 'warning',
    });
  }
}

type ReleasableEffectInstance = {
  readonly definition: RuntimeEffectDefinition;
  readonly id: string;
  readonly poolKey: string;
  detachEmitterKernels(): ReadonlyMap<string, BuiltEmitterKernels>;
  recordDiagnostic(diagnostic: VfxDiagnostic): void;
  recordReleaseDiagnostic(diagnostic: VfxDiagnostic): void;
  releaseEmitterKernels(): void;
  takeEmitterKernelsForPooling(): ReadonlyMap<string, BuiltEmitterKernels>;
};

type CaptureScheduler = <Value>(capture: () => Promise<Value> | Value) => Promise<Value>;

export class VfxEffectInstance<
  Definition extends RuntimeEffectDefinition = RuntimeEffectDefinition,
> implements EffectInstance<Definition> {
  readonly clock: EffectClock;
  readonly debug: EffectInstanceDebug;
  readonly #diagnostics: VfxDiagnostic[] = [];
  readonly #diagnosticKeys = new Set<string>();
  readonly #emitters = new Map<string, RuntimeEmitter>();
  readonly #eventListeners = new Map<string, Set<EffectEventCallback>>();
  readonly #onRelease: (instance: ReleasableEffectInstance, poolable: boolean) => void;
  readonly #now: () => number;
  readonly #parameterDefinitions: ParameterSchema;
  readonly #priority: number;
  readonly #scheduleCapture: CaptureScheduler;
  #scalability: EffectScalabilityStatus = {
    action: 'full',
    fade: 1,
    reasons: [],
    score: 0,
    significance: {
      distance: 0,
      distanceScore: 1,
      priority: 0,
      priorityScore: 0,
      screenOccupancy: 1,
      screenScore: 2,
    },
  };
  #state: EffectInstanceState = 'active';
  #eventFrame = 0;
  #completionCandidateFrame: number | undefined;
  #eventDrainFrames = 0;
  #eventDrainExtended = false;
  #initialized = false;
  #attachment: EffectTransformSource | undefined;

  constructor(
    readonly definition: Definition,
    readonly id: string,
    readonly poolKey: string,
    timeScale: number,
    parameterDefinitions: ParameterSchema,
    onRelease: (instance: ReleasableEffectInstance, poolable: boolean) => void,
    priority = 0,
    now: () => number = () => globalThis.performance?.now() ?? Date.now(),
    scheduleCapture: CaptureScheduler = (capture) => Promise.resolve().then(capture),
  ) {
    this.clock = new EffectClock(timeScale);
    this.#parameterDefinitions = parameterDefinitions;
    this.#onRelease = onRelease;
    this.#priority = priority;
    this.#scheduleCapture = scheduleCapture;
    this.#now = now;
    this.debug = {
      captureAttributes: (emitterId, options) => this.#captureAttributes(emitterId, options),
    };
  }

  get diagnostics(): readonly VfxDiagnostic[] {
    return this.#diagnostics;
  }

  get localTime(): number {
    return this.clock.localTime;
  }

  get state(): EffectInstanceState {
    return this.#state;
  }

  get scalability(): EffectScalabilityStatus {
    return this.#scalability;
  }

  get timeScale(): number {
    return this.clock.timeScale;
  }

  get usesSceneDepth(): boolean {
    return [...this.#emitters.values()].some((emitter) => emitter.usesSceneDepth);
  }

  addEmitter(key: string, emitter: RuntimeEmitter): void {
    this.#emitters.set(key, emitter);
  }

  get boundingSphere(): BoundingSphere {
    return mergeBoundingSpheres(
      [...this.#emitters.values()].map((emitter) => emitter.boundingSphere),
    );
  }

  get estimatedParticleCost(): number {
    return [...this.#emitters.values()].reduce(
      (total, emitter) => total + emitter.estimatedParticleCost,
      0,
    );
  }

  evaluateScalability(camera: VfxCameraState, cameraConfigured: boolean): EffectScalabilityStatus {
    const sphere = this.boundingSphere;
    const configuredPriority = this.definition.scalability?.significance?.priority ?? 0;
    const significance = significanceScore({
      camera,
      priority: configuredPriority + this.#priority,
      sphere,
    });
    const culling = this.definition.scalability?.culling;
    const reasons: string[] = [];
    let fade = 1;
    if (culling?.distance) {
      const { fadeEnd } = culling.distance;
      const fadeStart = culling.distance.fadeStart ?? fadeEnd;
      if (significance.distance >= fadeEnd) {
        fade = 0;
        reasons.push('distance');
      } else if (significance.distance > fadeStart) {
        fade = 1 - (significance.distance - fadeStart) / (fadeEnd - fadeStart);
        reasons.push('distance-fade');
      }
    }
    if ((culling?.frustum ?? culling !== undefined) && cameraConfigured) {
      if (!sphereIntersectsFrustum(sphere, camera)) {
        fade = 0;
        reasons.push('frustum');
      }
    }
    return {
      action: fade <= 0 ? 'culled' : 'full',
      fade,
      reasons,
      score: significance.score,
      significance,
    };
  }

  applyScalability(status: EffectScalabilityStatus): void {
    this.#scalability = status;
    for (const emitter of this.#emitters.values()) {
      emitter.setScalability(status.action === 'spawn-suppressed', status.fade);
    }
  }

  setQualityTier(tier: QualityTier): void {
    for (const emitter of this.#emitters.values()) emitter.setQualityTier(tier);
  }

  /** @internal Supplies stable emitter keys to VFXSystem's coarse transparency sort. */
  transparencyEmitters(): readonly (readonly [string, RuntimeEmitter])[] {
    return [...this.#emitters.entries()].filter(([, emitter]) => emitter.alphaBlended);
  }

  setEventDrainFrames(frames: number): void {
    this.#eventDrainFrames = frames;
  }

  getEmitter(key: string): VfxEmitterRuntimeView | undefined {
    this.#assertNotReleased();
    return this.#emitters.get(key);
  }

  beginProfileFrame(): void {
    for (const emitter of this.#emitters.values()) emitter.beginProfileFrame();
  }

  profileCounters(): readonly EmitterProfileCounters[] {
    return [...this.#emitters.entries()].map(([emitterId, emitter]) =>
      emitter.profileCounters(this.id, emitterId),
    );
  }

  async #captureAttributes(
    emitterId: string,
    options?: CaptureAttributesOptions,
  ): Promise<AttributeSnapshot> {
    return this.#scheduleCapture(async () => {
      this.#assertNotReleased();
      const emitter = this.#emitters.get(emitterId);
      if (!emitter) {
        throw new VfxDiagnosticError([
          runtimeDiagnostic(
            'NACHI_DEBUG_EMITTER_UNKNOWN',
            `Effect instance "${this.id}" has no emitter "${emitterId}".`,
            'emitterId',
          ),
        ]);
      }
      return emitter.captureAttributes(emitterId, options);
    });
  }

  async #measureEmitter(emitter: RuntimeEmitter, operation: () => Promise<void>): Promise<void> {
    const start = this.#now();
    try {
      await operation();
    } finally {
      emitter.recordCpuUpdate(Math.max(0, this.#now() - start));
    }
  }

  applyHitStop(durationMs: number, timeScale = 0): void {
    this.#assertNotReleased();
    if (this.#state !== 'active') return;
    this.clock.applyHitStop(durationMs, timeScale);
  }

  attachTo(source: EffectTransformSource): void {
    this.#assertNotReleased();
    this.#attachment = source;
    this.syncAttachment();
  }

  detach(): void {
    this.#assertNotReleased();
    this.#attachment = undefined;
  }

  syncAttachment(): void {
    const transform = this.#attachment?.getWorldTransform();
    if (transform) this.setTransform(transform.position, transform.rotation);
  }

  on(event: string, callback: EffectEventCallback): () => void {
    this.#assertNotReleased();
    let listeners = this.#eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  emitEventSummary(summary: EffectEventSummary): void {
    if (this.#state === 'released') return;
    for (const callback of this.#eventListeners.get(summary.event) ?? []) callback(summary);
  }

  release(): void {
    if (this.#state === 'released') return;
    const poolable = this.#state !== 'error';
    this.#eventListeners.clear();
    this.#onRelease(this, poolable);
    this.#state = 'released';
  }

  /** @internal Transfers materialized resources to VFXSystem's pool without exposing them publicly. */
  detachEmitterKernels(): ReadonlyMap<string, BuiltEmitterKernels> {
    const kernels = new Map(
      [...this.#emitters.entries()].map(
        ([key, emitter]) => [key, emitter.detachKernels()] as const,
      ),
    );
    this.#emitters.clear();
    return kernels;
  }

  /** @internal Retires renderer-visible draw state before transferring kernels into the pool. */
  takeEmitterKernelsForPooling(): ReadonlyMap<string, BuiltEmitterKernels> {
    for (const emitter of this.#emitters.values()) emitter.prepareForPooling();
    return this.detachEmitterKernels();
  }

  /** @internal Releases materialized resources when this instance cannot enter the pool. */
  releaseEmitterKernels(): void {
    for (const emitter of this.#emitters.values()) emitter.release();
    this.#emitters.clear();
  }

  setParameter<Path extends UserParameterKeys<Definition>>(
    path: Path,
    value: DefinitionParameterValue<Definition, Path>,
  ): void {
    this.#assertNotReleased();
    const parameterDiagnostic = validateRuntimeParameter(
      this.#parameterDefinitions,
      String(path),
      value,
      true,
    );
    if (parameterDiagnostic) throw new VfxDiagnosticError([parameterDiagnostic]);
    for (const emitter of this.#emitters.values()) {
      emitter.setParameter(path as ParameterPath, value);
    }
  }

  setTimeScale(timeScale: number): void {
    this.#assertNotReleased();
    this.clock.setTimeScale(timeScale);
  }

  setTransform(position: PositionInput, rotation?: RotationInput): void {
    this.#assertNotReleased();
    const transform = transformMatrix(position, rotation);
    for (const emitter of this.#emitters.values()) emitter.setTransform(transform);
  }

  setCamera(camera: VfxCameraState): void {
    for (const emitter of this.#emitters.values()) emitter.setCamera(camera);
  }

  stop(): void {
    this.#assertNotReleased();
    if (this.#state === 'active') {
      this.#state = 'stopped';
      for (const emitter of this.#emitters.values()) emitter.markNotRenderable();
    }
  }

  markError(diagnostic: VfxDiagnostic): void {
    if (this.#state === 'released') return;
    this.#diagnostics.push(diagnostic);
    this.#state = 'error';
  }

  recordDiagnostic(diagnostic: VfxDiagnostic): void {
    if (this.#state !== 'released') this.#diagnostics.push(diagnostic);
  }

  /** @internal Pool-limit diagnostics may be finalized after an in-flight update becomes safe. */
  recordReleaseDiagnostic(diagnostic: VfxDiagnostic): void {
    this.#diagnostics.push(diagnostic);
  }

  recordDiagnosticOnce(diagnostic: VfxDiagnostic, key = diagnostic.code): void {
    if (this.#state === 'released' || this.#diagnosticKeys.has(key)) return;
    this.#diagnosticKeys.add(key);
    this.#diagnostics.push(diagnostic);
  }

  async initialize(systemTime: number, prewarmStepSeconds: number): Promise<void> {
    if (this.#state !== 'active' || this.#initialized) return;
    const context = {
      prewarmStepSeconds,
      systemDelta: 0,
      systemTime,
    };
    // Initialization/prewarm is itself an event-producing frame. Preserve its bank so the first
    // externally advanced frame consumes it instead of clearing it.
    for (const emitter of this.#emitters.values()) {
      await this.#measureEmitter(emitter, () => emitter.prepareEventFrame(0));
    }
    this.#eventFrame = 1;
    for (const emitter of this.#emitters.values()) {
      await this.#measureEmitter(emitter, () => emitter.advance(0, context));
    }
    this.#initialized = true;
    this.#completeIfFinished();
    if (this.#state === 'active') {
      for (const emitter of this.#emitters.values()) emitter.markRenderable();
    }
  }

  async advance(worldDelta: number, systemTime: number, prewarmStepSeconds: number): Promise<void> {
    if (this.#state !== 'active') return;
    const localDelta = this.clock.advance(worldDelta);
    const context = {
      prewarmStepSeconds,
      systemDelta: worldDelta,
      systemTime,
    };
    const writeBank = (this.#eventFrame & 1) as 0 | 1;
    this.#eventFrame += 1;
    for (const emitter of this.#emitters.values()) {
      await this.#measureEmitter(emitter, () => emitter.prepareEventFrame(writeBank));
    }
    for (const emitter of this.#emitters.values()) {
      await this.#measureEmitter(emitter, () => emitter.consumeEvents());
    }
    for (const emitter of this.#emitters.values()) {
      await this.#measureEmitter(emitter, () => emitter.advance(localDelta, context));
    }
    this.#completeIfFinished();
    for (const emitter of this.#emitters.values()) {
      if (this.#state === 'active' && localDelta > TIME_EPSILON) emitter.markRenderable();
      else if (this.#state !== 'active') emitter.markNotRenderable();
    }
  }

  #completeIfFinished(): void {
    if (this.#state !== 'active') return;
    const emitters = [...this.#emitters.values()];
    if (!emitters.every((emitter) => emitter.complete)) {
      this.#completionCandidateFrame = undefined;
      return;
    }
    if (emitters.some((emitter) => emitter.hasEventPipeline)) {
      if (!this.#eventDrainExtended) {
        for (const emitter of emitters) emitter.beginFinalEventDrain();
        this.#eventDrainExtended = true;
        if (!emitters.every((emitter) => emitter.complete)) return;
      }
      if (this.#completionCandidateFrame === undefined) {
        this.#completionCandidateFrame = this.#eventFrame;
        return;
      }
      if (this.#eventFrame < this.#completionCandidateFrame + this.#eventDrainFrames) return;
    }
    this.#state = 'complete';
  }

  #assertNotReleased(): void {
    if (this.#state !== 'released') return;
    throw new VfxDiagnosticError([
      runtimeDiagnostic(
        'NACHI_INSTANCE_RELEASED',
        `Effect instance "${this.id}" has been released and can no longer be used.`,
      ),
    ]);
  }
}

function effectParameters(
  definitions: ParameterSchema,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(definitions).map(([path, definition]) => [
      path,
      overrides && path in overrides ? overrides[path] : definition.default,
    ]),
  );
}

export class VFXSystem<Renderer = unknown, Scene = unknown> {
  readonly debug: VfxSystemDebug;
  readonly #aliveCountReadbackInterval: number | undefined;
  readonly #compiledEffects = new WeakMap<RuntimeEffectDefinition, Map<string, CompiledEffect>>();
  readonly #effectPools = new WeakMap<RuntimeEffectDefinition, Map<string, EffectResourcePool>>();
  readonly #fixedStep: FixedStepAccumulator | undefined;
  readonly #instances = new Map<string, VfxEffectInstance<RuntimeEffectDefinition>>();
  readonly #now: () => number;
  readonly #maxPoolSize: number;
  readonly #prewarmStepSeconds: number;
  readonly #registry: KernelModuleRegistry | undefined;
  readonly #significanceBudget: Required<VfxSignificanceBudget>;
  readonly #budgetAdmittedInstances = new Set<string>();
  #cameraState: VfxCameraState = DEFAULT_CAMERA_STATE;
  #cameraConfigured = false;
  #compilationCount = 0;
  #deviceLossDiagnostic?: VfxDiagnostic;
  #instanceSequence = 0;
  #lastTimestamp?: number;
  #qualitySelection: QualityTierSelection;
  #profileFrame = 0;
  #systemTime = 0;
  #updateQueue: Promise<void> = Promise.resolve();
  #updateInFlight = false;

  constructor(
    readonly renderer: Renderer,
    readonly scene?: Scene,
    options: VfxSystemOptions = {},
  ) {
    this.#aliveCountReadbackInterval = options.aliveCountReadbackInterval;
    this.#registry = options.registry;
    const runtimeRenderer = asRuntimeRenderer(renderer);
    const automaticSelection = selectDeviceQualityTier(
      options.deviceProfile ?? {
        backend: runtimeRenderer?.kernelAdapter.capabilities.backend ?? 'webgl2',
        features: [],
        limits: runtimeRenderer?.kernelAdapter.deviceLimits ?? {},
      },
    );
    const configuredTier = options.qualityTier ?? 'epic';
    this.#qualitySelection =
      configuredTier !== 'auto'
        ? {
            ...automaticSelection,
            reasons: [`VFXSystem qualityTier selected ${configuredTier}.`],
            source: 'override',
            tier: configuredTier,
          }
        : automaticSelection;
    this.#significanceBudget = {
      maxActiveInstances: options.significanceBudget?.maxActiveInstances ?? Number.MAX_SAFE_INTEGER,
      maxParticles: options.significanceBudget?.maxParticles ?? Number.MAX_SAFE_INTEGER,
    };
    for (const [name, value] of Object.entries(this.#significanceBudget)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`significanceBudget.${name} must be a non-negative safe integer.`);
      }
    }
    this.#maxPoolSize = options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE;
    if (!Number.isSafeInteger(this.#maxPoolSize) || this.#maxPoolSize < 0) {
      throw new RangeError('maxPoolSize must be a non-negative safe integer.');
    }
    if (
      this.#aliveCountReadbackInterval !== undefined &&
      (!Number.isSafeInteger(this.#aliveCountReadbackInterval) ||
        this.#aliveCountReadbackInterval <= 0)
    ) {
      throw new RangeError('aliveCountReadbackInterval must be a positive safe integer.');
    }
    this.#fixedStep = options.fixedTimeStep
      ? new FixedStepAccumulator(options.fixedTimeStep)
      : undefined;
    this.#prewarmStepSeconds =
      options.prewarmStepSeconds ??
      options.fixedTimeStep?.stepSeconds ??
      DEFAULT_PREWARM_STEP_SECONDS;
    requireNonNegativeFinite(this.#prewarmStepSeconds, 'prewarmStepSeconds');
    if (this.#prewarmStepSeconds === 0) {
      throw new RangeError('prewarmStepSeconds must be greater than zero.');
    }
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.debug = {
      captureProfile: (captureOptions) => this.#captureProfile(captureOptions),
    };

    if (runtimeRenderer?.deviceLost) {
      void runtimeRenderer.deviceLost.then(
        (info) => this.#handleDeviceLoss(info),
        (error) =>
          this.#handleDeviceLoss({
            message: error instanceof Error ? error.message : String(error),
            reason: 'rejected',
          }),
      );
    }
  }

  get compilationCount(): number {
    return this.#compilationCount;
  }

  get instanceCount(): number {
    return this.#instances.size;
  }

  get qualitySelection(): QualityTierSelection {
    return this.#qualitySelection;
  }

  /** True when update deltas are routed through this system's fixed-step accumulator. */
  get usesFixedTimeStep(): boolean {
    return this.#fixedStep !== undefined;
  }

  setQualityTier(tier: QualityTier): void {
    if (!['low', 'medium', 'high', 'epic'].includes(tier)) {
      throw new RangeError(`Unknown quality tier ${String(tier)}.`);
    }
    const previous = this.#qualitySelection.tier;
    if (previous === tier) return;
    this.#qualitySelection = {
      ...this.#qualitySelection,
      reasons: [`Runtime quality override selected ${tier}.`],
      source: 'override',
      tier,
    };
    for (const instance of this.#instances.values()) {
      instance.setQualityTier(tier);
      if (
        this.#qualityPoolKey(instance.definition, previous) !==
        this.#qualityPoolKey(instance.definition, tier)
      ) {
        instance.recordDiagnosticOnce(
          runtimeDiagnostic(
            'NACHI_QUALITY_RESTART_REQUIRED',
            `Quality ${previous} -> ${tier} changed a compiled soft/lit/sorted gate. Runtime spawn/capacity scales changed immediately; compiled rendering changes on the next spawn.`,
            'VFXSystem.qualityTier',
            'warning',
          ),
          `NACHI_QUALITY_RESTART_REQUIRED:${tier}`,
        );
      }
    }
  }

  getPooledInstanceCount<
    const Elements extends EffectElements,
    const Parameters extends ParameterSchema,
  >(definition: EffectDefinition<Elements, Parameters>): number {
    return (
      this.#effectPools
        .get(definition as RuntimeEffectDefinition)
        ?.get(
          this.#qualityPoolKey(definition as RuntimeEffectDefinition, this.#qualitySelection.tier),
        )?.resources.length ?? 0
    );
  }

  get time(): number {
    return this.#systemTime;
  }

  setCamera(camera: VfxCameraState): void {
    this.#cameraState = validateCameraState(camera);
    this.#cameraConfigured = true;
    const reverseZDiagnostic = reverseZCameraDiagnostic(this.#cameraState);
    for (const instance of this.#instances.values()) {
      instance.setCamera(this.#cameraState);
      if (instance.usesSceneDepth && reverseZDiagnostic) {
        instance.recordDiagnosticOnce(reverseZDiagnostic);
      }
    }
    this.#updateScalability();
    this.#updateTransparencyOrder();
  }

  spawn<
    const Elements extends EffectElements,
    const Parameters extends ParameterSchema = Readonly<Record<string, never>>,
  >(
    definition: EffectDefinition<Elements, Parameters>,
    options: EffectSpawnOptions<EffectDefinition<Elements, Parameters>> = {},
  ): VfxEffectInstance<EffectDefinition<Elements, Parameters>> {
    const id = `nachi-effect-${++this.#instanceSequence}`;
    const parameterDefinitions = (definition.parameters ?? {}) as ParameterSchema;
    if (options.priority !== undefined && !Number.isFinite(options.priority)) {
      throw new RangeError('EffectSpawnOptions.priority must be finite.');
    }
    const poolKey = this.#qualityPoolKey(
      definition as RuntimeEffectDefinition,
      this.#qualitySelection.tier,
    );
    const instance = new VfxEffectInstance<EffectDefinition<Elements, Parameters>>(
      definition,
      id,
      poolKey,
      options.timeScale ?? 1,
      parameterDefinitions,
      (releasedInstance, poolable) => this.#releaseInstance(releasedInstance, poolable),
      options.priority ?? 0,
      undefined,
      (capture) => this.#scheduleCapture(capture),
    );
    this.#instances.set(id, instance);

    if (this.#deviceLossDiagnostic) {
      instance.markError(this.#deviceLossDiagnostic);
      return instance;
    }

    let pooled: PooledEffectResources | undefined;
    let runtimeRenderer: VfxRuntimeRenderer | undefined;
    try {
      const parameterDiagnostics = validateSpawnParameterOverrides(
        parameterDefinitions,
        options.parameters as Readonly<Record<string, unknown>> | undefined,
      );
      if (parameterDiagnostics.length > 0) throw new VfxDiagnosticError(parameterDiagnostics);
      runtimeRenderer = asRuntimeRenderer(this.renderer);
      if (!runtimeRenderer) {
        throw new Error('VFXSystem renderer must provide kernelAdapter and submitCompute().');
      }
      const materializationRenderer = runtimeRenderer;
      const compiled = this.#compile(definition, this.#qualitySelection.tier);
      pooled = this.#takePooledResources(definition, poolKey);
      const usesSceneDepth = compiled.emitters.some(({ program }) =>
        program.kernels.update.modules.some(({ type }) => type === 'core/collide-scene-depth'),
      );
      const reverseZDiagnostic = reverseZCameraDiagnostic(this.#cameraState);
      if (usesSceneDepth && this.#cameraConfigured && reverseZDiagnostic) {
        instance.recordDiagnosticOnce(reverseZDiagnostic);
      }
      instance.setEventDrainFrames(compiled.eventDrainFrames);
      const parameters = effectParameters(
        parameterDefinitions,
        options.parameters as Readonly<Record<string, unknown>> | undefined,
      );
      const transform = transformMatrix(options.position, options.rotation);
      const eventResources = new Map<string, Readonly<Record<string, EventQueueResources>>>();
      if (!pooled) {
        for (const entry of compiled.emitters) {
          eventResources.set(
            entry.key,
            Object.fromEntries(
              entry.program.events.map((queue) => [
                queue.eventName,
                allocateEventQueueResources(
                  materializationRenderer.kernelAdapter,
                  queue,
                  entry.key,
                ),
              ]),
            ),
          );
        }
      }
      for (const [index, entry] of compiled.emitters.entries()) {
        const seed = ((options.seed ?? 0) ^ hashModuleLabel(entry.key) ^ index) >>> 0;
        const runtimeEmitter = new RuntimeEmitter(
          entry.definition,
          entry.program,
          materializationRenderer,
          seed,
          transform,
          parameters,
          entry.maxLifetime,
          this.#aliveCountReadbackInterval,
          (diagnostic) => instance.recordDiagnostic(diagnostic),
          pooled ? {} : eventResources.get(entry.key),
          pooled
            ? []
            : compiled.eventLinks
                .filter(({ targetKey }) => targetKey === entry.key)
                .map(({ handler, queue, sourceKey }) => {
                  const resources = eventResources.get(sourceKey)?.[queue.eventName];
                  if (!resources) {
                    throw new Error(
                      `Event resources for ${sourceKey}.${queue.eventName} are missing.`,
                    );
                  }
                  return { handler, queue, resources, sourceKey };
                }),
          (summary) => instance.emitEventSummary(summary),
          pooled?.kernelsByEmitter.get(entry.key),
          this.#qualitySelection.tier,
        );
        runtimeEmitter.setCamera(this.#cameraState);
        instance.addEmitter(entry.key, runtimeEmitter);
      }
    } catch (error) {
      const kernelsToRelease = new Set<BuiltEmitterKernels>();
      for (const kernels of pooled?.kernelsByEmitter.values() ?? []) {
        kernelsToRelease.add(kernels);
      }
      for (const kernels of instance.detachEmitterKernels().values()) {
        kernelsToRelease.add(kernels);
      }
      for (const kernels of kernelsToRelease) runtimeRenderer?.releaseKernels?.(kernels);
      const diagnostics =
        error instanceof VfxDiagnosticError
          ? error.diagnostics
          : [
              runtimeDiagnostic(
                'NACHI_RUNTIME_MATERIALIZATION_FAILED',
                error instanceof Error ? error.message : String(error),
              ),
            ];
      for (const diagnostic of diagnostics) instance.markError(diagnostic);
    }
    this.#updateScalability();
    return instance;
  }

  update(deltaSeconds?: number): Promise<void> {
    const delta = deltaSeconds ?? this.#measuredDelta();
    requireNonNegativeFinite(delta, 'deltaSeconds');
    const run = async () => {
      this.#updateInFlight = true;
      this.#profileFrame += 1;
      for (const instance of this.#instances.values()) instance.beginProfileFrame();
      try {
        for (const instance of this.#instances.values()) {
          if (instance.usesSceneDepth && !this.#cameraConfigured) {
            instance.recordDiagnosticOnce(
              runtimeDiagnostic(
                'NACHI_SCENE_DEPTH_CAMERA_UNSET',
                'collideSceneDepth() is using identity camera uniforms because VFXSystem.setCamera() was not called before the first update.',
                'System.projectionMatrix',
                'warning',
              ),
            );
          }
          instance.syncAttachment();
        }
        this.#updateScalability();
        this.#updateTransparencyOrder();
        for (const instance of this.#instances.values()) {
          if (instance.scalability.action === 'culled') continue;
          await this.#advanceInstance(instance, () =>
            instance.initialize(this.#systemTime, this.#prewarmStepSeconds),
          );
        }
        const steps = this.#fixedStep ? this.#fixedStep.advance(delta) : [delta];
        for (const step of steps) {
          this.#systemTime += step;
          for (const instance of this.#instances.values()) instance.syncAttachment();
          this.#updateScalability();
          this.#updateTransparencyOrder();
          for (const instance of this.#instances.values()) {
            if (instance.scalability.action === 'culled') continue;
            await this.#advanceInstance(instance, () =>
              instance.advance(step, this.#systemTime, this.#prewarmStepSeconds),
            );
          }
        }
      } finally {
        this.#updateInFlight = false;
      }
    };
    const scheduled = this.#updateQueue.then(run, run);
    this.#updateQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  #captureProfile(options?: CaptureProfileOptions) {
    return this.#scheduleCapture(() => {
      const backend =
        asRuntimeRenderer(this.renderer)?.kernelAdapter.capabilities.backend ?? 'webgl2';
      return aggregateProfileFrame(
        this.#profileFrame,
        [...this.#instances.values()].flatMap((instance) => instance.profileCounters()),
        options?.gpuTiming,
        backend,
      );
    });
  }

  #scheduleCapture<Value>(capture: () => Promise<Value> | Value): Promise<Value> {
    const scheduled = this.#updateQueue.then(capture, capture);
    this.#updateQueue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  #updateScalability(): void {
    const evaluated = [...this.#instances.values()]
      .filter((instance) => instance.state === 'active')
      .map((instance) => {
        if (!this.#cameraConfigured && instance.definition.scalability) {
          instance.recordDiagnosticOnce(
            runtimeDiagnostic(
              'NACHI_SCALABILITY_CAMERA_UNSET',
              'Distance/frustum/significance evaluation is using the identity camera because VFXSystem.setCamera() was not called.',
              'System.viewMatrix',
              'warning',
            ),
          );
        }
        return {
          instance,
          status: instance.evaluateScalability(this.#cameraState, this.#cameraConfigured),
        };
      });
    const candidates = evaluated
      .filter(({ status }) => status.action !== 'culled')
      .sort((left, right) => {
        const leftScore =
          left.status.score +
          (this.#budgetAdmittedInstances.has(left.instance.id) ? BUDGET_HYSTERESIS_SCORE : 0);
        const rightScore =
          right.status.score +
          (this.#budgetAdmittedInstances.has(right.instance.id) ? BUDGET_HYSTERESIS_SCORE : 0);
        const difference = rightScore - leftScore;
        return difference === 0
          ? left.instance.id < right.instance.id
            ? -1
            : left.instance.id > right.instance.id
              ? 1
              : 0
          : difference;
      });
    let activeInstances = 0;
    let particles = 0;
    const budgeted = new Map<string, EffectScalabilityStatus>();
    const nextBudgetAdmittedInstances = new Set<string>();
    for (const { instance, status } of candidates) {
      if (activeInstances >= this.#significanceBudget.maxActiveInstances) {
        budgeted.set(instance.id, {
          ...status,
          action: 'culled',
          fade: 0,
          reasons: [...status.reasons, 'significance-instance-budget'],
        });
        continue;
      }
      activeInstances += 1;
      nextBudgetAdmittedInstances.add(instance.id);
      const cost = instance.estimatedParticleCost;
      if (particles + cost > this.#significanceBudget.maxParticles) {
        budgeted.set(instance.id, {
          ...status,
          action: 'spawn-suppressed',
          reasons: [...status.reasons, 'significance-particle-budget'],
        });
        continue;
      }
      particles += cost;
      budgeted.set(instance.id, status);
    }
    for (const { instance, status } of evaluated) {
      instance.applyScalability(budgeted.get(instance.id) ?? status);
    }
    this.#budgetAdmittedInstances.clear();
    for (const id of nextBudgetAdmittedInstances) this.#budgetAdmittedInstances.add(id);
  }

  #updateTransparencyOrder(): void {
    const entries = [...this.#instances.values()].flatMap((instance) =>
      instance.transparencyEmitters().map(([key, emitter]) => ({
        instance,
        stableKey: `${instance.id}/${key}`,
        value: emitter,
        worldPosition: emitter.worldPosition,
      })),
    );
    const needsCamera = entries.length > 1 || entries.some(({ value }) => value.particleSorted);
    if (needsCamera && !this.#cameraConfigured) {
      for (const { instance } of entries.filter(
        ({ value }) => entries.length > 1 || value.particleSorted,
      )) {
        instance.recordDiagnosticOnce(
          runtimeDiagnostic(
            'NACHI_ALPHA_SORT_CAMERA_UNSET',
            'Alpha emitter ordering and sorted particle depth require VFXSystem.setCamera().',
            'System.viewMatrix',
            'warning',
          ),
        );
      }
    }
    const ordered = sortEmittersBackToFront(entries, this.#cameraState.viewMatrix);
    for (const [rank, entry] of ordered.entries()) entry.value.setRenderOrder(1_000 + rank);
  }

  #compile(definition: RuntimeEffectDefinition, tier: QualityTier): CompiledEffect {
    const cacheKey = this.#qualityPoolKey(definition, tier);
    const cache = this.#compiledEffects.get(definition);
    const cached = cache?.get(cacheKey);
    if (cached) return cached;
    const emitterDefinitions = Object.entries(definition.elements).filter(
      (entry): entry is [string, EmitterDefinition] => entry[1].kind === 'emitter',
    );
    const eventPayloadFields = new Map<string, Set<string>>();
    for (const [, emitter] of emitterDefinitions) {
      for (const value of Object.values(emitter.events ?? {})) {
        const handlers = Array.isArray(value) ? value : [value];
        for (const handler of handlers) {
          if (handler?.type !== 'core/emit-to') continue;
          const config = handler.config as { inherit?: unknown; target?: unknown };
          if (typeof config.target !== 'string' || !Array.isArray(config.inherit)) continue;
          let fields = eventPayloadFields.get(config.target);
          if (!fields) {
            fields = new Set();
            eventPayloadFields.set(config.target, fields);
          }
          for (const name of config.inherit) {
            if (typeof name === 'string') fields.add(name);
          }
        }
      }
    }
    const emitters = emitterDefinitions
      .map(([key, authoredDefinition]) => {
        const emitter = applyEmitterQualityTier(authoredDefinition, tier);
        return {
          definition: emitter,
          key,
          program: compileEmitter(emitter, {
            eventPayloadFields: [...(eventPayloadFields.get(key) ?? [])],
            ...(this.#registry === undefined ? {} : { registry: this.#registry }),
          }),
        };
      })
      .map((entry) => ({
        ...entry,
        maxLifetime: maximumLifetime(entry.program, entry.definition),
      }));
    const byKey = new Map(emitters.map((entry) => [entry.key, entry] as const));
    const eventDiagnostics: VfxDiagnostic[] = [];
    const eventLinks = emitters.flatMap((source) =>
      source.program.events.flatMap((queue) =>
        queue.handlers.flatMap((handler) => {
          const target = byKey.get(handler.target);
          if (!target) {
            eventDiagnostics.push({
              code: 'NACHI_EVENT_TARGET_UNKNOWN',
              message: `emitTo() target "${handler.target}" is not an emitter in this effect.`,
              path: `${source.key}.${handler.path}.config.target`,
              phase: 'compile',
              severity: 'error',
            });
            return [];
          }
          for (const [index, name] of handler.inherit.entries()) {
            const producerAttribute = source.program.attributeSchema.byName[name];
            const consumerAttribute = target.program.attributeSchema.byName[name];
            if (!consumerAttribute) {
              eventDiagnostics.push({
                code: 'NACHI_EVENT_PAYLOAD_TARGET_UNKNOWN',
                message: `Target emitter "${handler.target}" does not declare inherited attribute "${name}".`,
                path: `${source.key}.${handler.path}.config.inherit[${index}]`,
                phase: 'compile',
                severity: 'error',
              });
            } else if (
              producerAttribute &&
              (consumerAttribute.logicalType !== producerAttribute.logicalType ||
                consumerAttribute.components !== producerAttribute.components)
            ) {
              eventDiagnostics.push({
                code: 'NACHI_EVENT_PAYLOAD_TYPE_MISMATCH',
                message: `Inherited attribute "${name}" is ${producerAttribute.logicalType} on "${source.key}" but ${consumerAttribute.logicalType} on "${handler.target}".`,
                path: `${source.key}.${handler.path}.config.inherit[${index}]`,
                phase: 'compile',
                severity: 'error',
              });
            }
          }
          return [{ handler, queue, sourceKey: source.key, targetKey: target.key }];
        }),
      ),
    );
    if (eventDiagnostics.length > 0) throw new VfxDiagnosticError(eventDiagnostics);
    const outgoing = new Map<string, string[]>();
    for (const { sourceKey, targetKey } of eventLinks) {
      const targets = outgoing.get(sourceKey) ?? [];
      targets.push(targetKey);
      outgoing.set(sourceKey, targets);
    }
    const eventDepth = (sourceKey: string, visited: ReadonlySet<string>): number => {
      let maximum = 0;
      for (const targetKey of outgoing.get(sourceKey) ?? []) {
        if (visited.has(targetKey)) {
          maximum = Math.max(maximum, 1);
          continue;
        }
        maximum = Math.max(maximum, 1 + eventDepth(targetKey, new Set([...visited, targetKey])));
      }
      return maximum;
    };
    const eventDrainFrames = Math.max(
      0,
      ...emitters.map(({ key }) => eventDepth(key, new Set([key]))),
    );
    const compiled = { emitters, eventDrainFrames, eventLinks };
    const nextCache = cache ?? new Map<string, CompiledEffect>();
    nextCache.set(cacheKey, compiled);
    this.#compiledEffects.set(definition, nextCache);
    this.#compilationCount += 1;
    return compiled;
  }

  #takePooledResources(
    definition: RuntimeEffectDefinition,
    poolKey: string,
  ): PooledEffectResources | undefined {
    const pool = this.#effectPools.get(definition)?.get(poolKey);
    return pool?.resources.pop();
  }

  #qualityPoolKey(definition: RuntimeEffectDefinition, tier: QualityTier): string {
    return Object.entries(definition.elements)
      .filter((entry): entry is [string, EmitterDefinition] => entry[1].kind === 'emitter')
      .map(([key, emitter]) => `${key}:${qualityStructuralKey(emitter, tier)}`)
      .join('|');
  }

  #releaseInstance(instance: ReleasableEffectInstance, poolable: boolean): void {
    this.#instances.delete(instance.id);
    if (this.#updateInFlight) {
      void this.#updateQueue.then(
        () => this.#retainOrReleaseInstance(instance, poolable),
        () => this.#retainOrReleaseInstance(instance, poolable),
      );
      return;
    }
    this.#retainOrReleaseInstance(instance, poolable);
  }

  #retainOrReleaseInstance(instance: ReleasableEffectInstance, poolable: boolean): void {
    const definition = instance.definition;
    const pools = this.#effectPools.get(definition) ?? new Map<string, EffectResourcePool>();
    const pool = pools.get(instance.poolKey) ?? { resources: [] };
    if (!poolable || this.#maxPoolSize === 0 || pool.resources.length >= this.#maxPoolSize) {
      if (poolable && pool.resources.length >= this.#maxPoolSize && this.#maxPoolSize > 0) {
        instance.recordReleaseDiagnostic({
          code: 'NACHI_EFFECT_POOL_LIMIT_EXCEEDED',
          message: `Effect pool limit ${this.#maxPoolSize} was reached; released GPU resources were disposed instead of retained.`,
          path: 'VFXSystem.maxPoolSize',
          phase: 'runtime',
          severity: 'warning',
        });
      }
      instance.releaseEmitterKernels();
      return;
    }
    const kernelsByEmitter = instance.takeEmitterKernelsForPooling();
    if (kernelsByEmitter.size === 0) return;
    pool.resources.push({ kernelsByEmitter });
    pools.set(instance.poolKey, pool);
    this.#effectPools.set(definition, pools);
  }

  #measuredDelta(): number {
    const timestamp = this.#now();
    if (this.#lastTimestamp === undefined) {
      this.#lastTimestamp = timestamp;
      return 0;
    }
    const delta = Math.max(0, (timestamp - this.#lastTimestamp) / 1000);
    this.#lastTimestamp = timestamp;
    return delta;
  }

  async #advanceInstance(
    instance: VfxEffectInstance,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (instance.state !== 'active') return;
    try {
      await operation();
    } catch (error) {
      instance.markError(
        runtimeDiagnostic(
          'NACHI_GPU_SUBMISSION_FAILED',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  #handleDeviceLoss(info: VfxDeviceLossInfo): void {
    const reason = info.reason ?? 'unknown';
    const message = info.message ? `: ${info.message}` : '';
    const diagnostic = runtimeDiagnostic(
      'NACHI_DEVICE_LOST',
      `GPU device was lost (${reason})${message}`,
    );
    this.#deviceLossDiagnostic = diagnostic;
    for (const instance of this.#instances.values()) instance.markError(diagnostic);
  }
}
