import {
  compileEmitter,
  type BuiltEmitterKernels,
  type CompiledSpawnModule,
  type CompiledEmitterProgram,
  type KernelComputeNode,
  type KernelTslAdapter,
  type KernelUniformNode,
} from './compiler.js';
import { VfxDiagnosticError } from './diagnostics.js';
import { hashModuleLabel, pcgRandomFloat, resolveRandomSampleSlot } from './random.js';
import type {
  AttributeType,
  DefinitionParameterValue,
  EffectDefinition,
  EffectElements,
  EffectInstance,
  EffectInstanceState,
  EffectSpawnOptions,
  EmitterDefinition,
  EmitterLifecycle,
  ParameterPath,
  ParameterSchema,
  PositionInput,
  RotationInput,
  UserParameterKeys,
  VfxDiagnostic,
} from './types.js';

const DEFAULT_MAX_SUB_STEPS = 8;
const DEFAULT_PREWARM_STEP_SECONDS = 1 / 60;
const TIME_EPSILON = 1e-10;

export interface VfxDeviceLossInfo {
  readonly message?: string;
  readonly reason?: string;
}

/** Renderer integration boundary. Core owns scheduling; backend packages own submission and nodes. */
export interface VfxRuntimeRenderer {
  readonly deviceLost?: Promise<VfxDeviceLossInfo>;
  readonly kernelAdapter: KernelTslAdapter;
  readStorage?(storage: BuiltEmitterKernels['aliveCount']): Promise<ArrayBuffer>;
  releaseKernels?(kernels: BuiltEmitterKernels): void;
  setUniformValue?(uniform: KernelUniformNode, path: ParameterPath, value: unknown): void;
  setInstanceCount?(kernels: BuiltEmitterKernels, count: number): void;
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
  /** Read exact GPU alive count every N compactions; omitted keeps conservative draining. */
  readonly aliveCountReadbackInterval?: number;
  readonly fixedTimeStep?: VfxFixedTimeStepOptions;
  readonly now?: () => number;
  readonly prewarmStepSeconds?: number;
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
};

type RuntimeEffectDefinition = {
  readonly elements: EffectElements;
  readonly kind: 'effect';
  readonly parameters?: ParameterSchema;
};

type AdvanceContext = {
  readonly prewarmStepSeconds: number;
  readonly systemDelta: number;
  readonly systemTime: number;
};

export interface VfxEmitterRuntimeView {
  readonly aliveCount: number | undefined;
  readonly definition: EmitterDefinition;
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

function runtimeDiagnostic(code: string, message: string, path?: string): VfxDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase: 'runtime',
    severity: 'error',
  };
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

