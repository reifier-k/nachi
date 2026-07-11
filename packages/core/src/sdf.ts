import type { BakeSdfOptions, ParsedSdfField, SdfShape, Vec3 } from './types.js';

function validateVector(value: Vec3, name: string): void {
  if (value.some((component) => !Number.isFinite(component))) {
    throw new RangeError(`${name} must contain finite components.`);
  }
}

function sphereDistance(position: Vec3, shape: Extract<SdfShape, { shape: 'sphere' }>): number {
  return (
    Math.hypot(
      position[0] - shape.center[0],
      position[1] - shape.center[1],
      position[2] - shape.center[2],
    ) - shape.radius
  );
}

function boxDistance(position: Vec3, shape: Extract<SdfShape, { shape: 'box' }>): number {
  const q = [0, 1, 2].map(
    (axis) => Math.abs(position[axis]! - shape.center[axis]!) - shape.size[axis]! * 0.5,
  ) as unknown as Vec3;
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
  return outside + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

function shapeDistance(position: Vec3, shape: SdfShape): number {
  return shape.shape === 'sphere' ? sphereDistance(position, shape) : boxDistance(position, shape);
}

/** Bakes a corner-aligned union of analytic sphere/box SDFs without renderer dependencies. */
export function bakeSdf(options: BakeSdfOptions): ParsedSdfField {
  validateVector(options.boundsMin, 'boundsMin');
  validateVector(options.boundsMax, 'boundsMax');
  if (options.boundsMax.some((value, axis) => value <= options.boundsMin[axis]!)) {
    throw new RangeError('boundsMax must be greater than boundsMin on every axis.');
  }
  if (options.resolution.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 2)) {
    throw new RangeError('SDF resolution values must be safe integers of at least 2.');
  }
  if (options.shapes.length === 0) throw new RangeError('SDF bake requires at least one shape.');
  for (const [index, shape] of options.shapes.entries()) {
    validateVector(shape.center, `shapes[${index}].center`);
    if (shape.shape === 'sphere') {
      if (!Number.isFinite(shape.radius) || shape.radius <= 0) {
        throw new RangeError(`shapes[${index}].radius must be positive and finite.`);
      }
    } else {
      validateVector(shape.size, `shapes[${index}].size`);
      if (shape.size.some((component) => component <= 0)) {
        throw new RangeError(`shapes[${index}].size components must be positive.`);
      }
    }
  }

  const [width, height, depth] = options.resolution;
  const distances = new Float32Array(width * height * depth);
  let sample = 0;
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const position = [
          options.boundsMin[0] + (x / (width - 1)) * (options.boundsMax[0] - options.boundsMin[0]),
          options.boundsMin[1] + (y / (height - 1)) * (options.boundsMax[1] - options.boundsMin[1]),
          options.boundsMin[2] + (z / (depth - 1)) * (options.boundsMax[2] - options.boundsMin[2]),
        ] as Vec3;
        distances[sample] = Math.min(
          ...options.shapes.map((shape) => shapeDistance(position, shape)),
        );
        sample += 1;
      }
    }
  }
  return {
    boundsMax: options.boundsMax,
    boundsMin: options.boundsMin,
    distances,
    resolution: options.resolution,
  };
}
