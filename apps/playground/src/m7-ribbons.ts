import {
  VFXSystem,
  colorOverLife,
  createCoreKernelModuleRegistry,
  defineEffect,
  defineEmitter,
  gradient,
  lifetime,
  positionSphere,
  rate,
  type UpdateModule,
  type Vec3,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi/trails';
import {
  materializeThreeRibbonDraw,
  readRibbonSegments,
  type ThreeRibbonDraw,
} from '@nachi/trails/three';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m7-ribbons.css';

const STEP = 1 / 60;
const WIDTH = 256;
const HEIGHT = 160;
const CAPACITY = 16;
const RIBBON_WIDTH = 0.28;
const TILE_LENGTH = 0.5;

type BackendLike = {
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  setTransform(position: Vec3): void;
};

type CaseResult = {
  readonly alive: Uint32Array;
  readonly draw: ThreeRibbonDraw;
  readonly indices: Uint32Array;
  readonly position: Float32Array;
  readonly ribbonId: Uint32Array;
  readonly segmentCount: number;
  readonly spawnOrder: Uint32Array;
  readonly uvAndParametric: Float32Array;
  readonly widths: Float32Array;
};

const root = document.documentElement;
const headless = new URLSearchParams(location.search).get('headless') === '1';
const sceneHost = requireElement<HTMLDivElement>('#scene');
const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const consoleMessages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(`warning: ${values.map(String).join(' ')}`);
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(`error: ${values.map(String).join(' ')}`);
  originalError(...values);
};

