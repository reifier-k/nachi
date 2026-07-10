import type * as THREE from 'three/webgpu';

type MetricStatus = 'available' | 'unavailable';
type GpuMetricStatus = 'available' | 'error' | 'pending' | 'unavailable';
type TimestampScope = 'compute' | 'render';

type NumericMetric = {
  status: MetricStatus;
  value: number | null;
  reason: string | null;
};

type GpuMetric = {
  status: GpuMetricStatus;
  source: 'three.resolveTimestampsAsync';
  renderMs: number | null;
  computeMs: number | null;
  totalMs: number | null;
  reason: string | null;
};

export type PerformanceSnapshot = {
  schema: 'nachi.perf-baseline';
  schemaVersion: 1;
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
  trackTimestamp?: boolean;
};

export type PerformanceMonitorOptions = {
  page: string;
  mode: 'headless' | 'visual';
  gpuScopes?: readonly TimestampScope[];
  windowSize?: number;
};

// Stable baseline record schema (v1):
// { schema, schemaVersion, page, backend, mode, capturedAt,
//   window:{capacity,samples},
//   frame:{fps,averageMs,p95Ms},
//   gpu:{status,source,renderMs,computeMs,totalMs,reason},
//   heap:{status,usedBytes,totalBytes,limitBytes,reason},
//   renderer:{drawCalls,renderCalls,computeCalls,triangles,points,lines} }
// Numeric metrics always carry {status,value,reason}; unavailable values are null, never silent 0.
// renderer.computeCalls is Three.js's current-frame counter. Three resets it at frame boundaries,
// so headless spike-compute can publish 0 after submitted compute work has already been reset.
export class PerformanceMonitor {
  readonly #renderer: THREE.WebGPURenderer;
  readonly #options: Required<PerformanceMonitorOptions>;
  readonly #frameSamples: number[] = [];
  readonly #hud: HTMLElement | null;
  #previousTimestamp: number | undefined;
  #frameCount = 0;
  #lastPublishTimestamp = 0;
  #timestampResolutionInFlight = false;
  #gpu: GpuMetric;

  constructor(renderer: THREE.WebGPURenderer, options: PerformanceMonitorOptions) {
    this.#renderer = renderer;
    this.#options = {
      gpuScopes: options.gpuScopes ?? ['render'],
      windowSize: options.windowSize ?? 120,
      ...options,
    };
    this.#gpu = this.#detectTimestampSupport();
    this.#hud = options.mode === 'visual' ? this.#createHud() : null;
    this.publish();
  }

  recordFrame(timestamp: number): void {
    this.#frameCount += 1;
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
    if (this.#frameCount % 30 === 0) {
      void this.resolveGpuTimestamps();
    }
  }

  async resolveGpuTimestamps(): Promise<void> {
    if (this.#gpu.status === 'unavailable' || this.#timestampResolutionInFlight) return;
    this.#timestampResolutionInFlight = true;

    try {
      let resolvedAny = false;
      for (const scope of this.#options.gpuScopes) {
        const duration = await this.#renderer.resolveTimestampsAsync(scope);
        if (duration !== undefined && Number.isFinite(duration)) {
          this.#gpu[scope === 'render' ? 'renderMs' : 'computeMs'] = round(duration);
          resolvedAny = true;
        }
      }

      const durations = [this.#gpu.renderMs, this.#gpu.computeMs].filter(
        (value): value is number => value !== null,
      );
      this.#gpu.totalMs = durations.length > 0 ? round(sum(durations)) : null;
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
    } finally {
      this.#timestampResolutionInFlight = false;
      this.publish();
    }
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
        drawCalls: info.render.drawCalls,
        lines: info.render.lines,
        points: info.render.points,
        renderCalls: info.render.frameCalls,
        triangles: info.render.triangles,
      },
      schema: 'nachi.perf-baseline',
      schemaVersion: 1,
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
      source: 'three.resolveTimestampsAsync' as const,
      totalMs: null,
    };

    if (backend.isWebGPUBackend) {
      const featureAvailable = backend.device?.features?.has('timestamp-query') === true;
      if (!featureAvailable) {
        return {
          ...common,
          reason: 'The selected WebGPU adapter does not expose the timestamp-query feature.',
          status: 'unavailable',
        };
      }
    } else if (backend.hasTimestamp !== true) {
      return {
        ...common,
        reason: 'EXT_disjoint_timer_query_webgl2 is unavailable on the WebGL2 backend.',
        status: 'unavailable',
      };
    }

    if (backend.trackTimestamp !== true) {
      return {
        ...common,
        reason: 'The renderer was not initialized with trackTimestamp: true.',
        status: 'unavailable',
      };
    }

    return {
      ...common,
      reason: 'Timestamp queries are supported, but no completed GPU work has been resolved yet.',
      status: 'pending',
    };
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
        ? `${snapshot.gpu.totalMs?.toFixed(3) ?? 'N/A'} ms`
        : `N/A (${snapshot.gpu.status})`;
    const heap =
      snapshot.heap.status === 'available' && snapshot.heap.usedBytes !== null
        ? `${(snapshot.heap.usedBytes / 1_048_576).toFixed(1)} MiB`
        : 'N/A (Chrome only)';
    this.#hud.textContent = `FPS ${fps}  frame ${average}  p95 ${p95}\nGPU ${gpu}  heap ${heap}  draws ${snapshot.renderer.drawCalls}`;
    this.#hud.title = snapshot.gpu.reason ?? 'GPU timestamp query active';
  }
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
