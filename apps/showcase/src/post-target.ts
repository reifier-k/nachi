import type { PostPipelineControls, ShockwaveSource } from '@nachi-vfx/post';
import * as THREE from 'three/webgpu';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type MutableVec2 = [number, number];

export type ShowcaseShockwaveSource = Readonly<
  Required<Omit<ShockwaveSource, 'center'>> & {
    readonly center: Vec2;
    readonly duration: number;
    readonly enabled: number;
    readonly radius: number;
    readonly ringWidth: number;
    readonly speed: number;
    readonly startTime: number;
    readonly strength: number;
  }
>;

export interface WorldShockwaveBinding {
  readonly authorEnabled: number;
  readonly source: ShowcaseShockwaveSource;
  readonly worldTarget: Vec3;
}

interface MutableShockwavePayload {
  center: MutableVec2;
  duration: number;
  enabled: number;
  radius: number;
  ringWidth: number;
  speed: number;
  startTime: number;
  strength: number;
}

interface ProjectionState {
  readonly center: MutableVec2;
  readonly payload: MutableShockwavePayload;
  enabled: number;
}

const cameraSpaceTarget = new THREE.Vector3();
const projectedTarget = new THREE.Vector3();
const query = typeof location === 'undefined' ? undefined : new URLSearchParams(location.search);
const freezePostProjection = query?.get('freezePostProjection') === '1';
const projectionState = new WeakMap<WorldShockwaveBinding, ProjectionState>();

/** Writes into a caller-owned tuple so the per-frame path creates no projection payloads. */
function projectCurrentWorldTarget(
  camera: THREE.PerspectiveCamera,
  worldTarget: Vec3,
  center: MutableVec2,
): boolean {
  cameraSpaceTarget
    .set(worldTarget[0], worldTarget[1], worldTarget[2])
    .applyMatrix4(camera.matrixWorldInverse);
  projectedTarget.set(worldTarget[0], worldTarget[1], worldTarget[2]).project(camera);
  const projectedX = 0.5 + projectedTarget.x * 0.5;
  const projectedY = 0.5 - projectedTarget.y * 0.5;
  const depth = -cameraSpaceTarget.z;
  if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY) || !Number.isFinite(depth)) {
    return false;
  }
  center[0] = projectedX;
  center[1] = projectedY;
  return (
    depth >= camera.near &&
    depth <= camera.far &&
    center[0] >= 0 &&
    center[0] <= 1 &&
    center[1] >= 0 &&
    center[1] <= 1
  );
}

export function projectWorldTarget(
  camera: THREE.PerspectiveCamera,
  worldTarget: Vec3,
): { readonly center: Vec2; readonly visible: boolean } {
  camera.updateMatrixWorld(true);
  const center: MutableVec2 = [0, 0];
  return { center, visible: projectCurrentWorldTarget(camera, worldTarget, center) };
}

export function worldShockwave(
  camera: THREE.PerspectiveCamera,
  worldTarget: Vec3,
  source: Omit<ShowcaseShockwaveSource, 'center'>,
): WorldShockwaveBinding {
  const projected = projectWorldTarget(camera, worldTarget);
  const enabled = projected.visible ? source.enabled : 0;
  const binding = Object.freeze({
    authorEnabled: source.enabled,
    source: Object.freeze({ ...source, center: projected.center, enabled }),
    worldTarget: Object.freeze([...worldTarget]) as Vec3,
  });
  const center: MutableVec2 = [projected.center[0], projected.center[1]];
  projectionState.set(binding, {
    center,
    enabled,
    payload: {
      center,
      duration: source.duration,
      enabled,
      radius: source.radius,
      ringWidth: source.ringWidth,
      speed: source.speed,
      startTime: source.startTime,
      strength: source.strength,
    },
  });
  return binding;
}

/** Reprojects world-authored impact points after the final camera transform for this frame. */
export function updateWorldShockwaves(
  camera: THREE.PerspectiveCamera,
  controls: Pick<PostPipelineControls, 'setShockwave'>,
  bindings: readonly WorldShockwaveBinding[],
): void {
  if (freezePostProjection) return;
  camera.updateMatrixWorld(true);
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const state = projectionState.get(binding);
    if (!state) throw new Error('World shockwave binding is missing projection state.');
    const previousX = state.center[0];
    const previousY = state.center[1];
    const enabled = projectCurrentWorldTarget(camera, binding.worldTarget, state.center)
      ? binding.authorEnabled
      : 0;
    if (
      state.enabled === enabled &&
      previousX === state.center[0] &&
      previousY === state.center[1]
    ) {
      continue;
    }
    state.enabled = enabled;
    state.payload.enabled = enabled;
    controls.setShockwave(index, state.payload);
  }
}
