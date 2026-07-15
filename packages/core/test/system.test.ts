import { describe, expect, it, vi } from 'vitest';

import { nextEffectInstanceIdentity } from '../src/internal-instance-identity.js';

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
  boids,
  burst,
  compileEmitter,
  collidePlane,
  collideSceneDepth,
  crossesSpawnOrderWarningThreshold,
  decalRenderer,
  defineEffect,
  defineEmitter,
  defineGrid2D,
  defineGrid2DStageFunction,
  defineGrid3D,
  defineNeighborGrid,
  defineParameter,
  defineSimStage,
  emitTo,
  estimateSimulationCacheMemory,
  gridAdvect,
  gridBuoyancy,
  gridInject,
  grid3DAdvect,
  grid3DBuoyancy,
  grid3DInject,
  grid3DTslModule,
  gridPressureJacobi,
  gridTslModule,
  Grid2DStageRegistry,
  estimateGrid3DMemory,
  lifetime,
  killVolume,
  perDistance,
  positionSphere,
  packedComponentIndex,
  rate,
  range,
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

  it.each([
    [9, 10],
    [99, 100],
  ])('uses numeric instance creation order across the %i -> %i digit boundary', (earlier, later) => {
    const entries = [later, earlier].map((stableSequence) => ({
      stableKey: `nachi-effect-${stableSequence}/particles`,
      stableSequence,
      value: stableSequence,
      worldPosition: [0, 0, -2] as const,
    }));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    expect(sortEmittersBackToFront(entries, identity).map(({ value }) => value)).toEqual([
      earlier,
      later,
    ]);
  });

  it.each([
    ['a', 'b', 'c'],
    ['a', 'c', 'b'],
    ['b', 'a', 'c'],
    ['b', 'c', 'a'],
    ['c', 'a', 'b'],
    ['c', 'b', 'a'],
  ])('falls the whole mixed collection back to stable keys for input %j', (...inputKeys) => {
    const byKey = {
      a: { stableKey: 'a', stableSequence: 30, value: 'a', worldPosition: [0, 0, -2] as const },
      b: { stableKey: 'b', value: 'b', worldPosition: [0, 0, -2] as const },
      c: { stableKey: 'c', stableSequence: 10, value: 'c', worldPosition: [0, 0, -2] as const },
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const entries = inputKeys.map((key) => byKey[key as keyof typeof byKey]);

    expect(sortEmittersBackToFront(entries, identity).map(({ stableKey }) => stableKey)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('falls the whole collection back to stable keys for invalid sequence %s', (invalidSequence) => {
    const entries = [
      { stableKey: 'a', stableSequence: 30, value: 'a', worldPosition: [0, 0, -2] as const },
      {
        stableKey: 'b',
        stableSequence: invalidSequence,
        value: 'b',
        worldPosition: [0, 0, -2] as const,
      },
      { stableKey: 'c', stableSequence: 10, value: 'c', worldPosition: [0, 0, -2] as const },
    ];
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    expect(
      sortEmittersBackToFront(entries.reverse(), identity).map(({ stableKey }) => stableKey),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('internal effect instance identity allocation', () => {
  it('emits the final exact safe integer ID once and rejects exhaustion', () => {
    const penultimate = nextEffectInstanceIdentity(Number.MAX_SAFE_INTEGER - 2);
    const final = nextEffectInstanceIdentity(penultimate.sequence);

    expect(penultimate).toEqual({
      id: `nachi-effect-${Number.MAX_SAFE_INTEGER - 1}`,
      sequence: Number.MAX_SAFE_INTEGER - 1,
    });
    expect(final).toEqual({
      id: `nachi-effect-${Number.MAX_SAFE_INTEGER}`,
      sequence: Number.MAX_SAFE_INTEGER,
    });
    expect(Number.isSafeInteger(final.sequence)).toBe(true);
    expect(new Set([penultimate.id, final.id]).size).toBe(2);
    expect(() => nextEffectInstanceIdentity(final.sequence)).toThrowError(
      'VFXSystem instance creation sequence exhausted Number.MAX_SAFE_INTEGER.',
    );
  });
});

describe('M12 Grid2D runtime scheduling', () => {
  it('submits every stage iteration and commit on separate ordered boundaries', async () => {
    const renderer = new FakeRuntimeRenderer();
    const fluid = defineGrid2D({
      channels: {
        density: { type: 'f32' },
        velocity: { default: [0, 0], type: 'vec2' },
        pressure: { type: 'f32' },
      },
      resolution: [4, 3],
    });
    const effect = defineEffect({
      elements: {
        fluid,
        before: defineSimStage({
          phase: 'before-particles',
          target: 'fluid',
          update: gridAdvect(),
        }),
        after: defineSimStage({
          iterations: 2,
          target: 'fluid',
          update: gridPressureJacobi(),
        }),
        particles: defineEmitter({
          capacity: 1,
          integration: 'none',
          lifecycle: { duration: 1 },
          render: {
            access: { reads: [], writes: [] },
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
    const system = new VFXSystem(renderer);
    const instance = system.spawn(effect);

    await system.update(0.1);

    const stageSubmissions = renderer.submissions
      .map((name, index) => ({ index, name }))
      .filter(({ name }) => name === 'NachiGrid2DStage')
      .map(({ index }) => index);
    expect(stageSubmissions).toHaveLength(6);
    expect(stageSubmissions[0]!).toBeLessThan(
      renderer.submissions.indexOf('NachiEmitterInitialize'),
    );
    expect(renderer.submissions.indexOf('NachiEmitterInitialize')).toBeLessThan(
      stageSubmissions[1]!,
    );
    expect(stageSubmissions[3]!).toBeLessThan(
      renderer.submissions.lastIndexOf('NachiEmitterUpdate'),
    );
    expect(renderer.submissions.lastIndexOf('NachiEmitterUpdate')).toBeLessThan(
      stageSubmissions[4]!,
    );
    expect(instance.getGrid2D('fluid')?.submissionCount).toBe(13);
    expect(instance.state).toBe('active');
  });

  it('diagnoses a missing Grid2D target before GPU submission', () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(
      defineEffect({
        elements: {
          orphan: defineSimStage({ target: 'missing', update: gridAdvect() }),
        },
      }),
    );
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_SIM_STAGE_TARGET_UNKNOWN' }),
    ]);
    expect(renderer.submissions).toEqual([]);
  });

  it('uses an explicit WebGL2 unsupported diagnostic instead of a silent fallback', () => {
    const renderer = new WebGlGridRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(
      defineEffect({
        elements: {
          fluid: defineGrid2D({
            channels: { density: { type: 'f32' } },
            resolution: [4, 4],
          }),
        },
      }),
    );
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_WEBGL2_UNSUPPORTED' }),
    ]);
    expect(renderer.submissions).toEqual([]);
  });

  it('rejects a Grid2D storage binding above the device limit and accepts the boundary', () => {
    const fluid = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [64, 64],
    });
    const largestBuffer = 64 * 64 * 16;
    const exceeded = new VFXSystem(new StorageLimitGridRenderer(largestBuffer - 1)).spawn(
      defineEffect({ elements: { fluid } }),
    );
    expect(exceeded.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STORAGE_LIMIT_EXCEEDED' }),
    ]);
    const exact = new VFXSystem(new StorageLimitGridRenderer(largestBuffer)).spawn(
      defineEffect({ elements: { fluid } }),
    );
    expect(exact.state).toBe('active');
  });

  it('materializes and executes inline and registered custom stage factories', async () => {
    const inlineRenderer = new FakeRuntimeRenderer();
    const fluid = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3],
    });
    const inlineSystem = new VFXSystem(inlineRenderer);
    const inline = inlineSystem.spawn(
      defineEffect({
        elements: {
          fluid,
          update: defineSimStage({
            target: 'fluid',
            update: gridTslModule(({ read }) => ({ density: read('density') })),
          }),
        },
      }),
    );
    await inlineSystem.update(0.1);
    expect(inlineRenderer.submissions).toContain('NachiGrid2DStage');
    expect(inline.diagnostics).toEqual([]);

    const registered = defineGrid2DStageFunction('test/grid-copy', ({ read }) => ({
      density: read('density'),
    }));
    const registry = new Grid2DStageRegistry().register(registered);
    const registeredRenderer = new FakeRuntimeRenderer();
    const registeredSystem = new VFXSystem(registeredRenderer, undefined, {
      grid2DStageRegistry: registry,
    });
    const registeredInstance = registeredSystem.spawn(
      defineEffect({
        elements: {
          fluid,
          update: defineSimStage({ target: 'fluid', update: gridTslModule(registered) }),
        },
      }),
    );
    await registeredSystem.update(0.1);
    expect(registeredRenderer.submissions).toContain('NachiGrid2DStage');
    expect(registeredInstance.diagnostics).toEqual([]);
  });

  it('diagnoses both unresolved custom-stage function paths', () => {
    const fluid = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3],
    });
    const unresolved = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid,
          update: defineSimStage({
            target: 'fluid',
            update: gridTslModule({
              id: 'missing/grid-stage',
              kind: 'grid2d-function-ref',
              version: 1,
            }),
          }),
        },
      }),
    );
    expect(unresolved.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_FUNCTION_UNRESOLVED' }),
    ]);

    const missingInlineMetadata = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid,
          update: defineSimStage({
            target: 'fluid',
            update: {
              config: {},
              kind: 'grid2d-stage-module',
              source: 'inline',
              version: 1,
            },
          }),
        },
      }),
    );
    expect(missingInlineMetadata.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_FUNCTION_UNRESOLVED' }),
    ]);
  });

  it('diagnoses undeclared and component-mismatched custom stage results', () => {
    const scalarGrid = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3],
    });
    const typo = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid: scalarGrid,
          update: defineSimStage({
            target: 'fluid',
            update: gridTslModule(({ read }) => ({ denisty: read('density') })),
          }),
        },
      }),
    );
    expect(typo.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_WRITE_CHANNEL_UNDECLARED' }),
    ]);

    const vectorGrid = defineGrid2D({
      channels: { density: { type: 'f32' }, velocity: { type: 'vec2' } },
      resolution: [4, 3],
    });
    const mismatch = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid: vectorGrid,
          update: defineSimStage({
            target: 'fluid',
            update: gridTslModule(({ read }) => ({ velocity: read('density') })),
          }),
        },
      }),
    );
    expect(mismatch.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_WRITE_COMPONENTS_INVALID' }),
    ]);
  });

  it('diagnoses undeclared Grid2D and Grid3D channels before custom sample interpolation', () => {
    const density2D = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3],
    });
    const typo2D = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          density2D,
          update: defineSimStage({
            target: 'density2D',
            update: gridTslModule(({ index, sample }) => ({
              density: sample('unknown', [index, index]),
            })),
          }),
        },
      }),
    );
    expect(typo2D.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_CHANNEL_UNDECLARED' }),
    ]);

    const density3D = defineGrid3D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3, 2],
    });
    const typo3D = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          density3D,
          update: defineSimStage({
            target: 'density3D',
            update: grid3DTslModule(({ index, sample }) => ({
              density: sample('unknown', [index, index, index]),
            })),
          }),
        },
      }),
    );
    expect(typo3D.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID3D_STAGE_CHANNEL_UNDECLARED' }),
    ]);
  });

  it('validates built-in Grid2D/3D stage channel types, finite values, and source IDs', () => {
    expect(() => gridInject({ center: [0, 0], radius: -1, values: { density: 1 } })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_VALUE_INVALID' })],
      }),
    );
    expect(() =>
      grid3DInject({ center: [0, 0, 0], radius: -1, values: { density: 1 } }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_GRID3D_STAGE_VALUE_INVALID' })],
      }),
    );
    const fluid = defineGrid2D({
      channels: {
        density: { type: 'f32' },
        temperature: { type: 'f32' },
        velocity: { type: 'vec2' },
      },
      resolution: [2, 2],
    });
    const invalid2D = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid,
          inject: defineSimStage({
            target: 'fluid',
            update: gridInject({ center: [0, 0], radius: 1, values: { velocity: 1 as never } }),
          }),
          decay: defineSimStage({
            target: 'fluid',
            update: {
              ...gridAdvect(),
              config: { dissipation: { density: Number.NaN } },
            },
          }),
          buoyancy: defineSimStage({
            target: 'fluid',
            update: gridBuoyancy({ velocity: 'density' }),
          }),
          unknown: defineSimStage({
            target: 'fluid',
            update: { ...gridAdvect(), source: 'core/grid2d-typo' } as never,
          }),
        },
      }),
    );
    expect(invalid2D.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_GRID2D_STAGE_VALUE_INVALID',
        'NACHI_GRID2D_STAGE_CHANNEL_TYPE_INVALID',
        'NACHI_GRID2D_STAGE_SOURCE_UNKNOWN',
      ]),
    );

    const volume = defineGrid3D({
      channels: {
        density: { type: 'f32' },
        temperature: { type: 'f32' },
        velocity: { type: 'vec3' },
      },
      resolution: [2, 2, 2],
    });
    const invalid3D = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          volume,
          inject: defineSimStage({
            target: 'volume',
            update: grid3DInject({
              center: [0, 0, 0],
              radius: 1,
              values: { velocity: 1 as never },
            }),
          }),
          decay: defineSimStage({
            target: 'volume',
            update: {
              ...grid3DAdvect(),
              config: { dissipation: { density: Number.POSITIVE_INFINITY } },
            },
          }),
          buoyancy: defineSimStage({
            target: 'volume',
            update: grid3DBuoyancy({ temperature: 'velocity' }),
          }),
        },
      }),
    );
    expect(invalid3D.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_GRID3D_STAGE_VALUE_INVALID',
        'NACHI_GRID3D_STAGE_CHANNEL_TYPE_INVALID',
      ]),
    );
  });

  it('annotates v1 bakes that execute but do not record Grid2D state', async () => {
    const cache = await bakeSimulation(
      new VFXSystem(new CacheRuntimeRenderer()),
      defineEffect({
        elements: {
          fluid: defineGrid2D({
            channels: { density: { type: 'f32' } },
            resolution: [4, 3],
          }),
        },
      }),
      { frames: 1 },
    );
    expect(cache.diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_SIM_CACHE_GRID2D_NOT_RECORDED',
        severity: 'warning',
      }),
    ]);
  });

  it('rejects negative and non-finite particle rasterization values before upload', async () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid: defineGrid2D({
            channels: { density: { type: 'f32' } },
            resolution: [4, 3],
          }),
        },
      }),
    );
    const grid = instance.getGrid2D('fluid')!;
    await expect(grid.rasterizeParticles([], 'density', -1)).rejects.toThrow(RangeError);
    await expect(grid.rasterizeParticles([], 'density', Number.NaN)).rejects.toThrow(RangeError);
    await expect(grid.rasterizeParticles([], 'density', Number.POSITIVE_INFINITY)).rejects.toThrow(
      RangeError,
    );
    await expect(grid.rasterizeParticles([], 'density', 0x1_0000_0000 / 4096)).rejects.toThrow(
      RangeError,
    );
    await expect(grid.rasterizeParticles([[Number.NaN, 0]], 'density')).rejects.toThrow(RangeError);
    await expect(grid.sampleParticles([[0, Number.POSITIVE_INFINITY]], 'density')).rejects.toThrow(
      RangeError,
    );
  });

  it('reports missing Grid2D storage readback/upload as structured runtime diagnostics', async () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          fluid: defineGrid2D({
            channels: { density: { type: 'f32' } },
            resolution: [2, 2],
          }),
        },
      }),
    );
    const grid = instance.getGrid2D('fluid')!;
    await expect(grid.capture()).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_GRID2D_READBACK_UNSUPPORTED' })],
    });
    await expect(grid.rasterizeParticles([[0, 0]], 'density')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_GRID2D_UPLOAD_UNSUPPORTED' })],
    });
  });
});

