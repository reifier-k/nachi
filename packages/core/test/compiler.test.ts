import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  attribute,
  bakeCurveLut,
  bakeGradientLut,
  burst,
  colorOverLife,
  compileEmitter,
  coreModuleImplementationAccess,
  createCoreKernelModuleRegistry,
  curve,
  curlNoise,
  defineEmitter,
  defineParameter,
  drag,
  gradient,
  gravity,
  KernelModuleRegistry,
  lifetime,
  parameter,
  perDistance,
  pcgRandomFloat,
  positionSphere,
  range,
  rate,
  resolveRandomSampleSlot,
  sizeOverLife,
  tslModule,
  velocityCone,
} from '../src/index.js';
import type {
  CompiledKernelModule,
  CurveGenerator,
  GradientGenerator,
  KernelComputeBuilder,
  KernelComputeNode,
  KernelNode,
  KernelNodeInput,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  KernelModuleBuildContext,
  KernelModuleImplementation,
  ModuleAccess,
  ModuleDefinition,
  TslModuleFactory,
  TslParticleBindings,
} from '../src/index.js';

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  stage: 'render',
  type: 'test/compute-only-render',
  version: 1,
};

class FakeNode implements KernelUniformNode {
  value: unknown;

  constructor(value: unknown = 0) {
    this.value = value;
  }

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

class RejectParticleOffsetNode extends FakeNode {
  override add(): KernelNode {
    throw new Error('Random sample offset touched the particle-index axis.');
  }
}

class CaptureBitXorNode extends FakeNode {
  constructor(readonly numericBitXors: number[]) {
    super();
  }

  override bitXor(value?: KernelNodeInput): KernelNode {
    if (typeof value === 'number') this.numericBitXors.push(value);
    return this;
  }
}

class FakeCompute implements KernelComputeBuilder, KernelComputeNode {
  compute(): KernelComputeNode {
    return this;
  }
  computeKernel(): KernelComputeNode {
    return this;
  }
  setName(): KernelComputeNode {
    return this;
  }
}

type ImplementationAccessTrace = {
  readonly reads: Set<string>;
  readonly writes: Set<string>;
};

class AccessTraceNode extends FakeNode {
  constructor(
    readonly trace: ImplementationAccessTrace,
    readonly path: string,
  ) {
    super();
  }

  readonly #read = (): void => {
    this.trace.reads.add(this.path);
  };

  readonly #write = (): void => {
    this.trace.writes.add(this.path);
  };

  override get r(): KernelNode {
    this.#read();
    return new FakeNode();
  }
  override get x(): KernelNode {
    this.#read();
    return new FakeNode();
  }
  override get y(): KernelNode {
    this.#read();
    return new FakeNode();
  }
  override get z(): KernelNode {
    this.#read();
    return new FakeNode();
  }
  override add(value?: KernelNodeInput): KernelNode {
    this.#read();
    markAccessRead(value);
    return this;
  }
  override addAssign(value?: KernelNodeInput): KernelNode {
    this.#read();
    this.#write();
    markAccessRead(value);
    return new FakeNode();
  }
  override assign(value?: KernelNodeInput): KernelNode {
    this.#write();
    markAccessRead(value);
    return new FakeNode();
  }
  override div(value?: KernelNodeInput): KernelNode {
    this.#read();
    markAccessRead(value);
    return this;
  }
  override mul(value?: KernelNodeInput): KernelNode {
    this.#read();
    markAccessRead(value);
    return new FakeNode();
  }
  override mulAssign(value?: KernelNodeInput): KernelNode {
    this.#read();
    this.#write();
    markAccessRead(value);
    return new FakeNode();
  }
}

function markAccessRead(value: unknown): void {
  if (value instanceof AccessTraceNode) value.trace.reads.add(value.path);
}

