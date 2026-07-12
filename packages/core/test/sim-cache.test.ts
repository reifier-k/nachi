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
        false,
        1,
      ),
    ]).toEqual([1]);
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
