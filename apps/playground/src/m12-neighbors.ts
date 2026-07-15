import {
  VFXSystem,
  attribute,
  billboard,
  boids,
  bucketNeighborGridPoints,
  burst,
  defineEffect,
  defineEmitter,
  defineNeighborGrid,
  enumerateNeighborGridCells,
  lifetime,
  neighborGridTslModule,
  neighborGridPositionCell,
  pbdDistanceConstraint,
  positionSphere,
  tslModule,
  type AttributeSnapshot,
  type DebugAttributeValue,
  type NeighborGridDefinition,
  type NeighborGridSnapshot,
  type Vec3,
  type VfxRuntimeRenderer,
} from '@nachi-vfx/core';
import * as THREE from 'three/webgpu';
import { uint, vec3 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi-vfx/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m12-neighbors.css';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
root.dataset.headless = String(headless);
const WEBGL_UNSUPPORTED_CODE = 'NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED';
if (requestedBackend === 'webgl') {
  root.dataset.expectedDiagnostics = JSON.stringify(
    Array.from({ length: 2 }, () => ({
      text: `[${WEBGL_UNSUPPORTED_CODE}]`,
      type: 'error',
    })),
  );
}

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

function logicalCellSets(
  snapshot: NeighborGridSnapshot,
  rows: AttributeSnapshot['rows'],
  grid: NeighborGridDefinition,
): number[][] {
  const logicalByPhysical = new Map(
    rows.map((row) => [row.physicalSlot, row.spawnOrder ?? -1] as const),
  );
  return [...snapshot.counts].map((_count, cell) =>
    [...snapshot.slots.slice(cell * grid.cellCapacity, (cell + 1) * grid.cellCapacity)]
      .filter((slot) => slot !== 0xffff_ffff)
      .map((slot) => logicalByPhysical.get(slot) ?? -1)
      .sort((left, right) => left - right),
  );
}

function cpuCellSets(points: readonly Vec3[], grid: NeighborGridDefinition): number[][] {
  const buckets = bucketNeighborGridPoints(points, grid);
  return [...buckets.counts].map((_count, cell) =>
    [...buckets.slots.slice(cell * grid.cellCapacity, (cell + 1) * grid.cellCapacity)]
      .filter((slot) => slot !== 0xffff_ffff)
      .sort((left, right) => left - right),
  );
}

function logicalNeighborSets(
  snapshot: NeighborGridSnapshot,
  rows: AttributeSnapshot['rows'],
  localPoints: readonly Vec3[],
  grid: NeighborGridDefinition,
): number[][] {
  const logicalByPhysical = new Map(
    rows.map((row) => [row.physicalSlot, row.spawnOrder ?? -1] as const),
  );
  return localPoints.map((point, logical) => {
    const cell = neighborGridPositionCell(point, grid);
    if (!cell) return [];
    return enumerateNeighborGridCells(cell, 1, grid.resolution)
      .flatMap((index) => [
        ...snapshot.slots.slice(index * grid.cellCapacity, (index + 1) * grid.cellCapacity),
      ])
      .filter((slot) => slot !== 0xffff_ffff)
      .map((slot) => logicalByPhysical.get(slot) ?? -1)
      .filter((candidate) => candidate !== logical)
      .sort((left, right) => left - right);
  });
}

function cpuNeighborSets(points: readonly Vec3[], grid: NeighborGridDefinition): number[][] {
  const buckets = bucketNeighborGridPoints(points, grid);
  return points.map((point, logical) => {
    const cell = neighborGridPositionCell(point, grid);
    if (!cell) return [];
    return enumerateNeighborGridCells(cell, 1, grid.resolution)
      .flatMap((index) => [
        ...buckets.slots.slice(index * grid.cellCapacity, (index + 1) * grid.cellCapacity),
      ])
      .filter((candidate) => candidate !== 0xffff_ffff && candidate !== logical)
      .sort((left, right) => left - right);
  });
}

function transformedPoint(
  point: Vec3,
  position: Vec3,
  rotationZ: number,
  offset: Vec3 = [0, 0, 0],
): Vec3 {
  const x = point[0] + offset[0];
  const y = point[1] + offset[1];
  const cosine = Math.cos(rotationZ);
  const sine = Math.sin(rotationZ);
  return [
    position[0] + x * cosine - y * sine,
    position[1] + x * sine + y * cosine,
    position[2] + point[2] + offset[2],
  ];
}

function equalNestedNumbers(left: readonly number[][], right: readonly number[][]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (values, index) =>
        values.length === right[index]?.length &&
        values.every((value, valueIndex) => value === right[index]?.[valueIndex]),
    )
  );
}

