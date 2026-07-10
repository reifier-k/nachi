import { describe, expect, it } from 'vitest';
import { billboard, burst, compileEmitter, defineEmitter } from '@nachi/core';

import { createThreeKernelAdapter, materializeThreeSpriteDraw } from './three-kernel-adapter.js';

describe('three kernel adapter', () => {
  it('materializes mat3 storage with its vec4-aligned physical length', () => {
    const storage = createThreeKernelAdapter().instancedArray(1, 'mat3');
    const attribute = storage.value as { array: Float32Array; count: number };

    expect(attribute.count).toBe(1);
    expect(attribute.array.length).toBe(12);
    expect(attribute.array.byteLength).toBe(48);
  });

  it('materializes a packed sprite InstancedMesh and primes indirect indexCount', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 4 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels);
    const offset = kernels.drawIndirectOffsetBytes! / Uint32Array.BYTES_PER_ELEMENT;
    const words = (kernels.drawIndirect!.indirectResource as { array: Uint32Array }).array;

    expect(mesh.isInstancedMesh).toBe(true);
    expect(mesh.geometry.getIndex()?.count).toBe(6);
    expect(mesh.geometry.getIndirect()).toBe(kernels.drawIndirect!.indirectResource);
    expect(words[offset]).toBe(6);
    expect(mesh.material.blending).toBe(2);
  });

  it('uses premultiplied alpha for Three.js multiply blending', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ blending: 'multiply' }),
        spawn: burst({ count: 1 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels);

    expect(mesh.material.premultipliedAlpha).toBe(true);
  });
});