describe('M12 Grid3D runtime diagnostics', () => {
  it('asserts custom-stage read, write, and component diagnostic codes', () => {
    const scalar = defineGrid3D({
      channels: { density: { type: 'f32' } },
      resolution: [3, 2, 2],
    });
    const spawnWith = (update: ReturnType<typeof grid3DTslModule>, volume = scalar) =>
      new VFXSystem(new FakeRuntimeRenderer()).spawn(
        defineEffect({
          elements: {
            volume,
            update: defineSimStage({ target: 'volume', update }),
          },
        }),
      );
    const read = spawnWith(grid3DTslModule(({ read }) => ({ density: read('unknown') })));
    const write = spawnWith(grid3DTslModule(({ read }) => ({ typo: read('density') })));
    const components = spawnWith(
      grid3DTslModule(({ read }) => ({ velocity: read('density') })),
      defineGrid3D({
        channels: { density: { type: 'f32' }, velocity: { type: 'vec3' } },
        resolution: [3, 2, 2],
      }),
    );
    expect(read.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_GRID3D_STAGE_CHANNEL_UNDECLARED' }),
    );
    expect(write.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_GRID3D_STAGE_WRITE_CHANNEL_UNDECLARED' }),
    );
    expect(components.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_GRID3D_STAGE_WRITE_COMPONENTS_INVALID' }),
    );
  });

  it('rejects a storage binding above the device limit and accepts the exact boundary', () => {
    const volume = defineGrid3D({
      channels: { density: { type: 'f32' } },
      resolution: [64, 64, 64],
    });
    const memory = estimateGrid3DMemory(volume);
    const largestBuffer = Math.max(memory.stateBufferBytes, memory.particlePositionBytes);

    const exceeded = new VFXSystem(new StorageLimitGridRenderer(largestBuffer - 1)).spawn(
      defineEffect({ elements: { volume } }),
    );
    expect(exceeded.diagnostics).toEqual([
      expect.objectContaining({ code: 'NACHI_GRID3D_STORAGE_LIMIT_EXCEEDED' }),
    ]);

    const exact = new VFXSystem(new StorageLimitGridRenderer(largestBuffer)).spawn(
      defineEffect({ elements: { volume } }),
    );
    expect(exact.state).toBe('active');
    expect(exact.diagnostics).toEqual([]);
  });

  it('aggregates definition and backend diagnostics before throwing', () => {
    const instance = new VFXSystem(new WebGlGridRenderer()).spawn(
      defineEffect({
        elements: {
          volume: defineGrid3D({ channels: {}, resolution: [0, 4, 4] }),
        },
      }),
    );
    expect(instance.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_GRID3D_RESOLUTION_INVALID',
      'NACHI_GRID3D_CHANNEL_INVALID',
      'NACHI_GRID3D_WEBGL2_UNSUPPORTED',
    ]);
  });

  it('rejects non-finite transfer points and a single fixed-point deposit above u32', async () => {
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          volume: defineGrid3D({
            channels: { density: { type: 'f32' } },
            resolution: [4, 3, 2],
          }),
        },
      }),
    );
    const grid = instance.getGrid3D('volume')!;
    await expect(grid.rasterizeParticles([], 'density', 0x1_0000_0000 / 4096)).rejects.toThrow(
      RangeError,
    );
    await expect(grid.rasterizeParticles([[0, Number.NaN, 0]], 'density')).rejects.toThrow(
      RangeError,
    );
    await expect(
      grid.sampleParticles([[0, 0, Number.NEGATIVE_INFINITY]], 'density'),
    ).rejects.toThrow(RangeError);
  });
});