function expectedPhysicalNeighborMasks(
  rows: AttributeSnapshot['rows'],
  logicalNeighborSets: readonly number[][],
): number[] {
  const physicalByLogical = new Map(
    rows.map((row) => [row.spawnOrder ?? -1, row.physicalSlot] as const),
  );
  return logicalNeighborSets.map((neighbors) => {
    let mask = 0;
    for (const logical of neighbors) {
      const physical = physicalByLogical.get(logical);
      if (physical === undefined) continue;
      mask = (mask | (1 << physical)) >>> 0;
    }
    return mask;
  });
}

function neighborSnapshotHash(
  snapshot: NeighborGridSnapshot,
  attributes: AttributeSnapshot,
): string {
  let hash = 0x811c_9dc5;
  const mix = (word: number) => {
    hash = Math.imul((hash ^ word) >>> 0, 0x0100_0193) >>> 0;
  };
  for (const word of snapshot.counts) mix(word);
  for (const word of snapshot.slots) mix(word);
  const scalar = new Float32Array(1);
  const bits = new Uint32Array(scalar.buffer);
  const rows = [...attributes.rows].sort(
    (left, right) => (left.spawnOrder ?? 0) - (right.spawnOrder ?? 0),
  );
  for (const row of rows) {
    mix(row.spawnOrder ?? 0xffff_ffff);
    mix(row.physicalSlot);
    const position = row.attributes.position;
    for (const component of Array.isArray(position) ? position.slice(0, 3) : [0, 0, 0]) {
      scalar[0] = component;
      mix(bits[0] ?? 0);
    }
  }
  return hash.toString(16).padStart(8, '0');
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
  if (webgpu) {
    root.dataset.expectedDiagnostics = JSON.stringify([
      { text: '[NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT]', type: 'warning' },
      { text: '[NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED]', type: 'warning' },
    ]);
  }
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
  // Isolate the WebGL2 capability probe from unrelated emitter-storage limitations. The zero-count
  // emitter binds and reads the grid through the public custom-neighbor module, but its empty render
  // module avoids billboard/lifecycle attributes that WebGL2 rejects for separate reasons.
  const webglRejectionEffect = defineEffect({
    elements: {
      neighbors: countGrid,
      particles: defineEmitter({
        capacity: 1,
        integration: 'none',
        render: {
          access: { reads: [], writes: [] },
          config: {},
          kind: 'module',
          stage: 'render',
          type: 'test/runtime-compute-only',
          version: 1,
        },
        spawn: burst({ count: 0 }),
        update: [
          neighborGridTslModule(
            {
              access: { reads: ['Particles.position'], writes: [] },
              grid: 'neighbors',
              radius: 0,
            },
            () => ({}),
          ),
        ],
      }),
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
      const performanceSystem = new VFXSystem(performanceRuntime, undefined, { maxPoolSize: 0 });
      const performanceInstance = performanceWebgpu
        ? performanceSystem.spawn(countEffect)
        : performanceSystem.spawn(webglRejectionEffect);
      const performanceTarget = new THREE.RenderTarget(1, 1);
      try {
        performanceRenderer.setRenderTarget(performanceTarget);
        const performanceScene = new THREE.Scene();
        const performanceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        performanceCamera.updateProjectionMatrix();
        performanceCamera.updateMatrixWorld(true);
        performanceSystem.setCamera({
          projectionMatrix: performanceCamera.projectionMatrix.elements,
          viewMatrix: performanceCamera.matrixWorldInverse.elements,
          viewportSize: [1, 1],
        });
        await performanceMonitor.captureGpuSamples(async () => {
          await performanceSystem.update(1 / 60);
          performanceRenderer.render(performanceScene, performanceCamera);
          await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
        });
        performanceRenderer.setRenderTarget(null);
      } finally {
        performanceInstance.release();
        performanceTarget.dispose();
      }
    } finally {
      performanceRenderer.dispose();
    }
  };
  // Keep the default delivery path on both backends. The runner narrowly consumes only the two
  // known WebGL2 rejection diagnostics (correctness + performance systems); every other build
  // diagnostic remains an unexpected console failure.
  const countSystem = new VFXSystem(runtime);
  const countCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  countCamera.updateProjectionMatrix();
  countCamera.updateMatrixWorld(true);
  const testCamera = {
    projectionMatrix: countCamera.projectionMatrix.elements,
    viewMatrix: countCamera.matrixWorldInverse.elements,
    viewportSize: [1, 1],
  } as const;
  const configureTestCamera = (system: Pick<typeof countSystem, 'setCamera'>): void => {
    system.setCamera(testCamera);
  };
  configureTestCamera(countSystem);
  const countInstance = webgpu
    ? countSystem.spawn(countEffect)
    : countSystem.spawn(webglRejectionEffect);
  await countSystem.update(0);
  await countSystem.update(1 / 60);

  if (!webgpu) {
    const codes = countInstance.diagnostics.map(({ code }) => code);
    await capturePerformance();
    const expectedMessages = messages.filter((message) =>
      message.includes(`[${WEBGL_UNSUPPORTED_CODE}]`),
    );
    const unexpectedMessages = messages.filter(
      (message) => !message.includes(`[${WEBGL_UNSUPPORTED_CODE}]`),
    );
    const validation = {
      consoleClean: expectedMessages.length === 2 && unexpectedMessages.length === 0,
      webgl2ExplicitlyRejected: codes.includes(WEBGL_UNSUPPORTED_CODE),
    };
    const result = {
      backend: 'WebGL2',
      checks: { diagnostics: codes, expectedMessages, unexpectedMessages },
      ok: Object.values(validation).every(Boolean),
      validation,
    };
    countInstance.release();
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

  const emitterSpaceGrid = defineNeighborGrid({
    cellCapacity: 32,
    cellSize: 1,
    origin: [-2, -2, -2],
    resolution: [4, 4, 4],
  });
  const emitterSpaceEffect = (offset?: Vec3) =>
    defineEffect({
      elements: {
        neighbors: emitterSpaceGrid,
        particles: defineEmitter({
          attributes: {
            neighborMask: attribute('neighborMask', { default: 0, type: 'u32' }),
          },
          capacity: 32,
          ...(offset === undefined ? {} : { offset }),
          init: [positionSphere({ radius: 1 }), lifetime(100)],
          integration: 'none',
          lifecycle: { duration: 100 },
          render: billboard({}),
          spawn: burst({ count: 32 }),
          update: [
            boids({
              alignment: 0,
              cohesion: 0,
              grid: 'neighbors',
              radius: 1,
              separation: 0,
            }),
            neighborGridTslModule(
              {
                access: {
                  reads: ['Particles.position'],
                  writes: ['Particles.neighborMask'],
                },
                grid: 'neighbors',
                radius: 1,
              },
              (context) => {
                const mask = uint(0).toVar();
                context.forEachNeighbor((neighbor) => {
                  mask.assign(mask.bitOr(uint(1).shiftLeft(neighbor.index as never)));
                });
                return { neighborMask: mask as never };
              },
            ),
          ],
        }),
      },
    });
  const runEmitterSpaceCase = async (options: {
    readonly liveSetTransform?: boolean;
    readonly offset?: Vec3;
    readonly position: Vec3;
    readonly rotationZ: number;
  }) => {
    const system = new VFXSystem(runtime, undefined, {
      maxPoolSize: 0,
      onRuntimeDiagnostic: null,
    });
    const instance = system.spawn(emitterSpaceEffect(options.offset), {
      position: options.liveSetTransform ? [0, 0, 0] : options.position,
      rotation: options.liveSetTransform ? [0, 0, 0] : [0, 0, options.rotationZ],
      seed: 0x513,
    });
    if (options.liveSetTransform) {
      // Exercise the live uniform update before the first spawn. Existing particle positions are
      // world-space and are deliberately not claimed to relocate after a later transform change.
      instance.setTransform(options.position, [0, 0, options.rotationZ]);
    }
    await system.update(0);
    await system.update(1 / 60);
    const snapshot = await instance.getNeighborGrid('neighbors')!.capture();
    const attributes = await instance.debug.captureAttributes('particles', {
      attributes: ['position', 'velocity', 'neighborMask'],
    });
    const rows = [...attributes.rows].sort(
      (left, right) => (left.spawnOrder ?? 0) - (right.spawnOrder ?? 0),
    );
    instance.release();
    return {
      attributes,
      cellSets: logicalCellSets(snapshot, rows, emitterSpaceGrid),
      counts: [...snapshot.counts],
      outOfBounds: snapshot.outOfBounds,
      points: vectors(attributes, 'position'),
      rows,
      snapshot,
      visitorMasks: rows.map((row) => Number(row.attributes.neighborMask) >>> 0),
    };
  };
  const identitySpace = await runEmitterSpaceCase({
    position: [0, 0, 0],
    rotationZ: 0,
  });
  const identityRepeat = await runEmitterSpaceCase({
    position: [0, 0, 0],
    rotationZ: 0,
  });
  const movedPosition: Vec3 = [8, 5, 0];
  const movedRotation = Math.PI / 2;
  const movedSpace = await runEmitterSpaceCase({
    position: movedPosition,
    rotationZ: movedRotation,
  });
  const emitterOffset: Vec3 = [2, -1, 0];
  const offsetSpace = await runEmitterSpaceCase({
    offset: emitterOffset,
    position: movedPosition,
    rotationZ: movedRotation,
  });
  const liveTransformSpace = await runEmitterSpaceCase({
    liveSetTransform: true,
    position: movedPosition,
    rotationZ: movedRotation,
  });
  const identityLocalPoints = identitySpace.points;
  const expectedBuckets = bucketNeighborGridPoints(identityLocalPoints, emitterSpaceGrid);
  const expectedCellSets = cpuCellSets(identityLocalPoints, emitterSpaceGrid);
  const expectedNeighborSets = cpuNeighborSets(identityLocalPoints, emitterSpaceGrid);
  const validateEmitterSpaceCase = (
    value: typeof identitySpace,
    position: Vec3,
    rotationZ: number,
    offset?: Vec3,
  ) => {
    const expectedWorld = identityLocalPoints.map((point) =>
      transformedPoint(point, position, rotationZ, offset),
    );
    const worldPositionsMatch = value.points.every((point, index) =>
      point.every((component, axis) => Math.abs(component - expectedWorld[index]![axis]!) < 2e-5),
    );
    const localNeighborSets = logicalNeighborSets(
      value.snapshot,
      value.rows,
      identityLocalPoints,
      emitterSpaceGrid,
    );
    const expectedVisitorMasks = expectedPhysicalNeighborMasks(value.rows, expectedNeighborSets);
    return {
      cellSetsMatch: equalNestedNumbers(value.cellSets, expectedCellSets),
      countsMatch: value.counts.every((count, index) => count === expectedBuckets.counts[index]),
      bucketNeighborSetsMatch: equalNestedNumbers(localNeighborSets, expectedNeighborSets),
      noOutOfBounds: value.outOfBounds === 0,
      visitorMasksMatch: value.visitorMasks.every(
        (mask, index) => mask === expectedVisitorMasks[index],
      ),
      worldPositionsMatch,
    };
  };
  const emitterSpaceChecks = {
    identity: validateEmitterSpaceCase(identitySpace, [0, 0, 0], 0),
    identityBitStable:
      identitySpace.points.length === identityRepeat.points.length &&
      identitySpace.points.every((point, index) =>
        point.every((component, axis) => Object.is(component, identityRepeat.points[index]![axis])),
      ),
    liveSetTransformBeforeFirstSpawn: validateEmitterSpaceCase(
      liveTransformSpace,
      movedPosition,
      movedRotation,
    ),
    moved: validateEmitterSpaceCase(movedSpace, movedPosition, movedRotation),
    offset: validateEmitterSpaceCase(offsetSpace, movedPosition, movedRotation, emitterOffset),
  };
  const identitySnapshotHash = neighborSnapshotHash(
    identitySpace.snapshot,
    identitySpace.attributes,
  );

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
  configureTestCamera(flockSystem);
  const flockInstance = flockSystem.spawn(flockEffect);
  await flockSystem.update(0);
  const flockInitial = dispersion(vectors(await capture(flockInstance), 'position'));
  const controlSystem = new VFXSystem(runtime);
  configureTestCamera(controlSystem);
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
  configureTestCamera(pbdSystem);
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
  configureTestCamera(denseSystem);
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

  const dominantGrid = defineNeighborGrid({
    cellCapacity: 1,
    cellSize: 1,
    origin: [-0.8, -1, -1],
    resolution: [1, 2, 2],
  });
  const dominantEffect = defineEffect({
    elements: {
      neighbors: dominantGrid,
      particles: fixtureEmitter(8, layout(8, 1, 0.5), [
        boids({ alignment: 0, cohesion: 0, grid: 'neighbors', radius: 0, separation: 0 }),
      ]),
    },
  });
  const dominantSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  configureTestCamera(dominantSystem);
  const dominantInstance = dominantSystem.spawn(dominantEffect);
  await dominantSystem.update(0);
  await dominantSystem.update(1 / 60);
  const dominantView = dominantInstance.getNeighborGrid('neighbors')!;
  const dominantFirst = await dominantView.capture();
  const dominantRepeat = await dominantView.capture();
  await dominantSystem.update(1 / 60);
  const dominantNextFrame = await dominantView.capture();
  const dominantCodes = dominantInstance.diagnostics.map(({ code }) => code);

  const exactHalfGrid = defineNeighborGrid({
    cellCapacity: 8,
    cellSize: 1,
    origin: [-1, -1, -1],
    resolution: [2, 2, 2],
  });
  const exactHalfSystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: null,
  });
  configureTestCamera(exactHalfSystem);
  const exactHalfInstance = exactHalfSystem.spawn(
    defineEffect({
      elements: {
        neighbors: exactHalfGrid,
        particles: fixtureEmitter(4, layout(4, 1, 1), [
          boids({ alignment: 0, cohesion: 0, grid: 'neighbors', radius: 0, separation: 0 }),
        ]),
      },
    }),
  );
  await exactHalfSystem.update(0);
  await exactHalfSystem.update(1 / 60);
  const exactHalfSnapshot = await exactHalfInstance.getNeighborGrid('neighbors')!.capture();

  const emptySystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: null,
  });
  configureTestCamera(emptySystem);
  const emptyInstance = emptySystem.spawn(
    defineEffect({
      elements: {
        neighbors: exactHalfGrid,
        particles: defineEmitter({
          capacity: 1,
          integration: 'none',
          render: billboard({}),
          spawn: burst({ count: 0 }),
          update: [
            boids({
              alignment: 0,
              cohesion: 0,
              grid: 'neighbors',
              radius: 0,
              separation: 0,
            }),
          ],
        }),
      },
    }),
  );
  await emptySystem.update(0);
  await emptySystem.update(1 / 60);
  const emptySnapshot = await emptyInstance.getNeighborGrid('neighbors')!.capture();

  const pooledDiagnosticSystem = new VFXSystem(runtime, undefined, {
    onRuntimeDiagnostic: null,
  });
  configureTestCamera(pooledDiagnosticSystem);
  const firstPooledDiagnostic = pooledDiagnosticSystem.spawn(dominantEffect);
  await pooledDiagnosticSystem.update(0);
  await pooledDiagnosticSystem.update(1 / 60);
  await firstPooledDiagnostic.getNeighborGrid('neighbors')!.capture();
  const firstPooledDiagnosticCount = firstPooledDiagnostic.diagnostics.filter(
    ({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
  ).length;
  firstPooledDiagnostic.release();
  const secondPooledDiagnostic = pooledDiagnosticSystem.spawn(dominantEffect);
  await pooledDiagnosticSystem.update(1 / 60);
  await secondPooledDiagnostic.getNeighborGrid('neighbors')!.capture();
  const secondPooledDiagnosticCount = secondPooledDiagnostic.diagnostics.filter(
    ({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
  ).length;

  let throwingHandlerCalls = 0;
  const throwingDiagnosticSystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: () => {
      throwingHandlerCalls += 1;
      throw new Error('intentional m12 runtime diagnostic handler failure');
    },
  });
  configureTestCamera(throwingDiagnosticSystem);
  const throwingDiagnosticInstance = throwingDiagnosticSystem.spawn(dominantEffect);
  await throwingDiagnosticSystem.update(0);
  await throwingDiagnosticSystem.update(1 / 60);
  const throwingCapture = await throwingDiagnosticInstance.getNeighborGrid('neighbors')!.capture();
  await throwingDiagnosticSystem.update(1 / 60);
  await throwingDiagnosticInstance.getNeighborGrid('neighbors')!.capture();
  const throwingCodes = throwingDiagnosticInstance.diagnostics.map(({ code }) => code);

  dominantInstance.release();
  exactHalfInstance.release();
  emptyInstance.release();
  secondPooledDiagnostic.release();
  throwingDiagnosticInstance.release();

  draw(flockPoints, pbdPoints);
  await capturePerformance();
  const countView = countInstance.getNeighborGrid('neighbors')!;
  const expectedRuntimeDiagnosticCodes = [
    'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
    'NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED',
  ];
  const expectedRuntimeMessages = messages.filter((message) =>
    expectedRuntimeDiagnosticCodes.some((code) => message.includes(`[${code}]`)),
  );
  const unexpectedMessages = messages.filter((message) =>
    expectedRuntimeDiagnosticCodes.every((code) => !message.includes(`[${code}]`)),
  );
  const allEmitterSpaceChecks = [
    emitterSpaceChecks.identity,
    emitterSpaceChecks.liveSetTransformBeforeFirstSpawn,
    emitterSpaceChecks.moved,
    emitterSpaceChecks.offset,
  ].every((checks) => Object.values(checks).every(Boolean));
  const validation = {
    analyticNeighborCounts:
      vectors(countAttributes, 'position').every((point, index) =>
        point.every((component, axis) => Math.abs(component - known[index]![axis]!) < 1e-6),
      ) &&
      gpuNeighborCounts.every((value, index) => value === cpuNeighborCounts[index]) &&
      [...countSnapshot.counts].every((value, index) => value === cpuBuckets.counts[index]),
    boidsCohesion: flockFinal < flockInitial * 0.9 && flockFinal < controlFinal * 0.9,
    consoleExpectedExactlyOnce:
      expectedRuntimeMessages.length === 2 && unexpectedMessages.length === 0,
    dominantOutOfBoundsDiagnostic:
      dominantFirst.outOfBounds === 6 &&
      dominantFirst.dropped === 1 &&
      dominantFirst.diagnostics.map(({ code }) => code).join(',') ===
        'NACHI_NEIGHBOR_GRID_CELL_OVERFLOW,NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT' &&
      dominantFirst.diagnostics.some(
        ({ code, path }) =>
          code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT' &&
          path === 'elements.neighbors.origin',
      ) &&
      dominantRepeat.diagnostics.some(
        ({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      ) &&
      dominantNextFrame.diagnostics.some(
        ({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      ) &&
      dominantCodes.filter((code) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT')
        .length === 1,
    emitterLocalGrid: allEmitterSpaceChecks && emitterSpaceChecks.identityBitStable,
    exactHalfAndZeroAreQuiet:
      exactHalfSnapshot.outOfBounds === 2 &&
      exactHalfSnapshot.diagnostics.length === 0 &&
      emptySnapshot.outOfBounds === 0 &&
      emptySnapshot.diagnostics.length === 0,
    overflowDropsAndContinues:
      denseSnapshot.dropped > 0 &&
      denseSnapshot.diagnostics.some(({ code }) => code === 'NACHI_NEIGHBOR_GRID_CELL_OVERFLOW') &&
      denseInstance.state === 'active',
    pbdOverlapResolved: pbdInitial < 0.15 && pbdFinal >= 0.295,
    pooledRuntimeRearmer: firstPooledDiagnosticCount === 1 && secondPooledDiagnosticCount === 1,
    rebuildEveryFrame: countView.submissionCount >= 2 && denseView.submissionCount >= 2,
    throwingRuntimeHandlerContained:
      throwingCapture.outOfBounds === 6 &&
      throwingHandlerCalls === 1 &&
      throwingCodes.join(',') ===
        'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT,NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED',
  };
  const result = {
    backend: 'WebGPU',
    checks: {
      boids: { controlFinal, final: flockFinal, initial: flockInitial },
      neighborCounts: { cpu: cpuNeighborCounts, gpu: gpuNeighborCounts },
      emitterSpace: emitterSpaceChecks,
      identitySnapshotHash,
      expectedRuntimeMessages,
      unexpectedMessages,
      outOfBoundsDiagnostics: {
        dominant: {
          codes: dominantCodes,
          dropped: dominantFirst.dropped,
          outOfBounds: dominantFirst.outOfBounds,
        },
        empty: emptySnapshot.outOfBounds,
        exactHalf: exactHalfSnapshot.outOfBounds,
        pool: [firstPooledDiagnosticCount, secondPooledDiagnosticCount],
        throwing: { calls: throwingHandlerCalls, codes: throwingCodes },
      },
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
  countInstance.release();
  flockInstance.release();
  controlInstance.release();
  pbdInstance.release();
  denseInstance.release();
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
