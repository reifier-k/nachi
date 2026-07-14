import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  detectDeviceQualityTier,
  lifetime,
  positionSphere,
  rate,
  selectDeviceQualityTier,
  type VfxDiagnostic,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m11-scale.css';

const WIDTH = 128;
const HEIGHT = 48;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
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

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: {
      readonly maxStorageBuffersPerShaderStage?: number;
    };
    readonly lost?: Promise<{ message?: string; reason?: string }>;
  };
  readonly gl?: WebGL2RenderingContext;
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M11 scale UI element ${selector}.`);
  return value;
}

function cameraState(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  return {
    coordinateSystem: 'webgl' as const,
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportSize: [WIDTH, HEIGHT] as const,
  };
}

function identityCameraState() {
  return {
    coordinateSystem: 'webgl' as const,
    projectionMatrix: [1, 0, 0, 0, 0, 1.4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewportSize: [WIDTH, HEIGHT] as const,
  };
}

function view(
  instance: {
    readonly diagnostics: readonly VfxDiagnostic[];
    getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  },
  key = 'particles',
): VfxEmitterRuntimeView {
  const emitter = instance.getEmitter(key);
  if (!emitter) {
    throw new Error(
      `Missing M11 runtime emitter ${key}. diagnostics=${JSON.stringify(instance.diagnostics)}`,
    );
  }
  return emitter;
}

function tierSwitchSnapshot(
  instance: {
    readonly diagnostics: readonly VfxDiagnostic[];
    readonly localTime: number;
    readonly scalability: unknown;
    readonly state: string;
    getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  },
  system: VFXSystem,
) {
  const emitter = instance.getEmitter('particles');
  return {
    diagnostics: instance.diagnostics,
    emitter:
      emitter === undefined
        ? undefined
        : {
            aliveCount: emitter.aliveCount,
            capabilityPath: emitter.kernels.capabilityPath,
            compiledCapacity: emitter.program.attributeSchema.capacity,
            definitionCapacity: emitter.definition.capacity,
            lifecycleState: emitter.lifecycleState,
            loopIndex: emitter.loopIndex,
            spawnGeneration: emitter.spawnGeneration,
            spawnModules: emitter.program.spawn.modules.map(({ config, path, type }) => ({
              config,
              path,
              type,
            })),
            storageNames: Object.fromEntries(
              Object.entries(emitter.kernels.storages).map(([key, storage]) => [
                key,
                (storage as { name?: string }).name,
              ]),
            ),
          },
    localTime: instance.localTime,
    qualitySelection: system.qualitySelection,
    scalability: instance.scalability,
    state: instance.state,
  };
}

function pixelDifference(left: Uint8Array, right: Uint8Array) {
  let changed = 0;
  let total = 0;
  for (let index = 0; index < left.length; index += 4) {
    const difference =
      Math.abs(left[index]! - right[index]!) +
      Math.abs(left[index + 1]! - right[index + 1]!) +
      Math.abs(left[index + 2]! - right[index + 2]!);
    if (difference > 8) changed += 1;
    total += difference;
  }
  return { changed, meanLinearByteDifference: total / (left.length / 4) / 3 };
}

function paint(panels: readonly Uint8Array[]): void {
  const canvas = required<HTMLCanvasElement>('#scale-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('M11 visual canvas has no 2D context.');
  const output = context.createImageData(WIDTH * panels.length, HEIGHT);
  for (const [panel, pixels] of panels.entries()) {
    for (let y = 0; y < HEIGHT; y += 1) {
      const sourceY = HEIGHT - 1 - y;
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (sourceY * WIDTH + x) * 4;
        const target = (y * WIDTH * panels.length + panel * WIDTH + x) * 4;
        output.data.set(pixels.subarray(source, source + 4), target);
      }
    }
  }
  context.putImageData(output, 0, 0);
}

async function capture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  webgpu: boolean,
): Promise<Uint8Array> {
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const raw = new Uint8Array(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT),
  );
  return compactRgba8Readback(raw, WIDTH, HEIGHT, webgpu);
}

async function run(): Promise<void> {
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x02050a, 1);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  const webgpu = backend.isWebGPUBackend === true;
  const activeBackend = webgpu ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${activeBackend}.`);
  }
  required<HTMLElement>('#backend-value').textContent = activeBackend;
  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';
  if (webgpu) {
    root.dataset.artifactScreenshots = JSON.stringify([
      { filename: 'm11-scale.png', selector: '#scale-visual' },
    ]);
  }

  const transformFeedbackLimit = backend.gl?.getParameter(
    backend.gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
  ) as number | undefined;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
    ...(transformFeedbackLimit === undefined
      ? {}
      : { maxTransformFeedbackSeparateAttribs: transformFeedbackLimit }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: webgpu ? ['compute', 'render'] : ['render'],
    mode: query.get('headless') === '1' ? 'headless' : 'visual',
    page: 'm11-scale',
  });
  const deviceSelection = webgpu
    ? await detectDeviceQualityTier({ fallbackBackend: 'none' })
    : selectDeviceQualityTier({ backend: 'webgl2', features: [], limits: {} });

  if (!webgpu) {
    const authored = defineEmitter({
      bounds: { center: [0.13, -0.09, 0], radius: 0.4 },
      capacity: 8,
      integration: 'none',
      lifecycle: { duration: 20 },
      quality: { low: { capacityScale: 0.5, spawnRateScale: 1 } },
      render: billboard({ blending: 'alpha', lit: true, soft: true, sorted: true }),
      spawn: burst({ count: 8 }),
    });
    const effect = defineEffect({
      elements: { particles: authored },
      scalability: {
        culling: { distance: { fadeEnd: 5, fadeStart: 4 }, frustum: true },
      },
    });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    camera.updateProjectionMatrix();
    const system = new VFXSystem(runtime, undefined, { qualityTier: 'low' });
    system.setCamera(cameraState(camera));
    const instance = system.spawn(effect, { seed: 41 });
    await system.update(0);
    const runtimeView = view(instance);
    const lowRender = Array.isArray(runtimeView.definition.render)
      ? runtimeView.definition.render[0]
      : runtimeView.definition.render;
    const logicalAlive = runtimeView.aliveCount;
    const timeBeforeCull = instance.localTime;
    instance.setTransform([0, 0, -5]);
    await system.update(0.5);
    const aliveWhileCulled = runtimeView.aliveCount;
    const timeWhileCulled = instance.localTime;
    const actionWhileCulled = instance.scalability.action;
    instance.setTransform([0, 0, 0]);
    await system.update(0.1);
    const timeAfterResume = instance.localTime;

    const tierEffect = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 8,
          integration: 'none',
          quality: { low: { capacityScale: 1, spawnRateScale: 0.25 } },
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 8 }),
        }),
      },
    });
    const tierSystem = new VFXSystem(runtime, undefined, { qualityTier: 'low' });
    tierSystem.setCamera(cameraState(camera));
    const lowTierInstance = tierSystem.spawn(tierEffect, { seed: 43 });
    await tierSystem.update(0);
    const lowTierState = tierSwitchSnapshot(lowTierInstance, tierSystem);
    const lowTierAlive = lowTierState.emitter?.aliveCount;
    tierSystem.setQualityTier('epic');
    const epicTierInstance = tierSystem.spawn(tierEffect, { seed: 47 });
    await tierSystem.update(0);
    const epicTierState = tierSwitchSnapshot(epicTierInstance, tierSystem);
    const epicTierAlive = epicTierState.emitter?.aliveCount;
    const tierSwitchDiagnostics = {
      epic: epicTierState,
      low: lowTierState,
      priorScenario: tierSwitchSnapshot(instance, system),
      system: {
        compilationCount: tierSystem.compilationCount,
        instanceCount: tierSystem.instanceCount,
        qualitySelection: tierSystem.qualitySelection,
      },
    };
    root.dataset.tierSwitchDiagnostics = JSON.stringify(tierSwitchDiagnostics);
    (
      window as unknown as {
        tierSwitchDiagnostics?: typeof tierSwitchDiagnostics;
      }
    ).tierSwitchDiagnostics = tierSwitchDiagnostics;

    const runtimeCamera = cameraState(camera);
    const frustumInside = system.spawn(effect, { position: [0, 0, 0], seed: 53 });
    const frustumOutside = system.spawn(effect, { position: [3, 0, 0], seed: 59 });
    await system.update(0);
    const actualProjectionFrustum =
      frustumInside.scalability.action === 'full' &&
      frustumOutside.scalability.action === 'culled' &&
      frustumOutside.scalability.reasons.includes('frustum');
    const config = lowRender?.config as Record<string, unknown> | undefined;
    const validation = {
      actualProjectionFrustum,
      autoLow: deviceSelection.tier === 'low',
      consoleClean: messages.length === 0,
      cullingAliveCountFrozen: logicalAlive === 4 && aliveWhileCulled === 4,
      cullingPauseAndResume:
        actionWhileCulled === 'culled' &&
        timeWhileCulled === timeBeforeCull &&
        timeAfterResume > timeWhileCulled,
      logicalCapacityFullReadback: logicalAlive === 4,
      lowFeatureGates: config?.lit === false && config.soft === false && config.sorted === false,
      tierSwitchAliveCounts: lowTierAlive === 2 && epicTierAlive === 8,
    };
    const result = {
      activeBackend,
      culling: {
        actionWhileCulled,
        aliveWhileCulled,
        timeAfterResume,
        timeBeforeCull,
        timeWhileCulled,
      },
      deviceSelection,
      logicalAlive,
      tierSwitch: { diagnostics: tierSwitchDiagnostics, epicTierAlive, lowTierAlive },
      ok: Object.values(validation).every(Boolean),
      runtimeProjectionMatrix: runtimeCamera.projectionMatrix,
      validation,
    };
    await monitor.resolveGpuTimestamps();
    monitor.publish();
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = result.ok
      ? 'All checks passed'
      : 'Validation failed';
    return;
  }

  const qualityEmitter = defineEmitter({
    bounds: { center: [0.17, -0.08, 0], radius: 0.5 },
    capacity: 64,
    init: [positionSphere({ radius: 0.2 }), lifetime(10)],
    quality: { low: { capacityScale: 0.25, spawnRateScale: 0.25 } },
    render: billboard({ blending: 'alpha', lit: true, soft: true, sorted: true }),
    spawn: burst({ count: 48 }),
  });
  const qualityEffect = defineEffect({ elements: { particles: qualityEmitter } });
  const qualitySystem = new VFXSystem(runtime, undefined, {
    aliveCountReadbackInterval: 1,
    qualityTier: 'low',
  });
  const visualCamera = new THREE.OrthographicCamera(-1.25, 1.25, 0.75, -0.75, 0.1, 10);
  visualCamera.position.z = 4;
  qualitySystem.setCamera(cameraState(visualCamera));
  const lowInstance = qualitySystem.spawn(qualityEffect, { seed: 11 });
  await qualitySystem.update(0);
  const lowCountView = view(lowInstance);
  qualitySystem.setQualityTier('epic');
  const epicInstance = qualitySystem.spawn(qualityEffect, { seed: 29 });
  await qualitySystem.update(0);
  const epicCountView = view(epicInstance);
  const lowQualityDraw = lowCountView.program.draws[0];
  const epicQualityDraw = epicCountView.program.draws[0];

  // Keep count scaling orthogonal to the lit/unlit pixel comparison: same position, seed, and
  // particle count, with only the structural tier gates changing.
  const visualEmitter = defineEmitter({
    bounds: { center: [0.11, -0.07, 0], radius: 0.6 },
    capacity: 1,
    init: [positionSphere({ radius: 0 }), lifetime(10)],
    quality: { low: { capacityScale: 1, spawnRateScale: 1 } },
    render: billboard({ blending: 'alpha', lit: true, sorted: true }),
    spawn: burst({ count: 1 }),
  });
  const visualEffect = defineEffect({ elements: { particles: visualEmitter } });
  const visualSystem = new VFXSystem(runtime, undefined, {
    aliveCountReadbackInterval: 1,
    qualityTier: 'low',
  });
  visualSystem.setCamera(cameraState(visualCamera));
  const lowVisual = visualSystem.spawn(visualEffect, { seed: 37 });
  await visualSystem.update(0);
  const lowView = view(lowVisual);
  visualSystem.setQualityTier('epic');
  const epicVisual = visualSystem.spawn(visualEffect, { seed: 37 });
  await visualSystem.update(0);
  const epicView = view(epicVisual);

  const lowMesh = materializeThreeSpriteDraw(lowView.program, lowView.kernels);
  const epicMesh = materializeThreeSpriteDraw(epicView.program, epicView.kernels);
  const litScene = new THREE.Scene();
  litScene.background = new THREE.Color(0x02050a);
  const asymmetricLight = new THREE.PointLight(0x49bfff, 5, 8);
  asymmetricLight.position.set(1.05, 0.38, 1.4);
  litScene.add(asymmetricLight);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  litScene.add(lowMesh);
  const lowPixels = await capture(renderer, litScene, visualCamera, target, true);
  litScene.remove(lowMesh);
  litScene.add(epicMesh);
  const epicPixels = await capture(renderer, litScene, visualCamera, target, true);
  litScene.remove(epicMesh);
  paint([lowPixels, epicPixels]);
  const tierDrawingDifference = pixelDifference(lowPixels, epicPixels);

  const cullingEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        bounds: { center: [0.23, -0.11, 0], radius: 0.35 },
        capacity: 32,
        init: [lifetime(10)],
        lifecycle: { duration: 20, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: rate(20),
      }),
    },
    scalability: { culling: { distance: { fadeEnd: 6, fadeStart: 4 }, frustum: false } },
  });
  const cullingSystem = new VFXSystem(runtime, undefined, {
    aliveCountReadbackInterval: 1,
    qualityTier: 'epic',
  });
  cullingSystem.setCamera(identityCameraState());
  const culled = cullingSystem.spawn(cullingEffect, { position: [0, 0, 2], seed: 7 });
  await cullingSystem.update(0.2);
  const cullingView = view(culled);
  const cullingMesh = materializeThreeSpriteDraw(cullingView.program, cullingView.kernels);
  const unmaterializedOrUnrendered = await cullingSystem.debug.captureProfile();
  const cullingScene = new THREE.Scene();
  cullingScene.add(cullingMesh);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(cullingScene, visualCamera);
  cullingScene.remove(cullingMesh);
  const visibleBeforeUserOverride = cullingMesh.visible;
  cullingMesh.setUserVisible(false);
  const hiddenByUser = !cullingMesh.visible;
  culled.setTransform([0, 0, 5]);
  await cullingSystem.update(1 / 60);
  const hiddenDuringRuntimeFade = !cullingMesh.visible;
  const renderableProfile = await cullingSystem.debug.captureProfile();
  const aliveBeforeCull = view(culled).aliveCount;
  const timeBeforeCull = culled.localTime;
  const fadeAtFive = culled.scalability.fade;
  culled.setTransform([0, 0, 8]);
  await cullingSystem.update(0.5);
  const hiddenAcrossRuntimeCull = !cullingMesh.visible;
  const culledProfile = await cullingSystem.debug.captureProfile();
  const aliveWhileCulled = view(culled).aliveCount;
  const timeWhileCulled = culled.localTime;
  cullingMesh.setUserVisible(true);
  const runtimeCullStillWins = !cullingMesh.visible;
  culled.setTransform([0, 0, 1]);
  await cullingSystem.update(0.1);
  const visibleAfterUserRestore = cullingMesh.visible;
  const aliveAfterResume = view(culled).aliveCount;

  const budgetEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        bounds: { center: [-0.27, 0.19, 0.4], radius: 0.2 },
        capacity: 32,
        init: [lifetime(5)],
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 8 }),
      }),
    },
    scalability: { significance: { priority: 0 } },
  });
  const budgetSystem = new VFXSystem(runtime, undefined, {
    qualityTier: 'epic',
    significanceBudget: { maxActiveInstances: 2, maxParticles: 32 },
  });
  budgetSystem.setCamera(identityCameraState());
  const lowPriority = budgetSystem.spawn(budgetEffect, { position: [0.6, -0.2, 3], priority: -1 });
  const highPriority = budgetSystem.spawn(budgetEffect, { position: [-0.2, 0.3, 1], priority: 2 });
  const budgetTie = budgetSystem.spawn(budgetEffect, { position: [0.1, -0.4, 2], priority: 0 });
  await budgetSystem.update(0);

  const frustumEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        bounds: { center: [0, 0, 0], radius: 0.1 },
        capacity: 1,
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 1 }),
      }),
    },
    scalability: { culling: { frustum: true } },
  });
  const frustumSystem = new VFXSystem(runtime);
  frustumSystem.setCamera(cameraState(visualCamera));
  const frustumInside = frustumSystem.spawn(frustumEffect, { position: [0, 0, 0] });
  const frustumOutside = frustumSystem.spawn(frustumEffect, { position: [4, 0, 0] });
  await frustumSystem.update(0);
  const actualSystemFrustum =
    frustumInside.scalability.action === 'full' &&
    frustumOutside.scalability.action === 'culled' &&
    frustumOutside.scalability.reasons.includes('frustum');
  const validation = {
    aliveReadbackTierScale: lowCountView.aliveCount === 12 && epicCountView.aliveCount === 48,
    consoleClean: messages.length === 0,
    cullingFadeLinear: Math.abs(fadeAtFive - 0.5) < 0.08,
    cullingPauseAndResume:
      aliveBeforeCull === aliveWhileCulled &&
      timeBeforeCull === timeWhileCulled &&
      (aliveAfterResume ?? 0) > (aliveWhileCulled ?? 0),
    drawVisibilityComposition:
      visibleBeforeUserOverride &&
      hiddenByUser &&
      hiddenDuringRuntimeFade &&
      hiddenAcrossRuntimeCull &&
      runtimeCullStillWins &&
      visibleAfterUserRestore,
    profilerDrawCulling:
      unmaterializedOrUnrendered.system.indirectDraws.value === 0 &&
      renderableProfile.system.indirectDraws.value === 1 &&
      culledProfile.system.indirectDraws.value === 0,
    deviceReasonPublished: deviceSelection.reasons.length > 0,
    featureGates:
      lowQualityDraw?.kind === 'billboard' &&
      !('lit' in lowQualityDraw.fragment) &&
      !('soft' in lowQualityDraw.fragment) &&
      lowQualityDraw.indirect.physicalIndex === 'alive-indices' &&
      epicQualityDraw?.kind === 'billboard' &&
      'lit' in epicQualityDraw.fragment &&
      'soft' in epicQualityDraw.fragment &&
      epicQualityDraw.indirect.physicalIndex === 'sorted-indices',
    actualSystemFrustum,
    particleBudgetSpawnSuppressed:
      budgetTie.scalability.action === 'spawn-suppressed' &&
      budgetTie.scalability.reasons.includes('significance-particle-budget'),
    significanceDiscrimination:
      highPriority.scalability.action === 'full' &&
      lowPriority.scalability.action !== 'full' &&
      highPriority.scalability.score > budgetTie.scalability.score &&
      budgetTie.scalability.score > lowPriority.scalability.score,
    tierDrawingDifference:
      tierDrawingDifference.changed > 80 && tierDrawingDifference.meanLinearByteDifference > 0.5,
  };
  // Discard correctness-probe work before the dedicated warmed measurement window. Baseline
  // pixels are already painted, so advancing this sample does not alter screenshots.
  await renderer.resolveTimestampsAsync('compute');
  await renderer.resolveTimestampsAsync('render');
  litScene.add(epicMesh);
  await monitor.captureGpuSamples(async () => {
    await qualitySystem.update(1 / 60);
    renderer.setRenderTarget(target);
    renderer.render(litScene, visualCamera);
  });
  litScene.remove(epicMesh);
  validation.consoleClean = messages.length === 0;
  const result = {
    activeBackend,
    culling: {
      aliveAfterResume,
      aliveBeforeCull,
      aliveWhileCulled,
      diagnostics: culled.scalability,
      fadeAtFive,
      visibilityComposition: {
        hiddenAcrossRuntimeCull,
        hiddenByUser,
        hiddenDuringRuntimeFade,
        runtimeCullStillWins,
        visibleAfterUserRestore,
        visibleBeforeUserOverride,
      },
      profile: {
        culled: culledProfile,
        renderable: renderableProfile,
        unmaterializedOrUnrendered,
      },
      timeBeforeCull,
      timeWhileCulled,
    },
    deviceSelection,
    ok: Object.values(validation).every(Boolean),
    quality: {
      compilationCount: qualitySystem.compilationCount + visualSystem.compilationCount,
      epicAlive: epicCountView.aliveCount,
      epicDraw: epicQualityDraw?.kind === 'billboard' ? epicQualityDraw.fragment : undefined,
      lowAlive: lowCountView.aliveCount,
      lowDraw: lowQualityDraw?.kind === 'billboard' ? lowQualityDraw.fragment : undefined,
      tierDrawingDifference,
    },
    significance: {
      high: highPriority.scalability,
      low: lowPriority.scalability,
      tie: budgetTie.scalability,
    },
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'All checks passed'
    : 'Validation failed';
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false, requestedBackend });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
