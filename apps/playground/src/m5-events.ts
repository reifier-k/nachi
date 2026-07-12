import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  emitTo,
  lifetime,
  positionSphere,
} from '@nachi/core';
import type { EffectEventSummary, VfxEmitterRuntimeView } from '@nachi/core';
import type { CompiledEventQueueDescription, KernelUniformNode } from '@nachi/core';

import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi/three';
import { readLogicalAttribute, readStorage } from './three-runtime-readback';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m3-sprites.css';

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

const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

type RuntimeInstance = {
  readonly diagnostics: readonly { readonly code: string }[];
  readonly state: string;
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  on(event: 'death', callback: (summary: EffectEventSummary) => void): () => void;
  release(): void;
};

type BackendLike = {
  device?: {
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M5 event UI element: ${selector}`);
  return element;
}

function emitter(instance: RuntimeInstance, key: string): VfxEmitterRuntimeView {
  const view = instance.getEmitter(key);
  if (!view) throw new Error(`M5 runtime emitter "${key}" is missing.`);
  return view;
}

function eventEffect(parentCapacity = 4, loops: number | 'infinite' = 1) {
  return defineEffect({
    elements: {
      smokePuffs: defineEmitter({
        capacity: Math.max(8, parentCapacity * 2),
        init: [positionSphere({ radius: 0 }), lifetime(1)],
        integration: 'none',
        lifecycle: { duration: 1 },
        render: billboard({}),
        spawn: burst({ count: 0 }),
      }),
      sparks: defineEmitter({
        capacity: parentCapacity,
        events: { onDeath: emitTo('smokePuffs', { inherit: ['position'] }) },
        init: [positionSphere({ radius: 1, surfaceOnly: true }), lifetime(0)],
        integration: 'none',
        lifecycle: {
          duration: STEP,
          ...(loops === 1 ? {} : { loopCount: loops }),
        },
        render: billboard({}),
        spawn: burst({ count: parentCapacity }),
      }),
    },
  });
}

function cascadingEventEffect() {
  const cascadeEmitter = (target?: string, count = 0) =>
    defineEmitter({
      capacity: 1,
      ...(target === undefined ? {} : { events: { onDeath: emitTo(target) } }),
      init: [lifetime(0)],
      integration: 'none',
      lifecycle: { duration: STEP },
      render: billboard({}),
      spawn: burst({ count }),
    });
  return defineEffect({
    elements: {
      a: cascadeEmitter('b', 1),
      b: cascadeEmitter('c'),
      c: cascadeEmitter(),
    },
  });
}

function pointSet(values: Float32Array, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    [values[index * 3], values[index * 3 + 1], values[index * 3 + 2]]
      .map((value) => (value ?? 0).toFixed(5))
      .join(','),
  ).sort();
}

function alivePointSet(values: Float32Array, alive: Uint32Array): string[] {
  return Array.from({ length: alive.length }, (_, index) => index)
    .filter((index) => (alive[index] ?? 0) !== 0)
    .map((index) =>
      [values[index * 3], values[index * 3 + 1], values[index * 3 + 2]]
        .map((value) => (value ?? 0).toFixed(5))
        .join(','),
    )
    .sort();
}

function uniformNumber(uniform: KernelUniformNode | undefined): number {
  return typeof uniform?.value === 'number' ? uniform.value : Number.NaN;
}

function eventPayloadPositionSet(
  values: Float32Array,
  queue: CompiledEventQueueDescription,
  bank: number,
  count: number,
): string[] {
  const field = queue.payloadFields.find(({ attribute }) => attribute === 'position');
  if (!field || field.components !== 3 || (bank !== 0 && bank !== 1)) return [];
  const positions = new Float32Array(count * 3);
  for (let slot = 0; slot < count; slot += 1) {
    const record =
      (bank * queue.capacity * queue.payloadGroupCount +
        slot * queue.payloadGroupCount +
        field.group) *
        4 +
      field.offset;
    positions.set(values.subarray(record, record + 3), slot * 3);
  }
  return pointSet(positions, count);
}

async function readPhysicalAttribute(
  renderer: Parameters<typeof readLogicalAttribute>[0],
  view: VfxEmitterRuntimeView,
  name: string,
): Promise<number[]> {
  const attribute = view.program.attributeSchema.byName[name];
  if (!attribute) throw new Error(`M5 diagnostic attribute "${name}" is missing.`);
  const description = view.program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
  const storage = description === undefined ? undefined : view.kernels.storages[description.name];
  if (!description || !storage) {
    throw new Error(`M5 diagnostic storage for "${name}" is missing.`);
  }
  const buffer = await renderer.getArrayBufferAsync(storage.value as never);
  const values =
    description.componentType === 'uint'
      ? new Uint32Array(buffer)
      : description.componentType === 'int'
        ? new Int32Array(buffer)
        : new Float32Array(buffer);
  return Array.from(values);
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(64, 64);
  requireElement('#scene').append(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M5 event smoke requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Storage readback' : 'GPU event diagnostics';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'm5-events',
  });

  const execute = async (seed: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
    });
    const instance = system.spawn(eventEffect(), { seed }) as RuntimeInstance;
    const callbackCounts: number[] = [];
    instance.on('death', ({ count }) => callbackCounts.push(count));
    const parent = emitter(instance, 'sparks');
    const child = emitter(instance, 'smokePuffs');
    await system.update(0);
    const parentPositions = (await readLogicalAttribute(
      renderer,
      parent.program,
      parent.kernels,
      'position',
    )) as Float32Array;
    await system.update(STEP);
    const childCountOnProducerFrame = child.aliveCount ?? -1;
    const eventOutput = parent.kernels.eventOutputs.onDeath!;
    const eventQueue = eventOutput.queue;
    const eventStateAfterDeath = (await readStorage(
      renderer,
      eventOutput.state,
      'uint',
    )) as Uint32Array;
    const eventPayloadAfterDeath = (await readStorage(
      renderer,
      eventOutput.payload,
      'float',
    )) as Float32Array;
    const producerWriteBank = uniformNumber(parent.kernels.uniforms['Emitter.eventWriteBank']);
    const producerReadBank = uniformNumber(parent.kernels.uniforms['Emitter.eventReadBank']);
    const producedCount = Math.min(
      eventQueue.capacity,
      eventStateAfterDeath[producerWriteBank] ?? 0,
    );
    const payloadPoints = eventPayloadPositionSet(
      eventPayloadAfterDeath,
      eventQueue,
      producerWriteBank,
      producedCount,
    );
    await system.update(STEP);
    const childCountAfterConsume = child.aliveCount ?? -1;
    const childPositions = (await readLogicalAttribute(
      renderer,
      child.program,
      child.kernels,
      'position',
    )) as Float32Array;
    const childAlive = (await readLogicalAttribute(
      renderer,
      child.program,
      child.kernels,
      'alive',
    )) as Uint32Array;
    const childPositionPhysicalAfterConsume = await readPhysicalAttribute(
      renderer,
      child,
      'position',
    );
    const eventStateAfterConsume = (await readStorage(
      renderer,
      eventOutput.state,
      'uint',
    )) as Uint32Array;
    const consumerWriteBank = uniformNumber(child.kernels.uniforms['Emitter.eventWriteBank']);
    const consumerReadBank = uniformNumber(child.kernels.uniforms['Emitter.eventReadBank']);
    const payloadRawLimit = Math.min(
      eventPayloadAfterDeath.length,
      eventQueue.capacity * eventQueue.payloadGroupCount * 2 * 4,
    );
    const result = {
      callbackCount: callbackCounts.reduce((sum, count) => sum + count, 0),
      childCountAfterConsume,
      childCountOnProducerFrame,
      childPoints: alivePointSet(childPositions, childAlive),
      diagnostics: instance.diagnostics.map(({ code }) => code),
      eventCount: (eventStateAfterDeath[0] ?? 0) + (eventStateAfterDeath[1] ?? 0),
      eventOverflow: eventStateAfterDeath[2] ?? 0,
      gpuDiagnostics: {
        afterConsumer: {
          childPositionLogical: Array.from(childPositions),
          childPositionPhysical: childPositionPhysicalAfterConsume,
          eventState: Array.from(eventStateAfterConsume),
          readBank: consumerReadBank,
          writeBank: consumerWriteBank,
        },
        afterProducer: {
          eventPayloadRaw: Array.from(eventPayloadAfterDeath.subarray(0, payloadRawLimit)),
          eventState: Array.from(eventStateAfterDeath),
          payloadPoints,
          readBank: producerReadBank,
          writeBank: producerWriteBank,
        },
      },
      parentPoints: pointSet(parentPositions, 4),
    };
    instance.release();
    return result;
  };

  const first = await execute(5150);
  const second = await execute(5150);

  const executeCascade = async (aliveCountReadbackInterval: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, { aliveCountReadbackInterval });
    const instance = system.spawn(cascadingEventEffect()) as RuntimeInstance;
    const callbackCounts: number[] = [];
    instance.on('death', ({ count }) => callbackCounts.push(count));
    await system.update(0);
    await system.update(STEP);
    const stateAfterA = instance.state;
    await system.update(STEP);
    const stateAfterB = instance.state;
    await system.update(STEP);
    const finalState = instance.state;
    const c = emitter(instance, 'c');
    const cSpawnGenerations = (await readLogicalAttribute(
      renderer,
      c.program,
      c.kernels,
      'spawnGeneration',
    )) as Uint32Array;
    const result = {
      callbackCount: callbackCounts.reduce((sum, count) => sum + count, 0),
      cConsumed: (cSpawnGenerations[0] ?? 0) > 0,
      finalState,
      stateAfterA,
      stateAfterB,
    };
    instance.release();
    return result;
  };

  const cascade = await executeCascade(1);
  const intervalTwoCascade = await executeCascade(2);

  const overflowSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
  });
  const overflowInstance = overflowSystem.spawn(eventEffect(1, 3), {
    seed: 77,
  }) as RuntimeInstance;
  await overflowSystem.update(0);
  await overflowSystem.update(STEP * 3);
  const overflowCodes = overflowInstance.diagnostics.map(({ code }) => code);
  const overflowSafe = overflowCodes.includes('NACHI_EVENT_QUEUE_OVERFLOW');
  overflowInstance.release();

  const validation = {
    bankSelection:
      first.gpuDiagnostics.afterProducer.writeBank === first.gpuDiagnostics.afterConsumer.readBank,
    callbackAggregate: first.callbackCount === 4,
    cascadeFinalConsumed:
      cascade.stateAfterA === 'active' &&
      cascade.stateAfterB === 'active' &&
      cascade.finalState === 'complete' &&
      cascade.cConsumed,
    childPositionBufferNonZero: first.gpuDiagnostics.afterConsumer.childPositionLogical.some(
      (value) => Math.abs(value) > 1e-7,
    ),
    consoleClean: consoleMessages.length === 0,
    deterministic: JSON.stringify(first.childPoints) === JSON.stringify(second.childPoints),
    inheritPosition: JSON.stringify(first.parentPoints) === JSON.stringify(first.childPoints),
    intervalTwoFinalFlush:
      intervalTwoCascade.stateAfterB === 'active' &&
      intervalTwoCascade.finalState === 'complete' &&
      intervalTwoCascade.cConsumed &&
      intervalTwoCascade.callbackCount === 2,
    nextFrameLatency: first.childCountOnProducerFrame === 0 && first.childCountAfterConsume === 4,
    onDeathCount: first.eventCount === 4 && first.childCountAfterConsume === 4,
    overflowSafe,
    payloadMatchesParent:
      JSON.stringify(first.parentPoints) ===
      JSON.stringify(first.gpuDiagnostics.afterProducer.payloadPoints),
    payloadNonZero: first.gpuDiagnostics.afterProducer.eventPayloadRaw.some(
      (value) => Math.abs(value) > 1e-7,
    ),
  };
  const result = {
    consoleMessages,
    cascade,
    first,
    intervalTwoCascade,
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    overflowCodes,
    second,
    validation,
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.eventDiagnostics = JSON.stringify(first.gpuDiagnostics);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M5 event checks passed' : 'M5 checks failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = `Error: ${message}`;
});
