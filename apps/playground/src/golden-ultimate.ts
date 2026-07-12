import {
  billboard,
  burst,
  colorOverLife,
  createCoreKernelModuleRegistry,
  curve,
  defineEmitter,
  drag,
  gradient,
  lifetime,
  lightIntensity,
  lightRenderer,
  positionSphere,
  range,
  rate,
  sizeOverLife,
  velocityCone,
  type TextureRef,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import {
  EFFECT_ASSET_FORMAT,
  EFFECT_ASSET_VERSION,
  loadEffect,
  serializeEffect,
} from '@nachi/format';
import { ring, slashArc } from '@nachi/mesh-fx';
import { bloomPreset, createPostPipeline, radialBlur, screenDistortion } from '@nachi/post';
import {
  VFXSystem,
  at,
  bindMeshFxResources,
  cameraShake,
  defineEffect,
  fxMaterial,
  getMeshFxResources,
  hitStop,
  marker,
  meshFxElement,
  play,
  stop,
  timeline,
  type CameraShakeSample,
  type TimelineEffectInstance,
} from '@nachi/timeline';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi/trails';
import { materializeThreeRibbonDraw, readRibbonSegments } from '@nachi/trails/three';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-ultimate.css';

const WIDTH = 512;
const HEIGHT = 320;
const STEP = 1 / 60;
const PARTICLE_FADE_COLOR = '#6b2cff00';
const TRAIL_FADE_COLOR = '#b347ff00';
const root = document.documentElement;
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

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { maxStorageBuffersPerShaderStage?: number };
    readonly lost: Promise<{ message?: string; reason?: string }>;
  };
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing golden ultimate element: ${selector}`);
  return value;
}

function normalMap(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const nx = ((x + 0.5) / size) * 1.3 - 0.65;
      const ny = ((y + 0.5) / size) * 0.7 - 0.35;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const offset = (y * size + x) * 4;
      data.set(
        [
          Math.round((nx * 0.5 + 0.5) * 255),
          Math.round((ny * 0.5 + 0.5) * 255),
          Math.round((nz * 0.5 + 0.5) * 255),
          255,
        ],
        offset,
      );
    }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function noiseMap(): THREE.DataTexture {
  const values = [15, 210, 65, 240, 130, 35, 190, 85, 225, 55, 165, 105, 30, 200, 75, 245];
  const texture = new THREE.DataTexture(
    new Uint8Array(values.flatMap((value) => [value, value, value, 255])),
    4,
    4,
    THREE.RGBAFormat,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createUltimate(normalRef: TextureRef, noise: THREE.Texture, loop = false) {
  const particles = defineEmitter({
    capacity: 64,
    init: [
      positionSphere({ radius: 0.14 }),
      velocityCone({ direction: [0.75, 0.35, 0], angle: 70, speed: range(1.4, 4.2) }),
      lifetime(range(0.45, 0.85)),
    ],
    render: billboard({
      blending: 'alpha',
      lit: { normalMap: normalRef, roughness: 0.74 },
      sorted: true,
    }),
    spawn: burst({ count: 42 }),
    update: [
      drag(0.8),
      sizeOverLife(curve([0, 0.2], [0.3, 0.13], [1, 0])),
      colorOverLife(gradient('#f6fbff', '#79cfff', PARTICLE_FADE_COLOR)),
    ],
  });
  const trail = defineEmitter({
    attributes: { ribbonId: ribbonIdAttribute() },
    capacity: 48,
    init: [
      positionSphere({ radius: 0.05 }),
      velocityCone({ direction: [0.9, 0.2, 0], angle: 28, speed: range(1.5, 3.4) }),
      lifetime(0.7),
      ribbonId(0),
    ],
    lifecycle: { duration: 0.45 },
    render: ribbon({
      blending: 'additive',
      maxRibbons: 1,
      taper: { start: 0.08, end: 0.48 },
      uv: { mode: 'stretched' },
      width: 0.16,
    }),
    spawn: rate(100),
    update: [drag(0.35), colorOverLife(gradient('#ffffff', '#55d8ff', TRAIL_FADE_COLOR))],
  });
  const flash = defineEmitter({
    capacity: 1,
    init: [positionSphere({ radius: 0 }), lifetime(0.34), lightIntensity(16)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      sizeOverLife(curve([0, 2.4], [1, 0.2])),
      colorOverLife(gradient('#fff1d6', '#65c8ff')),
    ],
  });
  const arc = meshFxElement(
    slashArc({
      angle: 156,
      innerRadius: 0.72,
      radius: 1.75,
      rotation: 10,
      taper: 0.76,
      material: fxMaterial({
        blending: 'additive',
        color: '#65dfff',
        dissolve: {
          edgeColor: '#ffffff',
          edgeWidth: 0.07,
          overLife: curve([0, 0], [0.35, 0.18], [1, 1]),
          texture: noise,
        },
        fresnel: { color: '#e9fbff', power: 2 },
      }),
    }),
    { duration: 0.7 },
  );
  const shockwave = meshFxElement(
    ring({
      innerRadius: 0.72,
      outerRadius: 0.83,
      segments: 80,
      material: fxMaterial({ blending: 'additive', color: '#bd6cff', opacity: 0.86 }),
    }),
    { duration: 0.3 },
  );
  return defineEffect({
    elements: { arc, flash, particles, shockwave, trail },
    timeline: timeline(
      [
        at(0, play('flash')),
        at(0.04, play('trail')),
        at(
          0.06,
          play('arc'),
          cameraShake({ duration: 0.24, frequency: 28, strength: 0.28 }),
          hitStop(45),
          marker('impact'),
        ),
        at(0.09, play('particles')),
        at(0.12, play('shockwave'), marker('post-start')),
        at(0.35, stop('shockwave')),
        at(0.45, stop('trail')),
        at(0.55, stop('particles')),
        at(0.62, stop('arc')),
      ],
      { duration: 0.72, ...(loop ? { loop: true } : {}) },
    ),
  });
}

function loadUltimateFromJson(
  definition: ReturnType<typeof createUltimate>,
): ReturnType<typeof createUltimate> {
  const document = serializeEffect(definition);
  const loaded = loadEffect(JSON.stringify(document));
  const resources = getMeshFxResources(definition);
  bindMeshFxResources(loaded, ({ resource }) => resources.get(resource)?.mesh);
  return loaded as unknown as ReturnType<typeof createUltimate>;
}

function cameraState(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  return {
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportSize: [WIDTH, HEIGHT] as const,
  };
}

function changedPixels(left: Uint8Array, right: Uint8Array): number {
  let changed = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const delta =
      Math.abs(left[offset]! - right[offset]!) +
      Math.abs(left[offset + 1]! - right[offset + 1]!) +
      Math.abs(left[offset + 2]! - right[offset + 2]!);
    if (delta > 12) changed += 1;
  }
  return changed;
}

function stats(pixels: Uint8Array) {
  let foreground = 0;
  let saturated = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const sum = pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!;
    if (sum > 30) foreground += 1;
    if (sum > 744) saturated += 1;
  }
  const count = pixels.length / 4;
  return { foregroundRatio: foreground / count, saturatedRatio: saturated / count };
}

function capturePlayedEmitter(
  captures: Map<string, VfxEmitterRuntimeView>,
  action: { readonly kind: string; readonly target?: string },
  emitter: VfxEmitterRuntimeView | undefined,
): void {
  if (action.kind === 'play' && action.target !== undefined && emitter !== undefined) {
    captures.set(action.target, emitter);
  }
}

function requireCapturedEmitter(
  captures: ReadonlyMap<string, VfxEmitterRuntimeView>,
  instance: Pick<TimelineEffectInstance, 'diagnostics' | 'getElementState' | 'state'>,
  key: string,
  scope: string,
) {
  const emitter = captures.get(key);
  if (emitter) return emitter;
  const element = instance.getElementState(key);
  const diagnostics =
    instance.diagnostics
      .map(({ code, message, path }) => `${code} at ${path}: ${message}`)
      .join('; ') || 'none';
  throw new Error(
    `Golden ultimate ${scope} emitter reference "${key}" was not captured by its play action ` +
      `(instance state: ${instance.state}; element state: ${element ? JSON.stringify(element) : 'missing'}; ` +
      `diagnostics: ${diagnostics}).`,
  );
}

async function measurePerformance(
  effect: ReturnType<typeof createUltimate>,
  normalRef: TextureRef,
  normal: THREE.Texture,
): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setSize(96, 64);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden ultimate perf requires WebGPU.');
  const registry = registerTrails(createCoreKernelModuleRegistry());
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(
      new THREE.PlaneGeometry(6, 3.8),
      new THREE.MeshStandardNodeMaterial({ color: 0x11182c, roughness: 0.72 }),
    ),
    new THREE.HemisphereLight(0x416586, 0x050611, 0.16),
  );
  const camera = new THREE.OrthographicCamera(-2.6, 2.6, 1.62, -1.62, 0.1, 20);
  camera.position.z = 5;
  const system = new VFXSystem(runtime, scene, { registry });
  system.setCamera(cameraState(camera));
  const instance = system.spawn(effect, { seed: 0x5105 });
  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  instance.onAction(({ action, emitter }) => {
    capturePlayedEmitter(playedEmitters, action, emitter);
  });
  for (const delta of [0, 0.04, 0.02, 0.045, 0.12]) await system.update(delta);
  const particle = requireCapturedEmitter(playedEmitters, instance, 'particles', 'performance');
  const particleDraw = materializeThreeSpriteDraw(particle.program, particle.kernels, 0, {
    resolveTexture: createThreeTextureResolver(new Map([[normalRef.uri, normal]])),
  });
  const trail = requireCapturedEmitter(playedEmitters, instance, 'trail', 'performance');
  const trailDraw = materializeThreeRibbonDraw(trail.program, trail.kernels);
  await trailDraw.prepare(renderer);
  const flash = requireCapturedEmitter(playedEmitters, instance, 'flash', 'performance');
  const lightDraw = materializeThreeLightDraw(flash.program, flash.kernels);
  await lightDraw.update(renderer);
  await lightDraw.update(renderer);
  lightDraw.group.position.z = 1.2;
  scene.add(particleDraw, trailDraw.mesh, lightDraw.group);
  const target = new THREE.RenderTarget(96, 64, { depthBuffer: true });
  const post = createPostPipeline(renderer, scene, camera, {
    bloom: bloomPreset('intense', { strength: 1.15, radius: 0.62, threshold: 0.48 }),
    distortion: screenDistortion({
      shockwaves: [
        {
          center: [0.54, 0.49],
          duration: 0.8,
          radius: 0.08,
          ringWidth: 0.1,
          speed: 0.6,
          strength: 0.035,
        },
      ],
      time: instance.localTime,
    }),
    radialBlur: radialBlur({ center: [0.52, 0.5], samples: 10, strength: 0.17 }),
    outputColorTransform: false,
  });
  renderer.setRenderTarget(target);
  post.render();
  await renderer.resolveTimestampsAsync('compute');
  await renderer.resolveTimestampsAsync('render');
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: 'headless',
    page: 'golden-ultimate',
  });
  await monitor.captureGpuSamples(async () => {
    await system.update(STEP);
    await trailDraw.prepare(renderer);
    await lightDraw.update(renderer);
    renderer.setRenderTarget(target);
    post.render();
  });
  post.dispose();
  lightDraw.dispose();
  target.dispose();
  renderer.dispose();
}

async function run(): Promise<void> {
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  root.dataset.goldenScope = JSON.stringify({
    authoring: 'json-loaded',
    jsonLoader: 'nachi-effect-v1',
    M10: [
      'mesh-fx',
      'lit-billboards',
      'trails',
      'lights',
      'shockwave',
      'radial-blur',
      'bloom',
      'camera-shake',
      'hit-stop',
    ],
  });
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden ultimate requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  const registry = registerTrails(createCoreKernelModuleRegistry());
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const normalRef: TextureRef = {
    assetType: 'texture',
    kind: 'asset-ref',
    uri: 'procedural://golden-ultimate/normal',
  };
  const normal = normalMap();
  const noise = noiseMap();
  const textureResolver = createThreeTextureResolver(new Map([[normalRef.uri, normal]]));
  const codeEffect = createUltimate(normalRef, noise);
  const effect = loadUltimateFromJson(codeEffect);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02040d);
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 3.8),
    new THREE.MeshStandardNodeMaterial({ color: 0x11182c, roughness: 0.72 }),
  );
  receiver.position.z = -0.25;
  const ambient = new THREE.HemisphereLight(0x416586, 0x050611, 0.16);
  scene.add(receiver, ambient);
  const camera = new THREE.OrthographicCamera(-2.6, 2.6, 1.62, -1.62, 0.1, 20);
  camera.position.z = 5;
  const shakeSamples: CameraShakeSample[] = [];
  const system = new VFXSystem(runtime, scene, {
    aliveCountReadbackInterval: 1,
    cameraShakeTarget: (sample) => shakeSamples.push(sample),
    registry,
  });
  system.setCamera(cameraState(camera));
  const instance = system.spawn(effect, { position: [0.08, 0.03, 0], seed: 0x5105 });
  const actions: Array<{ kind: string; localTime: number }> = [];
  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  instance.onAction(({ action, emitter, localTime }) => {
    actions.push({ kind: action.kind, localTime });
    capturePlayedEmitter(playedEmitters, action, emitter);
  });
  let impactMarkers = 0;
  let postMarkers = 0;
  instance.onMarker('impact', () => {
    impactMarkers += 1;
  });
  instance.onMarker('post-start', () => {
    postMarkers += 1;
  });
  await system.update(0);
  await system.update(0.04);
  await system.update(0.02);
  await system.update(0.045);
  const hitStopTimes = { local: instance.localTime, world: system.time };
  await system.update(0.12);
  const particleView = requireCapturedEmitter(playedEmitters, instance, 'particles', 'main');
  const trailView = requireCapturedEmitter(playedEmitters, instance, 'trail', 'main');
  const flashView = requireCapturedEmitter(playedEmitters, instance, 'flash', 'main');
  const particleDraw = materializeThreeSpriteDraw(particleView.program, particleView.kernels, 0, {
    resolveTexture: textureResolver,
  });
  const trailDraw = materializeThreeRibbonDraw(trailView.program, trailView.kernels);
  await trailDraw.prepare(renderer);
  const trailSegments = await readRibbonSegments(renderer, trailDraw);
  const lightDraw = materializeThreeLightDraw(flashView.program, flashView.kernels);
  await lightDraw.update(renderer);
  const lightStats = await lightDraw.update(renderer);
  // The billboard normals face the camera in view space. Keep the particle light in front of the
  // billboard plane, matching the physical-lighting setup used by /m10-lit/; a coplanar point
  // light has no positive normal component and leaves the lit sprites black.
  lightDraw.group.position.z = 1.2;
  scene.add(particleDraw, trailDraw.mesh, lightDraw.group);
  const meshFx = scene.children.filter(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh && Boolean(child.userData.nachiMeshFx),
  );
  const arcMesh = meshFx.find(({ userData }) => userData.nachiMeshFx?.kind === 'slashArc');
  const shockMesh = meshFx.find(({ userData }) => userData.nachiMeshFx?.kind === 'ring');
  if (!arcMesh || !shockMesh) throw new Error('Ultimate mesh-fx elements are missing.');
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const effectObjects: THREE.Object3D[] = [
    arcMesh,
    shockMesh,
    particleDraw,
    trailDraw.mesh,
    lightDraw.group,
  ];
  const capture = async (visible: readonly THREE.Object3D[]) => {
    const set = new Set(visible);
    effectObjects.forEach((object) => {
      object.visible = set.has(object);
    });
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    return compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
      WIDTH,
      HEIGHT,
      true,
    );
  };
  const baseline = await capture([]);
  const arcOnly = await capture([arcMesh]);
  const shockwaveOnly = await capture([shockMesh]);
  const ribbonOnly = await capture([trailDraw.mesh]);
  const lightOnly = await capture([lightDraw.group]);
  // A lit element must be measured with its light present. Diff against the light-only frame so
  // receiver illumination is excluded and the count represents the particles themselves.
  const particlesWithLight = await capture([particleDraw, lightDraw.group]);
  const fullObjects = [arcMesh, shockMesh, particleDraw, trailDraw.mesh, lightDraw.group] as const;
  const postDisabled = await capture(fullObjects);
  effectObjects.forEach((object) => {
    object.visible = true;
  });
  const post = createPostPipeline(renderer, scene, camera, {
    bloom: bloomPreset('intense', { strength: 1.15, radius: 0.62, threshold: 0.48 }),
    distortion: screenDistortion({
      shockwaves: [
        {
          center: [0.54, 0.49],
          duration: 0.8,
          radius: 0.08,
          ringWidth: 0.1,
          speed: 0.6,
          strength: 0.035,
        },
      ],
      time: instance.localTime,
    }),
    radialBlur: radialBlur({ center: [0.52, 0.5], samples: 10, strength: 0.17 }),
    outputColorTransform: false,
  });
  renderer.setRenderTarget(target);
  renderer.clear();
  post.render();
  const postEnabled = compactRgba8Readback(
    new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
    WIDTH,
    HEIGHT,
    true,
  );
  const postDifference = changedPixels(postDisabled, postEnabled);
  const elementPixels = {
    arc: changedPixels(baseline, arcOnly),
    light: changedPixels(baseline, lightOnly),
    particles: changedPixels(lightOnly, particlesWithLight),
    ribbon: changedPixels(baseline, ribbonOnly),
    shockwave: changedPixels(baseline, shockwaveOnly),
  };
  const particlePositions = await readLogicalAttribute(
    renderer,
    particleView.program,
    particleView.kernels,
    'position',
  );
  const deterministicSystem = new VFXSystem(runtime, undefined, { registry });
  deterministicSystem.setCamera(cameraState(camera));
  const first = deterministicSystem.spawn(codeEffect, { seed: 0x7777 });
  const second = deterministicSystem.spawn(effect, { seed: 0x7777 });
  const firstActions: string[] = [];
  const secondActions: string[] = [];
  const firstEmitters = new Map<string, VfxEmitterRuntimeView>();
  const secondEmitters = new Map<string, VfxEmitterRuntimeView>();
  first.onAction(({ action, emitter, localTime }) => {
    firstActions.push(`${action.kind}@${localTime}`);
    capturePlayedEmitter(firstEmitters, action, emitter);
  });
  second.onAction(({ action, emitter, localTime }) => {
    secondActions.push(`${action.kind}@${localTime}`);
    capturePlayedEmitter(secondEmitters, action, emitter);
  });
  for (const delta of [0, 0.04, 0.02, 0.045, 0.12]) await deterministicSystem.update(delta);
  const firstView = requireCapturedEmitter(
    firstEmitters,
    first,
    'particles',
    'first determinism run',
  );
  const secondView = requireCapturedEmitter(
    secondEmitters,
    second,
    'particles',
    'second determinism run',
  );
  const firstPositions = await readLogicalAttribute(
    renderer,
    firstView.program,
    firstView.kernels,
    'position',
  );
  const secondPositions = await readLogicalAttribute(
    renderer,
    secondView.program,
    secondView.kernels,
    'position',
  );
  const firstBytes = new Uint8Array(
    firstPositions.buffer,
    firstPositions.byteOffset,
    firstPositions.byteLength,
  );
  const secondBytes = new Uint8Array(
    secondPositions.buffer,
    secondPositions.byteOffset,
    secondPositions.byteLength,
  );
  const jsonGpuEquivalent =
    firstActions.join('|') === secondActions.join('|') &&
    firstBytes.length === secondBytes.length &&
    firstBytes.every((value, index) => value === secondBytes[index]);
  const stressSystem = new VFXSystem(runtime, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
    registry,
  });
  stressSystem.setCamera(cameraState(camera));
  const stressInstance = stressSystem.spawn(
    loadUltimateFromJson(createUltimate(normalRef, noise, true)),
    {
      seed: 0x600f,
    },
  );
  for (let frame = 0; frame < 600; frame += 1) await stressSystem.update(STEP);
  const stress = {
    diagnostics: stressInstance.diagnostics.map(({ code }) => code),
    frames: 600,
    state: stressInstance.state,
    worldTime: stressSystem.time,
  };
  const visual = stats(postEnabled);
  const expectedKinds = [
    'play',
    'play',
    'play',
    'camera-shake',
    'hit-stop',
    'marker',
    'play',
    'play',
    'marker',
  ];
  const checks = {
    cameraShake: shakeSamples.some(({ decay }) => decay > 0),
    consoleClean: consoleMessages.length === 0,
    jsonGpuEquivalent,
    elementPixels:
      Object.values(elementPixels).every((count) => count > 24) &&
      particlePositions.length > 0 &&
      trailSegments.segmentCount > 2 &&
      lightStats.selectedCount === 1 &&
      particleDraw.material instanceof THREE.MeshStandardNodeMaterial &&
      particleDraw.material.normalNode !== null,
    hitStop:
      Math.abs(hitStopTimes.local - 0.06) < 1e-8 && Math.abs(hitStopTimes.world - 0.105) < 1e-8,
    postContrast: postDifference > 350,
    stress600:
      stress.state !== 'error' &&
      stress.diagnostics.length === 0 &&
      Math.abs(stress.worldTime - 10) < 1e-5,
    timelineOrder:
      actions.map(({ kind }) => kind).join('|') === expectedKinds.join('|') &&
      actions.every(
        ({ localTime }, index) =>
          Math.abs(localTime - [0, 0.04, 0.06, 0.06, 0.06, 0.06, 0.09, 0.12, 0.12][index]!) < 1e-8,
      ) &&
      impactMarkers === 1 &&
      postMarkers === 1,
    visualBounds:
      visual.foregroundRatio > 0.02 &&
      // Bloom intentionally creates a broad, dim foreground. Keep measuring the final post image,
      // but reserve foregroundRatio's upper bound for near-total coverage and use the independent
      // saturatedRatio bound to reject an actual whiteout.
      visual.foregroundRatio < 0.97 &&
      visual.saturatedRatio < 0.16,
  };
  await measurePerformance(effect, normalRef, normal);
  checks.consoleClean = consoleMessages.length === 0;
  const canvas = required<HTMLCanvasElement>('#ultimate-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Golden ultimate 2D canvas is unavailable.');
  const output = context.createImageData(WIDTH * 2, HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const sourceY = HEIGHT - 1 - y;
    for (let panel = 0; panel < 2; panel += 1) {
      const pixels = panel === 0 ? postDisabled : postEnabled;
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (sourceY * WIDTH + x) * 4;
        const target = (y * WIDTH * 2 + panel * WIDTH + x) * 4;
        output.data.set(pixels.subarray(source, source + 4), target);
      }
    }
  }
  context.putImageData(output, 0, 0);
  const result = {
    checks,
    consoleMessages,
    evidence: {
      actionLog: actions,
      elementPixels,
      hitStopTimes,
      light: lightStats,
      postDifference,
      shakeSamples: shakeSamples.length,
      stress,
      trailSegments: trailSegments.segmentCount,
      visual,
    },
    ok: Object.values(checks).every(Boolean),
    post: ['shockwave-distortion', 'radial-blur', 'bloom'],
    schema: 'nachi.golden-ultimate.v1',
    scope: {
      currentAuthoring: 'json-loaded',
      envelope: { format: EFFECT_ASSET_FORMAT, version: EFFECT_ASSET_VERSION },
      equivalence: 'code-definition-vs-json-load GPU attribute bytes and timeline actions',
    },
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-ultimate.png', selector: '#ultimate-visual' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#status-value').textContent = result.ok ? 'all checks passed' : 'failed';
  post.dispose();
  lightDraw.dispose();
  target.dispose();
  normal.dispose();
  noise.dispose();
  renderer.dispose();
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = message;
  originalError(error);
});
