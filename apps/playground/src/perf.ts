import { TimestampQuery } from 'three/webgpu';
import type * as THREE from 'three/webgpu';

type MetricStatus = 'available' | 'unavailable';
type GpuMetricStatus = 'available' | 'error' | 'pending' | 'unavailable';
type TimestampScope = 'compute' | 'render';

export type GpuUnavailableCause =
  | {
      kind: 'adapter-capability';
      backend: 'WebGL2' | 'WebGPU';
      capability: 'EXT_disjoint_timer_query_webgl2' | 'timestamp-query';
    }
  | {
      kind: 'renderer-configuration';
      option: 'trackTimestamp';
      expected: true;
      actual: false;
    };

type NumericMetric = {
  status: MetricStatus;
  value: number | null;
  reason: string | null;
};

type GpuMetric = {
  status: GpuMetricStatus;
  source: 'three.resolveTimestampsAsync';
  /** Scopes the page explicitly asked the monitor to collect. */
  requestedScopes: readonly TimestampScope[];
  renderMs: number | null;
  computeMs: number | null;
  totalMs: number | null;
  reason: string | null;
  /** Machine-readable reason; verification only permits adapter-capability absence. */
  unavailableCause: GpuUnavailableCause | null;
  sampleWindow: {
    warmup: { completed: number; target: number };
    targetSamples: number;
    compute: GpuSampleAggregate;
    render: GpuSampleAggregate;
    total: GpuSampleAggregate;
  };
};

export type GpuSampleAggregate = {
  status: GpuMetricStatus;
  samples: number;
  complete: boolean;
  medianMs: number | null;
  p95Ms: number | null;
  reason: string | null;
};

export type PerformanceSnapshot = {
  schema: 'nachi.perf-baseline';
  schemaVersion: 2;
  page: string;
  backend: 'WebGL2' | 'WebGPU' | 'unknown';
  mode: 'headless' | 'visual';
  capturedAt: string;
  window: { capacity: number; samples: number };
  frame: {
    fps: NumericMetric;
    averageMs: NumericMetric;
    p95Ms: NumericMetric;
  };
  gpu: GpuMetric;
  heap: {
    status: MetricStatus;
    usedBytes: number | null;
    totalBytes: number | null;
    limitBytes: number | null;
    reason: string | null;
  };
  renderer: {
    drawCalls: number;
    renderCalls: number;
    computeCalls: number;
    computeCallsStatus: 'available' | 'unreliable';
    computeCallsReason: string | null;
    triangles: number;
    points: number;
    lines: number;
  };
};

type PerformanceMemory = {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
};

type TimestampBackend = {
  device?: { features?: { has(feature: string): boolean } };
  hasTimestamp?: boolean;
  isWebGPUBackend?: boolean;
  timestampQueryPool?: Partial<Record<TimestampScope, TimestampQueryPoolLike | null>>;
  trackTimestamp?: boolean;
};

type TimestampQueryPoolLike = {
  currentQueryIndex?: number;
  maxQueries?: number;
};

export type PerformanceMonitorOptions = {
  page: string;
  mode: 'headless' | 'visual';
  gpuScopes?: readonly TimestampScope[];
  gpuSampleSize?: number;
  gpuWarmupSamples?: number;
  windowSize?: number;
};

type TimestampQueryPoolDrainOptions = {
  minimumRemainingRatio?: number;
  projectedFrameMultiplier?: number;
  resolve?: (scopes: readonly TimestampScope[]) => Promise<void>;
  scopes?: readonly TimestampScope[];
};

const DEFAULT_MINIMUM_REMAINING_RATIO = 0.25;
const DEFAULT_PROJECTED_FRAME_MULTIPLIER = 1.25;

