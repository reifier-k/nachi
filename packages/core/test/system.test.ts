import { describe, expect, it } from 'vitest';

import {
  EffectClock,
  EmitterLifecycleController,
  FixedStepAccumulator,
  VFXSystem,
  VfxDiagnosticError,
  burst,
  defineEffect,
  defineEmitter,
  defineParameter,
  lifetime,
  perDistance,
  rate,
  tslModule,
} from '../src/index.js';
import type {
  KernelComputeBuilder,
  KernelComputeNode,
  KernelNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  ModuleDefinition,
  VfxDeviceLossInfo,
  VfxRuntimeRenderer,
} from '../src/index.js';

class FakeNode implements KernelUniformNode {
  constructor(public value: unknown = 0) {}

  get a(): KernelNode {
    return this;
  }
  get b(): KernelNode {
    return this;
  }
  get g(): KernelNode {
    return this;
  }
  get r(): KernelNode {
    return this;
  }
  get rgb(): KernelNode {
    return this;
  }
  get w(): KernelNode {
    return this;
  }
  get x(): KernelNode {
    return this;
  }
  get xyz(): KernelNode {
    return this;
  }
  get y(): KernelNode {
    return this;
  }
  get z(): KernelNode {
    return this;
  }
  add(): KernelNode {
    return this;
  }
  addAssign(): KernelNode {
    return this;
  }
  assign(): KernelNode {
    return this;
  }
  bitXor(): KernelNode {
    return this;
  }
  clamp(): KernelNode {
    return this;
  }
  div(): KernelNode {
    return this;
  }
  equal(): KernelNode {
    return this;
  }
  greaterThanEqual(): KernelNode {
    return this;
  }
  lessThan(): KernelNode {
    return this;
  }
  mul(): KernelNode {
    return this;
  }
  mulAssign(): KernelNode {
    return this;
  }
  pow(): KernelNode {
    return this;
  }
  shiftRight(): KernelNode {
    return this;
  }
  sqrt(): KernelNode {
    return this;
  }
  sub(): KernelNode {
    return this;
  }
  toFloat(): KernelNode {
    return this;
  }
}

class FakeStorage implements KernelStorageNode {
  readonly value = {};
  readonly node = new FakeNode();

  element(): KernelNode {
    return this.node;
  }
  setName(): KernelStorageNode {
    return this;
  }
  toAtomic(): KernelStorageNode {
    return this;
  }
}

class FakeCompute implements KernelComputeBuilder, KernelComputeNode {
  name = '';

  compute(): KernelComputeNode {
    return this;
  }
  computeKernel(): KernelComputeNode {
    return this;
  }
  setName(name: string): KernelComputeNode {
    this.name = name;
    return this;
  }
}

function fakeAdapter(): KernelTslAdapter {
  const node = () => new FakeNode();
  return {
    instanceIndex: node(),
    atomicAdd: node,
    atomicLoad: node,
    atomicStore: () => undefined,
    branch: (_condition, whenTrue) => whenTrue(),
    constant: (value) => new FakeNode(value),
    cos: node,
    dataTexture: (lut) => lut,
    fn: (callback) => {
      callback();
      return new FakeCompute();
    },
    instancedArray: () => new FakeStorage(),
    indirectArray: () => Object.assign(new FakeStorage(), { indirectResource: {} }),
    sampleTexture: node,
    sin: node,
    uniform: (value) => new FakeNode(value),
    uint: node,
    vec2: node,
    vec3: node,
    vec4: node,
  };
}

class FakeRuntimeRenderer implements VfxRuntimeRenderer {
  readonly kernelAdapter = fakeAdapter();
  readonly submissions: string[] = [];
  failNextSubmission = false;
  releaseCount = 0;

  releaseKernels(): void {
    this.releaseCount += 1;
  }

  submitCompute(kernel: KernelComputeNode): void {
    if (this.failNextSubmission) {
      this.failNextSubmission = false;
      throw new Error('synthetic submit failure');
    }
    this.submissions.push((kernel as FakeCompute).name);
  }

  submitComputeIndirect(kernel: KernelComputeNode): void {
    this.submitCompute(kernel);
  }
}

