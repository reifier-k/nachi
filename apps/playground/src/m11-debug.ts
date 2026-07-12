import {
  VFXSystem,
  VfxDiagnosticError,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  positionSphere,
  tslModule,
  type AttributeSnapshot,
  type DebugAttributeValue,
  type VfxEmitterRuntimeView,
  type VfxProfileSnapshot,
} from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { normalizeRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m11-debug.css';

// 190 * RGBA8 is deliberately not 256-byte aligned; shared readback must remove WebGPU padding.
const WIDTH = 190;
const HEIGHT = 64;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const headless = query.get('headless') === '1';
const consoleMessages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(values.map(String).join(' '));
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(values.map(String).join(' '));
  originalError(...values);
};

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { readonly maxStorageBuffersPerShaderStage?: number };
    readonly lost?: Promise<{ message?: string; reason?: string }>;
  };
  readonly gl?: WebGL2RenderingContext;
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M11 debugger UI element ${selector}.`);
  return value;
}

function fixtureEmitter(scale: number, bias: number) {
  const analyticLifetime = tslModule(
    ({ spawnOrder }) => ({ lifetime: spawnOrder.toFloat().mul(scale).add(bias) }),
    { stage: 'init' },
  );
  return defineEmitter({
    capacity: 4,
    init: [positionSphere({ radius: 0 }), analyticLifetime],
    integration: 'none',
    lifecycle: { duration: 10 },
    render: billboard({ blending: 'additive' }),
    spawn: burst({ count: 4 }),
  });
}

function numeric(value: DebugAttributeValue | undefined): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function emitterView(instance: {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
}): VfxEmitterRuntimeView {
  const emitter = instance.getEmitter('particles');
  if (!emitter) throw new Error('M11 debugger fixture emitter is missing.');
  return emitter;
}

async function renderProfileDrawFrame(
  renderer: THREE.WebGPURenderer,
  draws: readonly THREE.Object3D[],
): Promise<void> {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
  camera.position.z = 2;
  scene.add(...draws);
  const target = new THREE.RenderTarget(1, 1);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  renderer.setRenderTarget(null);
  target.dispose();
}

function analyticRows(snapshot: AttributeSnapshot, scale: number, bias: number): boolean {
  return (
    snapshot.aliveCount === 4 &&
    snapshot.rows.length === 4 &&
    snapshot.rows.every((row) => {
      const order = row.spawnOrder;
      return (
        order !== undefined &&
        Math.abs(numeric(row.attributes.lifetime) - (order * scale + bias)) < 1e-6
      );
    })
  );
}

function formatValue(value: DebugAttributeValue | undefined): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return `[${value.map((item) => item.toFixed(3)).join(', ')}]`;
  return typeof value === 'number' ? value.toFixed(3) : String(value);
}

function installSpreadsheet(snapshot: AttributeSnapshot): void {
  const table = required<HTMLTableElement>('#attribute-table');
  const controls = required<HTMLElement>('#column-controls');
  const select = required<HTMLSelectElement>('#sort-select');
  const direction = required<HTMLButtonElement>('#sort-direction');
  const visible = new Set(snapshot.columns.map(({ name }) => name));
  let ascending = true;
  let sortKey = 'aliveIndex';
  const columnLabel = (column: AttributeSnapshot['columns'][number]) =>
    column.aliased ? `${column.name} ⚠ WebGL2 TF alias` : column.name;
  select.replaceChildren(
    ...[
      'aliveIndex',
      'physicalSlot',
      'spawnOrder',
      ...snapshot.columns.map(({ name }) => name),
    ].map((name) => new Option(name, name)),
  );
  const render = () => {
    const columns = snapshot.columns.filter(({ name }) => visible.has(name));
    const value = (row: AttributeSnapshot['rows'][number], key: string): number => {
      if (key === 'aliveIndex' || key === 'physicalSlot') return row[key];
      if (key === 'spawnOrder') return row.spawnOrder ?? Number.POSITIVE_INFINITY;
      return numeric(row.attributes[key]);
    };
    const rows = [...snapshot.rows].sort((left, right) => {
      const difference = value(left, sortKey) - value(right, sortKey);
      return ascending ? difference : -difference;
    });
    const head = document.createElement('thead');
    const heading = document.createElement('tr');
    for (const name of ['alive', 'slot', 'generation', 'order']) {
      const cell = document.createElement('th');
      cell.textContent = name;
      heading.append(cell);
    }
    for (const column of columns) {
      const cell = document.createElement('th');
      cell.textContent = columnLabel(column);
      if (column.aliased) {
        cell.classList.add('aliased-column');
        cell.title =
          'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED: value aliases the corresponding packed group-0 component.';
      }
      heading.append(cell);
    }
    head.append(heading);
    const body = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const values = [
        String(row.aliveIndex),
        String(row.physicalSlot),
        String(row.spawnGeneration ?? '—'),
        String(row.spawnOrder ?? '—'),
        ...columns.map(({ name }) => formatValue(row.attributes[name])),
      ];
      for (const text of values) {
        const cell = document.createElement('td');
        cell.textContent = text;
        tr.append(cell);
      }
      body.append(tr);
    }
    table.replaceChildren(head, body);
  };
  controls.replaceChildren();
  for (const column of snapshot.columns) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) visible.add(column.name);
      else visible.delete(column.name);
      render();
    });
    label.append(checkbox, ` ${columnLabel(column)}`);
    if (column.aliased) {
      label.classList.add('aliased-column');
      label.title =
        'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED: value aliases the corresponding packed group-0 component.';
    }
    controls.append(label);
  }
  select.addEventListener('change', () => {
    sortKey = select.value;
    render();
  });
  direction.addEventListener('click', () => {
    ascending = !ascending;
    direction.textContent = ascending ? 'ascending' : 'descending';
    render();
  });
  render();
}

function metric(metric: { readonly status: string; readonly value: number | null }): string {
  return metric.value === null ? `N/A (${metric.status})` : String(metric.value);
}

function renderProfile(snapshot: VfxProfileSnapshot): void {
  const table = required<HTMLTableElement>('#profile-table');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const name of ['instance/emitter', 'alive/capacity', 'spawn', 'compute', 'draw', 'CPU ms']) {
    const cell = document.createElement('th');
    cell.textContent = name;
    heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  for (const row of snapshot.emitters) {
    const tr = document.createElement('tr');
    const values = [
      `${row.instanceId}/${row.emitterId}`,
      `${metric(row.alive)}/${row.capacity}`,
      String(row.spawnCount),
      String(row.computeDispatches),
      metric(row.indirectDraws),
      row.cpuUpdateMs.toFixed(3),
    ];
    for (const text of values) {
      const cell = document.createElement('td');
      cell.textContent = text;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.replaceChildren(head, body);
  required<HTMLElement>('#gpu-value').textContent =
    `GPU pass compute ${metric(snapshot.gpu.computeMs)} ms · render ${metric(snapshot.gpu.renderMs)} ms`;
}

async function offscreenReadback(
  renderer: THREE.WebGPURenderer,
  webgpu: boolean,
  fixture: AttributeSnapshot,
  control: AttributeSnapshot,
): Promise<{ foregroundPixels: number; leftEnergy: number; rightEnergy: number }> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020711);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
  camera.position.z = 2;
  for (const [side, snapshot] of [fixture, control].entries()) {
    for (const [index, row] of snapshot.rows.entries()) {
      const height = 0.08 + numeric(row.attributes.lifetime) * 0.025;
      const geometry = new THREE.PlaneGeometry(0.12, height);
      const material = new THREE.MeshBasicMaterial({ color: side === 0 ? 0x35c9ff : 0xff6da8 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((side === 0 ? -0.55 : 0.15) + index * 0.14, -0.65 + height / 2, 0);
      scene.add(mesh);
    }
  }
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const raw = new Uint8Array(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT),
  );
  const pixels = normalizeRgba8Readback(raw, WIDTH, HEIGHT, webgpu);
  let foregroundPixels = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const offset = index * 4;
    const energy = (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
    if (energy > 30) foregroundPixels += 1;
    if (index % WIDTH < WIDTH / 2) leftEnergy += energy;
    else rightEnergy += energy;
  }
  const canvas = required<HTMLCanvasElement>('#readback-canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('M11 debugger 2D readback canvas is unavailable.');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), WIDTH, HEIGHT), 0, 0);
  target.dispose();
  for (const object of scene.children) {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      object.material.dispose();
    }
  }
  return { foregroundPixels, leftEnergy, rightEnergy };
}

async function run(): Promise<void> {
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  const webgpu = backend.isWebGPUBackend === true;
  const activeBackend = webgpu ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) throw new Error(`Backend mismatch: ${activeBackend}.`);
  root.dataset.backend = activeBackend;
  required<HTMLElement>('#backend-value').textContent = activeBackend;
  if (webgpu) {
    root.dataset.artifactScreenshots = JSON.stringify([
      { filename: 'm11-debug.png', selector: '#debug-visual' },
    ]);
  }

  const transformFeedbackLimit = backend.gl?.getParameter(
    backend.gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
  ) as number | undefined;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
    ...(transformFeedbackLimit === undefined
      ? {}
      : { maxTransformFeedbackSeparateAttribs: transformFeedbackLimit }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: webgpu ? ['compute', 'render'] : ['render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm11-debug',
  });
  const system = new VFXSystem(runtime, undefined, { aliveCountReadbackInterval: 1 });
  const fixture = system.spawn(defineEffect({ elements: { particles: fixtureEmitter(2, 0.5) } }), {
    seed: 17,
  });
  const control = system.spawn(defineEffect({ elements: { particles: fixtureEmitter(3, 1.5) } }), {
    seed: 17,
  });
  const profileEmitters = [emitterView(fixture), emitterView(control)];
  // Materialization precedes scheduler accounting; the completed offscreen render below makes the
  // reported records the most recently completed draw frame rather than an inferred static count.
  const profileDraws = webgpu
    ? profileEmitters.map((emitter) => materializeThreeSpriteDraw(emitter.program, emitter.kernels))
    : [];
  let uninitializedDiagnostic = '';
  try {
    await fixture.debug.captureAttributes('particles');
  } catch (error) {
    if (error instanceof VfxDiagnosticError) {
      uninitializedDiagnostic = error.diagnostics[0]?.code ?? '';
    } else {
      throw error;
    }
  }
  await system.update(0);
  const fixtureSnapshot = await fixture.debug.captureAttributes('particles');
  const controlSnapshot = await control.debug.captureAttributes('particles');
  const truncated = await fixture.debug.captureAttributes('particles', {
    attributes: ['lifetime', 'spawnGeneration', 'spawnOrder'],
    limit: 2,
  });
  installSpreadsheet(fixtureSnapshot);
  required<HTMLElement>('#truncation-value').textContent =
    `capture limit ${truncated.truncation.limit}: returned ${truncated.truncation.returned}/${truncated.truncation.totalAlive}, truncated=${truncated.truncation.truncated}`;
  const visual = await offscreenReadback(renderer, webgpu, fixtureSnapshot, controlSnapshot);
  if (webgpu) await renderProfileDrawFrame(renderer, profileDraws);
  await monitor.resolveGpuTimestamps();
  const perf = monitor.publish();
  const profile = await system.debug.captureProfile({ gpuTiming: perf.gpu });
  renderProfile(profile);

  const expectedDispatches = webgpu ? 10 : 2;
  const fixtureByOrder = new Map(
    fixtureSnapshot.rows.map((row) => [row.spawnOrder, numeric(row.attributes.lifetime)]),
  );
  const controlDifference = controlSnapshot.rows.every((row) => {
    const fixtureValue = fixtureByOrder.get(row.spawnOrder);
    return (
      fixtureValue !== undefined && Math.abs(numeric(row.attributes.lifetime) - fixtureValue) > 0.9
    );
  });
  const profileRows = profile.emitters;
  const sizeColumn = fixtureSnapshot.columns.find(({ name }) => name === 'size');
  const validation = {
    attributeAnalyticFixture: analyticRows(fixtureSnapshot, 2, 0.5),
    attributeControlDifference: controlDifference && analyticRows(controlSnapshot, 3, 1.5),
    attributeFullLogicalTable: fixtureSnapshot.rows.every(
      ({ attributes }) => Object.keys(attributes).length === fixtureSnapshot.columns.length,
    ),
    attributeWebglAliasSemantics: webgpu
      ? sizeColumn?.aliased !== true &&
        fixtureSnapshot.diagnostics.every(
          ({ code }) => code !== 'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED',
        )
      : sizeColumn?.aliased === true &&
        fixtureSnapshot.diagnostics.some(
          ({ code, path }) =>
            code === 'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED' && path === 'Particles.size',
        ) &&
        fixtureSnapshot.rows.every((row) => {
          const position = row.attributes.position;
          return Array.isArray(position) && numeric(row.attributes.size) === position[0];
        }),
    consoleClean: consoleMessages.length === 0,
    uninitializedCaptureDiagnostic: uninitializedDiagnostic === 'NACHI_DEBUG_EMITTER_UNINITIALIZED',
    offscreenReadback:
      visual.foregroundPixels > 100 && Math.abs(visual.leftEnergy - visual.rightEnergy) > 500,
    profilerKnownCounts:
      profileRows.length === 2 &&
      profileRows.every(
        (row) =>
          row.alive.value === 4 &&
          row.capacity === 4 &&
          row.spawnCount === 4 &&
          row.computeDispatches === expectedDispatches,
      ),
    profilerDrawSemantics: webgpu
      ? profileRows.every((row) => row.indirectDraws.value === 1)
      : profileRows.every(
          (row) => row.indirectDraws.status === 'unavailable' && row.indirectDraws.value === null,
        ) &&
        profile.gpu.computeMs.status === 'unavailable' &&
        'code' in profile.gpu.computeMs &&
        profile.gpu.computeMs.code === 'NACHI_PROFILE_GPU_TIMESTAMP_WEBGL2_COMPUTE_UNAVAILABLE',
    profilerHostTime: profileRows.every(
      (row) => Number.isFinite(row.cpuUpdateMs) && row.cpuUpdateMs >= 0,
    ),
    truncationExplicit:
      truncated.truncation.truncated &&
      truncated.truncation.returned === 2 &&
      truncated.truncation.totalAlive === 4,
  };
  const result = {
    activeBackend,
    attributes: { control: controlSnapshot, fixture: fixtureSnapshot, truncated },
    ok: Object.values(validation).every(Boolean),
    profile,
    validation,
    visual,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'All checks passed'
    : 'Validation failed';

  let previous: number | undefined;
  let updating = false;
  renderer.setAnimationLoop((timestamp) => {
    monitor.recordFrame(timestamp);
    if (updating) return;
    updating = true;
    const delta = previous === undefined ? 0 : Math.min((timestamp - previous) / 1000, 0.05);
    previous = timestamp;
    void system
      .update(delta)
      .then(() => system.debug.captureProfile({ gpuTiming: monitor.publish().gpu }))
      .then(
        (nextProfile) => {
          renderProfile(nextProfile);
          updating = false;
        },
        () => {
          updating = false;
        },
      );
  });
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false, requestedBackend });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
