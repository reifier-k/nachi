import {
  VFXSystem,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  range,
  velocityCone,
} from '@nachi/core';
import type { ModuleDefinition, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  readStorage,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './spike-compute.css';

const FIXED_DELTA_SECONDS = 1 / 60;
const PREWARM_FRAMES = 4;

type RendererBackendLike = {
  device?: {
    features?: { has(feature: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const backendValue = requireElement<HTMLElement>('#backend-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLElement>('#scene');

root.dataset.backendRequested = requestedBackend;
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M2 runtime smoke element: ${selector}`);
  return element;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  stage: 'render',
  type: 'test/m2-compute-only',
  version: 1,
};

function movingEffect(
  options: {
    readonly duration?: number;
    readonly loopCount?: number;
    readonly prewarm?: number;
    readonly randomSpeed?: boolean;
  } = {},
) {
  const emitter = defineEmitter({
    capacity: 1,
    init: [
      velocityCone({
        angle: 0,
        direction: [1, 0, 0],
        speed: options.randomSpeed ? range(1, 2) : 1,
      }),
      lifetime(10),
    ],
    lifecycle: {
      duration: options.duration ?? 1,
      ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
      ...(options.prewarm === undefined ? {} : { prewarm: options.prewarm }),
    },
    render: computeRender,
    spawn: burst({ count: 1 }),
  });
  return defineEffect({ elements: { particles: emitter } });
}

async function storageValues(
  renderer: THREE.WebGPURenderer,
  instance: { getEmitter(key: string): VfxEmitterRuntimeView | undefined },
  name: 'position' | 'velocity',
): Promise<Float32Array> {
  const storage = instance.getEmitter('particles')?.kernels.storages[name];
  if (!storage) throw new Error(`M2 runtime emitter storage "${name}" is missing.`);
  return (await readStorage(renderer, storage, 'float')) as Float32Array;
}

function equalArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

function close(left: number, right: number, tolerance = 0.0002): boolean {
  return Math.abs(left - right) <= tolerance;
}

async function runSmoke(): Promise<void> {
  if (requestedBackend === 'webgl') {
    const error =
      'NACHI_M2_RUNTIME_WEBGPU_ONLY: The M2 runtime smoke is WebGPU-only while GPU allocation and indirect-draw gates remain pending.';
    backendValue.textContent = 'WebGL2 (unsupported)';
    root.dataset.backend = 'WebGL2';
    root.dataset.rendererStatus = 'unsupported';
    root.dataset.spikeError = error;
    root.dataset.spikeResult = JSON.stringify({ error, ok: false, requestedBackend });
    root.dataset.spikeStatus = 'error';
    root.dataset.sceneReady = 'true';
    statusValue.textContent = error;
    return;
  }

  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: false,
    trackTimestamp: true,
  });
  if (!headless) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    sceneHost.append(renderer.domElement);
  }
  await renderer.init();
  const backend = renderer.backend as RendererBackendLike;
  if (!backend.isWebGPUBackend)
    throw new Error('M2 runtime smoke requires an active WebGPU backend.');
  backendValue.textContent = 'WebGPU';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';

  const storageBufferLimit = backend.device?.limits?.maxStorageBuffersPerShaderStage;
  const linearFloat32Filtering = backend.device?.features?.has('float32-filterable') === true;
  const kernelAdapter = createThreeKernelAdapter({
    linearFloat32Filtering,
    ...(storageBufferLimit === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: storageBufferLimit }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'm2-runtime',
  });

  root.dataset.spikeStatus = 'running';
  statusValue.textContent = 'Scheduling VFXSystem runtime scenarios…';

  const movementSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { maxSubSteps: 8, stepSeconds: FIXED_DELTA_SECONDS },
  });
  const movementDefinition = movingEffect();
  const normal = movementSystem.spawn(movementDefinition, { seed: 7 });
  const paused = movementSystem.spawn(movementDefinition, { seed: 7, timeScale: 0 });
  const fast = movementSystem.spawn(movementDefinition, { seed: 7, timeScale: 2 });
  await movementSystem.update(0);
  const normalInitial = await storageValues(renderer, normal, 'position');
  const pausedInitial = await storageValues(renderer, paused, 'position');
  const fastInitial = await storageValues(renderer, fast, 'position');
  await movementSystem.update(FIXED_DELTA_SECONDS);
  const normalFinal = await storageValues(renderer, normal, 'position');
  const pausedFinal = await storageValues(renderer, paused, 'position');
  const fastFinal = await storageValues(renderer, fast, 'position');
  const normalAdvance = (normalFinal[0] ?? Number.NaN) - (normalInitial[0] ?? Number.NaN);
  const fastAdvance = (fastFinal[0] ?? Number.NaN) - (fastInitial[0] ?? Number.NaN);

  const loopSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  });
  const looped = loopSystem.spawn(
    movingEffect({ duration: FIXED_DELTA_SECONDS, loopCount: 2, randomSpeed: true }),
    { seed: 19 },
  );
  await loopSystem.update(0);
  const firstGenerationVelocity = await storageValues(renderer, looped, 'velocity');
  await loopSystem.update(FIXED_DELTA_SECONDS);
  const secondGenerationVelocity = await storageValues(renderer, looped, 'velocity');

  const warmSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  });
  const coldSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  });
  const warmed = warmSystem.spawn(movingEffect({ prewarm: PREWARM_FRAMES * FIXED_DELTA_SECONDS }), {
    seed: 23,
  });
  const cold = coldSystem.spawn(movingEffect(), { seed: 23 });
  await warmSystem.update(0);
  await coldSystem.update(0);
  for (let frame = 0; frame < PREWARM_FRAMES; frame += 1) {
    await coldSystem.update(FIXED_DELTA_SECONDS);
  }
  const warmedPosition = await storageValues(renderer, warmed, 'position');
  const coldPosition = await storageValues(renderer, cold, 'position');

  const validation = {
    compileCacheOk: movementSystem.compilationCount === 1,
    durationLoopGenerationOk:
      looped.getEmitter('particles')?.spawnGeneration === 1 &&
      !equalArrays(firstGenerationVelocity, secondGenerationVelocity),
    prewarmDeterministic: equalArrays(warmedPosition, coldPosition),
    timeAdvanced: normalAdvance > 0,
    timeScalePaused: equalArrays(pausedInitial, pausedFinal),
    timeScaleTwice: close(fastAdvance, normalAdvance * 2),
  };
  const ok = Object.values(validation).every(Boolean);
  const result = {
    backend: 'WebGPU',
    compileCounts: {
      cold: coldSystem.compilationCount,
      loop: loopSystem.compilationCount,
      movement: movementSystem.compilationCount,
      warm: warmSystem.compilationCount,
    },
    loop: {
      firstGenerationVelocity: [...firstGenerationVelocity.slice(0, 3)],
      secondGenerationVelocity: [...secondGenerationVelocity.slice(0, 3)],
      spawnGeneration: looped.getEmitter('particles')?.spawnGeneration,
    },
    movement: {
      fastAdvance,
      normalAdvance,
      pausedUnchanged: equalArrays(pausedInitial, pausedFinal),
    },
    ok,
    prewarm: {
      cold: [...coldPosition.slice(0, 3)],
      frames: PREWARM_FRAMES,
      warmed: [...warmedPosition.slice(0, 3)],
    },
    requestedBackend,
    validation,
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  statusValue.textContent = ok ? 'M2 runtime smoke complete' : 'M2 runtime validation failed';
}

void runSmoke().catch((error) => {
  const errorText = message(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = errorText;
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({ error: errorText, ok: false, requestedBackend });
  root.dataset.sceneReady = 'true';
  statusValue.textContent = `Error: ${errorText}`;
});
