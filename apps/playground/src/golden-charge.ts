import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  curve,
  defineEffect,
  defineEmitter,
  drag,
  gradient,
  intensityOverLife,
  lifetime,
  lightIntensity,
  lightRenderer,
  pointAttractor,
  positionSphere,
  rate,
  sizeOverLife,
  velocityCone,
  type EffectInstanceState,
  type VfxEmitterRuntimeView,
} from '@nachi-vfx/core';
import {
  createCylinderGeometry,
  createMagicCircleGeometry,
  fxMaterial,
  polarUV,
  uvFlow,
} from '@nachi-vfx/mesh-fx';
import { dissolveCpu, polarUVCpu, uvFlowCpu } from '@nachi-vfx/tsl-kit/math';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { readLogicalAttribute } from './three-runtime-readback';
import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-charge.css';

const WIDTH = 640;
const HEIGHT = 400;
const PROBE_SIZE = 96;
const STEP = 1 / 60;
const MAP_WIDTH = 32;
const DISSOLVE_SIZE = 8;
const DISSOLVE_LIFE = 0.65;
const DISSOLVE_THRESHOLD = 0.92 + (0.05 - 0.92) * DISSOLVE_LIFE;
const DISSOLVE_EDGE_WIDTH = 0.04;
const ATTRACTOR_STRENGTH = 14;
const DRAG_COEFFICIENT = 4.2;
const INITIAL_RADIUS = 1.55;
const PIXEL_DIFFERENCE_THRESHOLD = 10;
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
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'running';
root.dataset.goldenScope = JSON.stringify({
  M8: true,
  M9: 'timeline choreography',
  M10: 'bloom/post',
});

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
  release(): void;
  readonly state: EffectInstanceState;
};

type Pixels = Uint8Array;
type Rgb = readonly [number, number, number];

function required<ElementType extends Element>(selector: string): ElementType {
  const value = document.querySelector<ElementType>(selector);
  if (!value) throw new Error(`Missing golden charge element: ${selector}`);
  return value;
}

function emitter(instance: RuntimeInstance, key: string): VfxEmitterRuntimeView {
  const value = instance.getEmitter(key);
  if (!value) throw new Error(`Missing golden charge emitter: ${key}`);
  return value;
}

function irregularTexel(index: number): Rgb {
  const red = (index * 53 + index * index * 7 + 29) % 256;
  return [red, (255 - red + index * 11) % 256, (index * 37 + 73) % 256];
}