describe('M12 data-interface capture FIFO', () => {
  it.each([
    'grid2d',
    'grid3d',
  ] as const)('serializes %s capture, rasterization, and sampling after an in-flight update', async (kind) => {
    const renderer = new DeferredSubmissionRenderer();
    const definition =
      kind === 'grid2d'
        ? defineEffect({
            elements: {
              grid: defineGrid2D({
                channels: { density: { type: 'f32' } },
                resolution: [3, 2],
              }),
            },
          })
        : defineEffect({
            elements: {
              grid: defineGrid3D({
                channels: { density: { type: 'f32' } },
                resolution: [3, 2, 2],
              }),
            },
          });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(definition as never);
    const grid = kind === 'grid2d' ? instance.getGrid2D('grid')! : instance.getGrid3D('grid')!;
    const update = system.update(0.1);
    await Promise.resolve();
    await Promise.resolve();
    const capture = grid.capture();
    const raster =
      kind === 'grid2d'
        ? (grid as Grid2DRuntimeView).rasterizeParticles([[0.25, 0.5]], 'density')
        : (grid as Grid3DRuntimeView).rasterizeParticles([[0.25, 0.5, 0.75]], 'density');
    const sample =
      kind === 'grid2d'
        ? (grid as Grid2DRuntimeView).sampleParticles([[0.25, 0.5]], 'density')
        : (grid as Grid3DRuntimeView).sampleParticles([[0.25, 0.5, 0.75]], 'density');
    expect(renderer.readCount).toBe(0);
    expect(renderer.writeCount).toBe(0);
    renderer.releaseFirstSubmission();
    await Promise.all([update, capture, raster, sample]);
    expect(renderer.readCount).toBe(2);
    expect(renderer.writeCount).toBe(2);
    expect(grid.initialized).toBe(true);
    instance.release();
    expect(grid.initialized).toBe(false);
  });

  it('captures one NeighborGrid rebuild after an in-flight update and resets on release', async () => {
    const renderer = new DeferredSubmissionRenderer();
    const neighbors = defineNeighborGrid({ cellCapacity: 2, resolution: [2, 2, 2] });
    const particles = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: {
        access: { reads: [], writes: [] },
        config: {},
        kind: 'module',
        stage: 'render',
        type: 'test/runtime-compute-only',
        version: 1,
      },
      spawn: burst({ count: 1 }),
      update: [boids({ grid: 'neighbors', radius: 0 })],
    });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(defineEffect({ elements: { neighbors, particles } }));
    expect(instance.state).toBe('active');
    const grid = instance.getNeighborGrid('neighbors')!;
    const update = system.update(0.1);
    for (let tick = 0; tick < 20 && renderer.submissions.length === 0; tick += 1) {
      await Promise.resolve();
    }
    const capture = grid.capture();
    expect(renderer.readCount).toBe(0);
    renderer.releaseFirstSubmission();
    await Promise.all([update, capture]);
    expect(renderer.readCount).toBe(3);
    expect(grid.initialized).toBe(true);
    instance.release();
    expect(grid.initialized).toBe(false);
  });

  it('reports missing NeighborGrid storage readback as a structured runtime diagnostic', async () => {
    const neighbors = defineNeighborGrid({ resolution: [2, 2, 2] });
    const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
      defineEffect({
        elements: {
          neighbors,
          particles: defineEmitter({
            capacity: 1,
            integration: 'none',
            render: computeRender,
            spawn: burst({ count: 0 }),
            update: [boids({ grid: 'neighbors', radius: 0 })],
          }),
        },
      }),
    );
    await expect(instance.getNeighborGrid('neighbors')!.capture()).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_NEIGHBOR_GRID_READBACK_UNSUPPORTED' })],
    });
  });

  it('reports dominant NeighborGrid out-of-bounds once per runtime lifetime and resets for pooled instances', async () => {
    const renderer = new NeighborGridDiagnosticRenderer();
    const delivered: string[] = [];
    const neighbors = defineNeighborGrid({
      cellCapacity: 1,
      cellSize: 0.5,
      origin: [-1, -2, -3],
      resolution: [2, 1, 1],
    });
    const particles = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 0 }),
      update: [boids({ grid: 'neighbors', radius: 0 })],
    });
    const effect = defineEffect({ elements: { neighbors, particles } });
    const system = new VFXSystem(renderer, undefined, {
      onRuntimeDiagnostic: (diagnostic) => delivered.push(diagnostic.code),
    });
    const first = system.spawn(effect);
    await system.update(0.1);

    const firstView = first.getNeighborGrid('neighbors')!;
    const [captureA, captureB] = await Promise.all([firstView.capture(), firstView.capture()]);
    for (const snapshot of [captureA, captureB]) {
      expect(snapshot.diagnostics.map(({ code }) => code)).toEqual([
        'NACHI_NEIGHBOR_GRID_CELL_OVERFLOW',
        'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      ]);
    }
    expect(
      first.diagnostics.filter(({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT'),
    ).toEqual([
      expect.objectContaining({
        path: 'elements.neighbors.origin',
        context: {
          emitterPath: 'elements.particles',
          kernel: 'neighbor-grid',
          neighborGrid: {
            cellCapacity: 1,
            cellSize: 0.5,
            inBounds: 2,
            key: 'neighbors',
            origin: [-1, -2, -3],
            outOfBounds: 3,
            outOfBoundsRatio: 0.6,
            resolution: [2, 1, 1],
            total: 5,
          },
        },
      }),
    ]);

    await system.update(0.1);
    await firstView.capture();
    expect(
      first.diagnostics.filter(({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT'),
    ).toHaveLength(1);
    expect(delivered).toEqual(['NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT']);

    renderer.counts = new Uint32Array([1, 0]);
    renderer.stats = new Uint32Array([0, 1]);
    await system.update(0.1);
    expect((await firstView.capture()).diagnostics).toEqual([]);
    renderer.counts = new Uint32Array([0, 0]);
    renderer.stats = new Uint32Array([0, 0]);
    await system.update(0.1);
    expect((await firstView.capture()).diagnostics).toEqual([]);

    first.release();
    renderer.counts = new Uint32Array([2, 0]);
    renderer.stats = new Uint32Array([1, 3]);
    const pooled = system.spawn(effect);
    await system.update(0.1);
    await pooled.getNeighborGrid('neighbors')!.capture();
    expect(
      pooled.diagnostics.filter(
        ({ code }) => code === 'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      ),
    ).toHaveLength(1);
    expect(delivered).toEqual([
      'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
    ]);
  });

  it('supports default, null, and throwing runtime diagnostic delivery without rejecting capture', async () => {
    const effect = defineEffect({
      elements: {
        neighbors: defineNeighborGrid({ cellCapacity: 1, resolution: [2, 1, 1] }),
        particles: defineEmitter({
          capacity: 2,
          integration: 'none',
          render: computeRender,
          spawn: burst({ count: 0 }),
          update: [boids({ grid: 'neighbors', radius: 0 })],
        }),
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const defaultSystem = new VFXSystem(new NeighborGridDiagnosticRenderer());
      const defaultInstance = defaultSystem.spawn(effect);
      await defaultSystem.update(0.1);
      const defaultView = defaultInstance.getNeighborGrid('neighbors')!;
      await defaultView.capture();
      await defaultView.capture();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT]'),
      );

      warn.mockClear();
      const nullSystem = new VFXSystem(new NeighborGridDiagnosticRenderer(), undefined, {
        onRuntimeDiagnostic: null,
      });
      const nullInstance = nullSystem.spawn(effect);
      await nullSystem.update(0.1);
      await nullInstance.getNeighborGrid('neighbors')!.capture();
      expect(warn).not.toHaveBeenCalled();
      expect(nullInstance.diagnostics.map(({ code }) => code)).toContain(
        'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
      );

      let handlerCalls = 0;
      const throwingSystem = new VFXSystem(new NeighborGridDiagnosticRenderer(), undefined, {
        onRuntimeDiagnostic: () => {
          handlerCalls += 1;
          throw new Error('synthetic runtime diagnostic handler failure');
        },
      });
      const throwingInstance = throwingSystem.spawn(effect);
      await throwingSystem.update(0.1);
      const throwingView = throwingInstance.getNeighborGrid('neighbors')!;
      await expect(throwingView.capture()).resolves.toMatchObject({ outOfBounds: 3 });
      await throwingSystem.update(0.1);
      await expect(throwingView.capture()).resolves.toMatchObject({ outOfBounds: 3 });
      expect(handlerCalls).toBe(1);
      expect(throwingInstance.diagnostics.map(({ code }) => code)).toEqual([
        'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT',
        'NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects queued Grid and NeighborGrid operations after their instance is released', async () => {
    const gridRenderer = new DeferredSubmissionRenderer();
    const gridSystem = new VFXSystem(gridRenderer);
    const gridInstance = gridSystem.spawn(
      defineEffect({
        elements: {
          grid: defineGrid2D({
            channels: { density: { type: 'f32' } },
            resolution: [2, 2],
          }),
          grid3d: defineGrid3D({
            channels: { density: { type: 'f32' } },
            resolution: [2, 2, 2],
          }),
        },
      }),
    );
    const grid = gridInstance.getGrid2D('grid')!;
    const grid3d = gridInstance.getGrid3D('grid3d')!;
    const queuedGridOperations = [
      grid.capture(),
      grid.rasterizeParticles([[0.5, 0.5]], 'density'),
      grid.sampleParticles([[0.5, 0.5]], 'density'),
      grid3d.capture(),
      grid3d.rasterizeParticles([[0.5, 0.5, 0.5]], 'density'),
      grid3d.sampleParticles([[0.5, 0.5, 0.5]], 'density'),
    ];
    gridInstance.release();
    for (const operation of queuedGridOperations) {
      await expect(operation).rejects.toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'NACHI_INSTANCE_RELEASED' })],
        }),
      );
    }
    expect(gridRenderer.readCount).toBe(0);
    expect(gridRenderer.writeCount).toBe(0);

    const neighborRenderer = new DeferredSubmissionRenderer();
    const neighborSystem = new VFXSystem(neighborRenderer);
    const neighborInstance = neighborSystem.spawn(
      defineEffect({
        elements: {
          neighbors: defineNeighborGrid({ cellCapacity: 2, resolution: [2, 2, 2] }),
          particles: defineEmitter({
            capacity: 1,
            integration: 'none',
            render: computeRender,
            spawn: burst({ count: 0 }),
            update: [boids({ grid: 'neighbors', radius: 0 })],
          }),
        },
      }),
    );
    const neighborCapture = neighborInstance.getNeighborGrid('neighbors')!.capture();
    neighborInstance.release();
    await expect(neighborCapture).rejects.toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_INSTANCE_RELEASED' })],
      }),
    );
    expect(neighborRenderer.readCount).toBe(0);
  });
});

