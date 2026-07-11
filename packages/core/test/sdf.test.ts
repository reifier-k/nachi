import { describe, expect, it } from 'vitest';

import { bakeSdf } from '../src/index.js';

const base = {
  boundsMax: [1, 1, 1] as const,
  boundsMin: [-1, -1, -1] as const,
  resolution: [3, 3, 3] as const,
};

describe('analytic SDF baking', () => {
  it('bakes negative sphere interior and positive exterior distances', () => {
    const field = bakeSdf({
      ...base,
      shapes: [{ center: [0, 0, 0], radius: 0.5, shape: 'sphere' }],
    });
    expect(field.distances[13]).toBeCloseTo(-0.5);
    expect(field.distances[0]).toBeGreaterThan(1);
  });

  it('bakes an axis-aligned box signed distance', () => {
    const field = bakeSdf({
      ...base,
      shapes: [{ center: [0, 0, 0], shape: 'box', size: [1, 1, 1] }],
    });
    expect(field.distances[13]).toBeCloseTo(-0.5);
    expect(field.distances[14]).toBeCloseTo(0.5);
  });

  it('combines shapes as a distance-field union', () => {
    const field = bakeSdf({
      ...base,
      shapes: [
        { center: [-0.5, 0, 0], radius: 0.6, shape: 'sphere' },
        { center: [0.5, 0, 0], radius: 0.6, shape: 'sphere' },
      ],
    });
    expect(field.distances[12]).toBeLessThan(0);
    expect(field.distances[14]).toBeLessThan(0);
  });

  it('uses deterministic X-major corner-aligned storage', () => {
    const first = bakeSdf({
      ...base,
      shapes: [{ center: [0, 0, 0], radius: 0.5, shape: 'sphere' }],
    });
    const second = bakeSdf({
      ...base,
      shapes: [{ center: [0, 0, 0], radius: 0.5, shape: 'sphere' }],
    });
    expect(first.distances).toEqual(second.distances);
    expect(first.distances).not.toBe(second.distances);
  });

  it('rejects invalid bounds', () => {
    expect(() =>
      bakeSdf({
        ...base,
        boundsMax: [-1, 1, 1],
        shapes: [{ center: [0, 0, 0], radius: 1, shape: 'sphere' }],
      }),
    ).toThrow('boundsMax');
  });

  it('rejects undersized resolutions', () => {
    expect(() =>
      bakeSdf({
        ...base,
        resolution: [1, 3, 3],
        shapes: [{ center: [0, 0, 0], radius: 1, shape: 'sphere' }],
      }),
    ).toThrow('at least 2');
  });

  it('rejects an empty shape union', () => {
    expect(() => bakeSdf({ ...base, shapes: [] })).toThrow('at least one shape');
  });

  it('rejects invalid sphere and box dimensions', () => {
    expect(() =>
      bakeSdf({
        ...base,
        shapes: [{ center: [0, 0, 0], radius: 0, shape: 'sphere' }],
      }),
    ).toThrow('radius');
    expect(() =>
      bakeSdf({
        ...base,
        shapes: [{ center: [0, 0, 0], shape: 'box', size: [1, -1, 1] }],
      }),
    ).toThrow('size');
  });
});