export function shouldDrainTimestampQueryPool(
  currentQueryIndex: number,
  maxQueries: number,
  recentlyAllocatedQueries: number,
  minimumRemainingRatio = DEFAULT_MINIMUM_REMAINING_RATIO,
  projectedFrameMultiplier = DEFAULT_PROJECTED_FRAME_MULTIPLIER,
): boolean {
  if (
    !Number.isFinite(currentQueryIndex) ||
    !Number.isFinite(maxQueries) ||
    !Number.isFinite(recentlyAllocatedQueries) ||
    maxQueries <= 0 ||
    currentQueryIndex <= 0
  ) {
    return false;
  }
  const remaining = Math.max(0, maxQueries - currentQueryIndex);
  const capacityReserve = Math.ceil(maxQueries * minimumRemainingRatio);
  const projectedFrameReserve = Math.ceil(
    Math.max(0, recentlyAllocatedQueries) * projectedFrameMultiplier,
  );
  return remaining <= Math.max(capacityReserve, projectedFrameReserve);
}

/**
 * Watches Three's timestamp-query pool consumption and resolves before the next frame can exhaust
 * the pool. Timestamp-free renderers have no pools, so this is a no-op for correctness loops that
 * follow the repository's separate-renderer performance policy.
 */
export function createTimestampQueryPoolDrain(
  renderer: THREE.WebGPURenderer,
  options: TimestampQueryPoolDrainOptions = {},
): () => Promise<boolean> {
  const scopes = [...(options.scopes ?? ['compute', 'render'])];
  const minimumRemainingRatio = options.minimumRemainingRatio ?? DEFAULT_MINIMUM_REMAINING_RATIO;
  const projectedFrameMultiplier =
    options.projectedFrameMultiplier ?? DEFAULT_PROJECTED_FRAME_MULTIPLIER;
  const previousQueryIndices = new Map<TimestampScope, number>();
  let resolutionInFlight: Promise<void> | null = null;
  const resolve =
    options.resolve ??
    (async (requestedScopes: readonly TimestampScope[]) => {
      for (const scope of requestedScopes) {
        const timestampQuery = scope === 'compute' ? TimestampQuery.COMPUTE : TimestampQuery.RENDER;
        await renderer.resolveTimestampsAsync(timestampQuery);
      }
    });

  return async () => {
    if (resolutionInFlight !== null) {
      await resolutionInFlight;
      return true;
    }

    const pools = (renderer.backend as TimestampBackend).timestampQueryPool;
    if (!pools) return false;

    let needsDrain = false;
    for (const scope of scopes) {
      const pool = pools[scope];
      const currentQueryIndex = pool?.currentQueryIndex;
      const maxQueries = pool?.maxQueries;
      if (currentQueryIndex === undefined || maxQueries === undefined) continue;
      const previousQueryIndex = previousQueryIndices.get(scope) ?? 0;
      const recentlyAllocatedQueries =
        currentQueryIndex >= previousQueryIndex
          ? currentQueryIndex - previousQueryIndex
          : currentQueryIndex;
      previousQueryIndices.set(scope, currentQueryIndex);
      needsDrain ||= shouldDrainTimestampQueryPool(
        currentQueryIndex,
        maxQueries,
        recentlyAllocatedQueries,
        minimumRemainingRatio,
        projectedFrameMultiplier,
      );
    }
    if (!needsDrain) return false;

    resolutionInFlight = resolve(scopes);
    try {
      await resolutionInFlight;
      for (const scope of scopes) previousQueryIndices.set(scope, 0);
      return true;
    } finally {
      resolutionInFlight = null;
    }
  };
}

