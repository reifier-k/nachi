import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  curve,
  defineEffect,
  defineEmitter,
  drag,
  flipbook,
  gradient,
  gravity,
  lifetime,
  meshRenderer,
  positionSphere,
  range,
  sizeOverLife,
  velocityCone,
} from '@nachi/core';
import type { GeometryRef, TextureRef, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';

import { createPerformanceMonitor } from './perf';
import {
  createThreeGeometryResolver,
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeMeshDraw,
  materializeThreeSpriteDraw,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-explosion.css';

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

root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';
const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLDivElement>('#scene');

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
  setTimeScale(timeScale: number): void;
};

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing golden explosion element: ${selector}`);
  return element;
}

function textureRef(uri: string): TextureRef {
  return { assetType: 'texture', kind: 'asset-ref', uri };
}

function geometryRef(uri: string): GeometryRef {
  return { assetType: 'geometry', kind: 'asset-ref', uri };
}

const atlasRef = textureRef('procedural://golden-explosion/flame-atlas');
const motionRef = textureRef('procedural://golden-explosion/flame-motion');
const smokeRef = textureRef('procedural://golden-explosion/smoke');
const debrisRef = geometryRef('procedural://golden-explosion/debris');

const goldenExplosion = defineEffect({
  elements: {
    mainExplosion: defineEmitter({
      capacity: 4,
      init: [positionSphere({ radius: 0.08 }), lifetime(0.9)],
      integration: 'none',
      lifecycle: { duration: 1.8, loopCount: 'infinite' },
      render: billboard({
        blending: 'additive',
        cutout: { vertices: 8 },
        map: flipbook(atlasRef, { cols: 4, motionVectors: motionRef, rows: 2 }),
      }),
      spawn: burst({ count: 3 }),
      update: [
        sizeOverLife(curve([0, 1.7], [0.35, 2.5], [1, 2.9])),
        colorOverLife(gradient([0.85, 0.12, 0.015, 0.75], [1, 0.65, 0.12, 1], [0.02, 0, 0, 0])),
      ],
    }),
    debris: defineEmitter({
      capacity: 40,
      init: [
        positionSphere({ radius: 0.12, surfaceOnly: true }),
        velocityCone({ angle: 68, direction: [0, 1, 0], speed: range(2.2, 4.8) }),
        lifetime(range(0.85, 1.35)),
      ],
      lifecycle: { duration: 1.8, loopCount: 'infinite' },
      render: meshRenderer({
        alignment: { mode: 'velocity' },
        geometry: debrisRef,
      }),
      spawn: burst({ count: 32 }),
      update: [
        gravity(-7.5),
        drag(0.18),
        colorOverLife(gradient([1, 0.36, 0.04, 1], [0.16, 0.04, 0.012, 0.92])),
      ],
    }),
    smoke: defineEmitter({
      capacity: 18,
      init: [
        positionSphere({ radius: 0.18 }),
        velocityCone({ angle: 34, direction: [0, 1, 0], speed: range(0.35, 0.85) }),
        lifetime(range(1.15, 1.65)),
      ],
      lifecycle: { duration: 1.8, loopCount: 'infinite' },
      render: billboard({
        blending: 'alpha',
        map: smokeRef,
        soft: { fadeDistance: 0.05 },
      }),
      spawn: burst({ count: 14 }),
      update: [
        drag(0.12),
        sizeOverLife(curve([0, 0.3], [1, 1.35])),
        colorOverLife(
          gradient([0.18, 0.16, 0.15, 0.32], [0.08, 0.075, 0.08, 0.18], [0.03, 0.03, 0.04, 0]),
        ),
      ],
    }),
  },
});

function proceduralFlameTextures(): { atlas: THREE.DataTexture; motion: THREE.DataTexture } {
  const cellSize = 32;
  const cols = 4;
  const rows = 2;
  const width = cellSize * cols;
  const height = cellSize * rows;
  const atlasData = new Uint8Array(width * height * 4);
  const motionData = new Uint8Array(width * height * 4);
  for (let frame = 0; frame < cols * rows; frame += 1) {
    const frameX = frame % cols;
    const frameY = Math.floor(frame / cols);
    const progress = frame / (cols * rows - 1);
    for (let y = 0; y < cellSize; y += 1) {
      for (let x = 0; x < cellSize; x += 1) {
        const nx = ((x + 0.5) / cellSize) * 2 - 1;
        const ny = ((y + 0.5) / cellSize) * 2 - 1;
        const distance = Math.sqrt(nx * nx + ny * ny);
        const noise = Math.sin((nx * 19 + ny * 13 + frame * 1.7) * 2.1) * 0.08;
        const radius = 0.48 + progress * 0.42 + noise;
        const radial = Math.max(0, Math.min(1, 1 - distance / radius));
        const heat = radial * (1 - progress * 0.42);
        const px = frameX * cellSize + x;
        const py = frameY * cellSize + y;
        const offset = (py * width + px) * 4;
        atlasData[offset] = Math.round(255 * heat);
        atlasData[offset + 1] = Math.round(255 * heat * (0.25 + radial * 0.58));
        atlasData[offset + 2] = Math.round(80 * heat * radial);
        atlasData[offset + 3] = Math.round(255 * Math.pow(radial, 0.65));
        const inverseDistance = distance > 0.0001 ? 1 / distance : 0;
        motionData[offset] = Math.round(128 + nx * inverseDistance * 28);
        motionData[offset + 1] = Math.round(128 + ny * inverseDistance * 28);
        motionData[offset + 2] = 0;
        motionData[offset + 3] = 255;
      }
    }
  }
  const atlas = new THREE.DataTexture(atlasData, width, height);
  const motion = new THREE.DataTexture(motionData, width, height);
  for (const texture of [atlas, motion]) {
    texture.flipY = true;
    texture.generateMipmaps = false;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
  }
  return { atlas, motion };
}

function proceduralSmokeTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const distance = Math.sqrt(nx * nx + ny * ny);
      const noise = 0.84 + Math.sin(nx * 17 + ny * 23) * 0.08;
      const alpha = Math.max(0, Math.min(1, (1 - distance) * 1.4 * noise));
      const offset = (y * size + x) * 4;
      data[offset] = 210;
      data[offset + 1] = 205;
      data[offset + 2] = 215;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.flipY = true;
  texture.generateMipmaps = false;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function debrisGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(0.075, 0.34, 3, 1);
  geometry.translate(0, 0.12, 0);
  return geometry;
}

function compareReadbacks(left: ArrayLike<number>, right: ArrayLike<number>) {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('Golden explosion readbacks were empty or mismatched.');
  }
  let changed = 0;
  let total = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const difference =
      (Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
        Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
        Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0))) /
      3;
    total += difference;
    if (difference > 6) changed += 1;
  }
  const pixels = left.length / 4;
  return { changedPixelRatio: changed / pixels, meanAbsoluteDifference: total / pixels };
}

function brightnessContribution(pixels: ArrayLike<number>, baseline: ArrayLike<number>): number {
  let total = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const luminance =
      (pixels[offset] ?? 0) * 0.2126 +
      (pixels[offset + 1] ?? 0) * 0.7152 +
      (pixels[offset + 2] ?? 0) * 0.0722;
    const baselineLuminance =
      (baseline[offset] ?? 0) * 0.2126 +
      (baseline[offset + 1] ?? 0) * 0.7152 +
      (baseline[offset + 2] ?? 0) * 0.0722;
    total += Math.max(luminance - baselineLuminance, 0);
  }
  return total / (pixels.length / 4);
}

function paintReadback(canvas: HTMLCanvasElement, pixels: ArrayLike<number>): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Golden explosion preview canvas has no 2D context.');
  const image = context.createImageData(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const sourceY = HEIGHT - 1 - y;
    for (let x = 0; x < WIDTH; x += 1) {
      const source = (sourceY * WIDTH + x) * 4;
      const target = (y * WIDTH + x) * 4;
      image.data[target] = pixels[source] ?? 0;
      image.data[target + 1] = pixels[source + 1] ?? 0;
      image.data[target + 2] = pixels[source + 2] ?? 0;
      image.data[target + 3] = pixels[source + 3] ?? 255;
    }
  }
  context.putImageData(image, 0, 0);
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(headless ? WIDTH : innerWidth, headless ? HEIGHT : innerHeight);
  if (!headless) sceneHost.append(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden explosion requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Offscreen validation' : 'Visual';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'golden-explosion',
  });
  const { atlas, motion } = proceduralFlameTextures();
  const smoke = proceduralSmokeTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [atlasRef.uri, atlas],
      [motionRef.uri, motion],
      [smokeRef.uri, smoke],
    ]),
  );
  const resolveGeometry = createThreeGeometryResolver(new Map([[debrisRef.uri, debrisGeometry()]]));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050711);
  const camera = new THREE.OrthographicCamera(-3, 3, 2.25, -2.25, 0.1, 20);
  camera.position.set(0, 0.35, 5);
  camera.lookAt(0, 0.25, 0);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 5),
    new THREE.MeshBasicMaterial({ color: 0x080c18 }),
  );
  ground.position.set(0, -1.25, -0.6);
  scene.add(ground);
  const intersectionRock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 1),
    new THREE.MeshBasicMaterial({ color: 0x232938 }),
  );
  intersectionRock.position.set(0.32, -0.18, 0);
  intersectionRock.scale.set(1.2, 0.72, 0.8);
  scene.add(intersectionRock);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });

  const emitterView = (instance: RuntimeInstance, key: string): VfxEmitterRuntimeView => {
    const view = instance.getEmitter(key);
    if (!view) throw new Error(`Golden explosion emitter "${key}" is missing.`);
    return view;
  };
  const createRuntime = async (seed: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { maxSubSteps: 64, stepSeconds: STEP },
    });
    const instance = system.spawn(goldenExplosion, { seed }) as RuntimeInstance;
    const mainView = emitterView(instance, 'mainExplosion');
    const debrisView = emitterView(instance, 'debris');
    const smokeView = emitterView(instance, 'smoke');
    const main = materializeThreeSpriteDraw(mainView.program, mainView.kernels, 0, {
      resolveTexture,
    });
    const debris = materializeThreeMeshDraw(debrisView.program, debrisView.kernels, 0, {
      resolveGeometry,
    });
    const smokeMesh = materializeThreeSpriteDraw(smokeView.program, smokeView.kernels, 0, {
      resolveTexture,
    });
    main.position.z = 1.05;
    debris.position.z = 0.82;
    smokeMesh.position.z = 0.67;
    await system.update(0);
    await system.update(STEP);
    return { debris, instance, main, mainView, smoke: smokeMesh, system };
  };
  const mainNormalizedAge = async (runtime: Awaited<ReturnType<typeof createRuntime>>) => {
    const ages = (await readLogicalAttribute(
      renderer,
      runtime.mainView.program,
      runtime.mainView.kernels,
      'normalizedAge',
    )) as Float32Array;
    return Math.max(...ages);
  };
  const render = async (objects: readonly THREE.Object3D[]) => {
    for (const object of objects) scene.add(object);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT);
    renderer.setRenderTarget(null);
    for (const object of objects) scene.remove(object);
    return pixels;
  };

  const baseline = await render([]);
  const primary = await createRuntime(2026);
  const earlyMain = await render([primary.main]);
  const earlyMainDebris = await render([primary.main, primary.debris]);
  const earlyAll = await render([primary.main, primary.debris, primary.smoke]);
  const earlyMainAge = await mainNormalizedAge(primary);
  await primary.system.update(0.34);
  const peakMain = await render([primary.main]);
  const peakAll = await render([primary.main, primary.debris, primary.smoke]);
  const peakMainAge = await mainNormalizedAge(primary);
  await primary.system.update(0.4);
  const lateMain = await render([primary.main]);
  const lateAll = await render([primary.main, primary.debris, primary.smoke]);
  const lateMainAge = await mainNormalizedAge(primary);

  const duplicate = await createRuntime(2026);
  const duplicateEarly = await render([duplicate.main, duplicate.debris, duplicate.smoke]);
  const mainContribution = compareReadbacks(earlyMain, baseline);
  const debrisContribution = compareReadbacks(earlyMainDebris, earlyMain);
  const smokeContribution = compareReadbacks(earlyAll, earlyMainDebris);
  const deterministicDifference = compareReadbacks(earlyAll, duplicateEarly);
  const brightnessCurve = {
    early: brightnessContribution(earlyMain, baseline),
    late: brightnessContribution(lateMain, baseline),
    peak: brightnessContribution(peakMain, baseline),
  };
  const validation = {
    consoleClean: consoleMessages.length === 0,
    debrisContribution: debrisContribution.changedPixelRatio > 0.0002,
    deterministic:
      deterministicDifference.changedPixelRatio === 0 &&
      deterministicDifference.meanAbsoluteDifference === 0,
    mainContribution: mainContribution.changedPixelRatio > 0.003,
    smokeContribution: smokeContribution.changedPixelRatio > 0.0005,
    timeEvolution:
      brightnessCurve.peak > brightnessCurve.early * 1.2 &&
      brightnessCurve.peak > brightnessCurve.late * 1.2,
  };
  const result = {
    brightnessCurve,
    consoleMessages,
    contributions: { debris: debrisContribution, main: mainContribution, smoke: smokeContribution },
    deterministicDifference,
    mainNormalizedAge: { early: earlyMainAge, late: lateMainAge, peak: peakMainAge },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    validation,
  };
  paintReadback(requireElement<HTMLCanvasElement>('#golden-early'), earlyAll);
  paintReadback(requireElement<HTMLCanvasElement>('#golden-peak'), peakAll);
  paintReadback(requireElement<HTMLCanvasElement>('#golden-late'), lateAll);
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-explosion-early.png', selector: '#golden-early' },
    { filename: 'golden-explosion-peak.png', selector: '#golden-peak' },
    { filename: 'golden-explosion-late.png', selector: '#golden-late' },
  ]);
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'Golden explosion verified' : 'Golden explosion failed';

  if (!headless) {
    scene.add(duplicate.main, duplicate.debris, duplicate.smoke);
    const settings = { debris: true, explosionScale: 1, playbackSpeed: 1, smoke: true };
    const pane = new Pane({ title: 'Explosion controls' });
    pane.addBinding(settings, 'playbackSpeed', { label: 'Playback', max: 2, min: 0, step: 0.05 });
    pane.addBinding(settings, 'explosionScale', { label: 'Scale', max: 2, min: 0.25, step: 0.05 });
    pane.addBinding(settings, 'debris', { label: 'Debris' });
    pane.addBinding(settings, 'smoke', { label: 'Smoke' });
    let previous: number | undefined;
    let updating = false;
    renderer.setAnimationLoop((timestamp) => {
      if (updating) return;
      const delta = previous === undefined ? STEP : Math.min((timestamp - previous) / 1000, 0.1);
      previous = timestamp;
      duplicate.instance.setTimeScale(settings.playbackSpeed);
      duplicate.main.scale.setScalar(settings.explosionScale);
      duplicate.debris.visible = settings.debris;
      duplicate.smoke.visible = settings.smoke;
      updating = true;
      void duplicate.system
        .update(delta)
        .then(() => {
          renderer.render(scene, camera);
          performanceMonitor.recordFrame(timestamp);
        })
        .finally(() => {
          updating = false;
        });
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
