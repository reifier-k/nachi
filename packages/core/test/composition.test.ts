import { describe, expect, it } from 'vitest';

import {
  VFXSystem,
  VfxDiagnosticError,
  attribute,
  burst,
  defineEffect,
  defineEmitter,
  defineParameter,
  drag,
  gravity,
  lifetime,
  parameter,
  positionSphere,
} from '../src/index.js';
import type {
  KernelComputeBuilder,
  KernelComputeNode,
  KernelNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  ModuleDefinition,
  ModuleStage,
  VfxRuntimeRenderer,
} from '../src/index.js';

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  label: 'renderer',
  stage: 'render',
  type: 'test/m9-compute-only',
  version: 1,
};

function labeled<Stage extends ModuleStage, Config extends object>(
  label: string,
  module: ModuleDefinition<Stage, Config>,
): ModuleDefinition<Stage, Config> {
  return { ...module, label };
}

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
  and(): KernelNode {
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
  lessThanEqual(): KernelNode {
    return this;
  }
  mul(): KernelNode {
    return this;
  }
  mulAssign(): KernelNode {
    return this;
  }
  not(): KernelNode {
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
  readonly node = new FakeNode();
  readonly value = {};
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
    capabilities: { atomics: true, backend: 'webgpu', indirectDispatch: true, indirectDraw: true },
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
    indirectArray: () => Object.assign(new FakeStorage(), { indirectResource: {} }),
    instancedArray: () => new FakeStorage(),
    inverse: node,
    mat4: node,
    sampleMeshSurface: () => ({ normal: node(), position: node() }),
    sampleSdf: () => ({ distance: node(), gradient: node() }),
    sampleTexture: node,
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
  prepareCount = 0;
  releaseCount = 0;
  throwOnSetUniform = false;
  prepareKernelsForPooling(): void {
    this.prepareCount += 1;
  }
  releaseKernels(): void {
    this.releaseCount += 1;
  }
  setUniformValue(uniform: KernelUniformNode, _path: string, value: unknown): void {
    if (this.throwOnSetUniform) throw new Error('uniform materialization failed');
    uniform.value = value;
  }
  submitCompute(kernel: KernelComputeNode): Promise<void> | void {
    this.submissions.push((kernel as FakeCompute).name);
  }
  submitComputeIndirect(kernel: KernelComputeNode): Promise<void> | void {
    return this.submitCompute(kernel);
  }
}

class DelayedFailureRenderer extends FakeRuntimeRenderer {
  readonly blocked: Promise<void>;
  #notifyBlocked!: () => void;
  #resume!: () => void;
  #submissionCount = 0;

  constructor() {
    super();
    this.blocked = new Promise((resolve) => {
      this.#notifyBlocked = resolve;
    });
  }

  resume(): void {
    this.#resume();
  }

  override submitCompute(kernel: KernelComputeNode): Promise<void> | void {
    this.submissions.push((kernel as FakeCompute).name);
    this.#submissionCount += 1;
    if (this.#submissionCount === 1) return Promise.reject(new Error('first instance failed'));
    if (this.#submissionCount !== 2) return;
    this.#notifyBlocked();
    return new Promise((resolve) => {
      this.#resume = resolve;
    });
  }
}

describe('M9 emitter inheritance', () => {
  it('merges labeled stacks while inheriting untouched modules and child scalar settings', () => {
    const base = defineEmitter({
      capacity: 8,
      init: [labeled('position', positionSphere({ radius: 1 })), labeled('life', lifetime(2))],
      lifecycle: { duration: 3, loopCount: 2 },
      offset: [1, 0, 0],
      render: computeRender,
      spawn: burst({ count: 2 }),
      update: [labeled('gravity', gravity(-9)), labeled('drag', drag(0.1))],
    });
    const child = defineEmitter(base, {
      capacity: 16,
      init: { modules: [labeled('position', positionSphere({ radius: 2 }))] },
      lifecycle: { duration: 4 },
      offset: [2, 0, -1],
      spawn: burst({ count: 5 }),
      update: {
        modules: [labeled('gravity', gravity(-3)), labeled('wind', gravity([2, 0, 0]))],
        order: ['wind', 'gravity'],
        remove: ['drag'],
      },
    });

    expect(child.capacity).toBe(16);
    expect(child.lifecycle).toEqual({ duration: 4, loopCount: 2 });
    expect(child.offset).toEqual([2, 0, -1]);
    expect((child.spawn as ModuleDefinition).config).toEqual({ count: 5 });
    expect(child.init?.map(({ label }) => label)).toEqual(['position', 'life']);
    expect(child.init?.[0]?.config).toEqual({ radius: 2 });
    expect(child.update?.map(({ label }) => label)).toEqual(['wind', 'gravity']);
    expect(child.render).toEqual([computeRender]);
    expect(JSON.stringify(child)).not.toContain('extends');
  });

  it('supports whole-stack replacement and reports invalid inheritance graphs and types', () => {
    const base = defineEmitter({
      attributes: { heat: attribute('heat', { default: 0, type: 'f32' }) },
      capacity: 2,
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: [labeled('gravity', gravity(-9))],
    });
    const replaced = defineEmitter(base, {
      update: { mode: 'replace', modules: [labeled('drag', drag(0.2))] },
    });
    expect(replaced.update?.map(({ label }) => label)).toEqual(['drag']);
    expect(() =>
      defineEmitter(base, {
        attributes: { heat: attribute('heat', { default: [0, 0, 0], type: 'vec3' }) },
      }),
    ).toThrowError(VfxDiagnosticError);

    const cyclic = { ...base } as typeof base & { self?: unknown };
    cyclic.self = cyclic;
    expect(() => defineEmitter(cyclic, {})).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_EMITTER_INHERITANCE_CYCLE' })],
      }),
    );
  });

  it('preserves inherited values passed as explicit undefined and diagnoses duplicate order', () => {
    const heat = attribute('heat', { default: 1, type: 'f32' });
    const intensity = defineParameter('User.intensity', {
      default: 1,
      mutable: true,
      type: 'f32',
    });
    const base = defineEmitter({
      attributes: { heat },
      capacity: 2,
      lifecycle: { duration: 3, loopCount: 2 },
      parameters: { 'User.intensity': intensity },
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: [labeled('gravity', gravity(-9))],
    });
    const inherited = defineEmitter(base, {
      attributes: { heat: undefined },
      capacity: undefined,
      lifecycle: { duration: undefined },
      parameters: { 'User.intensity': undefined },
      spawn: undefined,
    } as never);
    expect(inherited.capacity).toBe(2);
    expect(inherited.spawn).toBe(base.spawn);
    expect(inherited.attributes?.heat).toBe(heat);
    expect(inherited.lifecycle).toEqual({ duration: 3, loopCount: 2 });
    expect(inherited.parameters?.['User.intensity']).toBe(intensity);

    expect(() => defineEmitter(base, { update: { order: ['gravity', 'gravity'] } })).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'NACHI_EMITTER_INHERITANCE_TARGET_UNKNOWN',
            message: expect.stringContaining('duplicate module selector'),
          }),
        ],
      }),
    );
  });

  it('omits absent optional stage keys from inherited emitters', () => {
    const base = defineEmitter({
      capacity: 2,
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const inherited = defineEmitter(base, { capacity: 4 });

    expect('init' in inherited).toBe(false);
    expect('update' in inherited).toBe(false);
  });
});

