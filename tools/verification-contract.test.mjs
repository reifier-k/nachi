import { describe, expect, it } from 'vitest';

import {
  validateBrowserDiagnostics,
  validatePerformanceSnapshot,
  validateScreenshotRegions,
  validateScreenshotUpdateEligibility,
  screenshotRegionResultsOk,
} from './verification-contract.mjs';

function completePerformance() {
  const aggregate = { complete: true, samples: 16, status: 'available' };
  return {
    backend: 'WebGPU',
    gpu: {
      reason: null,
      requestedScopes: ['compute'],
      sampleWindow: {
        compute: aggregate,
        render: { complete: false, samples: 0, status: 'unavailable' },
        targetSamples: 16,
        total: aggregate,
        warmup: { completed: 4, target: 4 },
      },
      status: 'available',
      unavailableCause: null,
    },
    schema: 'nachi.perf-baseline',
    schemaVersion: 2,
  };
}

describe('runner diagnostic contract', () => {
  it('fails warnings, errors, and page errors by default', () => {
    expect(
      validateBrowserDiagnostics({
        console: [{ type: 'warning', text: 'import warning' }],
        pageErrors: ['async failure'],
      }),
    ).toMatchObject({ ok: false, unexpected: [{ type: 'warning' }, { type: 'pageerror' }] });
  });

  it('only consumes an exact type and substring once and rejects unused opt-outs', () => {
    const diagnostics = {
      console: [{ type: 'warning', text: '[NACHI_X] expected detail' }],
      pageErrors: [],
    };
    expect(
      validateBrowserDiagnostics(diagnostics, [{ type: 'warning', text: '[NACHI_X]' }]),
    ).toMatchObject({ missing: [], ok: true, unexpected: [] });
    expect(
      validateBrowserDiagnostics(diagnostics, [{ type: 'error', text: '[NACHI_X]' }]),
    ).toMatchObject({ ok: false });
    expect(
      validateBrowserDiagnostics({ console: [], pageErrors: [] }, [
        { type: 'warning', text: '[NACHI_X]' },
      ]),
    ).toMatchObject({ missing: [{ type: 'warning', text: '[NACHI_X]' }], ok: false });
  });
});

