import {
  VFXSystem,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  perDistance,
  range,
  rate,
  velocityCone,
} from '@nachi/core';
import type { ModuleDefinition, SpawnModule, VfxEmitterRuntimeView } from '@nachi/core';
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

type RendererBackendLike = {
  device?: {
    features?: { has(feature: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  readonly diagnostics: readonly { code: string }[];
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  setTransform(position: readonly [number, number, number]): void;
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

function smokeEffect(options: {
  readonly capacity: number;
  readonly duration?: number;
  readonly lifetimeSeconds?: number;
  readonly loopCount?: number;
  readonly randomVelocity?: boolean;
  readonly spawn: SpawnModule | readonly SpawnModule[];
}) {
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: options.capacity,
        init: [
          ...(options.randomVelocity
            ? [
                velocityCone({
                  angle: 0,
                  direction: [1, 0, 0],
                  speed: range(1, 2),
                }),
              ]
            : []),
          lifetime(options.lifetimeSeconds ?? 10),
        ],
        integration: 'none',
        lifecycle: {
          duration: options.duration ?? 1,
          ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
        },
        render: computeRender,
        spawn: options.spawn,
      }),
    },
  });
}

function emitter(instance: RuntimeInstance): VfxEmitterRuntimeView {
  const value = instance.getEmitter('particles');
  if (!value) throw new Error('M2 runtime emitter is missing.');
  return value;
}

async function uintStorage(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  name: 'alive' | 'spawnGeneration',
): Promise<Uint32Array> {
  const storage = emitter(instance).kernels.storages[name];
  if (!storage) throw new Error(`M2 runtime emitter storage "${name}" is missing.`);
  return (await readStorage(renderer, storage, 'uint')) as Uint32Array;
}

async function floatStorage(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  name: 'velocity',
): Promise<Float32Array> {
  const storage = emitter(instance).kernels.storages[name];
  if (!storage) throw new Error(`M2 runtime emitter storage "${name}" is missing.`);
  return (await readStorage(renderer, storage, 'float')) as Float32Array;
}

async function aliveCount(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
): Promise<number> {
  const kernels = emitter(instance).kernels;
  const counters = (await readStorage(renderer, kernels.aliveCount, 'uint')) as Uint32Array;
  return counters[kernels.counterOffsets.aliveCount] ?? 0;
}

async function indirectInstanceCount(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
): Promise<number> {
  const indirect = emitter(instance).kernels.drawIndirect;
  if (!indirect) throw new Error('M2 draw-indirect arguments are missing.');
  const data = await renderer.getArrayBufferAsync(indirect.indirectResource as never);
  return new Uint32Array(data)[1] ?? 0;
}

function equalArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

