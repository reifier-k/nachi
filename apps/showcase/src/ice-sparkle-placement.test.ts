import { createHash } from 'node:crypto';

import {
  billboard,
  burst,
  compileEmitter,
  createCoreKernelModuleRegistry,
  defineEmitter,
  lifetime,
} from '@nachi-vfx/core';
import { createThreeKernelAdapter } from '@nachi-vfx/three';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

import {
  ICE_SPARKLE_JITTER_ACCESS,
  ICE_SPARKLE_JITTER_ATTRIBUTE,
  ICE_SPARKLE_JITTER_NORMALIZED_STAGE_INDEX,
  ICE_SPARKLE_PLACEMENT_ACCESS,
  ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS,
  iceSparkleInitModules,
  iceSparkleJitterAttribute,
  placeIceSparkleLocal,
  registerIceSparklePlacement,
  sampleIceSparkleJitter,
  sampleIceSparkleLocal,
} from './ice-sparkle-placement';

function distributionHash(points: readonly (readonly number[])[]): string {
  let hash = 0x811c9dc5;
  for (const point of points) {
    for (const value of point) {
      hash = Math.imul(hash ^ (Math.round(value * 1e5) >>> 0), 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

function productionProgram() {
  const registry = createCoreKernelModuleRegistry();
  registerIceSparklePlacement(registry);
  return compileEmitter(
    defineEmitter({
      attributes: { [ICE_SPARKLE_JITTER_ATTRIBUTE]: iceSparkleJitterAttribute },
      capacity: 8,
      init: [...iceSparkleInitModules, lifetime(2)],
      integration: 'none',
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 8 }),
    }),
    { registry },
  );
}

describe('ice sparkle local placement', () => {
  it('pins the production module slots, custom schema/access, and keyed samples', () => {
    expect(iceSparkleInitModules.map(({ type }) => type)).toEqual([
      'showcase/ice-sparkle-local-jitter',
      'showcase/ice-sparkle-placement',
    ]);
    expect(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS).toEqual([1, 2, 4]);
    expect(ICE_SPARKLE_JITTER_ACCESS).toEqual({
      reads: ['Emitter.seed', 'Particles.spawnOrder'],
      writes: ['Particles.iceSparkleJitter'],
    });
    expect(ICE_SPARKLE_PLACEMENT_ACCESS).toEqual({
      reads: [
        'Emitter.spawnInterpolatedTransform',
        'Particles.iceSparkleJitter',
        'Particles.spawnOrder',
      ],
      writes: ['Particles.position'],
    });
    expect(iceSparkleJitterAttribute).toEqual({
      default: [0, 0, 0],
      kind: 'attribute',
      name: 'iceSparkleJitter',
      type: 'vec3',
    });
    const points = Array.from({ length: 144 }, (_, spawnOrder) =>
      sampleIceSparkleLocal(spawnOrder, 0x1ce0),
    );
    expect(ICE_SPARKLE_JITTER_NORMALIZED_STAGE_INDEX).toBe(1);
    expect(distributionHash(points)).toBe('7fbb5a40');
    expect(sampleIceSparkleLocal(17, 0x1ce0)).toEqual(sampleIceSparkleLocal(17, 0x1ce0));
    expect(sampleIceSparkleLocal(17, 0x1ce1)).not.toEqual(sampleIceSparkleLocal(17, 0x1ce0));
  });

  it('generates real Three WGSL from the production registration without an inverse', () => {
    const program = productionProgram();
    expect(
      program.kernels.init.modules.map(({ slot, stageIndex, type }) => ({
        slot,
        stageIndex,
        type,
      })),
    ).toEqual([
      { slot: 1_298_895_206, stageIndex: 0, type: 'core/defaults' },
      {
        slot: 380_752_754,
        stageIndex: ICE_SPARKLE_JITTER_NORMALIZED_STAGE_INDEX,
        type: 'showcase/ice-sparkle-local-jitter',
      },
      { slot: 380_752_753, stageIndex: 2, type: 'showcase/ice-sparkle-placement' },
      { slot: 380_752_752, stageIndex: 3, type: 'core/lifetime' },
    ]);
    const kernels = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' }));
    const renderer = {
      backend: {
        capabilities: { getUniformBufferLimit: () => 64 },
        compatibilityMode: false,
      },
      contextNode: context({}),
      getMRT: () => null,
      getRenderTarget: () => null,
      hasFeature: () => false,
    };
    const NodeBuilder = THREE.WGSLNodeBuilder as unknown as new (
      object: unknown,
      renderer: unknown,
    ) => { build(): void; computeShader: string };
    const builder = new NodeBuilder(kernels.init, renderer);
    builder.build();

    expect(builder.computeShader).not.toMatch(/inverse/i);
    expect(createHash('sha256').update(builder.computeShader).digest('hex')).toBe(
      '5c6dd287cddcc41513ece6899b5b8ea1768068180bc24b5055259541fa40f554',
    );
  });

  it('composes local placement once and stays finite under a singular scale', () => {
    const local = Array.from(
      { length: 144 },
      (_, spawnOrder) => new THREE.Vector3(...sampleIceSparkleLocal(spawnOrder, 0x1ce0)),
    );
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(2.4, -0.35, 1.7),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.73),
      new THREE.Vector3(1, 1, 1),
    );
    const world = local.map((point) => point.clone().applyMatrix4(transform));
    expect(distributionHash(local.map(({ x, y, z }) => [x, y, z]))).toBe('7fbb5a40');
    expect(world.every(({ x, y, z }) => [x, y, z].every(Number.isFinite))).toBe(true);

    const singular = new THREE.Matrix4().compose(
      new THREE.Vector3(2.4, -0.35, 1.7),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.73),
      new THREE.Vector3(0, 0, 0),
    );
    const collapsed = local.map((point) => point.clone().applyMatrix4(singular));
    expect(collapsed.every(({ x, y, z }) => [x, y, z].every(Number.isFinite))).toBe(true);
    expect(
      collapsed.every((point) => point.distanceTo(new THREE.Vector3(2.4, -0.35, 1.7)) < 1e-12),
    ).toBe(true);
  });

  it('pins the corrected normalized-slot evidence for the former world-jitter path', () => {
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(2.4, -0.35, 1.7),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.73),
      new THREE.Vector3(1, 1, 1),
    );
    const inverse = transform.clone().invert();
    const local = Array.from({ length: 144 }, (_, spawnOrder) =>
      sampleIceSparkleLocal(spawnOrder, 0x1ce0),
    );
    const contaminated = Array.from({ length: 144 }, (_, spawnOrder) => {
      const worldJitter = new THREE.Vector3(
        ...sampleIceSparkleJitter(spawnOrder, 0x1ce0),
      ).applyMatrix4(transform);
      return new THREE.Vector3(
        ...placeIceSparkleLocal([worldJitter.x, worldJitter.y, worldJitter.z], spawnOrder),
      )
        .applyMatrix4(inverse)
        .toArray();
    });
    const stats = (points: readonly (readonly number[])[]) => ({
      bounds: [0, 1, 2].map((axis) => [
        Number(Math.min(...points.map((point) => point[axis]!)).toFixed(5)),
        Number(Math.max(...points.map((point) => point[axis]!)).toFixed(5)),
      ]),
      hash: distributionHash(points),
      mean: [0, 1, 2].map((axis) =>
        Number((points.reduce((sum, point) => sum + point[axis]!, 0) / points.length).toFixed(5)),
      ),
    });

    expect({ contaminated: stats(contaminated), local: stats(local) }).toEqual({
      contaminated: {
        bounds: [
          [-1.74219, 0.65033],
          [-0.66896, 0.92547],
          [-3.51182, -1.16373],
        ],
        hash: '14816497',
        mean: [-0.52315, 0.0196, -2.28299],
      },
      local: {
        bounds: [
          [-1.21697, 1.11228],
          [-0.75646, 0.99547],
          [-1.12151, 1.16771],
        ],
        hash: '7fbb5a40',
        mean: [0.00064, -0.04822, 0.01084],
      },
    });
  });
});
