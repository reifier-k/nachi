import { describe, expect, it } from 'vitest';

import {
  EffectClock,
  EmitterLifecycleController,
  FixedStepAccumulator,
  SPAWN_ORDER_WRAP_WARNING_THRESHOLD,
  VFXSystem,
  VfxDiagnosticError,
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
  attribute,
  attributeStorageComponentIndex,
  bakeSimulation,
  billboard,
  burst,
  compileEmitter,
  collidePlane,
  collideSceneDepth,
  crossesSpawnOrderWarningThreshold,
  decalRenderer,
  defineEffect,
  defineEmitter,
  defineParameter,
  emitTo,
  estimateSimulationCacheMemory,
  lifetime,
  killVolume,
  perDistance,
  positionSphere,
  packedComponentIndex,
  rate,
  resolvePackedAttributeAddress,
  replaySimulation,
  sortEmittersBackToFront,
  tslModule,
} from '../src/index.js';

describe('M10 coarse transparency order', () => {
  it('sorts far-to-near and uses a stable key for equal depth', () => {
    const entries = [
      { stableKey: 'b', value: 2, worldPosition: [0, 0, -2] as const },
      { stableKey: 'c', value: 3, worldPosition: [0, 0, -7] as const },
      { stableKey: 'a', value: 1, worldPosition: [1, 0, -2] as const },
    ];
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(sortEmittersBackToFront(entries, identity).map(({ stableKey }) => stableKey)).toEqual([
      'c',
      'a',
      'b',
    ]);
    const reversedView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    expect(sortEmittersBackToFront(entries, reversedView)[0]?.stableKey).toBe('a');
  });
});
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
  name = '';

  element(): KernelNode {
    return this.node;
  }
  setName(name: string): KernelStorageNode {
    this.name = name;
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

class DrawTrackingRuntimeRenderer extends FakeRuntimeRenderer {
  drawCount = 0;

  getRenderableIndirectDrawCount(): number {
    return this.drawCount;
  }
}

class ZeroReadbackRenderer extends FakeRuntimeRenderer {
  readStorage(): Promise<ArrayBuffer> {
    return Promise.resolve(new Uint32Array(4).buffer);
  }
}

class CacheRuntimeRenderer extends ZeroReadbackRenderer {
  readonly uploads: { readonly byteLength: number; readonly byteOffset: number }[] = [];

  writeStorage(_storage: KernelStorageNode, data: ArrayBufferView, byteOffset = 0): void {
    this.uploads.push({ byteLength: data.byteLength, byteOffset });
  }
}

class DeferredUploadRenderer extends FakeRuntimeRenderer {
  readonly cpu = new Map<KernelStorageNode, Uint8Array>();
  readonly gpu = new Map<KernelStorageNode, Uint8Array>();
  flushCount = 0;
  readonly replayReady = new WeakSet<object>();

  clearStorageReplayReady(kernels: object): void {
    this.replayReady.delete(kernels);
  }

  isStorageReplayReady(kernels: object): boolean {
    return this.replayReady.has(kernels);
  }

  markStorageReplayReady(kernels: object): void {
    this.replayReady.add(kernels);
  }

  writeStorage(storage: KernelStorageNode, data: ArrayBufferView, byteOffset = 0): void {
    const size = Math.max(this.cpu.get(storage)?.byteLength ?? 0, byteOffset + data.byteLength);
    const target = new Uint8Array(size);
    target.set(this.cpu.get(storage)?.subarray(0, size) ?? []);
    target.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset);
    this.cpu.set(storage, target);
    if (!this.gpu.has(storage)) {
      const stale = new Uint8Array(size);
      new Uint32Array(stale.buffer)[0] = 8;
      this.gpu.set(storage, stale);
    }
  }

  flushStorageWrites(): void {
    this.flushCount += 1;
    for (const [storage, bytes] of this.cpu) this.gpu.set(storage, bytes.slice());
  }

  readStorage(storage: KernelStorageNode): Promise<ArrayBuffer> {
    return Promise.resolve((this.gpu.get(storage) ?? new Uint8Array(128)).slice().buffer);
  }
}

class SequenceCacheRuntimeRenderer extends CacheRuntimeRenderer {
  readonly #readbacks: ArrayBuffer[];

  constructor(readbacks: readonly ArrayBuffer[]) {
    super();
    this.#readbacks = readbacks.map((value) => value.slice(0));
  }

