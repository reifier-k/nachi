import {
  VFXSystem as CoreVFXSystem,
  VfxDiagnosticError,
  hashModuleLabel,
  pcgRandomFloat,
  validateRuntimeParameter,
  type DefinitionParameterValue,
  type EffectDefinition,
  type EffectElementDefinition,
  type EffectElements,
  type EffectEventCallback,
  type EffectInstanceState,
  type EffectSpawnOptions,
  type EffectTransformSource,
  type MarkerAction,
  type ParameterSchema,
  type PositionInput,
  type RotationInput,
  type TimelineAction,
  type TimelineDefinition,
  type TimelineEntry,
  type UserParameterKeys,
  type VfxCameraState,
  type VfxDiagnostic,
  type VfxEffectInstance,
  type VfxEmitterRuntimeView,
  type VfxPrepareOptions,
  type VfxSystemOptions,
  FixedStepAccumulator,
} from '@nachi-vfx/core';
import type { FxNodeMaterial, MeshFxMesh } from '@nachi-vfx/mesh-fx';

import {
  cloneTimelineFxMaterial,
  getMeshFxResources,
  setTimelineFxMaterialLife,
  type MeshFxRuntimeResource,
} from './authoring.js';

const EPSILON = 1e-10;
const DEFAULT_SHAKE_DURATION = 0.25;
const DEFAULT_SHAKE_FREQUENCY = 24;

export interface CameraShakeSample {
  readonly cycle: number;
  readonly decay: number;
  readonly effectId: string;
  readonly localTime: number;
  readonly rotation: readonly [number, number, number];
  readonly translation: readonly [number, number, number];
}

/** Receives an absolute additive shake sample; the final sample is always zero. */
export type CameraShakeTarget = (sample: CameraShakeSample) => void;

export interface TimelineActionEvent {
  readonly action: TimelineAction;
  readonly actionIndex: number;
  readonly cycle: number;
  /** Emitter created by this play action; absent for mesh-fx and non-play actions. */
  readonly emitter?: VfxEmitterRuntimeView;
  readonly entryIndex: number;
  readonly localTime: number;
  readonly sequence: number;
}

export interface TimelineElementState {
  readonly aliveCount: number | undefined;
  /** Element-local time; after completion this retains the final value for every element kind. */
  readonly localTime: number;
  readonly playing: boolean;
  readonly visible: boolean;
}

export interface TimelineSystemOptions extends VfxSystemOptions {
  readonly cameraShakeTarget?: CameraShakeTarget;
}

export interface TimelineEffectSpawnOptions<Definition = EffectDefinition>
  extends EffectSpawnOptions<Definition> {
  readonly cameraShakeTarget?: CameraShakeTarget;
}

export type TimelinePrepareOptions = VfxPrepareOptions<MeshFxMesh>;

/** @internal Timeline owns fixed stepping and budgets its choreography as one unit. */
export function timelineCoreOptions(options: TimelineSystemOptions): VfxSystemOptions {
  return Object.fromEntries(
    Object.entries(options).filter(
      ([key]) =>
        key !== 'cameraShakeTarget' && key !== 'fixedTimeStep' && key !== 'significanceBudget',
    ),
  ) as VfxSystemOptions;
}

type RuntimeDefinition = {
  readonly elements: Readonly<Record<string, EffectElementDefinition>>;
  readonly kind: 'effect';
  readonly parameters?: ParameterSchema;
  readonly timeline?: unknown;
};

type SceneTarget = {
  add(object: object): void;
  remove(object: object): void;
};

type MeshRuntime = {
  readonly authoredLocal: AuthoredLocalTransform;
  elapsed: number;
  readonly duration: number;
  readonly mesh: MeshFxMesh;
  playing: boolean;
};

type AuthoredLocalTransform = {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
};

type ActiveShake = {
  readonly action: Extract<TimelineAction, { readonly kind: 'camera-shake' }>;
  elapsed: number;
  readonly id: number;
};