function angularTexture(): THREE.DataTexture {
  const data = new Uint8Array(MAP_WIDTH * 4);
  for (let index = 0; index < MAP_WIDTH; index += 1)
    data.set([...irregularTexel(index), 255], index * 4);
  const texture = new THREE.DataTexture(data, MAP_WIDTH, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function dissolveTexture(): THREE.DataTexture {
  const data = new Uint8Array(DISSOLVE_SIZE * DISSOLVE_SIZE * 4);
  for (let y = 0; y < DISSOLVE_SIZE; y += 1) {
    for (let x = 0; x < DISSOLVE_SIZE; x += 1) {
      const noise = (x + y) % 2 === 1 ? 216 : 48;
      data.set([noise, noise, noise, 255], (y * DISSOLVE_SIZE + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, DISSOLVE_SIZE, DISSOLVE_SIZE, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function beamTexture(): THREE.DataTexture {
  const data = new Uint8Array(16 * 4);
  for (let index = 0; index < 16; index += 1) {
    const pulse = index % 5 === 0 ? 255 : 60 + index * 7;
    data.set([20, pulse, 255, 255], index * 4);
  }
  const texture = new THREE.DataTexture(data, 1, 16, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function sampleAngular(uvX: number): Rgb {
  const wrapped = uvX - Math.floor(uvX);
  return irregularTexel(Math.min(MAP_WIDTH - 1, Math.floor(wrapped * MAP_WIDTH)));
}

function sampleDissolve(uv: readonly [number, number]): number {
  const x = Math.min(DISSOLVE_SIZE - 1, Math.floor((uv[0] - Math.floor(uv[0])) * DISSOLVE_SIZE));
  const y = Math.min(DISSOLVE_SIZE - 1, Math.floor((uv[1] - Math.floor(uv[1])) * DISSOLVE_SIZE));
  return (x + y) % 2 === 1 ? 216 : 48;
}

function rgb(pixels: Pixels, x: number, row: number, width: number): Rgb {
  const offset = (row * width + x) * 4;
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function rgbMatches(actual: Rgb, expected: Rgb): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= 4);
}

function energyAt(pixels: Pixels, x: number, row: number, width: number): number {
  const value = rgb(pixels, x, row, width);
  return value[0] + value[1] + value[2];
}

function changedPixels(left: Pixels, right: Pixels): number {
  return differenceStats(left, right).changedPixels;
}

function differenceStats(
  left: Pixels,
  right: Pixels,
): { changedPixels: number; maximumDifference: number; totalDifference: number } {
  let changed = 0;
  let maximumDifference = 0;
  let totalDifference = 0;
  for (let index = 0; index < left.length; index += 4) {
    const difference =
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)) +
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)) +
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0));
    totalDifference += difference;
    maximumDifference = Math.max(maximumDifference, difference);
    if (difference > PIXEL_DIFFERENCE_THRESHOLD) changed += 1;
  }
  return { changedPixels: changed, maximumDifference, totalDifference };
}

function imageStats(pixels: Pixels): { foregroundRatio: number; saturatedRatio: number } {
  let foreground = 0;
  let saturated = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const sum = (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0);
    if (sum > 30) foreground += 1;
    if (sum > 744) saturated += 1;
  }
  const count = pixels.length / 4;
  return { foregroundRatio: foreground / count, saturatedRatio: saturated / count };
}

function meanRadius(position: Float32Array, alive: Uint32Array): number {
  let count = 0;
  let total = 0;
  for (let index = 0; index < alive.length; index += 1) {
    if ((alive[index] ?? 0) === 0) continue;
    total += Math.hypot(
      position[index * 3] ?? 0,
      position[index * 3 + 1] ?? 0,
      position[index * 3 + 2] ?? 0,
    );
    count += 1;
  }
  return total / count;
}

function analyticConvergenceRadius(time: number): number {
  const dragPhase = (1 - Math.exp(-DRAG_COEFFICIENT * time)) / DRAG_COEFFICIENT;
  return INITIAL_RADIUS - (ATTRACTOR_STRENGTH / DRAG_COEFFICIENT) * (time - dragPhase);
}

function paint(canvas: HTMLCanvasElement, pixels: Pixels): void {
  canvas
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(pixels), WIDTH, HEIGHT), 0, 0);
}

const convergenceDefinition = defineEmitter({
  capacity: 96,
  init: [
    positionSphere({ radius: INITIAL_RADIUS, surfaceOnly: true }),
    velocityCone({ angle: 0, direction: [0, 1, 0], speed: 0 }),
    lifetime(4),
  ],
  render: billboard({ blending: 'additive' }),
  spawn: burst({ count: 80 }),
  update: [
    pointAttractor({ falloff: 0, position: [0, 0, 0], strength: ATTRACTOR_STRENGTH }),
    drag(DRAG_COEFFICIENT),
    sizeOverLife(curve([0, 0.055], [0.7, 0.035], [1, 0.012])),
    colorOverLife(gradient('#d8fbff', '#56d9ff', '#b64fff')),
  ],
});

const lightDefinition = defineEmitter({
  capacity: 6,
  init: [positionSphere({ radius: 0.04 }), lifetime(3), lightIntensity(1)],
  integration: 'none',
  render: lightRenderer({ maxLights: 4, priority: 'intensity-radius', radiusScale: 2.5 }),
  spawn: burst({ count: 6 }),
  update: [
    colorOverLife(gradient('#bff8ff', '#9966ff')),
    intensityOverLife(curve([0, 2], [0.5, 9], [1, 16])),
    sizeOverLife(curve([0, 0.8], [1, 2.2])),
  ],
});

