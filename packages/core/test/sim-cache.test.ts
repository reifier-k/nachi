import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  interpolateSimulationCacheAttribute,
  validateSimulationCachePayloadSize,
} from '../src/index.js';

describe('simulation-cache linear interpolation', () => {
  it('interpolates a fractional seek only for particles alive in both frames', () => {
    const left = new Float32Array([0, 10, 20]);
    const right = new Float32Array([8, 18, 28]);
    const result = interpolateSimulationCacheAttribute(
      left,
      right,
      0.25,
      new Set([0, 1]),
      new Set([0, 2]),
      new Uint32Array([10, 11, 0]),
      new Uint32Array([10, 0, 12]),
      false,
      1,
    );

    expect([...result]).toEqual([2, 10, 20]);
  });

  it('uses the nearest frame for integer attributes and exact-frame seeks', () => {
    expect([
      ...interpolateSimulationCacheAttribute(
        new Uint32Array([1]),
        new Uint32Array([2]),
        0.75,
        new Set([0]),
        new Set([0]),
        new Uint32Array([7]),
        new Uint32Array([7]),
        true,
        1,
      ),
    ]).toEqual([2]);
    expect([
      ...interpolateSimulationCacheAttribute(
        new Float32Array([1]),
        new Float32Array([9]),
        0,
        new Set([0]),
        new Set([0]),
        new Uint32Array([7]),
        new Uint32Array([8]),
        false,
        1,
      ),
    ]).toEqual([1]);
  });

  it('never interpolates a physical slot reused by a different logical birth', () => {
    const left = new Float32Array([-1]);
    const right = new Float32Array([1]);
    const inputs = [left, right, 0.5, new Set([0]), new Set([0])] as const;

    expect([
      ...interpolateSimulationCacheAttribute(
        ...inputs,
        new Uint32Array([11]),
        new Uint32Array([12]),
        false,
        1,
      ),
    ]).toEqual([-1]);
    expect([
      ...interpolateSimulationCacheAttribute(
        ...inputs,
        new Uint32Array([11]),
        new Uint32Array([12]),
        true,
        1,
      ),
    ]).toEqual([1]);
  });

  it('still interpolates a surviving lineage in the same physical slot', () => {
    expect([
      ...interpolateSimulationCacheAttribute(
        new Float32Array([-1]),
        new Float32Array([1]),
        0.5,
        new Set([0]),
        new Set([0]),
        new Uint32Array([11]),
        new Uint32Array([11]),
        true,
        1,
      ),
    ]).toEqual([0]);
  });

  it('does not interpolate a lineage that moved to a different physical slot', () => {
    const inputs = [
      new Float32Array([-1, 40]),
      new Float32Array([60, 1]),
      new Set([0]),
      new Set([1]),
      new Uint32Array([11, 0]),
      new Uint32Array([0, 11]),
    ] as const;

    expect([
      ...interpolateSimulationCacheAttribute(
        inputs[0],
        inputs[1],
        0.25,
        inputs[2],
        inputs[3],
        inputs[4],
        inputs[5],
        false,
        1,
      ),
    ]).toEqual([-1, 40]);
    expect([
      ...interpolateSimulationCacheAttribute(
        inputs[0],
        inputs[1],
        0.75,
        inputs[2],
        inputs[3],
        inputs[4],
        inputs[5],
        true,
        1,
      ),
    ]).toEqual([60, 1]);
  });
});

describe('simulation-cache allocation limits', () => {
  it('diagnoses an oversized payload before constructing an ArrayBuffer', () => {
    expect(() => validateSimulationCachePayloadSize(0x8000_0000)).toThrow(VfxDiagnosticError);
    try {
      validateSimulationCachePayloadSize(0x8000_0000);
    } catch (error) {
      expect((error as VfxDiagnosticError).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'NACHI_SIM_CACHE_SIZE_LIMIT_EXCEEDED' }),
      );
    }
  });
});
