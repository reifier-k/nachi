import { describe, expect, it } from 'vitest';

import {
  publishM10SortError,
  publishM10SortValidation,
  validateSpawnOrderInitReadback,
} from './m10-sort-status';

function fixture() {
  return {
    root: { dataset: {} as Record<string, string | undefined> },
    status: { textContent: null as string | null },
  };
}

describe('M10 sort spike status', () => {
  it('matches an init tslModule spawnOrder derivation against GPU attribute readback', () => {
    expect(validateSpawnOrderInitReadback([2, 1, 0], [0.6, 0, -0.6])).toBe(true);
    expect(validateSpawnOrderInitReadback([2, 1, 0], [0, 0xffff_ffff, 0xffff_ffff])).toBe(false);
  });

  it('completes without throwing and publishes failed validation evidence', () => {
    const { root, status } = fixture();
    const validation = { coarseReversal: false, deterministic: true };

    expect(() =>
      publishM10SortValidation(root, status, validation, { backend: 'WebGPU' }),
    ).not.toThrow();

    expect(root.dataset.spikeStatus).toBe('complete');
    expect(JSON.parse(root.dataset.spikeResult!)).toEqual({
      backend: 'WebGPU',
      ok: false,
      validation,
    });
    expect(status.textContent).toBe('Validation failed');
  });

  it('uses error only for runtime exceptions', () => {
    const { root, status } = fixture();

    publishM10SortError(root, status, new Error('device failure'));

    expect(root.dataset.spikeStatus).toBe('error');
    expect(root.dataset.spikeError).toBe('device failure');
    expect(JSON.parse(root.dataset.spikeResult!)).toEqual({
      error: 'device failure',
      ok: false,
    });
  });
});
