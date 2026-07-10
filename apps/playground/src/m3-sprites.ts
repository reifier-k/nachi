import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  defineEffect,
  defineEmitter,
  flipbook,
  gradient,
  lifetime,
  positionSphere,
  velocityCone,
} from '@nachi/core';
import type { BillboardOptions, TextureRef, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
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
  readonly cutout?: BillboardOptions['cutout'];
  readonly duration?: number;
  readonly lifetimeSeconds?: number;
  readonly loopCount?: number;
  readonly map?: BillboardOptions['map'];
  readonly soft?: BillboardOptions['soft'];
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
          ...(options.cutout === undefined ? {} : { cutout: options.cutout }),
          ...(options.map === undefined ? {} : { map: options.map }),
          ...(options.soft === undefined ? {} : { soft: options.soft }),
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

function compareReadbacks(left: ArrayLike<number>, right: ArrayLike<number>) {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('M3 sprite readback buffers were empty or had mismatched lengths.');
  }
  let changedPixels = 0;
  let totalDifference = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const difference =
      (Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
        Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
        Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0))) /
      3;
    totalDifference += difference;
    if (difference > 6) changedPixels += 1;
  }
  const pixelCount = left.length / 4;
  return {
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteDifference: totalDifference / pixelCount,
  };
}

function centerBrightness(pixels: ArrayLike<number>): number {
  const offset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
  return ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)) / 3;
}