async function runSmoke(): Promise<void> {
  if (requestedBackend === 'webgl') {
    const error =
      'NACHI_M2_RUNTIME_WEBGPU_ONLY: GPU free-list smoke coverage requires WebGPU; WebGL2 uses the compiler-declared CPU alive-count fallback.';
    backendValue.textContent = 'WebGL2 (fallback documented)';
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
  if (!backend.isWebGPUBackend) throw new Error('M2 runtime smoke requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';

  const storageBufferLimit = backend.device?.limits?.maxStorageBuffersPerShaderStage;
  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
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
  const systemOptions = {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  } as const;

  root.dataset.spikeStatus = 'running';
  statusValue.textContent = 'Running M2 allocation, spawn, recycle, and indirect-draw scenarios…';

  // 1. Rate: 30/s for one second must produce exactly 30 particles with fixed timesteps.
  const rateSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const rateInstance = rateSystem.spawn(
    smokeEffect({ capacity: 64, duration: 1, spawn: rate({ rate: 30 }) }),
    { seed: 11 },
  );
  await rateSystem.update(0);
  for (let frame = 0; frame < 60; frame += 1) await rateSystem.update(FIXED_DELTA_SECONDS);
  const rateAlive = await aliveCount(renderer, rateInstance);

  // 2. A one-slot emitter must recycle the same index and advance its particle generation/RNG.
  const recycleSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const recycled = recycleSystem.spawn(
    smokeEffect({
      capacity: 1,
      duration: FIXED_DELTA_SECONDS * 2,
      lifetimeSeconds: FIXED_DELTA_SECONDS,
      loopCount: 2,
      randomVelocity: true,
      spawn: burst({ count: 1 }),
    }),
    { seed: 19 },
  );
  await recycleSystem.update(0);
  const firstGeneration = await uintStorage(renderer, recycled, 'spawnGeneration');
  const firstVelocity = await floatStorage(renderer, recycled, 'velocity');
  await recycleSystem.update(FIXED_DELTA_SECONDS);
  await recycleSystem.update(FIXED_DELTA_SECONDS);
  const secondGeneration = await uintStorage(renderer, recycled, 'spawnGeneration');
  const secondVelocity = await floatStorage(renderer, recycled, 'velocity');

  // 3. Per-distance: moving two units at four particles/unit must emit eight.
  const distanceSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const distanceInstance = distanceSystem.spawn(
    smokeEffect({ capacity: 16, spawn: perDistance({ rate: 4 }) }),
    { seed: 23 },
  );
  await distanceSystem.update(0);
  distanceInstance.setTransform([2, 0, 0]);
  await distanceSystem.update(FIXED_DELTA_SECONDS);
  const distanceAlive = await aliveCount(renderer, distanceInstance);

  // 4/5. Atomic compaction count, alive flags, and indirect instanceCount must agree.
  const distanceFlags = await uintStorage(renderer, distanceInstance, 'alive');
  const actualAlive = distanceFlags.reduce((sum, value) => sum + (value === 0 ? 0 : 1), 0);
  const indirectAlive = await indirectInstanceCount(renderer, distanceInstance);

  // 6. Exhaustion clamps safely and publishes a stable warning diagnostic.
  const overflowSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const overflowed = overflowSystem.spawn(
    smokeEffect({ capacity: 2, duration: 0, spawn: burst({ count: 5 }) }),
    { seed: 29 },
  );
  await overflowSystem.update(0);
  const overflowAlive = await aliveCount(renderer, overflowed);

  // 7. Identical seeds and schedules must produce bit-identical particle state.
  const deterministicEffect = smokeEffect({
    capacity: 4,
    randomVelocity: true,
    spawn: burst({ count: 4 }),
  });
  const deterministicSystemA = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const deterministicSystemB = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const deterministicA = deterministicSystemA.spawn(deterministicEffect, { seed: 31 });
  const deterministicB = deterministicSystemB.spawn(deterministicEffect, { seed: 31 });
  await deterministicSystemA.update(0);
  await deterministicSystemB.update(0);
  const deterministicVelocityA = await floatStorage(renderer, deterministicA, 'velocity');
  const deterministicVelocityB = await floatStorage(renderer, deterministicB, 'velocity');
  const deterministicGenerationA = await uintStorage(renderer, deterministicA, 'spawnGeneration');
  const deterministicGenerationB = await uintStorage(renderer, deterministicB, 'spawnGeneration');

  const validation = {
    aliveCountMatchesFlags: distanceAlive === actualAlive,
    deterministic:
      equalArrays(deterministicVelocityA, deterministicVelocityB) &&
      equalArrays(deterministicGenerationA, deterministicGenerationB),
    freeListExhaustionSafe:
      overflowAlive === 2 &&
      overflowed.diagnostics.some(({ code }) => code === 'NACHI_SPAWN_CAPACITY_EXCEEDED'),
    indirectCountMatchesAlive: indirectAlive === distanceAlive,
    perDistanceProportional: distanceAlive === 8,
    rateSpawnTotal: rateAlive === 30,
    recycledIndexHasNewRandomStream:
      firstGeneration[0] === 1 &&
      secondGeneration[0] === 2 &&
      !equalArrays(firstVelocity, secondVelocity),
  };
  const ok = Object.values(validation).every(Boolean);
  const result = {
    backend: 'WebGPU',
    counts: {
      actualAlive,
      distanceAlive,
      indirectAlive,
      overflowAlive,
      rateAlive,
    },
    ok,
    recycle: {
      firstGeneration: firstGeneration[0],
      firstVelocity: [...firstVelocity.slice(0, 3)],
      secondGeneration: secondGeneration[0],
      secondVelocity: [...secondVelocity.slice(0, 3)],
    },
    requestedBackend,
    validation,
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  statusValue.textContent = ok ? 'M2 GPU smoke complete' : 'M2 GPU smoke validation failed';
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
