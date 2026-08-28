import {
  billboard,
  compileEmitter,
  defineEmitter,
  lifetime,
  positionSphere,
  range,
  rate,
} from '@nachi-vfx/core';
import { context } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createThreeKernelAdapter } from '../src/index.js';

// Three's program/pipeline caches are keyed by shader text. Emitters that differ only in
// authored numbers (capacity, sizes, rates, lifetimes) must therefore produce identical WGSL on
// WebGPU, otherwise every emitter compiles its own pipelines. These tests guard that property
// directly rather than through pinned hashes.

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

type ComputeTexts = {
  readonly initialize: string;
  readonly spawn: string;
  readonly update: string;
};

function computeTexts(
  capacity: number,
  radius: number,
  scale: number,
  options: { literalConstants?: boolean } = {},
): ComputeTexts {
  const program = compileEmitter(
    defineEmitter({
      capacity,
      init: [positionSphere({ radius }), lifetime(range(0.1 * scale, 0.2 * scale))],
      integration: 'none',
      render: billboard({ blending: 'additive', sorted: false }),
      spawn: rate(40 * scale),
    }),
  );
  const kernels = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu', ...options }));
  const text = (kernel: unknown) => {
    const builder = new NodeBuilder(kernel, renderer);
    builder.build();
    return builder.computeShader;
  };
  return {
    initialize: text(kernels.initialize),
    spawn: text(kernels.spawn),
    update: text(kernels.update),
  };
}

describe('stable shader text across structurally identical emitters', () => {
  it('emits identical WebGPU compute WGSL when only numeric parameters differ', () => {
    const small = computeTexts(32, 1, 1);
    const large = computeTexts(64, 2, 3);

    expect(large.initialize).toBe(small.initialize);
    expect(large.spawn).toBe(small.spawn);
    expect(large.update).toBe(small.update);
  });

  it('restores per-emitter literals with literalConstants: true', () => {
    const small = computeTexts(32, 1, 1, { literalConstants: true });
    const large = computeTexts(64, 2, 3, { literalConstants: true });

    // Capacity and spawn rate are baked into the spawn kernel as literals.
    expect(large.spawn).not.toBe(small.spawn);
    expect(small.spawn).not.toBe(computeTexts(32, 1, 1).spawn);
  });

  it('emits numeric constants as uniforms on WebGPU and as literals on WebGL2', () => {
    const isUniform = (node: unknown) =>
      (node as { isUniformNode?: boolean }).isUniformNode === true;
    const webgpu = createThreeKernelAdapter({ backend: 'webgpu' });
    const webgl2 = createThreeKernelAdapter({ backend: 'webgl2' });
    const literal = createThreeKernelAdapter({ backend: 'webgpu', literalConstants: true });

    expect(isUniform(webgpu.constant(1.5, 'f32'))).toBe(true);
    expect(isUniform(webgpu.constant([1, 2, 3], 'vec3'))).toBe(true);
    expect(isUniform(webgpu.uint(7))).toBe(true);
    // Booleans feed If/select conditions and never vary: they stay literal.
    expect(isUniform(webgpu.constant(true, 'bool'))).toBe(false);

    expect(isUniform(webgl2.constant(1.5, 'f32'))).toBe(false);
    expect(isUniform(webgl2.uint(7))).toBe(false);
    expect(isUniform(literal.constant(1.5, 'f32'))).toBe(false);
    expect(isUniform(literal.uint(7))).toBe(false);
  });
});