function normalizedTimeline(definition: RuntimeDefinition): TimelineDefinition {
  const value = definition.timeline as TimelineDefinition | readonly TimelineEntry[] | undefined;
  if (value === undefined) return { duration: 0, entries: [], kind: 'timeline', speed: 1 };
  const source = Array.isArray(value)
    ? ({ entries: value, kind: 'timeline' } as TimelineDefinition)
    : (value as TimelineDefinition);
  const diagnostics: VfxDiagnostic[] = [];
  for (const [entryIndex, entry] of source.entries.entries()) {
    if (!Number.isFinite(entry.at) || entry.at < 0) {
      diagnostics.push(
        runtimeDiagnostic(
          'NACHI_TIMELINE_TIME_INVALID',
          'Timeline entry time must be non-negative and finite.',
          `timeline.entries[${entryIndex}].at`,
        ),
      );
    }
  }
  const speed = source.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    diagnostics.push(
      runtimeDiagnostic(
        'NACHI_TIMELINE_SPEED_INVALID',
        'Timeline speed must be positive and finite.',
        'timeline.speed',
      ),
    );
  }
  const entries = source.entries
    .map((entry, authorIndex) => ({ authorIndex, entry }))
    .sort((left, right) => left.entry.at - right.entry.at || left.authorIndex - right.authorIndex)
    .map(({ entry }) => entry);
  const lastTime = entries.at(-1)?.at ?? 0;
  const duration = source.duration ?? lastTime;
  if (!Number.isFinite(duration) || duration < lastTime || duration < 0) {
    diagnostics.push(
      runtimeDiagnostic(
        'NACHI_TIMELINE_DURATION_INVALID',
        'Timeline duration must be finite and no earlier than its last entry.',
        'timeline.duration',
      ),
    );
  }
  if (
    (source.loop === true || (typeof source.loop === 'number' && source.loop > 1)) &&
    duration <= 0
  ) {
    diagnostics.push(
      runtimeDiagnostic(
        'NACHI_TIMELINE_LOOP_DURATION_REQUIRED',
        'A looping timeline requires a positive duration.',
        'timeline.duration',
      ),
    );
  }
  if (typeof source.loop === 'number' && (!Number.isSafeInteger(source.loop) || source.loop <= 0)) {
    diagnostics.push(
      runtimeDiagnostic(
        'NACHI_TIMELINE_LOOP_INVALID',
        'Timeline loop count must be a positive safe integer.',
        'timeline.loop',
      ),
    );
  }
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  return {
    ...source,
    duration,
    entries,
    kind: 'timeline',
    speed,
  };
}

function loopCount(loop: TimelineDefinition['loop']): number {
  if (loop === true) return Infinity;
  if (typeof loop === 'number') return loop;
  return 1;
}

function runtimeDiagnostic(
  code: string,
  message: string,
  path?: string,
  severity: VfxDiagnostic['severity'] = 'error',
): VfxDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase: 'runtime',
    severity,
  };
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

function isSceneTarget(value: unknown): value is SceneTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'add' in value &&
    typeof value.add === 'function' &&
    'remove' in value &&
    typeof value.remove === 'function'
  );
}

function cloneMaterial(material: MeshFxMesh['material'], path: string): MeshFxMesh['material'] {
  if ('fx' in material) return cloneTimelineFxMaterial(material as FxNodeMaterial, path);
  return material.clone();
}

function cloneMesh(
  key: string,
  resource: MeshFxRuntimeResource,
): { readonly authoredLocal: AuthoredLocalTransform; readonly mesh: MeshFxMesh } {
  const authoredLocal = Object.freeze({
    position: Object.freeze([
      resource.mesh.position.x,
      resource.mesh.position.y,
      resource.mesh.position.z,
    ] as const),
    quaternion: Object.freeze([
      resource.mesh.quaternion.x,
      resource.mesh.quaternion.y,
      resource.mesh.quaternion.z,
      resource.mesh.quaternion.w,
    ] as const),
    scale: Object.freeze([
      resource.mesh.scale.x,
      resource.mesh.scale.y,
      resource.mesh.scale.z,
    ] as const),
  });
  const mesh = resource.mesh.clone() as MeshFxMesh;
  mesh.material = cloneMaterial(resource.mesh.material, `elements.${key}.material`);
  mesh.visible = false;
  return { authoredLocal, mesh };
}

function setMeshTransform(
  mesh: MeshFxMesh,
  authoredLocal: AuthoredLocalTransform,
  position: PositionInput | undefined,
  rotation: RotationInput | undefined,
): void {
  const [px, py, pz] = vector3(position);
  const [qx, qy, qz, qw] = quaternion(rotation);
  const [ax, ay, az] = authoredLocal.position;
  const tx = 2 * (qy * az - qz * ay);
  const ty = 2 * (qz * ax - qx * az);
  const tz = 2 * (qx * ay - qy * ax);
  mesh.position.set(
    px + ax + qw * tx + qy * tz - qz * ty,
    py + ay + qw * ty + qz * tx - qx * tz,
    pz + az + qw * tz + qx * ty - qy * tx,
  );

  const [aqx, aqy, aqz, aqw] = authoredLocal.quaternion;
  mesh.quaternion.set(
    qw * aqx + qx * aqw + qy * aqz - qz * aqy,
    qw * aqy - qx * aqz + qy * aqw + qz * aqx,
    qw * aqz + qx * aqy - qy * aqx + qz * aqw,
    qw * aqw - qx * aqx - qy * aqy - qz * aqz,
  );
}

function fxMaterials(mesh: MeshFxMesh): FxNodeMaterial[] {
  return 'fx' in mesh.material ? [mesh.material as FxNodeMaterial] : [];
}