root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M7 ribbons UI element: ${selector}`);
  return element;
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}

function close(left: number, right: number, tolerance = 1e-5): boolean {
  return Math.abs(left - right) <= tolerance;
}

function killSpawnOrder(order: number): UpdateModule {
  return {
    access: { reads: ['Particles.alive', 'Particles.spawnOrder'], writes: ['Particles.alive'] },
    config: { order },
    kind: 'module',
    stage: 'update',
    type: 'smoke/kill-spawn-order',
    version: 1,
  };
}

function expectedSegments(result: CaseResult): Array<readonly [number, number, number]> {
  const groups = new Map<number, number[]>();
  for (let physical = 0; physical < CAPACITY; physical += 1) {
    if ((result.alive[physical] ?? 0) === 0) continue;
    const id = result.ribbonId[physical] ?? 0;
    const values = groups.get(id) ?? [];
    values.push(physical);
    groups.set(id, values);
  }
  const expected: Array<readonly [number, number, number]> = [];
  for (const [id, physicalIndices] of [...groups].sort(([a], [b]) => a - b)) {
    physicalIndices.sort((a, b) => (result.spawnOrder[a] ?? 0) - (result.spawnOrder[b] ?? 0));
    for (let index = 1; index < physicalIndices.length; index += 1) {
      expected.push([physicalIndices[index - 1]!, physicalIndices[index]!, id]);
    }
  }
  return expected;
}

function actualSegments(result: CaseResult): Array<readonly [number, number, number]> {
  return Array.from(
    { length: result.segmentCount },
    (_, segment) =>
      [
        result.indices[segment * 4] ?? 0,
        result.indices[segment * 4 + 1] ?? 0,
        result.indices[segment * 4 + 2] ?? 0,
      ] as const,
  );
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) {
    throw new Error('NACHI_RIBBON_WEBGL2_UNSUPPORTED: /m7-ribbons/ requires the WebGPU backend.');
  }
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Offscreen RT readback' : 'GPU trail diagnostics';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const registry = registerTrails(createCoreKernelModuleRegistry());
  registry.register({
    access: { reads: ['Particles.alive', 'Particles.spawnOrder'], writes: ['Particles.alive'] },
    build(context) {
      const { order } = context.module.config as { order: number };
      context.adapter.branch(
        context.attribute('spawnOrder').equal(context.adapter.uint(order)),
        () => context.write('alive', context.adapter.constant(false, 'bool')),
      );
    },
    stage: 'update',
    type: 'smoke/kill-spawn-order',
    version: 1,
  });
  const adapter = createThreeKernelAdapter({
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const textureRef = {
    assetType: 'texture',
    kind: 'asset-ref',
    uri: 'm7-ribbon-gradient',
  } as const;
  const textureData = new Uint8Array([
    255, 255, 255, 0, 180, 230, 255, 180, 120, 120, 255, 255, 255, 120, 240, 180, 255, 255, 255, 0,
    180, 230, 255, 180, 120, 120, 255, 255, 255, 120, 240, 180,
  ]);
  const trailTexture = new THREE.DataTexture(textureData, 4, 2, THREE.RGBAFormat);
  trailTexture.wrapS = THREE.RepeatWrapping;
  trailTexture.needsUpdate = true;

  const runCase = async (options: {
    readonly killOrder?: number;
    readonly maxRibbons: number;
    readonly positions: readonly Vec3[];
    readonly seed: number;
    readonly uv:
      | { readonly mode: 'stretched' }
      | { readonly mode: 'tiled'; readonly tileLength: number };
  }): Promise<CaseResult> => {
    const definition = defineEmitter({
      attributes: { ribbonId: ribbonIdAttribute() },
      capacity: CAPACITY,
      init: [
        positionSphere({ radius: 0 }),
        lifetime(10),
        ribbonId(options.maxRibbons === 1 ? 0 : { count: options.maxRibbons, mode: 'alternating' }),
      ],
      integration: 'none',
      lifecycle: { duration: 1 },
      render: ribbon({
        blending: 'additive',
        map: textureRef,
        maxRibbons: options.maxRibbons,
        taper: { end: 0.25, start: 0.25 },
        uv: options.uv,
        width: RIBBON_WIDTH,
      }),
      spawn: rate(60),
      update: [
        colorOverLife(gradient('#89e8ff', '#b779ff', '#ff7ac8')),
        ...(options.killOrder === undefined ? [] : [killSpawnOrder(options.killOrder)]),
      ],
    });
    const system = new VFXSystem(runtimeRenderer, undefined, {
      fixedTimeStep: { stepSeconds: STEP },
      registry,
    });
    const instance = system.spawn(defineEffect({ elements: { trail: definition } }), {
      seed: options.seed,
    }) as RuntimeInstance;
    for (const position of options.positions) {
      instance.setTransform(position);
      await system.update(STEP);
    }
    const view = instance.getEmitter('trail');
    if (!view) throw new Error('M7 trail runtime emitter is missing.');
    const draw = materializeThreeRibbonDraw(view.program, view.kernels, 0, {
      resolveTexture: ({ uri }) => (uri === textureRef.uri ? trailTexture : undefined),
    });
    await draw.prepare(renderer);
    const [segments, alive, position, id, order] = await Promise.all([
      readRibbonSegments(renderer, draw),
      readLogicalAttribute(renderer, view.program, view.kernels, 'alive'),
      readLogicalAttribute(renderer, view.program, view.kernels, 'position'),
      readLogicalAttribute(renderer, view.program, view.kernels, 'ribbonId'),
      readLogicalAttribute(renderer, view.program, view.kernels, 'spawnOrder'),
    ]);
    return {
      alive: alive as Uint32Array,
      draw,
      indices: segments.indices,
      position: position as Float32Array,
      ribbonId: id as Uint32Array,
      segmentCount: segments.segmentCount,
      spawnOrder: order as Uint32Array,
      uvAndParametric: segments.uvAndParametric,
      widths: segments.widths,
    };
  };

  const crossingPositions: readonly Vec3[] = [
    [-1.2, -0.55, 0],
    [-1.2, 0.55, 0],
    [-0.4, -0.18, 0],
    [-0.4, 0.18, 0],
    [0.4, 0.18, 0],
    [0.4, -0.18, 0],
    [1.2, 0.55, 0],
    [1.2, -0.55, 0],
  ];
  const stretched = await runCase({
    maxRibbons: 2,
    positions: crossingPositions,
    seed: 7001,
    uv: { mode: 'stretched' },
  });
  const stretchedDuplicate = await runCase({
    maxRibbons: 2,
    positions: crossingPositions,
    seed: 7001,
    uv: { mode: 'stretched' },
  });
  const tiled = await runCase({
    maxRibbons: 2,
    positions: crossingPositions,
    seed: 7002,
    uv: { mode: 'tiled', tileLength: TILE_LENGTH },
  });
  const compacted = await runCase({
    killOrder: 2,
    maxRibbons: 1,
    positions: [
      [-1, -0.7, 0],
      [-0.5, -0.25, 0],
      [0, 0, 0],
      [0.5, 0.25, 0],
      [1, 0.7, 0],
    ],
    seed: 7003,
    uv: { mode: 'stretched' },
  });
  const saturated = await runCase({
    maxRibbons: 1,
    positions: Array.from({ length: CAPACITY * 3 }, (_, index) => {
      const point = index % CAPACITY;
      return [-1.2 + (point / (CAPACITY - 1)) * 2.4, 0.75, 0] as Vec3;
    }),
    seed: 7004,
    uv: { mode: 'stretched' },
  });

  const expectedStretched = expectedSegments(stretched);
  const actualStretched = actualSegments(stretched);
  const expectedCompacted = expectedSegments(compacted);
  const actualCompacted = actualSegments(compacted);
  const expectedSaturated = expectedSegments(saturated);
  const actualSaturated = actualSegments(saturated);
  const stretchedUvOk = Array.from({ length: stretched.segmentCount }, (_, segment) => {
    const values = stretched.uvAndParametric.slice(segment * 4, segment * 4 + 4);
    return close(values[0] ?? -1, values[2] ?? -2) && close(values[1] ?? -1, values[3] ?? -2);
  }).every(Boolean);
  const tiledUvOk = actualSegments(tiled).every(([a, b], segment) => {
    const ax = tiled.position[a * 3] ?? 0;
    const ay = tiled.position[a * 3 + 1] ?? 0;
    const az = tiled.position[a * 3 + 2] ?? 0;
    const bx = tiled.position[b * 3] ?? 0;
    const by = tiled.position[b * 3 + 1] ?? 0;
    const bz = tiled.position[b * 3 + 2] ?? 0;
    const measuredDelta =
      (tiled.uvAndParametric[segment * 4 + 1] ?? 0) - (tiled.uvAndParametric[segment * 4] ?? 0);
    return close(measuredDelta, Math.hypot(bx - ax, by - ay, bz - az) / TILE_LENGTH, 2e-5);
  });
  const widthTaperOk = [0, 3].every((firstSegment) => {
    const lastSegment = firstSegment + 2;
    return (
      close(stretched.widths[firstSegment * 4] ?? -1, 0) &&
      close(stretched.widths[firstSegment * 4 + 1] ?? -1, RIBBON_WIDTH) &&
      close(stretched.widths[lastSegment * 4] ?? -1, RIBBON_WIDTH) &&
      close(stretched.widths[lastSegment * 4 + 1] ?? -1, 0)
    );
  });
  const compactionSkippedKilledPoint = actualCompacted.some(
    ([a, b]) => (compacted.spawnOrder[a] ?? -1) === 1 && (compacted.spawnOrder[b] ?? -1) === 3,
  );

  const visualScene = new THREE.Scene();
  visualScene.background = new THREE.Color(0x080b1a);
  visualScene.add(stretched.draw.mesh);
  const camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.05, -1.05, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  renderer.setRenderTarget(target);
  renderer.render(visualScene, camera);
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT);
  renderer.setRenderTarget(null);
  const rgba = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const sourceRow = Math.floor(index / 4 / WIDTH);
    const sourceColumn = (index / 4) % WIDTH;
    const targetIndex = ((HEIGHT - 1 - sourceRow) * WIDTH + sourceColumn) * 4;
    rgba[targetIndex] = pixels[index] ?? 0;
    rgba[targetIndex + 1] = pixels[index + 1] ?? 0;
    rgba[targetIndex + 2] = pixels[index + 2] ?? 0;
    rgba[targetIndex + 3] = 255;
  }
  const visualCanvas = document.createElement('canvas');
  visualCanvas.id = 'ribbon-visual';
  visualCanvas.width = WIDTH;
  visualCanvas.height = HEIGHT;
  visualCanvas.getContext('2d')?.putImageData(new ImageData(rgba, WIDTH, HEIGHT), 0, 0);
  sceneHost.append(visualCanvas);
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm7-ribbons.png', selector: '#ribbon-visual' },
  ]);
  const foregroundPixels = Array.from({ length: WIDTH * HEIGHT }, (_, index) => {
    const offset = index * 4;
    return (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 36;
  }).filter(Boolean).length;

  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm7-ribbons',
  });
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();

  const validation = {
    compactionResilient:
      JSON.stringify(actualCompacted) === JSON.stringify(expectedCompacted) &&
      compactionSkippedKilledPoint,
    consoleClean: consoleMessages.length === 0,
    deterministic:
      bytesEqual(stretched.indices, stretchedDuplicate.indices) &&
      bytesEqual(stretched.uvAndParametric, stretchedDuplicate.uvAndParametric) &&
      bytesEqual(stretched.widths, stretchedDuplicate.widths),
    multiRibbonSeparated:
      actualStretched.every(
        ([a, b, id]) => stretched.ribbonId[a] === id && stretched.ribbonId[b] === id,
      ) && new Set(actualStretched.map(([, , id]) => id)).size === 2,
    spawnOrderConnected: JSON.stringify(actualStretched) === JSON.stringify(expectedStretched),
    spawnOrderSaturation:
      saturated.segmentCount === CAPACITY - 1 &&
      JSON.stringify(actualSaturated) === JSON.stringify(expectedSaturated),
    tiledUv: tiledUvOk,
    stretchedUv: stretchedUvOk,
    visualReadback: foregroundPixels > 100,
    widthTaper: widthTaperOk,
  };
  const result = {
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    ordering: 'gpu-birth-ring:(ribbonId,spawnOrder)',
    readback: {
      compactedSegments: actualCompacted.map(([a, b, id]) => ({
        fromOrder: compacted.spawnOrder[a],
        id,
        toOrder: compacted.spawnOrder[b],
      })),
      segmentCount: stretched.segmentCount,
      saturatedSegmentCount: saturated.segmentCount,
      tiledUv: [...tiled.uvAndParametric.slice(0, tiled.segmentCount * 4)],
      widths: [...stretched.widths.slice(0, stretched.segmentCount * 4)],
    },
    validation,
    visual: { foregroundPixels, source: 'offscreen-render-target-readback' },
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M7 ribbon checks passed' : 'M7 ribbon checks failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = message;
  originalError(error);
});
