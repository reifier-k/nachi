import { describe, expect, it } from 'vitest';

import {
  EffectClock,
  EmitterLifecycleController,
  FixedStepAccumulator,
  VFXSystem,
  VfxDiagnosticError,
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
  attribute,
  burst,
  collidePlane,
  collideSceneDepth,
  defineEffect,
  defineEmitter,
  defineParameter,
  emitTo,
  lifetime,
  killVolume,
  perDistance,
  positionSphere,
  packedComponentIndex,
  rate,
  resolvePackedAttributeAddress,
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
  ResolvedAttributeSchema,
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
  lessThanEqual(): KernelNode {
    return this;
  }
  lessThan(): KernelNode {
    return this;
  }
  and(): KernelNode {
    return this;
  }
  not(): KernelNode {
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
    capabilities: {
      atomics: true,
      backend: 'webgpu',
      indirectDispatch: true,
      indirectDraw: true,
    },
    instanceIndex: node(),
    atomicAdd: node,
    atomicLoad: node,
    atomicStore: () => undefined,
    atan2: node,
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
    inverse: node,
    sampleTexture: node,
    sampleMeshSurface: () => ({ normal: node(), position: node() }),
    sampleSdf: () => ({ distance: node(), gradient: node() }),
    sampleVectorField: node,
    select: node,
    simplexNoise: node,
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

class MappedReadbackRenderer extends FakeRuntimeRenderer {
  readonly storageValues = new Map<KernelStorageNode, Uint32Array>();
  readonly storageSequences = new Map<KernelStorageNode, Uint32Array[]>();
  readCount = 0;

  readStorage(storage: KernelStorageNode): Promise<ArrayBuffer> {
    this.readCount += 1;
    const sequence = this.storageSequences.get(storage);
    const values = sequence?.shift() ?? this.storageValues.get(storage) ?? new Uint32Array(32);
    return Promise.resolve(values.slice().buffer);
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

function eventEffect(target = 'smokePuffs') {
  const sparks = defineEmitter({
    capacity: 4,
    events: { onDeath: emitTo(target, { inherit: ['position'] }) },
    init: [positionSphere({ radius: 1 }), lifetime(0.05)],
    integration: 'none',
    lifecycle: { duration: 1 },
    render: computeRender,
    spawn: burst({ count: 4 }),
  });
  const smokePuffs = defineEmitter({
    capacity: 8,
    init: [positionSphere({ radius: 0 }), lifetime(1)],
    integration: 'none',
    lifecycle: { duration: 2 },
    render: computeRender,
    spawn: burst({ count: 0 }),
  });
  return defineEffect({ elements: { smokePuffs, sparks } });
}

function collisionEventEffect() {
  const source = defineEmitter({
    capacity: 1,
    events: { onCollision: emitTo('impact', { inherit: ['position'] }) },
    init: [positionSphere({ radius: 0 })],
    integration: 'none',
    lifecycle: { duration: 1 },
    render: computeRender,
    spawn: burst({ count: 1 }),
    update: [collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 1 })],
  });
  const impact = defineEmitter({
    capacity: 1,
    init: [positionSphere({ radius: 0 })],
    integration: 'none',
    render: computeRender,
    spawn: burst({ count: 0 }),
  });
  return defineEffect({ elements: { impact, source } });
}

function cascadingEventEffect() {
  const emitter = (target?: string, count = 0) =>
    defineEmitter({
      capacity: 1,
      ...(target === undefined ? {} : { events: { onDeath: emitTo(target) } }),
      init: [lifetime(0)],
      integration: 'none',
      lifecycle: { duration: 1 / 60 },
      render: computeRender,
      spawn: burst({ count }),
    });
  return defineEffect({
    elements: {
      a: emitter('b', 1),
      b: emitter('c'),
      c: emitter(),
    },
  });
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
  const sceneDepthRenderer = (): VfxRuntimeRenderer => {
    const base = new FakeRuntimeRenderer();
    return {
      kernelAdapter: {
        ...base.kernelAdapter,
        capabilities: { ...base.kernelAdapter.capabilities, sceneDepth: true },
        sampleSceneDepth: () => new FakeNode(),
      },
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitComputeIndirect(kernel),
    };
  };
  const sceneDepthEffect = () =>
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          integration: 'none',
          render: computeRender,
          spawn: burst({ count: 1 }),
          update: [collideSceneDepth()],
        }),
      },
    });

  it('warns when scene-depth collision is spawned before camera uniforms are set', () => {
    const instance = new VFXSystem(sceneDepthRenderer()).spawn(sceneDepthEffect());

    expect(instance.state).toBe('active');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_SCENE_DEPTH_CAMERA_UNSET',
        severity: 'warning',
      }),
    );
  });

  it('warns when scene-depth collision receives a reverse-z projection', () => {
    const system = new VFXSystem(sceneDepthRenderer());
    const projectionMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.01, -1, 0, 0, 0.1, 0];
    system.setCamera({
      projectionMatrix,
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewportSize: [64, 64],
    });
    const instance = system.spawn(sceneDepthEffect());

    expect(instance.state).toBe('active');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_SCENE_DEPTH_REVERSE_Z_UNSUPPORTED',
        severity: 'warning',
      }),
    );
  });

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

  it.each([
    ['NACHI_PARAMETER_UNKNOWN', { 'User.typo': 2 }],
    ['NACHI_PARAMETER_TYPE_MISMATCH', { 'User.intensity': 'bad' }],
  ] as const)(
    'transitions to error for invalid spawn parameter overrides: %s',
    (code, parameters) => {
      const parameterDefinition = defineParameter('User.intensity', {
        default: 1,
        type: 'f32',
      });
      const emitter = defineEmitter({
        capacity: 1,
        integration: 'none',
        parameters: { 'User.intensity': parameterDefinition },
        render: computeRender,
        spawn: burst({ count: 1 }),
      });
      const effect = defineEffect({
        elements: { particles: emitter },
        parameters: { 'User.intensity': parameterDefinition },
      });
      const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(effect, {
        parameters: parameters as never,
      });

      expect(instance.state).toBe('error');
      expect(instance.diagnostics).toContainEqual(
        expect.objectContaining({ code, phase: 'runtime' }),
      );
      expect(instance.getEmitter('particles')).toBeUndefined();
    },
  );

  it('accepts type-valid immutable parameter overrides at spawn time', () => {
    const parameterDefinition = defineParameter('User.intensity', {
      default: 1,
      type: 'f32',
    });
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      parameters: { 'User.intensity': parameterDefinition },
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { particles: emitter },
      parameters: { 'User.intensity': parameterDefinition },
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(effect, {
      parameters: { 'User.intensity': 2 },
    });

    expect(instance.state).toBe('active');
    expect(instance.getEmitter('particles')?.kernels.uniforms['User.intensity']?.value).toBe(2);
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

  it('discards distance accumulated before delayed activation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 16,
      integration: 'none',
      lifecycle: { duration: 1, startDelay: 1 },
      render: computeRender,
      spawn: perDistance({ rate: 2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    instance.setTransform([5, 0, 0]);
    await system.update(1);
    await system.update(0.1);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(0);
  });

  it('reads GPU overflow only with the periodic alive-count readback', async () => {
    const base = new FakeRuntimeRenderer();
    let readCount = 0;
    let aliveOffset = 0;
    let overflowOffset = 0;
    const renderer: VfxRuntimeRenderer = {
      kernelAdapter: base.kernelAdapter,
      readStorage: () => {
        readCount += 1;
        const counters = new Uint32Array(Math.max(aliveOffset, overflowOffset) + 1);
        counters[aliveOffset] = 1;
        counters[overflowOffset] = 1;
        return Promise.resolve(counters.buffer);
      },
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitCompute(kernel),
    };
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 2 });
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const offsets = instance.getEmitter('particles')?.kernels.counterOffsets;
    aliveOffset = offsets?.aliveCount ?? 0;
    overflowOffset = offsets?.spawnOverflow ?? 0;
    await system.update(0);

    expect(readCount).toBe(1);
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_CAPACITY_EXCEEDED' }),
    );
  });

  it('reports CPU-side spawn clamping immediately without readback', async () => {
    const renderer = new FakeRuntimeRenderer();
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 2 }),
    });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(0);

    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_CAPACITY_EXCEEDED' }),
    );
  });

  it('aggregates WebGL2 burst alive flags on the CPU and updates instance count', async () => {
    const base = new FakeRuntimeRenderer();
    const readbacks = [
      { alive: [0, 0, 0], spawnGeneration: [0, 0, 0] },
      { alive: [1, 0, 0], spawnGeneration: [1, 2, 1] },
    ];
    const instanceCounts: number[] = [];
    let readIndex = 0;
    const schema: { current: ResolvedAttributeSchema | undefined } = { current: undefined };
    const renderer: VfxRuntimeRenderer = {
      kernelAdapter: {
        ...base.kernelAdapter,
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
      },
      readStorage: () => {
        const values = readbacks[Math.min(readIndex, readbacks.length - 1)]!;
        readIndex += 1;
        if (!schema.current) throw new Error('Test schema is unavailable.');
        const aliveAttribute = schema.current.byName.alive;
        const spawnGenerationAttribute = schema.current.byName.spawnGeneration;
        if (!aliveAttribute || !spawnGenerationAttribute) {
          throw new Error('Test lifecycle attributes are unavailable.');
        }
        const storage = schema.current.storageArrays[aliveAttribute.physical.bufferIndex];
        if (!storage) throw new Error('Test packed uint storage is unavailable.');
        const words = new Uint32Array(
          storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type],
        );
        const aliveAddress = resolvePackedAttributeAddress(aliveAttribute, storage);
        const spawnGenerationAddress = resolvePackedAttributeAddress(
          spawnGenerationAttribute,
          storage,
        );
        for (let particle = 0; particle < schema.current.capacity; particle += 1) {
          words[packedComponentIndex(particle, aliveAddress, 0)] = values.alive[particle] ?? 0;
          words[packedComponentIndex(particle, spawnGenerationAddress, 0)] =
            values.spawnGeneration[particle] ?? 0;
        }
        return Promise.resolve(words.buffer);
      },
      setInstanceCount: (_kernels, count) => instanceCounts.push(count),
      submitCompute: (kernel) => base.submitCompute(kernel),
    };
    const emitter = defineEmitter({
      capacity: 3,
      integration: 'none',
      lifecycle: { duration: 1 },
      render: computeRender,
      spawn: burst({ count: 2 }),
    });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    schema.current = instance.getEmitter('particles')?.program.attributeSchema;
    await system.update(0);

    expect(instance.state).toBe('active');
    expect(readIndex).toBe(2);
    expect(instanceCounts).toEqual([0, 1]);
    expect(instance.getEmitter('particles')?.aliveCount).toBe(1);
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

  it('allows lifetime-less particles to rely on an explicit kill-volume recovery path', async () => {
    const emitter = defineEmitter({
      capacity: 2,
      render: computeRender,
      spawn: burst({ count: 2 }),
      update: [killVolume({ mode: 'inside', normal: [0, 1, 0], offset: -1, shape: 'plane' })],
    });
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await expect(system.update(0)).resolves.toBeUndefined();
    expect(instance.state).toBe('active');
    expect(instance.getEmitter('particles')?.program.attributeSchema.byName.alive).toBeDefined();
  });

  it('keeps a lifetime-less rate emitter capped while full-capacity requests are suppressed', async () => {
    const base = new FakeRuntimeRenderer();
    let aliveOffset = 0;
    let overflowOffset = 0;
    let readCount = 0;
    const renderer: VfxRuntimeRenderer = {
      kernelAdapter: base.kernelAdapter,
      readStorage: () => {
        const counters = new Uint32Array(Math.max(aliveOffset, overflowOffset) + 1);
        counters[aliveOffset] = 2;
        counters[overflowOffset] = readCount === 0 ? 0 : readCount;
        readCount += 1;
        return Promise.resolve(counters.buffer);
      },
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitCompute(kernel),
    };
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      lifecycle: { duration: 10, loopCount: 'infinite' },
      render: computeRender,
      spawn: rate({ rate: 100 }),
    });
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    const offsets = instance.getEmitter('particles')?.kernels.counterOffsets;
    aliveOffset = offsets?.aliveCount ?? 0;
    overflowOffset = offsets?.spawnOverflow ?? 0;

    await system.update(0);
    await system.update(0.1);

    expect(instance.getEmitter('particles')?.aliveCount).toBe(2);
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_CAPACITY_EXCEEDED' }),
    );
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

  it('treats an update-stage lifetime writer as conservatively unbounded', async () => {
    const updateLifetime = tslModule(({ lifetime: value }) => ({ lifetime: value }), {
      stage: 'update',
    });
    const emitter = defineEmitter({
      capacity: 1,
      init: [lifetime(1)],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: [updateLifetime],
    });
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(100);
    expect(instance.state).toBe('active');
  });

  it('treats an event-stage lifetime writer as conservatively unbounded', async () => {
    const eventLifetime: ModuleDefinition<'event', object> = {
      access: { reads: [], writes: ['Particles.lifetime'] },
      config: {},
      kind: 'module',
      stage: 'event',
      type: 'test/event-lifetime',
      version: 1,
    };
    const emitter = defineEmitter({
      capacity: 1,
      events: { onDeath: eventLifetime },
      init: [lifetime(1)],
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

  it('attaches an effect to a mutable world-transform source immediately', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const source = {
      getWorldTransform: () => ({ position: [2, 3, 4] as const }),
    };
    instance.attachTo(source);
    expect(instance.getEmitter('particles')!.kernels.uniforms['Emitter.transform']?.value).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1,
    ]);
  });

  it('refreshes attached transforms before every system update', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    let position: readonly [number, number, number] = [0, 0, 0];
    instance.attachTo({ getWorldTransform: () => ({ position }) });
    position = [5, 6, 7];
    await system.update(0);
    expect(instance.getEmitter('particles')!.kernels.uniforms['Emitter.transform']?.value).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1,
    ]);
  });

  it('stops socket transform refresh after detach', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    let position: readonly [number, number, number] = [1, 0, 0];
    instance.attachTo({ getWorldTransform: () => ({ position }) });
    instance.detach();
    position = [9, 0, 0];
    await system.update(0);
    expect(instance.getEmitter('particles')!.kernels.uniforms['Emitter.transform']?.value).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1,
    ]);
  });

  it('supplies camera uniforms to emitters spawned after setCamera', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const viewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, -5, 1];
    const projectionMatrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
    system.setCamera({ projectionMatrix, viewMatrix, viewportSize: [640, 360] });
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    expect(uniforms['System.viewMatrix']?.value).toEqual(viewMatrix);
    expect(uniforms['System.projectionMatrix']?.value).toEqual(projectionMatrix);
    expect(uniforms['System.viewportSize']?.value).toEqual([640, 360]);
  });

  it('updates camera uniforms on already materialized emitters', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const viewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1];
    system.setCamera({
      projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewMatrix,
      viewportSize: [32, 16],
    });
    expect(instance.getEmitter('particles')!.kernels.uniforms['System.viewMatrix']?.value).toEqual(
      viewMatrix,
    );
  });

  it('rejects invalid camera matrices and viewport dimensions', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    expect(() =>
      system.setCamera({ projectionMatrix: [1], viewMatrix: [1], viewportSize: [0, 1] }),
    ).toThrow(RangeError);
  });

  it('diagnoses an unresolved emitTo target in effect scope', () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(eventEffect('missing'));
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_TARGET_UNKNOWN', phase: 'compile' }),
    );
  });

  it('materializes producer and consumer event kernels from effect links', () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(eventEffect());
    const producer = instance.getEmitter('sparks')!;
    const consumer = instance.getEmitter('smokePuffs')!;

    expect(producer.kernels.eventOutputs.onDeath?.queue.payloadFields).toEqual([
      expect.objectContaining({ attribute: 'position' }),
    ]);
    expect(consumer.kernels.eventInputs).toHaveLength(1);
    expect(consumer.kernels.eventInputs[0]?.binding.sourceKey).toBe('sparks');
  });

  it('materializes onCollision producer and inherited-position consumer kernels', () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(collisionEventEffect());
    const producer = instance.getEmitter('source')!;
    const consumer = instance.getEmitter('impact')!;
    expect(producer.kernels.eventOutputs.onCollision?.queue.payloadFields).toEqual([
      expect.objectContaining({ attribute: 'position' }),
    ]);
    expect(consumer.kernels.eventInputs[0]?.binding.queue.eventName).toBe('onCollision');
  });

  it('drains every frame of an A to B to C zero-lifetime event chain', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(cascadingEventEffect());
    const step = 1 / 60;

    await system.update(0);
    await system.update(step);
    expect(instance.state).toBe('active');
    await system.update(step);
    expect(instance.state).toBe('active');
    await system.update(step);

    expect(instance.state).toBe('complete');
  });

  it('forces interval-2 readback for event births and the final zero-lifetime death callback', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 2 });
    const instance = system.spawn(cascadingEventEffect());
    const callbackCounts: number[] = [];
    instance.on('death', ({ count }) => callbackCounts.push(count));
    const b = instance.getEmitter('b')!;
    const bAlive = b.kernels.aliveCount;
    const bEvents = b.kernels.eventOutputs.onDeath!.state;
    const step = 1 / 60;

    await system.update(0);
    await system.update(step);
    renderer.storageSequences.set(bAlive, [new Uint32Array([0, 1]), new Uint32Array([0, 0])]);
    renderer.storageSequences.set(bEvents, [
      new Uint32Array([0, 0, 0, 0]),
      new Uint32Array([0, 0, 0, 1]),
    ]);
    await system.update(step);

    expect(renderer.storageSequences.get(bAlive)).toHaveLength(0);
    expect(renderer.storageSequences.get(bEvents)).toHaveLength(0);
    expect(callbackCounts).toContain(1);
    expect(instance.state).toBe('active');
    await system.update(step);
    expect(instance.state).toBe('complete');
  });

  it('alternates event banks and consumes only the previous frame bank', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(eventEffect());
    await system.update(0);
    const uniforms = instance.getEmitter('sparks')!.kernels.uniforms;
    expect(uniforms['Emitter.eventWriteBank']?.value).toBe(1);
    expect(uniforms['Emitter.eventReadBank']?.value).toBe(0);

    await system.update(0.1);
    expect(instance.state).toBe('active');
    expect(uniforms['Emitter.eventWriteBank']?.value).toBe(0);
    expect(uniforms['Emitter.eventReadBank']?.value).toBe(1);
  });

  it('submits the event consumer through the indirect spawn path', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    system.spawn(eventEffect());
    await system.update(0.1);

    expect(renderer.submissions).toContain('NachiEventReset_onDeath');
    expect(renderer.submissions).toContain('NachiEventPrepare_sparks_onDeath_0');
    expect(renderer.submissions).toContain('NachiEventSpawn_sparks_onDeath_0');
    expect(renderer.submissions).toContain('NachiEventFinalize_sparks_onDeath_0');
  });

  it('notifies death callbacks with low-frequency aggregate readback counts', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(eventEffect());
    const counts: number[] = [];
    const unsubscribe = instance.on('death', ({ count }) => counts.push(count));
    await system.update(0);
    const state = instance.getEmitter('sparks')!.kernels.eventOutputs.onDeath!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 0, 4]));
    await system.update(0.1);
    unsubscribe();

    expect(counts).toEqual([4]);
  });

  it('maps onCollision GPU aggregates to collision callbacks', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(collisionEventEffect());
    const counts: number[] = [];
    instance.on('collision', ({ count }) => counts.push(count));
    await system.update(0);
    const state = instance.getEmitter('source')!.kernels.eventOutputs.onCollision!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 0, 1]));
    await system.update(1 / 60);
    expect(counts).toEqual([1]);
  });

  it('reports append overflow without exposing particle payloads to JavaScript', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(eventEffect());
    await system.update(0);
    const state = instance.getEmitter('sparks')!.kernels.eventOutputs.onDeath!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 2, 4]));
    await system.update(0.1);

    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_QUEUE_OVERFLOW', severity: 'warning' }),
    );
  });

  it('diagnoses inherited payload type mismatches between effect emitters', () => {
    const source = defineEmitter({
      attributes: { shared: attribute('shared', { default: 0, type: 'f32' }) },
      capacity: 1,
      events: { onDeath: emitTo('target', { inherit: ['shared'] }) },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const target = defineEmitter({
      attributes: { shared: attribute('shared', { default: [0, 0, 0], type: 'vec3' }) },
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 0 }),
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({ elements: { source, target } }),
    );

    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_PAYLOAD_TYPE_MISMATCH' }),
    );
  });

  it('diagnoses a target that does not declare an inherited custom attribute', () => {
    const source = defineEmitter({
      attributes: { heat: attribute('heat', { default: 0, type: 'f32' }) },
      capacity: 1,
      events: { onDeath: emitTo('target', { inherit: ['heat'] }) },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const target = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 0 }),
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({ elements: { source, target } }),
    );
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_PAYLOAD_TARGET_UNKNOWN' }),
    );
  });

  it('binds multiple producer queues to one consumer emitter', () => {
    const effect = eventEffect();
    const secondSource = defineEmitter({
      capacity: 1,
      events: { onDeath: emitTo('smokePuffs', { inherit: ['position'] }) },
      init: [positionSphere({ radius: 2 }), lifetime(1)],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const combined = defineEffect({
      elements: { ...effect.elements, secondSource },
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(combined);
    expect(instance.getEmitter('smokePuffs')?.kernels.eventInputs).toHaveLength(2);
  });

  it('does not repeat a callback when the cumulative event total is unchanged', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(eventEffect());
    const counts: number[] = [];
    instance.on('death', ({ count }) => counts.push(count));
    await system.update(0);
    const state = instance.getEmitter('sparks')!.kernels.eventOutputs.onDeath!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 0, 2]));
    await system.update(0.1);
    await system.update(0.1);
    expect(counts).toEqual([2]);
  });

  it('performs no event counter readback when the interval is omitted', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer);
    system.spawn(eventEffect());
    await system.update(0.1);
    expect(renderer.readCount).toBe(0);
  });

  it('surfaces onCustom as an explicit compile diagnostic at spawn', () => {
    const custom = defineEmitter({
      capacity: 1,
      events: { onCustom: emitTo('target') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const target = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 0 }),
    });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({ elements: { custom, target } }),
    );
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_ON_CUSTOM_UNIMPLEMENTED' }),
    );
  });
});