async function measurePerformance(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setSize(64, 64);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend)
    throw new Error('Golden charge performance capture requires WebGPU.');
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const system = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const instance = system.spawn(defineEffect({ elements: { particles: convergenceDefinition } }), {
    seed: 8301,
  }) as RuntimeInstance;
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'golden-charge',
  });
  const target = new THREE.RenderTarget(64, 64);
  const scene = new THREE.Scene();
  const view = emitter(instance, 'particles');
  scene.add(materializeThreeSpriteDraw(view.program, view.kernels));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  camera.position.z = 4;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  system.setCamera({
    projectionMatrix: camera.projectionMatrix.elements,
    viewMatrix: camera.matrixWorldInverse.elements,
    viewportSize: [64, 64],
  });
  renderer.setRenderTarget(target);
  await system.update(0);
  renderer.render(scene, camera);
  await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  await renderer.resolveTimestampsAsync('compute');
  await renderer.resolveTimestampsAsync('render');
  await monitor.captureGpuSamples(async () => {
    await system.update(STEP);
    renderer.render(scene, camera);
  });
  instance.release();
  target.dispose();
  renderer.dispose();
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.setClearColor(0x010208, 1);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden charge M8 requires WebGPU.');
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';

  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const convergenceSystem = new VFXSystem(runtime, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  const convergenceInstance = convergenceSystem.spawn(
    defineEffect({ elements: { particles: convergenceDefinition } }),
    { seed: 8302 },
  ) as RuntimeInstance;
  await convergenceSystem.update(0);
  const convergenceView = emitter(convergenceInstance, 'particles');
  const readRadius = async () => {
    const [position, alive] = await Promise.all([
      readLogicalAttribute(renderer, convergenceView.program, convergenceView.kernels, 'position'),
      readLogicalAttribute(renderer, convergenceView.program, convergenceView.kernels, 'alive'),
    ]);
    return meanRadius(position as Float32Array, alive as Uint32Array);
  };
  const radii = [await readRadius()];
  for (let frame = 0; frame < 12; frame += 1) await convergenceSystem.update(STEP);
  radii.push(await readRadius());
  for (let frame = 0; frame < 12; frame += 1) await convergenceSystem.update(STEP);
  radii.push(await readRadius());
  const radiusTimes = [0, 12 * STEP, 24 * STEP];
  const analyticRadii = radiusTimes.map(analyticConvergenceRadius);
  const radiusRelativeErrors = radii.map(
    (radius, index) => Math.abs(radius - analyticRadii[index]!) / analyticRadii[index]!,
  );

  const lightSystem = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const lightInstance = lightSystem.spawn(defineEffect({ elements: { light: lightDefinition } }), {
    position: [0, 0.25, 0],
    seed: 8303,
  }) as RuntimeInstance;
  await lightSystem.update(0);
  for (let frame = 0; frame < 45; frame += 1) await lightSystem.update(STEP);
  const lightView = emitter(lightInstance, 'light');
  const lightDraw = materializeThreeLightDraw(lightView.program, lightView.kernels);
  await lightDraw.update(renderer);
  const lightStats = await lightDraw.update(renderer);

  const stressDefinition = defineEmitter({
    capacity: 64,
    init: [
      positionSphere({ radius: 1.8, surfaceOnly: true }),
      velocityCone({ angle: 0, direction: [0, 1, 0], speed: 0 }),
      lifetime(20),
    ],
    lifecycle: { duration: 10 },
    render: billboard({ blending: 'additive' }),
    spawn: rate(480),
    update: [pointAttractor({ falloff: 0, position: [0, 0, 0], strength: 8 }), drag(4)],
  });
  const stressSystem = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const stressInstance = stressSystem.spawn(
    defineEffect({ elements: { stress: stressDefinition } }),
    {
      seed: 8304,
    },
  ) as RuntimeInstance;
  await stressSystem.update(0);
  for (let frame = 0; frame < 600; frame += 1) await stressSystem.update(STEP);
  const stressView = emitter(stressInstance, 'stress');
  const [stressAlive, stressPosition] = await Promise.all([
    readLogicalAttribute(renderer, stressView.program, stressView.kernels, 'alive'),
    readLogicalAttribute(renderer, stressView.program, stressView.kernels, 'position'),
  ]);
  const stressAliveCount = Array.from(stressAlive as Uint32Array).filter(Boolean).length;
  const stressFinite = Array.from(stressPosition as Float32Array).every(Number.isFinite);

  const map = angularTexture();
  const dissolveMap = dissolveTexture();
  const beamMap = beamTexture();
  const magicGeometry = createMagicCircleGeometry({
    radius: 0.92,
    rings: 4,
    segments: 80,
    thetaStart: 0.11,
  });
  const magicMaterial = fxMaterial({
    blending: 'additive',
    dissolve: {
      edgeColor: '#ffffff',
      edgeWidth: DISSOLVE_EDGE_WIDTH,
      overLife: [
        [0, 0.92],
        [1, 0.05],
      ],
      texture: dissolveMap,
    },
    map,
    uv: polarUV({ rotation: 0.23 }).flow({ speed: [0.21, 0] }),
  });
  magicMaterial.fx.setTime(0.7);
  magicMaterial.fx.setNormalizedLife(DISSOLVE_LIFE);
  const magicWithoutDissolveMaterial = fxMaterial({
    blending: 'additive',
    map,
    uv: polarUV({ rotation: 0.23 }).flow({ speed: [0.21, 0] }),
  });
  magicWithoutDissolveMaterial.fx.setTime(0.7);
  const beamMaterial = fxMaterial({
    blending: 'additive',
    map: beamMap,
    opacity: 0.82,
    uv: uvFlow({ speed: [0, -0.8] }),
  });
  beamMaterial.fx.setTime(0.7);

  const probeTarget = new THREE.RenderTarget(PROBE_SIZE, PROBE_SIZE, { depthBuffer: true });
  const probeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  probeCamera.position.z = 3;
  const probeScene = new THREE.Scene();
  const probeMesh = new THREE.Mesh(magicGeometry, magicMaterial);
  probeScene.add(probeMesh);
  renderer.setRenderTarget(probeTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(probeScene, probeCamera);
  const magicPixels = compactRgba8Readback(
    new Uint8Array(
      await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, PROBE_SIZE, PROBE_SIZE),
    ),
    PROBE_SIZE,
    PROBE_SIZE,
    true,
  );
  probeMesh.material = magicWithoutDissolveMaterial;
  renderer.clear();
  renderer.render(probeScene, probeCamera);
  const magicWithoutDissolvePixels = compactRgba8Readback(
    new Uint8Array(
      await renderer.readRenderTargetPixelsAsync(probeTarget, 0, 0, PROBE_SIZE, PROBE_SIZE),
    ),
    PROBE_SIZE,
    PROBE_SIZE,
    true,
  );
  probeMesh.material = magicMaterial;
  const magicDissolveDifference = differenceStats(magicPixels, magicWithoutDissolvePixels);
  const approximateWorld = [0.31, 0.18] as const;
  const sampleX = Math.round(((approximateWorld[0] + 1) * PROBE_SIZE) / 2 - 0.5);
  const sampleBottom = Math.round(((approximateWorld[1] + 1) * PROBE_SIZE) / 2 - 0.5);
  const sampleWorld = [
    ((sampleX + 0.5) / PROBE_SIZE) * 2 - 1,
    ((sampleBottom + 0.5) / PROBE_SIZE) * 2 - 1,
  ] as const;
  const sourceUv = [sampleWorld[0] / (2 * 0.92) + 0.5, sampleWorld[1] / (2 * 0.92) + 0.5] as const;
  const transformedUv = uvFlowCpu(polarUVCpu(sourceUv, { rotation: 0.23 }), [0.21, 0], 0.7);
  const expectedMagic = sampleAngular(transformedUv[0]);
  const mirrorUv = [sourceUv[0], 1 - sourceUv[1]] as const;
  const transformedMirrorUv = uvFlowCpu(polarUVCpu(mirrorUv, { rotation: 0.23 }), [0.21, 0], 0.7);
  const expectedMirrorMagic = sampleAngular(transformedMirrorUv[0]);
  const expectedDissolveNoise = sampleDissolve(transformedUv) / 255;
  const expectedDissolve = dissolveCpu(
    expectedDissolveNoise,
    DISSOLVE_THRESHOLD,
    DISSOLVE_EDGE_WIDTH,
  );
  const sampleRow = PROBE_SIZE - 1 - sampleBottom;
  const mirrorRow = sampleBottom;
  const actualMagic = rgb(magicPixels, sampleX, sampleRow, PROBE_SIZE);
  const mirrorEnergy = energyAt(magicPixels, sampleX, mirrorRow, PROBE_SIZE);

  const camera = new THREE.PerspectiveCamera(43, WIDTH / HEIGHT, 0.1, 30);
  camera.position.set(0, 2.5, 5.1);
  camera.lookAt(0, 0.15, 0);
  const circle = new THREE.Mesh(magicGeometry, magicMaterial);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = -0.72;
  const beam = new THREE.Mesh(
    createCylinderGeometry({ radius: 0.16, height: 2.8, radialSegments: 48, heightSegments: 6 }),
    beamMaterial,
  );
  beam.position.y = 0.55;
  const particleMesh = materializeThreeSpriteDraw(convergenceView.program, convergenceView.kernels);
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.8),
    new THREE.MeshStandardNodeMaterial({ color: 0x132340, metalness: 0, roughness: 0.78 }),
  );
  // Keep the receiver in front of the selected lights' illumination direction. The previous sphere
  // enclosed the lights, so its outward-facing normals measured almost no direct illumination.
  receiver.position.set(0, 0.05, -0.75);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010208);
  scene.add(circle, beam, particleMesh, receiver, lightDraw.group);
  scene.add(new THREE.HemisphereLight(0x223366, 0x020208, 0.18));
  const visualTarget = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  const renderVisual = async (): Promise<Pixels> => {
    renderer.setRenderTarget(visualTarget);
    renderer.clear();
    renderer.render(scene, camera);
    return compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(visualTarget, 0, 0, WIDTH, HEIGHT)),
      WIDTH,
      HEIGHT,
      true,
    );
  };
  circle.visible = false;
  particleMesh.visible = false;
  receiver.visible = false;
  lightDraw.group.visible = false;
  beam.visible = false;
  const blank = await renderVisual();
  beam.visible = true;
  beamMaterial.fx.setTime(0);
  const beamAtZero = await renderVisual();
  beamMaterial.fx.setTime(0.7);
  const beamOnly = await renderVisual();
  beam.visible = false;
  particleMesh.visible = true;
  const particlesOnly = await renderVisual();
  particleMesh.visible = false;
  receiver.visible = true;
  const receiverUnlit = await renderVisual();
  lightDraw.group.visible = true;
  const receiverLit = await renderVisual();
  circle.visible = true;
  beam.visible = true;
  particleMesh.visible = true;
  receiver.visible = true;
  lightDraw.group.visible = true;
  const combined = await renderVisual();
  renderer.setRenderTarget(null);
  const visual = imageStats(combined);
  paint(required<HTMLCanvasElement>('#golden-charge'), combined);
  const beamPixels = changedPixels(beamOnly, blank);
  const beamFlowDifference = differenceStats(beamOnly, beamAtZero);
  const particlePixels = changedPixels(particlesOnly, blank);
  const lightDifference = differenceStats(receiverLit, receiverUnlit);
  const lightPixels = lightDifference.changedPixels;
  await measurePerformance();
  const validation = {
    beamReadback: beamPixels > 120,
    beamUvFlow: beamFlowDifference.changedPixels > 120,
    consoleClean: consoleMessages.length === 0,
    convergence:
      radii[0]! > radii[1]! &&
      radii[1]! > radii[2]! &&
      radiusRelativeErrors.every((error) => error <= 0.03),
    lightReadback:
      lightStats.selectedCount === 4 && lightStats.candidateCount === 6 && lightPixels > 40,
    magicExpectedTexel: rgbMatches(actualMagic, expectedMagic),
    magicPartialDissolve:
      48 / 255 < DISSOLVE_THRESHOLD &&
      216 / 255 > DISSOLVE_THRESHOLD + DISSOLVE_EDGE_WIDTH &&
      expectedDissolve.coverage === 1 &&
      expectedDissolve.edge === 0 &&
      magicDissolveDifference.changedPixels > 120,
    magicNonMirror:
      sampleWorld[1] > 0.1 &&
      !rgbMatches(actualMagic, expectedMirrorMagic) &&
      energyAt(magicPixels, sampleX, sampleRow, PROBE_SIZE) !== mirrorEnergy,
    particlesRendered: particlePixels > 60,
    saturationLongRun: stressAliveCount === 64 && stressFinite,
    visualReadback:
      visual.foregroundRatio > 0.018 &&
      visual.foregroundRatio < 0.48 &&
      visual.saturatedRatio < 0.1,
  };
  const result = {
    beam: {
      changedPixels: beamPixels,
      flow: 'uv.y + speed.y * effectTime',
      timeDifference: beamFlowDifference,
    },
    consoleMessages,
    lightPixels,
    light: {
      ...lightStats,
      ...lightDifference,
      differenceThreshold: PIXEL_DIFFERENCE_THRESHOLD,
      lightPixels,
      readbackLatencyFrames: 1,
      receiver: { geometry: 'front-facing-plane', position: receiver.position.toArray() },
    },
    magicCircle: {
      actual: actualMagic,
      dissolve: {
        differenceFromDisabled: magicDissolveDifference,
        expectedAtSample: expectedDissolve,
        expectedNoiseAtSample: expectedDissolveNoise,
        life: DISSOLVE_LIFE,
        noiseBytes: [48, 216],
        threshold: DISSOLVE_THRESHOLD,
      },
      expected: expectedMagic,
      expectedMirror: expectedMirrorMagic,
      mirrorEnergy,
      sampleWorld,
      transformedUv,
    },
    ok: Object.values(validation).every(Boolean),
    particles: {
      analyticRadii,
      changedPixels: particlePixels,
      radii,
      radiusRelativeErrors,
      radiusTimes,
    },
    measurements: {
      beamPixels,
      lightPixels,
      particlePixels,
      analyticRadii,
      radii,
      radiusRelativeErrors,
      stressAliveCount,
      stressFinite,
      visual,
    },
    scope: { M8: true, M9: 'timeline choreography', M10: 'bloom/post' },
    stress: { aliveCount: stressAliveCount, finite: stressFinite, frames: 600 },
    validation,
    visual: { ...visual, source: 'offscreen-rgba8-readback-to-2d-canvas' },
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-charge.png', selector: '#golden-charge' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'Golden charge verified'
    : 'Golden charge failed';

  probeTarget.dispose();
  visualTarget.dispose();
  map.dispose();
  dissolveMap.dispose();
  beamMap.dispose();
  magicGeometry.dispose();
  beam.geometry.dispose();
  receiver.geometry.dispose();
  magicMaterial.dispose();
  magicWithoutDissolveMaterial.dispose();
  beamMaterial.dispose();
  (receiver.material as THREE.Material).dispose();
}

void run().catch((error: unknown) => {
  console.error(error);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  });
  required<HTMLElement>('#status-value').textContent = 'Golden charge failed';
});