function textureRef(uri: string): TextureRef {
  return { assetType: 'texture', kind: 'asset-ref', uri };
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
  const atlasRef = textureRef('procedural://m3-sprites/flipbook-atlas');
  const atlasTexture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255, 190, 190, 190, 255, 100, 100, 100, 255, 16, 16, 16, 255]),
    2,
    2,
  );
  atlasTexture.flipY = true;
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.needsUpdate = true;
  const resolveTexture = createThreeTextureResolver(new Map([[atlasRef.uri, atlasTexture]]));

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
    const mesh = materializeThreeSpriteDraw(view.program, view.kernels, 0, { resolveTexture });
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

  const flipbookMap = flipbook(atlasRef, { cols: 2, rows: 2 });
  const interpolatedFlipbook = await createSprite({
    count: 1,
    lifetimeSeconds: STEP * 8,
    map: flipbookMap,
  });
  const firstFlipbookPixels = await render(interpolatedFlipbook.mesh);
  await interpolatedFlipbook.system.update(STEP * 2);
  const progressedFlipbookPixels = await render(interpolatedFlipbook.mesh);
  const discreteFlipbook = await createSprite({
    count: 1,
    lifetimeSeconds: STEP * 8,
    map: flipbook(atlasRef, { cols: 2, interpolate: false, rows: 2 }),
  });
  const discreteFlipbookPixels = await render(discreteFlipbook.mesh);
  await discreteFlipbook.system.update(STEP);
  const nextDiscreteFlipbookPixels = await render(discreteFlipbook.mesh);
  const frameProgressDifference = compareReadbacks(firstFlipbookPixels, progressedFlipbookPixels);
  const interpolationDifference = compareReadbacks(firstFlipbookPixels, discreteFlipbookPixels);
  const discreteFrameDifference = compareReadbacks(
    discreteFlipbookPixels,
    nextDiscreteFlipbookPixels,
  );
  const flipbookBrightness = {
    discrete: centerBrightness(discreteFlipbookPixels),
    first: centerBrightness(firstFlipbookPixels),
    nextDiscrete: centerBrightness(nextDiscreteFlipbookPixels),
    progressed: centerBrightness(progressedFlipbookPixels),
  };
  const interpolationBrightnessRange = {
    maximum: Math.max(flipbookBrightness.discrete, flipbookBrightness.nextDiscrete),
    minimum: Math.min(flipbookBrightness.discrete, flipbookBrightness.nextDiscrete),
  };
  const flipbookDraw = interpolatedFlipbook.view.program.draws[0];
  const flipbookDescription =
    flipbookDraw?.kind === 'billboard' ? flipbookDraw.fragment.flipbook : undefined;

  const quadSprite = await createSprite({ count: 1, cutout: { vertices: 4 } });
  const cutoutSprite = await createSprite({ count: 1, cutout: { vertices: 6 } });
  const quadPixels = await render(quadSprite.mesh);
  const cutoutPixels = await render(cutoutSprite.mesh);
  const quadMetrics = comparePixels(quadPixels, baseline);
  const cutoutMetrics = comparePixels(cutoutPixels, baseline);
  const cutoutCenterDifference = Math.abs(
    centerBrightness(quadPixels) - centerBrightness(cutoutPixels),
  );
  const cutoutDraw = cutoutSprite.view.program.draws[0];
  const cutoutGeometry = cutoutDraw?.kind === 'billboard' ? cutoutDraw.geometry : undefined;

  const hardIntersectionSprite = await createSprite({ count: 1 });
  const softIntersectionSprite = await createSprite({ count: 1, soft: true });
  hardIntersectionSprite.mesh.position.z = 0.72;
  softIntersectionSprite.mesh.position.z = 0.72;
  const occluder = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 1.35, 1.3),
    new THREE.MeshBasicMaterial({ color: 0x5a78a8 }),
  );
  occluder.position.set(0.18, 0, 0);
  occluder.rotation.y = 0.58;
  scene.add(occluder);
  const occluderBaseline = await render();
  const hardIntersectionPixels = await render(hardIntersectionSprite.mesh);
  const softIntersectionPixels = await render(softIntersectionSprite.mesh);
  scene.remove(occluder);
  const hardIntersection = comparePixels(hardIntersectionPixels, occluderBaseline);
  const softIntersection = comparePixels(softIntersectionPixels, occluderBaseline);
  const hardIntersectionContribution = compareReadbacks(hardIntersectionPixels, occluderBaseline);
  const softIntersectionContribution = compareReadbacks(softIntersectionPixels, occluderBaseline);
  const softFadeDifference = compareReadbacks(hardIntersectionPixels, softIntersectionPixels);

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
    cutoutShape:
      cutoutGeometry?.shape === 'cutout' &&
      cutoutGeometry.vertexCount === 6 &&
      cutoutGeometry.indexCount === 12 &&
      cutoutCenterDifference < 2 &&
      cutoutMetrics.foregroundPixelRatio > 0 &&
      cutoutMetrics.foregroundPixelRatio < quadMetrics.foregroundPixelRatio,
    consoleClean: consoleMessages.length === 0,
    flipbookFrameProgress:
      frameProgressDifference.changedPixelRatio > 0.005 &&
      frameProgressDifference.meanAbsoluteDifference > 0.1 &&
      flipbookBrightness.first > flipbookBrightness.progressed,
    flipbookInterpolation:
      // Sub-threshold per-pixel interpolation can produce a zero changed-pixel ratio; MAD plus
      // the strict between-frame brightness check still distinguishes it from discrete playback.
      interpolationDifference.meanAbsoluteDifference > 0.1 &&
      discreteFrameDifference.meanAbsoluteDifference > 0.1 &&
      flipbookBrightness.first > interpolationBrightnessRange.minimum + 1 &&
      flipbookBrightness.first < interpolationBrightnessRange.maximum - 1,
    flipbookTopLeftRows:
      flipbookDescription?.rowOrder === 'top-left' && flipbookDescription.rows === 2,
    m2NumericRegression:
      regressionView.program.meta.storageBufferCount <= 8 &&
      Math.abs(movementDelta - STEP) < 0.0002,
    respawnReflected: respawned,
    softIntersectionFade:
      softFadeDifference.changedPixelRatio > 0.001 &&
      softFadeDifference.meanAbsoluteDifference > 0.05 &&
      softIntersection.foregroundPixelRatio > 0.001 &&
      softIntersectionContribution.meanAbsoluteDifference > 0 &&
      softIntersectionContribution.meanAbsoluteDifference <
        hardIntersectionContribution.meanAbsoluteDifference,
    spriteForeground: foreground.foregroundPixelRatio > 0.01,
    velocityStretchShape:
      stretchedShape.bounds.height > facingShape.bounds.height * 1.5 &&
      stretchedShape.bounds.height > stretchedShape.bounds.width,
  };
  const result = {
    aliveHistory,
    blendMetrics,
    cutout: {
      centerDifference: cutoutCenterDifference,
      draw: cutoutGeometry,
      hex: cutoutMetrics,
      quad: quadMetrics,
    },
    consoleMessages,
    flipbook: {
      brightness: flipbookBrightness,
      description: flipbookDescription,
      discreteFrameDifference,
      frameProgressDifference,
      interpolationDifference,
    },
    foreground,
    m2Regression: {
      movementDelta,
      storageBufferCount: regressionView.program.meta.storageBufferCount,
    },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    pixelHistory,
    shapes: { facing: facingShape.bounds, stretched: stretchedShape.bounds },
    softParticles: {
      fadeDifference: softFadeDifference,
      hard: hardIntersection,
      hardContribution: hardIntersectionContribution,
      soft: softIntersection,
      softContribution: softIntersectionContribution,
    },
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
