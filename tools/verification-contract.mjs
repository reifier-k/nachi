const DIAGNOSTIC_TYPES = new Set(['warning', 'error', 'pageerror']);

/**
 * Match browser diagnostics against a page's deliberately narrow opt-out contract.
 * Every ignored diagnostic consumes exactly one expectation, and unused expectations fail too.
 */
export function validateBrowserDiagnostics(diagnostics, expectations = []) {
  if (!Array.isArray(expectations)) {
    return { ok: false, error: 'data-expected-diagnostics must contain a JSON array.' };
  }
  const pending = expectations.map((expectation, index) => {
    if (
      typeof expectation !== 'object' ||
      expectation === null ||
      !DIAGNOSTIC_TYPES.has(expectation.type) ||
      typeof expectation.text !== 'string' ||
      expectation.text.length === 0
    ) {
      throw new Error(`Invalid expected diagnostic at index ${index}.`);
    }
    return { ...expectation, matched: false };
  });
  const actual = [
    ...diagnostics.console
      .filter(({ type }) => type === 'warning' || type === 'error')
      .map(({ text, type }) => ({ text, type })),
    ...diagnostics.pageErrors.map((text) => ({ text, type: 'pageerror' })),
  ];
  const unexpected = [];
  for (const diagnostic of actual) {
    const expected = pending.find(
      (candidate) =>
        !candidate.matched &&
        candidate.type === diagnostic.type &&
        diagnostic.text.includes(candidate.text),
    );
    if (expected) expected.matched = true;
    else unexpected.push(diagnostic);
  }
  const missing = pending
    .filter(({ matched }) => !matched)
    .map(({ matched: _matched, ...expectation }) => expectation);
  return { actual, missing, ok: unexpected.length === 0 && missing.length === 0, unexpected };
}

/** Verify the perf-baseline v2 completion contract without treating timings as performance claims. */
export function validatePerformanceSnapshot(snapshot) {
  const failures = [];
  if (snapshot?.schema !== 'nachi.perf-baseline' || snapshot?.schemaVersion !== 2) {
    failures.push('Expected nachi.perf-baseline schemaVersion 2.');
    return { failures, ok: false };
  }
  const gpu = snapshot.gpu;
  if (!gpu || !Array.isArray(gpu.requestedScopes) || gpu.requestedScopes.length === 0) {
    failures.push('GPU requestedScopes must be a non-empty array.');
    return { failures, ok: false };
  }
  if (gpu.requestedScopes.some((scope) => scope !== 'compute' && scope !== 'render')) {
    failures.push('GPU requestedScopes contains an unknown scope.');
  }
  if (gpu.status === 'unavailable') {
    if (typeof gpu.reason !== 'string' || gpu.reason.length === 0) {
      failures.push('Unavailable GPU metrics require an explicit reason.');
    }
    const cause = gpu.unavailableCause;
    const allowedCause =
      cause?.kind === 'adapter-capability' &&
      ((cause.backend === 'WebGPU' && cause.capability === 'timestamp-query') ||
        (cause.backend === 'WebGL2' && cause.capability === 'EXT_disjoint_timer_query_webgl2')) &&
      snapshot.backend === cause.backend;
    if (!allowedCause) {
      failures.push(
        'Unavailable GPU metrics are allowed only for a structured adapter-capability cause matching the active backend.',
      );
    }
    return { failures, ok: failures.length === 0 };
  }
  if (gpu.status !== 'available') {
    failures.push(
      `GPU metric status must be available or explicitly unavailable, received ${gpu.status}.`,
    );
    return { failures, ok: false };
  }
  const window = gpu.sampleWindow;
  if (!window || !Number.isSafeInteger(window.targetSamples) || window.targetSamples < 1) {
    failures.push('GPU sampleWindow.targetSamples must be a positive integer.');
    return { failures, ok: false };
  }
  const warmup = window.warmup;
  if (
    !warmup ||
    !Number.isSafeInteger(warmup.completed) ||
    warmup.completed < 0 ||
    !Number.isSafeInteger(warmup.target) ||
    warmup.target < 0
  ) {
    failures.push('GPU sampleWindow.warmup must contain finite non-negative integer counters.');
  } else if (warmup.completed !== warmup.target) {
    failures.push('GPU warmup window is incomplete or exceeds its declared target.');
  }
  for (const scope of ['compute', 'render']) {
    const aggregate = window[scope];
    if (!Number.isSafeInteger(aggregate?.samples) || aggregate.samples < 0) {
      failures.push(`GPU ${scope} sample count must be a non-negative safe integer.`);
    }
    if (gpu.requestedScopes.includes(scope)) {
      if (
        aggregate?.status !== 'available' ||
        aggregate?.complete !== true ||
        aggregate?.samples < window.targetSamples
      ) {
        failures.push(`Requested GPU ${scope} sample window is incomplete.`);
      }
    } else if (
      aggregate?.status !== 'unavailable' ||
      aggregate?.complete !== false ||
      aggregate?.samples !== 0
    ) {
      failures.push(
        `Unrequested GPU ${scope} scope must remain explicitly unavailable with zero samples.`,
      );
    }
  }
  if (!Number.isSafeInteger(window.total?.samples) || window.total.samples < 0) {
    failures.push('GPU total sample count must be a non-negative safe integer.');
  }
  if (
    window.total?.status !== 'available' ||
    window.total?.complete !== true ||
    window.total?.samples < window.targetSamples
  ) {
    failures.push('GPU total sample window is incomplete.');
  }
  return { failures, ok: failures.length === 0 };
}

export function validateScreenshotRegions(regions) {
  if (regions === undefined) return [];
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error('Screenshot regions must be a non-empty array when provided.');
  }
  return regions.map((region, index) => {
    if (
      typeof region !== 'object' ||
      region === null ||
      typeof region.name !== 'string' ||
      region.name.length === 0 ||
      ![region.x, region.y, region.width, region.height].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
      ) ||
      region.width === 0 ||
      region.height === 0 ||
      region.x + region.width > 1 ||
      region.y + region.height > 1 ||
      !Number.isSafeInteger(region.minimumForegroundPixels) ||
      region.minimumForegroundPixels < 1 ||
      (region.maximumChangedPixelRatio !== undefined &&
        (typeof region.maximumChangedPixelRatio !== 'number' ||
          !Number.isFinite(region.maximumChangedPixelRatio) ||
          region.maximumChangedPixelRatio <= 0 ||
          region.maximumChangedPixelRatio > 1)) ||
      (region.luminanceThreshold !== undefined &&
        (typeof region.luminanceThreshold !== 'number' ||
          !Number.isFinite(region.luminanceThreshold) ||
          region.luminanceThreshold < 0 ||
          region.luminanceThreshold > 255))
    ) {
      throw new Error(`Invalid screenshot region at index ${index}.`);
    }
    return { luminanceThreshold: 28, ...region };
  });
}

/** Absolute floors keep a mutually broken baseline/current pair from passing a zero-diff check. */
export function screenshotRegionResultsOk(actualRegions, baselineRegions, regionChanges) {
  return (
    actualRegions.every(({ ok }) => ok === true) &&
    baselineRegions.every(({ ok }) => ok === true) &&
    regionChanges.every(({ ok }) => ok === true)
  );
}

export function validateScreenshotUpdateEligibility({
  diagnosticOk,
  performanceOk,
  resultOk,
  screenshotsOk,
  status,
}) {
  return (
    status === 'complete' &&
    resultOk === true &&
    screenshotsOk === true &&
    performanceOk === true &&
    diagnosticOk === true
  );
}
