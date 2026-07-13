import {
  VFXSystem,
  billboard,
  boids,
  bucketNeighborGridPoints,
  burst,
  defineEffect,
  defineEmitter,
  defineNeighborGrid,
  enumerateNeighborGridCells,
  lifetime,
  neighborGridPositionCell,
  pbdDistanceConstraint,
  tslModule,
  type AttributeSnapshot,
  type DebugAttributeValue,
  type Vec3,
  type VfxRuntimeRenderer,
} from '@nachi/core';
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m12-neighbors.css';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
root.dataset.headless = String(headless);

const messages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  messages.push(values.map(String).join(' '));
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  messages.push(values.map(String).join(' '));
  originalError(...values);
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M12 neighbor UI element ${selector}.`);
  return value;
}

function layout(countX: number, countY: number, spacing: number, z = 0) {
  return tslModule(
    ({ spawnOrder }) => {
      const row = spawnOrder.div(countX);
      const column = spawnOrder.sub(row.mul(countX));
      return {
        position: vec3(
          column
            .toFloat()
            .sub((countX - 1) * 0.5)
            .mul(spacing) as never,
          row
            .toFloat()
            .sub((countY - 1) * 0.5)
            .mul(spacing) as never,
          z,
        ) as never,
        velocity: vec3(0, 0, 0) as never,
      };
    },
    { stage: 'init' },
  );
}

function fixtureEmitter(
  count: number,
  init: ReturnType<typeof layout>,
  update: readonly ReturnType<typeof boids>[],
  integration: 'euler' | 'none' = 'none',
) {
  return defineEmitter({
    capacity: count,
    init: [init, lifetime(100)],
    integration,
    lifecycle: { duration: 100 },
    render: billboard({ blending: 'additive' }),
    spawn: burst({ count }),
    update,
  });
}

function vectors(snapshot: AttributeSnapshot, name: 'position' | 'velocity'): Vec3[] {
  return [...snapshot.rows]
    .sort((left, right) => (left.spawnOrder ?? 0) - (right.spawnOrder ?? 0))
    .map((row) => row.attributes[name] as DebugAttributeValue)
    .map(
      (value) =>
        (Array.isArray(value) ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0] : [0, 0, 0]) as Vec3,
    );
}

function dispersion(points: readonly Vec3[]): number {
  const center = points
    .reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]] as Vec3, [
      0, 0, 0,
    ] as Vec3)
    .map((value) => value / points.length) as unknown as Vec3;
  return Math.sqrt(
    points.reduce(
      (sum, point) =>
        sum +
        (point[0] - center[0]) ** 2 +
        (point[1] - center[1]) ** 2 +
        (point[2] - center[2]) ** 2,
      0,
    ) / points.length,
  );
}

function minimumDistance(points: readonly Vec3[]): number {
  let minimum = Infinity;
  for (let left = 0; left < points.length; left += 1)
    for (let right = left + 1; right < points.length; right += 1)
      minimum = Math.min(
        minimum,
        Math.hypot(
          points[left]![0] - points[right]![0],
          points[left]![1] - points[right]![1],
          points[left]![2] - points[right]![2],
        ),
      );
  return minimum;
}

async function capture(instance: {
  debug: {
    captureAttributes(
      id: string,
      options?: { attributes?: readonly string[] },
    ): Promise<AttributeSnapshot>;
  };
}) {
  return instance.debug.captureAttributes('particles', { attributes: ['position', 'velocity'] });
}

function draw(points: readonly Vec3[], pbd: readonly Vec3[]) {
  const canvas = required<HTMLCanvasElement>('#neighbor-visual');
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(256, 190, 10, 256, 190, 310);
  gradient.addColorStop(0, '#153d6c');
  gradient.addColorStop(1, '#030711');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#183452';
  context.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 32) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  for (const [index, point] of points.entries()) {
    const x = 256 + point[0] * 78;
    const y = 190 - point[1] * 78;
    context.fillStyle = index % 3 === 0 ? '#ffce73' : '#66e6ff';
    context.beginPath();
    context.arc(x, y, 3.2, 0, Math.PI * 2);
    context.fill();
  }
  if (pbd.length === 2) {
    const left = 256 + pbd[0]![0] * 180;
    const right = 256 + pbd[1]![0] * 180;
    context.strokeStyle = '#ff6f91';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(left, 340);
    context.lineTo(right, 340);
    context.stroke();
    for (const x of [left, right]) {
      context.fillStyle = '#fff0f4';
      context.beginPath();
      context.arc(x, 340, 7, 0, Math.PI * 2);
      context.fill();
    }
  }
}

async function run() {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: false,
  });
  renderer.setSize(1, 1);
  await renderer.init();
  const backend = renderer.backend as {
    readonly device?: {
      readonly features?: { has(name: string): boolean };
      readonly limits?: { readonly maxStorageBuffersPerShaderStage?: number };
      readonly lost?: Promise<{ message?: string; reason?: string }>;
    };
    readonly isWebGPUBackend?: boolean;
  };
  const webgpu = backend.isWebGPUBackend === true;
  root.dataset.backend = webgpu ? 'WebGPU' : 'WebGL2';
  required<HTMLElement>('#backend-value').textContent = root.dataset.backend;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const base = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  let submissions = 0;
  const runtime: VfxRuntimeRenderer = {
    ...base,
    submitCompute(kernel) {
      submissions += 1;
      return base.submitCompute(kernel);
    },
  };

  const countGrid = defineNeighborGrid({
    cellCapacity: 16,
    cellSize: 1,
    origin: [-2, -2, -2],
    resolution: [4, 4, 4],
  });
  const countEffect = defineEffect({
    elements: {
      neighbors: countGrid,
      particles: fixtureEmitter(32, layout(8, 4, 0.4), [
        boids({ alignment: 0, cohesion: 0, grid: 'neighbors', radius: 1, separation: 0 }),
      ]),
    },
  });
  // Keep timestamp queries off the correctness renderer and confine them to this short fixture
  // after every validation readback has completed.
  const capturePerformance = async (): Promise<void> => {
    const performanceRenderer = await createPlaygroundRenderer({
      antialias: false,
      forceWebGL: requestedBackend === 'webgl',
      trackTimestamp: true,
    });
    performanceRenderer.setSize(1, 1);
    try {
      await performanceRenderer.init();
      const performanceBackend = performanceRenderer.backend as typeof backend;
      const performanceWebgpu = performanceBackend.isWebGPUBackend === true;
      const performanceAdapter = createThreeKernelAdapter({
        backend: performanceWebgpu ? 'webgpu' : 'webgl2',
        ...(performanceBackend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
          ? {}
          : {
              maxStorageBuffersPerShaderStage:
                performanceBackend.device.limits.maxStorageBuffersPerShaderStage,
            }),
      });
      const performanceRuntime = createThreeRuntimeRenderer(
        performanceRenderer,
        performanceAdapter,
        performanceBackend.device?.lost,
      );
      const performanceMonitor = createPerformanceMonitor(performanceRenderer, {
        gpuScopes: performanceWebgpu ? ['compute'] : ['render'],
        mode: headless ? 'headless' : 'visual',
        page: '/m12-neighbors/',
      });
      const performanceSystem = new VFXSystem(performanceRuntime, undefined, {
        onBuildDiagnostic: null,
      });
      performanceSystem.spawn(countEffect);
      await performanceSystem.update(0);
      await performanceSystem.update(1 / 60);
      const performanceTarget = new THREE.RenderTarget(1, 1);
      try {
        performanceRenderer.setRenderTarget(performanceTarget);
        performanceRenderer.render(
          new THREE.Scene(),
          new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10),
        );
        await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
        performanceRenderer.setRenderTarget(null);
      } finally {
        performanceTarget.dispose();
      }
      await performanceMonitor.resolveGpuTimestamps();
      performanceMonitor.publish();
    } finally {
      performanceRenderer.dispose();
    }
  };
  const countSystem = new VFXSystem(runtime, undefined, { onBuildDiagnostic: null });
  const countInstance = countSystem.spawn(countEffect);
  await countSystem.update(0);
  await countSystem.update(1 / 60);

  if (!webgpu) {
    const codes = countInstance.diagnostics.map(({ code }) => code);
    await capturePerformance();
    const validation = {
      consoleClean: messages.length === 0,
      webgl2ExplicitlyRejected: codes.includes('NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED'),
    };
    const result = {
      backend: 'WebGL2',
      checks: { diagnostics: codes },
      ok: Object.values(validation).every(Boolean),
      validation,
    };
    renderer.dispose();
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = result.ok
      ? 'Explicit rejection passed'
      : 'Validation failed';
    return;
  }

  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm12-neighbors.png', selector: '#neighbor-visual' },
  ]);

  const countSnapshot = await countInstance.getNeighborGrid('neighbors')!.capture();
  const countAttributes = await capture(countInstance);
  const countRows = [...countAttributes.rows].sort(
    (left, right) => (left.spawnOrder ?? 0) - (right.spawnOrder ?? 0),
  );
  const known = Array.from(
    { length: 32 },
    (_, index) => [((index % 8) - 3.5) * 0.4, (Math.floor(index / 8) - 1.5) * 0.4, 0] as Vec3,
  );
  const cpuBuckets = bucketNeighborGridPoints(known, countGrid);
  const gpuNeighborCounts = known.map((point, particle) => {
    const cell = neighborGridPositionCell(point, countGrid)!;
    const physicalSlot = countRows[particle]!.physicalSlot;
    return enumerateNeighborGridCells(cell, 1, countGrid.resolution)
      .flatMap((index) => [
        ...countSnapshot.slots.slice(
          index * countGrid.cellCapacity,
          (index + 1) * countGrid.cellCapacity,
        ),
      ])
      .filter((candidate) => candidate !== 0xffff_ffff && candidate !== physicalSlot).length;
  });
  const cpuNeighborCounts = known.map((point, particle) => {
    const cell = neighborGridPositionCell(point, countGrid)!;
    return enumerateNeighborGridCells(cell, 1, countGrid.resolution)
      .flatMap((index) => [
        ...cpuBuckets.slots.slice(
          index * countGrid.cellCapacity,
          (index + 1) * countGrid.cellCapacity,
        ),
      ])
      .filter((candidate) => candidate !== 0xffff_ffff && candidate !== particle).length;
  });

  const flockGrid = defineNeighborGrid({
    cellCapacity: 24,
    cellSize: 0.75,
    origin: [-4, -4, -2],
    resolution: [10, 10, 4],
  });
  const flockEmitter = (enabled: boolean) =>
    fixtureEmitter(
      64,
      layout(8, 8, 0.42),
      enabled
        ? [
            boids({
              alignment: 0.35,
              cohesion: 1.8,
              grid: 'neighbors',
              maxAcceleration: 8,
              radius: 1,
              separation: 0.25,
              separationRadius: 0.3,
            }),
          ]
        : [],
      'euler',
    );
  const flockEffect = defineEffect({
    elements: { neighbors: flockGrid, particles: flockEmitter(true) },
  });
  const controlEffect = defineEffect({ elements: { particles: flockEmitter(false) } });
  const flockSystem = new VFXSystem(runtime);
  const flockInstance = flockSystem.spawn(flockEffect);
  await flockSystem.update(0);
  const flockInitial = dispersion(vectors(await capture(flockInstance), 'position'));
  const controlSystem = new VFXSystem(runtime);
  const controlInstance = controlSystem.spawn(controlEffect);
  await controlSystem.update(0);
  for (let frame = 0; frame < 100; frame += 1) {
    await flockSystem.update(1 / 60);
    await controlSystem.update(1 / 60);
  }
  const flockPoints = vectors(await capture(flockInstance), 'position');
  const controlPoints = vectors(await capture(controlInstance), 'position');
  const flockFinal = dispersion(flockPoints);
  const controlFinal = dispersion(controlPoints);

  const pbdGrid = defineNeighborGrid({
    cellCapacity: 8,
    cellSize: 1,
    origin: [-2, -2, -2],
    resolution: [4, 4, 4],
  });
  const pbdEmitter = defineEmitter({
    capacity: 2,
    init: [layout(2, 1, 0.1), lifetime(100)],
    integration: 'none',
    lifecycle: { duration: 100 },
    render: billboard({}),
    spawn: burst({ count: 2 }),
    update: [
      pbdDistanceConstraint({ distance: 0.3, grid: 'neighbors', iterations: 4, stiffness: 1 }),
    ],
  });
  const pbdSystem = new VFXSystem(runtime);
  const pbdInstance = pbdSystem.spawn(
    defineEffect({ elements: { neighbors: pbdGrid, particles: pbdEmitter } }),
  );
  await pbdSystem.update(0);
  const pbdInitial = minimumDistance(vectors(await capture(pbdInstance), 'position'));
  await pbdSystem.update(1 / 60);
  const pbdPoints = vectors(await capture(pbdInstance), 'position');
  const pbdFinal = minimumDistance(pbdPoints);

  const denseGrid = defineNeighborGrid({
    cellCapacity: 4,
    cellSize: 2,
    origin: [-1, -1, -1],
    resolution: [2, 2, 2],
  });
  const denseSystem = new VFXSystem(runtime);
  const denseInstance = denseSystem.spawn(
    defineEffect({
      elements: {
        neighbors: denseGrid,
        particles: fixtureEmitter(32, layout(32, 1, 0), [
          boids({ alignment: 0, cohesion: 0, grid: 'neighbors', radius: 0, separation: 0 }),
        ]),
      },
    }),
  );
  await denseSystem.update(0);
  await denseSystem.update(1 / 60);
  const denseView = denseInstance.getNeighborGrid('neighbors')!;
  const denseSnapshot = await denseView.capture();

  draw(flockPoints, pbdPoints);
  await capturePerformance();
  const countView = countInstance.getNeighborGrid('neighbors')!;
  const validation = {
    analyticNeighborCounts:
      vectors(countAttributes, 'position').every((point, index) =>
        point.every((component, axis) => Math.abs(component - known[index]![axis]!) < 1e-6),
      ) &&
      gpuNeighborCounts.every((value, index) => value === cpuNeighborCounts[index]) &&
      [...countSnapshot.counts].every((value, index) => value === cpuBuckets.counts[index]),
    boidsCohesion: flockFinal < flockInitial * 0.9 && flockFinal < controlFinal * 0.9,
    consoleClean: messages.length === 0,
    overflowDropsAndContinues:
      denseSnapshot.dropped > 0 &&
      denseSnapshot.diagnostics.some(({ code }) => code === 'NACHI_NEIGHBOR_GRID_CELL_OVERFLOW') &&
      denseInstance.state === 'active',
    pbdOverlapResolved: pbdInitial < 0.15 && pbdFinal >= 0.295,
    rebuildEveryFrame: countView.submissionCount >= 2 && denseView.submissionCount >= 2,
  };
  const result = {
    backend: 'WebGPU',
    checks: {
      boids: { controlFinal, final: flockFinal, initial: flockInitial },
      neighborCounts: { cpu: cpuNeighborCounts, gpu: gpuNeighborCounts },
      overflow: denseSnapshot.dropped,
      pbd: { final: pbdFinal, initial: pbdInitial },
      submissions: {
        all: submissions,
        count: countView.submissionCount,
        dense: denseView.submissionCount,
      },
    },
    ok: Object.values(validation).every(Boolean),
    validation,
  };
  renderer.dispose();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = 'complete';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'All checks passed'
    : 'Validation failed';
  required<HTMLElement>('#submission-value').textContent = String(submissions);
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false, requestedBackend });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