describe('M9 composed parameters and pooling', () => {
  const intensity = defineParameter('User.intensity', {
    default: 1,
    mutable: true,
    type: 'f32',
  });
  const effect = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 2,
        integration: 'none',
        parameters: { 'User.intensity': intensity },
        render: computeRender,
        spawn: burst({ count: 1 }),
        update: [gravity(parameter<number>('User.intensity'))],
      }),
    },
  });

  it('lifts emitter User.* declarations and keeps instance uniforms independent', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const first = system.spawn(effect);
    const second = system.spawn(effect);
    first.setParameter('User.intensity', 2);

    expect(first.getEmitter('particles')?.kernels.uniforms['User.intensity']?.value).toBe(2);
    expect(second.getEmitter('particles')?.kernels.uniforms['User.intensity']?.value).toBe(1);
    expect(() => first.setParameter('User.missing' as never, 2)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_PARAMETER_UNKNOWN' })],
      }),
    );
    expect(() => first.setParameter('User.intensity', 'bad' as never)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_PARAMETER_TYPE_MISMATCH' })],
      }),
    );

    const exposure = defineParameter('User.exposure', {
      default: 0.5,
      mutable: true,
      type: 'f32',
    });
    const explicit = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          integration: 'none',
          render: computeRender,
          spawn: burst({ count: 1 }),
        }),
      },
      parameters: { 'User.exposure': exposure },
    });
    const explicitInstance = system.spawn(explicit);
    explicitInstance.setParameter('User.exposure', 0.75);
    expect(explicitInstance.getEmitter('particles')?.kernels.uniforms['User.exposure']?.value).toBe(
      0.75,
    );
  });

  it('describes sibling parameter conflicts as sibling disagreements', () => {
    const sibling = (defaultValue: number) =>
      defineEmitter({
        capacity: 1,
        integration: 'none',
        parameters: {
          'User.shared': defineParameter('User.shared', {
            default: defaultValue,
            type: 'f32',
          }),
        },
        render: computeRender,
        spawn: burst({ count: 1 }),
      });

    expect(() =>
      defineEffect({ elements: { first: sibling(1), second: sibling(2) } }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'NACHI_EFFECT_PARAMETER_CONFLICT',
            message: expect.stringContaining('Sibling emitter declarations'),
          }),
        ],
      }),
    );
  });

  it('reuses materialized kernels while preserving the WeakMap compile cache', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const first = system.spawn(effect, { seed: 42 });
    await system.update(0);
    const firstKernels = first.getEmitter('particles')!.kernels;
    first.release();
    expect(system.getPooledInstanceCount(effect)).toBe(1);
    expect(renderer.prepareCount).toBe(1);

    const second = system.spawn(effect, { seed: 42 });
    const secondKernels = second.getEmitter('particles')!.kernels;
    expect(secondKernels).toBe(firstKernels);
    await system.update(0);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterInitialize')).toHaveLength(
      2,
    );
    expect(system.compilationCount).toBe(1);
    expect(system.getPooledInstanceCount(effect)).toBe(0);
  });

  it('bounds retained bundles and diagnoses resources disposed beyond the cap', () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const first = system.spawn(effect);
    const second = system.spawn(effect);
    first.release();
    second.release();

    expect(system.getPooledInstanceCount(effect)).toBe(1);
    expect(renderer.releaseCount).toBe(1);
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EFFECT_POOL_LIMIT_EXCEEDED', severity: 'warning' }),
    );
  });

  it('keeps pool accounting inside each weakly keyed definition ledger', () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const otherEffect = defineEffect({ elements: effect.elements });
    const first = system.spawn(effect);
    const other = system.spawn(otherEffect);

    first.release();
    other.release();

    expect(system.getPooledInstanceCount(effect)).toBe(1);
    expect(system.getPooledInstanceCount(otherEffect)).toBe(1);
    expect(other.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_EFFECT_POOL_LIMIT_EXCEEDED' }),
    );
  });

  it('disposes a pooled bundle if respawn materialization fails after checkout', () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    system.spawn(effect).release();
    renderer.throwOnSetUniform = true;

    const failed = system.spawn(effect);

    expect(failed.state).toBe('error');
    expect(system.getPooledInstanceCount(effect)).toBe(0);
    expect(renderer.releaseCount).toBe(1);
  });

  it('does not pool an error instance released while another update is still in flight', async () => {
    const renderer = new DelayedFailureRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const failed = system.spawn(effect);
    system.spawn(effect);
    const update = system.update(0);
    await renderer.blocked;
    expect(failed.state).toBe('error');

    failed.release();
    renderer.resume();
    await update;
    await Promise.resolve();
    await Promise.resolve();

    expect(system.getPooledInstanceCount(effect)).toBe(0);
    expect(renderer.releaseCount).toBe(1);
  });
});
