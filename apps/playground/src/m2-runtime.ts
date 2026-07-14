import {
  VFXSystem,
  attribute,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  perDistance,
  positionSphere,
  range,
  rate,
  velocityCone,
} from '@nachi/core';
import type { ModuleDefinition, SpawnModule, ValueInput, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi/three';
import { readLogicalAttribute, readStorage } from './three-runtime-readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './spike-compute.css';

const FIXED_DELTA_SECONDS = 1 / 60;
const PREWARM_FRAMES = 4;
// Interpolation uses at most a few dozen unit-scale f32 operations. This is a roundoff-derived
// budget (32 IEEE-754 f32 ulps at magnitude one), not an arbitrary visual epsilon.
const SPAWN_INTERPOLATION_ERROR_BUDGET = 32 * 2 ** -23;

type RendererBackendLike = {
  device?: {
    features?: { has(feature: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  gl?: WebGL2RenderingContext;
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
const requestedScenario = query.get('scenario') ?? 'all';
if (!['all', 'lifecycle', 'time'].includes(requestedScenario)) {
  throw new Error('scenario must be one of: all, lifecycle, time.');
}
const scenario = requestedScenario as 'all' | 'lifecycle' | 'time';
const backendValue = requireElement<HTMLElement>('#backend-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLElement>('#scene');

root.dataset.backendRequested = requestedBackend;
root.dataset.headless = String(headless);
root.dataset.scenario = scenario;
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

const consoleMessages: string[] = [];
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(`warning: ${values.map(message).join(' ')}`);
  originalConsoleWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(`error: ${values.map(message).join(' ')}`);
  originalConsoleError(...values);
};

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

function webglInitializeBudgetEffect() {
  const zero4 = [0, 0, 0, 0] as const;
  return defineEffect({
    elements: {
      particles: defineEmitter({
        attributes: {
          customA: attribute('customA', { default: zero4, type: 'vec4' }),
          customB: attribute('customB', { default: zero4, type: 'vec4' }),
          customC: attribute('customC', { default: zero4, type: 'vec4' }),
        },
        capacity: 8,
        init: [lifetime(1)],
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    },
  });
}

function movingEffect(
  options: {
    readonly duration?: number;
    readonly lifetimeSeconds?: number;
    readonly loopCount?: number;
    readonly prewarm?: number;
    readonly randomSpeed?: boolean;
  } = {},
) {
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 1,
        init: [
          velocityCone({
            angle: 0,
            direction: [1, 0, 0],
            speed: options.randomSpeed ? range(1, 2) : 1,
          }),
          lifetime(options.lifetimeSeconds ?? 10),
        ],
        lifecycle: {
          duration: options.duration ?? 1,
          ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
          ...(options.prewarm === undefined ? {} : { prewarm: options.prewarm }),
        },
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    },
  });
}

function placementEffect(
  spawn: SpawnModule | readonly SpawnModule[],
  radius: ValueInput<number> = 0,
  capacity = 16,
) {
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity,
        init: [positionSphere({ radius }), lifetime(10)],
        integration: 'none',
        lifecycle: { duration: 1 },
        render: computeRender,
        spawn,
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
  const runtimeEmitter = emitter(instance);
  return (await readLogicalAttribute(
    renderer,
    runtimeEmitter.program,
    runtimeEmitter.kernels,
    name,
  )) as Uint32Array;
}

async function floatStorage(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  name: 'position' | 'velocity',
): Promise<Float32Array> {
  const runtimeEmitter = emitter(instance);
  return (await readLogicalAttribute(
    renderer,
    runtimeEmitter.program,
    runtimeEmitter.kernels,
    name,
  )) as Float32Array;
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
  const offset = emitter(instance).kernels.drawIndirectOffsetBytes;
  if (offset === undefined) throw new Error('M2 draw-indirect offset is missing.');
  const data = await renderer.getArrayBufferAsync(indirect.indirectResource as never);
  return new Uint32Array(data)[offset / Uint32Array.BYTES_PER_ELEMENT + 1] ?? 0;
}

function equalArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

function close(left: number, right: number, tolerance = 0.0002): boolean {
  return Math.abs(left - right) <= tolerance;
}

async function alivePositions(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
): Promise<readonly (readonly [number, number, number])[]> {
  const [alive, position] = await Promise.all([
    uintStorage(renderer, instance, 'alive'),
    floatStorage(renderer, instance, 'position'),
  ]);
  return Array.from({ length: alive.length }, (_, particle) => particle)
    .filter((particle) => alive[particle] !== 0)
    .map(
      (particle) =>
        [
          position[particle * 3] ?? Number.NaN,
          position[particle * 3 + 1] ?? Number.NaN,
          position[particle * 3 + 2] ?? Number.NaN,
        ] as const,
    );
}

function lineDistribution(
  positions: readonly (readonly [number, number, number])[],
  expectedCount: number,
  maximumSpacing: number,
): { readonly maximumGap: number; readonly valid: boolean; readonly xs: readonly number[] } {
  const xs = positions.map(([x]) => x).sort((left, right) => left - right);
  const maximumGap = Math.max(
    0,
    ...xs.slice(1).map((value, index) => value - (xs[index] ?? value)),
  );
  return {
    maximumGap,
    valid:
      positions.length === expectedCount &&
      positions.every(
        ([x, y, z]) =>
          x >= -SPAWN_INTERPOLATION_ERROR_BUDGET &&
          x <= 0.5 + SPAWN_INTERPOLATION_ERROR_BUDGET &&
          Math.abs(y) <= SPAWN_INTERPOLATION_ERROR_BUDGET &&
          Math.abs(z) <= SPAWN_INTERPOLATION_ERROR_BUDGET,
      ) &&
      maximumGap <= maximumSpacing + SPAWN_INTERPOLATION_ERROR_BUDGET * 2,
    xs,
  };
}

async function runLifecycleScenario(
  renderer: THREE.WebGPURenderer,
  runtimeRenderer: ReturnType<typeof createThreeRuntimeRenderer>,
  performanceMonitor: ReturnType<typeof createPerformanceMonitor>,
) {
  const systemOptions = {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  } as const;
  // 1. Rate: 30/s for one second must produce exactly 30 particles with fixed timesteps.
  const rateSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const rateInstance = rateSystem.spawn(
    smokeEffect({ capacity: 64, duration: 1, spawn: rate({ rate: 30 }) }),
    { seed: 11 },
  );
  await rateSystem.update(0);
  for (let frame = 0; frame < 60; frame += 1) {
    await rateSystem.update(FIXED_DELTA_SECONDS);
    await performanceMonitor.resolveGpuTimestamps();
  }
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

  // 3. Per-distance: the accumulator fires ten particles along one 0.5-unit segment.
  const distanceSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const distanceInstance = distanceSystem.spawn(placementEffect(perDistance({ rate: 20 })), {
    seed: 23,
  });
  await distanceSystem.update(0);
  distanceInstance.setTransform([0.5, 0, 0]);
  await distanceSystem.update(FIXED_DELTA_SECONDS);
  const distanceAlive = await aliveCount(renderer, distanceInstance);
  const distanceDistribution = lineDistribution(
    await alivePositions(renderer, distanceInstance),
    10,
    1 / 20,
  );

  // 4. Timed births use deterministic midpoints across the same moving segment.
  const movingRateSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const movingRate = movingRateSystem.spawn(placementEffect(rate(600)), { seed: 24 });
  await movingRateSystem.update(0);
  movingRate.setTransform([0.5, 0, 0]);
  await movingRateSystem.update(FIXED_DELTA_SECONDS);
  const rateDistribution = lineDistribution(await alivePositions(renderer, movingRate), 10, 1 / 20);

  // 5. GPU free-list saturation must retain the leading phases of the CPU-clamped rate batch.
  // Eight existing particles leave two slots; a ten-birth request therefore keeps phases 0.05
  // and 0.15 rather than redistributing the two successful births across the segment.
  const partialOccupancySystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const partialOccupancy = partialOccupancySystem.spawn(
    placementEffect([burst({ count: 8 }), rate(600)], 0, 10),
    { seed: 25 },
  );
  await partialOccupancySystem.update(0);
  const partialOccupancyAliveBefore = await aliveCount(renderer, partialOccupancy);
  partialOccupancy.setTransform([1, 0, 0]);
  await partialOccupancySystem.update(FIXED_DELTA_SECONDS);
  const partialOccupancyAliveAfter = await aliveCount(renderer, partialOccupancy);
  const partialOccupancyPositions = await alivePositions(renderer, partialOccupancy);
  const partialOccupancyXs = partialOccupancyPositions
    .map(([x]) => x)
    .sort((left, right) => left - right);
  const partialOccupancyExpectedXs = [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.15] as const;
  const partialOccupancyPhasesValid =
    partialOccupancyAliveBefore === 8 &&
    partialOccupancyAliveAfter === 10 &&
    partialOccupancyXs.length === partialOccupancyExpectedXs.length &&
    partialOccupancyXs.every(
      (value, index) =>
        Math.abs(value - (partialOccupancyExpectedXs[index] ?? Number.NaN)) <=
        SPAWN_INTERPOLATION_ERROR_BUDGET,
    ) &&
    partialOccupancyPositions.every(
      ([, y, z]) =>
        Math.abs(y) <= SPAWN_INTERPOLATION_ERROR_BUDGET &&
        Math.abs(z) <= SPAWN_INTERPOLATION_ERROR_BUDGET,
    );

  // 6. interpolationActive=0 must retain the current-transform path bit-for-bit. A static timed
  // batch and an equivalent static burst therefore produce identical seeded positions.
  const staticDefinition = placementEffect(rate(600), range(0.1, 0.4));
  const staticControlDefinition = placementEffect(burst({ count: 10 }), range(0.1, 0.4));
  const staticSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const staticControlSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const staticTimed = staticSystem.spawn(staticDefinition, { seed: 25 });
  const staticControl = staticControlSystem.spawn(staticControlDefinition, { seed: 25 });
  await staticSystem.update(0);
  await staticControlSystem.update(0);
  await staticSystem.update(FIXED_DELTA_SECONDS);
  const staticTimedPositions = await floatStorage(renderer, staticTimed, 'position');
  const staticControlPositions = await floatStorage(renderer, staticControl, 'position');

  // 7. A pooled kernel whose prior generation moved must respawn exactly like a fresh kernel.
  const pooledDefinition = placementEffect(burst({ count: 10 }), range(0.1, 0.4));
  const pooledSystem = new VFXSystem(runtimeRenderer, undefined, {
    ...systemOptions,
    maxPoolSize: 1,
  });
  const previousGeneration = pooledSystem.spawn(pooledDefinition, { seed: 26 });
  await pooledSystem.update(0);
  previousGeneration.setTransform([0.5, 0, 0]);
  await pooledSystem.update(FIXED_DELTA_SECONDS);
  previousGeneration.release();
  const pooledRespawn = pooledSystem.spawn(pooledDefinition, {
    position: [2, 0, 0],
    seed: 27,
  });
  await pooledSystem.update(0);
  const freshPoolControlSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const freshPoolControl = freshPoolControlSystem.spawn(pooledDefinition, {
    position: [2, 0, 0],
    seed: 27,
  });
  await freshPoolControlSystem.update(0);
  const pooledRespawnPositions = await floatStorage(renderer, pooledRespawn, 'position');
  const freshPoolControlPositions = await floatStorage(renderer, freshPoolControl, 'position');

  // 8/9. Atomic compaction count, alive flags, and indirect instanceCount must agree.
  const distanceFlags = await uintStorage(renderer, distanceInstance, 'alive');
  const actualAlive = distanceFlags.reduce((sum, value) => sum + (value === 0 ? 0 : 1), 0);
  const indirectAlive = await indirectInstanceCount(renderer, distanceInstance);

  // 10. Exhaustion clamps safely and publishes a stable warning diagnostic.
  const overflowSystem = new VFXSystem(runtimeRenderer, undefined, systemOptions);
  const overflowed = overflowSystem.spawn(
    smokeEffect({ capacity: 2, duration: 0, spawn: burst({ count: 5 }) }),
    { seed: 29 },
  );
  await overflowSystem.update(0);
  const overflowAlive = await aliveCount(renderer, overflowed);

  // 11. Identical seeds and schedules must produce bit-identical particle state.
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
    perDistanceInterpolated:
      distanceAlive === 10 &&
      distanceDistribution.valid &&
      (distanceDistribution.xs[0] ?? 1) < 0.1 &&
      (distanceDistribution.xs.at(-1) ?? 0) > 0.45,
    partialOccupancyKeepsLeadingRatePhases: partialOccupancyPhasesValid,
    rateInterpolated:
      rateDistribution.valid &&
      (rateDistribution.xs[0] ?? 1) < 0.1 &&
      (rateDistribution.xs.at(-1) ?? 0) > 0.4,
    rateSpawnTotal: rateAlive === 30,
    recycledIndexHasNewRandomStream:
      firstGeneration[0] === 1 &&
      secondGeneration[0] === 2 &&
      !equalArrays(firstVelocity, secondVelocity),
    respawnTransformHistoryReset: equalArrays(pooledRespawnPositions, freshPoolControlPositions),
    stationaryCurrentPathBitExact: equalArrays(staticTimedPositions, staticControlPositions),
  };
  return {
    counts: {
      actualAlive,
      distanceAlive,
      indirectAlive,
      overflowAlive,
      rateAlive,
    },
    interpolation: {
      errorBudget: SPAWN_INTERPOLATION_ERROR_BUDGET,
      partialOccupancy: {
        aliveAfter: partialOccupancyAliveAfter,
        aliveBefore: partialOccupancyAliveBefore,
        expectedPhases: [0.05, 0.15],
        valid: partialOccupancyPhasesValid,
        xs: partialOccupancyXs,
      },
      perDistance: distanceDistribution,
      pooledRespawnBitExact: equalArrays(pooledRespawnPositions, freshPoolControlPositions),
      rate: rateDistribution,
      stationaryBitExact: equalArrays(staticTimedPositions, staticControlPositions),
    },
    recycle: {
      firstGeneration: firstGeneration[0],
      firstVelocity: [...firstVelocity.slice(0, 3)],
      secondGeneration: secondGeneration[0],
      secondVelocity: [...secondVelocity.slice(0, 3)],
    },
    validation,
  };
}

async function runTimeScenario(
  renderer: THREE.WebGPURenderer,
  runtimeRenderer: ReturnType<typeof createThreeRuntimeRenderer>,
) {
  const movementSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { maxSubSteps: 8, stepSeconds: FIXED_DELTA_SECONDS },
  });
  const movementDefinition = movingEffect();
  const normal = movementSystem.spawn(movementDefinition, { seed: 7 });
  const paused = movementSystem.spawn(movementDefinition, { seed: 7, timeScale: 0 });
  const fast = movementSystem.spawn(movementDefinition, { seed: 7, timeScale: 2 });
  await movementSystem.update(0);
  const normalInitial = await floatStorage(renderer, normal, 'position');
  const pausedInitial = await floatStorage(renderer, paused, 'position');
  const fastInitial = await floatStorage(renderer, fast, 'position');
  await movementSystem.update(FIXED_DELTA_SECONDS);
  const normalFinal = await floatStorage(renderer, normal, 'position');
  const pausedFinal = await floatStorage(renderer, paused, 'position');
  const fastFinal = await floatStorage(renderer, fast, 'position');
  const normalAdvance = (normalFinal[0] ?? Number.NaN) - (normalInitial[0] ?? Number.NaN);
  const fastAdvance = (fastFinal[0] ?? Number.NaN) - (fastInitial[0] ?? Number.NaN);

  const loopSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  });
  const looped = loopSystem.spawn(
    movingEffect({
      duration: FIXED_DELTA_SECONDS,
      lifetimeSeconds: FIXED_DELTA_SECONDS,
      loopCount: 2,
      randomSpeed: true,
    }),
    { seed: 19 },
  );
  await loopSystem.update(0);
  const firstGenerationVelocity = await floatStorage(renderer, looped, 'velocity');
  await loopSystem.update(FIXED_DELTA_SECONDS);
  const secondGenerationVelocity = await floatStorage(renderer, looped, 'velocity');

  const warmSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: FIXED_DELTA_SECONDS },
  });
  const coldSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
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
  const warmedPosition = await floatStorage(renderer, warmed, 'position');
  const coldPosition = await floatStorage(renderer, cold, 'position');
  const packedStorageBufferCount = emitter(normal).program.meta.storageBufferCount;

  const validation = {
    compileCacheOk: movementSystem.compilationCount === 1,
    durationLoopGenerationOk:
      looped.getEmitter('particles')?.spawnGeneration === 1 &&
      !equalArrays(firstGenerationVelocity, secondGenerationVelocity),
    prewarmDeterministic: equalArrays(warmedPosition, coldPosition),
    packedStorageBufferBudget: packedStorageBufferCount <= 8,
    timeAdvanced: normalAdvance > 0,
    timeScalePaused: equalArrays(pausedInitial, pausedFinal),
    timeScaleTwice: close(fastAdvance, normalAdvance * 2),
  };
  return {
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
      packedStorageBufferCount,
      pausedUnchanged: equalArrays(pausedInitial, pausedFinal),
    },
    prewarm: {
      cold: [...coldPosition.slice(0, 3)],
      frames: PREWARM_FRAMES,
      warmed: [...warmedPosition.slice(0, 3)],
    },
    validation,
  };
}

