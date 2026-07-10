import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  defineEffect,
  defineEmitter,
  gradient,
  lifetime,
  positionSphere,
  velocityCone,
} from '@nachi/core';
import type { BillboardOptions, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m3-sprites.css';

const WIDTH = 320;
const HEIGHT = 240;
const STEP = 1 / 60;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
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

const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLDivElement>('#scene');
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

type RuntimeInstance = {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
};

type BackendLike = {
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M3 sprite UI element: ${selector}`);
  return element;
}

function emitter(instance: RuntimeInstance): VfxEmitterRuntimeView {
  const runtimeEmitter = instance.getEmitter('particles');
  if (!runtimeEmitter) throw new Error('M3 sprite runtime emitter is missing.');
  return runtimeEmitter;
}

function spriteEffect(options: {
  readonly alignment?: BillboardOptions['alignment'];
  readonly blending?: NonNullable<BillboardOptions['blending']>;
  readonly capacity?: number;
  readonly count?: number;
  readonly duration?: number;
  readonly lifetimeSeconds?: number;
  readonly loopCount?: number;
  readonly spread?: number;
  readonly speed?: number;
}) {
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: options.capacity ?? 8,
        init: [
          positionSphere({ radius: options.spread ?? 0 }),
          velocityCone({
            angle: 0,
            direction: [0, 1, 0],
            speed: options.speed ?? 0,
          }),
          lifetime(options.lifetimeSeconds ?? 10),
        ],
        integration: 'none',
        lifecycle: {
          duration: options.duration ?? 10,
          ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
        },
        render: billboard({
          ...(options.alignment === undefined ? {} : { alignment: options.alignment }),
          blending: options.blending ?? 'alpha',
        }),
        spawn: burst({ count: options.count ?? 4 }),
        update: [colorOverLife(gradient([1, 0.18, 0.04, 0.38], [1, 0.18, 0.04, 0.38]))],
      }),
    },
  });
}

function comparePixels(pixels: ArrayLike<number>, baseline: ArrayLike<number>) {
  let changed = 0;
  let brightness = 0;
  let minX = WIDTH;
  let minY = HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
    const offset = pixel * 4;
    const difference =
      Math.abs((pixels[offset] ?? 0) - (baseline[offset] ?? 0)) +
      Math.abs((pixels[offset + 1] ?? 0) - (baseline[offset + 1] ?? 0)) +
      Math.abs((pixels[offset + 2] ?? 0) - (baseline[offset + 2] ?? 0));
    if (difference <= 12) continue;
    changed += 1;
    brightness += (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
    const x = pixel % WIDTH;
    const y = Math.floor(pixel / WIDTH);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    bounds:
      changed === 0 ? { height: 0, width: 0 } : { height: maxY - minY + 1, width: maxX - minX + 1 },
    foregroundPixelRatio: changed / (WIDTH * HEIGHT),
    meanForegroundBrightness: changed === 0 ? 0 : brightness / (changed * 3),
  };
}

async function indirectCount(renderer: THREE.WebGPURenderer, view: VfxEmitterRuntimeView) {
  const indirect = view.kernels.drawIndirect;
  const offset = view.kernels.drawIndirectOffsetBytes;
  if (!indirect || offset === undefined) throw new Error('M3 indirect arguments are missing.');
  const buffer = await renderer.getArrayBufferAsync(indirect.indirectResource as never);
  return new Uint32Array(buffer)[offset / 4 + 1] ?? 0;
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(headless ? WIDTH : innerWidth, headless ? HEIGHT : innerHeight);
  if (!headless) sceneHost.append(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M3 sprite smoke requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Offscreen readback' : 'Visual';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm3-sprites',
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101828);
  const camera = new THREE.OrthographicCamera(-3, 3, 2.25, -2.25, 0.1, 20);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });

  const render = async (mesh?: THREE.Object3D) => {
    if (mesh) scene.add(mesh);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT);
    renderer.setRenderTarget(null);
    if (mesh) scene.remove(mesh);
    return pixels;
  };
  const baseline = await render();

  const createSprite = async (options: Parameters<typeof spriteEffect>[0]) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { stepSeconds: STEP },
    });
    const instance = system.spawn(spriteEffect(options), { seed: 41 }) as RuntimeInstance;
    const view = emitter(instance);
    const mesh = materializeThreeSpriteDraw(view.program, view.kernels);
    await system.update(0);
    await system.update(STEP);
    return { instance, mesh, system, view };
  };

  const foregroundSprite = await createSprite({ count: 5, spread: 1.1 });
  const foreground = comparePixels(await render(foregroundSprite.mesh), baseline);

  const blendMetrics: Record<string, ReturnType<typeof comparePixels>> = {};
  for (const blending of ['additive', 'alpha', 'multiply', 'premultiplied'] as const) {
    const sprite = await createSprite({ blending, count: 4, spread: 0.2 });
    blendMetrics[blending] = comparePixels(await render(sprite.mesh), baseline);
  }

  const facing = await createSprite({ count: 1, speed: 2 });
  const stretched = await createSprite({
    alignment: { factor: 1.5, mode: 'velocity-stretch' },
    count: 1,
    speed: 2,
  });
  const facingShape = comparePixels(await render(facing.mesh), baseline);
  const stretchedShape = comparePixels(await render(stretched.mesh), baseline);

  const lifecycleSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const lifecycleInstance = lifecycleSystem.spawn(
    spriteEffect({
      capacity: 3,
      count: 3,
      duration: STEP * 2,
      lifetimeSeconds: STEP,
      loopCount: 2,
    }),
    { seed: 7 },
  ) as RuntimeInstance;
  const lifecycleView = emitter(lifecycleInstance);
  const lifecycleMesh = materializeThreeSpriteDraw(lifecycleView.program, lifecycleView.kernels);
  const aliveHistory: number[] = [];
  const pixelHistory: number[] = [];
  await lifecycleSystem.update(0);
  for (let frame = 0; frame < 6; frame += 1) {
    aliveHistory.push(await indirectCount(renderer, lifecycleView));
    pixelHistory.push(comparePixels(await render(lifecycleMesh), baseline).foregroundPixelRatio);
    await lifecycleSystem.update(STEP);
  }

  const regressionSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const regressionInstance = regressionSystem.spawn(
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], speed: 1 }), lifetime(10)],
          render: billboard({}),
          spawn: burst({ count: 1 }),
        }),
      },
    }),
    { seed: 7 },
  ) as RuntimeInstance;
  const regressionView = emitter(regressionInstance);
  await regressionSystem.update(0);
  const initialPosition = (await readLogicalAttribute(
    renderer,
    regressionView.program,
    regressionView.kernels,
    'position',
  )) as Float32Array;
  await regressionSystem.update(STEP);
  const finalPosition = (await readLogicalAttribute(
    renderer,
    regressionView.program,
    regressionView.kernels,
    'position',
  )) as Float32Array;
  const movementDelta = (finalPosition[0] ?? Number.NaN) - (initialPosition[0] ?? Number.NaN);

  const firstDeath = aliveHistory.findIndex((count) => count === 0);
  const respawned =
    firstDeath >= 0 && aliveHistory.slice(firstDeath + 1).some((count) => count > 0);
  const blendBrightness = Object.fromEntries(
    Object.entries(blendMetrics).map(([mode, metrics]) => [mode, metrics.meanForegroundBrightness]),
  );
  const validation = {
    aliveCountChangesDraw:
      new Set(aliveHistory).size > 1 &&
      aliveHistory.every((count, index) => (count === 0) === ((pixelHistory[index] ?? 0) === 0)),
    blendModesDiffer:
      Math.abs((blendBrightness.additive ?? 0) - (blendBrightness.alpha ?? 0)) > 2 &&
      Math.abs((blendBrightness.multiply ?? 0) - (blendBrightness.alpha ?? 0)) > 2 &&
      (blendMetrics.premultiplied?.foregroundPixelRatio ?? 0) > 0,
    consoleClean: consoleMessages.length === 0,
    m2NumericRegression:
      regressionView.program.meta.storageBufferCount <= 8 &&
      Math.abs(movementDelta - STEP) < 0.0002,
    respawnReflected: respawned,
    spriteForeground: foreground.foregroundPixelRatio > 0.01,
    velocityStretchShape:
      stretchedShape.bounds.height > facingShape.bounds.height * 1.5 &&
      stretchedShape.bounds.height > stretchedShape.bounds.width,
  };
  const result = {
    aliveHistory,
    blendMetrics,
    consoleMessages,
    foreground,
    m2Regression: {
      movementDelta,
      storageBufferCount: regressionView.program.meta.storageBufferCount,
    },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    pixelHistory,
    shapes: { facing: facingShape.bounds, stretched: stretchedShape.bounds },
    validation,
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M3 sprite checks passed' : 'M3 sprite checks failed';

  if (!headless) {
    scene.add(stretched.mesh);
    renderer.setAnimationLoop((timestamp) => {
      renderer.render(scene, camera);
      performanceMonitor.recordFrame(timestamp);
    });
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = `Error: ${message}`;
});
