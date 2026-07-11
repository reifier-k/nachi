import { describe, expect, it } from 'vitest';

import { compactRgba8Readback } from './readback';

describe('RGBA8 render-target readback compaction', () => {
  it('compacts the 32px golden-slash probe without losing its lower rows', () => {
    const width = 32;
    const height = 32;
    const denseRowBytes = width * 4;
    const paddedRowBytes = 256;
    const source = new Uint8Array((height - 1) * paddedRowBytes + denseRowBytes);
    for (let row = 0; row < height; row += 1) {
      source.fill(row + 1, row * paddedRowBytes, row * paddedRowBytes + denseRowBytes);
    }

    const dense = compactRgba8Readback(source, width, height, true);

    expect(source.byteLength).toBe(8064);
    expect(dense.byteLength).toBe(4096);
    expect(dense[denseRowBytes * 16]).toBe(17);
    expect(dense.at(-1)).toBe(32);
  });

  it('removes Three r185 WebGPU 256-byte row padding including its short final row', () => {
    const width = 96;
    const height = 3;
    const denseRowBytes = width * 4;
    const paddedRowBytes = 512;
    const source = new Uint8Array((height - 1) * paddedRowBytes + denseRowBytes).fill(0xee);
    for (let row = 0; row < height; row += 1) {
      source.fill(20 + row, row * paddedRowBytes, row * paddedRowBytes + denseRowBytes);
    }

    const dense = compactRgba8Readback(source, width, height, true);

    expect(dense.byteLength).toBe(width * height * 4);
    expect(dense[denseRowBytes - 1]).toBe(20);
    expect(dense[denseRowBytes]).toBe(21);
    expect(dense[denseRowBytes * 2]).toBe(22);
    expect(dense.at(-1)).toBe(22);
    expect(dense).not.toContain(0xee);
  });

  it('keeps already dense WebGL2 and aligned WebGPU arrays unchanged', () => {
    const webgl = new Uint8Array(96 * 2 * 4);
    const alignedWebgpu = new Uint8Array(64 * 2 * 4);
    expect(compactRgba8Readback(webgl, 96, 2, false)).toBe(webgl);
    expect(compactRgba8Readback(alignedWebgpu, 64, 2, true)).toBe(alignedWebgpu);
  });

  it('supports other pixel strides while retaining the dense identity fast path', () => {
    const padded = new Uint8Array(256 + 32).fill(0xee);
    padded.fill(7, 0, 32);
    padded.fill(9, 256, 288);
    expect(compactRgba8Readback(padded, 32, 2, true, 1)).toEqual(
      new Uint8Array([...new Uint8Array(32).fill(7), ...new Uint8Array(32).fill(9)]),
    );

    const dense = new Uint8Array(32 * 2);
    expect(compactRgba8Readback(dense, 32, 2, true, 1)).toBe(dense);
  });

  it('rejects unknown layouts instead of letting numeric validation read wrong rows', () => {
    expect(() => compactRgba8Readback(new Uint8Array(123), 96, 96, true)).toThrow(
      'Unexpected WebGPU readback length',
    );
    expect(() => compactRgba8Readback(new Uint8Array(123), 96, 96, false)).toThrow(
      'Unexpected WebGL2 readback length',
    );
  });
});
