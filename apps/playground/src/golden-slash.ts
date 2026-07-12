import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  createCoreKernelModuleRegistry,
  curve,
  decalRenderer,
  defineEffect,
  defineEmitter,
  drag,
  gradient,
  gravity,
  intensityOverLife,
  lifetime,
  lightIntensity,
  lightRenderer,
  positionSphere,
  range,
  rate,
  sizeOverLife,
  velocityCone,
  type EffectInstanceState,
  type Vec3,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi/trails';
import { materializeThreeRibbonDraw, readRibbonSegments } from '@nachi/trails/three';
import * as THREE from 'three/webgpu';
import { screenUV, texture, vec4 } from 'three/tsl';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTransformSource,
  materializeThreeDecalDraw,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-slash.css';

const WIDTH = 640;
const HEIGHT = 400;
const STEP = 1 / 60;
const HIT: Vec3 = [0.72, -0.08, 0.08];
const root = document.documentElement;
const headless = new URLSearchParams(location.search).get('headless') === '1';
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
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  attachTo(source: ReturnType<typeof createThreeTransformSource>): void;
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  readonly state: EffectInstanceState;
};

function required<ElementType extends Element>(selector: string): ElementType {
  const value = document.querySelector<ElementType>(selector);
  if (!value) throw new Error(`Missing golden slash element: ${selector}`);
  return value;
}

function emitter(instance: RuntimeInstance, key: string): VfxEmitterRuntimeView {
  const value = instance.getEmitter(key);
  if (!value) throw new Error(`Missing golden slash emitter: ${key}`);
  return value;
}

function paint(canvas: HTMLCanvasElement, pixels: ArrayLike<number>): number {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let foreground = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const source = (y * WIDTH + x) * 4;
      const target = ((HEIGHT - 1 - y) * WIDTH + x) * 4;
      const r = Number(pixels[source] ?? 0);
      const g = Number(pixels[source + 1] ?? 0);
      const b = Number(pixels[source + 2] ?? 0);
      rgba.set([r, g, b, 255], target);
      if (r + g + b > 42) foreground += 1;
    }
  }
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, WIDTH, HEIGHT), 0, 0);
  return foreground / (WIDTH * HEIGHT);
}

async function probePointLights(
  renderer: THREE.WebGPURenderer,
  camera: THREE.PerspectiveCamera,
): Promise<{
  readonly counts: readonly number[];
  readonly gpuRenderMs: readonly (number | null)[];
  readonly nonBlack: readonly number[];
  readonly relativeToEight: readonly (number | null)[];
}> {
  const counts = [8, 16, 32] as const;
  const gpuRenderMs: (number | null)[] = [];
  const nonBlack: number[] = [];
  const target = new THREE.RenderTarget(32, 32, { depthBuffer: true });
  for (const count of counts) {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.8 });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material));
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const light = new THREE.PointLight(0xffffff, 1 / count, 4, 2);
      light.position.set(Math.cos(angle), Math.sin(angle), 1.2);
      scene.add(light);
    }
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    await renderer.resolveTimestampsAsync('render');
    renderer.render(scene, camera);
    const pixels = compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32)),
      32,
      32,
      true,
    );
    const duration = await renderer.resolveTimestampsAsync('render');
    gpuRenderMs.push(duration !== undefined && Number.isFinite(duration) ? duration : null);
    nonBlack.push(
      Array.from({ length: 32 * 32 }, (_, pixel) => {
        const offset = pixel * 4;
        return (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 0;
      }).filter(Boolean).length,
    );
  }
  renderer.setRenderTarget(null);
  const baseline = gpuRenderMs[0];
  const relativeToEight = gpuRenderMs.map((duration) =>
    duration !== null && baseline !== undefined && baseline !== null && baseline > 0
      ? duration / baseline
      : null,
  );
  return { counts, gpuRenderMs, nonBlack, relativeToEight };
}

