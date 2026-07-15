import { describe, expect, it } from 'vitest';

import { evaluateDrawControl } from './spike-compute-contract';

const zero = {
  foreground: false,
  indirectArgs: [6, 0, 0, 0, 0],
  instanceCount: 0,
} as const;
const nonzero = {
  foreground: true,
  indirectArgs: [6, 7394, 0, 0, 0],
  instanceCount: 7394,
} as const;

describe('spike-compute draw causal control', () => {
  it('accepts black zero GPU args followed by foreground nonzero GPU args', () => {
    expect(evaluateDrawControl('WebGPU', 6, zero, nonzero)).toEqual({
      controlPassed: true,
      indirectCausal: true,
    });
  });

  it('rejects a missing geometry.setIndirect/direct-count path that draws the zero control', () => {
    expect(evaluateDrawControl('WebGPU', 6, { ...zero, foreground: true }, nonzero)).toEqual({
      controlPassed: false,
      indirectCausal: false,
    });
  });

  it('rejects CPU-looking or malformed arguments on the WebGPU path', () => {
    expect(
      evaluateDrawControl('WebGPU', 6, zero, {
        ...nonzero,
        indirectArgs: null,
      }),
    ).toEqual({ controlPassed: false, indirectCausal: false });
    expect(
      evaluateDrawControl('WebGPU', 6, zero, {
        ...nonzero,
        indirectArgs: [6, 0, 0, 0, 0],
      }),
    ).toEqual({ controlPassed: false, indirectCausal: false });
  });

  it('labels the verified WebGL CPU fallback as non-indirect', () => {
    expect(
      evaluateDrawControl(
        'WebGL2',
        6,
        { ...zero, indirectArgs: null },
        { ...nonzero, indirectArgs: null },
      ),
    ).toEqual({ controlPassed: true, indirectCausal: false });
  });
});