import type {
  BuiltEmitterKernels,
  Grid2DRuntimeView,
  Grid3DRuntimeView,
  KernelComputeBuilder,
  KernelComputeNode,
  KernelNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  ModuleDefinition,
  ResolvedAttributeSchema,
  VfxDeviceLossInfo,
  VfxEmitterRuntimeView,
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
    floor: node,
    instancedArray: () => new FakeStorage(),
    indirectArray: () => Object.assign(new FakeStorage(), { indirectResource: {} }),
    inverse: node,
    mat4: node,
    loop: (_parameters, callback) => callback(node()),
    mod: node,
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
  readonly submittedKernels: KernelComputeNode[] = [];
  readonly submissions: string[] = [];
  readonly updateRandomStepSubmissions: Array<{ emitter: string; step: number }> = [];
  readonly #updateRandomStepSources = new Map<
    KernelComputeNode,
    { emitter: string; view: VfxEmitterRuntimeView }
  >();
  failNextSubmission = false;
  releaseCount = 0;

  trackUpdateRandomStep(emitter: string, view: VfxEmitterRuntimeView): void {
    this.#updateRandomStepSources.set(view.kernels.update, { emitter, view });
  }

  releaseKernels(_kernels: BuiltEmitterKernels): void {
    void _kernels;
    this.releaseCount += 1;
  }

  submitCompute(kernel: KernelComputeNode): void {
    if (this.failNextSubmission) {
      this.failNextSubmission = false;
      throw new Error('synthetic submit failure');
    }
    const tracked = this.#updateRandomStepSources.get(kernel);
    if (tracked) {
      const value = tracked.view.kernels.uniforms['Emitter.updateRandomStep']?.value;
      if (typeof value !== 'number') {
        throw new Error(`Missing numeric Update random step for ${tracked.emitter}.`);
      }
      this.updateRandomStepSubmissions.push({ emitter: tracked.emitter, step: value });
    }
    this.submittedKernels.push(kernel);
    this.submissions.push((kernel as FakeCompute).name);
  }

  submitComputeIndirect(kernel: KernelComputeNode): void {
    this.submitCompute(kernel);
  }
}

class ReleaseOrderingRenderer extends FakeRuntimeRenderer {
  readonly lifecycle: string[] = [];
  readonly releasedKernels = new Set<BuiltEmitterKernels>();
  readonly #releasedComputes = new WeakSet<object>();

  override releaseKernels(kernels: BuiltEmitterKernels): void {
    super.releaseKernels(kernels);
    this.releasedKernels.add(kernels);
    for (const compute of [
      kernels.compact,
      kernels.finalizeIndirect,
      kernels.finalizeSpawn,
      kernels.init,
      kernels.initialize,
      kernels.prepareSort,
      kernels.prepareSpawn,
      kernels.resetAliveCount,
      kernels.spawn,
      kernels.update,
      ...(kernels.sortPasses ?? []),
    ]) {
      if (compute) this.#releasedComputes.add(compute as object);
    }
    this.lifecycle.push('release');
  }

  override submitCompute(kernel: KernelComputeNode): void {
    if (this.#releasedComputes.has(kernel as object)) {
      throw new Error('submitted compute that references released kernels');
    }
    this.lifecycle.push(`submit:${(kernel as FakeCompute).name}`);
    super.submitCompute(kernel);
  }
}

class FailFirstEmitterUpdateRenderer extends FakeRuntimeRenderer {
  failed = false;

  override submitCompute(kernel: KernelComputeNode): void {
    const name = (kernel as FakeCompute).name;
    super.submitCompute(kernel);
    if (!this.failed && name === 'NachiEmitterUpdate') {
      this.failed = true;
      throw new Error('synthetic step failure');
    }
  }
}

class WebGlGridRenderer extends FakeRuntimeRenderer {
  override readonly kernelAdapter: KernelTslAdapter = {
    ...fakeAdapter(),
    capabilities: {
      atomics: false,
      backend: 'webgl2',
      indirectDispatch: false,
      indirectDraw: false,
    },
  };
}

class StorageLimitGridRenderer extends FakeRuntimeRenderer {
  override readonly kernelAdapter: KernelTslAdapter;

  constructor(maxStorageBufferBindingSize: number) {
    super();
    this.kernelAdapter = {
      ...fakeAdapter(),
      deviceLimits: { maxStorageBufferBindingSize },
    };
  }
}

class DeferredSubmissionRenderer extends FakeRuntimeRenderer {
  #releaseFirstSubmission: (() => void) | undefined;
  #shouldBlock = true;
  readCount = 0;
  writeCount = 0;

  override submitCompute(kernel: KernelComputeNode): Promise<void> | void {
    super.submitCompute(kernel);
    if (!this.#shouldBlock) return;
    this.#shouldBlock = false;
    return new Promise<void>((resolve) => {
      this.#releaseFirstSubmission = resolve;
    });
  }

  readStorage(): Promise<ArrayBuffer> {
    this.readCount += 1;
    return Promise.resolve(new Uint32Array(4096).buffer);
  }

  writeStorage(): void {
    this.writeCount += 1;
  }

  releaseFirstSubmission(): void {
    const release = this.#releaseFirstSubmission;
    if (!release) throw new Error('No deferred submission is pending.');
    this.#releaseFirstSubmission = undefined;
    release();
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

class NeighborGridDiagnosticRenderer extends FakeRuntimeRenderer {
  counts = new Uint32Array([2, 0]);
  slots = new Uint32Array([0, 0xffff_ffff]);
  stats = new Uint32Array([1, 3]);

  readStorage(storage: KernelStorageNode): Promise<ArrayBuffer> {
    const name = (storage as FakeStorage).name;
    const source = name.includes('Counts')
      ? this.counts
      : name.includes('Slots')
        ? this.slots
        : this.stats;
    return Promise.resolve(source.slice().buffer);
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

function lifetimeWithoutAgeEffect() {
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 1,
        init: [
          tslModule(({ lifetime: value }) => ({ lifetime: value }), {
            stage: 'init',
          }),
        ],
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 0 }),
      }),
    },
  });
}

function invalidBuildEffect() {
  const unsupportedSpawn: ModuleDefinition<'spawn', Record<string, never>> = {
    access: { reads: [], writes: ['Emitter.spawnCount'] },
    config: {},
    kind: 'module',
    stage: 'spawn',
    type: 'test/unsupported-spawn',
    version: 1,
  };
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 1,
        render: computeRender,
        spawn: unsupportedSpawn,
      }),
    },
  });
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