function maximumLifetime(program: CompiledEmitterProgram): number {
  let maximum = 0;
  const writers = program.kernels.init.modules.filter(
    (module) => module.source === 'author' && module.access.writes.includes('Particles.lifetime'),
  );
  // An undeclared lifetime means an emitter may remain alive indefinitely. Likewise, an
  // arbitrary lifetime writer cannot be bounded safely from core/lifetime's known config.
  if (writers.length === 0 || writers.some(({ type }) => type !== 'core/lifetime')) return Infinity;
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

type SpawnAccumulator = { burstCycles: number; remainder: number };

class RuntimeEmitter implements VfxEmitterRuntimeView {
  readonly controller: EmitterLifecycleController;
  readonly kernels: BuiltEmitterKernels;
  readonly program: CompiledEmitterProgram;
  readonly #aliveCountReadbackInterval: number | undefined;
  readonly #maxLifetime: number;
  readonly #onDiagnostic: (diagnostic: VfxDiagnostic) => void;
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
  #initialized = false;
  #pendingDistance = 0;
  #spawnGeneration = 0;
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
  ) {
    this.program = program;
    this.#renderer = renderer;
    this.#seed = seed >>> 0;
    this.#transform = transform;
    this.#parameters = { ...parameters };
    this.#maxLifetime = maxLifetime;
    this.#aliveCountReadbackInterval = aliveCountReadbackInterval;
    this.#onDiagnostic = onDiagnostic;
    this.controller = new EmitterLifecycleController(definition.lifecycle);
    this.kernels = program.buildKernels(renderer.kernelAdapter);
    setUniform(renderer, this.kernels.uniforms, 'Emitter.seed', this.#seed);
    setUniform(renderer, this.kernels.uniforms, 'Emitter.transform', transform);
    for (const [path, value] of Object.entries(parameters)) {
      setUniform(renderer, this.kernels.uniforms, path as ParameterPath, value);
    }
  }

  get aliveCount(): number | undefined {
    return this.#exactAliveCount;
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

  release(): void {
    this.#renderer.releaseKernels?.(this.kernels);
  }

  async advance(deltaSeconds: number, context: AdvanceContext): Promise<void> {
    if (!this.#initialized) {
      await this.#renderer.submitCompute(this.kernels.initialize);
      this.#initialized = true;
      await this.#compactAlive();
    }
    const commands = this.controller.advance(deltaSeconds);
    for (const command of commands) {
      if (command.kind === 'activate') {
        this.#spawnGeneration = command.spawnGeneration;
        this.#emitterAge = 0;
        this.#drainRemaining = 0;
        this.#emissionCompletedSequence = undefined;
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
          await this.#renderer.submitCompute(this.kernels.update);
          this.#emitterAge += step;
          setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.age', this.#emitterAge);
          setUniform(this.#renderer, this.kernels.uniforms, 'Emitter.localTime', this.#emitterAge);
          if (command.phase === 'drain') {
            this.#drainRemaining = Math.max(0, this.#drainRemaining - step);
          }
          await this.#compactAlive();
        }
      }
    }
  }

  #activationSpawnCount(): number {
    let count = 0;
    for (const module of this.program.spawn.modules) {
      if (module.type !== 'core/burst') continue;
      count += this.#burstCount(module);
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
        const rate = (module.config as { rate: number }).rate;
        const exact = accumulator.remainder + rate * deltaSeconds;
        const emitted = Math.floor(exact + TIME_EPSILON);
        accumulator.remainder = exact - emitted;
        count += emitted;
      } else if (module.type === 'core/per-distance') {
        const rate = (module.config as { rate: number }).rate;
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
          count += this.#burstCount(module);
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
    if (requestedCount <= 0) return;
    // Never encode more spawn invocations than physical slots. The GPU overflow counter handles
    // lower free-list availability; this clamp also makes malformed/extreme requests safe.
    const dispatchCount = Math.min(requestedCount, this.definition.capacity);
    const cpuOverflow = Math.max(0, requestedCount - dispatchCount);
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
      await this.#renderer.submitCompute(prepareSpawn);
      await this.#renderer.submitComputeIndirect(
        this.kernels.spawn,
        spawnDispatch.indirectResource,
      );
      await this.#renderer.submitCompute(finalizeSpawn);
      if (this.#renderer.readStorage) {
        const counters = new Uint32Array(
          await this.#renderer.readStorage(this.kernels.spawnOverflow),
        );
        const overflow = (counters[this.kernels.counterOffsets.spawnOverflow] ?? 0) + cpuOverflow;
        if (overflow > 0) this.#reportOverflow(requestedCount, overflow);
      } else if (cpuOverflow > 0) {
        this.#reportOverflow(requestedCount, cpuOverflow);
      }
    } else {
      await this.#renderer.submitCompute(this.kernels.spawn);
      if (cpuOverflow > 0) this.#reportOverflow(requestedCount, cpuOverflow);
    }
  }

  #reportOverflow(requestedCount: number, overflow: number): void {
    this.#onDiagnostic({
      code: 'NACHI_SPAWN_CAPACITY_EXCEEDED',
      message: `Spawn request ${requestedCount} exceeded available capacity; ${overflow} particle(s) were safely dropped.`,
      phase: 'runtime',
      severity: 'warning',
    });
  }

  async #compactAlive(): Promise<void> {
    this.#compactSequence += 1;
    if (this.kernels.capabilityPath === 'webgpu-atomic-indirect') {
      const { compact, finalizeIndirect, resetAliveCount } = this.kernels;
      if (!compact || !finalizeIndirect || !resetAliveCount) {
        throw new Error('WebGPU lifecycle compaction kernels are missing.');
      }
      await this.#renderer.submitCompute(resetAliveCount);
      await this.#renderer.submitCompute(compact);
      await this.#renderer.submitCompute(finalizeIndirect);
      if (
        this.#renderer.readStorage &&
        this.#aliveCountReadbackInterval !== undefined &&
        this.#compactSequence % this.#aliveCountReadbackInterval === 0
      ) {
        const counters = new Uint32Array(await this.#renderer.readStorage(this.kernels.aliveCount));
        this.#exactAliveCount = counters[this.kernels.counterOffsets.aliveCount] ?? 0;
        this.#exactAliveSequence = this.#compactSequence;
      }
    } else if (this.#renderer.readStorage) {
      const alive = this.kernels.storages.alive;
      if (!alive) return;
      const flags = new Uint32Array(await this.#renderer.readStorage(alive));
      const count = flags.reduce((sum, value) => sum + (value === 0 ? 0 : 1), 0);
      this.#exactAliveCount = count;
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
}

export class VfxEffectInstance<
  Definition extends RuntimeEffectDefinition = RuntimeEffectDefinition,
> implements EffectInstance<Definition> {
  readonly clock: EffectClock;
  readonly #diagnostics: VfxDiagnostic[] = [];
  readonly #emitters = new Map<string, RuntimeEmitter>();
  readonly #onRelease: (id: string) => void;
  readonly #parameterDefinitions: ParameterSchema;
  #state: EffectInstanceState = 'active';

  constructor(
    readonly definition: Definition,
    readonly id: string,
    timeScale: number,
    parameterDefinitions: ParameterSchema,
    onRelease: (id: string) => void,
  ) {
    this.clock = new EffectClock(timeScale);
    this.#parameterDefinitions = parameterDefinitions;
    this.#onRelease = onRelease;
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

  get timeScale(): number {
    return this.clock.timeScale;
  }

  addEmitter(key: string, emitter: RuntimeEmitter): void {
    this.#emitters.set(key, emitter);
  }

  getEmitter(key: string): VfxEmitterRuntimeView | undefined {
    this.#assertNotReleased();
    return this.#emitters.get(key);
  }

  applyHitStop(durationMs: number, timeScale = 0): void {
    this.#assertNotReleased();
    if (this.#state !== 'active') return;
    this.clock.applyHitStop(durationMs, timeScale);
  }

  release(): void {
    if (this.#state === 'released') return;
    for (const emitter of this.#emitters.values()) emitter.release();
    this.#emitters.clear();
    this.#state = 'released';
    this.#onRelease(this.id);
  }

  setParameter<Path extends UserParameterKeys<Definition>>(
    path: Path,
    value: DefinitionParameterValue<Definition, Path>,
  ): void {
    this.#assertNotReleased();
    const definition = this.#parameterDefinitions[path as ParameterPath];
    if (!definition) {
      throw new VfxDiagnosticError([
        runtimeDiagnostic(
          'NACHI_PARAMETER_UNKNOWN',
          `Unknown runtime parameter "${String(path)}".`,
        ),
      ]);
    }
    if (definition.mutable !== true) {
      throw new VfxDiagnosticError([
        runtimeDiagnostic(
          'NACHI_PARAMETER_IMMUTABLE',
          `Runtime parameter "${String(path)}" is immutable.`,
        ),
      ]);
    }
    if (!isParameterValue(definition.type, value)) {
      throw new VfxDiagnosticError([
        runtimeDiagnostic(
          'NACHI_PARAMETER_TYPE_MISMATCH',
          `Runtime parameter "${String(path)}" does not match ${definition.type}.`,
        ),
      ]);
    }
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

  stop(): void {
    this.#assertNotReleased();
    if (this.#state === 'active') this.#state = 'stopped';
  }

  markError(diagnostic: VfxDiagnostic): void {
    if (this.#state === 'released') return;
    this.#diagnostics.push(diagnostic);
    this.#state = 'error';
  }

  recordDiagnostic(diagnostic: VfxDiagnostic): void {
    if (this.#state !== 'released') this.#diagnostics.push(diagnostic);
  }

  async initialize(systemTime: number, prewarmStepSeconds: number): Promise<void> {
    if (this.#state !== 'active') return;
    const context = {
      prewarmStepSeconds,
      systemDelta: 0,
      systemTime,
    };
    for (const emitter of this.#emitters.values()) await emitter.advance(0, context);
    this.#completeIfFinished();
  }

  async advance(worldDelta: number, systemTime: number, prewarmStepSeconds: number): Promise<void> {
    if (this.#state !== 'active') return;
    const localDelta = this.clock.advance(worldDelta);
    const context = {
      prewarmStepSeconds,
      systemDelta: worldDelta,
      systemTime,
    };
    for (const emitter of this.#emitters.values()) await emitter.advance(localDelta, context);
    this.#completeIfFinished();
  }

  #completeIfFinished(): void {
    if (
      this.#state === 'active' &&
      [...this.#emitters.values()].every((emitter) => emitter.complete)
    ) {
      this.#state = 'complete';
    }
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
  readonly #aliveCountReadbackInterval: number | undefined;
  readonly #compiledEffects = new WeakMap<RuntimeEffectDefinition, CompiledEffect>();
  readonly #fixedStep: FixedStepAccumulator | undefined;
  readonly #instances = new Map<string, VfxEffectInstance<RuntimeEffectDefinition>>();
  readonly #now: () => number;
  readonly #prewarmStepSeconds: number;
  #compilationCount = 0;
  #deviceLossDiagnostic?: VfxDiagnostic;
  #instanceSequence = 0;
  #lastTimestamp?: number;
  #systemTime = 0;
  #updateQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly renderer: Renderer,
    readonly scene?: Scene,
    options: VfxSystemOptions = {},
  ) {
    this.#aliveCountReadbackInterval = options.aliveCountReadbackInterval;
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

    const runtimeRenderer = asRuntimeRenderer(renderer);
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

  get time(): number {
    return this.#systemTime;
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
    const instance = new VfxEffectInstance<EffectDefinition<Elements, Parameters>>(
      definition,
      id,
      options.timeScale ?? 1,
      parameterDefinitions,
      (releasedId) => this.#instances.delete(releasedId),
    );
    this.#instances.set(id, instance);

    if (this.#deviceLossDiagnostic) {
      instance.markError(this.#deviceLossDiagnostic);
      return instance;
    }

    try {
      const runtimeRenderer = asRuntimeRenderer(this.renderer);
      if (!runtimeRenderer) {
        throw new Error('VFXSystem renderer must provide kernelAdapter and submitCompute().');
      }
      const compiled = this.#compile(definition);
      const parameters = effectParameters(
        parameterDefinitions,
        options.parameters as Readonly<Record<string, unknown>> | undefined,
      );
      const transform = transformMatrix(options.position, options.rotation);
      for (const [index, entry] of compiled.emitters.entries()) {
        const seed = ((options.seed ?? 0) ^ hashModuleLabel(entry.key) ^ index) >>> 0;
        instance.addEmitter(
          entry.key,
          new RuntimeEmitter(
            entry.definition,
            entry.program,
            runtimeRenderer,
            seed,
            transform,
            parameters,
            entry.maxLifetime,
            this.#aliveCountReadbackInterval,
            (diagnostic) => instance.recordDiagnostic(diagnostic),
          ),
        );
      }
    } catch (error) {
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
    return instance;
  }

  update(deltaSeconds?: number): Promise<void> {
    const delta = deltaSeconds ?? this.#measuredDelta();
    requireNonNegativeFinite(delta, 'deltaSeconds');
    const run = async () => {
      for (const instance of this.#instances.values()) {
        await this.#advanceInstance(instance, () =>
          instance.initialize(this.#systemTime, this.#prewarmStepSeconds),
        );
      }
      const steps = this.#fixedStep ? this.#fixedStep.advance(delta) : [delta];
      for (const step of steps) {
        this.#systemTime += step;
        for (const instance of this.#instances.values()) {
          await this.#advanceInstance(instance, () =>
            instance.advance(step, this.#systemTime, this.#prewarmStepSeconds),
          );
        }
      }
    };
    const scheduled = this.#updateQueue.then(run, run);
    this.#updateQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  #compile(definition: RuntimeEffectDefinition): CompiledEffect {
    const cached = this.#compiledEffects.get(definition);
    if (cached) return cached;
    const emitters = Object.entries(definition.elements)
      .filter((entry): entry is [string, EmitterDefinition] => entry[1].kind === 'emitter')
      .map(([key, emitter]) => {
        return {
          definition: emitter,
          key,
          program: compileEmitter(emitter),
        };
      })
      .map((entry) => ({
        ...entry,
        maxLifetime: maximumLifetime(entry.program),
      }));
    const compiled = { emitters };
    this.#compiledEffects.set(definition, compiled);
    this.#compilationCount += 1;
    return compiled;
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
