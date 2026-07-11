import type { ParsedVectorField, Vec3 } from './types.js';

function finiteValues(tokens: readonly string[], label: string): number[] {
  const values = tokens.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`FGA ${label} contains a non-finite value.`);
  }
  return values;
}

/** Parses the Unreal/Vector Fields ASCII FGA layout without any renderer dependency. */
export function parseFga(source: string): ParsedVectorField {
  const tokens = source.replaceAll(',', ' ').split(/\s+/u).filter(Boolean);
  if (tokens.length < 9) throw new Error('FGA requires a resolution and min/max bounds header.');

  const resolutionValues = finiteValues(tokens.slice(0, 3), 'resolution');
  if (resolutionValues.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('FGA resolution values must be positive safe integers.');
  }
  const resolution = resolutionValues as [number, number, number];
  const bounds = finiteValues(tokens.slice(3, 9), 'bounds');
  const boundsMin: Vec3 = [bounds[0]!, bounds[1]!, bounds[2]!];
  const boundsMax: Vec3 = [bounds[3]!, bounds[4]!, bounds[5]!];
  if (boundsMax.some((value, axis) => value <= (boundsMin[axis] ?? value))) {
    throw new Error('FGA maximum bounds must be greater than minimum bounds on every axis.');
  }

  const sampleCount = resolution[0] * resolution[1] * resolution[2];
  const expectedComponents = sampleCount * 3;
  const vectorTokens = tokens.slice(9);
  if (vectorTokens.length !== expectedComponents) {
    throw new Error(
      `FGA expected ${expectedComponents} vector components for ${sampleCount} samples; received ${vectorTokens.length}.`,
    );
  }
  const vectors = new Float32Array(finiteValues(vectorTokens, 'vector data'));
  return { boundsMax, boundsMin, resolution, vectors };
}
