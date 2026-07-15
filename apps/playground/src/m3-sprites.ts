import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  defineEffect,
  defineEmitter,
  emitTo,
  flipbook,
  gradient,
  gravity,
  lifetime,
  positionSphere,
  rate,
  range,
  velocityCone,
} from '@nachi-vfx/core';
import type { BillboardOptions, TextureRef, Vec4, VfxEmitterRuntimeView } from '@nachi-vfx/core';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { readLogicalAttribute, readStorage } from './three-runtime-readback';
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
  readonly color?: Vec4;
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
        update: [
          colorOverLife(
            gradient(
              options.color ?? [1, 0.18, 0.04, 0.38],
              options.color ?? [1, 0.18, 0.04, 0.38],
            ),
          ),
        ],
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

function centerColor(pixels: ArrayLike<number>): readonly [number, number, number, number] {
  const offset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
  return [
    pixels[offset] ?? 0,
    pixels[offset + 1] ?? 0,
    pixels[offset + 2] ?? 0,
    pixels[offset + 3] ?? 0,
  ];
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
  // This page is a long-running correctness suite. Timestamp capture belongs on a separate short
  // performance renderer so repeated lifecycle/readback rigs cannot exhaust Three's query pool.
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
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
  const uniqueAtlasBytes = new Uint8Array([
    255, 24, 24, 255, 24, 255, 24, 255, 24, 24, 255, 255, 255, 230, 24, 255,
  ]);
  const atlasFlipYRef = textureRef('procedural://m3-sprites/unique-atlas-flipy');
  const atlasNoFlipRef = textureRef('procedural://m3-sprites/unique-atlas-no-flip');
  const uniqueAtlasFlipY = new THREE.DataTexture(uniqueAtlasBytes.slice(), 2, 2);
  const uniqueAtlasNoFlip = new THREE.DataTexture(uniqueAtlasBytes.slice(), 2, 2);
  for (const [texture, flipY] of [
    [uniqueAtlasFlipY, true],
    [uniqueAtlasNoFlip, false],
  ] as const) {
    texture.flipY = flipY;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }
  const translucentRef = textureRef('procedural://m3-sprites/translucent');
  const translucentTexture = new THREE.DataTexture(new Uint8Array([255, 96, 32, 72]), 1, 1);
  translucentTexture.needsUpdate = true;
  const opaqueControlRef = textureRef('procedural://m3-sprites/opaque-control');
  const opaqueControlTexture = new THREE.DataTexture(new Uint8Array([255, 96, 32, 255]), 1, 1);
  opaqueControlTexture.needsUpdate = true;
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [atlasRef.uri, atlasTexture],
      [atlasFlipYRef.uri, uniqueAtlasFlipY],
      [atlasNoFlipRef.uri, uniqueAtlasNoFlip],
      [translucentRef.uri, translucentTexture],
      [opaqueControlRef.uri, opaqueControlTexture],
    ]),
  );

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
  const translucentAlpha = await createSprite({
    blending: 'alpha',
    color: [1, 1, 1, 1],
    count: 1,
    map: translucentRef,
  });
  const translucentPremultiplied = await createSprite({
    blending: 'premultiplied',
    color: [1, 1, 1, 1],
    count: 1,
    map: translucentRef,
  });
  const untexturedPremultiplied = await createSprite({
    blending: 'premultiplied',
    color: [1, 1, 1, 1],
    count: 1,
  });
  const opaquePremultiplied = await createSprite({
    blending: 'premultiplied',
    color: [1, 1, 1, 1],
    count: 1,
    map: opaqueControlRef,
  });
  const translucentPremultipliedPixels = await render(translucentPremultiplied.mesh);
  const untexturedPremultipliedPixels = await render(untexturedPremultiplied.mesh);
  const opaquePremultipliedPixels = await render(opaquePremultiplied.mesh);
  const premultipliedTextureDifference = compareReadbacks(
    translucentPremultipliedPixels,
    untexturedPremultipliedPixels,
  );
  const premultipliedOpacityDifference = compareReadbacks(
    translucentPremultipliedPixels,
    opaquePremultipliedPixels,
  );

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
  const sampleUniqueAtlas = async (reference: TextureRef) => {
    const sprite = await createSprite({
      color: [1, 1, 1, 1],
      count: 1,
      lifetimeSeconds: STEP * 8,
      map: flipbook(reference, { cols: 2, interpolate: false, rows: 2 }),
    });
    const colors: (readonly [number, number, number, number])[] = [];
    for (let frame = 0; frame < 4; frame += 1) {
      colors.push(centerColor(await render(sprite.mesh)));
      if (frame < 3) await sprite.system.update(STEP * 2);
    }
    return colors;
  };
  const flipYColors = await sampleUniqueAtlas(atlasFlipYRef);
  const noFlipColors = await sampleUniqueAtlas(atlasNoFlipRef);
  const atlasPairDifference = flipYColors.map((color, index) =>
    color.reduce((sum, channel, channelIndex) => {
      return sum + Math.abs(channel - (noFlipColors[index]?.[channelIndex] ?? 0));
    }, 0),
  );
  const atlasFrameSeparation = flipYColors.flatMap((color, left) =>
    flipYColors.slice(left + 1).map((other) =>
      color.slice(0, 3).reduce((sum, channel, channelIndex) => {
        return sum + Math.abs(channel - (other[channelIndex] ?? 0));
      }, 0),
    ),
  );

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

  const firstDeath = aliveHistory.indexOf(0);
  const respawned =
    firstDeath >= 0 && aliveHistory.slice(firstDeath + 1).some((count) => count > 0);

  const burstCycleSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const burstCycleInstance = burstCycleSystem.spawn(
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 200,
          init: [positionSphere({ radius: 0.65 }), lifetime(range(0.3, 0.45))],
          integration: 'none',
          render: billboard({}),
          spawn: burst({ count: 40, cycles: 5, interval: 0.12 }),
        }),
      },
    }),
    { seed: 0x007b_57c1 },
  ) as RuntimeInstance;
  const burstCycleView = emitter(burstCycleInstance);
  const burstCycleMesh = materializeThreeSpriteDraw(burstCycleView.program, burstCycleView.kernels);
  await burstCycleSystem.update(0);
  for (let frame = 0; frame < 30; frame += 1) await burstCycleSystem.update(STEP);
  const burstCycleAlive = (await readLogicalAttribute(
    renderer,
    burstCycleView.program,
    burstCycleView.kernels,
    'alive',
  )) as Uint32Array;
  const burstCycleSpawnGeneration = (await readLogicalAttribute(
    renderer,
    burstCycleView.program,
    burstCycleView.kernels,
    'spawnGeneration',
  )) as Uint32Array;
  const burstCyclePhysicalAlive = [...burstCycleAlive].filter((value) => value !== 0).length;
  const burstCycleSuccessfulBirths = [...burstCycleSpawnGeneration].reduce(
    (total, generation) => total + generation,
    0,
  );
  const burstCycleIndirectAlive = await indirectCount(renderer, burstCycleView);
  const burstCyclePixels = comparePixels(await render(burstCycleMesh), baseline);

  const updateRandomRangeEffect = (capacity: number) =>
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity,
          init: [
            positionSphere({ radius: 0.8 }),
            velocityCone({ angle: 55, direction: [0, 1, 0], speed: range(0.4, 1.8) }),
            lifetime(range(0.12, 0.18)),
          ],
          lifecycle: { duration: 0.8 },
          render: billboard({ blending: 'additive' }),
          spawn: rate(80),
          update: [gravity(range(-3, -0.5))],
        }),
      },
    });
  const captureRateReuse = async (capacity: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { stepSeconds: STEP },
    });
    const instance = system.spawn(updateRandomRangeEffect(capacity), {
      seed: 0x51a7_0e11,
    }) as RuntimeInstance;
    const view = emitter(instance);
    const mesh = materializeThreeSpriteDraw(view.program, view.kernels);
    await system.update(0);
    for (let frame = 0; frame < 40; frame += 1) await system.update(STEP);
    const pixels = await render(mesh);
    const [alive, spawnGeneration, spawnOrder, position, velocity, lifetimeValues, age] =
      await Promise.all([
        readLogicalAttribute(renderer, view.program, view.kernels, 'alive') as Promise<Uint32Array>,
        readLogicalAttribute(
          renderer,
          view.program,
          view.kernels,
          'spawnGeneration',
        ) as Promise<Uint32Array>,
        readLogicalAttribute(
          renderer,
          view.program,
          view.kernels,
          'spawnOrder',
        ) as Promise<Uint32Array>,
        readLogicalAttribute(
          renderer,
          view.program,
          view.kernels,
          'position',
        ) as Promise<Float32Array>,
        readLogicalAttribute(
          renderer,
          view.program,
          view.kernels,
          'velocity',
        ) as Promise<Float32Array>,
        readLogicalAttribute(
          renderer,
          view.program,
          view.kernels,
          'lifetime',
        ) as Promise<Float32Array>,
        readLogicalAttribute(renderer, view.program, view.kernels, 'age') as Promise<Float32Array>,
      ]);
    const records = Array.from({ length: alive.length }, (_, physicalSlot) => physicalSlot)
      .filter((physicalSlot) => alive[physicalSlot] !== 0)
      .map((physicalSlot) => [
        spawnOrder[physicalSlot]!,
        position[physicalSlot * 3]!,
        position[physicalSlot * 3 + 1]!,
        position[physicalSlot * 3 + 2]!,
        velocity[physicalSlot * 3]!,
        velocity[physicalSlot * 3 + 1]!,
        velocity[physicalSlot * 3 + 2]!,
        lifetimeValues[physicalSlot]!,
        age[physicalSlot]!,
      ])
      .sort((left, right) => left[0]! - right[0]!);
    const float = new Float32Array(1);
    const word = new Uint32Array(float.buffer);
    let hash = 0x811c9dc5;
    for (const [order, ...values] of records) {
      hash = Math.imul((hash ^ order!) >>> 0, 0x01000193) >>> 0;
      for (const value of values) {
        float[0] = value!;
        hash = Math.imul((hash ^ word[0]!) >>> 0, 0x01000193) >>> 0;
      }
    }
    return {
      alive: records.length,
      hash: hash.toString(16).padStart(8, '0'),
      pixels,
      records,
      successfulBirths: [...spawnGeneration].reduce((total, generation) => total + generation, 0),
    };
  };
  const equalRateReuseRecords = (
    left: Awaited<ReturnType<typeof captureRateReuse>>,
    right: Awaited<ReturnType<typeof captureRateReuse>>,
  ) =>
    left.records.length === right.records.length &&
    left.records.every((record, index) =>
      record.every((value, component) => Object.is(value, right.records[index]?.[component])),
    );
  const rateReuseFirst = await captureRateReuse(32);
  const rateReuseSecond = await captureRateReuse(32);
  const rateReuseThird = await captureRateReuse(32);
  // A one-slot capacity perturbation changes every initial physical allocation while preserving
  // birth order and spawn schedule. This catches a regression that keeps spawnOrder allocated but
  // accidentally feeds physical slot identity back into Init or Update randomness.
  const rateReusePerturbed = await captureRateReuse(33);
  const rateReuseRecordsEqual = equalRateReuseRecords(rateReuseFirst, rateReuseSecond);
  const rateReuseThreeRunsEqual =
    rateReuseRecordsEqual && equalRateReuseRecords(rateReuseSecond, rateReuseThird);
  const rateReusePhysicalLayoutInvariant = equalRateReuseRecords(
    rateReuseFirst,
    rateReusePerturbed,
  );
  const rateReuseScreenshotDeltas = [
    compareReadbacks(rateReuseFirst.pixels, rateReuseSecond.pixels),
    compareReadbacks(rateReuseSecond.pixels, rateReuseThird.pixels),
    compareReadbacks(rateReuseFirst.pixels, rateReuseThird.pixels),
  ];
  const rateReuseMaximumScreenshotDelta = Math.max(
    ...rateReuseScreenshotDeltas.map(({ changedPixelRatio }) => changedPixelRatio),
  );
  const rateReusePhysicalLayoutScreenshotDelta = compareReadbacks(
    rateReuseFirst.pixels,
    rateReusePerturbed.pixels,
  );
  const captureEventRouting = async (reverseInsertion: boolean) => {
    const source = (center: readonly [number, number, number]) =>
      defineEmitter({
        capacity: 1,
        events: { onDeath: emitTo('target', { inherit: ['position'] }) },
        init: [positionSphere({ center, radius: 0 }), lifetime(0.01)],
        integration: 'none' as const,
        render: billboard({ blending: 'additive' as const }),
        spawn: burst({ count: 1 }),
      });
    const target = defineEmitter({
      capacity: 1,
      init: [positionSphere({ radius: 0 }), lifetime(1)],
      integration: 'none',
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 0 }),
    });
    const alpha = source([-0.75, 0, 0]);
    const zeta = source([0.75, 0, 0]);
    const elements = reverseInsertion ? { alpha, target, zeta } : { zeta, target, alpha };
    const routeSystem = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      maxPoolSize: 0,
    });
    const routeInstance = routeSystem.spawn(defineEffect({ elements }), { seed: 0x2e71 });
    try {
      await routeSystem.update(0);
      await routeSystem.update(0.02);
      await routeSystem.update(0.001);
      const targetView = routeInstance.getEmitter('target');
      if (!targetView) throw new Error('M3 event routing target is missing.');
      const [position, spawnOrder, alive, state] = await Promise.all([
        readLogicalAttribute(
          renderer,
          targetView.program,
          targetView.kernels,
          'position',
        ) as Promise<Float32Array>,
        readLogicalAttribute(
          renderer,
          targetView.program,
          targetView.kernels,
          'spawnOrder',
        ) as Promise<Uint32Array>,
        readLogicalAttribute(
          renderer,
          targetView.program,
          targetView.kernels,
          'alive',
        ) as Promise<Uint32Array>,
        readStorage(renderer, targetView.kernels.aliveCount, 'uint') as Promise<Uint32Array>,
      ]);
      return {
        alive: alive[0] ?? 0,
        dropped: state[targetView.kernels.counterOffsets.spawnOverflow] ?? 0,
        positionX: position[0] ?? 0,
        spawnOrder: spawnOrder[0] ?? 0xffffffff,
      };
    } finally {
      routeInstance.release();
    }
  };
  const eventRouting = {
    forward: await captureEventRouting(false),
    reversed: await captureEventRouting(true),
  };
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
    burstCycleDeathOverlap:
      burstCycleSuccessfulBirths === 200 &&
      burstCyclePhysicalAlive > 0 &&
      burstCyclePhysicalAlive < 200 &&
      burstCycleIndirectAlive === burstCyclePhysicalAlive &&
      burstCyclePixels.foregroundPixelRatio > 0.01,
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
    flipYAtlasParity:
      atlasPairDifference.every((difference) => difference <= 8) &&
      atlasFrameSeparation.every((difference) => difference > 30),
    m2NumericRegression:
      regressionView.program.meta.storageBufferCount <= 8 &&
      Math.abs(movementDelta - STEP) < 0.0002,
    eventRoutingCanonical:
      JSON.stringify(eventRouting.forward) === JSON.stringify(eventRouting.reversed) &&
      eventRouting.forward.alive === 1 &&
      eventRouting.forward.dropped >= 1 &&
      eventRouting.forward.positionX < -0.7 &&
      eventRouting.forward.spawnOrder === 0,
    rateReuseRandomDeterminism:
      rateReuseFirst.successfulBirths > 32 &&
      rateReuseFirst.successfulBirths === rateReuseSecond.successfulBirths &&
      rateReuseFirst.alive > 0 &&
      rateReuseFirst.hash === rateReuseSecond.hash &&
      rateReuseThreeRunsEqual &&
      rateReuseMaximumScreenshotDelta <= 0.0002 &&
      rateReuseFirst.successfulBirths === rateReusePerturbed.successfulBirths &&
      rateReuseFirst.hash === rateReusePerturbed.hash &&
      rateReusePhysicalLayoutInvariant &&
      rateReusePhysicalLayoutScreenshotDelta.changedPixelRatio <= 0.0002,
    respawnReflected: respawned,
    premultipliedTranslucentTexture:
      translucentPremultiplied.mesh.material.premultipliedAlpha &&
      !translucentAlpha.mesh.material.premultipliedAlpha &&
      premultipliedOpacityDifference.changedPixelRatio > 0.001 &&
      premultipliedOpacityDifference.meanAbsoluteDifference > 0.05 &&
      centerBrightness(translucentPremultipliedPixels) <
        centerBrightness(opaquePremultipliedPixels),
    premultipliedTextureDifference:
      premultipliedTextureDifference.changedPixelRatio > 0.001 &&
      premultipliedTextureDifference.meanAbsoluteDifference > 0.05,
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

  // Keep timestamp queries isolated from the long correctness/readback sequence above. A compact
  // renderer runs the same core compute + sprite render path for the warmed performance window.
  const performanceRenderer = await createPlaygroundRenderer({
    antialias: false,
    trackTimestamp: true,
  });
  performanceRenderer.setPixelRatio(1);
  performanceRenderer.setSize(64, 64);
  await performanceRenderer.init();
  const performanceBackend = performanceRenderer.backend as BackendLike;
  if (!performanceBackend.isWebGPUBackend) {
    throw new Error('M3 performance capture requires WebGPU.');
  }
  const performanceRuntimeRenderer = createThreeRuntimeRenderer(
    performanceRenderer,
    createThreeKernelAdapter({
      backend: 'webgpu',
      linearFloat32Filtering:
        performanceBackend.device?.features?.has('float32-filterable') === true,
      ...(performanceBackend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
        ? {}
        : {
            maxStorageBuffersPerShaderStage:
              performanceBackend.device.limits.maxStorageBuffersPerShaderStage,
          }),
    }),
    performanceBackend.device?.lost,
  );
  const performanceSystem = new VFXSystem(performanceRuntimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  const performanceInstance = performanceSystem.spawn(updateRandomRangeEffect(32), {
    seed: 0x51a7_0e11,
  }) as RuntimeInstance;
  const performanceView = emitter(performanceInstance);
  const performanceUpdateRandomReads =
    performanceView.program.kernels.update.modules.find(({ type }) => type === 'core/gravity')
      ?.access.reads ?? [];
  const performanceUpdateRandomAccessOk = (
    ['Emitter.seed', 'Particles.spawnOrder', 'Emitter.updateRandomStep'] as const
  ).every((key) => performanceUpdateRandomReads.includes(key));
  const performanceMesh = materializeThreeSpriteDraw(
    performanceView.program,
    performanceView.kernels,
    0,
    { resolveTexture },
  );
  const performanceScene = new THREE.Scene();
  performanceScene.add(performanceMesh);
  const performanceTarget = new THREE.RenderTarget(64, 64, { depthBuffer: true });
  const performanceMonitor = createPerformanceMonitor(performanceRenderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm3-sprites',
  });
  await performanceSystem.update(0);
  performanceRenderer.setRenderTarget(performanceTarget);
  await performanceMonitor.captureGpuSamples(async () => {
    await performanceSystem.update(STEP);
    performanceRenderer.render(performanceScene, camera);
    await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
  });
  performanceRenderer.setRenderTarget(null);
  const completeValidation = {
    ...validation,
    performanceUpdateRandomAccess: performanceUpdateRandomAccessOk,
  };
  const result = {
    aliveHistory,
    blendMetrics,
    burstCycleDeathOverlap: {
      foreground: burstCyclePixels,
      indirectAlive: burstCycleIndirectAlive,
      physicalAlive: burstCyclePhysicalAlive,
      successfulBirths: burstCycleSuccessfulBirths,
    },
    cutout: {
      centerDifference: cutoutCenterDifference,
      draw: cutoutGeometry,
      hex: cutoutMetrics,
      quad: quadMetrics,
    },
    consoleMessages,
    flipbook: {
      atlasFlipY: flipYColors,
      atlasNoFlip: noFlipColors,
      brightness: flipbookBrightness,
      description: flipbookDescription,
      discreteFrameDifference,
      frameProgressDifference,
      interpolationDifference,
    },
    foreground,
    eventRouting,
    premultipliedOpacityDifference,
    premultipliedTextureDifference,
    m2Regression: {
      movementDelta,
      storageBufferCount: regressionView.program.meta.storageBufferCount,
    },
    performanceUpdateRandomAccess: {
      ok: performanceUpdateRandomAccessOk,
      reads: performanceUpdateRandomReads,
    },
    rateReuseRandomDeterminism: {
      first: {
        alive: rateReuseFirst.alive,
        hash: rateReuseFirst.hash,
        successfulBirths: rateReuseFirst.successfulBirths,
      },
      recordsEqual: rateReuseRecordsEqual,
      threeRunsEqual: rateReuseThreeRunsEqual,
      physicalLayoutInvariant: rateReusePhysicalLayoutInvariant,
      screenshotDeltas: rateReuseScreenshotDeltas,
      maximumScreenshotDelta: rateReuseMaximumScreenshotDelta,
      physicalLayoutScreenshotDelta: rateReusePhysicalLayoutScreenshotDelta,
      perturbedCapacity: {
        alive: rateReusePerturbed.alive,
        capacity: 33,
        hash: rateReusePerturbed.hash,
        successfulBirths: rateReusePerturbed.successfulBirths,
      },
      second: {
        alive: rateReuseSecond.alive,
        hash: rateReuseSecond.hash,
        successfulBirths: rateReuseSecond.successfulBirths,
      },
      third: {
        alive: rateReuseThird.alive,
        hash: rateReuseThird.hash,
        successfulBirths: rateReuseThird.successfulBirths,
      },
    },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(completeValidation).every(Boolean),
    pixelHistory,
    shapes: { facing: facingShape.bounds, stretched: stretchedShape.bounds },
    softParticles: {
      fadeDifference: softFadeDifference,
      hard: hardIntersection,
      hardContribution: hardIntersectionContribution,
      soft: softIntersection,
      softContribution: softIntersectionContribution,
    },
    validation: completeValidation,
  };
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