async function run(): Promise<void> {
  root.dataset.spikeStatus = 'running';
  root.dataset.rendererStatus = 'initializing';
  root.dataset.goldenScope = JSON.stringify({
    M7: ['ribbon', 'sprite', 'light', 'decal'],
    M8: 'arc-mesh',
    M9: ['hit-stop', 'shake'],
    M10: 'post-distortion',
  });
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden slash M7 requires WebGPU.');
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = 'Offscreen RT readback';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';

  const camera = new THREE.PerspectiveCamera(44, WIDTH / HEIGHT, 0.1, 30);
  camera.position.set(0, 0.25, 5.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(5.5, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x11182a, metalness: 0.18, roughness: 0.62 }),
  );
  const depthScene = new THREE.Scene();
  depthScene.add(receiver);
  const depthTexture = new THREE.DepthTexture(WIDTH, HEIGHT, THREE.UnsignedIntType);
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  const depthTarget = new THREE.RenderTarget(WIDTH, HEIGHT, {
    depthBuffer: true,
    depthTexture,
    samples: 0,
  });
  const depthPipeline = new THREE.RenderPipeline(renderer);
  depthPipeline.outputColorTransform = false;
  const depthValue = texture(depthTexture, screenUV).r;
  depthPipeline.outputNode = vec4(depthValue, depthValue, depthValue, 1);
  const depthCopy = new THREE.RenderTarget(WIDTH, HEIGHT, {
    depthBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });
  depthCopy.texture.colorSpace = THREE.NoColorSpace;
  depthCopy.texture.minFilter = THREE.NearestFilter;
  depthCopy.texture.magFilter = THREE.NearestFilter;
  renderer.setRenderTarget(depthTarget);
  renderer.render(depthScene, camera);
  renderer.setRenderTarget(depthCopy);
  depthPipeline.render();
  renderer.setRenderTarget(null);

  const registry = registerTrails(createCoreKernelModuleRegistry());
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
    sceneDepthSampleCount: 1,
    sceneDepthTexture: depthCopy.texture,
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const trailDefinition = defineEmitter({
    attributes: { ribbonId: ribbonIdAttribute() },
    capacity: 64,
    init: [positionSphere({ radius: 0 }), lifetime(3), ribbonId(0)],
    integration: 'none',
    lifecycle: { duration: 0.75 },
    render: ribbon({
      blending: 'additive',
      maxRibbons: 1,
      taper: { start: 0.12, end: 0.55 },
      uv: { mode: 'stretched' },
      width: 0.22,
    }),
    spawn: rate(60),
    update: [colorOverLife(gradient('#ffffff', '#77ddff', '#c65cff'))],
  });
  const sparksDefinition = defineEmitter({
    capacity: 80,
    init: [
      positionSphere({ radius: 0.03 }),
      velocityCone({ angle: 58, direction: [0.75, 0.55, 0.15], speed: range(2.5, 6.5) }),
      lifetime(range(0.35, 0.85)),
    ],
    render: billboard({ blending: 'additive' }),
    spawn: burst({ count: 60 }),
    update: [
      gravity([0, -4.5, 0]),
      drag(1.3),
      sizeOverLife(curve([0, 0.1], [0.2, 0.055], [1, 0])),
      colorOverLife(gradient('#ffffff', '#ffd05a', '#ff4b20')),
    ],
  });
  const lightDefinition = defineEmitter({
    capacity: 12,
    init: [positionSphere({ radius: 0.05 }), lifetime(0.5), lightIntensity(range(8, 22))],
    integration: 'none',
    render: lightRenderer({ maxLights: 4, priority: 'intensity', radiusScale: 1.8 }),
    spawn: burst({ count: 12 }),
    update: [
      colorOverLife(gradient('#fff4cc', '#ff5b30')),
      intensityOverLife(curve([0, 24], [0.22, 12], [1, 0])),
    ],
  });
  const decalDefinition = defineEmitter({
    capacity: 1,
    init: [positionSphere({ radius: 0 }), lifetime(5)],
    integration: 'none',
    render: decalRenderer({ fadeOverLife: true, sizeScale: 1.15 }),
    spawn: burst({ count: 1 }),
    update: [colorOverLife(gradient('#d9f8ff', '#5d7dff'))],
  });
  const measureGpuPerformance = async () => {
    const performanceRenderer = await createPlaygroundRenderer({
      antialias: false,
      trackTimestamp: true,
    });
    performanceRenderer.setSize(32, 32);
    await performanceRenderer.init();
    const performanceBackend = performanceRenderer.backend as BackendLike;
    if (!performanceBackend.isWebGPUBackend) {
      throw new Error('Golden slash performance capture requires WebGPU.');
    }
    const performanceAdapter = createThreeKernelAdapter({
      backend: 'webgpu',
      linearFloat32Filtering:
        performanceBackend.device?.features?.has('float32-filterable') === true,
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
      gpuScopes: ['compute', 'render'],
      mode: headless ? 'headless' : 'visual',
      page: 'golden-slash',
    });
    const performanceSystem = new VFXSystem(performanceRuntime, undefined, {
      fixedTimeStep: { stepSeconds: STEP },
    });
    performanceSystem.spawn(defineEffect({ elements: { flash: lightDefinition } }), {
      seed: 7199,
    });
    const performanceScene = new THREE.Scene();
    const performanceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x88ccff }),
    );
    performanceScene.add(performanceMesh);
    const performanceTarget = new THREE.RenderTarget(32, 32);
    performanceRenderer.setRenderTarget(performanceTarget);
    await performanceSystem.update(0);
    performanceRenderer.render(performanceScene, camera);
    await performanceRenderer.resolveTimestampsAsync('compute');
    await performanceRenderer.resolveTimestampsAsync('render');
    await performanceMonitor.captureGpuSamples(async () => {
      await performanceSystem.update(STEP);
      performanceRenderer.render(performanceScene, camera);
    });
    const pointLightProbe = await probePointLights(performanceRenderer, camera);
    performanceTarget.dispose();
    performanceMesh.geometry.dispose();
    performanceMesh.material.dispose();
    return pointLightProbe;
  };
  const trailSystem = new VFXSystem(runtime, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
    registry,
  });
  const sparksSystem = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const lightSystem = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const decalSystem = new VFXSystem(runtime, undefined, { fixedTimeStep: { stepSeconds: STEP } });
  const socket = new THREE.Object3D();
  const trailInstance = trailSystem.spawn(defineEffect({ elements: { trail: trailDefinition } }), {
    seed: 7101,
  }) as RuntimeInstance;
  trailInstance.attachTo(createThreeTransformSource(socket));
  const sparksInstance = sparksSystem.spawn(
    defineEffect({ elements: { sparks: sparksDefinition } }),
    { position: HIT, seed: 7102 },
  ) as RuntimeInstance;
  const lightInstance = lightSystem.spawn(defineEffect({ elements: { flash: lightDefinition } }), {
    position: HIT,
    seed: 7103,
  }) as RuntimeInstance;
  const decalInstance = decalSystem.spawn(defineEffect({ elements: { decal: decalDefinition } }), {
    position: HIT,
    seed: 7104,
  }) as RuntimeInstance;
  const socketSamples: Vec3[] = [];
  await trailSystem.update(0);
  await sparksSystem.update(0);
  await lightSystem.update(0);
  await decalSystem.update(0);
  for (let frame = 0; frame < 48; frame += 1) {
    const t = frame / 47;
    const angle = -2.45 + t * 2.65;
    socket.position.set(Math.cos(angle) * 1.55 - 0.25, Math.sin(angle) * 1.05 + 0.35, 0.16);
    socket.updateMatrixWorld(true);
    socketSamples.push(socket.position.toArray() as Vec3);
    await trailSystem.update(STEP);
    if (frame < 18) await sparksSystem.update(STEP);
    if (frame < 8) await lightSystem.update(STEP);
    await decalSystem.update(STEP);
  }
  const trailView = emitter(trailInstance, 'trail');
  const trailDraw = materializeThreeRibbonDraw(trailView.program, trailView.kernels);
  await trailDraw.prepare(renderer);
  const [trailSegments, trailPositions, trailOrders, trailAlive] = await Promise.all([
    readRibbonSegments(renderer, trailDraw),
    readLogicalAttribute(renderer, trailView.program, trailView.kernels, 'position'),
    readLogicalAttribute(renderer, trailView.program, trailView.kernels, 'spawnOrder'),
    readLogicalAttribute(renderer, trailView.program, trailView.kernels, 'alive'),
  ]);
  let ribbonFollowError = 0;
  for (let physical = 0; physical < 64; physical += 1) {
    if ((trailAlive[physical] ?? 0) === 0) continue;
    const expected = socketSamples[Number(trailOrders[physical] ?? 0)];
    if (!expected) continue;
    ribbonFollowError = Math.max(
      ribbonFollowError,
      Math.hypot(
        (trailPositions[physical * 3] ?? 0) - expected[0],
        (trailPositions[physical * 3 + 1] ?? 0) - expected[1],
        (trailPositions[physical * 3 + 2] ?? 0) - expected[2],
      ),
    );
  }
  const lightView = emitter(lightInstance, 'flash');
  const lightDiagnostics: string[] = [];
  const lightDraw = materializeThreeLightDraw(lightView.program, lightView.kernels, 0, {
    onDiagnostic: ({ code }) => lightDiagnostics.push(code),
  });
  await lightDraw.update(renderer);
  const lightStats = await lightDraw.update(renderer);
  const lightPositionError = Math.max(
    0,
    ...lightStats.selected.map(({ position }) =>
      Math.hypot(position[0] - HIT[0], position[1] - HIT[1], position[2] - HIT[2]),
    ),
  );
  const decalView = emitter(decalInstance, 'decal');
  const decalPosition = await readLogicalAttribute(
    renderer,
    decalView.program,
    decalView.kernels,
    'position',
  );
  const decalPositionError = Math.hypot(
    (decalPosition[0] ?? 0) - HIT[0],
    (decalPosition[1] ?? 0) - HIT[1],
    (decalPosition[2] ?? 0) - HIT[2],
  );

  const stressDefinition = defineEmitter({
    attributes: { ribbonId: ribbonIdAttribute() },
    capacity: 32,
    init: [positionSphere({ radius: 0 }), lifetime(20), ribbonId(0)],
    integration: 'none',
    lifecycle: { duration: 10 },
    render: ribbon({ blending: 'additive', maxRibbons: 1, uv: { mode: 'stretched' }, width: 0.05 }),
    spawn: rate(240),
  });
  const stressSystem = new VFXSystem(runtime, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
    registry,
  });
  const stressInstance = stressSystem.spawn(
    defineEffect({ elements: { stress: stressDefinition } }),
    { seed: 7105 },
  ) as RuntimeInstance;
  for (let frame = 0; frame < 600; frame += 1) await stressSystem.update(STEP);
  const stressView = emitter(stressInstance, 'stress');
  const stressDraw = materializeThreeRibbonDraw(stressView.program, stressView.kernels);
  await stressDraw.prepare(renderer);
  const stressSegments = await readRibbonSegments(renderer, stressDraw);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030611);
  const hemisphere = new THREE.HemisphereLight(0x9bcfff, 0x080b15, 0.45);
  scene.add(receiver, hemisphere);
  scene.add(trailDraw.mesh);
  const sparksView = emitter(sparksInstance, 'sparks');
  const sparksMesh = materializeThreeSpriteDraw(sparksView.program, sparksView.kernels);
  scene.add(sparksMesh);
  scene.add(lightDraw.group);
  const decalMesh = materializeThreeDecalDraw(decalView.program, decalView.kernels, 0, {
    sceneDepthTexture: depthCopy.texture,
  });
  scene.add(decalMesh);
  const visualTarget = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  const renderVisual = async () => {
    renderer.setRenderTarget(visualTarget);
    renderer.render(scene, camera);
    return renderer.readRenderTargetPixelsAsync(visualTarget, 0, 0, WIDTH, HEIGHT);
  };
  const changedPixels = (
    left: ArrayLike<number>,
    right: ArrayLike<number>,
    include: (x: number, y: number) => boolean = () => true,
  ) => {
    let changed = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (!include(x, y)) continue;
        const offset = (y * WIDTH + x) * 4;
        const difference =
          Math.abs(Number(left[offset] ?? 0) - Number(right[offset] ?? 0)) +
          Math.abs(Number(left[offset + 1] ?? 0) - Number(right[offset + 1] ?? 0)) +
          Math.abs(Number(left[offset + 2] ?? 0) - Number(right[offset + 2] ?? 0));
        if (difference > 8) changed += 1;
      }
    }
    return changed;
  };
  trailDraw.mesh.visible = false;
  sparksMesh.visible = false;
  decalMesh.visible = false;
  receiver.visible = true;
  const withoutDecal = await renderVisual();
  decalMesh.visible = true;
  const withDecal = await renderVisual();
  const projectedHit = new THREE.Vector3(...HIT).project(camera);
  const expectedDecalPixel = {
    x: (projectedHit.x * 0.5 + 0.5) * WIDTH,
    // readRenderTargetPixelsAsync rows are bottom-up, matching NDC y-up here.
    y: (projectedHit.y * 0.5 + 0.5) * HEIGHT,
  };
  const decalProjectedPixels = changedPixels(
    withDecal,
    withoutDecal,
    (x, y) => Math.abs(x - expectedDecalPixel.x) < 90 && Math.abs(y - expectedDecalPixel.y) < 90,
  );

  receiver.visible = false;
  decalMesh.visible = false;
  sparksMesh.visible = false;
  const withoutSparks = await renderVisual();
  sparksMesh.visible = true;
  const withSparks = await renderVisual();
  const sparkForegroundPixels = changedPixels(
    withSparks,
    withoutSparks,
    (x) => x > expectedDecalPixel.x - 40,
  );

  receiver.visible = true;
  trailDraw.mesh.visible = true;
  decalMesh.visible = true;
  sparksMesh.visible = true;
  const visualPixels = await renderVisual();
  renderer.setRenderTarget(null);
  const foregroundRatio = paint(required<HTMLCanvasElement>('#golden-slash'), visualPixels);
  const pointLightProbe = await measureGpuPerformance();
  for (let frame = 0; frame < 60 && lightInstance.state === 'active'; frame += 1) {
    await lightSystem.update(STEP);
  }
  await lightDraw.update(renderer, lightInstance.state);
  const lightPoolDisposed =
    lightInstance.state === 'complete' &&
    lightDraw.group.parent === null &&
    lightDraw.lights.every(({ intensity }) => intensity === 0);
  const validation = {
    consoleClean: consoleMessages.length === 0,
    decalParticlePosition: decalPositionError < 0.0001,
    decalProjected: decalProjectedPixels > 100,
    fireSparksRendered: sparkForegroundPixels > 20,
    lightBounded: lightStats.selectedCount === 4 && lightStats.candidateCount === 12,
    lightOverflowDiagnostic: lightDiagnostics.includes('NACHI_LIGHT_LIMIT_EXCEEDED'),
    lightPoolDisposed,
    lightPosition: lightPositionError < 0.06,
    pointLightR185Probe: pointLightProbe.nonBlack.every((count) => count > 0),
    ribbonFollow: ribbonFollowError < 0.0001,
    saturationLongRun: stressSegments.segmentCount === 31,
    visualReadback: foregroundRatio > 0.015,
    weaponTrail: trailSegments.segmentCount >= 35,
  };
  const result = {
    artifact: 'artifacts/golden-slash.png',
    consoleMessages,
    decal: {
      expectedPixel: expectedDecalPixel,
      positionError: decalPositionError,
      projectedPixels: decalProjectedPixels,
      projection: 'scene-depth-world-reconstruction',
    },
    light: {
      ...lightStats,
      effectState: lightInstance.state,
      positionError: lightPositionError,
      readbackLatencyFrames: 1,
    },
    lightSelection: 'gpu-top-n-intensity',
    ok: Object.values(validation).every(Boolean),
    pointLightProbe,
    rendererChoice: 'bounded PointLight pool; emissive+bloom deferred to M10',
    ribbon: { followError: ribbonFollowError, segmentCount: trailSegments.segmentCount },
    scope: { M7: true, M8: 'arc mesh', M9: 'hit stop/shake', M10: 'post distortion' },
    sparks: { foregroundPixels: sparkForegroundPixels, isolatedReadback: true },
    stress: { frames: 600, saturatedSegments: stressSegments.segmentCount },
    validation,
    visual: { foregroundRatio, source: 'offscreen-render-target-readback-to-2d-canvas' },
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-slash.png', selector: '#golden-slash' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'Golden slash verified'
    : 'Golden slash failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.documentElement.dataset.spikeError = message;
  document.documentElement.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  document.documentElement.dataset.spikeStatus = 'error';
  required<HTMLElement>('#status-value').textContent = message;
  console.error(error);
});
