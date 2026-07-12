import { describe, expect, it } from 'vitest';

import { summarizeGpuSamples } from './perf';

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
