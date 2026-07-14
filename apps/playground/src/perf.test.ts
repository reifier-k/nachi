import { describe, expect, it } from 'vitest';

import {
  createTimestampQueryPoolDrain,
  shouldDrainTimestampQueryPool,
  summarizeGpuSamples,
} from './perf';

describe('timestamp query-pool auto drain', () => {
  it('keeps accumulating while the remaining pool covers the reserve and projected next frame', () => {
    expect(shouldDrainTimestampQueryPool(600, 2048, 300)).toBe(false);
    expect(shouldDrainTimestampQueryPool(1200, 2048, 300)).toBe(false);
  });

  it('drains from remaining capacity instead of a fixed frame period', () => {
    expect(shouldDrainTimestampQueryPool(1800, 2048, 300)).toBe(true);
    expect(shouldDrainTimestampQueryPool(1200, 2048, 900)).toBe(true);
  });

  it('ignores absent and unused pools', () => {
    expect(shouldDrainTimestampQueryPool(0, 2048, 0)).toBe(false);
    expect(shouldDrainTimestampQueryPool(12, 0, 12)).toBe(false);
  });

  it('resolves configured scopes only after their pool crosses the adaptive reserve', async () => {
    const pool = { currentQueryIndex: 600, maxQueries: 2048 };
    const resolved: string[] = [];
    const renderer = {
      backend: { timestampQueryPool: { compute: pool, render: null } },
      async resolveTimestampsAsync(scope: string) {
        resolved.push(scope);
        pool.currentQueryIndex = 0;
      },
    };
    const drain = createTimestampQueryPoolDrain(renderer as never, { scopes: ['compute'] });

    await expect(drain()).resolves.toBe(false);
    pool.currentQueryIndex = 1800;
    await expect(drain()).resolves.toBe(true);
    expect(resolved).toEqual(['compute']);
  });
});

describe('perf-baseline v2 GPU aggregation', () => {
  it('records a complete 16-sample median and nearest-rank p95', () => {
    expect(
      summarizeGpuSamples([16, 1, 15, 2, 14, 3, 13, 4, 12, 5, 11, 6, 10, 7, 9, 8], 16, true),
    ).toEqual({
      complete: true,
      medianMs: 8.5,
      p95Ms: 16,
      reason: null,
      samples: 16,
      status: 'available',
    });
  });

  it('keeps incomplete and unrequested scopes explicit', () => {
    expect(summarizeGpuSamples([4, 2, 3], 16, true)).toMatchObject({
      complete: false,
      medianMs: 3,
      p95Ms: 4,
      reason: 'Collected 3 of 16 target samples.',
      samples: 3,
      status: 'available',
    });
    expect(summarizeGpuSamples([], 16, false)).toEqual({
      complete: false,
      medianMs: null,
      p95Ms: null,
      reason: 'This timestamp scope was not requested.',
      samples: 0,
      status: 'unavailable',
    });
  });
});