// Stable baseline record schema (v2, backward-compatible extension of v1):
// { schema, schemaVersion, page, backend, mode, capturedAt,
//   window:{capacity,samples},
//   frame:{fps,averageMs,p95Ms},
//   gpu:{status,source,renderMs,computeMs,totalMs,reason},
//   heap:{status,usedBytes,totalBytes,limitBytes,reason},
//   renderer:{drawCalls,renderCalls,computeCalls,computeCallsStatus,computeCallsReason,
//             triangles,points,lines} }
// Numeric metrics always carry {status,value,reason}; unavailable values are null, never silent 0.
// The v1 gpu renderMs/computeMs/totalMs fields remain the latest resolved values. v2 adds a warmed
// bounded sample window with median/p95 per scope and total. Timestamp resolution stays outside
// long-running verification loops; pages explicitly run a short captureGpuSamples window.
// renderer.computeCalls is Three.js's current-frame counter. Three resets it at frame boundaries,
// so headless spike-compute can publish 0 after submitted compute work has already been reset.
export class PerformanceMonitor {
  readonly #renderer: THREE.WebGPURenderer;
  readonly #options: Required<PerformanceMonitorOptions>;
  readonly #frameSamples: number[] = [];
  readonly #hud: HTMLElement | null;
  readonly #timestampQueryPoolDrain: () => Promise<boolean>;
  #previousTimestamp: number | undefined;
  #lastPublishTimestamp = 0;
  #timestampResolutionInFlight: Promise<void> | null = null;
  #gpu: GpuMetric;
  readonly #gpuSamples: Record<TimestampScope | 'total', number[]> = {
    compute: [],
    render: [],
    total: [],
  };
  #gpuWarmupCompleted = 0;

  constructor(renderer: THREE.WebGPURenderer, options: PerformanceMonitorOptions) {
    this.#renderer = renderer;
    this.#options = {
      gpuScopes: options.gpuScopes ?? ['render'],
      gpuSampleSize: options.gpuSampleSize ?? 16,
      gpuWarmupSamples: options.gpuWarmupSamples ?? 4,
      windowSize: options.windowSize ?? 120,
      ...options,
    };
    this.#gpu = this.#detectTimestampSupport();
    this.#hud = options.mode === 'visual' ? this.#createHud() : null;
    this.#timestampQueryPoolDrain = createTimestampQueryPoolDrain(renderer, {
      resolve: async () => this.#scheduleGpuTimestampResolution(false),
      scopes: this.#options.gpuScopes,
    });
    this.publish();
  }

  recordFrame(timestamp: number): void {
    if (this.#previousTimestamp !== undefined) {
      const frameMs = timestamp - this.#previousTimestamp;
      if (Number.isFinite(frameMs) && frameMs > 0 && frameMs < 1000) {
        this.#frameSamples.push(frameMs);
        if (this.#frameSamples.length > this.#options.windowSize) this.#frameSamples.shift();
      }
    }
    this.#previousTimestamp = timestamp;

    if (timestamp - this.#lastPublishTimestamp >= 250) {
      this.#lastPublishTimestamp = timestamp;
      this.publish();
    }
    void this.#timestampQueryPoolDrain();
  }

  resolveGpuTimestamps(): Promise<void> {
    return this.#scheduleGpuTimestampResolution(false);
  }

  async #scheduleGpuTimestampResolution(requireFreshResolution: boolean): Promise<void> {
    if (this.#gpu.status === 'unavailable') return;
    while (this.#timestampResolutionInFlight !== null) {
      await this.#timestampResolutionInFlight;
      if (!requireFreshResolution) return;
    }

    const resolution = this.#resolveGpuTimestampsAndPublish();
    this.#timestampResolutionInFlight = resolution;
    await resolution;
  }

  async #resolveGpuTimestampsAndPublish(): Promise<void> {
    try {
      await this.#resolveGpuTimestamps();
    } finally {
      this.#timestampResolutionInFlight = null;
      this.publish();
    }
  }

  async #resolveGpuTimestamps(): Promise<void> {
    try {
      let resolvedAny = false;
      const resolvedFrame: Partial<Record<TimestampScope, number>> = {};
      for (const scope of this.#options.gpuScopes) {
        const timestampQuery = scope === 'compute' ? TimestampQuery.COMPUTE : TimestampQuery.RENDER;
        const duration = await this.#renderer.resolveTimestampsAsync(timestampQuery);
        if (duration !== undefined && Number.isFinite(duration)) {
          const value = round(duration);
          this.#gpu[scope === 'render' ? 'renderMs' : 'computeMs'] = value;
          resolvedFrame[scope] = value;
          resolvedAny = true;
        }
      }

      const durations = [this.#gpu.renderMs, this.#gpu.computeMs].filter(
        (value): value is number => value !== null,
      );
      this.#gpu.totalMs = durations.length > 0 ? round(sum(durations)) : null;
      if (resolvedAny) this.#recordGpuFrame(resolvedFrame);
      this.#gpu.status = resolvedAny ? 'available' : 'pending';
      this.#gpu.reason = resolvedAny
        ? null
        : 'Timestamp queries are supported, but no completed GPU work has been resolved yet.';
    } catch (error) {
      this.#gpu.status = 'error';
      this.#gpu.reason = error instanceof Error ? error.message : String(error);
      this.#gpu.renderMs = null;
      this.#gpu.computeMs = null;
      this.#gpu.totalMs = null;
    }
  }

  async captureGpuSamples(runFrame: (sample: number) => Promise<void> | void): Promise<void> {
    const targetFrames = this.#options.gpuWarmupSamples + this.#options.gpuSampleSize;
    const maximumAttempts = Math.max(targetFrames, this.#options.gpuSampleSize * 4);
    for (let sample = 0; sample < maximumAttempts; sample += 1) {
      await runFrame(sample);
      await this.#scheduleGpuTimestampResolution(true);
      if (this.#gpuSamplingComplete() || this.#gpu.status === 'unavailable') break;
    }
    this.publish();
  }

  publish(): PerformanceSnapshot {
    const frame = this.#frameMetrics();
    const info = this.#renderer.info;
    const snapshot: PerformanceSnapshot = {
      backend: readBackendName(this.#renderer.backend as TimestampBackend),
      capturedAt: new Date().toISOString(),
      frame,
      gpu: { ...this.#gpu },
      heap: readHeapMetric(),
      mode: this.#options.mode,
      page: this.#options.page,
      renderer: {
        computeCalls: info.compute.frameCalls,
        computeCallsReason:
          info.compute.frameCalls === 0
            ? 'Three resets the current-frame compute counter at frame boundaries; zero does not prove that no compute work was submitted.'
            : null,
        computeCallsStatus: info.compute.frameCalls === 0 ? 'unreliable' : 'available',
        drawCalls: info.render.drawCalls,
        lines: info.render.lines,
        points: info.render.points,
        renderCalls: info.render.frameCalls,
        triangles: info.render.triangles,
      },
      schema: 'nachi.perf-baseline',
      schemaVersion: 2,
      window: { capacity: this.#options.windowSize, samples: this.#frameSamples.length },
    };

    document.documentElement.dataset.perfResult = JSON.stringify(snapshot);
    document.documentElement.dataset.perfStatus = this.#gpu.status;
    this.#updateHud(snapshot);
    return snapshot;
  }

  #detectTimestampSupport(): GpuMetric {
    const backend = this.#renderer.backend as TimestampBackend;
    const common = {
      computeMs: null,
      renderMs: null,
      requestedScopes: [...this.#options.gpuScopes],
      source: 'three.resolveTimestampsAsync' as const,
      totalMs: null,
      unavailableCause: null,
      sampleWindow: {
        compute: emptyGpuAggregate('pending', this.#options.gpuSampleSize),
        render: emptyGpuAggregate('pending', this.#options.gpuSampleSize),
        targetSamples: this.#options.gpuSampleSize,
        total: emptyGpuAggregate('pending', this.#options.gpuSampleSize),
        warmup: { completed: 0, target: this.#options.gpuWarmupSamples },
      },
    };

    if (backend.isWebGPUBackend) {
      const featureAvailable = backend.device?.features?.has('timestamp-query') === true;
      if (!featureAvailable) {
        return {
          ...common,
          reason: 'The selected WebGPU adapter does not expose the timestamp-query feature.',
          status: 'unavailable',
          unavailableCause: {
            backend: 'WebGPU',
            capability: 'timestamp-query',
            kind: 'adapter-capability',
          },
        };
      }
    } else if (backend.hasTimestamp !== true) {
      return {
        ...common,
        reason: 'EXT_disjoint_timer_query_webgl2 is unavailable on the WebGL2 backend.',
        status: 'unavailable',
        unavailableCause: {
          backend: 'WebGL2',
          capability: 'EXT_disjoint_timer_query_webgl2',
          kind: 'adapter-capability',
        },
      };
    }

    if (backend.trackTimestamp !== true) {
      return {
        ...common,
        reason: 'The renderer was not initialized with trackTimestamp: true.',
        status: 'unavailable',
        unavailableCause: {
          actual: false,
          expected: true,
          kind: 'renderer-configuration',
          option: 'trackTimestamp',
        },
      };
    }

    return {
      ...common,
      reason: 'Timestamp queries are supported, but no completed GPU work has been resolved yet.',
      status: 'pending',
    };
  }

  #recordGpuFrame(resolvedFrame: Partial<Record<TimestampScope, number>>): void {
    if (this.#gpuWarmupCompleted < this.#options.gpuWarmupSamples) {
      this.#gpuWarmupCompleted += 1;
    } else {
      for (const scope of this.#options.gpuScopes) {
        const value = resolvedFrame[scope];
        if (value !== undefined) this.#pushGpuSample(scope, value);
      }
      const frameValues = this.#options.gpuScopes.map((scope) => resolvedFrame[scope]);
      if (frameValues.every((value): value is number => value !== undefined)) {
        this.#pushGpuSample('total', round(sum(frameValues)));
      }
    }
    this.#gpu.sampleWindow = {
      compute: summarizeGpuSamples(
        this.#gpuSamples.compute,
        this.#options.gpuSampleSize,
        this.#options.gpuScopes.includes('compute'),
      ),
      render: summarizeGpuSamples(
        this.#gpuSamples.render,
        this.#options.gpuSampleSize,
        this.#options.gpuScopes.includes('render'),
      ),
      targetSamples: this.#options.gpuSampleSize,
      total: summarizeGpuSamples(this.#gpuSamples.total, this.#options.gpuSampleSize, true),
      warmup: {
        completed: this.#gpuWarmupCompleted,
        target: this.#options.gpuWarmupSamples,
      },
    };
  }

  #pushGpuSample(scope: TimestampScope | 'total', value: number): void {
    const samples = this.#gpuSamples[scope];
    samples.push(value);
    if (samples.length > this.#options.gpuSampleSize) samples.shift();
  }

  #gpuSamplingComplete(): boolean {
    return (
      this.#gpuWarmupCompleted >= this.#options.gpuWarmupSamples &&
      this.#options.gpuScopes.every(
        (scope) => this.#gpuSamples[scope].length >= this.#options.gpuSampleSize,
      ) &&
      this.#gpuSamples.total.length >= this.#options.gpuSampleSize
    );
  }

  #frameMetrics(): PerformanceSnapshot['frame'] {
    if (this.#frameSamples.length === 0) {
      const reason =
        this.#options.mode === 'headless'
          ? 'No presentation frames are recorded in headless/offscreen mode.'
          : 'Waiting for presentation frame samples.';
      const unavailable = (): NumericMetric => ({ reason, status: 'unavailable', value: null });
      return { averageMs: unavailable(), fps: unavailable(), p95Ms: unavailable() };
    }

    const averageMs = sum(this.#frameSamples) / this.#frameSamples.length;
    const sorted = [...this.#frameSamples].sort((left, right) => left - right);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    const p95Ms = sorted[p95Index] ?? averageMs;
    const available = (value: number): NumericMetric => ({
      reason: null,
      status: 'available',
      value: round(value),
    });
    return {
      averageMs: available(averageMs),
      fps: available(1000 / averageMs),
      p95Ms: available(p95Ms),
    };
  }

  #createHud(): HTMLElement {
    const hud = document.createElement('aside');
    hud.dataset.perfHud = '';
    hud.setAttribute('aria-label', 'Performance metrics');
    Object.assign(hud.style, {
      background: 'rgb(2 8 19 / 82%)',
      border: '1px solid rgb(86 226 255 / 25%)',
      borderRadius: '0.65rem',
      bottom: '1rem',
      color: '#eafaff',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      left: '1rem',
      padding: '0.55rem 0.7rem',
      pointerEvents: 'none',
      position: 'fixed',
      whiteSpace: 'pre',
      zIndex: '4',
    });
    document.body.append(hud);
    return hud;
  }

  #updateHud(snapshot: PerformanceSnapshot): void {
    if (!this.#hud) return;
    const fps = formatMetric(snapshot.frame.fps, 1);
    const average = formatMetric(snapshot.frame.averageMs, 2, ' ms');
    const p95 = formatMetric(snapshot.frame.p95Ms, 2, ' ms');
    const gpu =
      snapshot.gpu.status === 'available'
        ? `${snapshot.gpu.sampleWindow.total.medianMs?.toFixed(3) ?? snapshot.gpu.totalMs?.toFixed(3) ?? 'N/A'} ms`
        : `N/A (${snapshot.gpu.status})`;
    const heap =
      snapshot.heap.status === 'available' && snapshot.heap.usedBytes !== null
        ? `${(snapshot.heap.usedBytes / 1_048_576).toFixed(1)} MiB`
        : 'N/A (Chrome only)';
    this.#hud.textContent = `FPS ${fps}  frame ${average}  p95 ${p95}\nGPU ${gpu}  heap ${heap}  draws ${snapshot.renderer.drawCalls}`;
    this.#hud.title = snapshot.gpu.reason ?? 'GPU timestamp query active';
  }
}

function emptyGpuAggregate(
  status: GpuMetricStatus,
  targetSamples: number,
  reason = 'Waiting for warmed GPU timestamp samples.',
): GpuSampleAggregate {
  return {
    complete: false,
    medianMs: null,
    p95Ms: null,
    reason: targetSamples > 0 ? reason : null,
    samples: 0,
    status,
  };
}

export function summarizeGpuSamples(
  values: readonly number[],
  targetSamples: number,
  requested: boolean,
): GpuSampleAggregate {
  if (!requested) {
    return emptyGpuAggregate(
      'unavailable',
      targetSamples,
      'This timestamp scope was not requested.',
    );
  }
  if (values.length === 0) return emptyGpuAggregate('pending', targetSamples);
  const sorted = [...values].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[medianIndex - 1] ?? 0) + (sorted[medianIndex] ?? 0)) / 2
      : (sorted[medianIndex] ?? 0);
  const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
  const complete = values.length >= targetSamples;
  return {
    complete,
    medianMs: round(median),
    p95Ms: round(sorted[p95Index] ?? median),
    reason: complete ? null : `Collected ${values.length} of ${targetSamples} target samples.`,
    samples: values.length,
    status: 'available',
  };
}

export function createPerformanceMonitor(
  renderer: THREE.WebGPURenderer,
  options: PerformanceMonitorOptions,
): PerformanceMonitor {
  return new PerformanceMonitor(renderer, options);
}

function readBackendName(backend: TimestampBackend): PerformanceSnapshot['backend'] {
  if (backend.isWebGPUBackend === true) return 'WebGPU';
  return 'WebGL2';
}

function readHeapMetric(): PerformanceSnapshot['heap'] {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  if (!memory) {
    return {
      limitBytes: null,
      reason: 'performance.memory is unavailable (Chrome-only, non-standard API).',
      status: 'unavailable',
      totalBytes: null,
      usedBytes: null,
    };
  }
  return {
    limitBytes: memory.jsHeapSizeLimit,
    reason: null,
    status: 'available',
    totalBytes: memory.totalJSHeapSize,
    usedBytes: memory.usedJSHeapSize,
  };
}

function formatMetric(metric: NumericMetric, digits: number, suffix = ''): string {
  return metric.value === null ? 'N/A' : `${metric.value.toFixed(digits)}${suffix}`;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
