import {
  VFXSystem,
  VfxDiagnosticError,
  billboard,
  burst,
  colorOverLife,
  curve,
  defineEffect,
  defineEmitter,
  defineParameter,
  emitTo,
  gradient,
  gravity,
  lifetime,
  parameter,
  positionSphere,
  sizeOverLife,
  velocityCone,
} from '@nachi-vfx/core';
import type { KernelTslAdapter, ModuleDefinition, VfxEmitterRuntimeView } from '@nachi-vfx/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { readLogicalAttribute, readStorage } from './three-runtime-readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m9-compose.css';

const STEP = 0.25;
const WIDTH = 256;
const HEIGHT = 128;
const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';

type Backend = {
  readonly device?: {
    readonly features?: { has(feature: string): boolean };
    readonly limits?: { maxStorageBuffersPerShaderStage?: number };
    readonly lost: Promise<{ message?: string; reason?: string }>;
  };
  readonly isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  readonly diagnostics: readonly { readonly code: string }[];
  getEmitter(name: string): VfxEmitterRuntimeView | undefined;
};

const consoleMessages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(`warning: ${values.map(message).join(' ')}`);
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(`error: ${values.map(message).join(' ')}`);
  originalError(...values);
};

root.dataset.backendRequested = requestedBackend;
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M9 composition smoke element: ${selector}`);
  return element;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function labeled<Stage extends ModuleDefinition['stage'], Config extends object>(
  label: string,
  module: ModuleDefinition<Stage, Config>,
): ModuleDefinition<Stage, Config> {
  return { ...module, label };
}

function close(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function equal(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

function diagnosticCode(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof VfxDiagnosticError ? (error.diagnostics[0]?.code ?? null) : null;
  }
}

const intensity = defineParameter('User.acceleration', {
  default: -2,
  mutable: true,
  type: 'f32',
});
const inheritedRenderer = labeled('sprite', {
  ...billboard({ blending: 'additive' }),
  access: {
    reads: [
      ...(billboard({ blending: 'additive' }).access?.reads ?? []),
      'Particles.spawnOrder' as const,
    ],
    writes: [],
  },
});
const baseEmitter = defineEmitter({
  capacity: 4,
  init: [
    labeled('position', positionSphere({ radius: 0 })),
    labeled('velocity', velocityCone({ angle: 0, direction: [1, 0, 0], speed: 1 })),
    labeled('lifetime', lifetime(3)),
  ],
  lifecycle: { duration: 1 },
  parameters: { 'User.acceleration': intensity },
  render: inheritedRenderer,
  spawn: burst({ count: 1 }),
  update: [
    labeled('gravity', gravity(parameter<number>('User.acceleration'))),
    labeled('size', sizeOverLife(curve([0, 0.22], [1, 0.22]))),
    labeled('color', colorOverLife(gradient('#26a6ff', '#7b5cff'))),
  ],
});
const childEmitter = defineEmitter(baseEmitter, {
  capacity: 6,
  init: {
    modules: [labeled('velocity', velocityCone({ angle: 0, direction: [1, 0, 0], speed: 2 }))],
  },
  lifecycle: { duration: 1.5 },
});
const parentEffect = defineEffect({ elements: { particles: baseEmitter } });
const childEffect = defineEffect({ elements: { particles: childEmitter } });
const dirtyLaneEffect = defineEffect({
  elements: {
    particles: defineEmitter({
      capacity: 1,
      init: [lifetime(0.1)],
      integration: 'none',
      lifecycle: { duration: 1 },
      render: billboard({}),
      spawn: burst({ count: 1 }),
      update: [gravity(-4)],
    }),
  },
});
const pooledEventEffect = defineEffect({
  elements: {
    smoke: defineEmitter({
      capacity: 2,
      init: [lifetime(1)],
      integration: 'none',
      lifecycle: { duration: 1 },
      render: billboard({}),
      spawn: burst({ count: 0 }),
    }),
    sparks: defineEmitter({
      capacity: 1,
      events: { onDeath: emitTo('smoke') },
      init: [lifetime(0.05)],
      integration: 'none',
      lifecycle: { duration: 1 },
      render: billboard({}),
      spawn: burst({ count: 1 }),
    }),
  },
});

function emitter(instance: RuntimeInstance, key = 'particles'): VfxEmitterRuntimeView {
  const view = instance.getEmitter(key);
  if (!view) throw new Error(`M9 runtime emitter ${key} is missing.`);
  return view;
}

async function floats(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  name: 'lifetime' | 'position' | 'velocity',
  key = 'particles',
): Promise<Float32Array> {
  const view = emitter(instance, key);
  return (await readLogicalAttribute(renderer, view.program, view.kernels, name)) as Float32Array;
}

async function uints(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  name: 'alive' | 'spawnGeneration' | 'spawnOrder',
  key = 'particles',
): Promise<Uint32Array> {
  const view = emitter(instance, key);
  return (await readLogicalAttribute(renderer, view.program, view.kernels, name)) as Uint32Array;
}

async function lifecycle(
  renderer: THREE.WebGPURenderer,
  instance: RuntimeInstance,
  key = 'particles',
) {
  const view = emitter(instance, key);
  const words = (await readStorage(renderer, view.kernels.aliveCount, 'uint')) as Uint32Array;
  return {
    aliveCount: words[view.kernels.counterOffsets.aliveCount] ?? -1,
    birthHead: words[view.kernels.birthIndicesOffset] ?? -1,
    nextSpawnOrder: words[view.kernels.nextSpawnOrderOffset] ?? -1,
  };
}

function imageStats(pixels: Uint8Array) {
  let foreground = 0;
  let saturated = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const energy = (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
    if (energy > 36) foreground += 1;
    if (energy > 744) saturated += 1;
  }
  const count = pixels.length / 4;
  return { foregroundRatio: foreground / count, saturatedRatio: saturated / count };
}

function paint(pixels: Uint8Array): void {
  required<HTMLCanvasElement>('#compose-visual')
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(pixels), WIDTH, HEIGHT), 0, 0);
}

async function measurePerformance(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setSize(64, 64);
  await renderer.init();
  const backend = renderer.backend as Backend;
  if (!backend.isWebGPUBackend) throw new Error('M9 performance capture requires WebGPU.');
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const system = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  const instance = system.spawn(childEffect, { seed: 91 });
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm9-compose',
  });
  await system.update(0);
  await monitor.resolveGpuTimestamps();
  await system.update(1 / 60);
  const target = new THREE.RenderTarget(64, 64);
  const scene = new THREE.Scene();
  const view = emitter(instance);
  scene.add(materializeThreeSpriteDraw(view.program, view.kernels));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  renderer.setRenderTarget(target);
  await monitor.captureGpuSamples(async () => {
    await system.update(1 / 120);
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  });
  renderer.setRenderTarget(null);
  target.dispose();
  renderer.dispose();
}

async function run(): Promise<void> {
  if (requestedBackend !== 'webgpu') throw new Error('M9 composition smoke is WebGPU-only.');
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.setClearColor(0x01030a, 1);
  await renderer.init();
  const backend = renderer.backend as Backend;
  if (!backend.isWebGPUBackend) throw new Error('M9 composition smoke requires WebGPU.');
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const adapter: KernelTslAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const system = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  const parent = system.spawn(parentEffect, {
    position: [-0.8, 0.35, 0],
    seed: 73,
  });
  const first = system.spawn(childEffect, {
    position: [0.15, -0.25, 0],
    seed: 91,
  });
  parent.setParameter('User.acceleration', -2);
  first.setParameter('User.acceleration', -3.5);
  await system.update(0);
  await system.update(STEP);

  const parentVelocity = await floats(renderer, parent, 'velocity');
  const parentLifetime = await floats(renderer, parent, 'lifetime');
  const firstPosition = await floats(renderer, first, 'position');
  const firstVelocity = await floats(renderer, first, 'velocity');
  const firstLifetime = await floats(renderer, first, 'lifetime');
  const firstGeneration = await uints(renderer, first, 'spawnGeneration');
  const firstOrder = await uints(renderer, first, 'spawnOrder');
  const firstLifecycle = await lifecycle(renderer, first);
  const firstBuffer = emitter(first).kernels.storages.velocity;
  const invalidKey = diagnosticCode(() => first.setParameter('User.missing' as never, 1));
  const invalidType = diagnosticCode(() => first.setParameter('User.acceleration', 'bad' as never));

  first.release();
  const pooledAfterRelease = system.getPooledInstanceCount(childEffect);
  const second = system.spawn(childEffect, {
    position: [0.15, -0.25, 0],
    seed: 91,
  });
  second.setParameter('User.acceleration', -3.5);
  const reusedBuffer = emitter(second).kernels.storages.velocity === firstBuffer;
  await system.update(0);
  await system.update(STEP);
  const secondPosition = await floats(renderer, second, 'position');
  const secondVelocity = await floats(renderer, second, 'velocity');
  const secondLifetime = await floats(renderer, second, 'lifetime');
  const secondGeneration = await uints(renderer, second, 'spawnGeneration');
  const secondOrder = await uints(renderer, second, 'spawnOrder');
  const secondLifecycle = await lifecycle(renderer, second);

  const dirtySystem = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  const dirtyFirst = dirtySystem.spawn(dirtyLaneEffect);
  await dirtySystem.update(0);
  await dirtySystem.update(0.05);
  const dirtyVelocity = await floats(renderer, dirtyFirst, 'velocity');
  await dirtySystem.update(0.1);
  const deadFlags = await uints(renderer, dirtyFirst, 'alive');
  const dirtyBuffer = emitter(dirtyFirst).kernels.storages.velocity;
  dirtyFirst.release();
  const dirtySecond = dirtySystem.spawn(dirtyLaneEffect);
  const dirtyBufferReused = emitter(dirtySecond).kernels.storages.velocity === dirtyBuffer;
  await dirtySystem.update(0);
  const resetVelocity = await floats(renderer, dirtySecond, 'velocity');
  const respawnedFlags = await uints(renderer, dirtySecond, 'alive');

  const eventSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  const eventFirst = eventSystem.spawn(pooledEventEffect);
  await eventSystem.update(0);
  await eventSystem.update(0.1);
  await eventSystem.update(0);
  const firstEventTarget = await lifecycle(renderer, eventFirst, 'smoke');
  const eventSourceBuffer = emitter(eventFirst, 'sparks').kernels.storages.alive;
  const eventTargetBuffer = emitter(eventFirst, 'smoke').kernels.storages.alive;
  eventFirst.release();
  const eventSecond = eventSystem.spawn(pooledEventEffect);
  const eventBuffersReused =
    emitter(eventSecond, 'sparks').kernels.storages.alive === eventSourceBuffer &&
    emitter(eventSecond, 'smoke').kernels.storages.alive === eventTargetBuffer;
  await eventSystem.update(0);
  await eventSystem.update(0.1);
  await eventSystem.update(0);
  const secondEventTarget = await lifecycle(renderer, eventSecond, 'smoke');

  const capSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  const capA = capSystem.spawn(childEffect);
  const capB = capSystem.spawn(childEffect);
  capA.release();
  capB.release();
  const poolLimitDiagnostic = capB.diagnostics.some(
    ({ code }) => code === 'NACHI_EFFECT_POOL_LIMIT_EXCEEDED',
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x01030a);
  const parentView = emitter(parent);
  const secondView = emitter(second);
  scene.add(materializeThreeSpriteDraw(parentView.program, parentView.kernels));
  scene.add(materializeThreeSpriteDraw(secondView.program, secondView.kernels));
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const pixels = compactRgba8Readback(
    new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
    WIDTH,
    HEIGHT,
    true,
  );
  renderer.setRenderTarget(null);
  paint(pixels);
  const visual = imageStats(pixels);

  // Allocation is LIFO, so one spawned particle occupies the final physical slot.
  const parentSlot = baseEmitter.capacity - 1;
  const childSlot = childEmitter.capacity - 1;
  const parentVx = parentVelocity[parentSlot * 3] ?? Number.NaN;
  const childVx = firstVelocity[childSlot * 3] ?? Number.NaN;
  const childVy = firstVelocity[childSlot * 3 + 1] ?? Number.NaN;
  const childLife = firstLifetime[childSlot] ?? Number.NaN;
  const childPosition = [
    firstPosition[childSlot * 3] ?? Number.NaN,
    firstPosition[childSlot * 3 + 1] ?? Number.NaN,
  ];
  const expectedChildPosition = [0.15 + 2 * STEP, -0.25 + -3.5 * STEP * STEP] as const;
  const inherited = {
    childLifetime: firstLifetime[childSlot],
    childVelocity: [...firstVelocity.slice(childSlot * 3, childSlot * 3 + 3)],
    parentLifetime: parentLifetime[parentSlot],
    parentVelocity: [...parentVelocity.slice(parentSlot * 3, parentSlot * 3 + 3)],
  };
  const validation = {
    consoleClean: consoleMessages.length === 0,
    inheritanceGpu:
      close(parentVx, 1) &&
      close(childVx, 2) &&
      close(childLife, 3) &&
      close(parentLifetime[parentSlot] ?? Number.NaN, 3),
    inheritanceNonMirror:
      close(childPosition[0]!, expectedChildPosition[0]) &&
      close(childPosition[1]!, expectedChildPosition[1]) &&
      !close(childPosition[1]!, -expectedChildPosition[1]),
    dirtyLaneReuse:
      dirtyBufferReused &&
      close(dirtyVelocity[2] ?? Number.NaN, 0) &&
      close(dirtyVelocity[1] ?? Number.NaN, -4 * 0.05) &&
      deadFlags[0] === 0 &&
      close(resetVelocity[0] ?? Number.NaN, 0) &&
      close(resetVelocity[1] ?? Number.NaN, 0) &&
      close(resetVelocity[2] ?? Number.NaN, 0) &&
      respawnedFlags[0] === 1,
    eventPooling:
      eventBuffersReused && firstEventTarget.aliveCount === 1 && secondEventTarget.aliveCount === 1,
    poolBound: capSystem.getPooledInstanceCount(childEffect) === 1 && poolLimitDiagnostic,
    poolingDeterministic:
      reusedBuffer &&
      pooledAfterRelease === 1 &&
      equal(firstPosition, secondPosition) &&
      equal(firstVelocity, secondVelocity) &&
      equal(firstLifetime, secondLifetime) &&
      equal(firstGeneration, secondGeneration) &&
      equal(firstOrder, secondOrder) &&
      JSON.stringify(firstLifecycle) === JSON.stringify(secondLifecycle) &&
      secondLifecycle.aliveCount === 1 &&
      secondLifecycle.nextSpawnOrder === 1,
    userDiagnostics:
      invalidKey === 'NACHI_PARAMETER_UNKNOWN' && invalidType === 'NACHI_PARAMETER_TYPE_MISMATCH',
    userGpu: close(childVy, -3.5 * STEP),
    visualReadback:
      visual.foregroundRatio > 0.001 &&
      visual.foregroundRatio < 0.08 &&
      visual.saturatedRatio < 0.02,
  };
  await measurePerformance();
  const ok = Object.values(validation).every(Boolean);
  const result = {
    backend: 'WebGPU',
    consoleMessages,
    diagnostics: { invalidKey, invalidType, poolLimitDiagnostic },
    inherited,
    ok,
    dirtyLane: {
      deadFlags: [...deadFlags],
      dirtyBufferReused,
      dirtyVelocity: [...dirtyVelocity],
      resetVelocity: [...resetVelocity],
      respawnedFlags: [...respawnedFlags],
    },
    eventPooling: { eventBuffersReused, firstEventTarget, secondEventTarget },
    pooling: {
      firstLifecycle,
      pooledAfterRelease,
      reusedBuffer,
      secondLifecycle,
    },
    userParameter: { actualVelocityY: childVy, expectedVelocityY: -3.5 * STEP },
    validation,
    visual,
  };
  root.dataset.artifactScreenshots = JSON.stringify(
    headless ? [] : [{ filename: 'm9-compose.png', selector: '#compose-visual' }],
  );
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = ok
    ? 'M9 GPU smoke complete'
    : 'M9 GPU validation failed';
  target.dispose();
}

void run().catch((error: unknown) => {
  const text = message(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = text;
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({ error: text, ok: false });
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Error: ${text}`;
});