  override readStorage(): Promise<ArrayBuffer> {
    const value = this.#readbacks.shift();
    if (!value) throw new Error('Synthetic cache readback sequence is exhausted.');
    return Promise.resolve(value);
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

describe('spawn-order wrap warning', () => {
  it('crosses once at the u32 half-range safety threshold', () => {
    expect(crossesSpawnOrderWarningThreshold(SPAWN_ORDER_WRAP_WARNING_THRESHOLD - 1, 1)).toBe(true);
    expect(crossesSpawnOrderWarningThreshold(SPAWN_ORDER_WRAP_WARNING_THRESHOLD, 1)).toBe(false);
    expect(crossesSpawnOrderWarningThreshold(0, 1)).toBe(false);
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
  it('warns without a camera and reverses stable coarse alpha render order with the view', async () => {
    class OrderRenderer extends FakeRuntimeRenderer {
      readonly orders: number[] = [];
      readonly byKernels = new Map<unknown, number>();
      setRenderOrder(kernels: unknown, order: number): void {
        this.orders.push(order);
        this.byKernels.set(kernels, order);
      }
    }
    const renderer = new OrderRenderer();
    const alphaEmitter = (z: number) =>
      defineEmitter({
        capacity: 1,
        init: [positionSphere({ radius: 0 }), lifetime(1)],
        integration: 'none' as const,
        render: billboard({ blending: 'alpha', sortCenter: [0, 0, z] }),
        spawn: burst({ count: 1 }),
      });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(
      defineEffect({ elements: { far: alphaEmitter(-3), near: alphaEmitter(2) } }),
    );
    await system.update(0);
    expect(instance.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'NACHI_ALPHA_SORT_CAMERA_UNSET' })]),
    );
    renderer.orders.length = 0;
    system.setCamera({
      projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewportSize: [64, 64],
    });
    const farKernels = instance.getEmitter('far')!.kernels;
    const nearKernels = instance.getEmitter('near')!.kernels;
    const forward = [renderer.byKernels.get(farKernels), renderer.byKernels.get(nearKernels)];
    renderer.orders.length = 0;
    system.setCamera({
      projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
      viewportSize: [64, 64],
    });
    const reverse = [renderer.byKernels.get(farKernels), renderer.byKernels.get(nearKernels)];
    expect(forward).toEqual([1_000, 1_001]);
    expect(reverse).toEqual([1_001, 1_000]);
  });

  it('warns without a camera and submits each bitonic stage in dependency order', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 8,
            init: [positionSphere({ radius: 1 }), lifetime(1)],
            integration: 'none',
            render: billboard({ blending: 'alpha', sorted: true }),
            spawn: burst({ count: 8 }),
          }),
        },
      }),
    );

    await system.update(0);

    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_ALPHA_SORT_CAMERA_UNSET' }),
    );
    const stages = renderer.submissions.filter((name) => name.startsWith('NachiBitonicSort_'));
    const expectedStages = [
      ['2', '1'],
      ['4', '2'],
      ['4', '1'],
      ['8', '4'],
      ['8', '2'],
      ['8', '1'],
    ];
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.length % expectedStages.length).toBe(0);
    for (let offset = 0; offset < stages.length; offset += expectedStages.length) {
      expect(
        stages
          .slice(offset, offset + expectedStages.length)
          .map((name) => name.match(/_k(\d+)_j(\d+)$/)?.slice(1)),
      ).toEqual(expectedStages);
    }
  });
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

  it('does not consume an alpha coarse-sort rank for a projection decal', async () => {
    const base = sceneDepthRenderer();
    let renderOrderWrites = 0;
    const system = new VFXSystem({
      ...base,
      setRenderOrder: () => {
        renderOrderWrites += 1;
      },
    });
    const instance = system.spawn(
      defineEffect({
        elements: {
          decal: defineEmitter({
            capacity: 1,
            integration: 'none',
            render: decalRenderer({ blending: 'alpha' }),
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );

    await system.update(0);

    expect(renderOrderWrites).toBe(0);
    expect(instance.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_ALPHA_SORT_CAMERA_UNSET' }),
    );
  });

  it('warns on first update when scene-depth collision has no configured camera', async () => {
    const system = new VFXSystem(sceneDepthRenderer());
    const instance = system.spawn(sceneDepthEffect());

    expect(instance.state).toBe('active');
    expect(instance.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_SCENE_DEPTH_CAMERA_UNSET' }),
    );
    await system.update(0);
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_SCENE_DEPTH_CAMERA_UNSET',
        severity: 'warning',
      }),
    );
  });

  it('does not warn when camera uniforms are configured before the first update', async () => {
    const system = new VFXSystem(sceneDepthRenderer());
    const instance = system.spawn(sceneDepthEffect());
    system.setCamera({
      projectionMatrix: [1, 0, 0, 0, 0, 1, -1, -1, 0, 0, -1, -1, 0, 0, -0.1, 0],
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewportSize: [64, 64],
    });
    await system.update(0);

    expect(instance.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_SCENE_DEPTH_CAMERA_UNSET' }),
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

  it('deduplicates reverse-z camera warnings per instance and diagnostic code', () => {
    const system = new VFXSystem(sceneDepthRenderer());
    const instance = system.spawn(sceneDepthEffect());
    const camera = {
      projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.01, -1, 0, 0, 0.1, 0],
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      viewportSize: [64, 64] as const,
    };

    system.setCamera(camera);
    system.setCamera(camera);
    system.setCamera(camera);

    expect(
      instance.diagnostics.filter(({ code }) => code === 'NACHI_SCENE_DEPTH_REVERSE_Z_UNSUPPORTED'),
    ).toHaveLength(1);
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
    expect((system.renderer as FakeRuntimeRenderer).releaseCount).toBe(0);
    expect(system.getPooledInstanceCount(stopped.definition)).toBe(1);
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
    instance.release();
    expect(system.getPooledInstanceCount(instance.definition)).toBe(0);
    expect(renderer.releaseCount).toBe(1);
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

  it('warns once when readback observes spawnOrder at the u32 half-range', async () => {
    const base = new FakeRuntimeRenderer();
    let nextSpawnOrderOffset = 0;
    const renderer: VfxRuntimeRenderer = {
      kernelAdapter: base.kernelAdapter,
      readStorage: () => {
        const counters = new Uint32Array(nextSpawnOrderOffset + 1);
        counters[nextSpawnOrderOffset] = SPAWN_ORDER_WRAP_WARNING_THRESHOLD;
        return Promise.resolve(counters.buffer);
      },
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitCompute(kernel),
    };
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const orderedEmitter = defineEmitter({
      capacity: 1,
      init: [lifetime(1)],
      lifecycle: { duration: 1 },
      render: {
        ...computeRender,
        access: { reads: ['Particles.spawnOrder'], writes: [] },
      },
      spawn: burst({ count: 1 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: orderedEmitter } }));
    nextSpawnOrderOffset = instance.getEmitter('particles')?.kernels.nextSpawnOrderOffset ?? 0;

    await system.update(0);
    await system.update(0);

    expect(
      instance.diagnostics.filter(({ code }) => code === 'NACHI_SPAWN_ORDER_WRAP_RISK'),
    ).toHaveLength(1);
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

describe('M11 debug capture scheduling', () => {
  it('diagnoses attribute capture before the emitter initialization kernel has run', async () => {
    const system = new VFXSystem(new ZeroReadbackRenderer());
    const instance = system.spawn(runtimeEffect());

    await expect(instance.debug.captureAttributes('particles')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_DEBUG_EMITTER_UNINITIALIZED' })],
    });
  });

  it('keeps multi-storage capture and profile on one frame before a concurrent update', async () => {
    const base = new FakeRuntimeRenderer();
    const pendingReads = new Map<KernelStorageNode, (buffer: ArrayBuffer) => void>();
    const renderer: VfxRuntimeRenderer = {
      kernelAdapter: base.kernelAdapter,
      readStorage: (storage) =>
        new Promise<ArrayBuffer>((resolve) => {
          pendingReads.set(storage, resolve);
        }),
      submitCompute: (kernel) => base.submitCompute(kernel),
      submitComputeIndirect: (kernel) => base.submitCompute(kernel),
    };
    const system = new VFXSystem(renderer);
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            init: [
              positionSphere({ radius: 0 }),
              tslModule(
                ({ spawnOrder }) => ({
                  lifetime: spawnOrder.toFloat().mul(0).add(10),
                }),
                { stage: 'init' },
              ),
            ],
            integration: 'none',
            lifecycle: { duration: 10 },
            render: billboard({ blending: 'additive' }),
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    await system.update(0);

    const view = instance.getEmitter('particles')!;
    const schema = view.program.attributeSchema;
    const storageNodes = schema.storageArrays.map(
      (storage) => view.kernels.storages[storage.name]!,
    );
    const makeStorageBuffer = (storageIndex: number, marker: number): ArrayBuffer => {
      const storage = schema.storageArrays[storageIndex]!;
      const length = storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type];
      const physical =
        storage.componentType === 'uint'
          ? new Uint32Array(length)
          : storage.componentType === 'int'
            ? new Int32Array(length)
            : new Float32Array(length);
      const logicalValues: Readonly<Record<string, readonly number[]>> = {
        position: [marker, marker + 1, marker + 2],
        spawnGeneration: [1],
        spawnOrder: [marker],
      };
      for (const [name, values] of Object.entries(logicalValues)) {
        const attribute = schema.byName[name];
        if (!attribute || attribute.physical.bufferIndex !== storageIndex) continue;
        for (const [component, value] of values.entries()) {
          physical[attributeStorageComponentIndex(attribute, storage, 'webgpu', 0, component)] =
            value;
        }
      }
      return physical.slice().buffer as ArrayBuffer;
    };
    const resolveRead = (storage: KernelStorageNode, buffer: ArrayBuffer): void => {
      const resolve = pendingReads.get(storage);
      if (!resolve) throw new Error('Expected deferred debug readback was not scheduled.');
      pendingReads.delete(storage);
      resolve(buffer);
    };

    const capture = instance.debug.captureAttributes('particles', {
      attributes: ['position', 'spawnOrder'],
    });
    for (let turn = 0; turn < 4 && pendingReads.size < 3; turn += 1) {
      await Promise.resolve();
    }
    expect(pendingReads.size).toBe(3);

    const marker = base.submissions.length;
    const lifecycle = new Uint32Array(view.program.meta.lifecycleStorage.buffers.state.wordCount);
    lifecycle[view.kernels.counterOffsets.aliveCount] = 1;
    lifecycle[view.kernels.aliveIndicesOffset] = 0;
    resolveRead(view.kernels.aliveCount, lifecycle.buffer);
    const floatStorageIndex = schema.storageArrays.findIndex(
      ({ componentType }) => componentType === 'float',
    );
    resolveRead(storageNodes[floatStorageIndex]!, makeStorageBuffer(floatStorageIndex, marker));

    const profileBeforeUpdate = system.debug.captureProfile();
    const concurrentUpdate = system.update(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(base.submissions).toHaveLength(marker);

    for (const [storageIndex, storage] of storageNodes.entries()) {
      if (pendingReads.has(storage)) {
        resolveRead(storage, makeStorageBuffer(storageIndex, base.submissions.length));
      }
    }
    const snapshot = await capture;
    const profile = await profileBeforeUpdate;
    await concurrentUpdate;

    expect(snapshot.rows[0]).toMatchObject({
      attributes: { position: [marker, marker + 1, marker + 2], spawnOrder: marker },
      spawnOrder: marker,
    });
    expect(profile.frame).toBe(1);
    expect((await system.debug.captureProfile()).frame).toBe(2);
  });
});

describe('M11 VFXSystem scalability scheduling', () => {
  const camera = {
    projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    viewportSize: [320, 180] as const,
  };

  it('fades by distance, pauses update/local time while culled, and resumes deterministically', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { center: [0.2, -0.1, 0], radius: 0.25 },
          capacity: 32,
          init: [lifetime(2)],
          lifecycle: { duration: 10, loopCount: 'infinite' },
          render: computeRender,
          spawn: rate(10),
        }),
      },
      scalability: {
        culling: { distance: { fadeEnd: 6, fadeStart: 4 }, frustum: false },
      },
    });
    const instance = system.spawn(definition, { position: [0, 0, 5] });
    expect(instance.scalability.action).toBe('full');
    expect(instance.scalability.fade).toBeGreaterThan(0.35);
    expect(instance.scalability.fade).toBeLessThan(0.65);
    await system.update(0.1);
    const visibleTime = instance.localTime;
    const submissions = renderer.submissions.length;
    instance.setTransform([0, 0, 7]);
    await system.update(0.5);
    expect(instance.scalability).toMatchObject({ action: 'culled', fade: 0 });
    expect(instance.scalability.reasons).toContain('distance');
    expect(instance.localTime).toBe(visibleTime);
    expect(renderer.submissions).toHaveLength(submissions);
    instance.setTransform([0, 0, 1]);
    await system.update(0.1);
    expect(instance.scalability.action).toBe('full');
    expect(instance.localTime).toBeCloseTo(visibleTime + 0.1);
  });

  it('keeps the higher deterministic significance score inside the instance budget', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      significanceBudget: { maxActiveInstances: 1, maxParticles: 100 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { center: [0.15, -0.2, 0.4], radius: 0.2 },
          capacity: 10,
          render: computeRender,
          spawn: burst({ count: 1 }),
        }),
      },
      scalability: { significance: { priority: 0 } },
    });
    const low = system.spawn(definition, { position: [0, 0, 0.5], priority: 0 });
    const high = system.spawn(definition, { position: [0, 0, 0.5], priority: 2 });
    expect(high.scalability.action).toBe('full');
    expect(low.scalability.action).toBe('culled');
    expect(low.scalability.reasons).toContain('significance-instance-budget');
    expect(high.scalability.score).toBeGreaterThan(low.scalability.score);
  });

  it('suppresses normal scheduler births at the particle budget with the normative reason', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, {
      significanceBudget: { maxActiveInstances: 2, maxParticles: 4 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          render: computeRender,
          spawn: burst({ count: 4 }),
        }),
      },
    });
    const full = system.spawn(definition, { priority: 1 });
    const suppressed = system.spawn(definition, { priority: 0 });

    expect(full.scalability.action).toBe('full');
    expect(suppressed.scalability).toMatchObject({
      action: 'spawn-suppressed',
      reasons: ['significance-particle-budget'],
    });
    await system.update(0);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
  });

  it('reports indirect draws one frame late and keeps culled, paused, and unmaterialized frames at zero', async () => {
    const renderer = new DrawTrackingRuntimeRenderer();
    const system = new VFXSystem(renderer);
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { radius: 0.1 },
          capacity: 1,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 1 }),
        }),
      },
      scalability: { culling: { distance: { fadeEnd: 5 }, frustum: false } },
    });
    const instance = system.spawn(definition);
    await system.update(0);
    const unmaterialized = await system.debug.captureProfile();
    expect(unmaterialized).toMatchObject({
      frame: 1,
      system: { indirectDraws: { value: 0 } },
    });

    // Host materialization/render completes after update/capture. The same scheduler frame remains
    // unchanged; the next top-level update publishes that completed draw frame.
    renderer.drawCount = 1;
    expect((await system.debug.captureProfile()).system.indirectDraws).toMatchObject({ value: 0 });
    await system.update(1 / 60);
    expect(await system.debug.captureProfile()).toMatchObject({
      frame: 2,
      system: { indirectDraws: { value: 1 } },
    });

    instance.setTransform([10, 0, 0]);
    await system.update(1 / 60);
    expect(instance.scalability.action).toBe('culled');
    expect((await system.debug.captureProfile()).system.indirectDraws).toMatchObject({ value: 0 });

    instance.setTransform([0, 0, 0]);
    await system.update(0);
    expect((await system.debug.captureProfile()).system.indirectDraws).toMatchObject({ value: 0 });

    renderer.drawCount = 0;
    await system.update(1 / 60);
    expect((await system.debug.captureProfile()).system.indirectDraws).toMatchObject({ value: 0 });

    instance.stop();
    await system.update(1 / 60);
    expect((await system.debug.captureProfile()).system.indirectDraws).toMatchObject({ value: 0 });
  });

  it('keeps the admitted instance through a narrow score crossing and switches outside the band', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      significanceBudget: { maxActiveInstances: 1, maxParticles: 100 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { radius: 0.01 },
          capacity: 1,
          render: computeRender,
          spawn: burst({ count: 0 }),
        }),
      },
      scalability: { significance: { priority: 0 } },
    });
    const admitted = system.spawn(definition, { position: [0, 0, 2] });
    const challenger = system.spawn(definition, { position: [0, 0, 1.9] });
    expect(challenger.scalability.score).toBeGreaterThan(admitted.scalability.score);
    expect(admitted.scalability.action).toBe('full');
    expect(challenger.scalability.action).toBe('culled');

    challenger.setTransform([0, 0, 0.1]);
    await system.update(0);
    expect(challenger.scalability.action).toBe('full');
    expect(admitted.scalability.action).toBe('culled');
  });

  it('enforces scaled logical capacity without readback and expires conservative births by lifetime', async () => {
    const definition = (particleLifetime: number) =>
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 8,
            init: [lifetime(particleLifetime)],
            lifecycle: { duration: 10, loopCount: 'infinite' },
            quality: { low: { capacityScale: 0.5, spawnRateScale: 1 } },
            render: computeRender,
            spawn: rate(8),
          }),
        },
      });

    const conservativeRenderer = new FakeRuntimeRenderer();
    const conservative = new VFXSystem(conservativeRenderer, undefined, { qualityTier: 'low' });
    conservative.spawn(definition(10));
    await conservative.update(0.5);
    await conservative.update(0.5);
    expect(
      conservativeRenderer.submissions.filter((name) => name === 'NachiEmitterSpawn'),
    ).toHaveLength(1);

    const expiringRenderer = new FakeRuntimeRenderer();
    const expiring = new VFXSystem(expiringRenderer, undefined, { qualityTier: 'low' });
    expiring.spawn(definition(0.5));
    await expiring.update(0.5);
    await expiring.update(0.5);
    expect(
      expiringRenderer.submissions.filter((name) => name === 'NachiEmitterSpawn'),
    ).toHaveLength(2);
  });

  it('does not apply stale alive readback as a CPU clamp at physical capacity', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 3 });
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 4,
            init: [lifetime(10)],
            lifecycle: { duration: 1 },
            render: computeRender,
            spawn: burst({ count: 1, cycles: 3, interval: 0.1 }),
          }),
        },
      }),
    );
    await system.update(0);
    const emitter = instance.getEmitter('particles')!;
    const counters = new Uint32Array(32);
    counters[emitter.kernels.counterOffsets.aliveCount] = 4;
    renderer.storageValues.set(emitter.kernels.aliveCount, counters);
    await system.update(0.1);
    await system.update(0.1);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(3);
  });

  it('applies uniform quality scales live and isolates structural variants by spawn/pool key', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, { qualityTier: 'epic' });
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 16,
          quality: { low: { capacityScale: 0.125, spawnRateScale: 0.25 } },
          render: billboard({ blending: 'alpha', lit: true, soft: true, sorted: true }),
          spawn: burst({ count: 8 }),
        }),
      },
    });
    const epic = system.spawn(definition);
    expect(epic.getEmitter('particles')?.program.draws[0]).toMatchObject({
      fragment: { lit: expect.any(Object), soft: expect.any(Object) },
      indirect: { physicalIndex: 'sorted-indices' },
    });
    system.setQualityTier('low');
    expect(epic.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_QUALITY_RESTART_REQUIRED' }),
    );
    const low = system.spawn(definition);
    const lowDraw = low.getEmitter('particles')?.program.draws[0];
    expect(lowDraw).toMatchObject({
      indirect: { physicalIndex: 'alive-indices' },
    });
    expect(lowDraw?.kind === 'billboard' && 'lit' in lowDraw.fragment).toBe(false);
    expect(lowDraw?.kind === 'billboard' && 'soft' in lowDraw.fragment).toBe(false);
    expect(system.compilationCount).toBe(2);

    system.setQualityTier('epic');
    system.setQualityTier('low');
    expect(
      epic.diagnostics.filter(({ code }) => code === 'NACHI_QUALITY_RESTART_REQUIRED'),
    ).toHaveLength(2);
  });

  it('round-trips nonzero per-component u16 ranges and preserves integer attributes losslessly', async () => {
    const quantizedVector = attribute('quantizedVector', {
      default: [0, 0, 0],
      type: 'vec3',
    });
    const booleanValue = attribute('booleanValue', { default: false, type: 'bool' });
    const signedValue = attribute('signedValue', { default: 0, type: 'i32' });
    const unsignedValue = attribute('unsignedValue', { default: 0, type: 'u32' });
    const render: ModuleDefinition<'render', Record<string, never>> = {
      ...computeRender,
      access: {
        reads: [
          'Particles.quantizedVector',
          'Particles.booleanValue',
          'Particles.signedValue',
          'Particles.unsignedValue',
        ],
        writes: [],
      },
    };
    const emitter = defineEmitter({
      attributes: { booleanValue, quantizedVector, signedValue, unsignedValue },
      capacity: 3,
      render,
      spawn: burst({ count: 0 }),
    });
    const definition = defineEffect({ elements: { particles: emitter } });
    const program = compileEmitter(emitter);
    const schema = program.attributeSchema;
    const source = new Map<string, Float32Array | Int32Array | Uint32Array>([
      [
        'quantizedVector',
        new Float32Array([-5.5, 2.25, -9.875, -1, 2.4375, -0.25, 7.25, 2.75, 0.125]),
      ],
      ['booleanValue', new Uint32Array([0, 1, 1])],
      ['signedValue', new Int32Array([-2_147_483_648, -17, 2_147_483_647])],
      ['unsignedValue', new Uint32Array([0, 0x89ab_cdef, 0xffff_ffff])],
    ]);
    const physical = schema.storageArrays.map((storage) => {
      const length = storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type];
      const values =
        storage.componentType === 'uint'
          ? new Uint32Array(length)
          : storage.componentType === 'int'
            ? new Int32Array(length)
            : new Float32Array(length);
      for (const name of storage.attributes) {
        const resolved = schema.byName[name];
        const logical = source.get(name);
        if (!resolved || !logical) continue;
        for (let particle = 0; particle < schema.capacity; particle += 1) {
          for (let component = 0; component < resolved.components; component += 1) {
            const physicalIndex = storage.packed
              ? packedComponentIndex(
                  particle,
                  resolvePackedAttributeAddress(resolved, storage),
                  component,
                )
              : particle * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] + component;
            values[physicalIndex] = logical[particle * resolved.components + component] ?? 0;
          }
        }
      }
      return values;
    });
    const lifecycle = new Uint32Array(program.meta.lifecycleStorage.buffers.state.wordCount);
    const lifecycleFields = program.meta.lifecycleStorage.buffers.state.fields;
    lifecycle[lifecycleFields.aliveCount.offsetWords] = schema.capacity;
    for (let particle = 0; particle < schema.capacity; particle += 1) {
      lifecycle[lifecycleFields.aliveIndices.offsetWords + particle] = particle;
    }
    const selectedStorageIndexes = [
      ...new Set(
        [...source.keys()].sort().map((name) => schema.byName[name]!.physical.bufferIndex),
      ),
    ];
    const renderer = new SequenceCacheRuntimeRenderer([
      lifecycle.buffer,
      ...selectedStorageIndexes.map((index) => physical[index]!.buffer),
    ]);

    const cache = await bakeSimulation(new VFXSystem(renderer), definition, {
      compression: 'quantized-u16',
      frames: 1,
    });
    const metadata = cache.metadata.emitters[0]!;
    for (const cached of metadata.attributes) {
      const expected = source.get(cached.name)!;
      const length = metadata.capacity * cached.components;
      if (cached.encoding === 'quantized-u16') {
        const encoded = new Uint16Array(cache.data, cached.offsetBytes, length);
        const range = cached.quantization!;
        for (let index = 0; index < length; index += 1) {
          const component = index % cached.components;
          const extent = range.maximum[component]! - range.minimum[component]!;
          expect(extent).toBeGreaterThan(0);
          const decoded = range.minimum[component]! + (encoded[index]! / 65535) * extent;
          expect(Math.abs(decoded - expected[index]!)).toBeLessThanOrEqual(extent / 131070);
        }
      } else if (cached.encoding === 'int32') {
        expect([...new Int32Array(cache.data, cached.offsetBytes, length)]).toEqual([...expected]);
      } else {
        expect([...new Uint32Array(cache.data, cached.offsetBytes, length)]).toEqual([...expected]);
      }
    }
  });

  it('bakes WebGL2 transform-feedback records against an independent analytic fixture', async () => {
    const render: ModuleDefinition<'render', Record<string, never>> = {
      ...computeRender,
      access: {
        reads: ['Particles.position', 'Particles.lifetime', 'Particles.size'],
        writes: [],
      },
    };
    const emitter = defineEmitter({
      capacity: 4,
      render,
      spawn: burst({ count: 0 }),
    });
    const definition = defineEffect({ elements: { particles: emitter } });
    const program = compileEmitter(emitter);
    const schema = program.attributeSchema;
    const lifetimeAttribute = schema.byName.lifetime!;
    const lifetimeStorage = schema.storageArrays[lifetimeAttribute.physical.bufferIndex]!;
    const aliveAttribute = schema.byName.alive!;
    const aliveStorage = schema.storageArrays[aliveAttribute.physical.bufferIndex]!;

    expect(lifetimeStorage.groupCount).toBe(2);
    expect(lifetimeAttribute.physical).toMatchObject({ group: 0, offset: 3, packed: true });

    // This fixture is authored directly in Three r185 TF record order: one vec4 per storage and
    // particle. It deliberately does not call the production address helper used by sim-cache.
    const lifetimePhysical = new Float32Array(lifetimeStorage.length * 4);
    const expectedLifetime = [1.5, 4.5, 7.5, 10.5];
    for (let particle = 0; particle < schema.capacity; particle += 1) {
      lifetimePhysical[particle * 4 + lifetimeAttribute.physical.offset] =
        expectedLifetime[particle]!;
    }
    const alivePhysical = new Uint32Array(aliveStorage.length * 4);
    for (let particle = 0; particle < schema.capacity; particle += 1) {
      alivePhysical[particle * 4 + aliveAttribute.physical.offset] = 1;
    }
    const lifecycle = new Uint32Array(program.meta.lifecycleStorage.buffers.state.wordCount);
    const fields = program.meta.lifecycleStorage.buffers.state.fields;
    lifecycle[fields.aliveCount.offsetWords] = schema.capacity;
    for (let particle = 0; particle < schema.capacity; particle += 1) {
      lifecycle[fields.aliveIndices.offsetWords + particle] = particle;
    }

    const renderer = new (class extends CacheRuntimeRenderer {
      override readStorage(storage?: KernelStorageNode): Promise<ArrayBuffer> {
        if (!storage) throw new Error('Analytic WebGL2 readback requires a storage node.');
        const name = (storage as FakeStorage).name;
        if (name.includes('packed_float')) return Promise.resolve(lifetimePhysical.slice().buffer);
        if (name.includes('packed_uint')) return Promise.resolve(alivePhysical.slice().buffer);
        if (name.includes('LifecycleState')) return Promise.resolve(lifecycle.slice().buffer);
        throw new Error(`Unexpected analytic WebGL2 readback storage ${name}.`);
      }
    })();
    Object.assign(renderer.kernelAdapter.capabilities, { backend: 'webgl2' });
    const cache = await bakeSimulation(new VFXSystem(renderer), definition, {
      frames: 1,
    });
    const cachedLifetime = cache.metadata.emitters[0]!.attributes.find(
      ({ name }) => name === 'lifetime',
    )!;

    expect(cache.metadata.sourceBackend).toBe('webgl2');
    expect([...new Float32Array(cache.data, cachedLifetime.offsetBytes, schema.capacity)]).toEqual(
      expectedLifetime,
    );
  });

  it('bakes render reads into quantized binary metadata and replays without simulation submits', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 2,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const bakeRenderer = new CacheRuntimeRenderer();
    const cache = await bakeSimulation(new VFXSystem(bakeRenderer), definition, {
      compression: 'quantized-u16',
      frames: 2,
      loop: true,
    });
    expect(cache.metadata.emitters[0]?.attributes).toEqual([
      expect.objectContaining({ encoding: 'quantized-u16', name: 'color' }),
      expect.objectContaining({ encoding: 'quantized-u16', name: 'position' }),
      expect.objectContaining({ encoding: 'quantized-u16', name: 'size' }),
      expect.objectContaining({ encoding: 'quantized-u16', name: 'spriteRotation' }),
    ]);
    expect(cache.metadata.loop).toMatchObject({
      aliveIndicesMatch: true,
      continuous: true,
      enabled: true,
      integerAttributesMatch: true,
      maximumAttributeError: 0,
    });
    expect(cache.metadata.sourceBackend).toBe('webgpu');
    expect(cache.metadata.qualityTier).toBe('epic');
    expect(estimateSimulationCacheMemory(cache)).toMatchObject({
      binaryBytes: cache.data.byteLength,
      uploadBytesPerFrame: expect.any(Number),
    });

    const replayRenderer = new CacheRuntimeRenderer();
    const player = await replaySimulation(new VFXSystem(replayRenderer), definition, cache);
    expect(replayRenderer.submissions).toEqual([]);
    expect(replayRenderer.uploads.length).toBeGreaterThan(0);
    player.play();
    player.setTimeScale(2);
    await player.update(1 / 240);
    expect(player.localTime).toBeCloseTo(1 / 120);
    player.stop();
    await player.update(1);
    expect(player.localTime).toBeCloseTo(1 / 120);

    const webglRenderer = new CacheRuntimeRenderer();
    Object.assign(webglRenderer.kernelAdapter.capabilities, { backend: 'webgl2' });
    await expect(
      replaySimulation(new VFXSystem(webglRenderer), definition, cache),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_BACKEND_MISMATCH' })],
    });

    const webglCache = {
      ...cache,
      metadata: { ...cache.metadata, sourceBackend: 'webgl2' as const },
    };
    await expect(
      replaySimulation(new VFXSystem(webglRenderer), definition, webglCache),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_REPLAY_WEBGL2_UNSUPPORTED' })],
    });
    await expect(
      replaySimulation(new VFXSystem(new CacheRuntimeRenderer()), definition, webglCache),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_BACKEND_MISMATCH' })],
    });
  });

  it('flushes replay uploads before immediate debug readback and resumes from a completed seek', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 8,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const renderer = new DeferredUploadRenderer();
    const system = new VFXSystem(renderer);
    const cache = await bakeSimulation(system, definition, { frames: 2 });
    expect(system.getPooledInstanceCount(definition)).toBe(1);
    const player = await replaySimulation(system, definition, cache);

    expect(renderer.flushCount).toBeGreaterThan(0);
    await expect(player.instance.debug.captureAttributes('particles')).resolves.toMatchObject({
      aliveCount: 0,
      rows: [],
    });

    player.play();
    await player.update(player.duration);
    expect(player.state).toBe('complete');
    await player.seek(player.duration / 2);
    const seekTime = player.localTime;
    player.play();
    expect(player.localTime).toBe(seekTime);
    await player.update(player.duration / 4);
    expect(player.localTime).toBeCloseTo((player.duration * 3) / 4);
  });

  it('rejects hostile cache layouts and indices with structured metadata diagnostics', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const floatCache = await bakeSimulation(new VFXSystem(new CacheRuntimeRenderer()), definition, {
      frames: 1,
    });
    const quantizedCache = await bakeSimulation(
      new VFXSystem(new CacheRuntimeRenderer()),
      definition,
      { compression: 'quantized-u16', frames: 1 },
    );
    const corrupt = (
      source: typeof floatCache,
      mutate: (metadata: typeof floatCache.metadata, data: ArrayBuffer) => void,
    ) => {
      const metadata = JSON.parse(JSON.stringify(source.metadata)) as typeof floatCache.metadata;
      const data = source.data.slice(0);
      mutate(metadata, data);
      return { data, kind: 'simulation-cache' as const, metadata };
    };
    const fixtures = [
      corrupt(floatCache, (metadata, data) => {
        Object.assign(metadata.emitters[0]!, { aliveCounts: [2] });
        const emitter = metadata.emitters[0]!;
        new Uint32Array(data, emitter.aliveIndicesOffsetBytes, 2).set([0, 0]);
      }),
      corrupt(floatCache, (metadata, data) => {
        Object.assign(metadata.emitters[0]!, { aliveCounts: [1] });
        const emitter = metadata.emitters[0]!;
        new Uint32Array(data, emitter.aliveIndicesOffsetBytes, 1)[0] = emitter.capacity;
      }),
      corrupt(floatCache, (metadata) => {
        Object.assign(metadata.emitters[0]!.attributes[0]!, { offsetBytes: 1 });
      }),
      corrupt(floatCache, (metadata) => {
        Object.assign(metadata.emitters[0]!.attributes[0]!, {
          frameStrideBytes: Number.MAX_SAFE_INTEGER,
        });
      }),
      corrupt(floatCache, (metadata) => {
        Object.assign(metadata.emitters[0]!.attributes[0]!, { logicalType: 'u32' });
      }),
      corrupt(floatCache, (metadata) => {
        const emitter = metadata.emitters[0]!;
        Object.assign(emitter.attributes[0]!, { offsetBytes: emitter.aliveIndicesOffsetBytes });
      }),
      corrupt(quantizedCache, (metadata) => {
        const quantization = metadata.emitters[0]!.attributes[0]!.quantization!;
        Object.assign(quantization, {
          maximum: quantization.maximum.map(() => -1),
          minimum: quantization.minimum.map(() => 1),
        });
      }),
    ];

    for (const fixture of fixtures) {
      expect(() => estimateSimulationCacheMemory(fixture)).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_METADATA_INVALID' })],
        }),
      );
    }
  });

  it('warms up by sampleStartFrame fixed steps before recording cache frames', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const renderer = new CacheRuntimeRenderer();
    const cache = await bakeSimulation(new VFXSystem(renderer), definition, {
      frameRate: 30,
      frames: 2,
      sampleStartFrame: 2,
    });

    expect(cache.metadata.sampleStartFrame).toBe(2);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterUpdate')).toHaveLength(3);
  });

  it('rejects baking through a system configured with a fixed timestep', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const renderer = new CacheRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, {
      fixedTimeStep: { stepSeconds: 1 / 30 },
    });

    expect(system.usesFixedTimeStep).toBe(true);
    await expect(bakeSimulation(system, definition, { frames: 2 })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'NACHI_SIM_CACHE_FIXED_TIMESTEP_UNSUPPORTED' }),
      ],
    });
    expect(renderer.submissions).toEqual([]);
  });

  it('rejects culled and particle-budget-suppressed bake instances', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { radius: 0.1 },
          capacity: 4,
          render: billboard({ blending: 'additive' }),
          spawn: burst({ count: 4 }),
        }),
      },
      scalability: { culling: { frustum: true } },
    });
    const culledSystem = new VFXSystem(new CacheRuntimeRenderer());
    culledSystem.setCamera({ ...camera, coordinateSystem: 'webgl' });
    await expect(
      bakeSimulation(culledSystem, definition, {
        frames: 1,
        spawn: { position: [3, 0, 0] },
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_SCALABILITY_SUPPRESSED' })],
    });

    const suppressedSystem = new VFXSystem(new CacheRuntimeRenderer(), undefined, {
      significanceBudget: { maxParticles: 0 },
    });
    await expect(bakeSimulation(suppressedSystem, definition, { frames: 1 })).rejects.toMatchObject(
      {
        diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_SCALABILITY_SUPPRESSED' })],
      },
    );
  });

  it('rebuilds valid sorted draw indirection during cache replay', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          render: billboard({ blending: 'alpha', sorted: true }),
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const cache = await bakeSimulation(new VFXSystem(new CacheRuntimeRenderer()), definition, {
      frames: 1,
    });
    const renderer = new CacheRuntimeRenderer();
    const player = await replaySimulation(new VFXSystem(renderer), definition, cache);
    const emitter = player.instance.getEmitter('particles')!;

    expect(emitter.program.draws[0]).toMatchObject({
      indirect: { physicalIndex: 'sorted-indices' },
    });
    expect(emitter.kernels.sortedIndices).toBeDefined();
    expect(renderer.submissions[0]).toBe('NachiEmitterPrepareDepthSort');
    expect(renderer.submissions.slice(1)).toEqual([
      'NachiBitonicSort_k2_j1',
      'NachiBitonicSort_k4_j2',
      'NachiBitonicSort_k4_j1',
    ]);
    expect(
      renderer.submissions.some((name) =>
        ['NachiEmitterInitialize', 'NachiEmitterSpawn', 'NachiEmitterUpdate'].includes(name),
      ),
    ).toBe(false);
  });

  it('rejects transient attributes required by a cache replay render path', async () => {
    const heat = attribute('heat', { default: 0, transient: true, type: 'f32' });
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          attributes: { heat },
          capacity: 1,
          render: {
            access: { reads: ['Particles.heat'], writes: [] },
            config: {},
            kind: 'module',
            stage: 'render',
            type: 'test/runtime-compute-only',
            version: 1,
          },
          spawn: burst({ count: 0 }),
        }),
      },
    });
    await expect(
      bakeSimulation(new VFXSystem(new CacheRuntimeRenderer()), definition, { frames: 1 }),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'NACHI_SIM_CACHE_TRANSIENT_RENDER_ATTRIBUTE' }),
      ],
    });
  });

  it('records birth-ring lifecycle data when a render path reads spawnOrder', async () => {
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 3,
          render: {
            access: { reads: ['Particles.spawnOrder'], writes: [] },
            config: {},
            kind: 'module',
            stage: 'render',
            type: 'test/runtime-compute-only',
            version: 1,
          },
          spawn: burst({ count: 0 }),
        }),
      },
    });
    const cache = await bakeSimulation(new VFXSystem(new CacheRuntimeRenderer()), definition, {
      frames: 2,
    });
    expect(cache.metadata.emitters[0]).toMatchObject({
      birthIndicesFrameStrideBytes: 12,
      nextSpawnOrders: [0, 0],
    });
    expect(cache.metadata.emitters[0]?.birthIndicesOffsetBytes).toEqual(expect.any(Number));
  });

  it('diagnoses birth-order schema drift in both replay directions', async () => {
    const initializeFromOrder = tslModule(
      ({ spawnOrder }) => ({ lifetime: spawnOrder.toFloat() }),
      { stage: 'init' },
    );
    const definition = (withBirthOrder: boolean) =>
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 2,
            ...(withBirthOrder ? { init: [initializeFromOrder] } : {}),
            integration: 'none',
            render: computeRender,
            spawn: burst({ count: 0 }),
          }),
        },
      });
    const withBirthOrder = definition(true);
    const withoutBirthOrder = definition(false);
    const cacheWithBirthOrder = await bakeSimulation(
      new VFXSystem(new CacheRuntimeRenderer()),
      withBirthOrder,
      { frames: 1 },
    );
    const cacheWithoutBirthOrder = await bakeSimulation(
      new VFXSystem(new CacheRuntimeRenderer()),
      withoutBirthOrder,
      { frames: 1 },
    );

    await expect(
      replaySimulation(
        new VFXSystem(new CacheRuntimeRenderer()),
        withoutBirthOrder,
        cacheWithBirthOrder,
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_SCHEMA_MISMATCH' })],
    });
    await expect(
      replaySimulation(
        new VFXSystem(new CacheRuntimeRenderer()),
        withBirthOrder,
        cacheWithoutBirthOrder,
      ),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_SIM_CACHE_SCHEMA_MISMATCH' })],
    });
  });
});
