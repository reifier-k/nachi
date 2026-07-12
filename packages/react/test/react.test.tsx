import type {
  KernelComputeBuilder,
  KernelComputeNode,
  KernelNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  ParameterPath,
  VfxRuntimeRenderer,
} from '@nachi/core';
import {
  burst,
  defineEffect,
  defineEmitter,
  defineParameter,
  gravity,
  lifetime,
  parameter,
} from '@nachi/core';
// React 19 deprecates react-test-renderer; retain it for this canvas-free lifecycle suite until the
// binding tests migrate to a supported React renderer.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Object3D, Scene } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const r3f = vi.hoisted(() => ({
  frames: new Set<(state: unknown, delta: number) => void>(),
  scene: undefined as unknown,
}));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    r3f.frames.add(callback);
  },
  useThree: (selector: (state: { scene: unknown }) => unknown) => selector({ scene: r3f.scene }),
}));

import { VFXEffect, VFXSystemProvider, useVFXSystem } from '../src/index.js';

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
  and(): KernelNode {
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
  lessThanEqual(): KernelNode {
    return this;
  }
  mod(): KernelNode {
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
    floor: node,
    fn: (callback) => {
      callback();
      return new FakeCompute();
    },
    indirectArray: () => Object.assign(new FakeStorage(), { indirectResource: {} }),
    instancedArray: () => new FakeStorage(),
    inverse: node,
    mod: node,
    sampleMeshSurface: () => ({ normal: node(), position: node() }),
    sampleSdf: () => ({ distance: node(), gradient: node() }),
    sampleTexture: node,
    sampleVectorField: node,
    select: node,
    simplexNoise: node,
    sin: node,
    uint: node,
    uniform: (value) => new FakeNode(value),
    vec2: node,
    vec3: node,
    vec4: node,
  };
}

class FakeRuntimeRenderer implements VfxRuntimeRenderer {
  readonly kernelAdapter = fakeAdapter();
  readonly submissions: string[] = [];
  readonly uniformWrites: { path: ParameterPath; value: unknown }[] = [];
  releaseCount = 0;
  releaseKernels(): void {
    this.releaseCount += 1;
  }
  setUniformValue(_uniform: KernelUniformNode, path: ParameterPath, value: unknown): void {
    this.uniformWrites.push({ path, value });
  }
  submitCompute(kernel: KernelComputeNode): void {
    this.submissions.push((kernel as FakeCompute).name);
  }
  submitComputeIndirect(kernel: KernelComputeNode): void {
    this.submitCompute(kernel);
  }
}

const renderModule = {
  access: { reads: [] as const, writes: [] as const },
  config: {},
  kind: 'module' as const,
  stage: 'render' as const,
  type: 'test/react-compute-only',
  version: 1,
};

const intensity = defineParameter('User.intensity', {
  default: 1,
  mutable: true,
  type: 'f32',
});

const definition = defineEffect({
  elements: {
    particles: defineEmitter({
      capacity: 2,
      init: [lifetime(1)],
      parameters: { 'User.intensity': intensity },
      render: renderModule,
      spawn: burst({ count: 1 }),
      update: [gravity(parameter('User.intensity', 1))],
    }),
  },
});

const immutableDefinition = defineEffect({
  elements: {
    particles: defineEmitter({
      capacity: 2,
      init: [lifetime(1)],
      parameters: {
        'User.variant': defineParameter('User.variant', { default: 1, type: 'f32' }),
      },
      render: renderModule,
      spawn: burst({ count: 1 }),
    }),
  },
});

const SYSTEM_OPTIONS = { maxPoolSize: 0 } as const;

describe('@nachi/react lifecycle', () => {
  beforeEach(() => {
    r3f.frames.clear();
    r3f.scene = new Scene();
  });

  it('mounts, drives update, forwards props/attachment, and releases without leaks', async () => {
    const renderer = new FakeRuntimeRenderer();
    const target = new Object3D();
    target.position.set(2, 3, 4);
    let system: ReturnType<typeof useVFXSystem> | undefined;

    function Probe(): null {
      system = useVFXSystem();
      return null;
    }

    function Tree({ attached = false, intensityValue = 1, visible = true }) {
      return (
        <VFXSystemProvider renderer={renderer} options={SYSTEM_OPTIONS}>
          <Probe />
          {visible ? (
            <VFXEffect
              {...(attached ? { attachTo: target } : {})}
              definition={definition}
              parameters={{ 'User.intensity': intensityValue }}
            />
          ) : null}
        </VFXSystemProvider>
      );
    }

    let root: ReactTestRenderer;
    await act(async () => {
      root = create(<Tree />);
    });
    expect(system?.instanceCount).toBe(1);
    expect(r3f.frames.size).toBe(1);

    await act(async () => {
      for (const frame of r3f.frames) frame({}, 1 / 60);
      await Promise.resolve();
    });
    expect(renderer.submissions).toContain('NachiEmitterUpdate');

    renderer.uniformWrites.length = 0;
    await act(async () => {
      root.update(<Tree attached intensityValue={2} />);
    });
    expect(renderer.uniformWrites).toContainEqual({ path: 'User.intensity', value: 2 });
    expect(renderer.uniformWrites.some(({ path }) => path === 'Emitter.transform')).toBe(true);
    expect(system?.instanceCount).toBe(1);

    target.position.x = 7;
    renderer.uniformWrites.length = 0;
    await act(async () => {
      for (const frame of r3f.frames) frame({}, 1 / 60);
      await Promise.resolve();
    });
    expect(renderer.uniformWrites.some(({ path }) => path === 'Emitter.transform')).toBe(true);

    await act(async () => {
      root.update(<Tree visible={false} />);
    });
    expect(system?.instanceCount).toBe(0);
    expect(renderer.releaseCount).toBe(1);
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps the React tree mounted when spawn fails with immutable parameters', async () => {
    const rendererWithoutKernelAdapter = {} as VfxRuntimeRenderer;
    let observedState: string | undefined;
    let root: ReactTestRenderer;

    await act(async () => {
      root = create(
        <VFXSystemProvider renderer={rendererWithoutKernelAdapter} options={SYSTEM_OPTIONS}>
          <VFXEffect
            definition={immutableDefinition}
            onInstance={(instance) => {
              observedState = instance?.state;
            }}
          />
        </VFXSystemProvider>,
      );
    });

    expect(observedState).toBe('error');
    expect(root!.toJSON()).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it('notifies an inline onInstance callback only when the instance changes', async () => {
    const renderer = new FakeRuntimeRenderer();
    const observedInstances: unknown[] = [];

    function Tree({ tick }: { tick: number }) {
      return (
        <VFXSystemProvider renderer={renderer} options={SYSTEM_OPTIONS}>
          <VFXEffect
            definition={definition}
            onInstance={(instance) => {
              if (instance) observedInstances.push(instance);
            }}
          />
          <group name={String(tick)} />
        </VFXSystemProvider>
      );
    }

    let root: ReactTestRenderer;
    await act(async () => {
      root = create(<Tree tick={0} />);
    });
    await act(async () => {
      root.update(<Tree tick={1} />);
    });
    expect(observedInstances).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });
});