class ZeroReadbackRenderer extends FakeRuntimeRenderer {
  readStorage(): Promise<ArrayBuffer> {
    return Promise.resolve(new Uint32Array(4).buffer);
  }
}

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  stage: 'render',
  type: 'test/runtime-compute-only',
  version: 1,
};

function runtimeEffect(
  options: {
    readonly duration?: number;
    readonly lifetime?: number;
    readonly loopCount?: number | 'infinite';
    readonly prewarm?: number;
    readonly startDelay?: number;
  } = {},
) {
  const emitter = defineEmitter({
    capacity: 1,
    init: [lifetime(options.lifetime ?? 1)],
    lifecycle: {
      ...(options.duration === undefined ? {} : { duration: options.duration }),
      ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
      ...(options.prewarm === undefined ? {} : { prewarm: options.prewarm }),
      ...(options.startDelay === undefined ? {} : { startDelay: options.startDelay }),
    },
    render: computeRender,
    spawn: burst({ count: 1 }),
  });
  return defineEffect({ elements: { particles: emitter } });
}

describe('effect-local clock', () => {
  it('scales world delta without changing world time', () => {
    const clock = new EffectClock(2);
    expect(clock.advance(0.25)).toBe(0.5);
    expect(clock.localTime).toBe(0.5);
  });

  it('supports a fully paused instance clock', () => {
    const clock = new EffectClock(0);
    expect(clock.advance(1)).toBe(0);
    expect(clock.localTime).toBe(0);
  });

  it('consumes a hit stop and advances the remainder of a frame', () => {
    const clock = new EffectClock();
    clock.applyHitStop(100);
    expect(clock.advance(0.04)).toBe(0);
    expect(clock.advance(0.1)).toBeCloseTo(0.04);
    expect(clock.hitStopRemaining).toBe(0);
  });

  it('supports a nonzero hit-stop time scale', () => {
    const clock = new EffectClock(2);
    clock.applyHitStop(100, 0.25);
    expect(clock.advance(0.1)).toBeCloseTo(0.05);
  });

  it('rejects invalid clock scales and deltas', () => {
    expect(() => new EffectClock(-1)).toThrow(RangeError);
    expect(() => new EffectClock().setTimeScale(Number.NaN)).toThrow(RangeError);
    expect(() => new EffectClock().advance(-0.1)).toThrow(RangeError);
  });
});

describe('fixed timestep accumulator', () => {
  it('accumulates partial frames until one fixed step is available', () => {
    const fixed = new FixedStepAccumulator({ stepSeconds: 0.1 });
    expect(fixed.advance(0.04)).toEqual([]);
    expect(fixed.advance(0.06)).toEqual([0.1]);
    expect(fixed.accumulator).toBeCloseTo(0);
  });

  it('produces identical steps for equivalent delta partitions', () => {
    const first = new FixedStepAccumulator({ stepSeconds: 0.02 });
    const second = new FixedStepAccumulator({ stepSeconds: 0.02 });
    const firstSteps = first.advance(0.1);
    expect(firstSteps).toEqual([0.02, 0.02, 0.02, 0.02, 0.02]);
    expect([...second.advance(0.03), ...second.advance(0.07)]).toEqual(firstSteps);
  });

  it('clamps substeps and reports discarded backlog', () => {
    const fixed = new FixedStepAccumulator({ maxSubSteps: 2, stepSeconds: 0.1 });
    expect(fixed.advance(1)).toEqual([0.1, 0.1]);
    expect(fixed.droppedSeconds).toBeCloseTo(0.8);
  });
});

