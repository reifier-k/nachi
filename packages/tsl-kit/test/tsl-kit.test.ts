import { DataTexture, RGBAFormat } from 'three';
import type Node from 'three/src/nodes/core/Node.js';
import { float, uv, vec3 } from 'three/tsl';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  TslKitDiagnosticError,
  dissolve,
  distortionUV,
  flowMap,
  fresnel,
  polarUV,
  rimLight,
  uvFlow,
} from '../src';
import {
  blendFlowMapSamplesCpu,
  dissolveCpu,
  distortionUVCpu,
  flowMapPhasesCpu,
  fresnelFactorCpu,
  polarUVCpu,
  uvFlowCpu,
} from '../src/math';

function dataTexture(...rgba: number[]): DataTexture {
  const texture = new DataTexture(
    new Uint8Array(rgba),
    Math.max(1, rgba.length / 4),
    1,
    RGBAFormat,
  );
  texture.needsUpdate = true;
  return texture;
}

function expectNode(node: Node, minimumGraphSize = 2): void {
  expect(node.isNode).toBe(true);
  let count = 0;
  node.traverse(() => {
    count += 1;
  });
  expect(count).toBeGreaterThanOrEqual(minimumGraphSize);
}

describe('@nachi/tsl-kit node graphs', () => {
  const noise = dataTexture(64, 192, 128, 255, 224, 96, 128, 255);
  const map = dataTexture(0, 32, 255, 255, 255, 64, 0, 255);

  it('constructs every public shader part with typed outputs and node thresholds', () => {
    const dissolved = dissolve({
      edgeColor: '#ff8040',
      edgeWidth: float(0.1),
      noiseTexture: noise,
      threshold: float(0.5),
      uv: uv(),
    });
    const flowedUv = uvFlow({ speed: [0.25, -0.5], time: float(2), uv: uv() });
    const polar = polarUV({ center: [0.25, 0.75], rotation: Math.PI / 4, uv: uv() });
    const edge = fresnel({ color: 0x66ddff, normal: vec3(0, 0, 1), power: 3 });
    const rim = rimLight({
      baseColor: '#101820',
      intensity: 2,
      lightColor: '#ffcc80',
      normal: vec3(0, 0, 1),
      viewDirection: vec3(0, 0, 1),
    });
    const distorted = distortionUV({
      noiseTexture: noise,
      speed: [0.1, 0.2],
      strength: 0.05,
      time: float(1),
      uv: uv(),
    });
    const flowedMap = flowMap({
      flowTexture: noise,
      map,
      strength: 0.2,
      time: float(0.25),
      uv: uv(),
    });

    expectTypeOf(dissolved).toMatchTypeOf<Node<'vec4'>>();
    expectTypeOf(flowedUv).toMatchTypeOf<Node<'vec2'>>();
    expectTypeOf(polar).toMatchTypeOf<Node<'vec2'>>();
    expectTypeOf(edge).toMatchTypeOf<Node<'vec3'>>();
    expectTypeOf(rim).toMatchTypeOf<Node<'vec3'>>();
    expectTypeOf(distorted).toMatchTypeOf<Node<'vec2'>>();
    expectTypeOf(flowedMap).toMatchTypeOf<Node<'vec4'>>();
    [dissolved, flowedUv, polar, edge, rim, distorted, flowedMap].forEach((node) =>
      expectNode(node),
    );
  });

  it('reports stable diagnostics for invalid constants and resources', () => {
    const cases = [
      () => dissolve({ edgeWidth: -0.01, noiseTexture: noise, threshold: 0.5 }),
      () => dissolve({ noiseTexture: {} as DataTexture, threshold: 0.5 }),
      () => uvFlow({ speed: [Number.NaN, 0], time: 0 }),
      () => polarUV({ center: [0.5, Number.POSITIVE_INFINITY] }),
      () => fresnel({ power: 0 }),
      () => rimLight({ baseColor: 0, intensity: -1 }),
      () => rimLight({ baseColor: 0, power: 0 }),
      () => distortionUV({ noiseTexture: noise, strength: Number.NaN, time: 0 }),
      () => flowMap({ flowTexture: noise, map: {} as DataTexture, time: 0 }),
    ];

    for (const build of cases) {
      expect(build).toThrow(TslKitDiagnosticError);
      try {
        build();
      } catch (error) {
        expect((error as TslKitDiagnosticError).diagnostic.path).toMatch(/\w+\.\w+/);
      }
    }
  });

  it('rejects invalid color strings before Three emits a warning', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => fresnel({ color: 'definitely-not-a-color' })).toThrow(TslKitDiagnosticError);
      try {
        fresnel({ color: 'definitely-not-a-color' });
      } catch (error) {
        expect((error as TslKitDiagnosticError).diagnostic).toMatchObject({
          code: 'NACHI_TSLKIT_INVALID_PARAMETER',
          path: 'fresnel.color',
        });
      }
      expect(warning).not.toHaveBeenCalled();
      expect(() => fresnel({ color: 'rebeccapurple' })).not.toThrow();
      expect(() => fresnel({ color: 'rgb(12, 34, 56)' })).not.toThrow();
    } finally {
      warning.mockRestore();
    }
  });
});

describe('@nachi/tsl-kit CPU mirror math', () => {
  it('matches the documented counter-clockwise polar convention', () => {
    expect(polarUVCpu([1, 0.5])).toEqual([0.5, 0.5]);
    expect(polarUVCpu([0.5, 1])).toEqual([0.75, 0.5]);
    expect(polarUVCpu([1, 0.5], { rotation: Math.PI / 2 })[0]).toBeCloseTo(0.75, 12);
    expect(polarUVCpu([0.5, 0.5])).toEqual([0.5, 0]);
  });

  it('mirrors UV flow, distortion, dissolve, and Fresnel boundaries', () => {
    expect(uvFlowCpu([0.25, 0.75], [2, -0.5], 0.25)).toEqual([0.75, 0.625]);
    expect(distortionUVCpu([0.5, 0.5], [0.75, 0.25], 0.2)).toEqual([0.6, 0.4]);
    expect(dissolveCpu(0.49, 0.5, 0.1)).toEqual({ coverage: 0, edge: 0 });
    expect(dissolveCpu(0.55, 0.5, 0.1)).toEqual({ coverage: 1, edge: 1 });
    expect(dissolveCpu(0.6, 0.5, 0.1)).toEqual({ coverage: 1, edge: 0 });
    expect(fresnelFactorCpu([0, 0, 1], [0, 0, 1], 2)).toBe(0);
    expect(fresnelFactorCpu([1, 0, 0], [0, 0, 1], 2)).toBe(1);
  });

  it('keeps two flow phases half a cycle apart with complementary weights', () => {
    for (const time of [0, 0.125, 0.25, 0.5, 0.875, 1.125]) {
      const phases = flowMapPhasesCpu({ flow: [1, -0.5], strength: 0.2, time, uv: [0.5, 0.5] });
      expect((phases.phase1 - phases.phase0 + 1) % 1).toBeCloseTo(0.5, 12);
      expect(phases.weight0 + phases.weight1).toBeCloseTo(1, 12);
    }
    const phases = flowMapPhasesCpu({ flow: [1, 0], strength: 0.2, time: 0.25, uv: [0.5, 0.5] });
    expect(phases.uv0).toEqual([0.45, 0.5]);
    expect(phases.uv1).toEqual([0.35, 0.5]);
    expect(blendFlowMapSamplesCpu([1, 0], [0, 1], phases.weight0)).toEqual([0.5, 0.5]);
  });
});