function traceCoreImplementation(
  type: string,
  config: object,
  lutId?: string,
): { reads: string[]; writes: string[] } {
  const implementation = createCoreKernelModuleRegistry().resolve(type, 1);
  if (!implementation || implementation.stage === 'spawn') {
    throw new Error(`Missing core implementation ${type}.`);
  }
  const trace: ImplementationAccessTrace = { reads: new Set(), writes: new Set() };
  const module: CompiledKernelModule = {
    access: implementation.access,
    config,
    ...(lutId === undefined ? {} : { lutId }),
    path: 'trace[0]',
    slot: 0,
    source: 'author',
    stage: implementation.stage,
    stageIndex: 0,
    type,
    version: 1,
  };
  const node = (path: string) => new AccessTraceNode(trace, path);
  const context: KernelModuleBuildContext = {
    adapter: fakeAdapter(),
    module,
    attribute: (name) => node(`Particles.${name}`),
    random: () => {
      trace.reads.add('Emitter.seed');
      trace.reads.add('Particles.spawnGeneration');
      return new FakeNode();
    },
    sampleLut: (_id, coordinate) => {
      markAccessRead(coordinate);
      return new FakeNode();
    },
    uniform: (path) => {
      trace.reads.add(path);
      return node(path);
    },
    value: () => new FakeNode(),
    write: (name, value) => {
      trace.writes.add(`Particles.${name}`);
      markAccessRead(value);
    },
  };
  implementation.build(context);
  return { reads: [...trace.reads].sort(), writes: [...trace.writes].sort() };
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

function baseEmitter(
  options: {
    readonly init?: readonly ModuleDefinition<'init', object>[];
    readonly integration?: 'euler' | 'none';
    readonly update?: readonly ModuleDefinition<'update', object>[];
  } = {},
) {
  return defineEmitter({
    ...(options.init === undefined ? {} : { init: options.init }),
    ...(options.integration === undefined ? {} : { integration: options.integration }),
    ...(options.update === undefined ? {} : { update: options.update }),
    capacity: 8,
    render: computeRender,
    spawn: burst({ count: 8 }),
  });
}

describe('emitter kernel compiler', () => {
  it('preserves author order and appends the compiler-owned integrator', () => {
    const program = compileEmitter(
      baseEmitter({ update: [gravity(-9.8), drag(0.2), sizeOverLife(curve([0, 0], [1, 1]))] }),
    );

    expect(program.kernels.update.modules.map(({ type }) => type)).toEqual([
      'core/gravity',
      'core/drag',
      'core/size-over-life',
      'core/integrate',
    ]);
    expect(program.kernels.update.modules.at(-1)).toMatchObject({
      label: '$integrate',
      path: 'update[$integrate]',
      source: 'compiler',
    });
    expect(program.kernels.init.modules[0]).toMatchObject({
      access: {
        reads: [],
        writes: program.attributeSchema.attributes
          .filter(({ name }) => name !== 'alive' && name !== 'spawnGeneration')
          .map(({ path }) => path),
      },
      label: '$defaults',
      source: 'compiler',
      type: 'core/defaults',
    });
  });

  it('omits integration when integration is none', () => {
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [gravity(-9.8)] }));
    expect(program.kernels.update.modules.map(({ type }) => type)).toEqual(['core/gravity']);
  });

  it('diagnoses an author position writer when compiler integration is enabled', () => {
    const customIntegrator = tslModule(({ position }) => ({ position }));
    const program = compileEmitter(baseEmitter({ update: [customIntegrator] }));

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_INTEGRATION_DOUBLE_APPLY',
        path: 'update[0].access.writes',
        severity: 'error',
      }),
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('revalidates reserved and duplicate labels when compileEmitter is called directly', () => {
    const direct = {
      ...baseEmitter({ integration: 'none' }),
      update: [
        { ...gravity(-9.8), label: '$integrate' },
        { ...drag(0.1), label: 'duplicate' },
        { ...gravity(-1), label: 'duplicate' },
      ],
    };
    const program = compileEmitter(direct);

    expect(program.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_MODULE_RESERVED_LABEL',
      'NACHI_MODULE_DUPLICATE_LABEL',
    ]);
  });

  it('emits a stable kernel-description snapshot', () => {
    const program = compileEmitter(
      baseEmitter({
        init: [
          positionSphere({ radius: 1 }),
          velocityCone({ angle: 30, direction: [0, 1, 0], speed: range(2, 4) }),
          lifetime(2),
        ],
        update: [gravity(-9.8), drag(0.1)],
      }),
    );

    expect({
      init: program.kernels.init.modules.map(({ source, type }) => ({ source, type })),
      update: program.kernels.update.modules.map(({ label, source, type }) => ({
        label: label ?? null,
        source,
        type,
      })),
      workgroupSize: program.kernels.init.workgroupSize,
    }).toMatchInlineSnapshot(`
      {
        "init": [
          {
            "source": "compiler",
            "type": "core/defaults",
          },
          {
            "source": "author",
            "type": "core/position-sphere",
          },
          {
            "source": "author",
            "type": "core/velocity-cone",
          },
          {
            "source": "author",
            "type": "core/lifetime",
          },
        ],
        "update": [
          {
            "label": "$age",
            "source": "compiler",
            "type": "core/age",
          },
          {
            "label": null,
            "source": "author",
            "type": "core/gravity",
          },
          {
            "label": null,
            "source": "author",
            "type": "core/drag",
          },
          {
            "label": "$integrate",
            "source": "compiler",
            "type": "core/integrate",
          },
        ],
        "workgroupSize": 64,
      }
    `);
    expect(program.kernels.update.modules[0]).toMatchObject({
      access: {
        reads: ['Emitter.deltaTime', 'Particles.age', 'Particles.lifetime'],
        writes: ['Particles.age', 'Particles.normalizedAge'],
      },
      label: '$age',
      source: 'compiler',
      type: 'core/age',
    });
  });

  it('uses labels before normalized stage indexes for module slots', () => {
    const labeled = { ...gravity(-9.8), label: 'stable-gravity' };
    const first = compileEmitter(baseEmitter({ update: [labeled] }));
    const moved = compileEmitter(baseEmitter({ update: [drag(0.1), labeled] }));
    const firstSlot = first.meta.moduleSlots.find(({ type }) => type === 'core/gravity')?.slot;
    const movedSlot = moved.meta.moduleSlots.find(({ type }) => type === 'core/gravity')?.slot;

    expect(firstSlot).toBe(movedSlot);
    expect(first.meta.moduleSlots.find(({ type }) => type === 'core/drag')).toBeUndefined();
    expect(moved.meta.moduleSlots.find(({ type }) => type === 'core/drag')?.stageIndex).toBe(0);
  });

  it('gives equal init/update indexes distinct deterministic range values', () => {
    const program = compileEmitter(
      baseEmitter({
        init: [lifetime(range(1, 2))],
        integration: 'none',
        update: [gravity(range(1, 2))],
      }),
    );
    const lifetimeSlot = program.meta.moduleSlots.find(
      ({ type }) => type === 'core/lifetime',
    )?.slot;
    const gravitySlot = program.meta.moduleSlots.find(({ type }) => type === 'core/gravity')?.slot;

    expect(lifetimeSlot).toBeDefined();
    expect(gravitySlot).toBeDefined();
    expect(lifetimeSlot).not.toBe(gravitySlot);
    expect(pcgRandomFloat(0, 42, resolveRandomSampleSlot(lifetimeSlot!, 0), 0)).not.toBe(
      pcgRandomFloat(0, 42, resolveRandomSampleSlot(gravitySlot!, 0), 0),
    );
  });

  it('samples every vector range component from an independent stream', () => {
    const emitter = defineEmitter({
      attributes: {
        direction: attribute('direction', {
          default: range([0, 0, 0] as const, [1, 1, 1] as const),
          type: 'vec3',
        }),
      },
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);
    const numericBitXors: number[] = [];
    const capture = () => new CaptureBitXorNode(numericBitXors);

    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        instanceIndex: capture(),
        uint: capture,
      }),
    ).not.toThrow();
    // The legacy all-slots Init kernel and the M2 free-list Spawn kernel build the same streams.
    expect(numericBitXors).toHaveLength(6);
    expect(new Set(numericBitXors).size).toBe(3);
  });

  it('derives deterministic random uniform reads from nested range generators', () => {
    const program = compileEmitter(
      baseEmitter({
        init: [velocityCone({ angle: 30, direction: [0, 1, 0], speed: range(2, 4) })],
        integration: 'none',
      }),
    );
    expect(
      program.kernels.init.modules.find(({ type }) => type === 'core/velocity-cone')?.access.reads,
    ).toEqual(['Emitter.seed', 'Particles.spawnGeneration']);
  });

  it('resolves integration attributes and carries built-in defaults', () => {
    const program = compileEmitter(baseEmitter());
    expect(program.attributeSchema.attributes.map(({ name }) => name)).toEqual([
      'position',
      'velocity',
      'alive',
      'spawnGeneration',
    ]);
    expect(program.attributeSchema.byName.position?.default).toEqual([0, 0, 0]);
    expect(program.attributeSchema.byName.velocity?.default).toEqual([0, 0, 0]);
    expect(program.meta.storageBufferCount).toBe(6);
  });

  it('counts schema storage buffers and diagnoses a device stage-limit overflow', () => {
    const emitter = defineEmitter({
      attributes: Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => {
          const name = `custom${index}`;
          return [name, attribute(name, { default: 0, type: 'f32' })];
        }),
      ),
      capacity: 1,
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);

    expect(program.attributeSchema.storageArrays).toHaveLength(11);
    expect(program.meta.storageBufferCount).toBe(13);
    let buildError: unknown;
    try {
      program.buildKernels({
        ...fakeAdapter(),
        deviceLimits: { maxStorageBuffersPerShaderStage: 8 },
      });
    } catch (error) {
      buildError = error;
    }
    expect(buildError).toBeInstanceOf(VfxDiagnosticError);
    expect(buildError instanceof VfxDiagnosticError ? buildError.diagnostics : []).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_STORAGE_BUFFER_LIMIT',
        path: 'meta.storageBufferCount',
        phase: 'compile',
        severity: 'error',
      }),
    );
    expect(program.diagnostics.map(({ code }) => code)).not.toContain('NACHI_STORAGE_BUFFER_LIMIT');
    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        deviceLimits: { maxStorageBuffersPerShaderStage: 13 },
      }),
    ).not.toThrow();
  });

  it('compiles burst, rate, and per-distance through the unified registry', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 8,
        integration: 'none',
        render: computeRender,
        spawn: [burst({ count: 2 }), rate({ rate: 3 }), perDistance({ rate: 4 })],
      }),
    );

    expect(program.spawn.modules.map(({ type }) => type)).toEqual([
      'core/burst',
      'core/rate',
      'core/per-distance',
    ]);
    expect(program.diagnostics).toEqual([]);
  });

  it('publishes explicit WebGPU and WebGL2 lifecycle capability paths', () => {
    expect(compileEmitter(baseEmitter()).meta.capabilities).toEqual({
      webgl2: {
        aliveCount: 'cpu-readback',
        allocation: 'prefix-cpu-fallback',
        indirectDraw: false,
      },
      webgpu: {
        aliveCount: 'atomic-compaction',
        allocation: 'atomic-free-list',
        indirectDraw: true,
      },
    });
  });

  it('materializes WebGL2 without atomic or indirect lifecycle nodes', () => {
    const unsupported = () => {
      throw new Error('unsupported WebGL2 operation was materialized');
    };
    const built = compileEmitter(baseEmitter()).buildKernels({
      ...fakeAdapter(),
      atomicAdd: unsupported,
      atomicLoad: unsupported,
      atomicStore: unsupported,
      capabilities: {
        atomics: false,
        backend: 'webgl2',
        indirectDispatch: false,
        indirectDraw: false,
      },
      indirectArray: unsupported,
    });

    expect(built.capabilityPath).toBe('webgl2-cpu-readback');
    expect(built.drawIndirect).toBeUndefined();
    expect(built.spawnDispatch).toBeUndefined();
  });

  it('rejects a spawn module that writes particle state', () => {
    const illegal = {
      ...burst({ count: 1 }),
      access: { reads: [], writes: ['Particles.alive'] },
    } as ModuleDefinition<'spawn', object>;
    const program = compileEmitter({ ...baseEmitter(), spawn: illegal });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_STAGE_WRITE_FORBIDDEN',
        path: 'spawn[0].access.writes[0]',
      }),
    );
  });

  it('rejects an init module that writes emitter state', () => {
    const illegal: ModuleDefinition<'init', object> = {
      access: { reads: [], writes: ['Emitter.age'] },
      config: {},
      kind: 'module',
      stage: 'init',
      type: 'test/illegal-init',
      version: 1,
    };
    const program = compileEmitter({ ...baseEmitter(), init: [illegal] });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_STAGE_WRITE_FORBIDDEN' }),
    );
  });

  it('rejects a render module that writes simulation state', () => {
    const illegalRender: ModuleDefinition<'render', object> = {
      access: { reads: [], writes: ['Particles.alive'] },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/illegal-render',
      version: 1,
    };
    const program = compileEmitter({ ...baseEmitter(), render: illegalRender });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_STAGE_WRITE_FORBIDDEN' }),
    );
  });

  it('diagnoses invalid rate spawn values', () => {
    const program = compileEmitter({ ...baseEmitter(), spawn: rate({ rate: -1 }) });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_RATE_INVALID', path: 'spawn[0].config.rate' }),
    );
  });

  it('diagnoses invalid per-distance spawn values', () => {
    const program = compileEmitter({ ...baseEmitter(), spawn: perDistance(Number.NaN) });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_RATE_INVALID' }),
    );
  });

  it('diagnoses non-positive burst cycle counts', () => {
    const program = compileEmitter({ ...baseEmitter(), spawn: burst({ count: 1, cycles: 0 }) });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BURST_CYCLES_INVALID' }),
    );
  });

  it('requires an interval for multi-cycle bursts', () => {
    const program = compileEmitter({ ...baseEmitter(), spawn: burst({ count: 1, cycles: 2 }) });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BURST_INTERVAL_REQUIRED' }),
    );
  });

  it('describes system, emitter, and declared user uniforms', () => {
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      parameters: {
        'User.intensity': defineParameter('User.intensity', { default: 1.5, type: 'f32' }),
      },
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter, { deltaTime: 0.25, emitterSeed: 42 });

    expect(
      Object.fromEntries(program.uniforms.map(({ default: value, path }) => [path, value])),
    ).toMatchObject({
      'Emitter.deltaTime': 0.25,
      'Emitter.seed': 42,
      'System.deltaTime': 0.25,
      'System.time': 0,
      'User.intensity': 1.5,
    });
  });

  it('materializes every logical uniform type with its shared TSL type', () => {
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      parameters: {
        'User.bool': defineParameter('User.bool', { default: true, type: 'bool' }),
        'User.color': defineParameter('User.color', {
          default: [1, 0.5, 0.25, 1],
          type: 'color',
        }),
        'User.f32': defineParameter('User.f32', { default: 1, type: 'f32' }),
        'User.i32': defineParameter('User.i32', { default: -1, type: 'i32' }),
        'User.mat3': defineParameter('User.mat3', {
          default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          type: 'mat3',
        }),
        'User.mat4': defineParameter('User.mat4', {
          default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          type: 'mat4',
        }),
        'User.quat': defineParameter('User.quat', {
          default: [0, 0, 0, 1],
          type: 'quat',
        }),
        'User.u32': defineParameter('User.u32', { default: 1, type: 'u32' }),
        'User.vec2': defineParameter('User.vec2', { default: [1, 2], type: 'vec2' }),
        'User.vec3': defineParameter('User.vec3', { default: [1, 2, 3], type: 'vec3' }),
        'User.vec4': defineParameter('User.vec4', { default: [1, 2, 3, 4], type: 'vec4' }),
      },
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);
    const userUniforms = program.uniforms.filter(({ path }) => path.startsWith('User.'));

    expect(
      Object.fromEntries(program.uniforms.map(({ path, tslType }) => [path, tslType])),
    ).toMatchObject({
      'Emitter.deltaTime': 'float',
      'Emitter.seed': 'uint',
      'Emitter.spawnGeneration': 'uint',
      'System.deltaTime': 'float',
      'System.time': 'float',
    });
    expect(Object.fromEntries(userUniforms.map(({ tslType, type }) => [type, tslType]))).toEqual({
      bool: 'uint',
      color: 'vec4',
      f32: 'float',
      i32: 'int',
      mat3: 'mat3',
      mat4: 'mat4',
      quat: 'vec4',
      u32: 'uint',
      vec2: 'vec2',
      vec3: 'vec3',
      vec4: 'vec4',
    });

    const materializedTypes: string[] = [];
    const adapter = fakeAdapter();
    expect(() =>
      program.buildKernels({
        ...adapter,
        uniform: (value, type) => {
          materializedTypes.push(type);
          return new FakeNode(value);
        },
      }),
    ).not.toThrow();
    expect(materializedTypes).toEqual(program.uniforms.map(({ tslType }) => tslType));
  });

  it('bakes a 256-sample linearly interpolated curve LUT', () => {
    const lut = bakeCurveLut(curve([0, 0], [0.5, 1], [1, 0]));
    expect(lut).toMatchObject({ channels: 1, kind: 'curve', width: 256 });
    expect(lut.data[0]).toBeCloseTo(0);
    expect(lut.data[128]).toBeCloseTo(0.996, 2);
    expect(lut.data[255]).toBeCloseTo(0);
  });

  it('bakes gradient colors into a 256-sample RGBA Float32 LUT', () => {
    const lut = bakeGradientLut(gradient('#000000', '#ff0000'));
    expect(lut).toMatchObject({ channels: 4, kind: 'gradient', width: 256 });
    expect([...lut.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    expect(lut.data[128 * 4]).toBeCloseTo(128 / 255);
    expect([...lut.data.slice(255 * 4, 256 * 4)]).toEqual([1, 0, 0, 1]);

    const srgbGray = bakeGradientLut(gradient('#808080', '#808080'));
    expect(srgbGray.data[0]).toBeCloseTo(0.2158605, 6);
    const linearGray = bakeGradientLut(gradient([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]));
    expect(linearGray.data[0]).toBeCloseTo(0.5, 6);
  });

  it('diagnoses underspecified curves/gradients and unsupported interpolation', () => {
    const oneKeyCurve = {
      keys: [{ time: 0, value: 1 }],
      kind: 'curve',
    } as CurveGenerator<number>;
    const constantCurve = {
      keys: [
        { interpolation: 'constant', time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
      kind: 'curve',
    } as CurveGenerator<number>;
    const oneStopGradient = {
      kind: 'gradient',
      stops: [{ color: '#fff', position: 0 }],
    } as GradientGenerator;
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          sizeOverLife(oneKeyCurve),
          sizeOverLife(constantCurve),
          colorOverLife(oneStopGradient),
        ],
      }),
    );

    expect(program.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_CURVE_POINT_COUNT_INVALID',
      'NACHI_CURVE_INTERPOLATION_UNSUPPORTED',
      'NACHI_GRADIENT_STOP_COUNT_INVALID',
    ]);
    expect(() => bakeCurveLut(constantCurve)).toThrow('not supported');
    expect(() => bakeGradientLut(oneStopGradient)).toThrow('at least two stops');
  });

  it('derives missing tslModule access from Proxy gets and returned keys', () => {
    type HeatBindings = TslParticleBindings<{ heat: number }>;
    const custom = tslModule<HeatBindings>((bindings) => {
      const position = bindings.position;
      const heat = bindings['custom.heat'];
      return { 'custom.heat': heat, velocity: position };
    });
    const emitter = defineEmitter({
      attributes: { heat: attribute('heat', { default: 0, type: 'f32' }) },
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: [custom],
    });
    const program = compileEmitter(emitter);

    expect(
      program.kernels.update.modules.find(({ type }) => type === 'core/tsl-module')?.access,
    ).toEqual({
      reads: ['Particles.position', 'Particles.heat'],
      writes: ['Particles.heat', 'Particles.velocity'],
    });
    expect(program.diagnostics).toEqual([]);
  });

  it('accepts traced access that is a subset of an explicit manifest', () => {
    const custom = tslModule(({ velocity }) => ({ velocity }), {
      access: {
        optionalReads: ['Particles.position'],
        reads: ['Particles.velocity'],
        writes: ['Particles.velocity'],
      },
    });
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [custom] }));
    expect(program.diagnostics).toEqual([]);
  });

  it('accumulates undeclared traced reads and writes', () => {
    const custom = tslModule(({ position }) => ({ velocity: position }), {
      access: { reads: [], writes: [] },
    });
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [custom] }));
    expect(program.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_TSL_UNDECLARED_READ',
      'NACHI_TSL_UNDECLARED_WRITE',
    ]);
  });

  it('keeps random sample offsets off the particle-index axis during TSL construction', () => {
    const program = compileEmitter(
      baseEmitter({ init: [positionSphere({ radius: 1 })], integration: 'none' }),
    );

    expect(() =>
      program.buildKernels({ ...fakeAdapter(), instanceIndex: new RejectParticleOffsetNode() }),
    ).not.toThrow();
  });

  it('diagnoses traced write keys that are absent from the attribute schema', () => {
    const factory = ((bindings: TslParticleBindings) => ({
      typo: bindings.position,
    })) as unknown as TslModuleFactory;
    const custom = tslModule(factory);
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [custom] }));
    expect(program.diagnostics.map(({ code }) => code)).toContain(
      'NACHI_ATTRIBUTE_UNKNOWN_REFERENCE',
    );
  });

  it('diagnoses an unregistered module and blocks materialization', () => {
    const unknown: ModuleDefinition<'update', Record<string, never>> = {
      access: { reads: [], writes: [] },
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'game/unknown',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [unknown] }));
    expect(program.diagnostics.map(({ code }) => code)).toEqual(['NACHI_MODULE_UNKNOWN']);
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('accepts every RFC-reserved Emitter path before M2 supplies its uniforms', () => {
    const access: ModuleAccess = {
      reads: [
        'Emitter.transform',
        'Emitter.localTime',
        'Emitter.deltaTime',
        'Emitter.age',
        'Emitter.loopIndex',
        'Emitter.seed',
        'Emitter.spawnGeneration',
        'Emitter.spawnCount',
        'Emitter.events.pending',
        'Emitter.events.onDeath',
        'Emitter.eventPayload.position',
      ],
      writes: [],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access,
      build() {},
      stage: 'update',
      type: 'test/reserved-emitter-paths',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/reserved-emitter-paths',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      registry,
    });

    expect(program.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_PARAMETER_UNKNOWN_REFERENCE',
    );
  });

  it('diagnoses parameter generators that target particle or unwired emitter paths', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          gravity(parameter('Particles.mass', 1)),
          gravity(parameter('Emitter.spawnCount', 1)),
        ],
      }),
    );

    expect(program.diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_PARAMETER_GENERATOR_UNSUPPORTED_TARGET',
        path: 'update[0].config.value.path',
      }),
      expect.objectContaining({
        code: 'NACHI_PARAMETER_GENERATOR_UNSUPPORTED_TARGET',
        path: 'update[1].config.value.path',
      }),
    ]);
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('keeps warnings non-blocking during kernel materialization', () => {
    const emitter = defineEmitter({
      attributes: { unused: attribute('unused', { default: 3, type: 'f32' }) },
      capacity: 1,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);

    expect(program.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_ATTRIBUTE_UNUSED', severity: 'warning' }),
    ]);
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('counts render and event access when checking unused custom attributes', () => {
    const render: ModuleDefinition<'render', Record<string, never>> = {
      access: { reads: ['Particles.renderHeat'], writes: [] },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/custom-render-reader',
      version: 1,
    };
    const event: ModuleDefinition<'event', Record<string, never>> = {
      access: { reads: ['Particles.eventHeat'], writes: [] },
      config: {},
      kind: 'module',
      stage: 'event',
      type: 'test/custom-event-reader',
      version: 1,
    };
    const emitter = defineEmitter({
      attributes: {
        eventHeat: attribute('eventHeat', { default: 0, type: 'f32' }),
        renderHeat: attribute('renderHeat', { default: 0, type: 'f32' }),
      },
      capacity: 1,
      events: { onDeath: event },
      integration: 'none',
      render,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);

    expect(program.diagnostics.map(({ code }) => code)).not.toContain('NACHI_ATTRIBUTE_UNUSED');
  });

  it('counts optionalReads when checking unused custom attributes', () => {
    const render: ModuleDefinition<'render', Record<string, never>> = {
      access: { optionalReads: ['Particles.optionalHeat'], reads: [], writes: [] },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/optional-custom-reader',
      version: 1,
    };
    const emitter = defineEmitter({
      attributes: { optionalHeat: attribute('optionalHeat', { default: 0, type: 'f32' }) },
      capacity: 1,
      integration: 'none',
      render,
      spawn: burst({ count: 1 }),
    });

    expect(compileEmitter(emitter).diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_ATTRIBUTE_UNUSED',
    );
  });

  it('materializes the full north-star init/update set through the adapter boundary', () => {
    const emitter = defineEmitter({
      capacity: 4,
      init: [
        positionSphere({ radius: 1 }),
        velocityCone({ angle: 30, direction: [0, 1, 0], speed: range(2, 4) }),
        lifetime(2),
      ],
      render: computeRender,
      spawn: burst({ count: 4 }),
      update: [
        gravity(-9.8),
        drag(0.1),
        curlNoise({ frequency: 0.5, strength: 0.2 }),
        sizeOverLife(curve([0, 0], [1, 1])),
        colorOverLife(gradient('#000', '#fff')),
      ],
    });
    const program = compileEmitter(emitter);
    expect(program.diagnostics).toEqual([]);
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('keeps core implementation manifests aligned with authoring helpers', () => {
    const access = coreModuleImplementationAccess();
    const expected: Readonly<Record<string, ModuleAccess | undefined>> = {
      'core/age': {
        reads: ['Emitter.deltaTime', 'Particles.age', 'Particles.lifetime'],
        writes: ['Particles.age', 'Particles.normalizedAge'],
      },
      'core/color-over-life': colorOverLife(gradient('#000', '#fff')).access,
      'core/curl-noise': curlNoise({ frequency: 1, strength: 1 }).access,
      'core/drag': drag(1).access,
      'core/gravity': gravity(-9.8).access,
      'core/lifetime': lifetime(1).access,
      'core/position-sphere': positionSphere({ radius: 1 }).access,
      'core/size-over-life': sizeOverLife(curve([0, 0], [1, 1])).access,
      'core/velocity-cone': velocityCone({ angle: 30, direction: [0, 1, 0], speed: 1 }).access,
    };
    for (const [type, manifest] of Object.entries(expected)) expect(access[type]).toEqual(manifest);
  });

  it('allows idempotent registry registration but rejects replacement objects', () => {
    const implementation = {
      access: { reads: [], writes: [] },
      build() {},
      stage: 'update',
      type: 'test/identity',
      version: 1,
    } satisfies KernelModuleImplementation;
    const registry = new KernelModuleRegistry();

    expect(() => registry.register(implementation)).not.toThrow();
    expect(() => registry.register(implementation)).not.toThrow();
    expect(() => registry.register({ ...implementation })).toThrow(
      'Kernel module implementation test/identity@1 is already registered.',
    );
  });

  it('matches traced core implementation reads and writes to every registered manifest', () => {
    const cases: ReadonlyArray<readonly [string, object, string?]> = [
      ['core/age', {}],
      ['core/position-sphere', { radius: 1, surfaceOnly: false }],
      ['core/velocity-cone', { angle: 30, direction: [0, 1, 0], speed: 2 }],
      ['core/lifetime', { value: 2 }],
      ['core/gravity', { value: -9.8 }],
      ['core/drag', { value: 0.1 }],
      ['core/curl-noise', { frequency: 1, strength: 0.2 }],
      ['core/size-over-life', { value: curve([0, 0], [1, 1]) }, 'size-lut'],
      ['core/color-over-life', { value: gradient('#000', '#fff') }, 'color-lut'],
      ['core/integrate', {}],
    ];
    const registry = createCoreKernelModuleRegistry();

    for (const [type, config, lutId] of cases) {
      const access = registry.resolve(type, 1)?.access;
      expect(traceCoreImplementation(type, config, lutId), type).toEqual({
        reads: [...(access?.reads ?? [])].sort(),
        writes: [...(access?.writes ?? [])].sort(),
      });
    }
  });
});