function eventFallbackEffect() {
  return defineEffect({
    elements: {
      source: defineEmitter({
        capacity: 1,
        events: { onDeath: emitTo('target') },
        init: [lifetime(1)],
        integration: 'none',
        lifecycle: { duration: 1 },
        render: computeRender,
        spawn: burst({ count: 0 }),
      }),
      target: defineEmitter({
        capacity: 1,
        init: [lifetime(0)],
        integration: 'none',
        lifecycle: { duration: 0 },
        render: computeRender,
        spawn: burst({ count: 0 }),
      }),
    },
  });
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
    update: [collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 1, space: 'world' })],
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
    expect(() => new EmitterLifecycleController({ duration: Infinity })).toThrow(RangeError);
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
  it('reports spawn-time build diagnostics to the default console handler one line at a time', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new VFXSystem(new FakeRuntimeRenderer()).spawn(invalidBuildEffect());
      new VFXSystem(new FakeRuntimeRenderer()).spawn(lifetimeWithoutAgeEffect());

      expect(error.mock.calls.map(([line]) => line)).toContainEqual(
        expect.stringContaining('[NACHI_MODULE_UNKNOWN]'),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[NACHI_LIFETIME_WITHOUT_AGE]'));
      for (const [line] of [...error.mock.calls, ...warn.mock.calls]) {
        expect(line).not.toMatch(/[\r\n]/);
      }
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('allows spawn-time build diagnostic reporting to be disabled or replaced', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics: string[] = [];
    try {
      new VFXSystem(new FakeRuntimeRenderer(), undefined, { onBuildDiagnostic: null }).spawn(
        invalidBuildEffect(),
      );
      new VFXSystem(new FakeRuntimeRenderer(), undefined, {
        onBuildDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }).spawn(lifetimeWithoutAgeEffect());

      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(diagnostics).toEqual(['NACHI_LIFETIME_WITHOUT_AGE']);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('contains spawn-time build diagnostic handler failures and keeps reporting diagnostics', () => {
    const unsupportedUpdate: ModuleDefinition<'update', Record<string, never>> = {
      access: { reads: [], writes: [] },
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/unsupported-update',
      version: 1,
    };
    const invalid = invalidBuildEffect();
    const particles = invalid.elements.particles!;
    const delivered: string[] = [];
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      onBuildDiagnostic: (diagnostic) => {
        delivered.push(diagnostic.code);
        throw new Error('synthetic build diagnostic handler failure');
      },
    });

    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: { ...particles, update: [unsupportedUpdate] },
        },
      }),
    );

    expect(instance.state).toBe('error');
    expect(delivered).toEqual([
      'NACHI_MODULE_UNKNOWN',
      'NACHI_MODULE_UNKNOWN',
      'NACHI_COMPILER_OWNED_WRITE',
    ]);
    expect(instance.diagnostics.filter(({ code }) => code === 'NACHI_MODULE_UNKNOWN')).toHaveLength(
      2,
    );
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BUILD_DIAGNOSTIC_HANDLER_FAILED',
        path: 'VFXSystem.onBuildDiagnostic',
        severity: 'warning',
      }),
    );
  });

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

  it('prepares every emitter pipeline without advancing public time or publishing an instance', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const effect = runtimeEffect({ duration: 10_000, startDelay: 9_000 });
    const prepareEmitter = vi.fn();
    const progress: Array<{ completed: number; total: number }> = [];

    await system.prepare(effect, {
      onProgress: ({ completed, total }) => progress.push({ completed, total }),
      preparer: { prepareEmitter },
    });

    expect(system.time).toBe(0);
    expect(system.instanceCount).toBe(0);
    expect(system.getPooledInstanceCount(effect)).toBe(1);
    expect(system.compilationCount).toBe(1);
    expect(renderer.submissions).toEqual(
      expect.arrayContaining([
        'NachiEmitterInitialize',
        'NachiEmitterPrepareSpawn',
        'NachiEmitterSpawn',
        'NachiEmitterUpdate',
        'NachiEmitterCompactAlive',
      ]),
    );
    expect(prepareEmitter).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([
      { completed: 0, total: 1 },
      { completed: 1, total: 1 },
    ]);
    const preparedKernels = prepareEmitter.mock.calls[0]![0].emitter.kernels;
    const live = system.spawn(effect);
    expect(live.getEmitter('particles')?.kernels).toBe(preparedKernels);
  });

  it('keeps compile-purpose Update preparation outside the simulation random ordinal', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const effect = runtimeEffect({ duration: 1 });
    let preparedEmitter: VfxEmitterRuntimeView | undefined;

    await system.prepare(effect, {
      preparer: {
        prepareEmitter: ({ emitter }) => {
          preparedEmitter = emitter;
        },
      },
    });

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterUpdate')).toHaveLength(1);
    expect(preparedEmitter?.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
    const live = system.spawn(effect);
    const emitter = live.getEmitter('particles')!;
    expect(emitter.kernels).toBe(preparedEmitter?.kernels);
    renderer.trackUpdateRandomStep('prepared-pool-checkout', emitter);

    await system.update(0.1);

    expect(renderer.updateRandomStepSubmissions).toEqual([
      { emitter: 'prepared-pool-checkout', step: 0 },
    ]);
    expect(emitter.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
  });

  it('rejects preparation when pooling is disabled instead of retaining dead draw anchors', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 0 });

    await expect(system.prepare(runtimeEffect({ duration: 1 }))).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_PREPARE_POOLING_DISABLED' })],
    });

    expect(renderer.submissions).toEqual([]);
    expect(system.instanceCount).toBe(0);
  });

  it('reuses prepared Grid2D kernel nodes on the next live spawn', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const effect = defineEffect({
      elements: {
        fluid: defineGrid2D({
          channels: { density: { type: 'f32' } },
          resolution: [2, 2],
        }),
      },
    });

    await system.prepare(effect);
    const preparedClear = renderer.submittedKernels.find(
      (kernel) => (kernel as FakeCompute).name === 'NachiGrid2DClear',
    );
    const instance = system.spawn(effect);
    await system.update(0);
    const clearKernels = renderer.submittedKernels.filter(
      (kernel) => (kernel as FakeCompute).name === 'NachiGrid2DClear',
    );

    expect(instance.getGrid2D('fluid')).toBeDefined();
    expect(clearKernels).toHaveLength(2);
    expect(clearKernels[1]).toBe(preparedClear);
  });

  it('keeps the prepared bundle when another release fills the pool during preparation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const effect = runtimeEffect({ duration: 1 });
    const live = system.spawn(effect);
    let preparedKernels: BuiltEmitterKernels | undefined;
    let resume: (() => void) | undefined;
    const preparing = system.prepare(effect, {
      preparer: {
        prepareEmitter: ({ emitter }) => {
          preparedKernels = emitter.kernels;
          return new Promise<void>((resolve) => {
            resume = resolve;
          });
        },
      },
    });
    while (!resume) await Promise.resolve();

    live.release();
    resume();
    await preparing;
    const spawned = system.spawn(effect);

    expect(spawned.getEmitter('particles')?.kernels).toBe(preparedKernels);
    expect(renderer.releaseCount).toBe(1);
  });

  it('aborts preparation cleanly without retaining a partial resource bundle', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const effect = runtimeEffect({ duration: 1 });
    const controller = new AbortController();
    const discardEmitter = vi.fn();

    await expect(
      system.prepare(effect, {
        preparer: {
          discardEmitter,
          prepareEmitter: () => controller.abort(),
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(system.time).toBe(0);
    expect(system.instanceCount).toBe(0);
    expect(system.getPooledInstanceCount(effect)).toBe(0);
    expect(renderer.releaseCount).toBe(1);
    expect(discardEmitter).toHaveBeenCalledTimes(1);
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

  it('advances Update randomness only for actual update dispatches', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, {
      fixedTimeStep: { stepSeconds: 0.1 },
    });
    const instance = system.spawn(runtimeEffect({ duration: 2 }));
    const emitter = instance.getEmitter('particles')!;
    renderer.trackUpdateRandomStep('particles', emitter);
    const lastConsumedStep = () => emitter.kernels.uniforms['Emitter.updateRandomStep']?.value;

    await system.update(0);
    expect(lastConsumedStep()).toBe(0);
    expect(renderer.updateRandomStepSubmissions).toEqual([]);

    await system.update(0.25);
    expect(lastConsumedStep()).toBe(1);
    expect(renderer.updateRandomStepSubmissions).toEqual([
      { emitter: 'particles', step: 0 },
      { emitter: 'particles', step: 1 },
    ]);

    instance.setTimeScale(0);
    await system.update(0.5);
    expect(lastConsumedStep()).toBe(1);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1]);

    instance.setTimeScale(1);
    instance.applyHitStop(100);
    await system.update(0.1);
    expect(lastConsumedStep()).toBe(1);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1]);

    await system.update(0.1);
    expect(lastConsumedStep()).toBe(2);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1, 2]);
  });

  it('does not advance the next Update random ordinal when submission rejects', async () => {
    const renderer = new FailFirstEmitterUpdateRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const definition = runtimeEffect({ duration: 1 });
    const failed = system.spawn(definition);
    const failedEmitter = failed.getEmitter('particles')!;
    renderer.trackUpdateRandomStep('failed', failedEmitter);

    await system.update(0.1);

    expect(failed.state).toBe('error');
    expect(renderer.updateRandomStepSubmissions).toEqual([{ emitter: 'failed', step: 0 }]);
    // A rejected runtime is terminal, so the attempted current value is the observable boundary:
    // the uniform remains 0 because the successful-await continuation did not run.
    expect(failedEmitter.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
    await system.update(0.1);
    expect(renderer.updateRandomStepSubmissions).toEqual([{ emitter: 'failed', step: 0 }]);

    failed.release();
    const recreated = system.spawn(definition);
    const recreatedEmitter = recreated.getEmitter('particles')!;
    renderer.trackUpdateRandomStep('recreated', recreatedEmitter);
    await system.update(0.1);
    expect(renderer.updateRandomStepSubmissions).toEqual([
      { emitter: 'failed', step: 0 },
      { emitter: 'recreated', step: 0 },
    ]);
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
    const firstRenderer = new FakeRuntimeRenderer();
    const secondRenderer = new FakeRuntimeRenderer();
    const first = new VFXSystem(firstRenderer, undefined, {
      fixedTimeStep: { stepSeconds: 0.02 },
    });
    const second = new VFXSystem(secondRenderer, undefined, {
      fixedTimeStep: { stepSeconds: 0.02 },
    });
    const firstInstance = first.spawn(runtimeEffect({ duration: 1 }));
    const secondInstance = second.spawn(runtimeEffect({ duration: 1 }));
    firstRenderer.trackUpdateRandomStep('particles', firstInstance.getEmitter('particles')!);
    secondRenderer.trackUpdateRandomStep('particles', secondInstance.getEmitter('particles')!);
    await first.update(0.1);
    await second.update(0.03);
    await second.update(0.07);
    expect(first.time).toBeCloseTo(second.time);
    expect(firstInstance.localTime).toBeCloseTo(secondInstance.localTime);
    expect(
      firstInstance.getEmitter('particles')?.kernels.uniforms['Emitter.updateRandomStep']?.value,
    ).toBe(4);
    expect(
      secondInstance.getEmitter('particles')?.kernels.uniforms['Emitter.updateRandomStep']?.value,
    ).toBe(4);
    expect(firstRenderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(secondRenderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('splits prewarm into deterministic fixed-size submissions', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { prewarmStepSeconds: 0.1 });
    const instance = system.spawn(runtimeEffect({ duration: 1, prewarm: 0.3 }));
    renderer.trackUpdateRandomStep('particles', instance.getEmitter('particles')!);
    await system.update(0);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    expect(renderer.submissions.filter((name) => name === 'NachiEmitterUpdate')).toHaveLength(3);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.localTime']?.value,
    ).toBeCloseTo(0.3);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.updateRandomStep']?.value,
    ).toBe(2);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1, 2]);
  });

  it('advances spawnGeneration when a loop re-fires', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 0.1, loopCount: 2 }));
    renderer.trackUpdateRandomStep('particles', instance.getEmitter('particles')!);
    await system.update(0);
    expect(instance.getEmitter('particles')?.spawnGeneration).toBe(0);
    await system.update(0.1);
    expect(instance.getEmitter('particles')?.spawnGeneration).toBe(1);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0]);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.updateRandomStep']?.value,
    ).toBe(0);
    await system.update(0.1);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.updateRandomStep']?.value,
    ).toBe(1);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1]);
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

  it('retires overflow kernels only after a timeline-style stop/release update and safely reuses the pool', async () => {
    const renderer = new ReleaseOrderingRenderer();
    const definition = runtimeEffect({ duration: 1 });
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const first = system.spawn(definition);
    const second = system.spawn(definition);
    const pooledKernels = first.getEmitter('particles')!.kernels;
    system.spawn(runtimeEffect({ duration: 1 }));
    let releaseOnAttachmentRead = false;
    for (const instance of [first, second]) {
      instance.attachTo({
        getWorldTransform: () => {
          if (releaseOnAttachmentRead) {
            instance.stop();
            instance.release();
          }
          return { position: [0, 0, 0] };
        },
      });
    }

    releaseOnAttachmentRead = true;
    await system.update(0);

    expect(renderer.releaseCount).toBe(1);
    expect(renderer.lifecycle.at(-1)).toBe('release');
    expect(system.getPooledInstanceCount(definition)).toBe(1);

    const recycled = system.spawn(definition);
    expect(recycled.getEmitter('particles')!.kernels).toBe(pooledKernels);
    await expect(system.update(0)).resolves.toBeUndefined();
    expect(recycled.state).toBe('active');
  });

  it('re-evaluates a release against pool checkout before flush and only retires inactive overflow kernels', async () => {
    const renderer = new ReleaseOrderingRenderer();
    const definition = runtimeEffect({ duration: 1 });
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const releasedDuringUpdate = system.spawn(definition);
    const releasedKernels = releasedDuringUpdate.getEmitter('particles')!.kernels;
    const driver = system.spawn(runtimeEffect({ duration: 1 }));
    const initiallyPooled = system.spawn(definition);
    const pooledKernels = initiallyPooled.getEmitter('particles')!.kernels;
    initiallyPooled.release();
    let runBoundary = false;
    let reacquired: typeof releasedDuringUpdate | undefined;
    releasedDuringUpdate.attachTo({
      getWorldTransform: () => {
        if (runBoundary) releasedDuringUpdate.release();
        return { position: [0, 0, 0] };
      },
    });
    driver.attachTo({
      getWorldTransform: () => {
        if (runBoundary) {
          runBoundary = false;
          reacquired = system.spawn(definition);
        }
        return { position: [0, 0, 0] };
      },
    });

    runBoundary = true;
    await system.update(0);

    expect(reacquired?.getEmitter('particles')?.kernels).toBe(pooledKernels);
    expect(system.getPooledInstanceCount(definition)).toBe(1);
    expect(renderer.releasedKernels.has(pooledKernels)).toBe(false);
    expect(renderer.releasedKernels.has(releasedKernels)).toBe(false);

    reacquired!.release();
    expect(renderer.releasedKernels.has(pooledKernels)).toBe(true);
    expect(renderer.releaseCount).toBe(1);
  });

  it('keeps destroyed and active kernels disjoint through timeline-loop pool pressure', async () => {
    const renderer = new ReleaseOrderingRenderer();
    const definition = runtimeEffect({ duration: 1 });
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    system.spawn(definition).release();
    let active = [system.spawn(definition), system.spawn(definition)];
    const driver = system.spawn(runtimeEffect({ duration: 1 }));
    let crossLoopBoundary: (() => void) | undefined;
    driver.attachTo({
      getWorldTransform: () => {
        const boundary = crossLoopBoundary;
        crossLoopBoundary = undefined;
        boundary?.();
        return { position: [0, 0, 0] };
      },
    });

    for (let cycle = 0; cycle < 64; cycle += 1) {
      let replacements: typeof active = [];
      crossLoopBoundary = () => {
        for (const instance of active) {
          instance.stop();
          instance.release();
        }
        replacements = [system.spawn(definition), system.spawn(definition)];
      };

      await expect(system.update(0)).resolves.toBeUndefined();
      active = replacements;
      const activeKernels = active.map((instance) => instance.getEmitter('particles')!.kernels);
      expect(activeKernels.some((kernels) => renderer.releasedKernels.has(kernels))).toBe(false);
    }

    expect(renderer.releaseCount).toBe(64);
    expect(system.getPooledInstanceCount(definition)).toBe(1);
  });

  it('turns submission failures into runtime diagnostics', async () => {
    const renderer = new FakeRuntimeRenderer();
    renderer.failNextSubmission = true;
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    await system.update(0);
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_GPU_SUBMISSION_FAILED',
        context: { emitterPath: 'elements.particles', kernel: 'init' },
        path: 'elements.particles',
        phase: 'runtime',
      }),
    );
    expect(
      instance.diagnostics.find(({ code }) => code === 'NACHI_GPU_SUBMISSION_FAILED')?.message,
    ).toMatch(/init.*elements\.particles/);
    instance.release();
    expect(system.getPooledInstanceCount(instance.definition)).toBe(0);
    expect(renderer.releaseCount).toBe(1);
  });

  it.each([
    'grid2d',
    'grid3d',
  ] as const)('attributes %s submission failures to the simulation-stage context', async (kind) => {
    const renderer = new FakeRuntimeRenderer();
    const definition = defineEffect({
      elements: {
        grid:
          kind === 'grid2d'
            ? defineGrid2D({
                channels: { density: { type: 'f32' } },
                resolution: [2, 2],
              })
            : defineGrid3D({
                channels: { density: { type: 'f32' } },
                resolution: [2, 2, 2],
              }),
      },
    });
    const system = new VFXSystem(renderer);
    const instance = system.spawn(definition);
    renderer.failNextSubmission = true;

    await expect(system.update(0)).resolves.toBeUndefined();

    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_GPU_SUBMISSION_FAILED',
        context: { emitterPath: 'elements.grid', kernel: 'sim-stage' },
        path: 'elements.grid',
      }),
    );
  });

  it('initializes effects spawned by an event callback before same-update event consumption', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const source = system.spawn(eventEffect());
    let spawned: { readonly state: string } | undefined;
    let callbackSubmission = -1;
    source.on('death', () => {
      callbackSubmission = renderer.submissions.length;
      spawned = system.spawn(
        defineEffect({
          elements: {
            freshSource: defineEmitter({
              capacity: 1,
              events: { onDeath: emitTo('freshTarget') },
              init: [lifetime(0.1)],
              integration: 'none',
              render: computeRender,
              spawn: burst({ count: 1 }),
            }),
            freshTarget: defineEmitter({
              capacity: 1,
              integration: 'none',
              render: computeRender,
              spawn: burst({ count: 0 }),
            }),
          },
        }),
      );
    });
    await system.update(0);
    const state = source.getEmitter('sparks')!.kernels.eventOutputs.onDeath!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 0, 1]));

    await system.update(0.1);

    expect(spawned?.state).not.toBe('error');
    const sameUpdate = renderer.submissions.slice(callbackSubmission);
    expect(sameUpdate.indexOf('NachiEmitterInitialize')).toBeGreaterThanOrEqual(0);
    expect(sameUpdate.indexOf('NachiEmitterInitialize')).toBeLessThan(
      sameUpdate.indexOf('NachiEventPrepare_freshSource_onDeath_0'),
    );
  });

  it('initializes a budget-admitted effect before stepping it later in the same update', async () => {
    const renderer = new FailFirstEmitterUpdateRenderer();
    const system = new VFXSystem(renderer, undefined, {
      fixedTimeStep: { stepSeconds: 0.1 },
      significanceBudget: { maxActiveInstances: 1, maxParticles: 100 },
    });
    system.spawn(runtimeEffect({ duration: 1 }), { priority: 10 });
    const admittedLater = system.spawn(
      defineEffect({
        elements: {
          freshSource: defineEmitter({
            capacity: 1,
            events: { onDeath: emitTo('freshTarget') },
            init: [lifetime(0.1)],
            integration: 'none',
            render: computeRender,
            spawn: burst({ count: 1 }),
          }),
          freshTarget: defineEmitter({
            capacity: 1,
            integration: 'none',
            render: computeRender,
            spawn: burst({ count: 0 }),
          }),
        },
      }),
      { priority: 0 },
    );
    expect(admittedLater.scalability.action).toBe('culled');

    await system.update(0.2);

    expect(renderer.failed).toBe(true);
    expect(admittedLater.scalability.action).not.toBe('culled');
    const afterFailure = renderer.submissions.slice(
      renderer.submissions.indexOf('NachiEmitterUpdate') + 1,
    );
    expect(afterFailure.indexOf('NachiEmitterInitialize')).toBeGreaterThanOrEqual(0);
    expect(afterFailure.indexOf('NachiEmitterInitialize')).toBeLessThan(
      afterFailure.indexOf('NachiEventPrepare_freshSource_onDeath_0'),
    );
  });

  it('contains attachment-source failures per instance and tolerates self-release callbacks', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const broken = system.spawn(runtimeEffect({ duration: 1 }));
    const healthy = system.spawn(runtimeEffect({ duration: 1 }));
    let calls = 0;
    broken.attachTo({
      getWorldTransform: () => {
        calls += 1;
        if (calls > 1) throw new Error('synthetic attachment failure');
        return { position: [0, 0, 0] };
      },
    });

    await expect(system.update(0.1)).resolves.toBeUndefined();
    expect(broken.state).toBe('error');
    expect(broken.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_ATTACHMENT_SOURCE_FAILED' }),
    );
    expect(healthy.localTime).toBeCloseTo(0.1);

    const selfReleasing = system.spawn(runtimeEffect({ duration: 1 }));
    let releaseOnRead = false;
    selfReleasing.attachTo({
      getWorldTransform: () => {
        if (releaseOnRead) selfReleasing.release();
        return { position: [1, 2, 3] };
      },
    });
    releaseOnRead = true;
    await expect(system.update(0.1)).resolves.toBeUndefined();
    expect(selfReleasing.state).toBe('released');
  });

  it('keeps listener failures as warnings without killing or misdiagnosing the instance', async () => {
    const renderer = new MappedReadbackRenderer();
    const system = new VFXSystem(renderer, undefined, { aliveCountReadbackInterval: 1 });
    const instance = system.spawn(eventEffect());
    instance.on('death', () => {
      throw new Error('synthetic listener failure');
    });
    await system.update(0);
    const state = instance.getEmitter('sparks')!.kernels.eventOutputs.onDeath!.state;
    renderer.storageValues.set(state, new Uint32Array([0, 0, 0, 1]));

    await system.update(0.1);

    expect(instance.state).toBe('active');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_LISTENER_FAILED', severity: 'warning' }),
    );
    expect(instance.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_GPU_SUBMISSION_FAILED' }),
    );
  });

  it('commits release before cleanup and frees unowned event queues after spawn failure', () => {
    const throwingReleaseRenderer = new (class extends FakeRuntimeRenderer {
      override releaseKernels(): void {
        this.releaseCount += 1;
        throw new Error('synthetic release failure');
      }
    })();
    const released = new VFXSystem(throwingReleaseRenderer, undefined, {
      maxPoolSize: 0,
    }).spawn(runtimeEffect({ duration: 1 }));
    expect(() => released.release()).toThrowError('synthetic release failure');
    expect(released.state).toBe('released');
    expect(() => released.release()).not.toThrow();
    expect(throwingReleaseRenderer.releaseCount).toBe(1);

    const failedMaterializationRenderer = new (class extends FakeRuntimeRenderer {
      override readonly kernelAdapter: KernelTslAdapter = {
        ...fakeAdapter(),
        uniform: () => {
          throw new Error('synthetic uniform materialization failure');
        },
      };
      releasedStorages = 0;

      releaseStorage(): void {
        this.releasedStorages += 1;
      }
    })();
    const failed = new VFXSystem(failedMaterializationRenderer).spawn(eventEffect());
    expect(failed.state).toBe('error');
    expect(failedMaterializationRenderer.releasedStorages).toBe(3);
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
  ] as const)('transitions to error for invalid spawn parameter overrides: %s', (code, parameters) => {
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
  });

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
      render: computeRender,
      spawn: rate({ rate: 2.5 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));
    await system.update(0);
    await system.update(0.4);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(1);
    expect(instance.getEmitter('particles')?.lifecycleState).toBe('active');
    expect(instance.state).toBe('active');

    const submissionsBeforeStop = renderer.submissions.length;
    instance.stop();
    await system.update(0.4);
    expect(instance.state).toBe('stopped');
    expect(renderer.submissions).toHaveLength(submissionsBeforeStop);
  });

  it('keeps a partial lifecycle continuous emitter in its first unbounded activation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      integration: 'none',
      lifecycle: { loopCount: 2, startDelay: 0.1 },
      render: computeRender,
      spawn: rate(10),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0.1);
    expect(instance.getEmitter('particles')).toMatchObject({
      lifecycleState: 'active',
      loopIndex: 0,
    });
    await system.update(0.2);

    expect(instance.getEmitter('particles')).toMatchObject({
      lifecycleState: 'active',
      loopIndex: 0,
      spawnGeneration: 0,
    });
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(2);
  });

  it('keeps an explicit finite duration ahead of continuous derivation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      init: [lifetime(0.1)],
      integration: 'none',
      lifecycle: { duration: 0.2, startDelay: 0.1 },
      render: computeRender,
      spawn: rate(10),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0.4);

    expect(instance.getEmitter('particles')?.lifecycleState).toBe('completed');
    expect(instance.state).toBe('complete');
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(2);
  });

  it('converts transform distance into per-distance spawn count', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 16,
      integration: 'none',
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
    expect(instance.getEmitter('particles')?.lifecycleState).toBe('active');
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnPhaseStart']?.value,
    ).toBeCloseTo(0.1);
    expect(
      instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnPhaseStep']?.value,
    ).toBeCloseTo(0.1);
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

  it('derives an omitted lifecycle from the full multi-cycle burst envelope', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 200,
      init: [lifetime(range(0.3, 0.45))],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 40, cycles: 5, interval: 0.12 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }), {
      seed: 0x007b_57c1,
    });

    await system.update(0);
    for (let cycle = 1; cycle < 5; cycle += 1) await system.update(0.12);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(5);
    expect(instance.getEmitter('particles')).toMatchObject({ lifecycleState: 'active' });
    expect(instance.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(
      40,
    );
  });

  it('derives the envelope for an explicitly empty lifecycle object', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      init: [lifetime(1)],
      integration: 'none',
      lifecycle: {},
      render: computeRender,
      spawn: burst({ count: 1, cycles: 3, interval: 0.2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0);
    await system.update(0.2);
    await system.update(0.2);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(3);
    expect(instance.getEmitter('particles')).toMatchObject({ lifecycleState: 'active' });
  });

  it('composes startDelay with a derived envelope for a partial lifecycle object', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      init: [lifetime(1)],
      integration: 'none',
      lifecycle: { startDelay: 0.2 },
      render: computeRender,
      spawn: burst({ count: 1, cycles: 3, interval: 0.2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0);
    await system.update(0.19);
    expect(renderer.submissions).not.toContain('NachiEmitterSpawn');
    expect(instance.getEmitter('particles')).toMatchObject({ lifecycleState: 'delayed' });

    await system.update(0.01);
    await system.update(0.2);
    await system.update(0.2);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(3);
    expect(instance.getEmitter('particles')).toMatchObject({ lifecycleState: 'active' });
  });

  it('keeps an explicit numeric duration ahead of envelope derivation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 8,
      init: [lifetime(1)],
      integration: 'none',
      lifecycle: { duration: 0 },
      render: computeRender,
      spawn: burst({ count: 1, cycles: 3, interval: 0.2 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0);
    await system.update(0.5);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    expect(instance.getEmitter('particles')).toMatchObject({ lifecycleState: 'completed' });
  });

  it.each([
    ['finite', 2 as const, 4, 1, 'completed' as const],
    ['infinite', 'infinite' as const, 5, 2, 'active' as const],
  ])('repeats the complete derived envelope for a %s loop count', async (_name, loopCount, expectedSpawns, expectedLoopIndex, expectedState) => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const emitter = defineEmitter({
      capacity: 16,
      init: [lifetime(0.05)],
      integration: 'none',
      lifecycle: { loopCount },
      render: computeRender,
      spawn: burst({ count: 1, cycles: 2, interval: 0.1 }),
    });
    const instance = system.spawn(defineEffect({ elements: { particles: emitter } }));

    await system.update(0);
    await system.update(0.5);

    expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(
      expectedSpawns,
    );
    expect(instance.getEmitter('particles')).toMatchObject({
      lifecycleState: expectedState,
      loopIndex: expectedLoopIndex,
      spawnGeneration: expectedLoopIndex,
    });
  });

  it('still diagnoses a loop without an explicit or derived positive duration', () => {
    expect(() =>
      defineEmitter({
        capacity: 1,
        lifecycle: { loopCount: 2 },
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    ).toThrow(VfxDiagnosticError);
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
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    const matrix = uniforms['Emitter.transform']?.value;
    expect(matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(matrix);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
  });

  it('snapshots the last simulated transform and disables interpolation on a stationary step', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }), { position: [1, 2, 3] });
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    const initial = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1];

    expect(uniforms['Emitter.previousTransform']?.value).toEqual(initial);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
    await system.update(0);
    instance.setTransform([4, 5, 6]);
    await system.update(0.1);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(initial);
    expect(uniforms['Emitter.transform']?.value).toEqual(moved);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(1);

    await system.update(0.1);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(moved);
    expect(uniforms['Emitter.transform']?.value).toEqual(moved);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
  });

  it('resets previousTransform when pooled kernels are reacquired by a new spawn', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, { maxPoolSize: 1 });
    const definition = runtimeEffect({ duration: 1 });
    const first = system.spawn(definition, { position: [7, 0, 0] });
    const pooledKernels = first.getEmitter('particles')!.kernels;
    renderer.trackUpdateRandomStep('first', first.getEmitter('particles')!);
    await system.update(0);
    first.setTransform([9, 0, 0]);
    await system.update(0.1);
    expect(pooledKernels.uniforms['Emitter.interpolationActive']?.value).toBe(1);
    await system.update(0.1);
    expect(pooledKernels.uniforms['Emitter.updateRandomStep']?.value).toBe(1);
    first.release();

    const respawned = system.spawn(definition, { position: [-3, 2, 1] });
    const respawnedKernels = respawned.getEmitter('particles')!.kernels;
    const respawnTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, 2, 1, 1];
    expect(respawnedKernels).toBe(pooledKernels);
    expect(respawnedKernels.uniforms['Emitter.transform']?.value).toEqual(respawnTransform);
    expect(respawnedKernels.uniforms['Emitter.previousTransform']?.value).toEqual(respawnTransform);
    expect(respawnedKernels.uniforms['Emitter.interpolationActive']?.value).toBe(0);
    expect(respawnedKernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
    renderer.trackUpdateRandomStep('respawned', respawned.getEmitter('particles')!);
    await system.update(0.1);
    expect(renderer.updateRandomStepSubmissions).toEqual([
      { emitter: 'first', step: 0 },
      { emitter: 'first', step: 1 },
      { emitter: 'respawned', step: 0 },
    ]);
  });

  it('commits transform history across fixed substeps without leaving a stale endpoint', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      fixedTimeStep: { maxSubSteps: 4, stepSeconds: 0.1 },
    });
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    await system.update(0);
    instance.setTransform([4, 0, 0]);
    await system.update(0.2);
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1];
    expect(uniforms['Emitter.transform']?.value).toEqual(moved);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(moved);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
  });

  it('discards transform history consumed while hit stop suppresses simulation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(runtimeEffect({ duration: 2 }));
    const emitter = instance.getEmitter('particles')!;
    const uniforms = emitter.kernels.uniforms;
    renderer.trackUpdateRandomStep('particles', emitter);
    await system.update(0);
    instance.applyHitStop(100, 0);
    instance.setTransform([6, 0, 0]);
    await system.update(0.1);
    expect(renderer.updateRandomStepSubmissions).toEqual([]);
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(1);

    await system.update(0.1);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(
      uniforms['Emitter.transform']?.value,
    );
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
    expect(renderer.updateRandomStepSubmissions).toEqual([{ emitter: 'particles', step: 0 }]);
  });

  it('keeps prewarm on the direct-current transform branch', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      prewarmStepSeconds: 0.1,
    });
    const instance = system.spawn(runtimeEffect({ duration: 1, prewarm: 0.3 }), {
      position: [5, -2, 1],
      rotation: [0, 0, Math.PI / 4],
    });
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    await system.update(0);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(
      uniforms['Emitter.transform']?.value,
    );
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
  });

  it('composes each emitter offset after the instance transform for scattered bursts', () => {
    const emitter = (offset: readonly [number, number, number]) =>
      defineEmitter({
        capacity: 1,
        offset,
        render: computeRender,
        spawn: burst({ count: 1 }),
      });
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(
      defineEffect({
        elements: {
          left: emitter([-2, 0, 0]),
          middle: emitter([0, 1, 0]),
          right: emitter([3, 0, 0]),
        },
      }),
      { position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] },
    );

    const translation = (key: string) => {
      const matrix = instance.getEmitter(key)?.kernels.uniforms['Emitter.transform']?.value as
        | readonly number[]
        | undefined;
      return matrix?.slice(12, 15);
    };
    expect(translation('left')).toEqual([expect.closeTo(10), expect.closeTo(-2), 0]);
    expect(translation('middle')).toEqual([expect.closeTo(9), expect.closeTo(0), 0]);
    expect(translation('right')).toEqual([expect.closeTo(10), expect.closeTo(3), 0]);

    instance.setTransform([4, 5, 6]);
    expect(translation('left')).toEqual([2, 5, 6]);
    expect(translation('middle')).toEqual([4, 6, 6]);
    expect(translation('right')).toEqual([7, 5, 6]);
  });

  it('attaches an effect to a mutable world-transform source immediately', () => {
    const system = new VFXSystem(new FakeRuntimeRenderer());
    const instance = system.spawn(runtimeEffect({ duration: 1 }));
    const source = {
      getWorldTransform: () => ({ position: [2, 3, 4] as const }),
    };
    instance.attachTo(source);
    const uniforms = instance.getEmitter('particles')!.kernels.uniforms;
    expect(uniforms['Emitter.transform']?.value).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1,
    ]);
    expect(uniforms['Emitter.previousTransform']?.value).toEqual(
      uniforms['Emitter.transform']?.value,
    );
    expect(uniforms['Emitter.interpolationActive']?.value).toBe(0);
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

  it('canonicalizes multi-source event routing independently of element insertion order', () => {
    const source = (event: 'onCollision' | 'onDeath') =>
      defineEmitter({
        capacity: 1,
        events: { [event]: emitTo('target', { inherit: ['position'] }) },
        init: [lifetime(0.1)],
        integration: 'none' as const,
        render: computeRender,
        spawn: burst({ count: 1 }),
      });
    const target = defineEmitter({
      capacity: 1,
      init: [positionSphere({ radius: 0 })],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 0 }),
    });
    const elements = {
      zeta: source('onDeath'),
      target,
      alpha: source('onCollision'),
    };
    const reversed = Object.fromEntries(Object.entries(elements).reverse()) as typeof elements;
    const routeKeys = (definitionElements: typeof elements) => {
      const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
        defineEffect({ elements: definitionElements }),
      );
      return instance
        .getEmitter('target')!
        .kernels.eventInputs.map(
          ({ binding }) =>
            `${binding.sourceKey}/${binding.queue.eventName}/${binding.handler.target}`,
        );
    };

    expect(routeKeys(elements)).toEqual(['alpha/onCollision/target', 'zeta/onDeath/target']);
    expect(routeKeys(reversed)).toEqual(routeKeys(elements));
  });

  it('canonicalizes distinct handlers in one source queue by semantic inherit key', () => {
    const route = (reverseHandlers: boolean) => {
      const handlers = [
        emitTo('target', { inherit: ['velocity'] }),
        emitTo('target', { inherit: ['position'] }),
      ];
      const instance = new VFXSystem(new FakeRuntimeRenderer()).spawn(
        defineEffect({
          elements: {
            source: defineEmitter({
              capacity: 1,
              events: { onDeath: reverseHandlers ? [...handlers].reverse() : handlers },
              init: [positionSphere({ radius: 0 })],
              render: computeRender,
              spawn: burst({ count: 1 }),
            }),
            target: defineEmitter({
              capacity: 2,
              init: [positionSphere({ radius: 0 })],
              render: computeRender,
              spawn: burst({ count: 0 }),
              update: [
                tslModule(({ velocity }) => ({ velocity }), {
                  access: { reads: ['Particles.velocity'], writes: ['Particles.velocity'] },
                }),
              ],
            }),
          },
        }),
      );
      return instance
        .getEmitter('target')!
        .kernels.eventInputs.map(({ binding }) => binding.handler.inherit);
    };

    expect(route(false)).toEqual([['position'], ['velocity']]);
    expect(route(true)).toEqual(route(false));
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

  it('advances the Update random ordinal for event-input fallback simulation', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer);
    const instance = system.spawn(eventFallbackEffect());
    const target = instance.getEmitter('target')!;
    renderer.trackUpdateRandomStep('event-target', target);

    await system.update(0);
    expect(renderer.updateRandomStepSubmissions).toEqual([]);
    instance.setTransform([3, 0, 0]);
    await system.update(0.1);
    expect(
      (target.kernels.uniforms['Emitter.previousTransform']!.value as readonly number[]).slice(
        12,
        15,
      ),
    ).toEqual([0, 0, 0]);
    expect(
      (target.kernels.uniforms['Emitter.transform']!.value as readonly number[]).slice(12, 15),
    ).toEqual([3, 0, 0]);
    expect(target.kernels.uniforms['Emitter.interpolationActive']?.value).toBe(1);
    await system.update(0.1);

    expect(target.kernels.eventInputs).toHaveLength(1);
    expect(renderer.updateRandomStepSubmissions).toEqual([
      { emitter: 'event-target', step: 0 },
      { emitter: 'event-target', step: 1 },
    ]);
    expect(target.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(1);
    expect(
      (target.kernels.uniforms['Emitter.previousTransform']!.value as readonly number[]).slice(
        12,
        15,
      ),
    ).toEqual([3, 0, 0]);
    expect(target.kernels.uniforms['Emitter.interpolationActive']?.value).toBe(0);
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
          render: computeRender,
          spawn: rate(10),
        }),
      },
      scalability: {
        culling: { distance: { fadeEnd: 6, fadeStart: 4 }, frustum: false },
      },
    });
    const instance = system.spawn(definition, { position: [0, 0, 5] });
    const emitter = instance.getEmitter('particles')!;
    renderer.trackUpdateRandomStep('particles', emitter);
    expect(instance.scalability.action).toBe('full');
    expect(instance.scalability.fade).toBeGreaterThan(0.35);
    expect(instance.scalability.fade).toBeLessThan(0.65);
    await system.update(0.1);
    const visibleTime = instance.localTime;
    expect(emitter.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0]);
    const submissions = renderer.submissions.length;
    instance.setTransform([0, 0, 7]);
    await system.update(0.5);
    expect(instance.scalability).toMatchObject({ action: 'culled', fade: 0 });
    expect(instance.scalability.reasons).toContain('distance');
    expect(instance.localTime).toBe(visibleTime);
    expect(emitter.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(0);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0]);
    expect(renderer.submissions).toHaveLength(submissions);
    expect(
      (emitter.kernels.uniforms['Emitter.previousTransform']!.value as readonly number[]).slice(
        12,
        15,
      ),
    ).toEqual([0, 0, 5]);
    expect(
      (emitter.kernels.uniforms['Emitter.transform']!.value as readonly number[]).slice(12, 15),
    ).toEqual([0, 0, 7]);
    expect(emitter.kernels.uniforms['Emitter.interpolationActive']?.value).toBe(1);
    instance.setTransform([0, 0, 1]);
    await system.update(0.1);
    expect(instance.scalability.action).toBe('full');
    expect(instance.localTime).toBeCloseTo(visibleTime + 0.1);
    expect(emitter.kernels.uniforms['Emitter.updateRandomStep']?.value).toBe(1);
    expect(renderer.updateRandomStepSubmissions.map(({ step }) => step)).toEqual([0, 1]);
    expect(instance.getEmitter('particles')?.lifecycleState).toBe('active');
    expect(instance.state).toBe('active');
    expect(
      (emitter.kernels.uniforms['Emitter.previousTransform']!.value as readonly number[]).slice(
        12,
        15,
      ),
    ).toEqual([0, 0, 7]);
    expect(
      (emitter.kernels.uniforms['Emitter.transform']!.value as readonly number[]).slice(12, 15),
    ).toEqual([0, 0, 1]);
    expect(emitter.kernels.uniforms['Emitter.interpolationActive']?.value).toBe(1);
  });

  it('admits a duration-omitted continuous emitter after the significance slot is freed', async () => {
    const renderer = new FakeRuntimeRenderer();
    const system = new VFXSystem(renderer, undefined, {
      significanceBudget: { maxActiveInstances: 1, maxParticles: 64 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 8,
          integration: 'none',
          render: computeRender,
          spawn: rate(10),
        }),
      },
      scalability: { significance: { priority: 0 } },
    });
    const admitted = system.spawn(definition, { priority: 1 });
    const waiting = system.spawn(definition, { priority: 0 });
    expect(waiting.scalability.action).toBe('culled');

    admitted.stop();
    admitted.release();
    await system.update(0.1);

    expect(waiting.scalability.action).toBe('full');
    expect(waiting.getEmitter('particles')?.lifecycleState).toBe('active');
    expect(waiting.getEmitter('particles')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(1);
    expect(waiting.state).toBe('active');
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

  it.each([
    { boundary: 10, budget: 'instance' as const },
    { boundary: 100, budget: 'particle' as const },
  ])('uses numeric creation order for equal significance at id $boundary ($budget budget)', async ({
    boundary,
    budget,
  }) => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      maxPoolSize: 1,
      significanceBudget:
        budget === 'instance'
          ? { maxActiveInstances: 1, maxParticles: 2 }
          : { maxActiveInstances: 2, maxParticles: 1 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { radius: 0.1 },
          capacity: 1,
          render: computeRender,
          spawn: burst({ count: 0 }),
        }),
      },
      scalability: {
        culling: { distance: { fadeEnd: 2, fadeStart: 1 }, frustum: false },
        significance: { priority: 0 },
      },
    });
    for (let sequence = 1; sequence < boundary - 1; sequence += 1) {
      system.spawn(definition, { position: [10, 0, 0] }).release();
    }
    const earlier = system.spawn(definition, { position: [10, 0, 0] });
    const later = system.spawn(definition, { position: [10, 0, 0] });
    expect([earlier.id, later.id]).toEqual([
      `nachi-effect-${boundary - 1}`,
      `nachi-effect-${boundary}`,
    ]);
    earlier.setTransform([0, 0, 0]);
    later.setTransform([0, 0, 0]);

    await system.update(0);

    expect(earlier.scalability.action).toBe('full');
    expect(later.scalability.action).toBe(budget === 'instance' ? 'culled' : 'spawn-suppressed');
    expect(later.scalability.reasons).toContain(
      budget === 'instance' ? 'significance-instance-budget' : 'significance-particle-budget',
    );
  });

  it('does not let a hidden preparation spawn perturb significance admission', async () => {
    const system = new VFXSystem(new FakeRuntimeRenderer(), undefined, {
      significanceBudget: { maxActiveInstances: 1, maxParticles: 100 },
    });
    system.setCamera(camera);
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          bounds: { radius: 0.1 },
          capacity: 1,
          render: computeRender,
          spawn: burst({ count: 0 }),
        }),
      },
      scalability: { significance: { priority: 0 } },
    });
    const admitted = system.spawn(definition, { priority: 1 });
    const before = admitted.scalability;

    await system.prepare(definition);

    expect(admitted.scalability).toEqual(before);
    expect(admitted.scalability.action).toBe('full');
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

  it('rejects WebGL2 cache baking before multi-group transform-feedback records alias', async () => {
    const render: ModuleDefinition<'render', Record<string, never>> = {
      ...computeRender,
      access: {
        reads: ['Particles.position', 'Particles.rotation', 'Particles.size'],
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
    const sizeAttribute = program.attributeSchema.byName.size!;
    const sizeStorage = program.attributeSchema.storageArrays[sizeAttribute.physical.bufferIndex]!;
    expect(sizeStorage.groupCount).toBe(2);
    expect(sizeAttribute.physical).toMatchObject({ group: 0, offset: 3, packed: true });
    const renderer = new CacheRuntimeRenderer();
    Object.assign(renderer.kernelAdapter.capabilities, { backend: 'webgl2' });
    await expect(
      bakeSimulation(new VFXSystem(renderer), definition, { frames: 1 }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED' })],
    });
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
      return { data, diagnostics: source.diagnostics, kind: 'simulation-cache' as const, metadata };
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
