import { describe, expect, it } from 'vitest';

import { nextUpdateRandomStep } from '../src/update-random-step.js';

describe('Update random dispatch ordinal', () => {
  it.each([
    [0, 1],
    [0xffff_fffe, 0xffff_ffff],
    [0xffff_ffff, 0],
  ])('advances %d modulo 2^32 to %d', (current, expected) => {
    expect(nextUpdateRandomStep(current)).toBe(expected);
  });
});
