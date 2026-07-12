import { describe, expect, it } from 'vitest';

import {
  defineGrid2D,
  defineSimStage,
  gridAdvect,
  gridCellIndex,
  gridPressureJacobi,
  rasterizeGrid2DPoints,
  resolveGrid2DChannelLayout,
  sampleGrid2DBilinear,
  simStageExecutionOrder,
  simStageSubmissionCount,
} from '../src/index.js';

describe('M12 Grid2D mathematics', () => {
  it('uses x-fast row-major addressing and rejects out-of-range cells', () => {
    expect(gridCellIndex(0, 0, [5, 3])).toBe(0);
    expect(gridCellIndex(4, 0, [5, 3])).toBe(4);
    expect(gridCellIndex(1, 2, [5, 3])).toBe(11);
    expect(() => gridCellIndex(5, 0, [5, 3])).toThrow(RangeError);
  });

  it('bilinearly samples a deliberately asymmetric field without transpose or y-mirror aliases', () => {
    const field = new Float32Array([1, 3, 8, 5, 9, 20]);
    expect(sampleGrid2DBilinear(field, [3, 2], [0.25, 0.75])).toBeCloseTo(4.875, 6);
    expect(sampleGrid2DBilinear(field, [3, 2], [1.6, 0.2])).toBeCloseTo(7.92, 6);
    expect(sampleGrid2DBilinear(field, [3, 2], [0.2, 1.6])).not.toBeCloseTo(7.92, 2);
  });

  it('packs smoke channels into two vec4 records while retaining one buffer per state', () => {
    const grid = defineGrid2D({
      channels: {
        density: { type: 'f32' },
        temperature: { type: 'f32' },
        velocity: { type: 'vec2' },
        pressure: { type: 'f32' },
      },
      resolution: [32, 24],
    });
    expect(resolveGrid2DChannelLayout(grid)).toEqual([
      { components: 1, group: 0, name: 'density', offset: 0, type: 'f32' },
      { components: 1, group: 0, name: 'temperature', offset: 1, type: 'f32' },
      { components: 2, group: 0, name: 'velocity', offset: 2, type: 'vec2' },
      { components: 1, group: 1, name: 'pressure', offset: 0, type: 'f32' },
    ]);
  });

  it('rasterizes points additively and preserves duplicate deposits', () => {
    expect([
      ...rasterizeGrid2DPoints(
        [
          [0.1, 0.1],
          [0.1, 0.1],
          [0.9, 0.6],
        ],
        [4, 2],
        0.5,
      ),
    ]).toEqual([1, 0, 0, 0, 0, 0, 0, 0.5]);
  });
});

describe('M12 simulation-stage ordering', () => {
  it('keeps author order within explicit before/particle/after scheduler boundaries', () => {
    const before = defineSimStage({
      phase: 'before-particles',
      target: 'grid',
      update: gridAdvect(),
    });
    const afterA = defineSimStage({ target: 'grid', update: gridPressureJacobi() });
    const afterB = defineSimStage({ iterations: 7, target: 'grid', update: gridPressureJacobi() });
    expect(simStageExecutionOrder({ afterA, before, afterB })).toEqual([
      'before',
      '$particles',
      'afterA',
      'afterB',
    ]);
    expect(simStageSubmissionCount([before, afterA, afterB])).toBe(18);
  });
});
