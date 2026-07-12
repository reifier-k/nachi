import { VfxDiagnosticError } from './diagnostics.js';
import type { NeighborGridDefinition, Vec3, VfxDiagnostic } from './types.js';

export const NEIGHBOR_GRID_EMPTY_SLOT = 0xffff_ffff;

export function neighborGridCellCount(resolution: readonly [number, number, number]): number {
  if (
    resolution.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !Number.isSafeInteger(resolution[0] * resolution[1] * resolution[2])
  ) {
    throw new RangeError(
      'NeighborGrid resolution must contain three positive safe integers with a safe product.',
    );
  }
  return resolution[0] * resolution[1] * resolution[2];
}

export function neighborGridCellIndex(
  x: number,
  y: number,
  z: number,
  resolution: readonly [number, number, number],
): number {
  neighborGridCellCount(resolution);
  const [width, height, depth] = resolution;
  if (
    !Number.isSafeInteger(x) ||
    x < 0 ||
    x >= width ||
    !Number.isSafeInteger(y) ||
    y < 0 ||
    y >= height ||
    !Number.isSafeInteger(z) ||
    z < 0 ||
    z >= depth
  ) {
    throw new RangeError(
      `NeighborGrid cell (${x}, ${y}, ${z}) is outside ${width}x${height}x${depth}.`,
    );
  }
  return (z * height + y) * width + x;
}

export function neighborGridPositionCell(
  position: Vec3,
  definition: Pick<NeighborGridDefinition, 'cellSize' | 'origin' | 'resolution'>,
): readonly [number, number, number] | undefined {
  if (!Number.isFinite(definition.cellSize) || definition.cellSize <= 0) {
    throw new RangeError('NeighborGrid cellSize must be positive and finite.');
  }
  const cell = position.map((value, axis) =>
    Math.floor((value - definition.origin[axis]!) / definition.cellSize),
  ) as unknown as [number, number, number];
  return cell.some((value, axis) => value < 0 || value >= definition.resolution[axis]!)
    ? undefined
    : cell;
}

/** Deterministic x-fast enumeration used as the CPU mirror of the dynamic GPU scan. */
export function enumerateNeighborGridCells(
  cell: readonly [number, number, number],
  radius: number,
  resolution: readonly [number, number, number],
): readonly number[] {
  neighborGridCellCount(resolution);
  if (!Number.isSafeInteger(radius) || radius < 0) {
    throw new RangeError('NeighborGrid search radius must be a non-negative safe integer.');
  }
  const result: number[] = [];
  for (let z = cell[2] - radius; z <= cell[2] + radius; z += 1) {
    if (z < 0 || z >= resolution[2]) continue;
    for (let y = cell[1] - radius; y <= cell[1] + radius; y += 1) {
      if (y < 0 || y >= resolution[1]) continue;
      for (let x = cell[0] - radius; x <= cell[0] + radius; x += 1) {
        if (x < 0 || x >= resolution[0]) continue;
        result.push(neighborGridCellIndex(x, y, z, resolution));
      }
    }
  }
  return result;
}

export interface CpuNeighborGridBuckets {
  readonly counts: Uint32Array;
  readonly dropped: number;
  readonly outOfBounds: number;
  readonly slots: Uint32Array;
}

/** CPU replica of atomicAdd reservation followed by fixed-slot overflow dropping. */
export function bucketNeighborGridPoints(
  points: readonly Vec3[],
  definition: NeighborGridDefinition,
): CpuNeighborGridBuckets {
  validateNeighborGridDefinition(definition);
  const cells = neighborGridCellCount(definition.resolution);
  const counts = new Uint32Array(cells);
  const slots = new Uint32Array(cells * definition.cellCapacity);
  slots.fill(NEIGHBOR_GRID_EMPTY_SLOT);
  let dropped = 0;
  let outOfBounds = 0;
  for (const [particle, point] of points.entries()) {
    const cell = neighborGridPositionCell(point, definition);
    if (!cell) {
      outOfBounds += 1;
      continue;
    }
    const index = neighborGridCellIndex(cell[0], cell[1], cell[2], definition.resolution);
    const slot = counts[index]!;
    counts[index] = slot + 1;
    if (slot < definition.cellCapacity) {
      slots[index * definition.cellCapacity + slot] = particle;
    } else {
      dropped += 1;
    }
  }
  return { counts, dropped, outOfBounds, slots };
}

export function validateNeighborGridDefinition(definition: NeighborGridDefinition): void {
  const diagnostics: VfxDiagnostic[] = [];
  try {
    neighborGridCellCount(definition.resolution);
  } catch (error) {
    diagnostics.push({
      code: 'NACHI_NEIGHBOR_GRID_RESOLUTION_INVALID',
      message: error instanceof Error ? error.message : String(error),
      path: 'resolution',
      phase: 'compile',
      severity: 'error',
    });
  }
  if (!Number.isSafeInteger(definition.cellCapacity) || definition.cellCapacity <= 0) {
    diagnostics.push({
      code: 'NACHI_NEIGHBOR_GRID_CELL_CAPACITY_INVALID',
      message: 'NeighborGrid cellCapacity must be a positive safe integer.',
      path: 'cellCapacity',
      phase: 'compile',
      severity: 'error',
    });
  } else {
    try {
      const slots = neighborGridCellCount(definition.resolution) * definition.cellCapacity;
      if (!Number.isSafeInteger(slots)) {
        diagnostics.push({
          code: 'NACHI_NEIGHBOR_GRID_CELL_CAPACITY_INVALID',
          message: 'NeighborGrid cellCount * cellCapacity exceeds the safe integer range.',
          path: 'cellCapacity',
          phase: 'compile',
          severity: 'error',
        });
      }
    } catch {
      // Resolution already owns the primary diagnostic.
    }
  }
  if (!Number.isFinite(definition.cellSize) || definition.cellSize <= 0) {
    diagnostics.push({
      code: 'NACHI_NEIGHBOR_GRID_CELL_SIZE_INVALID',
      message: 'NeighborGrid cellSize must be positive and finite.',
      path: 'cellSize',
      phase: 'compile',
      severity: 'error',
    });
  }
  if (
    definition.origin.length !== 3 ||
    definition.origin.some((component) => !Number.isFinite(component))
  ) {
    diagnostics.push({
      code: 'NACHI_NEIGHBOR_GRID_ORIGIN_INVALID',
      message: 'NeighborGrid origin must be a finite vec3.',
      path: 'origin',
      phase: 'compile',
      severity: 'error',
    });
  }
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
}
