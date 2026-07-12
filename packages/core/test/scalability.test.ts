import { describe, expect, it } from 'vitest';

import { billboard, burst, defineEffect, defineEmitter, meshRenderer } from '../src/index.js';
import {
  applyEmitterQualityTier,
  detectDeviceQualityTier,
  mergeBoundingSpheres,
  resolveEmitterQuality,
  selectDeviceQualityTier,
  significanceScore,
  sphereIntersectsFrustum,
} from '../src/scalability.js';

describe('M11 quality tiers and device selection', () => {
  it('selects deterministic tiers from backend limits/features and exposes reasons', async () => {
    const webgl = selectDeviceQualityTier({ backend: 'webgl2', features: [], limits: {} });
    expect(webgl.tier).toBe('low');
    expect(webgl.reasons[0]).toContain('WebGL2');

    const epic = selectDeviceQualityTier({
      backend: 'webgpu',
      features: ['shader-f16', 'timestamp-query'],
      limits: {
        maxComputeInvocationsPerWorkgroup: 512,
        maxStorageBufferBindingSize: 256 * 1024 * 1024,
        maxStorageBuffersPerShaderStage: 10,
      },
    });
    expect(epic.tier).toBe('epic');

    const override = await detectDeviceQualityTier({ fallbackBackend: 'webgl2', override: 'high' });
    expect(override).toMatchObject({ source: 'override', tier: 'high' });
    expect(override.reasons[0]).toContain('override');
  });

  it('layers serializable emitter overrides and removes only gated billboard features', () => {
    const emitter = defineEmitter({
      capacity: 100,
      quality: {
        low: { capacityScale: 0.4, spawnRateScale: 0.3 },
      },
      render: billboard({ blending: 'alpha', lit: true, soft: true, sorted: true }),
      spawn: burst({ count: 10 }),
    });
    expect(JSON.parse(JSON.stringify(emitter)).quality.low).toEqual({
      capacityScale: 0.4,
      spawnRateScale: 0.3,
    });
    expect(resolveEmitterQuality(emitter, 'low')).toMatchObject({
      capacityScale: 0.4,
      features: { lit: false, soft: false, sorted: false },
      spawnRateScale: 0.3,
    });
    expect(applyEmitterQualityTier(emitter, 'low').render).toMatchObject({
      config: { lit: false, soft: false, sorted: false },
    });
    expect(applyEmitterQualityTier(emitter, 'epic').render).toMatchObject({
      config: { lit: true, soft: true, sorted: true },
    });
  });

  it('gates sorted mesh variants and omits empty inherited quality objects', () => {
    const base = defineEmitter({
      capacity: 4,
      render: meshRenderer({
        blending: 'alpha',
        geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh.glb' },
        sorted: true,
      }),
      spawn: burst({ count: 1 }),
    });
    const inherited = defineEmitter(base, { quality: { low: { features: {} } } });
    expect('quality' in inherited).toBe(false);
    expect(applyEmitterQualityTier(inherited, 'low').render).toMatchObject([
      { config: { sorted: false } },
    ]);
  });

  it('rejects invalid bounds, quality scales, and culling distances at authoring time', () => {
    expect(() =>
      defineEmitter({
        bounds: { radius: -1 },
        capacity: 1,
        render: billboard({}),
        spawn: burst({ count: 1 }),
      }),
    ).toThrowError(/bounds radius/);
    expect(() =>
      defineEmitter({
        bounds: { center: [0, Number.NaN, 0], radius: 1 },
        capacity: 1,
        render: billboard({}),
        spawn: burst({ count: 1 }),
      }),
    ).toThrowError(/bounds center/);
    expect(() =>
      defineEmitter({
        capacity: 1,
        quality: { low: { spawnRateScale: 1.1 } },
        render: billboard({}),
        spawn: burst({ count: 1 }),
      }),
    ).toThrowError(/spawnRateScale/);
    const valid = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    expect(() =>
      defineEffect({
        elements: { particles: valid },
        scalability: { culling: { distance: { fadeEnd: 3, fadeStart: 4 } } },
      }),
    ).toThrowError(/fadeStart/);
  });
});

describe('M11 deterministic culling/significance mathematics', () => {
  const camera = {
    projectionMatrix: [1, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewportSize: [320, 180] as const,
  };

  it('uses a non-symmetric frustum case and conservative sphere radius', () => {
    expect(sphereIntersectsFrustum({ center: [0.75, 0.1, 0.5], radius: 0.1 }, camera)).toBe(true);
    expect(sphereIntersectsFrustum({ center: [-1.35, 0.1, 0.5], radius: 0.1 }, camera)).toBe(false);
  });

  it('extracts the near plane according to the explicit clip-depth convention', () => {
    const near = 0.1;
    const far = 10;
    const glProjection = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      -2 / (far - near),
      0,
      0,
      0,
      -(far + near) / (far - near),
      1,
    ];
    const sphere = { center: [0, 0, -0.2] as const, radius: 0.01 };
    expect(
      sphereIntersectsFrustum(sphere, {
        ...camera,
        coordinateSystem: 'webgl',
        projectionMatrix: glProjection,
      }),
    ).toBe(true);
    expect(
      sphereIntersectsFrustum(sphere, {
        ...camera,
        coordinateSystem: 'webgpu',
        projectionMatrix: glProjection,
      }),
    ).toBe(false);
  });

  it('combines distance, projected occupancy, and priority with the documented formula', () => {
    const low = significanceScore({
      camera,
      priority: 0,
      sphere: { center: [0.2, 0.1, 8], radius: 0.25 },
    });
    const high = significanceScore({
      camera,
      priority: 1,
      sphere: { center: [-0.4, 0.3, 2], radius: 0.5 },
    });
    expect(high.score).toBe(high.priority * 4 + high.screenOccupancy * 2 + high.distanceScore);
    expect(high.score).toBeGreaterThan(low.score);
    expect(
      significanceScore({ camera, priority: 1, sphere: { center: [-0.4, 0.3, 2], radius: 0.5 } }),
    ).toEqual(high);
  });

  it('merges off-axis spheres without mirroring their center', () => {
    const merged = mergeBoundingSpheres([
      { center: [-2, 0.5, 0], radius: 1 },
      { center: [4, -0.5, 0], radius: 2 },
    ]);
    const distance = Math.hypot(6, -1);
    const shift = ((distance + 3) / 2 - 1) / distance;
    expect(merged.center[0]).toBeCloseTo(-2 + 6 * shift);
    expect(merged.center[1]).toBeCloseTo(0.5 - shift);
    expect(merged.radius).toBeCloseTo((Math.hypot(6, -1) + 3) / 2);
  });
});
