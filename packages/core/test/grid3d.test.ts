import { describe, expect, it } from 'vitest';

import {
  defineGrid3D,
  defineSimStage,
  estimateGrid3DMemory,
  grid3DAdvect,
  grid3DCellIndex,
  grid3DPressureJacobi,
  rasterizeGrid3DPoints,
  resolveGrid3DChannelLayout,
  sampleGrid3DTrilinear,
  simStageSubmissionCount,
} from '../src/index.js';

describe('M12 Grid3D mathematics', () => {
  it('uses x-fast, then y, then z addressing and rejects every out-of-range axis', () => {
    const resolution = [4, 3, 2] as const;
    expect(grid3DCellIndex(0, 0, 0, resolution)).toBe(0);
    expect(grid3DCellIndex(3, 0, 0, resolution)).toBe(3);
    expect(grid3DCellIndex(1, 2, 0, resolution)).toBe(9);
    expect(grid3DCellIndex(2, 1, 1, resolution)).toBe(18);
    expect(() => grid3DCellIndex(4, 0, 0, resolution)).toThrow(RangeError);
    expect(() => grid3DCellIndex(0, 3, 0, resolution)).toThrow(RangeError);
    expect(() => grid3DCellIndex(0, 0, 2, resolution)).toThrow(RangeError);
  });

  it('trilinearly samples an asymmetric field without axis transpose aliases', () => {
    const resolution = [3, 2, 2] as const;
    const values = new Float32Array([1, 3, 8, 5, 9, 20, 30, 34, 41, 47, 55, 70]);
    const actual = sampleGrid3DTrilinear(values, resolution, [1.25, 0.4, 0.7]);
    expect(actual).toBeCloseTo(33.64, 6);
    expect(actual).not.toBeCloseTo(sampleGrid3DTrilinear(values, resolution, [0.4, 1.25, 0.7]), 2);
    expect(actual).not.toBeCloseTo(sampleGrid3DTrilinear(values, resolution, [1.25, 0.7, 0.4]), 2);
  });

  it('packs scalar and vec3 channels and exposes cubic memory growth with exact byte accounting', () => {
    const grid = defineGrid3D({
      channels: {
        density: { type: 'f32' },
        velocity: { default: [0, 0, 0], type: 'vec3' },
        temperature: { type: 'f32' },
        pressure: { type: 'f32' },
      },
      resolution: [32, 32, 32],
    });
    expect(resolveGrid3DChannelLayout(grid)).toEqual([
      { components: 1, group: 0, name: 'density', offset: 0, type: 'f32' },
      { components: 3, group: 0, name: 'velocity', offset: 1, type: 'vec3' },
      { components: 1, group: 1, name: 'temperature', offset: 0, type: 'f32' },
      { components: 1, group: 1, name: 'pressure', offset: 1, type: 'f32' },
    ]);
    const estimate = estimateGrid3DMemory(grid);
    expect(estimate).toEqual({
      cellCount: 32 ** 3,
      channelGroups: 2,
      particleAtomicBytes: 32 ** 3 * 4,
      particlePositionBytes: 32 ** 3 * 16,
      particleSampleBytes: 32 ** 3 * 4,
      scratchBufferBytes: 32 ** 3 * 2 * 16,
      stateBufferBytes: 32 ** 3 * 2 * 16,
      totalBytes: 32 ** 3 * 88,
    });
    const doubled = estimateGrid3DMemory({ ...grid, resolution: [64, 64, 64] });
    expect(doubled.totalBytes).toBe(estimate.totalBytes * 8);
  });

  it('rasterizes an asymmetric multi-group grid additively with x-fast 3D addressing', () => {
    const grid = defineGrid3D({
      channels: {
        density: { type: 'f32' },
        velocity: { type: 'vec3' },
        temperature: { type: 'f32' },
      },
      resolution: [4, 3, 2],
    });
    expect(resolveGrid3DChannelLayout(grid).find(({ name }) => name === 'temperature')).toEqual({
      components: 1,
      group: 1,
      name: 'temperature',
      offset: 0,
      type: 'f32',
    });
    const rasterized = rasterizeGrid3DPoints(
      [
        [0.1, 0.1, 0.1],
        [0.1, 0.1, 0.1],
        [0.8, 0.7, 0.8],
      ],
      grid.resolution,
      0.5,
    );
    expect(rasterized[grid3DCellIndex(0, 0, 0, grid.resolution)]).toBe(1);
    expect(rasterized[grid3DCellIndex(3, 2, 1, grid.resolution)]).toBe(0.5);
    expect(rasterized.filter((value) => value !== 0)).toHaveLength(2);
  });

  it('retains the shared literal update/commit submission contract', () => {
    const advect = defineSimStage({ target: 'volume', update: grid3DAdvect() });
    const pressure = defineSimStage({
      iterations: 6,
      target: 'volume',
      update: grid3DPressureJacobi(),
    });
    expect(simStageSubmissionCount([advect, pressure])).toBe(14);
  });
});
