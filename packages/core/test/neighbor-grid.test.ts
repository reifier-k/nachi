import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  NEIGHBOR_GRID_EMPTY_SLOT,
  bucketNeighborGridPoints,
  defineNeighborGrid,
  enumerateNeighborGridCells,
  neighborGridCellIndex,
  neighborGridPositionCell,
  validateNeighborGridDefinition,
} from '../src/index.js';

describe('M12 NeighborGrid CPU mirrors', () => {
  it.each([
    ['NACHI_NEIGHBOR_GRID_RESOLUTION_INVALID', { resolution: [0, 2, 2] }],
    ['NACHI_NEIGHBOR_GRID_CELL_CAPACITY_INVALID', { cellCapacity: 0 }],
    ['NACHI_NEIGHBOR_GRID_CELL_SIZE_INVALID', { cellSize: 0 }],
    ['NACHI_NEIGHBOR_GRID_ORIGIN_INVALID', { origin: [0, Number.NaN, 0] }],
  ] as const)('asserts %s for its invalid definition field', (code, override) => {
    const definition = { ...defineNeighborGrid({ resolution: [2, 2, 2] }), ...override } as never;
    try {
      validateNeighborGridDefinition(definition);
      throw new Error('expected NeighborGrid validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VfxDiagnosticError);
      expect(error instanceof VfxDiagnosticError ? error.diagnostics : []).toContainEqual(
        expect.objectContaining({ code }),
      );
    }
  });

  it('uses x-fast hashing and maps world positions through origin/cellSize', () => {
    const grid = defineNeighborGrid({
      cellSize: 0.5,
      origin: [-1, -2, -3],
      resolution: [4, 3, 2],
    });
    expect(neighborGridCellIndex(0, 0, 0, grid.resolution)).toBe(0);
    expect(neighborGridCellIndex(3, 2, 1, grid.resolution)).toBe(23);
    expect(neighborGridPositionCell([-0.24, -1.01, -2.1], grid)).toEqual([1, 1, 1]);
    expect(neighborGridPositionCell([1.01, -2, -3], grid)).toBeUndefined();
    expect(() => neighborGridCellIndex(4, 0, 0, grid.resolution)).toThrow(RangeError);
  });

  it('enumerates clipped neighbor cells in deterministic z/y/x order', () => {
    const resolution = [4, 3, 2] as const;
    expect(enumerateNeighborGridCells([0, 1, 0], 1, resolution)).toEqual([
      neighborGridCellIndex(0, 0, 0, resolution),
      neighborGridCellIndex(1, 0, 0, resolution),
      neighborGridCellIndex(0, 1, 0, resolution),
      neighborGridCellIndex(1, 1, 0, resolution),
      neighborGridCellIndex(0, 2, 0, resolution),
      neighborGridCellIndex(1, 2, 0, resolution),
      neighborGridCellIndex(0, 0, 1, resolution),
      neighborGridCellIndex(1, 0, 1, resolution),
      neighborGridCellIndex(0, 1, 1, resolution),
      neighborGridCellIndex(1, 1, 1, resolution),
      neighborGridCellIndex(0, 2, 1, resolution),
      neighborGridCellIndex(1, 2, 1, resolution),
    ]);
  });

  it('matches analytic neighbor counts and preserves overflow dropping', () => {
    const grid = defineNeighborGrid({ cellCapacity: 2, resolution: [3, 2, 1] });
    const points = [
      [0.1, 0.1, 0.1],
      [0.2, 0.1, 0.1],
      [0.3, 0.1, 0.1],
      [1.2, 0.1, 0.1],
      [2.2, 1.2, 0.1],
      [8, 8, 8],
    ] as const;
    const buckets = bucketNeighborGridPoints(points, grid);
    expect([...buckets.counts]).toEqual([3, 1, 0, 0, 0, 1]);
    expect(buckets.dropped).toBe(1);
    expect(buckets.outOfBounds).toBe(1);
    expect([...buckets.slots.slice(0, 4)]).toEqual([0, 1, 3, NEIGHBOR_GRID_EMPTY_SLOT]);

    const neighborCounts = points.slice(0, 5).map((point, particle) => {
      const cell = neighborGridPositionCell(point, grid)!;
      const candidates = enumerateNeighborGridCells(cell, 1, grid.resolution).flatMap((index) => [
        ...buckets.slots.slice(index * grid.cellCapacity, (index + 1) * grid.cellCapacity),
      ]);
      return candidates.filter(
        (candidate) => candidate !== NEIGHBOR_GRID_EMPTY_SLOT && candidate !== particle,
      ).length;
    });
    expect(neighborCounts).toEqual([2, 2, 3, 3, 1]);
  });

  it.each([1, 2])('matches brute-force CPU neighbor counts at radius %i', (radius) => {
    const grid = defineNeighborGrid({ cellCapacity: 6, resolution: [5, 5, 5] });
    const points = [
      [0.1, 0.1, 0.1],
      [1.1, 0.1, 0.1],
      [2.1, 0.1, 0.1],
      [2.1, 2.1, 0.1],
      [4.1, 4.1, 4.1],
      [1.1, 1.1, 1.1],
    ] as const;
    const buckets = bucketNeighborGridPoints(points, grid);
    const cells = points.map((point) => neighborGridPositionCell(point, grid)!);
    const scanned = cells.map(
      (cell, particle) =>
        enumerateNeighborGridCells(cell, radius, grid.resolution)
          .flatMap((index) => [
            ...buckets.slots.slice(index * grid.cellCapacity, (index + 1) * grid.cellCapacity),
          ])
          .filter((candidate) => candidate !== NEIGHBOR_GRID_EMPTY_SLOT && candidate !== particle)
          .length,
    );
    const bruteForce = cells.map(
      (cell, particle) =>
        cells.filter(
          (candidate, other) =>
            other !== particle &&
            Math.max(
              Math.abs(candidate[0] - cell[0]),
              Math.abs(candidate[1] - cell[1]),
              Math.abs(candidate[2] - cell[2]),
            ) <= radius,
        ).length,
    );

    expect(scanned).toEqual(bruteForce);
  });
});