async function runSmoke(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  if (!headless) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    sceneHost.append(renderer.domElement);
  }
  await renderer.init();
  const backend = renderer.backend as RendererBackendLike;
  const activeBackend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${activeBackend}.`);
  }
  backendValue.textContent = activeBackend;
  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const storageBufferLimit = backend.device?.limits?.maxStorageBuffersPerShaderStage;
  const transformFeedbackLimit = backend.gl?.getParameter(
    backend.gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
  ) as number | undefined;
  const kernelAdapter = createThreeKernelAdapter({
    backend: backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(storageBufferLimit === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: storageBufferLimit }),
    ...(transformFeedbackLimit === undefined
      ? {}
      : { maxTransformFeedbackSeparateAttribs: transformFeedbackLimit }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'm2-runtime',
  });

  if (!backend.isWebGPUBackend) {
    statusValue.textContent = 'Verifying the WebGL2 lifecycle varying-budget diagnostic…';
    const diagnosticSystem = new VFXSystem(runtimeRenderer, undefined, {
      onBuildDiagnostic: null,
    });
    const diagnosed = diagnosticSystem.spawn(webglInitializeBudgetEffect());
    const diagnostic = diagnosed.diagnostics.find(
      ({ code }) => code === 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
    );
    const ok = diagnosed.state === 'error' && diagnostic !== undefined;
    const result = {
      activeBackend,
      diagnostic,
      ok,
      requestedBackend,
      scenario: 'webgl2-diagnostic',
      transformFeedbackLimit: transformFeedbackLimit ?? 4,
    };
    performanceMonitor.publish();
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = ok ? 'complete' : 'error';
    root.dataset.sceneReady = 'true';
    statusValue.textContent = ok
      ? 'WebGL2 lifecycle diagnostic confirmed'
      : 'WebGL2 lifecycle diagnostic did not fire';
    return;
  }

  statusValue.textContent = `Running M2 ${scenario} scenario(s)…`;

  const lifecycle =
    scenario === 'all' || scenario === 'lifecycle'
      ? await runLifecycleScenario(renderer, runtimeRenderer, performanceMonitor)
      : undefined;
  const time =
    scenario === 'all' || scenario === 'time'
      ? await runTimeScenario(renderer, runtimeRenderer)
      : undefined;
  const scenarioValidations: Record<string, boolean>[] = [];
  if (lifecycle) scenarioValidations.push(lifecycle.validation);
  if (time) scenarioValidations.push(time.validation);
  const validation = {
    consoleClean: consoleMessages.length === 0,
    scenariosPassed: scenarioValidations.every((values) => Object.values(values).every(Boolean)),
  };
  const ok = Object.values(validation).every(Boolean);
  const result = {
    activeBackend,
    consoleMessages,
    lifecycle,
    ok,
    requestedBackend,
    scenario,
    time,
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
