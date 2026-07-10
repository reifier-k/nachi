import { describe, expect, it } from 'vitest';

import { createThreeKernelAdapter } from './three-kernel-adapter.js';

describe('three kernel adapter', () => {
  it('materializes mat3 storage with its vec4-aligned physical length', () => {
    const storage = createThreeKernelAdapter().instancedArray(1, 'mat3');
    const attribute = storage.value as { array: Float32Array; count: number };

    expect(attribute.count).toBe(1);
    expect(attribute.array.length).toBe(12);
    expect(attribute.array.byteLength).toBe(48);
  });
});