export class TimelineEffectInstance<Definition extends RuntimeDefinition = RuntimeDefinition> {
  readonly definition: Definition;
  readonly diagnostics: VfxDiagnostic[] = [];
  readonly id: string;
  readonly #actionListeners = new Set<(event: TimelineActionEvent) => void>();
  readonly #activeEmitters = new Map<string, VfxEffectInstance>();
  readonly #activeShakes: ActiveShake[] = [];
  readonly #cameraShakeTarget: CameraShakeTarget | undefined;
  readonly #companionWarningKeys = new Set<string>();
  readonly #companions = new Set<WeakRef<VfxEffectInstance>>();
  readonly #eventListeners = new Map<string, Set<EffectEventCallback>>();
  readonly #meshRuntimes = new Map<string, MeshRuntime>();
  readonly #retiredEmitterStates = new Map<string, TimelineElementState>();
  readonly #parameters: Record<string, unknown>;
  readonly #scene: SceneTarget | undefined;
  readonly #seed: number;
  readonly #spawnEmitter: (key: string, options: EffectSpawnOptions) => VfxEffectInstance;
  readonly #timeline: TimelineDefinition;
  #attachment: EffectTransformSource | undefined;
  #baseTimeScale: number;
  #cycle = 0;
  #ended = false;
  #entryCursor = 0;
  #hitStopRemaining = 0;
  #hitStopScale = 0;
  #localTime = 0;
  #position: PositionInput | undefined;
  #released = false;
  #rotation: RotationInput | undefined;
  #sequence = 0;
  #shakeOutputActive = false;
  #started = false;
  #state: EffectInstanceState = 'active';

