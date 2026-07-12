import {
  VFXSystem,
  colorOverLife,
  curve,
  defineEffect,
  defineEmitter,
  drag,
  faceCamera,
  gradient,
  gravity,
  killVolume,
  lifetime,
  meshRenderer,
  orientToVelocity,
  pointAttractor,
  positionSphere,
  range,
  rate,
  sizeOverLife,
  turbulence,
  velocityCone,
  vortex,
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
import './golden-ambient.css';

const WIDTH = 320;
const HEIGHT = 240;
const STEP = 1 / 30;
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

type RuntimeInstance = {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  setTimeScale(timeScale: number): void;
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
  if (!element) throw new Error(`Missing golden ambient element: ${selector}`);
  return element;
}

const glowRef: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://golden-ambient/firefly-glow',
};
const leafRef: GeometryRef = {
  assetType: 'geometry',
  kind: 'asset-ref',
  uri: 'procedural://golden-ambient/leaf-quad',
};

// Golden #4 keeps the M4 visual baseline; M11 stress acceptance runs after baseline capture below.
const goldenAmbient = defineEffect({
  elements: {
    fireflies: defineEmitter({
      capacity: 128,
      init: [
        positionSphere({ radius: 2.2 }),
        velocityCone({ angle: 180, direction: [0, 1, 0], speed: range(0.04, 0.16) }),
        lifetime(range(4, 6)),
      ],
      lifecycle: { duration: 4, loopCount: 'infinite' },
      render: faceCamera({ blending: 'additive', map: glowRef }),
      spawn: rate({ rate: 18 }),
      update: [
        pointAttractor({ falloff: 0, position: [0, 0, 0], space: 'emitter', strength: 0.16 }),
        turbulence({ frequency: 1.4, octaves: 3, strength: 0.34 }),
        drag(0.32),
        sizeOverLife(curve([0, 0.055], [0.5, 0.16], [1, 0.055])),
        colorOverLife(gradient([0.35, 1, 0.18, 0.2], [0.9, 1, 0.42, 1], [0.2, 0.8, 0.1, 0.1])),
      ],
    }),
    leaves: defineEmitter({
      capacity: 160,
      init: [
        positionSphere({ radius: 2.4 }),
        velocityCone({ angle: 28, direction: [0.15, -1, 0.08], speed: range(0.16, 0.42) }),
        lifetime(12),
      ],
      lifecycle: { duration: 4, loopCount: 'infinite' },
      render: meshRenderer({
        alignment: { mode: 'quaternion' },
        blending: 'alpha',
        geometry: leafRef,
      }),
      spawn: rate({ rate: 12 }),
      update: [
        gravity(-1.9),
        drag(0.46),
        vortex({ axis: [0, 1, 0], center: [0.4, 1, 0], strength: 0.3 }),
        orientToVelocity(),
        colorOverLife(gradient([0.68, 0.3, 0.06, 0.95], [0.22, 0.08, 0.018, 0.8])),
        killVolume({ mode: 'inside', normal: [0, 1, 0], offset: -1.9, shape: 'plane' }),
      ],
    }),
  },
});

function glowTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const intensity = Math.max(0, 1 - Math.hypot(nx, ny));
      const offset = (y * size + x) * 4;
      data[offset] = 220;
      data[offset + 1] = 255;
      data[offset + 2] = 90;
      data[offset + 3] = Math.round(255 * intensity * intensity);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function leafGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(0.28, 0.52, 1, 1);
  geometry.translate(0, 0.02, 0);
  return geometry;
}

function paintReadback(canvas: HTMLCanvasElement, pixels: ArrayLike<number>): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Golden ambient preview canvas has no 2D context.');
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

function byteEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(headless ? WIDTH : innerWidth, headless ? HEIGHT : innerHeight);
  if (!headless) sceneHost.append(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden ambient loop requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Long-run readback' : 'Visual';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'golden-ambient',
  });
  const resolveTexture = createThreeTextureResolver(new Map([[glowRef.uri, glowTexture()]]));
  const resolveGeometry = createThreeGeometryResolver(new Map([[leafRef.uri, leafGeometry()]]));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06100d);
  const camera = new THREE.OrthographicCamera(-3.4, 3.4, 2.55, -2.55, 0.1, 20);
  camera.position.set(0, 0.55, 6);
  camera.lookAt(0, 0.45, 0);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 5),
    new THREE.MeshBasicMaterial({ color: 0x0d1a12 }),
  );
  ground.position.set(0, -0.72, -0.45);
  scene.add(ground);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });

  const view = (instance: RuntimeInstance, key: string): VfxEmitterRuntimeView => {
    const emitter = instance.getEmitter(key);
    if (!emitter) throw new Error(`Golden ambient emitter "${key}" is missing.`);
    return emitter;
  };
  const createRuntime = async (seed: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 15,
      fixedTimeStep: { maxSubSteps: 32, stepSeconds: STEP },
    });
    const instance = system.spawn(goldenAmbient, {
      position: [0, 1.15, 0],
      seed,
    }) as RuntimeInstance;
    const fireflyView = view(instance, 'fireflies');
    const leafView = view(instance, 'leaves');
    const fireflies = materializeThreeSpriteDraw(fireflyView.program, fireflyView.kernels, 0, {
      resolveTexture,
    });
    const leaves = materializeThreeMeshDraw(leafView.program, leafView.kernels, 0, {
      resolveGeometry,
    });
    await system.update(0);
    return { fireflies, fireflyView, instance, leaves, leafView, system };
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
  const snapshot = async (runtime: Awaited<ReturnType<typeof createRuntime>>) => ({
    fireflyAlive: (await readLogicalAttribute(
      renderer,
      runtime.fireflyView.program,
      runtime.fireflyView.kernels,
      'alive',
    )) as Uint32Array,
    fireflyPosition: (await readLogicalAttribute(
      renderer,
      runtime.fireflyView.program,
      runtime.fireflyView.kernels,
      'position',
    )) as Float32Array,
    leafAlive: (await readLogicalAttribute(
      renderer,
      runtime.leafView.program,
      runtime.leafView.kernels,
      'alive',
    )) as Uint32Array,
    leafPosition: (await readLogicalAttribute(
      renderer,
      runtime.leafView.program,
      runtime.leafView.kernels,
      'position',
    )) as Float32Array,
    leafRotation: (await readLogicalAttribute(
      renderer,
      runtime.leafView.program,
      runtime.leafView.kernels,
      'rotation',
    )) as Float32Array,
    leafSpawnGeneration: (await readLogicalAttribute(
      renderer,
      runtime.leafView.program,
      runtime.leafView.kernels,
      'spawnGeneration',
    )) as Uint32Array,
  });

  const primary = await createRuntime(404);
  const fireflyAliveHistory: number[] = [];
  const leafAliveHistory: number[] = [];
  const leafTracks: {
    generation: number;
    rotation: number[][];
    slot: number;
    y: number[];
  }[] = [];
  let trackedLeaf = -1;
  let trackedGeneration = -1;
  let deterministicReference: Awaited<ReturnType<typeof snapshot>> | undefined;
  for (let sample = 0; sample < 24; sample += 1) {
    await primary.system.update(0.5);
    await performanceMonitor.resolveGpuTimestamps();
    fireflyAliveHistory.push(primary.fireflyView.aliveCount ?? -1);
    leafAliveHistory.push(primary.leafView.aliveCount ?? -1);
    const state = await snapshot(primary);
    const generationChanged =
      trackedLeaf >= 0 && state.leafSpawnGeneration[trackedLeaf] !== trackedGeneration;
    if (trackedLeaf < 0 || state.leafAlive[trackedLeaf] === 0 || generationChanged) {
      trackedLeaf = state.leafAlive.findIndex((alive) => alive !== 0);
      trackedGeneration = trackedLeaf < 0 ? -1 : (state.leafSpawnGeneration[trackedLeaf] ?? -1);
      if (trackedLeaf >= 0) {
        leafTracks.push({
          generation: trackedGeneration,
          rotation: [],
          slot: trackedLeaf,
          y: [],
        });
      }
    }
    if (trackedLeaf >= 0 && state.leafAlive[trackedLeaf] !== 0) {
      const track = leafTracks.at(-1);
      track?.y.push(state.leafPosition[trackedLeaf * 3 + 1] ?? Number.NaN);
      track?.rotation.push(
        Array.from(state.leafRotation.subarray(trackedLeaf * 4, trackedLeaf * 4 + 4)),
      );
    }
    if (sample === 11) deterministicReference = state;
  }
  const finalState = await snapshot(primary);
  const liveFireflyPositions: number[] = [];
  for (let particle = 0; particle < finalState.fireflyAlive.length; particle += 1) {
    if (finalState.fireflyAlive[particle] === 0) continue;
    liveFireflyPositions.push(
      finalState.fireflyPosition[particle * 3] ?? 0,
      finalState.fireflyPosition[particle * 3 + 1] ?? 0,
      finalState.fireflyPosition[particle * 3 + 2] ?? 0,
    );
  }
  const means = [0, 1, 2].map((axis) => {
    let sum = 0;
    for (let index = axis; index < liveFireflyPositions.length; index += 3) {
      sum += liveFireflyPositions[index] ?? 0;
    }
    return sum / Math.max(1, liveFireflyPositions.length / 3);
  });
  const positionVariance =
    liveFireflyPositions.reduce((sum, value, index) => {
      return sum + (value - means[index % 3]!) ** 2;
    }, 0) / Math.max(1, liveFireflyPositions.length);
  const maximumFireflyRadius = Math.max(
    0,
    ...Array.from({ length: liveFireflyPositions.length / 3 }, (_, particle) =>
      Math.hypot(
        (liveFireflyPositions[particle * 3] ?? 0) - 0,
        (liveFireflyPositions[particle * 3 + 1] ?? 0) - 1.15,
        (liveFireflyPositions[particle * 3 + 2] ?? 0) - 0,
      ),
    ),
  );

  const duplicate = await createRuntime(404);
  for (let sample = 0; sample < 12; sample += 1) {
    await duplicate.system.update(0.5);
    await performanceMonitor.resolveGpuTimestamps();
  }
  const duplicateState = await snapshot(duplicate);
  const deterministic =
    deterministicReference !== undefined &&
    byteEqual(deterministicReference.fireflyAlive, duplicateState.fireflyAlive) &&
    byteEqual(deterministicReference.fireflyPosition, duplicateState.fireflyPosition) &&
    byteEqual(deterministicReference.leafAlive, duplicateState.leafAlive) &&
    byteEqual(deterministicReference.leafPosition, duplicateState.leafPosition) &&
    byteEqual(deterministicReference.leafRotation, duplicateState.leafRotation);

  const fireflyPixels = await render([primary.fireflies]);
  const leafPixels = await render([primary.leaves]);
  paintReadback(requireElement<HTMLCanvasElement>('#ambient-fireflies'), fireflyPixels);
  paintReadback(requireElement<HTMLCanvasElement>('#ambient-leaves'), leafPixels);

  // Run the M11 scale/significance phase only after both baseline images have been captured so the
  // established golden-ambient-fireflies/leaves pixels remain unchanged.
  const stressSystem = new VFXSystem(runtimeRenderer, undefined, {
    significanceBudget: { maxActiveInstances: 12, maxParticles: 3 * (128 + 160) },
  });
  const stressInstances = Array.from({ length: 24 }, (_, index) =>
    stressSystem.spawn(goldenAmbient, {
      position: [(index % 6) * 0.15, Math.floor(index / 6) * 0.1, 0],
      priority: 24 - index,
      seed: 9_000 + index,
    }),
  );
  await stressSystem.update(0);
  const stressActions = stressInstances.map(({ scalability }) => scalability);
  const stressCounts = {
    culled: stressActions.filter(({ action }) => action === 'culled').length,
    full: stressActions.filter(({ action }) => action === 'full').length,
    spawnSuppressed: stressActions.filter(({ action }) => action === 'spawn-suppressed').length,
  };
  const scaleSignificanceStress =
    stressCounts.full === 3 &&
    stressCounts.spawnSuppressed === 9 &&
    stressCounts.culled === 12 &&
    stressActions.some(({ reasons }) => reasons.includes('significance-particle-budget')) &&
    stressActions.some(({ reasons }) => reasons.includes('significance-instance-budget'));
  const fireflySteady = fireflyAliveHistory.slice(-8);
  const leafSteady = leafAliveHistory.slice(-8);
  const stableBand = (values: readonly number[], tolerance: number) =>
    values.length > 1 && Math.max(...values) - Math.min(...values) <= tolerance;
  const hasDecrease = (values: readonly number[]) =>
    values.some((value, index) => index > 0 && value < (values[index - 1] ?? value));
  const eligibleLeafTracks = leafTracks.filter(({ y }) => y.length >= 2);
  const trackFallsAndRotates = (track: (typeof eligibleLeafTracks)[number]) =>
    track.y.every((value, index) => index === 0 || value < (track.y[index - 1] ?? value)) &&
    track.rotation.every((quaternion) => quaternion.every(Number.isFinite)) &&
    Math.max(
      0,
      ...track.rotation
        .slice(1)
        .map((quaternion) =>
          Math.hypot(
            ...quaternion.map((value, axis) => value - (track.rotation[0]?.[axis] ?? value)),
          ),
        ),
    ) > 0.01;
  const leavesFallAndRotate =
    eligibleLeafTracks.length > 0 && eligibleLeafTracks.every(trackFallsAndRotates);
  const validation = {
    consoleClean: consoleMessages.length === 0,
    deterministic,
    fireflyMotion:
      liveFireflyPositions.length > 0 && positionVariance > 0.001 && maximumFireflyRadius < 6,
    leavesFallAndRotate,
    scaleSignificanceStress,
    // Churn bands scale with capacity: 28 / 128 ~= 22% for fireflies and
    // 22 / 160 ~= 14% for leaves, covering each emitter's expected spawn/retire cadence.
    steadyState:
      stableBand(fireflySteady, 28) &&
      stableBand(leafSteady, 22) &&
      hasDecrease(fireflyAliveHistory) &&
      hasDecrease(leafAliveHistory),
  };
  const result = {
    consoleMessages,
    deterministic,
    fireflies: {
      aliveHistory: fireflyAliveHistory,
      maximumRadius: maximumFireflyRadius,
      positionVariance,
      steadyBand: fireflySteady,
    },
    leaves: {
      aliveHistory: leafAliveHistory,
      eligibleTrackCount: eligibleLeafTracks.length,
      steadyBand: leafSteady,
      tracks: leafTracks,
    },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    thresholds: {
      fireflyAliveBand: 28,
      fireflyMaximumRadius: 6,
      fireflyMinimumVariance: 0.001,
      leafAliveBand: 22,
      leafMinimumRotationDelta: 0.01,
      simulatedSeconds: 12,
    },
    stress: { instanceCount: stressInstances.length, ...stressCounts },
    validation,
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-ambient-fireflies.png', selector: '#ambient-fireflies' },
    { filename: 'golden-ambient-leaves.png', selector: '#ambient-leaves' },
  ]);
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'Golden ambient verified' : 'Golden ambient failed';

  if (!headless) {
    scene.add(primary.fireflies, primary.leaves);
    const settings = { fireflies: true, leaves: true, playbackSpeed: 1, scale: 1 };
    const pane = new Pane({ title: 'Ambient controls' });
    pane.addBinding(settings, 'playbackSpeed', { label: 'Playback', max: 2, min: 0, step: 0.05 });
    pane.addBinding(settings, 'scale', { label: 'Field scale', max: 1.8, min: 0.5, step: 0.05 });
    pane.addBinding(settings, 'fireflies', { label: 'Fireflies' });
    pane.addBinding(settings, 'leaves', { label: 'Leaves' });
    let previous: number | undefined;
    let updating = false;
    renderer.setAnimationLoop((timestamp) => {
      if (updating) return;
      const delta = previous === undefined ? STEP : Math.min((timestamp - previous) / 1000, 0.1);
      previous = timestamp;
      primary.instance.setTimeScale(settings.playbackSpeed);
      primary.fireflies.visible = settings.fireflies;
      primary.leaves.visible = settings.leaves;
      primary.fireflies.scale.setScalar(settings.scale);
      primary.leaves.scale.setScalar(settings.scale);
      updating = true;
      void primary.system
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
