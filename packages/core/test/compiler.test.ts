import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  attribute,
  bakeCurveLut,
  bakeGradientLut,
  billboard,
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
  faceCamera,
  flipbook,
  gradient,
  gravity,
  killVolume,
  KernelModuleRegistry,
  TURBULENCE_SIMPLEX_AMPLITUDE,
  linearForce,
  lifetime,
  meshRenderer,
  orientToVelocity,
  parameter,
  perDistance,
  pointAttractor,
  pcgRandomFloat,
  positionSphere,
  range,
  rate,
  resolveRandomSampleSlot,
  sizeOverLife,
  rotationOverLife,
  tslModule,
  turbulence,
  velocityOverLife,
  velocityCone,
  vectorField,
  vortex,
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
  setName(name?: string): KernelStorageNode {
    void name;
    return this;
  }
  toAtomic(): KernelStorageNode {
    return this;
  }
}

class CaptureNameStorage extends FakeStorage {
  constructor(private readonly names: string[]) {
    super();
  }

  override setName(name?: string): KernelStorageNode {
    if (name !== undefined) this.names.push(name);
    return this;
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
    sampleVectorField: (_field, position) => {
      markAccessRead(position);
      return node();
    },
    select: (_condition, whenTrue, whenFalse) => {
      markAccessRead(whenTrue);
      markAccessRead(whenFalse);
      return node();
    },
    simplexNoise: node,
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
    expect(program.meta.storageBufferCount).toBe(4);
    expect(program.meta.storageBuffers.slice(-2)).toEqual([
      {
        count: 1,
        name: 'NachiLifecycleIndirectArguments',
        purposes: ['spawn dispatch indirect arguments', 'draw indirect arguments'],
      },
      {
        count: 1,
        name: 'NachiLifecycleState',
        purposes: [
          'free/alive/success/overflow counters',
          'free-list indices',
          'compacted alive indices',
        ],
      },
    ]);
  });

  it('counts schema storage buffers and diagnoses a device stage-limit overflow', () => {
    const emitter = defineEmitter({
      attributes: Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => {
          const name = `custom${index}`;
          return [name, attribute(name, { default: [0, 0, 0, 0], type: 'vec4' })];
        }),
      ),
      capacity: 1,
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);

    expect(program.attributeSchema.storageArrays).toHaveLength(9);
    expect(program.meta.storageBufferCount).toBe(11);
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
        deviceLimits: { maxStorageBuffersPerShaderStage: 11 },
      }),
    ).not.toThrow();
  });

  it('keeps five minimum attributes plus two lifecycle buffers within the WebGPU limit', () => {
    const initializeMinimum = tslModule(
      ({ position, velocity, lifetime }) => ({ lifetime, position, velocity }),
      { stage: 'init' },
    );
    const program = compileEmitter(
      defineEmitter({
        capacity: 8,
        init: [initializeMinimum],
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.attributeSchema.storageArrays.map(({ attributes }) => attributes)).toEqual([
      ['position', 'velocity', 'lifetime'],
      ['alive', 'spawnGeneration'],
    ]);
    expect(program.meta.storageBufferCount).toBe(4);
    expect(program.meta.storageBuffers).toHaveLength(4);
    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        deviceLimits: { maxStorageBuffersPerShaderStage: 8 },
      }),
    ).not.toThrow();
  });

  it('keeps the playground M1 and M2 smoke emitters within their measured budgets', () => {
    const m1 = compileEmitter(
      defineEmitter({
        capacity: 64,
        init: [
          positionSphere({ radius: 0.2 }),
          velocityCone({ angle: 20, direction: [0, 1, 0], speed: range(2, 3) }),
          lifetime(2),
        ],
        render: computeRender,
        spawn: burst({ count: 64 }),
        update: [gravity(-9.8), colorOverLife(gradient('#ffffff', '#000000'))],
      }),
    );
    const m2Lifecycle = compileEmitter(
      defineEmitter({
        capacity: 64,
        init: [lifetime(10)],
        integration: 'none',
        render: computeRender,
        spawn: rate({ rate: 30 }),
      }),
    );
    const m2Time = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [velocityCone({ angle: 0, direction: [1, 0, 0], speed: 1 }), lifetime(10)],
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    );

    expect(m1.meta.storageBufferCount).toBe(5);
    expect(m2Lifecycle.meta.storageBufferCount).toBe(4);
    expect(m2Time.meta.storageBufferCount).toBe(4);
    for (const program of [m1, m2Lifecycle, m2Time]) {
      expect(
        program.attributeSchema.storageArrays.every(({ name }) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
        ),
      ).toBe(true);
    }
  });

  it('compiles billboard geometry, indirect alive indexing, and packing-aware vertex reads', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 32,
        init: [velocityCone({ angle: 0, direction: [0, 1, 0], speed: 2 }), lifetime(3)],
        integration: 'none',
        render: billboard({
          alignment: { factor: 1.5, mode: 'velocity-stretch' },
          blending: 'premultiplied',
        }),
        spawn: burst({ count: 8 }),
      }),
    );

    expect(program.draws).toEqual([
      expect.objectContaining({
        fragment: { blending: 'premultiplied' },
        geometry: {
          indexCount: 6,
          shape: 'quad',
          topology: 'triangle-list',
          vertexCount: 4,
        },
        indirect: expect.objectContaining({
          instanceCount: 'alive-count',
          physicalIndex: 'alive-indices',
        }),
        kind: 'billboard',
        vertex: expect.objectContaining({
          alignment: { factor: 1.5, mode: 'velocity-stretch' },
          attributes: ['position', 'size', 'color', 'spriteRotation', 'velocity'],
        }),
      }),
    ]);
    expect(program.meta.backendBudgets.webgpu.vertexStorageBufferCount).toBeLessThanOrEqual(8);
    expect(
      program.attributeSchema.storageArrays.every(({ name }) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      ),
    ).toBe(true);
    expect(
      program.meta.storageBuffers.find(({ name }) => name === 'Particles.packed_float'),
    ).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({ name: 'position', group: 0, offset: 0 }),
        expect.objectContaining({ name: 'size', offset: 1 }),
        expect.objectContaining({ name: 'velocity', group: 1, offset: 0 }),
      ]),
    });
  });

  it('compiles flipbook interpolation, motion vectors, cutout, and soft depth fade', () => {
    const atlas = { assetType: 'texture', kind: 'asset-ref', uri: 'atlas' } as const;
    const motion = { assetType: 'texture', kind: 'asset-ref', uri: 'motion' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        init: [lifetime(2)],
        render: billboard({
          cutout: { vertices: 6 },
          map: flipbook(atlas, { cols: 4, motionVectors: motion, rows: 2 }),
          soft: true,
        }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.diagnostics).toEqual([]);
    expect(program.draws[0]).toMatchObject({
      fragment: {
        flipbook: {
          cols: 4,
          interpolate: true,
          motionVectors: motion,
          progressAttribute: 'normalizedAge',
          rowOrder: 'top-left',
          rows: 2,
        },
        map: atlas,
        soft: { fadeDistance: 0.035 },
      },
      geometry: {
        indexCount: 12,
        shape: 'cutout',
        topology: 'triangle-list',
        vertexCount: 6,
      },
      vertex: { attributes: expect.arrayContaining(['normalizedAge']) },
    });
  });

  it('warns and uses plain interpolation when flipbook motion vectors lack a resource', () => {
    const atlas = { assetType: 'texture', kind: 'asset-ref', uri: 'atlas' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [lifetime(1)],
        render: billboard({ map: flipbook(atlas, { cols: 2, motionVectors: true, rows: 2 }) }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_FLIPBOOK_MOTION_VECTOR_FALLBACK',
        severity: 'warning',
      }),
    );
    const draw = program.draws[0];
    if (!draw || draw.kind !== 'billboard') throw new Error('Expected a billboard draw.');
    expect(draw.fragment.flipbook).not.toHaveProperty('motionVectors');
  });

  it('warns when motion vectors are combined with discrete flipbook playback', () => {
    const atlas = { assetType: 'texture', kind: 'asset-ref', uri: 'atlas' } as const;
    const motion = { assetType: 'texture', kind: 'asset-ref', uri: 'motion' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [lifetime(1)],
        render: billboard({
          map: flipbook(atlas, { cols: 2, interpolate: false, motionVectors: motion, rows: 2 }),
        }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_FLIPBOOK_MOTION_VECTORS_IGNORED',
        severity: 'warning',
      }),
    );
    const draw = program.draws[0];
    if (!draw || draw.kind !== 'billboard') throw new Error('Expected a billboard draw.');
    expect(draw.fragment.flipbook).not.toHaveProperty('motionVectors');
  });

  it('compiles configurable soft distance and diagnoses invalid values', () => {
    const valid = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ soft: { fadeDistance: 0.08 } }),
        spawn: burst({ count: 1 }),
      }),
    );
    const validDraw = valid.draws[0];
    if (!validDraw || validDraw.kind !== 'billboard') throw new Error('Expected billboard.');
    expect(validDraw.fragment.soft).toEqual({ fadeDistance: 0.08 });

    const invalid = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ soft: { fadeDistance: 0 } }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BILLBOARD_SOFT_DISTANCE_INVALID' }),
    );
  });

  it('compiles mesh particle draws with packed attributes and alive-index indirection', () => {
    const geometry = { assetType: 'geometry', kind: 'asset-ref', uri: 'debris' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 16,
        init: [velocityCone({ angle: 20, direction: [0, 1, 0], speed: 2 })],
        render: meshRenderer({
          alignment: { mode: 'velocity' },
          blending: 'alpha',
          geometry,
        }),
        spawn: burst({ count: 4 }),
      }),
    );

    expect(program.diagnostics).toEqual([]);
    expect(program.draws[0]).toMatchObject({
      fragment: { blending: 'alpha' },
      geometry: { resource: geometry, topology: 'triangle-list' },
      indirect: { instanceCount: 'alive-count', physicalIndex: 'alive-indices' },
      kind: 'mesh',
      vertex: {
        alignment: { mode: 'velocity' },
        attributes: expect.arrayContaining(['position', 'scale', 'color', 'velocity']),
      },
    });
    expect(program.meta.backendBudgets.webgpu.vertexStorageBufferCount).toBeLessThanOrEqual(8);
  });

  it('compiles each mesh orientation mode and diagnoses an invalid custom axis', () => {
    const geometry = { assetType: 'geometry', kind: 'asset-ref', uri: 'debris' } as const;
    const alignments = [
      { mode: 'none' as const },
      { mode: 'quaternion' as const },
      { axis: [1, 0, 0] as const, mode: 'custom-axis' as const },
    ];
    for (const alignment of alignments) {
      const program = compileEmitter(
        defineEmitter({
          capacity: 1,
          render: meshRenderer({ alignment, geometry }),
          spawn: burst({ count: 1 }),
        }),
      );
      expect(program.draws).toEqual([
        expect.objectContaining({ kind: 'mesh', vertex: expect.objectContaining({ alignment }) }),
      ]);
      expect(program.diagnostics).toEqual([]);
    }

    const invalid = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: meshRenderer({
          alignment: { axis: [0, 0, 0], mode: 'custom-axis' },
          geometry,
        }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_MESH_AXIS_INVALID' }),
    );
  });

  it('rejects more than one render module per emitter during M3', () => {
    const geometry = { assetType: 'geometry', kind: 'asset-ref', uri: 'debris' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: [billboard({}), meshRenderer({ geometry })],
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_RENDER_MODULE_LIMIT',
        path: 'render[1]',
        severity: 'error',
      }),
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('diagnoses invalid flipbook grids and cutout vertex counts', () => {
    const atlas = { assetType: 'texture', kind: 'asset-ref', uri: 'atlas' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [lifetime(1)],
        render: billboard({
          cutout: { vertices: 9 as 8 },
          map: flipbook(atlas, { cols: 0, rows: 1 }),
        }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NACHI_BILLBOARD_CUTOUT_VERTICES_INVALID' }),
        expect.objectContaining({ code: 'NACHI_FLIPBOOK_GRID_INVALID' }),
      ]),
    );
  });

  it('diagnoses invalid custom-axis and velocity-stretch billboard configurations', () => {
    const invalidAxis = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ alignment: { axis: [0, 0, 0], mode: 'custom-axis' } }),
        spawn: burst({ count: 1 }),
      }),
    );
    const invalidStretch = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ alignment: { factor: -1, mode: 'velocity-stretch' } }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(invalidAxis.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BILLBOARD_AXIS_INVALID' }),
    );
    expect(invalidStretch.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BILLBOARD_STRETCH_INVALID' }),
    );
  });

  it('materializes separate lifecycle state and indirect-argument buffers', () => {
    let indirectArrays = 0;
    let instancedArrays = 0;
    const adapter = fakeAdapter();
    const built = compileEmitter(baseEmitter()).buildKernels({
      ...adapter,
      indirectArray: () => {
        indirectArrays += 1;
        return Object.assign(new FakeStorage(), { indirectResource: {} });
      },
      instancedArray: () => {
        instancedArrays += 1;
        return new FakeStorage();
      },
    });

    expect(indirectArrays).toBe(1);
    expect(instancedArrays).toBe(3);
    expect(built.aliveCount).toBe(built.aliveIndices);
    expect(built.aliveCount).toBe(built.freeCount);
    expect(built.drawIndirect).toBe(built.spawnDispatch);
    expect(built.drawIndirect).not.toBe(built.aliveCount);
    expect(built.freeListOffset).toBeLessThan(built.aliveIndicesOffset);
    expect(built.drawIndirectOffsetBytes).toBe(3 * Uint32Array.BYTES_PER_ELEMENT);
  });

  it('uses WGSL identifiers for every materialized storage buffer name', () => {
    const names: string[] = [];
    const adapter = fakeAdapter();
    const program = compileEmitter(
      defineEmitter({
        attributes: {
          'custom-value': attribute('custom-value', {
            default: [0, 0, 0, 0],
            type: 'vec4',
          }),
          signed: attribute('signed', { default: 0, type: 'i32' }),
        },
        capacity: 1,
        render: billboard({}),
        spawn: burst({ count: 1 }),
      }),
    );

    program.buildKernels({
      ...adapter,
      indirectArray: () => Object.assign(new CaptureNameStorage(names), { indirectResource: {} }),
      instancedArray: () => new CaptureNameStorage(names),
    });

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(true);
    expect(names.some((name) => name.includes('-'))).toBe(false);
    expect(
      program.meta.storageBuffers.every(({ name }) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.replace(/^Particles\./, '')),
      ),
    ).toBe(true);
  });

  it('describes both lifecycle allocation sizes exactly in metadata', () => {
    const program = compileEmitter(baseEmitter());
    let materializedIndirectWords = 0;
    const materializedInstancedWords: number[] = [];
    program.buildKernels({
      ...fakeAdapter(),
      indirectArray: (values) => {
        materializedIndirectWords = values.length;
        return Object.assign(new FakeStorage(), { indirectResource: {} });
      },
      instancedArray: (length) => {
        materializedInstancedWords.push(length);
        return new FakeStorage();
      },
    });
    const { indirectArguments, state } = program.meta.lifecycleStorage.buffers;
    const indirectMetadataWords = Object.values(indirectArguments.fields).reduce(
      (sum, field) => sum + field.wordCount,
      0,
    );
    const stateMetadataWords = Object.values(state.fields).reduce(
      (sum, field) => sum + field.wordCount,
      0,
    );
    const metadataWords = indirectMetadataWords + stateMetadataWords;

    expect(indirectMetadataWords).toBe(8);
    expect(stateMetadataWords).toBe(20);
    expect(metadataWords).toBe(28);
    expect(indirectArguments.wordCount).toBe(indirectMetadataWords);
    expect(state.wordCount).toBe(stateMetadataWords);
    expect(program.meta.lifecycleStorage.wordCount).toBe(metadataWords);
    expect(materializedIndirectWords).toBe(indirectMetadataWords);
    expect(materializedInstancedWords.at(-1)).toBe(stateMetadataWords);
    expect(metadataWords * Uint32Array.BYTES_PER_ELEMENT).toBe(112);
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

  it('rejects WebGL2 burst lifecycle kernels that exceed the transform-feedback budget', () => {
    const program = compileEmitter(baseEmitter({ init: [lifetime(1)], integration: 'none' }));
    expect(program.meta.backendBudgets.webgl2).toMatchObject({
      defaultSpawnVaryingLimit: 4,
      spawnVaryingCount: 5,
    });

    let caught: unknown;
    try {
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
        deviceLimits: { maxTransformFeedbackSeparateAttribs: 4 },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VfxDiagnosticError);
    expect(caught instanceof VfxDiagnosticError ? caught.diagnostics : []).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
        path: 'meta.backendBudgets.webgl2.spawnVaryingCount',
      }),
    );
  });

  it('rejects a WebGL2 spawn varying with more than four components', () => {
    const program = compileEmitter(
      defineEmitter({
        attributes: {
          transform: attribute('transform', {
            default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            type: 'mat4',
          }),
        },
        capacity: 1,
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    );

    let caught: unknown;
    try {
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
        deviceLimits: { maxTransformFeedbackSeparateAttribs: 4 },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VfxDiagnosticError);
    expect(caught instanceof VfxDiagnosticError ? caught.diagnostics : []).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
        path: 'attributeSchema.byName.transform.components',
      }),
    );
  });

  it.each([
    ['multi-cycle burst', { spawn: burst({ count: 1, cycles: 2, interval: 0.1 }) }],
    [
      'looping burst',
      {
        lifecycle: { duration: 1, loopCount: 2 as const, startDelay: 0.1 },
        spawn: burst({ count: 1 }),
      },
    ],
    [
      'infinite burst loop',
      {
        lifecycle: { duration: 1, loopCount: 'infinite' as const },
        spawn: burst({ count: 1 }),
      },
    ],
  ])('rejects WebGL2 %s re-firing', (_name, overrides) => {
    const program = compileEmitter({ ...baseEmitter({ integration: 'none' }), ...overrides });

    let caught: unknown;
    try {
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VfxDiagnosticError);
    expect(caught instanceof VfxDiagnosticError ? caught.diagnostics : []).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED' }),
    );
  });

  it('rejects missing WebGPU lifecycle capabilities instead of silently falling back', () => {
    let caught: unknown;
    try {
      compileEmitter(baseEmitter()).buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgpu',
          indirectDispatch: true,
          indirectDraw: false,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VfxDiagnosticError);
    expect(caught instanceof VfxDiagnosticError ? caught.diagnostics : []).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BACKEND_CAPABILITY_MISSING',
        path: 'meta.capabilities.webgpu',
      }),
    );
  });

  it.each([
    ['rate', rate({ rate: 1 })],
    ['per-distance', perDistance({ rate: 1 })],
  ])('rejects %s spawning on WebGL2 during kernel materialization', (_name, spawn) => {
    const program = compileEmitter({ ...baseEmitter(), spawn });
    let caught: unknown;
    try {
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VfxDiagnosticError);
    expect(caught instanceof VfxDiagnosticError ? caught.diagnostics : []).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BACKEND_SPAWN_UNSUPPORTED',
        path: 'spawn[0]',
        phase: 'compile',
      }),
    );
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

  it.each([
    [
      'particle spawn generation from init',
      'init',
      'Particles.spawnGeneration',
      'init[0].access.writes[0]',
    ],
    [
      'spawn count from a custom spawn module',
      'spawn',
      'Emitter.spawnCount',
      'spawn[0].access.writes[0]',
    ],
    [
      'allocation metadata from a custom spawn module',
      'spawn',
      'Emitter.allocation.slot',
      'spawn[0].access.writes[0]',
    ],
    [
      'event queue state from update',
      'update',
      'Emitter.events.onDeath',
      'update[0].access.writes[0]',
    ],
  ] as const)('protects compiler-owned write: %s', (_name, stage, reference, path) => {
    const module: ModuleDefinition<typeof stage, object> = {
      access: { reads: [], writes: [reference] },
      config: {},
      kind: 'module',
      stage,
      type: `test/owned-${stage}`,
      version: 1,
    };
    const definition =
      stage === 'spawn'
        ? { ...baseEmitter(), spawn: module }
        : stage === 'init'
          ? { ...baseEmitter(), init: [module] }
          : { ...baseEmitter(), update: [module] };
    const program = compileEmitter(definition as ReturnType<typeof baseEmitter>);

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_COMPILER_OWNED_WRITE', path }),
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

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'diagnoses invalid burst count %s',
    (count) => {
      const program = compileEmitter({ ...baseEmitter(), spawn: burst({ count }) });
      expect(program.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'NACHI_BURST_COUNT_INVALID',
          path: 'spawn[0].config.count',
        }),
      );
    },
  );

  it('diagnoses a burst count parameter whose declaration is not a numeric scalar', () => {
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      parameters: {
        'User.count': defineParameter('User.count', {
          default: [1, 2, 3],
          type: 'vec3',
        }),
      },
      render: computeRender,
      spawn: burst({ count: parameter('User.count', 1) }),
    });
    const program = compileEmitter(emitter);

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BURST_COUNT_INVALID',
        path: 'spawn[0].config.count',
      }),
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

    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
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
        'Emitter.allocation.freeCount',
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

  it('rejects in-place mutation of logical attribute reads', () => {
    const access: ModuleAccess = {
      reads: ['Particles.velocity'],
      writes: ['Particles.velocity'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access,
      build(context) {
        context.attribute('velocity').addAssign(1);
      },
      stage: 'update',
      type: 'test/in-place-mutation',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/in-place-mutation',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      registry,
    });

    expect(() => program.buildKernels(fakeAdapter())).toThrow(
      'Attribute "velocity" is read-only in KernelModuleBuildContext; use context.write().',
    );
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
        vortex({ axis: [0, 1, 0], strength: 2 }),
        pointAttractor({ position: [0, 0, 0], strength: 1 }),
        linearForce({ force: [1, 0, 0] }),
        turbulence({ frequency: 0.5, octaves: 2, strength: 1 }),
        vectorField({
          field: { assetType: 'vector-field', kind: 'asset-ref', uri: 'field.fga' },
          strength: 1,
        }),
        orientToVelocity(),
        sizeOverLife(curve([0, 0], [1, 1])),
        rotationOverLife(curve([0, 0], [1, Math.PI])),
        velocityOverLife(curve([0, 1], [1, 0])),
        killVolume({ mode: 'inside', radius: 0.1, shape: 'sphere' }),
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
      'core/kill-volume': killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }).access,
      'core/linear-force': linearForce({ force: [1, 2, 3] }).access,
      'core/orient-to-velocity': orientToVelocity().access,
      'core/lifetime': lifetime(1).access,
      'core/point-attractor': pointAttractor({ position: [0, 0, 0], strength: 1 }).access,
      'core/position-sphere': positionSphere({ radius: 1 }).access,
      'core/rotation-over-life': rotationOverLife(curve([0, 0], [1, 1])).access,
      'core/size-over-life': sizeOverLife(curve([0, 0], [1, 1])).access,
      'core/turbulence': turbulence({ frequency: 1, strength: 1 }).access,
      'core/velocity-over-life': velocityOverLife(curve([0, 1], [1, 0])).access,
      'core/vector-field': vectorField({
        field: { assetType: 'vector-field', kind: 'asset-ref', uri: 'field.fga' },
        strength: 1,
      }).access,
      'core/velocity-cone': velocityCone({ angle: 30, direction: [0, 1, 0], speed: 1 }).access,
      'core/vortex': vortex({ axis: [0, 1, 0], strength: 1 }).access,
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
      ['core/vortex', { axis: [0, 1, 0], center: [0, 0, 0], strength: 1 }],
      ['core/point-attractor', { falloff: 2, position: [0, 0, 0], strength: 1 }],
      ['core/linear-force', { force: [1, 2, 3] }],
      ['core/turbulence', { frequency: 1, octaves: 3, strength: 0.2 }],
      [
        'core/vector-field',
        {
          field: { assetType: 'vector-field', kind: 'asset-ref', uri: 'field.fga' },
          strength: 1,
        },
      ],
      ['core/orient-to-velocity', {}],
      ['core/size-over-life', { value: curve([0, 0], [1, 1]) }, 'size-lut'],
      ['core/rotation-over-life', { value: curve([0, 0], [1, 1]) }, 'rotation-lut'],
      ['core/velocity-over-life', { value: curve([0, 1], [1, 0]) }, 'velocity-lut'],
      ['core/kill-volume', { mode: 'inside', radius: 1, shape: 'sphere' }],
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

  it.each([
    [vortex({ axis: [0, 1, 0], strength: 2 }), 'core/vortex', 'Particles.velocity'],
    [
      pointAttractor({ position: [0, 0, 0], strength: -2 }),
      'core/point-attractor',
      'Particles.velocity',
    ],
    [linearForce({ force: [1, 2, 3] }), 'core/linear-force', 'Particles.velocity'],
    [turbulence({ frequency: 2, strength: 3 }), 'core/turbulence', 'Particles.velocity'],
    [
      rotationOverLife(curve([0, 0], [1, 1])),
      'core/rotation-over-life',
      'Particles.spriteRotation',
    ],
    [velocityOverLife(curve([0, 1], [1, 0])), 'core/velocity-over-life', 'Particles.velocity'],
    [
      killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }),
      'core/kill-volume',
      'Particles.alive',
    ],
  ] as const)('declares the %s authoring manifest', (module, type, write) => {
    expect(module).toMatchObject({ kind: 'module', stage: 'update', type, version: 1 });
    expect(module.access?.writes).toContain(write);
  });

  it.each([
    killVolume({ center: [1, 2, 3], mode: 'inside', radius: 2, shape: 'sphere' }),
    killVolume({ center: [1, 2, 3], mode: 'outside', shape: 'box', size: [2, 4, 6] }),
    killVolume({ mode: 'inside', normal: [0, 1, 0], offset: 2, shape: 'plane' }),
  ])('compiles a kill-volume shape through the free-list death attribute', (module) => {
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }));
    expect(program.diagnostics).toEqual([]);
    expect(program.attributeSchema.byName.alive).toBeDefined();
  });

  it.each([
    linearForce({ force: parameter('User.force', [1, 2, 3] as [number, number, number]) }),
    pointAttractor({
      position: parameter('User.target', [0, 0, 0] as [number, number, number]),
      strength: 1,
    }),
    vortex({
      axis: [0, 1, 0],
      center: parameter('User.center', [0, 0, 0] as [number, number, number]),
      strength: 1,
    }),
  ])('derives nested parameter reads for an M4 force helper', (module) => {
    expect(module.access?.reads.some((path) => path.startsWith('User.'))).toBe(true);
  });

  it.each([
    rotationOverLife(curve([0, 0], [1, Math.PI])),
    velocityOverLife(curve([0, 1], [1, 0.5])),
    sizeOverLife(curve([0, 0], [1, 2])),
  ])('bakes an over-life module to the shared curve LUT path', (module) => {
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }));
    expect(program.diagnostics).toEqual([]);
    expect(program.luts).toHaveLength(1);
    expect(program.luts[0]).toMatchObject({ channels: 1, kind: 'curve', width: 256 });
  });

  it('preserves all M4 author update modules in observable order', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          vortex({ axis: [0, 1, 0], strength: 1 }),
          pointAttractor({ position: [0, 0, 0], strength: 1 }),
          linearForce({ force: [1, 0, 0] }),
          turbulence({ frequency: 1, strength: 1 }),
          rotationOverLife(curve([0, 0], [1, 1])),
          velocityOverLife(curve([0, 1], [1, 0])),
          killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }),
        ],
      }),
    );
    expect(program.kernels.update.modules.map(({ type }) => type)).toEqual([
      'core/vortex',
      'core/point-attractor',
      'core/linear-force',
      'core/turbulence',
      'core/rotation-over-life',
      'core/velocity-over-life',
      'core/kill-volume',
    ]);
  });

  it('keeps turbulence deterministic by avoiding random-stream manifest inputs', () => {
    const module = turbulence({ frequency: 1, octaves: 4, strength: 1 });
    expect(module.access?.reads).not.toContain('Emitter.seed');
    expect(module.access?.reads).not.toContain('Particles.spawnGeneration');
    expect(module.access?.reads).toContain('Particles.position');
  });

  it('supports an optional inward acceleration in the vortex config', () => {
    expect(vortex({ axis: [0, 1, 0], inwardStrength: 0.5, strength: 2 }).config).toEqual({
      axis: [0, 1, 0],
      inwardStrength: 0.5,
      strength: 2,
    });
  });

  it('encodes positive attraction and negative repulsion without changing the manifest', () => {
    const attraction = pointAttractor({ position: [0, 0, 0], strength: 2 });
    const repulsion = pointAttractor({ position: [0, 0, 0], strength: -2 });
    expect(attraction.access).toEqual(repulsion.access);
    expect(attraction.config).toMatchObject({ strength: 2 });
    expect(repulsion.config).toMatchObject({ strength: -2 });
  });

  it('serializes emitter-space vortex coordinates without changing the stable module type', () => {
    expect(
      vortex({ axis: [0, 1, 0], center: [1, 2, 3], space: 'emitter', strength: 2 }),
    ).toMatchObject({
      config: { center: [1, 2, 3], space: 'emitter' },
      type: 'core/vortex',
    });
  });

  it('serializes emitter-space point attractors and declares transform access', () => {
    const module = pointAttractor({ position: [0, 0, 0], space: 'emitter', strength: 1 });
    expect(module.config).toMatchObject({ space: 'emitter' });
    expect(module.access?.reads).toContain('Emitter.transform');
  });

  it('uses the measured simplex amplitude correction constant', () => {
    expect(TURBULENCE_SIMPLEX_AMPLITUDE).toBe(0.286);
  });

  it('creates a serializable vector-field reference module', () => {
    const field = { assetType: 'vector-field', kind: 'asset-ref', uri: 'wind.fga' } as const;
    expect(vectorField({ field, strength: 3, tiling: true })).toMatchObject({
      config: { field, strength: 3, tiling: true },
      stage: 'update',
      type: 'core/vector-field',
    });
  });

  it('makes camera-facing billboard alignment explicit without a simulation module', () => {
    const module = faceCamera({ blending: 'additive' });
    expect(module).toMatchObject({
      config: { alignment: { mode: 'camera-facing' }, blending: 'additive' },
      stage: 'render',
      type: 'core/billboard',
    });
  });

  it('declares both orientation outputs and zero-speed preservation reads', () => {
    expect(orientToVelocity().access).toEqual({
      reads: ['Particles.rotation', 'Particles.spriteRotation', 'Particles.velocity'],
      writes: ['Particles.rotation', 'Particles.spriteRotation'],
    });
  });
});