  constructor(
    definition: Definition,
    id: string,
    scene: unknown,
    options: TimelineEffectSpawnOptions<Definition>,
    defaultCameraShakeTarget: CameraShakeTarget | undefined,
    spawnEmitter: (key: string, options: EffectSpawnOptions) => VfxEffectInstance,
  ) {
    this.definition = definition;
    this.id = id;
    this.#scene = isSceneTarget(scene) ? scene : undefined;
    let timelineDiagnostics: readonly VfxDiagnostic[] = [];
    try {
      this.#timeline = normalizedTimeline(definition);
    } catch (error) {
      if (!(error instanceof VfxDiagnosticError)) throw error;
      this.#timeline = { duration: 0, entries: [], kind: 'timeline', speed: 1 };
      timelineDiagnostics = error.diagnostics;
    }
    this.#baseTimeScale = options.timeScale ?? 1;
    this.#seed = options.seed ?? 0;
    this.#position = options.position;
    this.#rotation = options.rotation;
    this.#cameraShakeTarget = options.cameraShakeTarget ?? defaultCameraShakeTarget;
    this.#spawnEmitter = spawnEmitter;
    this.#parameters = { ...(options.parameters as Record<string, unknown> | undefined) };
    if (timelineDiagnostics.length > 0) {
      this.diagnostics.push(...timelineDiagnostics);
      this.#state = 'error';
      return;
    }
    try {
      for (const [key, resource] of getMeshFxResources(definition)) {
        const { authoredLocal, mesh } = cloneMesh(key, resource);
        setMeshTransform(mesh, authoredLocal, this.#position, this.#rotation);
        this.#scene?.add(mesh);
        this.#meshRuntimes.set(key, {
          authoredLocal,
          duration: resource.duration,
          elapsed: 0,
          mesh,
          playing: false,
        });
      }
      if (definition.timeline === undefined) {
        for (const key of Object.keys(definition.elements)) this.#playElement(key);
        this.#started = true;
      }
    } catch (error) {
      const failureDiagnostics =
        error instanceof VfxDiagnosticError
          ? error.diagnostics
          : [
              runtimeDiagnostic(
                'NACHI_TIMELINE_INSTANCE_CONSTRUCTION_FAILED',
                error instanceof Error ? error.message : String(error),
              ),
            ];
      const [first, ...rest] = failureDiagnostics;
      if (first) this.markError(first);
      this.diagnostics.push(...rest);
    }
  }

  get localTime(): number {
    return this.#localTime;
  }

  get state(): EffectInstanceState {
    return this.#state;
  }

  get timeScale(): number {
    return this.#baseTimeScale;
  }

  get cycle(): number {
    return this.#cycle;
  }

  getElementState(key: string): TimelineElementState | undefined {
    this.#assertNotReleased();
    const mesh = this.#meshRuntimes.get(key);
    if (mesh) {
      return {
        aliveCount: undefined,
        localTime: mesh.elapsed,
        playing: mesh.playing,
        visible: mesh.mesh.visible,
      };
    }
    const emitter = this.#activeEmitters.get(key);
    if (!emitter) {
      const retired = this.#retiredEmitterStates.get(key);
      if (retired) return retired;
      return key in this.definition.elements
        ? { aliveCount: undefined, localTime: 0, playing: false, visible: false }
        : undefined;
    }
    return {
      aliveCount: emitter.getEmitter(key)?.aliveCount,
      localTime: emitter.localTime,
      playing: emitter.state === 'active',
      visible: emitter.state === 'active',
    };
  }

  getEmitter(key: string): VfxEmitterRuntimeView | undefined {
    this.#assertNotReleased();
    return this.#activeEmitters.get(key)?.getEmitter(key);
  }

  onAction(callback: (event: TimelineActionEvent) => void): () => void {
    this.#assertNotReleased();
    this.#actionListeners.add(callback);
    return () => this.#actionListeners.delete(callback);
  }

  onMarker(
    name: string,
    callback: (event: TimelineActionEvent & { readonly action: MarkerAction }) => void,
  ): () => void {
    return this.onAction((event) => {
      if (event.action.kind === 'marker' && event.action.name === name) {
        callback(event as TimelineActionEvent & { readonly action: MarkerAction });
      }
    });
  }

  on(event: string, callback: EffectEventCallback): () => void {
    this.#assertNotReleased();
    let listeners = this.#eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    for (const emitter of this.#activeEmitters.values()) emitter.on(event, callback);
    return () => listeners?.delete(callback);
  }

  /** Shares this timeline's effective time scale and hit-stop replacements with a core instance. */
  bindCompanion(instance: VfxEffectInstance): void {
    this.#assertNotReleased();
    this.#visitCompanions(() => undefined);
    if (instance.state === 'released' || instance.state === 'error') {
      this.#warnUnavailableCompanion(instance);
      return;
    }
    for (const reference of this.#companions) {
      if (reference.deref() === instance) return;
    }
    const reference = new WeakRef(instance);
    this.#companions.add(reference);
    if (!this.#synchronizeCompanion(instance)) {
      this.#companions.delete(reference);
      this.#warnUnavailableCompanion(instance);
    }
  }

  /** Stops sharing timeline clock controls with a previously bound core instance. */
  unbindCompanion(instance: VfxEffectInstance): void {
    this.#assertNotReleased();
    for (const reference of this.#companions) {
      const companion = reference.deref();
      if (companion === undefined || companion === instance || companion.state === 'released') {
        this.#companions.delete(reference);
      }
    }
  }

  applyHitStop(durationMs: number, timeScale = 0): void {
    this.#assertNotReleased();
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      !Number.isFinite(timeScale) ||
      timeScale < 0
    ) {
      throw new RangeError('hitStop duration and timeScale must be non-negative finite numbers.');
    }
    this.#hitStopRemaining = durationMs / 1000;
    this.#hitStopScale = timeScale;
    for (const emitter of this.#activeEmitters.values())
      emitter.applyHitStop(durationMs, timeScale);
    this.#visitCompanions((companion) => companion.applyHitStop(durationMs, timeScale));
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

  setParameter<Path extends UserParameterKeys<Definition>>(
    path: Path,
    value: DefinitionParameterValue<Definition, Path>,
  ): void {
    this.#assertNotReleased();
    const parameterDiagnostic = validateRuntimeParameter(
      this.definition.parameters ?? {},
      String(path),
      value,
      true,
    );
    if (parameterDiagnostic) throw new VfxDiagnosticError([parameterDiagnostic]);
    this.#parameters[String(path)] = value;
    for (const emitter of this.#activeEmitters.values()) emitter.setParameter(path, value);
  }

  setTimeScale(timeScale: number): void {
    this.#assertNotReleased();
    if (!Number.isFinite(timeScale) || timeScale < 0) {
      throw new RangeError('timeScale must be a non-negative finite number.');
    }
    this.#baseTimeScale = timeScale;
    for (const emitter of this.#activeEmitters.values()) {
      emitter.setTimeScale(this.#effectiveTimeScale());
    }
    this.#visitCompanions((companion) => companion.setTimeScale(this.#effectiveTimeScale()));
  }

  setTransform(position: PositionInput, rotation?: RotationInput): void {
    this.#assertNotReleased();
    this.#position = position;
    this.#rotation = rotation;
    for (const emitter of this.#activeEmitters.values()) emitter.setTransform(position, rotation);
    for (const runtime of this.#meshRuntimes.values())
      setMeshTransform(runtime.mesh, runtime.authoredLocal, position, rotation);
  }

  stop(): void {
    this.#assertNotReleased();
    this.#stopAllElements();
    this.#state = 'stopped';
  }

  release(): void {
    if (this.#released) return;
    this.#stopAllElements();
    this.#disposeMeshes();
    this.#actionListeners.clear();
    this.#companions.clear();
    this.#eventListeners.clear();
    this.#released = true;
    this.#state = 'released';
  }

  /** @internal Contains one instance failure without rejecting the system update. */
  markError(diagnostic: VfxDiagnostic): void {
    if (this.#released || this.#state === 'error') return;
    this.diagnostics.push(diagnostic);
    this.#state = 'error';
    try {
      this.#stopAllElements();
    } catch (error) {
      this.diagnostics.push(
        runtimeDiagnostic(
          'NACHI_TIMELINE_ERROR_CLEANUP_FAILED',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    this.#disposeMeshes();
    this.#companions.clear();
  }

  #disposeMeshes(): void {
    for (const runtime of this.#meshRuntimes.values()) {
      this.#scene?.remove(runtime.mesh);
      runtime.mesh.material.dispose();
    }
    this.#meshRuntimes.clear();
  }

  /** @internal World seconds until the next action, loop, shake, mesh-life, or hit-stop boundary. */
  timeToBoundary(): number {
    if (this.#state !== 'active') return Infinity;
    const candidates = [this.#hitStopRemaining > EPSILON ? this.#hitStopRemaining : Infinity];
    const rate = this.#currentLocalRate();
    if (rate > EPSILON) {
      const nextEntry = this.#timeline.entries[this.#entryCursor];
      if (nextEntry) candidates.push(Math.max(0, nextEntry.at - this.#localTime) / rate);
      const duration = this.#timeline.duration ?? 0;
      if (!this.#ended && duration >= this.#localTime) {
        candidates.push(Math.max(0, duration - this.#localTime) / rate);
      }
      for (const runtime of this.#meshRuntimes.values()) {
        if (runtime.playing)
          candidates.push(Math.max(0, runtime.duration - runtime.elapsed) / rate);
      }
      for (const shake of this.#activeShakes) {
        candidates.push(
          Math.max(0, (shake.action.duration ?? DEFAULT_SHAKE_DURATION) - shake.elapsed) / rate,
        );
      }
    }
    return Math.min(...candidates.filter((candidate) => candidate > EPSILON));
  }

  /** @internal Defers explicit timeline time-zero actions until callbacks can be registered. */
  beginUpdate(): void {
    this.#visitCompanions(() => undefined);
    if (this.#state !== 'active' || this.#started) return;
    this.#started = true;
    this.#processDueEntries();
    if (this.#state !== 'active') return;
    this.#processCycleBoundary();
    this.#updateCameraShake();
    this.#completeIfDone();
  }

  /** @internal Called after core advances the same exact world segment. */
  advanceSegment(worldDelta: number): void {
    if (this.#state !== 'active') return;
    const hitStopPortion = Math.min(worldDelta, this.#hitStopRemaining);
    const normalPortion = worldDelta - hitStopPortion;
    const localDelta =
      this.#effectiveTimeScale() * (hitStopPortion * this.#hitStopScale + normalPortion);
    this.#hitStopRemaining = Math.max(0, this.#hitStopRemaining - worldDelta);
    this.#localTime += localDelta;
    for (const runtime of this.#meshRuntimes.values()) {
      if (!runtime.playing) continue;
      runtime.elapsed += localDelta;
      const normalizedLife = Math.min(1, runtime.elapsed / runtime.duration);
      for (const material of fxMaterials(runtime.mesh)) {
        material.fx.setTime(this.#localTime);
        setTimelineFxMaterialLife(material, normalizedLife);
      }
      if (runtime.elapsed + EPSILON >= runtime.duration) {
        runtime.playing = false;
        runtime.mesh.visible = false;
      }
    }
    for (const shake of this.#activeShakes) shake.elapsed += localDelta;
    this.#cleanupCompletedEmitters();
    this.#processDueEntries();
    this.#processCycleBoundary();
    this.#updateCameraShake();
    this.#completeIfDone();
  }

  #effectiveTimeScale(): number {
    return this.#baseTimeScale * (this.#timeline.speed ?? 1);
  }

  #synchronizeCompanion(companion: VfxEffectInstance): boolean {
    if (companion.state === 'released' || companion.state === 'error') return false;
    companion.setTimeScale(this.#effectiveTimeScale());
    const stateAfterTimeScale = companion.state as EffectInstanceState;
    if (stateAfterTimeScale === 'released' || stateAfterTimeScale === 'error') return false;
    if (this.#hitStopRemaining > EPSILON) {
      companion.applyHitStop(this.#hitStopRemaining * 1000, this.#hitStopScale);
    }
    const finalState = companion.state as EffectInstanceState;
    return finalState !== 'released' && finalState !== 'error';
  }

  #visitCompanions(operation: (companion: VfxEffectInstance) => void): void {
    for (const reference of this.#companions) {
      const companion = reference.deref();
      if (companion === undefined || companion.state === 'released') {
        this.#companions.delete(reference);
        continue;
      }
      // Wrapper integrations must never forward operations into terminal error instances.
      if (companion.state === 'error') {
        this.#companions.delete(reference);
        this.#warnUnavailableCompanion(companion);
        continue;
      }
      operation(companion);
      const stateAfterOperation = companion.state as EffectInstanceState;
      if (stateAfterOperation === 'released' || stateAfterOperation === 'error') {
        this.#companions.delete(reference);
        if (stateAfterOperation === 'error') this.#warnUnavailableCompanion(companion);
      }
    }
  }

  #warnUnavailableCompanion(companion: VfxEffectInstance): void {
    const state = companion.state;
    if (state !== 'released' && state !== 'error') return;
    const key = `${companion.id}:${state}`;
    if (this.#companionWarningKeys.has(key)) return;
    this.#companionWarningKeys.add(key);
    this.diagnostics.push(
      runtimeDiagnostic(
        'NACHI_TIMELINE_COMPANION_UNAVAILABLE',
        `Companion "${companion.id}" is ${state}; timeline clock controls were not forwarded.`,
        `companions.${companion.id}`,
        'warning',
      ),
    );
  }

  #currentLocalRate(): number {
    return this.#effectiveTimeScale() * (this.#hitStopRemaining > EPSILON ? this.#hitStopScale : 1);
  }

  #processDueEntries(): void {
    while (this.#entryCursor < this.#timeline.entries.length) {
      const entryIndex = this.#entryCursor;
      const entry = this.#timeline.entries[entryIndex]!;
      if (entry.at > this.#localTime + EPSILON) break;
      this.#entryCursor += 1;
      for (const [actionIndex, action] of entry.actions.entries()) {
        const emitter = this.#executeAction(action);
        const event: TimelineActionEvent = {
          action,
          actionIndex,
          cycle: this.#cycle,
          ...(emitter === undefined ? {} : { emitter }),
          entryIndex,
          localTime: entry.at,
          sequence: this.#sequence++,
        };
        for (const listener of this.#actionListeners) {
          try {
            listener(event);
          } catch (error) {
            this.markError(
              runtimeDiagnostic(
                'NACHI_TIMELINE_ACTION_CALLBACK_FAILED',
                error instanceof Error ? error.message : String(error),
              ),
            );
            return;
          }
        }
        if (this.#state !== 'active') return;
      }
    }
  }

  #executeAction(action: TimelineAction): VfxEmitterRuntimeView | undefined {
    if (action.kind === 'play') return this.#playElement(action.target);
    if (action.kind === 'stop') this.#stopElement(action.target);
    else if (action.kind === 'hit-stop')
      this.applyHitStop(action.durationMs, action.timeScale ?? 0);
    else if (action.kind === 'camera-shake') {
      this.#activeShakes.push({ action, elapsed: 0, id: this.#sequence });
    }
    return undefined;
  }

  #playElement(key: string): VfxEmitterRuntimeView | undefined {
    const mesh = this.#meshRuntimes.get(key);
    if (mesh) {
      mesh.elapsed = 0;
      mesh.playing = true;
      mesh.mesh.visible = true;
      for (const material of fxMaterials(mesh.mesh)) {
        material.fx.setTime(this.#localTime);
        setTimelineFxMaterialLife(material, 0);
      }
      return undefined;
    }
    this.#stopElement(key);
    this.#retiredEmitterStates.delete(key);
    const emitter = this.#spawnEmitter(key, {
      parameters: this.#parameters,
      seed: this.#seed,
      timeScale: this.#effectiveTimeScale(),
      ...(this.#position === undefined ? {} : { position: this.#position }),
      ...(this.#rotation === undefined ? {} : { rotation: this.#rotation }),
    });
    for (const [event, listeners] of this.#eventListeners) {
      for (const listener of listeners) emitter.on(event, listener);
    }
    if (this.#hitStopRemaining > EPSILON) {
      emitter.applyHitStop(this.#hitStopRemaining * 1000, this.#hitStopScale);
    }
    if (emitter.state === 'error') {
      this.diagnostics.push(...emitter.diagnostics);
      emitter.release();
      this.#state = 'error';
      return;
    }
    this.#activeEmitters.set(key, emitter);
    return emitter.getEmitter(key);
  }

  #stopElement(key: string): void {
    const mesh = this.#meshRuntimes.get(key);
    if (mesh) {
      mesh.playing = false;
      mesh.mesh.visible = false;
    }
    const emitter = this.#activeEmitters.get(key);
    if (emitter) {
      this.#retainEmitterState(key, emitter);
      emitter.stop();
      emitter.release();
      this.#activeEmitters.delete(key);
    }
  }

  #stopAllElements(): void {
    for (const key of this.#meshRuntimes.keys()) this.#stopElement(key);
    for (const key of [...this.#activeEmitters.keys()]) this.#stopElement(key);
    this.#activeShakes.length = 0;
    this.#emitTerminalZeroShake();
  }

  #cleanupCompletedEmitters(): void {
    for (const [key, emitter] of this.#activeEmitters) {
      if (emitter.state === 'active') continue;
      if (emitter.state === 'error') {
        this.diagnostics.push(...emitter.diagnostics);
        this.#state = 'error';
      }
      this.#retainEmitterState(key, emitter);
      emitter.release();
      this.#activeEmitters.delete(key);
    }
  }

  #retainEmitterState(key: string, emitter: VfxEffectInstance): void {
    // Mesh runtimes retain their terminal elapsed value. Keep the emitter's terminal clock too so
    // getElementState() has one completion contract instead of resetting only emitters to zero.
    this.#retiredEmitterStates.set(key, {
      aliveCount: undefined,
      localTime: emitter.localTime,
      playing: false,
      visible: false,
    });
  }

  #processCycleBoundary(): void {
    const duration = this.#timeline.duration ?? 0;
    if (this.#ended || this.#localTime + EPSILON < duration) return;
    if (this.#cycle + 1 >= loopCount(this.#timeline.loop)) {
      this.#ended = true;
      // The final track boundary owns the same child truncation as a loop boundary. Without this,
      // an intentionally unbounded continuous emitter can keep the parent timeline active forever.
      // Only an exact zero-duration at(0) shorthand has no later boundary and retains its
      // established behavior of letting the immediately played child determine completion.
      // Every positive duration owns final-boundary truncation, including sub-epsilon tracks.
      if (duration > 0) this.#stopAllElements();
      return;
    }
    this.#stopAllElements();
    this.#cycle += 1;
    this.#localTime = Math.max(0, this.#localTime - duration);
    this.#entryCursor = 0;
    this.#processDueEntries();
  }

  #completeIfDone(): void {
    if (this.#state !== 'active' || !this.#ended) return;
    const meshPlaying = [...this.#meshRuntimes.values()].some(({ playing }) => playing);
    if (!meshPlaying && this.#activeEmitters.size === 0 && this.#activeShakes.length === 0) {
      this.#state = 'complete';
    }
  }

  #updateCameraShake(): void {
    const active = this.#activeShakes.filter(
      (shake) => shake.elapsed + EPSILON < (shake.action.duration ?? DEFAULT_SHAKE_DURATION),
    );
    this.#activeShakes.length = 0;
    this.#activeShakes.push(...active);
    if (active.length === 0) {
      this.#emitTerminalZeroShake();
      return;
    }
    const translation = [0, 0, 0] as [number, number, number];
    const rotation = [0, 0, 0] as [number, number, number];
    let maximumDecay = 0;
    for (const shake of active) {
      const duration = shake.action.duration ?? DEFAULT_SHAKE_DURATION;
      const frequency = shake.action.frequency ?? DEFAULT_SHAKE_FREQUENCY;
      const decay = Math.max(0, 1 - shake.elapsed / duration);
      maximumDecay = Math.max(maximumDecay, decay);
      for (let axis = 0; axis < 3; axis += 1) {
        translation[axis] =
          translation[axis]! +
          noise(this.#seed, shake.id, axis, shake.elapsed * frequency) *
            shake.action.strength *
            decay;
        rotation[axis] =
          rotation[axis]! +
          noise(this.#seed, shake.id, axis + 3, shake.elapsed * frequency) *
            shake.action.strength *
            decay *
            0.15;
      }
    }
    this.#cameraShakeTarget?.({
      cycle: this.#cycle,
      decay: maximumDecay,
      effectId: this.id,
      localTime: this.#localTime,
      rotation,
      translation,
    });
    this.#shakeOutputActive = true;
  }

  #emitTerminalZeroShake(): void {
    if (!this.#shakeOutputActive) return;
    this.#cameraShakeTarget?.({
      cycle: this.#cycle,
      decay: 0,
      effectId: this.id,
      localTime: this.#localTime,
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });
    this.#shakeOutputActive = false;
  }

  #assertNotReleased(): void {
    if (!this.#released) return;
    throw new VfxDiagnosticError([
      runtimeDiagnostic(
        'NACHI_INSTANCE_RELEASED',
        `Timeline effect instance "${this.id}" has been released.`,
      ),
    ]);
  }
}

function noise(seed: number, shakeId: number, axis: number, phase: number): number {
  const lower = Math.floor(phase);
  const fraction = phase - lower;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  const sample = (index: number) =>
    pcgRandomFloat(index, seed ^ hashModuleLabel('timeline/camera-shake'), axis, shakeId) * 2 - 1;
  return sample(lower) * (1 - smooth) + sample(lower + 1) * smooth;
}

export class VFXSystem<Renderer = unknown, Scene = unknown> {
  readonly renderer: Renderer;
  readonly scene: Scene | undefined;
  readonly #cameraShakeTarget: CameraShakeTarget | undefined;
  readonly #core: CoreVFXSystem<Renderer, Scene>;
  readonly #fixedStep: FixedStepAccumulator | undefined;
  readonly #instances = new Map<string, TimelineEffectInstance>();
  readonly #now: () => number;
  readonly #subDefinitions = new WeakMap<
    object,
    Map<string, EffectDefinition<EffectElements, ParameterSchema>>
  >();
  #instanceSequence = 0;
  #lastTimestamp: number | undefined;
  #updateQueue: Promise<void> = Promise.resolve();

  constructor(renderer: Renderer, scene?: Scene, options: TimelineSystemOptions = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.#cameraShakeTarget = options.cameraShakeTarget;
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#fixedStep = options.fixedTimeStep
      ? new FixedStepAccumulator(options.fixedTimeStep)
      : undefined;
    this.#core = new CoreVFXSystem(renderer, scene, timelineCoreOptions(options));
  }

  get instanceCount(): number {
    return this.#instances.size;
  }

  get time(): number {
    return this.#core.time;
  }

  setCamera(camera: VfxCameraState): void {
    this.#core.setCamera(camera);
  }

  spawn<Definition extends RuntimeDefinition>(
    definition: Definition,
    options: TimelineEffectSpawnOptions<Definition> = {},
  ): TimelineEffectInstance<Definition> {
    const id = `nachi-timeline-${++this.#instanceSequence}`;
    const instance = new TimelineEffectInstance(
      definition,
      id,
      this.scene,
      options,
      this.#cameraShakeTarget,
      (key, spawnOptions) => this.#spawnEmitter(definition, key, spawnOptions),
    );
    this.#instances.set(id, instance);
    return instance;
  }

  prepare<Definition extends RuntimeDefinition>(
    definition: Definition,
    options: TimelinePrepareOptions = {},
  ): Promise<void> {
    const run = async () => {
      options.signal?.throwIfAborted();
      const emitterKeys = Object.entries(definition.elements)
        .filter((entry) => entry[1].kind === 'emitter')
        .map(([key]) => key);
      const meshResources = [...getMeshFxResources(definition)];
      const total = emitterKeys.length + meshResources.length;
      let completed = 0;
      options.onProgress?.({ completed, total });

      for (const key of emitterKeys) {
        options.signal?.throwIfAborted();
        await this.#core.prepare(this.#subDefinition(definition, key), {
          ...(options.preparer === undefined ? {} : { preparer: options.preparer }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        completed += 1;
        options.onProgress?.({ completed, resource: { key, kind: 'emitter' }, total });
      }

      for (const [key, resource] of meshResources) {
        options.signal?.throwIfAborted();
        const { mesh } = cloneMesh(key, resource);
        // Renderer compilation traverses visible objects; the clone is never attached to a scene.
        mesh.visible = true;
        let retained = false;
        try {
          const result = await options.preparer?.prepareObject?.({
            key,
            object: mesh,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          retained = result?.retained === true;
          options.signal?.throwIfAborted();
        } finally {
          mesh.removeFromParent();
          if (!retained) mesh.material.dispose();
        }
        completed += 1;
        options.onProgress?.({ completed, resource: { key, kind: 'object' }, total });
      }
    };
    const scheduled = this.#updateQueue.then(run, run);
    this.#updateQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  update(deltaSeconds?: number): Promise<void> {
    const delta = deltaSeconds ?? this.#measuredDelta();
    if (!Number.isFinite(delta) || delta < 0) {
      return Promise.reject(new RangeError('deltaSeconds must be a non-negative finite number.'));
    }
    const run = async () => {
      this.#deleteReleasedInstances();
      for (const instance of this.#instances.values()) {
        this.#advanceInstance(instance, () => instance.beginUpdate());
      }
      const steps = this.#fixedStep ? this.#fixedStep.advance(delta) : [delta];
      if (delta === 0) await this.#core.update(0);
      for (const step of steps) await this.#advanceStep(step);
      this.#deleteReleasedInstances();
    };
    const scheduled = this.#updateQueue.then(run, run);
    this.#updateQueue = scheduled.catch(() => undefined);
    return scheduled;
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

  async #advanceStep(deltaSeconds: number): Promise<void> {
    let remaining = deltaSeconds;
    let iterations = 0;
    while (remaining > EPSILON) {
      if (++iterations > 10_000) {
        const diagnostic = runtimeDiagnostic(
          'NACHI_TIMELINE_BOUNDARY_OVERFLOW',
          `Timeline update exceeded 10000 boundaries; the remaining ${remaining} world seconds were clamped.`,
          undefined,
          'warning',
        );
        for (const instance of this.#instances.values()) {
          if (instance.state === 'active') instance.diagnostics.push(diagnostic);
        }
        break;
      }
      const activeInstances = [...this.#instances.values()].filter(
        (instance) => instance.state === 'active',
      );
      for (const instance of activeInstances) {
        this.#advanceInstance(instance, () => instance.syncAttachment());
      }
      const healthyInstances = activeInstances.filter((instance) => instance.state === 'active');
      const boundary = Math.min(
        remaining,
        ...healthyInstances.map((instance) => instance.timeToBoundary()),
      );
      const segment = Number.isFinite(boundary) && boundary > EPSILON ? boundary : remaining;
      await this.#core.update(segment);
      for (const instance of healthyInstances) {
        this.#advanceInstance(instance, () => instance.advanceSegment(segment));
      }
      remaining = Math.max(0, remaining - segment);
    }
  }

  #advanceInstance(instance: TimelineEffectInstance, operation: () => void): void {
    if (instance.state !== 'active') return;
    try {
      operation();
    } catch (error) {
      instance.markError(
        runtimeDiagnostic(
          'NACHI_TIMELINE_INSTANCE_UPDATE_FAILED',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  #deleteReleasedInstances(): void {
    for (const [id, instance] of this.#instances) {
      if (instance.state === 'released') this.#instances.delete(id);
    }
  }

  #spawnEmitter(
    definition: RuntimeDefinition,
    key: string,
    options: EffectSpawnOptions,
  ): VfxEffectInstance {
    return this.#core.spawn(this.#subDefinition(definition, key), options);
  }

  #subDefinition(
    definition: RuntimeDefinition,
    key: string,
  ): EffectDefinition<EffectElements, ParameterSchema> {
    const element = definition.elements[key];
    if (element?.kind !== 'emitter') {
      throw new VfxDiagnosticError([
        runtimeDiagnostic(
          'NACHI_TIMELINE_ELEMENT_ADAPTER_MISSING',
          `Timeline target "${key}" is neither an emitter nor an adapted mesh-fx element.`,
          `elements.${key}`,
        ),
      ]);
    }
    let definitions = this.#subDefinitions.get(definition);
    if (!definitions) {
      definitions = new Map();
      this.#subDefinitions.set(definition, definitions);
    }
    let subDefinition = definitions.get(key);
    if (!subDefinition) {
      subDefinition = {
        elements: { [key]: element },
        kind: 'effect',
        ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
      };
      definitions.set(key, subDefinition);
    }
    return subDefinition!;
  }
}
