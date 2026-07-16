import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';

import { projectWorldTarget, updateWorldShockwaves, worldShockwave } from './post-target';

const SOURCE = {
  duration: 0.7,
  enabled: 1,
  radius: 0.02,
  ringWidth: 0.12,
  speed: 0.8,
  startTime: 0.9,
  strength: 0.05,
} as const;

function camera(): THREE.PerspectiveCamera {
  const value = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 40);
  value.position.set(0, 1, 6.2);
  value.lookAt(0, 0.1, 0);
  value.updateMatrixWorld(true);
  return value;
}

describe('showcase world shockwave projection', () => {
  it('follows orbit, pan, zoom, FOV, and aspect changes from the current camera', () => {
    const view = camera();
    const binding = worldShockwave(view, [2.3, 0, 0], SOURCE);
    const initial = binding.source.center;
    const setShockwave = vi.fn();

    view.position.add(new THREE.Vector3(1.1, 0.45, -0.75));
    view.lookAt(0.3, -0.05, 0.2);
    view.fov = 54;
    view.aspect = 1.32;
    view.updateProjectionMatrix();
    updateWorldShockwaves(view, { setShockwave }, [binding]);

    const expected = projectWorldTarget(view, [2.3, 0, 0]);
    expect(setShockwave).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ center: expected.center, enabled: 1 }),
    );
    expect(
      Math.hypot(expected.center[0] - initial[0], expected.center[1] - initial[1]),
    ).toBeGreaterThan(0.02);
  });

  it('preserves author disabling and disables targets behind or outside the viewport', () => {
    const view = camera();
    const setShockwave = vi.fn();
    const disabled = worldShockwave(view, [0, 0, 0], { ...SOURCE, enabled: 0 });
    const behind = worldShockwave(view, [0, 1, 8], SOURCE);
    const offscreen = worldShockwave(view, [100, 0, 0], SOURCE);

    expect([disabled, behind, offscreen].map(({ source }) => source.enabled)).toEqual([0, 0, 0]);
    view.position.x += 0.5;
    updateWorldShockwaves(view, { setShockwave }, [disabled, behind, offscreen]);

    expect(setShockwave.mock.calls.map(([, source]) => source.enabled)).toEqual([0, 0, 0]);
    expect(setShockwave.mock.calls[1]?.[1].center.every(Number.isFinite)).toBe(true);
    expect(setShockwave.mock.calls[2]?.[1].center.every(Number.isFinite)).toBe(true);
  });

  it('keeps the last finite center when a target reaches the camera plane', () => {
    const view = camera();
    const binding = worldShockwave(view, [0, 0, 0], SOURCE);
    const previousCenter = [...binding.source.center];
    const setShockwave = vi.fn();

    view.position.set(0, 0, 0);
    view.lookAt(0, 0, -1);
    updateWorldShockwaves(view, { setShockwave }, [binding]);

    expect(setShockwave).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ center: previousCenter, enabled: 0 }),
    );
    expect(setShockwave.mock.lastCall?.[1].center.every(Number.isFinite)).toBe(true);
  });

  it('does not rewrite post controls while a fixed projection is unchanged', () => {
    const view = camera();
    const binding = worldShockwave(view, [0, 0, 0], SOURCE);
    const setShockwave = vi.fn();

    updateWorldShockwaves(view, { setShockwave }, [binding]);

    expect(setShockwave).not.toHaveBeenCalled();
  });

  it.each([
    ['WebGL', THREE.WebGLCoordinateSystem],
    ['WebGPU', THREE.WebGPUCoordinateSystem],
  ])('uses camera-space near/far visibility under %s and reversed depth projection', (_name, coordinateSystem) => {
    const view = new THREE.PerspectiveCamera(50, 1, 0.25, 12);
    view.coordinateSystem = coordinateSystem;
    view.updateProjectionMatrix();
    view.updateMatrixWorld(true);
    const epsilon = 1e-4;

    expect(projectWorldTarget(view, [0, 0, -(view.near - epsilon)]).visible).toBe(false);
    expect(projectWorldTarget(view, [0, 0, -(view.near + epsilon)]).visible).toBe(true);
    expect(projectWorldTarget(view, [0, 0, -(view.far - epsilon)]).visible).toBe(true);
    expect(projectWorldTarget(view, [0, 0, -(view.far + epsilon)]).visible).toBe(false);

    // Only the clip-depth row is reversed. Geometric visibility must not depend on NDC z.
    view.projectionMatrix.elements[10] *= -1;
    view.projectionMatrix.elements[14] *= -1;
    expect(projectWorldTarget(view, [0, 0, -(view.near + epsilon)]).visible).toBe(true);
    expect(projectWorldTarget(view, [0, 0, -(view.far - epsilon)]).visible).toBe(true);
    expect(projectWorldTarget(view, [0, 0, -(view.near - epsilon)]).visible).toBe(false);
    expect(projectWorldTarget(view, [0, 0, -(view.far + epsilon)]).visible).toBe(false);
  });

  it('rejects behind/offscreen targets and re-enables them when the camera re-enters', () => {
    const view = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
    view.updateMatrixWorld(true);
    const binding = worldShockwave(view, [0, 0, 1], SOURCE);
    const setShockwave = vi.fn();
    expect(binding.source.enabled).toBe(0);

    view.position.set(0, 0, 3);
    view.lookAt(0, 0, 1);
    updateWorldShockwaves(view, { setShockwave }, [binding]);
    expect(setShockwave.mock.lastCall?.[1]).toEqual(
      expect.objectContaining({ center: [0.5, 0.5], enabled: 1 }),
    );

    view.lookAt(100, 0, 1);
    updateWorldShockwaves(view, { setShockwave }, [binding]);
    expect(setShockwave.mock.lastCall?.[1].enabled).toBe(0);

    view.lookAt(0, 0, 1);
    updateWorldShockwaves(view, { setShockwave }, [binding]);
    expect(setShockwave.mock.lastCall?.[1].enabled).toBe(1);
  });

  it('reuses the binding payload and center tuple while the camera moves', () => {
    const view = camera();
    const binding = worldShockwave(view, [1.4, 0, 0], SOURCE);
    const setShockwave = vi.fn();

    view.position.x += 0.2;
    updateWorldShockwaves(view, { setShockwave }, [binding]);
    view.position.x += 0.2;
    updateWorldShockwaves(view, { setShockwave }, [binding]);

    expect(setShockwave).toHaveBeenCalledTimes(2);
    expect(setShockwave.mock.calls[1]?.[1]).toBe(setShockwave.mock.calls[0]?.[1]);
    expect(setShockwave.mock.calls[1]?.[1].center).toBe(setShockwave.mock.calls[0]?.[1].center);
  });
});