describe('runner performance contract', () => {
  it('accepts complete requested scopes and explicit unrequested scopes', () => {
    expect(validatePerformanceSnapshot(completePerformance())).toEqual({ failures: [], ok: true });
  });

  it.each(['pending', 'error'])('rejects top-level %s status', (status) => {
    const snapshot = completePerformance();
    snapshot.gpu.status = status;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it('rejects incomplete or unavailable requested scopes', () => {
    const incomplete = completePerformance();
    incomplete.gpu.sampleWindow.compute.complete = false;
    expect(validatePerformanceSnapshot(incomplete).ok).toBe(false);
    const unavailable = completePerformance();
    unavailable.gpu.sampleWindow.compute = { complete: false, samples: 0, status: 'unavailable' };
    expect(validatePerformanceSnapshot(unavailable).ok).toBe(false);
  });

  it('allows adapter-level unavailability only with a matching structured cause', () => {
    const snapshot = completePerformance();
    snapshot.gpu.status = 'unavailable';
    snapshot.gpu.reason = 'timestamp-query is not exposed';
    snapshot.gpu.unavailableCause = {
      backend: 'WebGPU',
      capability: 'timestamp-query',
      kind: 'adapter-capability',
    };
    snapshot.gpu.sampleWindow = undefined;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(true);
    snapshot.gpu.reason = null;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it('rejects renderer-configuration and malformed adapter unavailability', () => {
    const snapshot = completePerformance();
    snapshot.gpu.status = 'unavailable';
    snapshot.gpu.reason = 'trackTimestamp is disabled';
    snapshot.gpu.unavailableCause = {
      actual: false,
      expected: true,
      kind: 'renderer-configuration',
      option: 'trackTimestamp',
    };
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);

    snapshot.gpu.unavailableCause = {
      backend: 'WebGL2',
      capability: 'EXT_disjoint_timer_query_webgl2',
      kind: 'adapter-capability',
    };
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
    snapshot.gpu.unavailableCause = null;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['string completed', { completed: '4', target: 4 }],
    ['non-finite completed', { completed: Number.NaN, target: 4 }],
    ['non-finite target', { completed: 4, target: Number.POSITIVE_INFINITY }],
    ['invalid target', { completed: 4, target: -1 }],
    ['incomplete', { completed: 3, target: 4 }],
    ['excess', { completed: 5, target: 4 }],
  ])('rejects %s warmup metadata', (_label, warmup) => {
    const snapshot = completePerformance();
    snapshot.gpu.sampleWindow.warmup = warmup;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it.each([
    ['string', '16'],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('rejects a %s targetSamples counter', (_label, targetSamples) => {
    const snapshot = completePerformance();
    snapshot.gpu.sampleWindow.targetSamples = targetSamples;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it.each([
    ['string', '16'],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('rejects a %s aggregate sample counter', (_label, samples) => {
    const snapshot = completePerformance();
    snapshot.gpu.sampleWindow.compute.samples = samples;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });

  it('strictly checks aggregate status/complete and unrequested zero samples', () => {
    const snapshot = completePerformance();
    snapshot.gpu.sampleWindow.compute.complete = 'true';
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
    snapshot.gpu.sampleWindow.compute.complete = true;
    snapshot.gpu.sampleWindow.compute.status = 'pending';
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
    snapshot.gpu.sampleWindow.compute.status = 'available';
    snapshot.gpu.sampleWindow.render.samples = 1;
    expect(validatePerformanceSnapshot(snapshot).ok).toBe(false);
  });
});

describe('screenshot ROI contract', () => {
  it('requires an absolute foreground-pixel floor in every normalized ROI', () => {
    expect(
      validateScreenshotRegions([
        {
          name: 'sparks',
          x: 0.5,
          y: 0.2,
          width: 0.4,
          height: 0.5,
          minimumForegroundPixels: 20,
          maximumChangedPixelRatio: 0.002,
        },
      ]),
    ).toEqual([
      {
        name: 'sparks',
        x: 0.5,
        y: 0.2,
        width: 0.4,
        height: 0.5,
        luminanceThreshold: 28,
        minimumForegroundPixels: 20,
        maximumChangedPixelRatio: 0.002,
      },
    ]);
    expect(() =>
      validateScreenshotRegions([
        { name: 'broken', x: 0, y: 0, width: 1, height: 1, minimumForegroundPixels: 0 },
      ]),
    ).toThrow();
  });

  it('rejects a zero-diff pair when both the baseline and fake implementation lost the element', () => {
    const missing = [{ foregroundPixels: 0, ok: false }];
    const zeroDifference = [{ changedPixelRatio: 0, ok: true }];
    expect(screenshotRegionResultsOk(missing, missing, zeroDifference)).toBe(false);
    expect(
      screenshotRegionResultsOk(
        [{ foregroundPixels: 323, ok: true }],
        [{ foregroundPixels: 323, ok: true }],
        zeroDifference,
      ),
    ).toBe(true);
  });
});

describe('screenshot update transaction gate', () => {
  const successful = {
    diagnosticOk: true,
    performanceOk: true,
    resultOk: true,
    screenshotsOk: true,
    status: 'complete',
  };

  it('opens only after every final runner contract succeeds', () => {
    expect(validateScreenshotUpdateEligibility(successful)).toBe(true);
    for (const key of ['diagnosticOk', 'performanceOk', 'resultOk', 'screenshotsOk']) {
      expect(validateScreenshotUpdateEligibility({ ...successful, [key]: false })).toBe(false);
    }
    expect(validateScreenshotUpdateEligibility({ ...successful, status: 'error' })).toBe(false);
  });
});