describe('emitter lifecycle state machine', () => {
  it('stays delayed until startDelay elapses', () => {
    const lifecycle = new EmitterLifecycleController({ duration: 1, startDelay: 0.5 });
    expect(lifecycle.advance(0.25)).toEqual([]);
    expect(lifecycle.state).toBe('delayed');
    expect(lifecycle.advance(0.25)).toEqual([
      { kind: 'activate', loopIndex: 0, spawnGeneration: 0 },
    ]);
  });

  it('completes after one duration', () => {
    const lifecycle = new EmitterLifecycleController({ duration: 1 });
    expect(lifecycle.advance(1).map(({ kind }) => kind)).toEqual([
      'activate',
      'update',
      'complete',
    ]);
    expect(lifecycle.state).toBe('completed');
  });

  it('reactivates burst emission and increments generation per loop', () => {
    const lifecycle = new EmitterLifecycleController({ duration: 0.5, loopCount: 2 });
    const commands = lifecycle.advance(0.5);
    expect(commands.at(-1)).toEqual({ kind: 'activate', loopIndex: 1, spawnGeneration: 1 });
    expect(lifecycle.loopIndex).toBe(1);
  });

  it('supports an infinite loop count', () => {
    const lifecycle = new EmitterLifecycleController({
      duration: 0.1,
      loopCount: 'infinite',
    });
    lifecycle.advance(1);
    expect(lifecycle.state).toBe('active');
    expect(lifecycle.spawnGeneration).toBe(10);
  });

  it('crosses multiple finite loops in one advance', () => {
    const lifecycle = new EmitterLifecycleController({ duration: 0.1, loopCount: 3 });
    const commands = lifecycle.advance(0.35);
    expect(commands.filter(({ kind }) => kind === 'activate')).toHaveLength(3);
    expect(commands.at(-1)).toMatchObject({ kind: 'update', phase: 'drain' });
    expect(lifecycle.state).toBe('completed');
  });

  it('emits prewarm work immediately after first activation', () => {
    const lifecycle = new EmitterLifecycleController({ duration: 1, prewarm: 0.25 });
    expect(lifecycle.advance(0)).toEqual([
      { kind: 'activate', loopIndex: 0, spawnGeneration: 0 },
      {
        deltaSeconds: 0.25,
        kind: 'update',
        loopIndex: 0,
        phase: 'active',
        prewarm: true,
      },
    ]);
    expect(lifecycle.age).toBeCloseTo(0.25);
  });

  it('completes a zero-duration one-shot immediately', () => {
    const lifecycle = new EmitterLifecycleController();
    expect(lifecycle.advance(0).map(({ kind }) => kind)).toEqual(['activate', 'complete']);
    expect(lifecycle.state).toBe('completed');
  });

  it('rejects invalid lifecycle configurations', () => {
    expect(() => new EmitterLifecycleController({ duration: -1 })).toThrow(RangeError);
    expect(() => new EmitterLifecycleController({ duration: 1, loopCount: 0 })).toThrow(RangeError);
    expect(() => new EmitterLifecycleController({ duration: 0, loopCount: 'infinite' })).toThrow(
      RangeError,
    );
  });

  it('reports invalid authored lifecycle values as structured diagnostics', () => {
    expect(() =>
      defineEmitter({
        capacity: 1,
        lifecycle: { duration: 0, loopCount: 2 },
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    ).toThrow(VfxDiagnosticError);
  });
});

describe('VFXSystem runtime scheduler', () => {
  it('caches compilation by effect-definition identity', () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const effect = runtimeEffect({ duration: 1 });
    system.spawn(effect);
    system.spawn(effect);
    expect(system.compilationCount).toBe(1);
    expect(system.instanceCount).toBe(2);
  });

  it('initializes the free list, spawns indirectly, and updates on time advances', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    await system.update(0);
    expect(renderer.submissions).toContain('NachiEmitterInitialize');
    expect(renderer.submissions).toContain('NachiEmitterSpawn');
    expect(renderer.submissions).toContain('NachiEmitterCompactAlive');
    await system.update(0.1);
    expect(renderer.submissions).toContain('NachiEmitterUpdate');
    expect(instance.localTime).toBeCloseTo(0.1);
  });

  it('writes scaled local delta into Emitter.deltaTime', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 2 }), { timeScale: 2 });
    await system.update(0.25);
    const uniforms = instance.getEmitter('particles')?.kernels.uniforms;
    expect(uniforms?.['System.time']?.value).toBe(0.25);
    expect(uniforms?.['System.deltaTime']?.value).toBe(0.25);
    expect(uniforms?.['Emitter.deltaTime']?.value).toBe(0.5);
    expect(uniforms?.['Emitter.spawnGeneration']?.value).toBe(0);
    expect(instance.localTime).toBe(0.5);
    expect(system.time).toBe(0.25);
  });

  it('derives optional update delta from the injected monotonic clock', async () => {
    let now = 1000;
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, { now: () => now });
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    await system.update();
    now += 100;
    await system.update();
    expect(system.time).toBeCloseTo(0.1);
    expect(instance.localTime).toBeCloseTo(0.1);
  });

  it('keeps fixed-step results deterministic across input partitions', async () => {
    const first = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      fixedTimeStep: { stepSeconds: 0.02 },
    });
    const second = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      fixedTimeStep: { stepSeconds: 0.02 },
    });
    const firstInstance = first.spawn(runtimeEffect({ duration: 1 }));
    const secondInstance = second.spawn(runtimeEffect({ duration: 1 }));
    await first.update(0.1);
    await second.update(0.03);
    await second.update(0.07);
    expect(first.time).toBeCloseTo(second.time);
    expect(firstInstance.localTime).toBeCloseTo(secondInstance.localTime);
  });

  it('splits prewarm into deterministic fixed-size submissions', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { prewarmStepSeconds: 0.1 });
    const instance = system.spawn(runtimeEffect({ duration: 1, prewarm: 0.3 }));
    await system.update(0);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterUpdate')).toHaveLength(3);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.localTime']?.value,
    ).toBeCloseTo(0.3);
  });

  it('advances spawnGeneration when a loop re-fires', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 0.1, loopCount: 2 }));
    await system.update(0);
    expect(instance.getEmitter('particles')?.spawnGeneration).toBe(0);
    await system.update(0.1);
    expect(instance.getEmitter('particles')?.spawnGeneration).toBe(1);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(2);
  });

  it('completes only after lifecycle completion plus conservative lifetime drain', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 0.1, lifetime: 0.2 }));
    await system.update(0.1);
    expect(instance.state).toBe('active');
    await system.update(0.19);
    expect(instance.state).toBe('active');
    await system.update(0.01);
    expect(instance.state).toBe('complete');
  });

  it('honors stop and release state transitions', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const stopped = system.spawn(runtimeEffect({ duration: 1 }));
    stopped.stop();
    expect(stopped.state).toBe('stopped');
    await system.update(0.1);
    stopped.release();
    expect(stopped.state).toBe('released');
    expect(system.instanceCount).toBe(0);
    expect((system.renderer as FakeRuntimeRenderer).releaseCount).toBe(1);
  });

  it('turns submission failures into runtime diagnostics', async () => {
    const renderer = new FakeRuntimeRenderer();
    renderer.failNextSubmission = true;
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    await system.update(0);
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_GPU_SUBMISSION_FAILED', phase: 'runtime' }),
    );
  });

  it('rejects unregistered spawn modules through the unified registry', () => {
    const unsupportedSpawn: ModuleDefinition<'spawn', Record<string, never>> = {
      access: { reads: [], writes: ['Emitter.spawnCount'] },
      config: {},
      kind: 'module',
      stage: 'spawn',
      type: 'test/rate-spawn',
      version: 1,
    };
    const emitter = defineEmitter({
      capacity: 1,
      render: computeRender,
      spawn: unsupportedSpawn,
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({ elements: { particles: emitter } }),
    );
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_MODULE_UNKNOWN', phase: 'compile' }),
    );
  });

  it('propagates device loss to every live instance', async () => {
    let loseDevice!: (info: VfxDeviceLossInfo) => void;
    const deviceLost = new Promise<VfxDeviceLossInfo>((resolve) => {
      loseDevice = resolve;
    });
    const base = new FakeRuntimeRenderer();
    const renderer: VfxRuntimeRenderer = {
      deviceLost,
      kernelAdapter: base.kernelAdapter,
      submitCompute: (kernel) => base.submitCompute(kernel),
    };
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    loseDevice({ message: 'test loss', reason: 'destroyed' });
    await deviceLost;
    await Promise.resolve();
    expect(instance.state).toBe('error');
    expect(instance.diagnostics.at(-1)).toMatchObject({ code: 'NACHI_DEVICE_LOST' });
  });

  it('validates mutable runtime parameters', () => {
    const renderer = new FakeRuntimeRenderer();
    const parameterDefinition = defineParameter('User.intensity', {
      default: 1,
      mutable: true,
      type: 'f32',
    });
    const emitter = defineEmitter({
      capacity: 1,
      parameters: { 'User.intensity': parameterDefinition },
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { particles: emitter },
      parameters: { 'User.intensity': parameterDefinition },
    });
    const instance = new VFXSystem(renderer).spawn(effect);
    expect(() => instance.setParameter('User.intensity', 2)).not.toThrow();
    expect(() => instance.setParameter('User.intensity', 'bad' as never)).toThrow(
      VfxDiagnosticError,
    );
  });

  it('throws NACHI_INSTANCE_RELEASED from released-instance methods', () => {
    const parameterDefinition = defineParameter('User.intensity', {
      default: 1,
      mutable: true,
      type: 'f32',
    });
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: { particles: emitter },
        parameters: { 'User.intensity': parameterDefinition },
      }),
    );
    instance.release();

    for (const operation of [
      () => instance.setParameter('User.intensity', 2),
      () => instance.setTimeScale(2),
      () => instance.setTransform([1, 2, 3]),
      () => instance.applyHitStop(10),
      () => instance.stop(),
      () => instance.getEmitter('particles'),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'NACHI_INSTANCE_RELEASED' })],
        }),
      );
    }
    expect(() => instance.release()).not.toThrow();
  });

  it('latches device loss for instances spawned after the loss', async () => {
    let loseDevice!: (info: VfxDeviceLossInfo) => void;
    const deviceLost = new Promise<VfxDeviceLossInfo>((resolve) => {
      loseDevice = resolve;
    });
    const base = new FakeRuntimeRenderer();
    const renderer: VfxRuntimeRenderer = {
      deviceLost,
      kernelAdapter: base.kernelAdapter,
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitCompute(kernel),
    };
    const system = new VFXSystem(renderer);
    loseDevice({ reason: 'destroyed' });
    await deviceLost;
    await Promise.resolve();

    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_DEVICE_LOST' }),
    );
  });

  it('accumulates fractional rate spawn under fixed timesteps', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, {
      fixedTimeStep: { stepSeconds: 0.1 },
    });
    const emitter = defineEmitter({
      capacity: 8,
      integration: 'none',
      lifecycle: { duration: 1 },
      render: computeRender,
      spawn: rate({ rate: 2.5 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(0);
    await system.update(0.4);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(1);
  });

  it('converts transform distance into per-distance spawn count', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 16,
      integration: 'none',
      lifecycle: { duration: 1 },
      render: computeRender,
      spawn: perDistance({ rate: 2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(0);
    instance.setTransform([3, 4, 0]);
    await system.update(0.1);

    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(
      10,
    );
  });

  it('schedules additional burst cycles when interval boundaries are crossed', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      integration: 'none',
      lifecycle: { duration: 1 },
      render: computeRender,
      spawn: burst({ count: 1, cycles: 3, interval: 0.2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(0);
    await system.update(0.5);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(2);
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(2);
  });

  it('can complete from opt-in exact alive-count readback', async () => {
    const system = new VFXSystem(new ZeroReadbackRenderer(), undefined, {
      aliveCountReadbackInterval: 1,
    });
    const instance = system.spawn(runtimeEffect({ duration: 0, lifetime: 10 }));
    await system.update(0);
    expect(instance.state).toBe('complete');
  });

  it('treats an emitter without a lifetime declaration as unbounded', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(100);
    expect(instance.state).toBe('active');
  });

  it('treats a non-core lifetime writer as conservatively unbounded', async () => {
    const customLifetime = tslModule(({ lifetime: value }) => ({ lifetime: value }), {
      stage: 'init',
    });
    const emitter = defineEmitter({
      capacity: 1,
      init: [customLifetime],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(100);
    expect(instance.state).toBe('active');
  });

  it('rejects invalid alive-count readback intervals', () => {
    expect(
      () => new VFXSystem(new FakeRuntimeRenderer(), undefined, { aliveCountReadbackInterval: 0 }),
    ).toThrow(RangeError);
  });

  it('writes setTransform translation into Emitter.transform', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    instance.setTransform([3, 4, 5]);
    const matrix = instance.getEmitter('particles')?.kernels.uniforms['Emitter.transform']?.value;
    expect(matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
  });
});
