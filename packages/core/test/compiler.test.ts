import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  allocateEventQueueResources,
  attribute,
  bakeCurveLut,
  bakeGradientLut,
  bitonicSortPasses,
  billboard,
  boids,
  burst,
  colorOverLife,
  collideBox,
  collidePlane,
  collideSceneDepth,
  collideSdf,
  collideSphere,
  clampSpawnOrderReservation,
  compileEmitter,
  coreModuleImplementationAccess,
  createCoreKernelModuleRegistry,
  defaultAttributeSampleOffset,
  curve,
  curlNoise,
  defineEmitter,
  defineNeighborGrid,
  defineParameter,
  drag,
  emitTo,
  faceCamera,
  flipbook,
  gradient,
  gravity,
  killVolume,
  KernelModuleRegistry,
  CURL_SIMPLEX_DERIVATIVE_AMPLITUDE,
  TURBULENCE_SIMPLEX_AMPLITUDE,
  linearForce,
  lifetime,
  lightIntensity,
  lightRenderer,
  neighborGridTslModule,
  intensityOverLife,
  decalRenderer,
  meshRenderer,
  orientToVelocity,
  parameter,
  pbdDistanceConstraint,
  perDistance,
  paddedSortCapacity,
  pbdPairCorrection,
  pointAttractor,
  pcgRandomFloat,
  positionSphere,
  positionMeshSurface,
  range,
  rate,
  readEventPayloadRecord,
  resolveRandomSampleSlot,
  sizeOverLife,
  rotationOverLife,
  tslModule,
  turbulence,
  velocityOverLife,
  velocityCone,
  velocityMeshNormal,
  vectorField,
  vortex,
  writeEventPayloadRecord,
} from '../src/index.js';
import { resolveTslBindingInputType } from '../src/attributes.js';

const H2_6_VERSIONED_MODULE_TYPES = new Set([
  'core/collide-box',
  'core/collide-plane',
  'core/collide-sphere',
  'core/kill-volume',
  'core/linear-force',
  'core/point-attractor',
  'core/velocity-cone',
  'core/vortex',
]);

function currentCoreModuleVersion(type: string): number {
  return H2_6_VERSIONED_MODULE_TYPES.has(type) ? 2 : 1;
}

function applyBitonicReference(
  values: readonly { depth: number; index: number }[],
): readonly { depth: number; index: number }[] {
  const output = [...values];
  for (const { blockSize, compareDistance } of bitonicSortPasses(output.length)) {
    for (let invocation = 0; invocation < output.length / 2; invocation += 1) {
      const group = Math.floor(invocation / compareDistance);
      const left = group * compareDistance * 2 + (invocation % compareDistance);
      const right = left + compareDistance;
      const a = output[left]!;
      const b = output[right]!;
      const ascending = Math.floor(left / blockSize) % 2 === 0;
      const comparison = a.depth === b.depth ? a.index - b.index : a.depth - b.depth;
      if ((ascending && comparison > 0) || (!ascending && comparison < 0)) {
        output[left] = b;
        output[right] = a;
      }
    }
  }
  return output;
}

describe('M10 bitonic particle sort contract', () => {
  it.each([
    [
      'billboard',
      () => billboard({ alignment: { axis: [0, 0, 0], mode: 'custom-axis' } }),
      'NACHI_BILLBOARD_AXIS_INVALID',
    ],
    [
      'velocityCone',
      () => velocityCone({ angle: 30, direction: [0, 0, 0], speed: 1 }),
      'NACHI_VELOCITY_CONE_DIRECTION_INVALID',
    ],
    ['rate', () => rate(-1), 'NACHI_SPAWN_RATE_INVALID'],
  ])('throws static %s factory diagnostics eagerly', (_name, factory, code) => {
    try {
      factory();
      throw new Error(`Expected ${String(_name)} to throw.`);
    } catch (error) {
      expect(error).toBeInstanceOf(VfxDiagnosticError);
      expect((error as VfxDiagnosticError).diagnostics).toContainEqual(
        expect.objectContaining({ code }),
      );
    }
  });

  it.each([
    [
      'center',
      () => positionSphere({ center: [0, Number.NaN, 0], radius: 1 }),
      'NACHI_POSITION_SPHERE_CENTER_INVALID',
    ],
    [
      'thetaMax',
      () => positionSphere({ arc: { thetaMax: 0 }, radius: 1 }),
      'NACHI_POSITION_SPHERE_ARC_THETA_INVALID',
    ],
    [
      'axis',
      () => positionSphere({ arc: { axis: [0, 0, 0], thetaMax: 90 }, radius: 1 }),
      'NACHI_POSITION_SPHERE_ARC_AXIS_INVALID',
    ],
  ])('throws static positionSphere %s diagnostics eagerly', (_name, factory, code) => {
    expect(factory).toThrowError(
      expect.objectContaining({ diagnostics: [expect.objectContaining({ code })] }),
    );
  });

  it('pads to 2^n, keeps far sentinels in the skipped prefix, and breaks ties by index', () => {
    const alive = [
      { depth: -2, index: 7 },
      { depth: -8, index: 4 },
      { depth: -2, index: 1 },
      { depth: -5, index: 9 },
      { depth: -3, index: 2 },
    ];
    const padded = paddedSortCapacity(alive.length);
    const padding = Array.from({ length: padded - alive.length }, (_, index) => ({
      depth: -Number.MAX_VALUE,
      index,
    }));
    const first = applyBitonicReference([...padding, ...alive]);
    const second = applyBitonicReference([...padding, ...alive]);
    const visible = first.slice(padded - alive.length);
    expect(padded).toBe(8);
    expect(first).toEqual(second);
    expect(visible.map(({ depth }) => depth)).toEqual([-8, -5, -3, -2, -2]);
    expect(visible.slice(-2).map(({ index }) => index)).toEqual([1, 7]);
    expect(bitonicSortPasses(padded)).toHaveLength(6);
  });

  it('diagnoses a non-finite particle sort center', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: rawConfig(billboard({ blending: 'alpha' }), {
          blending: 'alpha',
          sortCenter: [0, Number.NaN, 0],
        }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_CENTER_INVALID' }),
    );
  });

  it.each([
    ['billboard', 'additive'],
    ['billboard', 'multiply'],
    ['mesh', 'additive'],
    ['mesh', 'multiply'],
  ] as const)('diagnoses raw v2 sorted particle blending and rejects it in the %s helper: %s', (type, blending) => {
    const geometry = { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh.glb' } as const;
    const helper = () =>
      type === 'billboard'
        ? billboard({ blending, sorted: true })
        : meshRenderer({ blending, geometry, sorted: true });
    let helperError: unknown;
    try {
      helper();
    } catch (error) {
      helperError = error;
    }
    expect(helperError).toBeInstanceOf(VfxDiagnosticError);
    expect(helperError instanceof VfxDiagnosticError ? helperError.diagnostics : []).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED' }),
    );

    const render =
      type === 'billboard'
        ? rawConfig(billboard({ blending }), { blending, sorted: true })
        : rawConfig(meshRenderer({ blending, geometry }), { blending, geometry, sorted: true });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render,
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED' }),
    );
  });

  it('diagnoses sorted particle capacity above the bounded WebGPU tier', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 65_537,
        render: billboard({ blending: 'alpha', sorted: true }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_CAPACITY_EXCEEDED' }),
    );
  });
});

describe('H2-13 input validation hardening', () => {
  it.each([
    ['lifetime', () => lifetime(Number.NaN)],
    ['drag', () => drag('0.5' as never)],
    ['gravity', () => gravity([0, Number.POSITIVE_INFINITY, 0])],
    [
      'velocityCone.speed',
      () => velocityCone({ angle: 30, direction: [0, 1, 0], speed: [] as never }),
    ],
  ])('rejects invalid ordinary ValueInput at the %s factory boundary', (_name, factory) => {
    expect(factory).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID' })],
      }),
    );
  });

  it.each([
    ['lifetime.value', () => lifetime(undefined as never)],
    ['drag.value', () => drag(undefined as never)],
    ['gravity.value', () => gravity(undefined as never)],
    ['positionSphere.radius', () => positionSphere({ radius: undefined } as never)],
    [
      'positionSphere.arc.thetaMax',
      () => positionSphere({ arc: { thetaMax: undefined }, radius: 1 } as never),
    ],
    [
      'killVolume.radius',
      () => killVolume({ mode: 'inside', radius: undefined, shape: 'sphere' } as never),
    ],
    [
      'killVolume.size',
      () => killVolume({ mode: 'inside', shape: 'box', size: undefined } as never),
    ],
    [
      'velocityCone.speed',
      () =>
        velocityCone({
          angle: 30,
          direction: [0, 1, 0],
          speed: undefined,
        } as never),
    ],
  ])('rejects missing required ValueInput at the %s factory boundary', (_name, factory) => {
    expect(factory).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID' })],
      }),
    );
  });

  it.each([
    ['lifetime.value', lifetime(1), { value: undefined }, 'init[0].config.value'],
    ['drag.value', drag(1), { value: undefined }, 'update[0].config.value'],
    ['gravity.value', gravity(1), { value: undefined }, 'update[0].config.value'],
    [
      'positionSphere.radius',
      positionSphere({ radius: 1 }),
      { radius: undefined },
      'init[0].config.radius',
    ],
    [
      'positionSphere.arc.thetaMax',
      positionSphere({ arc: { thetaMax: 90 }, radius: 1 }),
      { arc: { thetaMax: undefined }, radius: 1 },
      'init[0].config.arc.thetaMax',
    ],
    [
      'killVolume.radius',
      killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }),
      { mode: 'inside', radius: undefined, shape: 'sphere' },
      'update[0].config.radius',
    ],
    [
      'killVolume.size',
      killVolume({ mode: 'inside', shape: 'box', size: [1, 1, 1] }),
      { mode: 'inside', shape: 'box', size: undefined },
      'update[0].config.size',
    ],
    [
      'velocityCone.speed',
      velocityCone({ angle: 30, direction: [0, 1, 0], speed: 1 }),
      { angle: 30, direction: [0, 1, 0], space: 'world', speed: undefined },
      'init[0].config.speed',
    ],
  ])('rejects missing required ValueInput at the raw %s compiler boundary', (_name, valid, config, path) => {
    const invalid = { ...valid, config };
    const program = compileEmitter(
      invalid.stage === 'init'
        ? { ...baseEmitter({ init: [invalid] }), integration: 'none' }
        : { ...baseEmitter({ integration: 'none', update: [invalid] }) },
    );

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID', path }),
    );
  });

  it.each([
    ['missing path', { kind: 'parameter' }],
    ['numeric path', { kind: 'parameter', path: 123 }],
    ['null path', { kind: 'parameter', path: null }],
  ])('rejects a parameter ValueInput with %s at the factory boundary', (_name, value) => {
    expect(() => lifetime(value as never)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID' })],
      }),
    );
  });

  it.each([
    ['missing path', { kind: 'parameter' }],
    ['numeric path', { kind: 'parameter', path: 123 }],
    ['null path', { kind: 'parameter', path: null }],
  ])('rejects a parameter ValueInput with %s at the raw compiler boundary', (_name, value) => {
    const invalidLifetime = { ...lifetime(1), config: { value } };
    const program = compileEmitter({ ...baseEmitter(), init: [invalidLifetime] });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_VALUE_INPUT_INVALID',
        path: 'init[0].config.value',
      }),
    );
  });

  it('keeps direct compiler input on the same ordinary ValueInput validator', () => {
    const invalidLifetime = { ...lifetime(1), config: { value: Number.NEGATIVE_INFINITY } };
    const program = compileEmitter({ ...baseEmitter(), init: [invalidLifetime] });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_VALUE_INPUT_INVALID',
        path: 'init[0].config.value',
      }),
    );
  });

  it('rejects a parameter generator whose declared type does not match its ValueInput field', () => {
    const wind = defineParameter('User.wind', { default: [0, 1, 0], type: 'vec3' });
    const program = compileEmitter({
      ...baseEmitter(),
      init: [{ ...lifetime(1), config: { value: parameter('User.wind') } }],
      parameters: { 'User.wind': wind },
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_VALUE_INPUT_INVALID',
        path: 'init[0].config.value',
      }),
    );
  });

  it.each([
    [
      'User f32 -> positionSphere.center',
      {
        ...positionSphere({ center: [0, 0, 0], radius: 1 }),
        config: { center: parameter('User.scalar'), radius: 1 },
      },
      { 'User.scalar': defineParameter('User.scalar', { default: 1, type: 'f32' }) },
      'init[0].config.center',
    ],
    [
      'User vec3 -> positionSphere.arc.thetaMax',
      {
        ...positionSphere({ arc: { thetaMax: 90 }, radius: 1 }),
        config: { arc: { thetaMax: parameter('User.vector') }, radius: 1 },
      },
      {
        'User.vector': defineParameter('User.vector', {
          default: [0, 1, 0],
          type: 'vec3',
        }),
      },
      'init[0].config.arc.thetaMax',
    ],
    [
      'System.time -> positionSphere.center',
      {
        ...positionSphere({ center: [0, 0, 0], radius: 1 }),
        config: { center: parameter('System.time'), radius: 1 },
      },
      {},
      'init[0].config.center',
    ],
    [
      'System.viewportSize -> gravity',
      { ...gravity(0), config: { value: parameter('System.viewportSize') } },
      {},
      'update[0].config.value',
    ],
  ])('validates materialized parameter types for %s', (_name, module, parameters, path) => {
    const definition =
      module.stage === 'init'
        ? { ...baseEmitter({ init: [module] }), parameters }
        : { ...baseEmitter({ update: [module] }), parameters };
    const program = compileEmitter(definition);

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID', path }),
    );
  });

  it.each([
    [
      'System.time -> positionSphere.center',
      () => positionSphere({ center: parameter('System.time') as never, radius: 1 }),
    ],
    ['System.viewportSize -> gravity', () => gravity(parameter('System.viewportSize') as never)],
  ])('rejects mismatched built-in parameter type at the %s factory boundary', (_name, factory) => {
    expect(factory).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_VALUE_INPUT_INVALID' })],
      }),
    );
  });

  it('keeps legal scalar/vec3 constants, ranges, curves, and parameters valid', () => {
    const parameters = {
      'User.scalar': defineParameter('User.scalar', { default: 1, type: 'f32' }),
      'User.vector': defineParameter('User.vector', {
        default: [0, 1, 0],
        type: 'vec3',
      }),
    };
    const program = compileEmitter({
      ...baseEmitter({
        init: [
          positionSphere({
            arc: { thetaMax: parameter('User.scalar') },
            center: parameter<[number, number, number]>('User.vector'),
            radius: range(0.5, 1),
          }),
          lifetime(curve([0, 0.5], [1, 1])),
        ],
        update: [
          gravity([0, -9.8, 0]),
          gravity(range([0, -10, 0], [0, -9, 0])),
          gravity(curve([0, [0, -10, 0]], [1, [0, -9, 0]])),
          gravity(parameter<[number, number, number]>('User.vector')),
          drag(parameter<number>('System.time')),
          sizeOverLife(curve([0, 1], [1, 0])),
        ],
      }),
      parameters,
    });

    expect(program.diagnostics.map(({ code }) => code)).not.toContain('NACHI_VALUE_INPUT_INVALID');
  });

  it('keeps optional omissions and string-path parameters without fallbacks valid', () => {
    expect(() => collideSceneDepth({})).not.toThrow();
    expect(() => positionSphere({ radius: 1 })).not.toThrow();
    expect(() => pointAttractor({ position: [0, 0, 0], strength: 1 })).not.toThrow();
    expect(() => vortex({ axis: [0, 1, 0], strength: 1 })).not.toThrow();
    expect(() => killVolume({ mode: 'inside', normal: [0, 1, 0], shape: 'plane' })).not.toThrow();

    const scalar = defineParameter('User.scalar', { default: 1, type: 'f32' });
    const program = compileEmitter({
      ...baseEmitter({ init: [lifetime(parameter('User.scalar'))] }),
      parameters: { 'User.scalar': scalar },
    });
    expect(program.diagnostics.map(({ code }) => code)).not.toContain('NACHI_VALUE_INPUT_INVALID');
  });

  it.each([Number.NaN, 1.5, 0, 5])('rejects invalid turbulence octave count %s', (octaves) => {
    expect(() => turbulence({ frequency: 1, octaves, strength: 1 })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_TURBULENCE_OCTAVES_INVALID' })],
      }),
    );
  });

  it.each(['slide', '', 0])('rejects unknown collision mode %s', (mode) => {
    expect(() => collidePlane({ mode: mode as never, normal: [0, 1, 0], offset: 0 })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_COLLISION_MODE_INVALID' })],
      }),
    );
  });

  it.each([
    ['plane', () => collidePlane({ normal: [0, 1, 0], offset: 0 } as never)],
    ['sphere', () => collideSphere({ center: [0, 0, 0], radius: 1 } as never)],
    ['box', () => collideBox({ center: [0, 0, 0], size: [1, 1, 1] } as never)],
    [
      'sdf',
      () =>
        collideSdf({
          field: { assetType: 'sdf', kind: 'asset-ref', uri: 'missing-mode' },
        } as never),
    ],
  ])('requires collision mode at the %s factory boundary', (_name, factory) => {
    expect(factory).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_COLLISION_MODE_INVALID' })],
      }),
    );
  });

  it.each([
    ['plane', collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 })],
    ['sphere', collideSphere({ center: [0, 0, 0], mode: 'bounce', radius: 1 })],
    ['box', collideBox({ center: [0, 0, 0], mode: 'bounce', size: [1, 1, 1] })],
    [
      'sdf',
      collideSdf({
        field: { assetType: 'sdf', kind: 'asset-ref', uri: 'missing-mode' },
        mode: 'bounce',
      }),
    ],
  ])('requires collision mode for raw %s compiler input', (_name, valid) => {
    const raw = { ...valid, config: { ...valid.config, mode: undefined } };
    const program = compileEmitter({ ...baseEmitter(), update: [raw] });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_COLLISION_MODE_INVALID' }),
    );
  });

  it('diagnoses normalizedAge reads without both age and lifetime ownership', () => {
    const normalizedAgeReader = {
      access: { reads: ['Particles.normalizedAge'], writes: [] },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/normalized-age-reader',
      version: 1,
    } as const;
    const program = compileEmitter({
      ...baseEmitter({ integration: 'none' }),
      render: normalizedAgeReader,
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME' }),
    );
  });

  it('uses write ownership rather than read-driven allocation for normalizedAge diagnostics', () => {
    const reader = {
      access: {
        reads: ['Particles.age', 'Particles.lifetime', 'Particles.normalizedAge'],
        writes: [],
      },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/normalized-age-read-only-allocation',
      version: 1,
    } as const;
    const readsOnly = compileEmitter({ ...baseEmitter({ integration: 'none' }), render: reader });
    expect(readsOnly.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME' }),
    );

    const writeAgeAndLifetime = {
      access: { reads: [], writes: ['Particles.age', 'Particles.lifetime'] },
      config: {},
      kind: 'module',
      stage: 'init',
      type: 'test/write-age-and-lifetime',
      version: 1,
    } as const;
    const owned = compileEmitter({
      ...baseEmitter({ init: [writeAgeAndLifetime], integration: 'none' }),
      render: reader,
    });
    expect(owned.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME',
    );

    const writeNormalizedAge = {
      access: { reads: [], writes: ['Particles.normalizedAge'] },
      config: {},
      kind: 'module',
      stage: 'init',
      type: 'test/write-normalized-age',
      version: 1,
    } as const;
    const explicitlyOwned = compileEmitter({
      ...baseEmitter({ init: [writeNormalizedAge], integration: 'none' }),
      render: reader,
    });
    expect(explicitlyOwned.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME',
    );
  });

  it('accepts the ValueInput and octave boundaries', () => {
    expect(() => lifetime(0)).not.toThrow();
    expect(() => gravity([0, -9.8, 0])).not.toThrow();
    expect(() => turbulence({ frequency: 1, octaves: 1, strength: 0 })).not.toThrow();
    expect(() => turbulence({ frequency: 1, octaves: 4, strength: 1 })).not.toThrow();
  });
});

describe('M12 neighbor-module diagnostic coverage', () => {
  const neighbors = defineNeighborGrid({ resolution: [4, 4, 4] });

  it('asserts the boids value diagnostic code', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [
          rawConfig(boids({ grid: 'neighbors' }), {
            alignment: Number.NaN,
            grid: 'neighbors',
          }),
        ],
      }),
      { neighborGrids: { neighbors } },
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BOIDS_VALUE_INVALID' }),
    );
  });

  it('asserts distance, iterations, and stiffness diagnostics for PBD', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [
          rawConfig(pbdDistanceConstraint({ distance: 1, grid: 'neighbors' }), {
            distance: 0,
            grid: 'neighbors',
            iterations: 0,
            stiffness: 2,
          }),
        ],
      }),
      { neighborGrids: { neighbors } },
    );
    expect(program.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_PBD_DISTANCE_INVALID',
        'NACHI_PBD_ITERATIONS_INVALID',
        'NACHI_PBD_STIFFNESS_INVALID',
      ]),
    );
  });

  it('enforces defensive capacity, PBD-iteration, and prewarm limits before materialization', () => {
    const valid = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const oversized = compileEmitter(
      {
        ...valid,
        capacity: 2 ** 22 + 1,
        lifecycle: { prewarm: 301 },
        update: [
          rawConfig(pbdDistanceConstraint({ distance: 1, grid: 'neighbors' }), {
            distance: 1,
            grid: 'neighbors',
            iterations: 65,
          }),
        ],
      },
      { neighborGrids: { neighbors } },
    );
    expect(oversized.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_EMITTER_CAPACITY_LIMIT_EXCEEDED',
        'NACHI_LIFECYCLE_PREWARM_LIMIT_EXCEEDED',
        'NACHI_PBD_ITERATIONS_LIMIT_EXCEEDED',
      ]),
    );
    expect(() => oversized.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('uses one emitter-local cell-coordinate path for bucket, boids, custom, and PBD lookups', () => {
    const custom = neighborGridTslModule(
      {
        access: { reads: ['Particles.position'], writes: [] },
        grid: 'neighbors',
        radius: 1,
      },
      (context) => {
        context.forEachNeighbor(() => undefined);
        return {};
      },
    );
    expect(custom.access?.reads).toContain('Emitter.transform');
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
        update: [
          boids({ grid: 'neighbors', radius: 1 }),
          custom,
          pbdDistanceConstraint({ distance: 0.5, grid: 'neighbors', radius: 1 }),
        ],
      }),
      { neighborGrids: { neighbors } },
    );
    let inverseCalls = 0;
    const base = fakeAdapter();
    const adapter: KernelTslAdapter = {
      ...base,
      floor: base.uint,
      inverse(value) {
        inverseCalls += 1;
        return base.inverse(value);
      },
      loop(_range, callback) {
        callback(base.uint(0));
      },
    };

    program.buildKernels(adapter);
    expect(inverseCalls).toBe(4);
  });

  it('supplements pre-H2-5 v1 neighbor access manifests without mutating the source definition', () => {
    const currentBoids = boids({ grid: 'neighbors', radius: 1 });
    const currentPbd = pbdDistanceConstraint({ distance: 0.5, grid: 'neighbors' });
    const legacy = [currentBoids, currentPbd].map((module) => {
      if (!module.access) throw new Error('Expected built-in neighbor access metadata.');
      return {
        ...module,
        access: {
          ...module.access,
          reads: module.access.reads.filter((read) => read !== 'Emitter.transform'),
        },
      };
    });
    const definition = defineEmitter({
      capacity: 4,
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: legacy,
    });

    const program = compileEmitter(definition, { neighborGrids: { neighbors } });
    expect(program.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_MODULE_ACCESS_MISMATCH' }),
    );
    expect(
      program.kernels.update.modules
        .filter(({ type }) => type === 'core/boids')
        .every(({ access }) => access.reads.includes('Emitter.transform')),
    ).toBe(true);
    expect(
      program.kernels.update.modules
        .filter(({ type }) => type === 'core/pbd-distance-constraint')
        .every(({ access }) => access.reads.includes('Emitter.transform')),
    ).toBe(true);
    expect(legacy.every(({ access }) => !access.reads.includes('Emitter.transform'))).toBe(true);
  });
});
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
  ModuleStage,
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

function rawConfig<Module extends ModuleDefinition<ModuleStage, object>>(
  module: Module,
  config: object,
): Module {
  return { ...module, config } as Module;
}

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

class BindingInputCaptureNode extends FakeNode {
  constructor(private readonly inputs: unknown[]) {
    super();
  }

  override add(value?: KernelNodeInput): KernelNode {
    this.inputs.push(value);
    return this;
  }
}

class BindingInputCaptureStorage extends FakeStorage {
  constructor(private readonly inputs: unknown[]) {
    super();
  }

  override element(): KernelNode {
    return new BindingInputCaptureNode(this.inputs);
  }
}

class TslLikeFakeNode extends FakeNode {
  readonly isNode = true;

  getNodeType(): string {
    return 'vec3';
  }
}

class StatementTraceNode extends FakeNode {
  constructor(
    private readonly label: string,
    private readonly assignments: string[],
  ) {
    super();
  }

  override get x(): KernelNode {
    return new StatementTraceNode(`${this.label}.x`, this.assignments);
  }

  override get y(): KernelNode {
    return new StatementTraceNode(`${this.label}.y`, this.assignments);
  }

  override get z(): KernelNode {
    return new StatementTraceNode(`${this.label}.z`, this.assignments);
  }

  override get w(): KernelNode {
    return new StatementTraceNode(`${this.label}.w`, this.assignments);
  }

  override assign(): KernelNode {
    this.assignments.push(this.label);
    return this;
  }
}

class StatementTraceStorage extends FakeStorage {
  #name = 'unnamed';

  constructor(private readonly assignments: string[]) {
    super();
  }

  override element(): KernelNode {
    return new StatementTraceNode(this.#name, this.assignments);
  }

  override setName(name?: string): KernelStorageNode {
    if (name !== undefined) this.#name = name;
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
  version = currentCoreModuleVersion(type),
): { reads: string[]; writes: string[] } {
  const implementation = createCoreKernelModuleRegistry().resolve(type, version);
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
    version,
  };
  const node = (path: string) => new AccessTraceNode(trace, path);
  const context: KernelModuleBuildContext = {
    adapter: fakeAdapter(),
    module,
    attribute: (name) => node(`Particles.${name}`),
    emitEvent: () => undefined,
    random: () => {
      trace.reads.add('Emitter.seed');
      if (implementation.stage === 'init') trace.reads.add('Particles.spawnOrder');
      else if (implementation.stage === 'update') {
        trace.reads.add('Particles.spawnOrder');
        trace.reads.add('Emitter.updateRandomStep');
      } else trace.reads.add('Particles.spawnGeneration');
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
      sceneDepth: true,
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
    mat4: node,
    sampleTexture: node,
    sampleSceneDepth: node,
    sampleMeshSurface: () => ({ normal: node(), position: node() }),
    sampleSdf: (_field, position) => {
      markAccessRead(position);
      return { distance: node(), gradient: node() };
    },
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
          .filter(
            ({ name }) => name !== 'alive' && name !== 'spawnGeneration' && name !== 'spawnOrder',
          )
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

  it('keeps all-slots, free-list, and event-spawn Init random streams bit-identical', () => {
    const target = compileEmitter(
      defineEmitter({
        capacity: 4,
        init: [lifetime(range(0.1, 0.2))],
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 0 }),
      }),
    );
    const source = compileEmitter(
      defineEmitter({
        capacity: 4,
        events: { onDeath: emitTo('target') },
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    );
    const adapter = fakeAdapter();
    const queue = source.events[0]!;
    const resources = allocateEventQueueResources(adapter, queue, 'source');
    const handler = queue.handlers[0]!;
    const numericBitXors: number[] = [];
    const capture = () => new CaptureBitXorNode(numericBitXors);

    target.buildKernels(
      { ...adapter, instanceIndex: capture(), uint: capture },
      {
        eventInputs: [{ handler, queue, resources, sourceKey: 'source' }],
      },
    );

    expect(numericBitXors).toEqual([2_941_967_914, 2_941_967_914, 2_941_967_914]);
  });

  it('assigns independent range sample offsets to every M4 force config field', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          pointAttractor({
            falloff: range(1, 2),
            position: range([0, 0, 0] as const, [1, 2, 3] as const),
            radius: range(2, 3),
            strength: range(3, 4),
          }),
        ],
      }),
    );
    const numericBitXors: number[] = [];
    const capture = () => new CaptureBitXorNode(numericBitXors);

    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        instanceIndex: capture(),
        uint: capture,
      }),
    ).not.toThrow();
    expect(numericBitXors).toHaveLength(6);
    expect(new Set(numericBitXors).size).toBe(6);
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
    ).toEqual(['Emitter.seed', 'Emitter.spawnInterpolatedTransform', 'Particles.spawnOrder']);
  });

  it('derives spawn-order and dispatch-step reads for Update range generators', () => {
    const program = compileEmitter(
      baseEmitter({ integration: 'none', update: [gravity(range(1, 2))] }),
    );
    expect(
      program.kernels.update.modules.find(({ type }) => type === 'core/gravity')?.access.reads,
    ).toEqual([
      'Emitter.deltaTime',
      'Particles.velocity',
      'Emitter.seed',
      'Particles.spawnOrder',
      'Emitter.updateRandomStep',
    ]);
    expect(program.attributeSchema.byName.spawnOrder).toBeDefined();
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
          physicalIndex: 'sorted-indices',
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

  it('compiles lit billboard physical parameters and tangent-space normal maps', () => {
    const normalMap = { assetType: 'texture', kind: 'asset-ref', uri: 'normal' } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 2,
        render: billboard({ lit: { metalness: 0.1, normalMap, roughness: 0.65 } }),
        spawn: burst({ count: 1 }),
      }),
    );
    const draw = program.draws[0];
    if (draw?.kind !== 'billboard') throw new Error('Expected a billboard draw.');

    expect(draw.fragment.lit).toEqual({ metalness: 0.1, normalMap, roughness: 0.65 });
    const defaults = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ lit: true }),
        spawn: burst({ count: 1 }),
      }),
    ).draws[0];
    if (defaults?.kind !== 'billboard') throw new Error('Expected lit defaults.');
    expect(defaults.fragment.lit).toEqual({ metalness: 0, roughness: 0.8 });
    expect(
      compileEmitter(
        defineEmitter({
          capacity: 1,
          render: rawConfig(billboard({}), {
            lit: { metalness: -0.1, roughness: 1.1 },
          }),
          spawn: burst({ count: 1 }),
        }),
      ).diagnostics.map(({ code }) => code),
    ).toEqual(
      expect.arrayContaining([
        'NACHI_BILLBOARD_LIT_METALNESS_INVALID',
        'NACHI_BILLBOARD_LIT_ROUGHNESS_INVALID',
      ]),
    );
  });

  it('materializes opt-in padded bitonic passes without replacing compaction indices', () => {
    const definition = defineEmitter({
      capacity: 7,
      init: [positionSphere({ radius: 1 }), lifetime(2)],
      integration: 'none',
      render: billboard({ blending: 'alpha', sortCenter: [0, 0, 2], sorted: true }),
      spawn: burst({ count: 5 }),
    });
    const program = compileEmitter(definition);
    const draw = program.draws[0];
    expect(draw).toMatchObject({
      coarseSortCenter: [0, 0, 2],
      indirect: { physicalIndex: 'sorted-indices', sortedPaddedCapacity: 8 },
    });
    const kernels = program.buildKernels(fakeAdapter());
    expect(kernels.aliveIndices).toBeDefined();
    expect(kernels.sortedIndices).toBeDefined();
    expect(kernels.sortedIndices).not.toBe(kernels.aliveIndices);
    expect(kernels.sortPaddedCapacity).toBe(8);
    expect(kernels.sortPasses).toHaveLength(6);

    let webglError: unknown;
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
      webglError = error;
    }
    expect(webglError).toBeInstanceOf(VfxDiagnosticError);
    expect((webglError as VfxDiagnosticError).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_WEBGL2_UNSUPPORTED' }),
      ]),
    );
  });

  it('elides depth-sort submissions for a capacity-one sorted draw', () => {
    const kernels = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: billboard({ blending: 'alpha' }),
        spawn: burst({ count: 1 }),
      }),
    ).buildKernels(fakeAdapter());

    expect(kernels.sortPaddedCapacity).toBe(1);
    expect(kernels.sortedIndices).toBeDefined();
    expect(kernels.prepareSort).toBeUndefined();
    expect(kernels.sortPasses).toEqual([]);
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
    if (draw?.kind !== 'billboard') throw new Error('Expected a billboard draw.');
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
    if (draw?.kind !== 'billboard') throw new Error('Expected a billboard draw.');
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
    if (validDraw?.kind !== 'billboard') throw new Error('Expected billboard.');
    expect(validDraw.fragment.soft).toEqual({ fadeDistance: 0.08 });

    const invalid = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: rawConfig(billboard({}), { soft: { fadeDistance: 0 } }),
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
      indirect: { instanceCount: 'alive-count', physicalIndex: 'sorted-indices' },
      kind: 'mesh',
      vertex: {
        alignment: { mode: 'velocity' },
        attributes: expect.arrayContaining(['position', 'scale', 'color', 'velocity']),
      },
    });
    expect(program.meta.backendBudgets.webgpu.vertexStorageBufferCount).toBeLessThanOrEqual(8);
  });

  it.each([
    ['billboard-alpha', () => billboard({ blending: 'alpha' })],
    ['billboard-premultiplied', () => billboard({ blending: 'premultiplied' })],
    [
      'mesh-alpha',
      () =>
        meshRenderer({
          blending: 'alpha',
          geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh' },
        }),
    ],
    [
      'mesh-premultiplied',
      () =>
        meshRenderer({
          blending: 'premultiplied',
          geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh' },
        }),
    ],
    ['decal-alpha', () => decalRenderer({ blending: 'alpha' })],
    ['decal-premultiplied', () => decalRenderer({ blending: 'premultiplied' })],
  ])('defaults omitted v2 particle sort on for %s', (_name, render) => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        integration: 'none',
        render: render(),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.draws[0]).toMatchObject({
      automaticRenderOrder: true,
      indirect: { physicalIndex: 'sorted-indices', sortedPaddedCapacity: 4 },
      moduleVersion: 2,
      renderOrderOffset: 0,
    });
  });

  it('preserves v1 renderer omission semantics and ignores v2-only fields', () => {
    const authored = billboard({ blending: 'alpha' });
    const legacy = {
      ...authored,
      config: {
        blending: 'alpha',
        renderOrderOffset: 0.5,
        sortCenter: [1, 2, 3],
      },
      version: 1,
    } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        integration: 'none',
        render: legacy,
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_RENDER_ORDER_OFFSET_INVALID' }),
    );
    expect(program.draws[0]).toMatchObject({
      automaticRenderOrder: true,
      coarseSortCenter: [1, 2, 3],
      indirect: { physicalIndex: 'alive-indices' },
      moduleVersion: 1,
      renderOrderOffset: 0,
    });
  });

  it('rejects unsupported built-in renderer versions without compiling a draw', () => {
    const authored = billboard({ sorted: false });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: { ...authored, version: 99 },
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.draws).toEqual([]);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_MODULE_UNKNOWN', path: 'render[0]' }),
    );
  });

  it.each([
    'core/billboard',
    'core/mesh-renderer',
  ] as const)('rejects non-boolean renderer@2 sorted without enabling its sort path: %s', (type) => {
    const render =
      type === 'core/billboard'
        ? billboard({ sorted: false })
        : meshRenderer({
            geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh' },
            sorted: false,
          });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: { ...render, config: { ...render.config, sorted: 'yes' } },
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARTICLE_SORT_VALUE_INVALID' }),
    );
    expect(program.draws[0]).toMatchObject({ indirect: { physicalIndex: 'alive-indices' } });
  });

  it('inserts the v2 decal spawn-rotation default after generic defaults and before author Init', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [lifetime(2)],
        integration: 'none',
        render: decalRenderer({ sorted: false }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(
      program.kernels.init.modules.slice(0, 3).map(({ path, type }) => ({ path, type })),
    ).toEqual([
      { path: 'init[$defaults]', type: 'core/defaults' },
      {
        path: 'init[$decal-spawn-rotation]',
        type: 'core/decal-spawn-rotation',
      },
      { path: 'init[0]', type: 'core/lifetime' },
    ]);
    expect(program.kernels.init.modules[1]?.access).toEqual({
      reads: ['Emitter.spawnInterpolatedRotation'],
      writes: ['Particles.rotation'],
    });
  });

  it('compiles bounded light selection with orthogonal color/intensity over-life attributes', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 16,
        init: [positionSphere({ radius: 0 }), lifetime(1), lightIntensity(12)],
        integration: 'none',
        render: lightRenderer({ maxLights: 4, priority: 'intensity-radius', radiusScale: 2 }),
        spawn: burst({ count: 16 }),
        update: [
          colorOverLife(gradient('#fff', '#f00')),
          intensityOverLife(curve([0, 10], [1, 0])),
        ],
      }),
    );
    expect(program.draws[0]).toMatchObject({
      kind: 'light',
      maxLights: 4,
      priority: 'intensity-radius',
      radiusScale: 2,
      readback: { latencyFrames: 1 },
      requiresBackend: 'webgpu',
    });
    expect(program.attributeSchema.byName).toHaveProperty('intensity');
    expect(program.attributeSchema.byName).toHaveProperty('spawnOrder');
    expect(program.draws[0]?.vertex.attributes).toContain('spawnOrder');
    expect(
      program.kernels.update.modules.find(({ type }) => type === 'core/intensity-over-life')?.lutId,
    ).toBeDefined();
    expect(program.draws[0]?.vertex.storageBuffers).not.toContain('NachiLifecycleState');
    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: { ...fakeAdapter().capabilities, backend: 'webgl2' },
      }),
    ).toThrowError('The light renderer requires WebGPU storage selection');
  });

  it('supplements spawnOrder for pre-H2-4 light access manifests without mutating them', () => {
    const current = lightRenderer({ maxLights: 2 });
    const legacy = {
      ...current,
      access: {
        ...current.access!,
        reads: current.access!.reads.filter((read) => read !== 'Particles.spawnOrder'),
      },
    };
    const definition = defineEmitter({
      capacity: 4,
      integration: 'none',
      render: legacy,
      spawn: burst({ count: 1 }),
    });

    const program = compileEmitter(definition);

    expect(legacy.access.reads).not.toContain('Particles.spawnOrder');
    expect(program.diagnostics).toEqual([]);
    expect(program.attributeSchema.byName.spawnOrder).toBeDefined();
    expect(program.draws).toContainEqual(
      expect.objectContaining({
        kind: 'light',
        vertex: expect.objectContaining({
          attributes: ['alive', 'color', 'intensity', 'position', 'size', 'spawnOrder'],
        }),
      }),
    );
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('does not publish a light draw after invalid pool-bound diagnostics', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: rawConfig(lightRenderer(), { maxLights: 0, radiusScale: -1 }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.draws).toEqual([]);
    expect(program.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['NACHI_LIGHT_COUNT_INVALID', 'NACHI_LIGHT_RADIUS_INVALID']),
    );
  });

  it('diagnoses an invalid light selection priority instead of treating it as intensity', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: rawConfig(lightRenderer(), { priority: 'distance' }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.draws).toEqual([]);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_LIGHT_PRIORITY_INVALID',
        path: 'render[0].config.priority',
      }),
    );
  });

  it('compiles a depth-reconstructed decal and rejects missing depth capability', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        init: [positionSphere({ radius: 0 }), lifetime(2)],
        integration: 'none',
        render: decalRenderer({ fadeOverLife: true, sizeScale: 1.5 }),
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.draws[0]).toMatchObject({
      fadeOverLife: true,
      geometry: { shape: 'projection-box' },
      kind: 'decal',
      requiresBackend: 'webgpu',
      requiresSceneDepth: true,
      sizeScale: 1.5,
    });
    const missingDepth = fakeAdapter();
    const { sampleSceneDepth: _sampleSceneDepth, ...missingDepthAdapter } = missingDepth;
    void _sampleSceneDepth;
    expect(() =>
      program.buildKernels({
        ...missingDepthAdapter,
        capabilities: { ...missingDepth.capabilities, sceneDepth: false },
      }),
    ).toThrowError(
      'The decal renderer requires an explicit sampleable previous-frame scene-depth texture',
    );
    const adapter = fakeAdapter();
    expect(() =>
      program.buildKernels({
        ...adapter,
        capabilities: { ...adapter.capabilities, sceneDepth: true, sceneDepthSampleCount: 1 },
        sampleSceneDepth: () => new FakeNode(),
      }),
    ).not.toThrow();
  });

  it('diagnoses invalid decal blending and fade-over-life values', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: rawConfig(decalRenderer(), {
          blending: 'additive' as never,
          fadeOverLife: 'yes' as never,
        }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(program.draws).toEqual([]);
    expect(program.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'NACHI_DECAL_BLENDING_INVALID',
          path: 'render[0].config.blending',
        }),
        expect.objectContaining({
          code: 'NACHI_DECAL_FADE_OVER_LIFE_INVALID',
          path: 'render[0].config.fadeOverLife',
        }),
      ]),
    );
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
        render: rawConfig(meshRenderer({ geometry }), {
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
        render: rawConfig(billboard({}), {
          cutout: { vertices: 9 },
          map: { ...flipbook(atlas, { cols: 1, rows: 1 }), cols: 0 },
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
        render: rawConfig(billboard({}), {
          alignment: { axis: [0, 0, 0], mode: 'custom-axis' },
        }),
        spawn: burst({ count: 1 }),
      }),
    );
    const invalidStretch = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: rawConfig(billboard({}), {
          alignment: { factor: -1, mode: 'velocity-stretch' },
        }),
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

  it('advances spawn order only by successful free-list reservations under saturation', () => {
    let freeCount = 4;
    let nextSpawnOrder = 0;
    let successfulSpawns = 0;
    for (const requested of [3, 3, 3]) {
      const reserved = clampSpawnOrderReservation(requested, freeCount);
      nextSpawnOrder += reserved;
      successfulSpawns += reserved;
      freeCount -= reserved;
    }

    expect(successfulSpawns).toBe(4);
    expect(nextSpawnOrder).toBe(successfulSpawns);
    expect(clampSpawnOrderReservation(8, 0)).toBe(0);
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

    const ordered = compileEmitter({
      ...baseEmitter(),
      render: {
        access: { reads: ['Particles.spawnOrder'], writes: [] },
        config: {},
        kind: 'module',
        stage: 'render',
        type: 'test/spawn-order-reader',
        version: 1,
      },
    });
    expect(ordered.meta.lifecycleStorage.buffers.state.wordCount).toBe(30);
    expect(ordered.meta.lifecycleStorage.buffers.state.fields.nextSpawnOrder.wordCount).toBe(1);
    expect(ordered.meta.lifecycleStorage.buffers.state.fields.currentSpawnBase.wordCount).toBe(1);
    expect(ordered.meta.lifecycleStorage.buffers.state.fields.birthIndices.wordCount).toBe(8);
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
    const built = compileEmitter(baseEmitter({ integration: 'none' })).buildKernels({
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

  it('allows unused higher packed groups on WebGL2', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 8,
        integration: 'none',
        render: billboard({ blending: 'alpha', sorted: false }),
        spawn: burst({ count: 8 }),
      }),
    );
    const packed = program.attributeSchema.storageArrays.find(
      ({ groupCount, packed }) => packed && groupCount > 1,
    );
    expect(packed?.attributes).toEqual(
      expect.arrayContaining(['position', 'size', 'spriteRotation']),
    );
    expect(program.attributeSchema.byName.spriteRotation?.physical.group).toBe(1);

    expect(() =>
      program.buildKernels({
        ...fakeAdapter(),
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
      }),
    ).not.toThrow();
  });

  it('rejects multi-group packed particle storage on WebGL2 before TF groups alias', () => {
    const aliasesPackedGroups = tslModule(({ position, velocity }) => ({
      position: position.add(velocity),
    }));
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [aliasesPackedGroups],
      }),
    );
    const packed = program.attributeSchema.storageArrays.find(
      ({ groupCount, packed }) => packed && groupCount > 1,
    );
    expect(packed?.attributes).toEqual(expect.arrayContaining(['position', 'velocity']));

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
        code: 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED',
        path: `attributeSchema.storageArrays.${packed?.index}.groupCount`,
      }),
    );
  });

  it('rejects WebGL2 initialize when all physical attribute buffers exceed the TF budget', () => {
    const zero4 = [0, 0, 0, 0] as const;
    const program = compileEmitter(
      defineEmitter({
        attributes: {
          customA: attribute('customA', { default: zero4, type: 'vec4' }),
          customB: attribute('customB', { default: zero4, type: 'vec4' }),
          customC: attribute('customC', { default: zero4, type: 'vec4' }),
        },
        capacity: 8,
        init: [lifetime(1)],
        integration: 'none',
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    );
    expect(program.meta.backendBudgets.webgl2).toMatchObject({
      defaultInitializeVaryingLimit: 4,
      initializeVaryingCount: 5,
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
        path: 'meta.backendBudgets.webgl2.initializeVaryingCount',
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
    ['particle spawn order from init', 'init', 'Particles.spawnOrder', 'init[0].access.writes[0]'],
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
    const program = compileEmitter({
      ...baseEmitter(),
      spawn: rawConfig(rate(0), { rate: -1 }),
    });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_RATE_INVALID', path: 'spawn[0].config.rate' }),
    );
  });

  it('diagnoses invalid per-distance spawn values', () => {
    const program = compileEmitter({
      ...baseEmitter(),
      spawn: rawConfig(perDistance(0), { rate: Number.NaN }),
    });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_SPAWN_RATE_INVALID' }),
    );
  });

  it('diagnoses non-positive burst cycle counts', () => {
    const program = compileEmitter({
      ...baseEmitter(),
      spawn: rawConfig(burst({ count: 1 }), { count: 1, cycles: 0 }),
    });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_BURST_CYCLES_INVALID' }),
    );
  });

  it.each([
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
  ])('diagnoses invalid burst count %s', (count) => {
    const program = compileEmitter({
      ...baseEmitter(),
      spawn: rawConfig(burst({ count: 1 }), { count }),
    });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BURST_COUNT_INVALID',
        path: 'spawn[0].config.count',
      }),
    );
  });

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

  it('does not duplicate an invalid burst parameter diagnostic when its fallback is also invalid', () => {
    const program = compileEmitter({
      ...baseEmitter(),
      parameters: {
        'User.count': defineParameter('User.count', {
          default: [1, 2, 3],
          type: 'vec3',
        }),
      },
      spawn: rawConfig(burst({ count: 1 }), {
        count: parameter('User.count', -1),
      }),
    });

    expect(
      program.diagnostics.filter(
        ({ code, path }) =>
          code === 'NACHI_BURST_COUNT_INVALID' && path === 'spawn[0].config.count',
      ),
    ).toHaveLength(1);
  });

  it('requires an interval for multi-cycle bursts', () => {
    const program = compileEmitter({
      ...baseEmitter(),
      spawn: rawConfig(burst({ count: 1 }), { count: 1, cycles: 2 }),
    });
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

  it('rejects LUT widths that cannot represent both endpoints', () => {
    expect(() => bakeCurveLut(curve([0, 0], [1, 1]), 'curve', 1)).toThrow('at least 2');
    expect(() => bakeGradientLut(gradient('#000', '#fff'), 'gradient', 1)).toThrow('at least 2');
  });

  it('allocates non-overlapping four-sample blocks to adjacent attribute defaults', () => {
    const firstBase = defaultAttributeSampleOffset(4);
    const secondBase = defaultAttributeSampleOffset(5);
    expect([firstBase, firstBase + 1, firstBase + 2]).not.toContain(secondBase);
    const moduleSlot = 23;
    expect(pcgRandomFloat(0, 73, resolveRandomSampleSlot(moduleSlot, firstBase + 1), 0)).not.toBe(
      pcgRandomFloat(0, 73, resolveRandomSampleSlot(moduleSlot, secondBase), 0),
    );
  });

  it('pins the symmetric PBD pair correction coefficient', () => {
    expect(pbdPairCorrection(0.75, 1)).toBe(0.125);
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

  it('bakes alpha-bearing hex colors with linear alpha and sRGB-decoded RGB', () => {
    const rgba = bakeGradientLut(gradient('#6b2cff00', '#6b2cff00'));
    expect(rgba.data[0]).toBeCloseTo(0.1470273, 7);
    expect(rgba.data[1]).toBeCloseTo(0.0251869, 7);
    expect(rgba.data[2]).toBe(1);
    expect(rgba.data[3]).toBe(0);

    const shorthand = bakeGradientLut(gradient('#6b28', '#6b28'));
    const expanded = bakeGradientLut(gradient('#66bb2288', '#66bb2288'));
    expect([...shorthand.data]).toEqual([...expanded.data]);
    expect(shorthand.data[3]).toBeCloseTo(8 / 15, 7);

    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [colorOverLife(gradient('#ffffff', '#6b2cff00'))],
      }),
    );
    expect(program.diagnostics.map(({ code }) => code)).not.toContain('NACHI_LUT_BAKE_FAILED');
  });

  it('lists supported hexadecimal formats in LUT bake diagnostics', () => {
    const unsupported = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [colorOverLife(gradient('#ffffff', '#12345'))],
      }),
    );

    expect(unsupported.diagnostics).toContainEqual({
      code: 'NACHI_LUT_BAKE_FAILED',
      message:
        'LUT baking failed: Unsupported color "#12345". Expected #RGB, #RRGGBB, #RGBA, or #RRGGBBAA.',
      path: 'update[0]',
      phase: 'compile',
      severity: 'error',
    });
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
      'NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME',
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

  it('derives every supported plain binding-input shape from the attribute type table', () => {
    expect([
      resolveTslBindingInputType(true),
      resolveTslBindingInputType(1),
      resolveTslBindingInputType([1, 2]),
      resolveTslBindingInputType([1, 2, 3]),
      resolveTslBindingInputType([1, 2, 3, 4]),
      resolveTslBindingInputType(Array.from({ length: 9 }, (_, index) => index)),
      resolveTslBindingInputType(Array.from({ length: 16 }, (_, index) => index)),
    ]).toEqual(['bool', 'f32', 'vec2', 'vec3', 'vec4', 'mat3', 'mat4']);
    expect(resolveTslBindingInputType([1])).toBeUndefined();
    expect(resolveTslBindingInputType([0, Number.NaN, 1])).toBeUndefined();
  });

  it('lowers plain vec3 binding inputs to the same node shape as an explicit vec3 node', () => {
    const literalProgram = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [tslModule(({ velocity }) => ({ velocity: velocity.add([0, 1, 0]) }))],
      }),
    );
    const literalInputs: unknown[] = [];
    const constantCalls: Array<{ readonly type: string; readonly value: unknown }> = [];
    let loweredNode: FakeNode | undefined;
    literalProgram.buildKernels({
      ...fakeAdapter(),
      constant: (value, type) => {
        const node = new FakeNode(value);
        if (type === 'vec3' && Array.isArray(value) && value.join(',') === '0,1,0') {
          constantCalls.push({ type, value });
          loweredNode = node;
        }
        return node;
      },
      instancedArray: () => new BindingInputCaptureStorage(literalInputs),
      vec3: () => new BindingInputCaptureNode(literalInputs),
    });

    const explicitNode = new TslLikeFakeNode([0, 1, 0]);
    const explicitProgram = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          tslModule(({ velocity }) => ({
            velocity: velocity.add(explicitNode as never),
          })),
        ],
      }),
    );
    const explicitInputs: unknown[] = [];
    explicitProgram.buildKernels({
      ...fakeAdapter(),
      instancedArray: () => new BindingInputCaptureStorage(explicitInputs),
      vec3: () => new BindingInputCaptureNode(explicitInputs),
    });

    expect(constantCalls).toEqual([{ type: 'vec3', value: [0, 1, 0] }]);
    expect(literalInputs).toContain(loweredNode);
    expect(explicitInputs).toContain(explicitNode);
    expect(loweredNode?.value).toEqual(explicitNode.value);
  });

  it('passes non-literal operation metadata through TSL tracing without false diagnostics', () => {
    const custom = tslModule(({ velocity }) => {
      const configured = (
        velocity as unknown as {
          configure(
            name: string,
            optional: undefined,
            empty: null,
            callback: () => void,
          ): typeof velocity;
        }
      ).configure('namedVelocity', undefined, null, () => undefined);
      return { velocity: configured };
    });
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [custom] }));

    expect(program.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_TSL_BINDING_INPUT_INVALID',
    );
  });

  it('rejects unsupported numeric-array binding inputs during tracing', () => {
    const invalid = tslModule(({ velocity }) => ({
      velocity: velocity.add([1] as never),
    }));
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [invalid] }));

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TSL_BINDING_INPUT_INVALID',
        path: 'update[0].factory.velocity.add[0]',
      }),
    );
  });

  it('rejects non-finite numeric-array binding inputs during tracing', () => {
    const invalid = tslModule(({ velocity }) => ({
      velocity: velocity.add([0, Number.NaN, 0] as never),
    }));
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [invalid] }));

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TSL_BINDING_INPUT_INVALID',
        path: 'update[0].factory.velocity.add[0]',
      }),
    );
  });

  it('rejects non-node binding inputs with the module path before materialization', () => {
    const invalid = tslModule(({ velocity }) => ({
      velocity: velocity.add({ x: 0, y: 1, z: 0 } as never),
    }));
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [invalid] }));

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TSL_BINDING_INPUT_INVALID',
        path: 'update[0].factory.velocity.add[0]',
        severity: 'error',
      }),
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('warns for lifetime without age unless lifecycle or an age write makes death explicit', () => {
    const lifetimeOnly = tslModule(({ lifetime: value }) => ({ lifetime: value }), {
      stage: 'init',
    });
    const withoutAge = compileEmitter(baseEmitter({ init: [lifetimeOnly], integration: 'none' }));
    expect(withoutAge.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_LIFETIME_WITHOUT_AGE',
        message: expect.stringContaining('lifecycle declaration or an age write'),
        severity: 'warning',
      }),
    );

    const lifecycle = compileEmitter({
      ...baseEmitter({ init: [lifetimeOnly], integration: 'none' }),
      lifecycle: { duration: 1 },
    });
    expect(lifecycle.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_LIFETIME_WITHOUT_AGE',
    );

    const lifetimeAndAge = tslModule(({ age, lifetime: value }) => ({ age, lifetime: value }), {
      stage: 'init',
    });
    const withAge = compileEmitter(baseEmitter({ init: [lifetimeAndAge], integration: 'none' }));
    expect(withAge.diagnostics.map(({ code }) => code)).not.toContain('NACHI_LIFETIME_WITHOUT_AGE');
  });

  it('assigns spawnOrder before an init tslModule reads it', () => {
    const assignments: string[] = [];
    const moduleReadOffsets: number[] = [];
    const initializeFromOrder = tslModule(
      ({ spawnOrder }) => {
        if (spawnOrder instanceof StatementTraceNode) {
          moduleReadOffsets.push(assignments.length);
        }
        return { lifetime: spawnOrder.toFloat() };
      },
      { stage: 'init' },
    );
    const program = compileEmitter(
      baseEmitter({ init: [initializeFromOrder], integration: 'none' }),
    );
    program.buildKernels({
      ...fakeAdapter(),
      instancedArray: () => new StatementTraceStorage(assignments),
    });

    const attribute = program.attributeSchema.byName.spawnOrder!;
    const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex]!;
    const lane = ['x', 'y', 'z', 'w'][attribute.physical.offset]!;
    const spawnOrderTarget = `NachiParticles_${storage.name}.${lane}`;
    expect(moduleReadOffsets).toHaveLength(2);
    let previousOffset = 0;
    for (const offset of moduleReadOffsets) {
      expect(assignments.slice(previousOffset, offset)).toContain(spawnOrderTarget);
      previousOffset = offset;
    }
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

  it('keeps random sample offsets off the spawn-order axis during TSL construction', () => {
    const program = compileEmitter(
      baseEmitter({ init: [positionSphere({ radius: 1 })], integration: 'none' }),
    );

    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('diagnoses external Init random implementations that omit spawnOrder access', () => {
    const legacyAccess: ModuleAccess = {
      reads: ['Emitter.seed', 'Particles.spawnGeneration'],
      writes: ['Particles.intensity'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access: legacyAccess,
      build(context) {
        context.write('intensity', context.random());
      },
      stage: 'init',
      type: 'test/legacy-init-random',
      version: 1,
    });
    const module: ModuleDefinition<'init', Record<string, never>> = {
      access: legacyAccess,
      config: {},
      kind: 'module',
      stage: 'init',
      type: 'test/legacy-init-random',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ init: [module], integration: 'none' }), {
      registry,
    });
    let thrown: unknown;
    try {
      program.buildKernels(fakeAdapter());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VfxDiagnosticError);
    expect((thrown as VfxDiagnosticError).diagnostics).toContainEqual({
      code: 'NACHI_INIT_RANDOM_SPAWN_ORDER_ACCESS_REQUIRED',
      message: expect.stringContaining('Add "Particles.spawnOrder" to access.reads'),
      path: 'init[0].access.reads',
      phase: 'compile',
      severity: 'error',
    });

    const moduleOnlyFixed: ModuleDefinition<'init', Record<string, never>> = {
      ...module,
      access: {
        ...legacyAccess,
        reads: [...legacyAccess.reads, 'Particles.spawnOrder'],
      },
    };
    const implementationMismatch = compileEmitter(
      baseEmitter({ init: [moduleOnlyFixed], integration: 'none' }),
      { registry },
    );
    expect(() => implementationMismatch.buildKernels(fakeAdapter())).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'NACHI_INIT_RANDOM_SPAWN_ORDER_ACCESS_REQUIRED' }),
        ]),
      }),
    );
  });

  it('diagnoses external Update random implementations that omit stable-key access', () => {
    const legacyAccess: ModuleAccess = {
      reads: ['Emitter.seed', 'Particles.spawnGeneration'],
      writes: ['Particles.intensity'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access: legacyAccess,
      build(context) {
        context.write('intensity', context.random());
      },
      stage: 'update',
      type: 'test/legacy-update-random',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access: legacyAccess,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/legacy-update-random',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      registry,
    });

    expect(() => program.buildKernels(fakeAdapter())).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: 'NACHI_UPDATE_RANDOM_STABLE_KEY_ACCESS_REQUIRED',
            path: 'update[0].access.reads',
          }),
        ]),
      }),
    );

    const stableReads = [
      'Emitter.seed',
      'Particles.spawnOrder',
      'Emitter.updateRandomStep',
    ] as const;
    const fixedRegistry = createCoreKernelModuleRegistry();
    fixedRegistry.register({
      access: { reads: [...stableReads], writes: ['Particles.intensity'] },
      build(context) {
        context.write('intensity', context.random());
      },
      stage: 'update',
      type: 'test/stable-update-random',
      version: 1,
    });
    const fixed: ModuleDefinition<'update', Record<string, never>> = {
      ...module,
      access: { reads: [...stableReads], writes: ['Particles.intensity'] },
      type: 'test/stable-update-random',
    };
    expect(() =>
      compileEmitter(baseEmitter({ integration: 'none', update: [fixed] }), {
        registry: fixedRegistry,
      }).buildKernels(fakeAdapter()),
    ).not.toThrow();
  });

  it('checks registered Update implementation access even when the definition is stable', () => {
    const implementationAccess: ModuleAccess = {
      reads: ['Emitter.seed', 'Particles.spawnGeneration'],
      writes: ['Particles.intensity'],
    };
    // Retaining the legacy read as an optional superset avoids the generic registry access
    // mismatch, so this case exclusively exercises context.random()'s implementation-side gate.
    const definitionAccess: ModuleAccess = {
      reads: [
        'Emitter.seed',
        'Particles.spawnOrder',
        'Emitter.updateRandomStep',
        'Particles.spawnGeneration',
      ],
      writes: ['Particles.intensity'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access: implementationAccess,
      build(context) {
        context.write('intensity', context.random());
      },
      stage: 'update',
      type: 'test/implementation-legacy-update-random',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access: definitionAccess,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/implementation-legacy-update-random',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      registry,
    });

    expect(program.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_MODULE_ACCESS_MISMATCH',
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'NACHI_UPDATE_RANDOM_STABLE_KEY_ACCESS_REQUIRED' }),
        ]),
      }),
    );
  });

  it('reports registry access mismatch before Update random tracing for a legacy definition', () => {
    const definitionAccess: ModuleAccess = {
      reads: ['Emitter.seed', 'Particles.spawnGeneration'],
      writes: ['Particles.intensity'],
    };
    const implementationAccess: ModuleAccess = {
      reads: ['Emitter.seed', 'Particles.spawnOrder', 'Emitter.updateRandomStep'],
      writes: ['Particles.intensity'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access: implementationAccess,
      build(context) {
        context.write('intensity', context.random());
      },
      stage: 'update',
      type: 'test/definition-legacy-update-random',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access: definitionAccess,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/definition-legacy-update-random',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      registry,
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_MODULE_ACCESS_MISMATCH',
        path: 'update[0].access',
      }),
    );
    let thrown: unknown;
    try {
      program.buildKernels(fakeAdapter());
    } catch (error) {
      thrown = error;
    }
    const codes =
      thrown instanceof VfxDiagnosticError
        ? thrown.diagnostics.map(({ code }) => code)
        : [String(thrown)];
    expect(codes).toContain('NACHI_MODULE_ACCESS_MISMATCH');
    expect(codes).not.toContain('NACHI_UPDATE_RANDOM_STABLE_KEY_ACCESS_REQUIRED');
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

  it('accepts reserved Emitter paths and declared inherited event payload fields', () => {
    const access: ModuleAccess = {
      reads: [
        'Emitter.transform',
        'Emitter.localTime',
        'Emitter.deltaTime',
        'Emitter.age',
        'Emitter.loopIndex',
        'Emitter.interpolationActive',
        'Emitter.previousTransform',
        'Emitter.seed',
        'Emitter.spawnGeneration',
        'Emitter.updateRandomStep',
        'Emitter.spawnCount',
        'Emitter.spawnInterpolatedTransform',
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
      eventPayloadFields: ['position'],
      registry,
    });

    expect(program.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_PARAMETER_UNKNOWN_REFERENCE',
    );
  });

  it('rejects event payload fields that are not declared by an inherit link', () => {
    const access: ModuleAccess = {
      reads: ['Emitter.eventPayload.typo'],
      writes: [],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access,
      build() {},
      stage: 'update',
      type: 'test/unknown-event-payload',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/unknown-event-payload',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      eventPayloadFields: ['position'],
      registry,
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARAMETER_UNKNOWN_REFERENCE' }),
    );
  });

  it('rejects undeclared event payload fields from non-kernel stages', () => {
    const render: ModuleDefinition<'render', Record<string, never>> = {
      access: { reads: ['Emitter.eventPayload.typo'], writes: [] },
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'test/render-event-payload',
      version: 1,
    };
    const program = compileEmitter({ ...baseEmitter({ integration: 'none' }), render });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_PARAMETER_UNKNOWN_REFERENCE' }),
    );
  });

  it('protects inherited event payload fields from author writes', () => {
    const access: ModuleAccess = {
      reads: [],
      writes: ['Emitter.eventPayload.position'],
    };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access,
      build() {},
      stage: 'update',
      type: 'test/write-event-payload',
      version: 1,
    });
    const module: ModuleDefinition<'update', Record<string, never>> = {
      access,
      config: {},
      kind: 'module',
      stage: 'update',
      type: 'test/write-event-payload',
      version: 1,
    };
    const program = compileEmitter(baseEmitter({ integration: 'none', update: [module] }), {
      eventPayloadFields: ['position'],
      registry,
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_COMPILER_OWNED_WRITE' }),
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
      'core/collide-box': collideBox({
        center: [0, 0, 0],
        mode: 'bounce',
        size: [1, 1, 1],
      }).access,
      'core/collide-plane': collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 }).access,
      'core/collide-scene-depth': collideSceneDepth().access,
      'core/collide-sdf': collideSdf({
        field: { assetType: 'sdf', kind: 'asset-ref', uri: 'shape.sdf' },
        mode: 'bounce',
      }).access,
      'core/collide-sphere': collideSphere({
        center: [0, 0, 0],
        mode: 'bounce',
        radius: 1,
      }).access,
      'core/curl-noise': curlNoise({ frequency: 1, strength: 1 }).access,
      'core/drag': drag(1).access,
      'core/gravity': gravity(-9.8).access,
      'core/kill-volume': killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }).access,
      'core/linear-force': linearForce({ force: [1, 2, 3] }).access,
      'core/orient-to-velocity': orientToVelocity().access,
      'core/lifetime': lifetime(1).access,
      'core/point-attractor': pointAttractor({ position: [0, 0, 0], strength: 1 }).access,
      'core/position-mesh-surface': positionMeshSurface({
        mesh: { assetType: 'mesh', kind: 'asset-ref', uri: 'character.mesh' },
        mode: 'surface',
      }).access,
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
      'core/velocity-mesh-normal': velocityMeshNormal({ speed: 1 }).access,
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
      [
        'core/position-mesh-surface',
        {
          mesh: { assetType: 'mesh', kind: 'asset-ref', uri: 'character.mesh' },
          mode: 'surface',
        },
      ],
      ['core/velocity-cone', { angle: 30, direction: [0, 1, 0], space: 'emitter', speed: 2 }],
      ['core/velocity-mesh-normal', { speed: 2 }],
      ['core/lifetime', { value: 2 }],
      ['core/gravity', { value: -9.8 }],
      ['core/drag', { value: 0.1 }],
      ['core/curl-noise', { frequency: 1, strength: 0.2 }],
      ['core/vortex', { axis: [0, 1, 0], center: [0, 0, 0], strength: 1 }],
      ['core/point-attractor', { falloff: 2, position: [0, 0, 0], strength: 1 }],
      ['core/linear-force', { force: [1, 2, 3], space: 'emitter' }],
      ['core/turbulence', { frequency: 1, octaves: 3, strength: 0.2 }],
      [
        'core/vector-field',
        {
          field: { assetType: 'vector-field', kind: 'asset-ref', uri: 'field.fga' },
          strength: 1,
        },
      ],
      [
        'core/collide-plane',
        {
          bounce: 0.5,
          friction: 0.2,
          mode: 'kill',
          normal: [0, 1, 0],
          offset: 0,
          space: 'emitter',
        },
      ],
      ['core/collide-sphere', { center: [0, 0, 0], mode: 'kill', radius: 1, space: 'emitter' }],
      ['core/collide-box', { center: [0, 0, 0], mode: 'kill', size: [1, 1, 1], space: 'emitter' }],
      ['core/collide-scene-depth', { mode: 'kill' }],
      [
        'core/collide-sdf',
        {
          field: { assetType: 'sdf', kind: 'asset-ref', uri: 'shape.sdf' },
          mode: 'kill',
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
      const access = registry.resolve(type, currentCoreModuleVersion(type))?.access;
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
      collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 }),
      'core/collide-plane',
      'Particles.position',
    ],
    [
      collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1 }),
      'core/collide-sphere',
      'Particles.position',
    ],
    [
      collideBox({ center: [0, 0, 0], mode: 'kill', size: [1, 1, 1] }),
      'core/collide-box',
      'Particles.alive',
    ],
    [collideSceneDepth(), 'core/collide-scene-depth', 'Particles.position'],
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
    expect(module).toMatchObject({
      kind: 'module',
      stage: 'update',
      type,
      version: currentCoreModuleVersion(type),
    });
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
    collidePlane({ bounce: 0.6, friction: 0.1, mode: 'bounce', normal: [0, 1, 0], offset: 0 }),
    collideSphere({ center: [1, 2, 3], mode: 'stick', radius: 2, space: 'emitter' }),
    collideBox({ center: [0, 0, 0], mode: 'kill', size: [2, 4, 6] }),
  ])('compiles an analytic collider alongside the reserved integrator', (module) => {
    const program = compileEmitter(baseEmitter({ update: [module] }));
    expect(program.diagnostics).toEqual([]);
    expect(program.kernels.update.modules.at(-1)?.type).toBe('core/integrate');
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('diagnoses invalid analytic and depth collision coefficients and geometry', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          rawConfig(collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 }), {
            bounce: 2,
            mode: 'bounce',
            normal: [0, 0, 0],
            offset: 0,
          }),
          rawConfig(collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1 }), {
            center: [0, 0, 0],
            friction: -1,
            mode: 'stick',
            radius: 0,
          }),
          rawConfig(collideBox({ center: [0, 0, 0], mode: 'kill', size: [1, 1, 1] }), {
            center: [0, 0, 0],
            mode: 'kill',
            size: [1, 0, 1],
          }),
          rawConfig(collideSceneDepth(), { surfaceOffset: -1 }),
        ],
      }),
    );
    expect(program.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_COLLISION_RESPONSE_INVALID',
      'NACHI_COLLISION_PLANE_NORMAL_INVALID',
      'NACHI_COLLISION_RESPONSE_INVALID',
      'NACHI_COLLISION_SPHERE_RADIUS_INVALID',
      'NACHI_COLLISION_BOX_SIZE_INVALID',
      'NACHI_COLLISION_DEPTH_OFFSET_INVALID',
    ]);
  });

  it('requires an explicit previous-frame depth binding for collideSceneDepth', () => {
    const program = compileEmitter(
      baseEmitter({ integration: 'none', update: [collideSceneDepth()] }),
    );
    const adapter = fakeAdapter();
    const withoutSceneDepth = { ...adapter };
    delete withoutSceneDepth.sampleSceneDepth;
    expect(() =>
      program.buildKernels({
        ...withoutSceneDepth,
        capabilities: { ...adapter.capabilities, sceneDepth: false },
      }),
    ).toThrow(VfxDiagnosticError);
  });

  it('rejects scene-depth collision on WebGL2 and with an MSAA source', () => {
    const program = compileEmitter(
      baseEmitter({ integration: 'none', update: [collideSceneDepth()] }),
    );
    const adapter = fakeAdapter();
    const codes = (callback: () => unknown) => {
      try {
        callback();
        return [];
      } catch (error) {
        if (!(error instanceof VfxDiagnosticError)) throw error;
        return error.diagnostics.map(({ code }) => code);
      }
    };

    expect(
      codes(() =>
        program.buildKernels({
          ...adapter,
          capabilities: { ...adapter.capabilities, backend: 'webgl2' },
        }),
      ),
    ).toContain('NACHI_SCENE_DEPTH_BACKEND_UNSUPPORTED');
    expect(
      codes(() =>
        program.buildKernels({
          ...adapter,
          capabilities: { ...adapter.capabilities, sceneDepthSampleCount: 4 },
        }),
      ),
    ).toContain('NACHI_SCENE_DEPTH_MSAA_UNSUPPORTED');
  });

  it('round-trips WebGPU NDC depth through the r185 perspective projection convention', () => {
    const near = Math.fround(0.1);
    const far = Math.fround(20);
    const viewZ = Math.fround(-5);
    // Column-major depth terms produced by Matrix4.makePerspective(..., WebGPUCoordinateSystem).
    const projection = new Float32Array(16);
    projection[10] = Math.fround(-far / (far - near));
    projection[11] = -1;
    projection[14] = Math.fround((-far * near) / (far - near));
    const clipZ = Math.fround(Math.fround(projection[10]! * viewZ) + projection[14]!);
    const clipW = Math.fround(projection[11]! * viewZ);
    const depth = Math.fround(clipZ / clipW);
    // CPU mirror of multiplying (x_ndc, y_ndc, depth, 1) by inverse(projection).
    const reconstructedViewZ = Math.fround(
      projection[14]! / Math.fround(depth * projection[11]! - projection[10]!),
    );

    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(1);
    expect(Math.abs(reconstructedViewZ - viewZ)).toBeLessThan(1e-5);
  });

  it('round-trips WebGPU NDC y through top-left-origin scene-depth UV', () => {
    const ndcY = 0.42;
    const textureV = 0.5 - ndcY * 0.5;
    const reconstructedNdcY = 1 - textureV * 2;
    const mirroredTextureV = ndcY * 0.5 + 0.5;

    expect(textureV).toBeCloseTo(0.29);
    expect(reconstructedNdcY).toBeCloseTo(ndcY);
    expect(mirroredTextureV).toBeCloseTo(0.71);
  });

  it('materializes collideSceneDepth with camera uniforms and a bound depth sampler', () => {
    const program = compileEmitter(
      baseEmitter({ integration: 'none', update: [collideSceneDepth({ mode: 'stick' })] }),
    );
    const built = program.buildKernels(fakeAdapter());
    expect(built.uniforms).toMatchObject({
      'System.projectionMatrix': expect.any(FakeNode),
      'System.viewMatrix': expect.any(FakeNode),
      'System.viewportSize': expect.any(FakeNode),
    });
  });

  it('keeps non-kill collision responses from writing Particles.alive', () => {
    const traced = traceCoreImplementation('core/collide-plane', {
      mode: 'bounce',
      normal: [0, 1, 0],
      offset: 0,
    });
    expect(traced.writes).not.toContain('Particles.alive');
    expect(traced.writes).toEqual(['Particles.position', 'Particles.velocity']);
  });

  it('diagnoses invalid scene-depth thickness', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [rawConfig(collideSceneDepth(), { thickness: 0 })],
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_COLLISION_DEPTH_THICKNESS_INVALID' }),
    );
  });

  it('compiles SDF collision with optional penetration thickness', () => {
    const field = { assetType: 'sdf', kind: 'asset-ref', uri: 'shape.sdf' } as const;
    const program = compileEmitter(
      baseEmitter({
        update: [collideSdf({ bounce: 0.5, field, friction: 0.2, mode: 'bounce', thickness: 0.4 })],
      }),
    );
    expect(program.diagnostics).toEqual([]);
    expect(program.kernels.update.modules.map(({ type }) => type)).toEqual([
      'core/collide-sdf',
      'core/integrate',
    ]);
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it('diagnoses invalid SDF collision thickness', () => {
    const field = { assetType: 'sdf', kind: 'asset-ref', uri: 'shape.sdf' } as const;
    expect(
      compileEmitter(
        baseEmitter({
          integration: 'none',
          update: [
            rawConfig(collideSdf({ field, mode: 'stick' }), {
              field,
              mode: 'stick',
              thickness: -1,
            }),
          ],
        }),
      ).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'NACHI_COLLISION_SDF_THICKNESS_INVALID' }));
  });

  it('compiles mesh-surface position and normal-velocity init modules', () => {
    const mesh = { assetType: 'mesh', kind: 'asset-ref', uri: 'character.mesh' } as const;
    const program = compileEmitter(
      baseEmitter({
        init: [positionMeshSurface({ mesh, mode: 'surface' }), velocityMeshNormal({ speed: 0.5 })],
        integration: 'none',
      }),
    );
    expect(program.diagnostics).toEqual([]);
    expect(program.kernels.init.modules.map(({ type }) => type)).toEqual([
      'core/defaults',
      'core/position-mesh-surface',
      'core/velocity-mesh-normal',
    ]);
    expect(program.attributeSchema.byName.surfaceNormal).toBeDefined();
    expect(() => program.buildKernels(fakeAdapter())).not.toThrow();
  });

  it.each([
    vortex({ axis: [0, 1, 0], strength: 1 }),
    pointAttractor({ position: [0, 0, 0], strength: 1 }),
    collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 }),
    collideSphere({ center: [0, 0, 0], mode: 'bounce', radius: 1 }),
    collideBox({ center: [0, 0, 0], mode: 'bounce', size: [1, 1, 1] }),
  ])('materializes the emitter-space authoring default in $type config', (module) => {
    expect(module.config).toMatchObject({ space: 'emitter' });
  });

  it.each([
    velocityCone({ angle: 0, direction: [1, 0, 0], speed: 1 }),
    linearForce({ force: [1, 0, 0] }),
  ])('materializes the v1-compatible world-space default in $type config', (module) => {
    expect(module.config).toMatchObject({ space: 'world' });
  });

  it('declares compiler-provided interpolated transform inputs for new selectors', () => {
    expect(
      velocityCone({ angle: 0, direction: [1, 0, 0], space: 'emitter', speed: 1 }).access?.reads,
    ).toContain('Emitter.spawnInterpolatedTransform');
    expect(linearForce({ force: [1, 0, 0], space: 'emitter' }).access?.reads).toContain(
      'Emitter.updateInterpolatedTransform',
    );
  });

  it('classifies update transform consumers as midpoint-sampled except NeighborGrid', () => {
    const midpointConsumers = [
      linearForce({ force: [1, 0, 0], space: 'emitter' }),
      vortex({ axis: [0, 1, 0], space: 'emitter', strength: 1 }),
      pointAttractor({ position: [0, 0, 0], space: 'emitter', strength: 1 }),
      collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0, space: 'emitter' }),
      collideSphere({ center: [0, 0, 0], mode: 'bounce', radius: 1, space: 'emitter' }),
      collideBox({ center: [0, 0, 0], mode: 'bounce', size: [1, 1, 1], space: 'emitter' }),
      killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }),
    ];
    for (const module of midpointConsumers) {
      expect(module.access?.reads).toContain('Emitter.updateInterpolatedTransform');
    }

    expect(boids({ grid: 'neighbors' }).access?.reads).toContain('Emitter.transform');
    expect(boids({ grid: 'neighbors' }).access?.reads).not.toContain(
      'Emitter.updateInterpolatedTransform',
    );
  });

  it('does not share the update midpoint node with a custom non-update kernel graph', () => {
    const access = { reads: ['Emitter.updateInterpolatedTransform'] as const, writes: [] };
    const registry = createCoreKernelModuleRegistry();
    registry.register({
      access,
      build: (context) => {
        context.uniform('Emitter.updateInterpolatedTransform');
      },
      stage: 'init',
      type: 'test/init-midpoint-read',
      version: 1,
    });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [
          {
            access,
            config: {},
            kind: 'module',
            stage: 'init',
            type: 'test/init-midpoint-read',
            version: 1,
          },
        ],
        integration: 'none',
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 1 }),
      }),
      { registry },
    );

    expect(() => program.buildKernels(fakeAdapter())).toThrowError(
      'Compiled uniform "Emitter.updateInterpolatedTransform" is missing.',
    );
  });

  it('separates legacy endpoint semantics from H2-6 module version 2', () => {
    const registry = createCoreKernelModuleRegistry();
    const cases = [
      [
        'core/vortex',
        { axis: [0, 1, 0], space: 'emitter', strength: 1 },
        'Emitter.updateInterpolatedTransform',
      ],
      [
        'core/point-attractor',
        { position: [0, 0, 0], space: 'emitter', strength: 1 },
        'Emitter.updateInterpolatedTransform',
      ],
      [
        'core/collide-plane',
        { mode: 'bounce', normal: [0, 1, 0], offset: 0, space: 'emitter' },
        'Emitter.updateInterpolatedTransform',
      ],
      [
        'core/collide-sphere',
        { center: [0, 0, 0], mode: 'bounce', radius: 1, space: 'emitter' },
        'Emitter.updateInterpolatedTransform',
      ],
      [
        'core/collide-box',
        { center: [0, 0, 0], mode: 'bounce', size: [1, 1, 1], space: 'emitter' },
        'Emitter.updateInterpolatedTransform',
      ],
      [
        'core/kill-volume',
        { mode: 'inside', radius: 1, shape: 'sphere' },
        'Emitter.updateInterpolatedTransform',
      ],
    ] as const;

    for (const [type, config, currentPath] of cases) {
      expect(registry.resolve(type, 1)?.access.reads, `${type}@1`).toContain('Emitter.transform');
      expect(registry.resolve(type, 1)?.access.reads, `${type}@1`).not.toContain(currentPath);
      expect(registry.resolve(type, 2)?.access.reads, `${type}@2`).toContain(currentPath);
      expect(
        traceCoreImplementation(type, config, undefined, 1).reads,
        `${type}@1 trace`,
      ).toContain('Emitter.transform');
      expect(
        traceCoreImplementation(type, config, undefined, 2).reads,
        `${type}@2 trace`,
      ).toContain(currentPath);
    }

    expect(
      traceCoreImplementation(
        'core/velocity-cone',
        { angle: 0, direction: [1, 0, 0], space: 'emitter', speed: 1 },
        undefined,
        1,
      ).reads,
    ).not.toContain('Emitter.spawnInterpolatedTransform');
    expect(
      traceCoreImplementation(
        'core/velocity-cone',
        { angle: 0, direction: [1, 0, 0], space: 'emitter', speed: 1 },
        undefined,
        2,
      ).reads,
    ).toContain('Emitter.spawnInterpolatedTransform');
    expect(
      traceCoreImplementation(
        'core/linear-force',
        { force: [1, 0, 0], space: 'emitter' },
        undefined,
        1,
      ).reads,
    ).not.toContain('Emitter.updateInterpolatedTransform');
    expect(
      traceCoreImplementation(
        'core/linear-force',
        { force: [1, 0, 0], space: 'emitter' },
        undefined,
        2,
      ).reads,
    ).toContain('Emitter.updateInterpolatedTransform');
  });

  it('makes an H2-6 module version 2 fail safely in a version-1-only registry', () => {
    const current = createCoreKernelModuleRegistry();
    const legacy = new KernelModuleRegistry();
    for (const type of ['core/burst', 'core/defaults', 'core/age', 'core/velocity-cone']) {
      const implementation = current.resolve(type, 1);
      if (implementation === undefined) throw new Error(`Missing ${type}@1 test implementation.`);
      legacy.register(implementation);
    }
    const program = compileEmitter(
      baseEmitter({
        init: [
          velocityCone({
            angle: 0,
            direction: [1, 0, 0],
            space: 'emitter',
            speed: 1,
          }),
        ],
        integration: 'none',
      }),
      { registry: legacy },
    );

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_MODULE_UNKNOWN',
        message: expect.stringContaining('core/velocity-cone@2'),
        path: 'init[0]',
      }),
    );
  });

  it('preserves the explicit world-space collider selector', () => {
    const world = collideSphere({
      center: [0, 0, 0],
      mode: 'bounce',
      radius: 1,
      space: 'world',
    });
    expect(world.config).toMatchObject({ space: 'world' });
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
    const program = compileEmitter(
      baseEmitter({ init: [lifetime(1)], integration: 'none', update: [module] }),
    );
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

  it('keeps simplex curl deterministic by avoiding random-stream manifest inputs', () => {
    const module = curlNoise({ frequency: 1, strength: 1 });
    expect(module.access?.reads).not.toContain('Emitter.seed');
    expect(module.access?.reads).not.toContain('Particles.spawnGeneration');
    expect(module.access?.reads).toContain('Particles.position');
  });

  it('diagnoses statically degenerate M4 behavior configs', () => {
    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          rawConfig(vortex({ axis: [0, 1, 0], strength: 1 }), {
            axis: [0, 0, 0],
            strength: 1,
          }),
          rawConfig(curlNoise({ frequency: 1, strength: 1 }), {
            frequency: 0,
            strength: 1,
          }),
          rawConfig(turbulence({ frequency: 1, strength: 1 }), {
            frequency: -1,
            strength: 1,
          }),
          rawConfig(pointAttractor({ position: [0, 0, 0], strength: 1 }), {
            position: [0, 0, 0],
            radius: -1,
            strength: 1,
          }),
          rawConfig(killVolume({ mode: 'inside', normal: [0, 1, 0], shape: 'plane' }), {
            mode: 'inside',
            normal: [0, 0, 0],
            shape: 'plane',
          }),
          rawConfig(killVolume({ mode: 'inside', radius: 1, shape: 'sphere' }), {
            mode: 'inside',
            radius: -1,
            shape: 'sphere',
          }),
          rawConfig(killVolume({ mode: 'inside', shape: 'box', size: [1, 1, 1] }), {
            mode: 'inside',
            shape: 'box',
            size: [1, 0, 1],
          }),
        ],
      }),
    );

    expect(program.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_VORTEX_AXIS_INVALID',
      'NACHI_FORCE_FREQUENCY_INVALID',
      'NACHI_FORCE_FREQUENCY_INVALID',
      'NACHI_POINT_ATTRACTOR_RADIUS_INVALID',
      'NACHI_KILL_VOLUME_NORMAL_INVALID',
      'NACHI_KILL_VOLUME_RADIUS_INVALID',
      'NACHI_KILL_VOLUME_SIZE_INVALID',
    ]);
  });

  it('diagnoses a statically degenerate velocity-cone direction', () => {
    const program = compileEmitter(
      baseEmitter({
        init: [
          rawConfig(velocityCone({ angle: 30, direction: [0, 1, 0], speed: 1 }), {
            angle: 30,
            direction: [0, 0, 0],
            speed: 1,
          }),
        ],
        integration: 'none',
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_VELOCITY_CONE_DIRECTION_INVALID' }),
    );
  });

  it('diagnoses positionSphere center and arc constraints for direct compiler input', () => {
    const valid = positionSphere({ radius: 1 });
    const program = compileEmitter(
      baseEmitter({
        init: [
          rawConfig(valid, {
            arc: { axis: [0, 0, 0], thetaMax: 181 },
            center: [0, Number.NaN, 0],
            radius: 1,
          }),
        ],
        integration: 'none',
      }),
    );

    expect(program.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_POSITION_SPHERE_CENTER_INVALID',
        'NACHI_POSITION_SPHERE_ARC_THETA_INVALID',
        'NACHI_POSITION_SPHERE_ARC_AXIS_INVALID',
      ]),
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);
  });

  it('shares emitter offset validation between defineEmitter and direct compiler input', () => {
    expect(() =>
      defineEmitter({
        capacity: 1,
        offset: [0, Number.POSITIVE_INFINITY, 0],
        render: computeRender,
        spawn: burst({ count: 1 }),
      }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_EMITTER_OFFSET_INVALID' })],
      }),
    );

    const program = compileEmitter({
      ...baseEmitter(),
      offset: [Number.NaN, 0, 0],
    });
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EMITTER_OFFSET_INVALID', path: 'offset' }),
    );
  });

  it('supports an optional inward acceleration in the vortex config', () => {
    expect(vortex({ axis: [0, 1, 0], inwardStrength: 0.5, strength: 2 }).config).toEqual({
      axis: [0, 1, 0],
      inwardStrength: 0.5,
      space: 'emitter',
      strength: 2,
    });
  });

  it('shares affected-module space diagnostics between helpers and direct compiler input', () => {
    expect(() =>
      pointAttractor({
        position: [0, 0, 0],
        space: 'camera' as never,
        strength: 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_MODULE_SPACE_INVALID' })],
      }),
    );

    const program = compileEmitter(
      baseEmitter({
        integration: 'none',
        update: [
          rawConfig(collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1 }), {
            center: [0, 0, 0],
            mode: 'stick',
            radius: 1,
            space: 'camera',
          }),
        ],
      }),
    );
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_MODULE_SPACE_INVALID',
        path: 'update[0].config.space',
      }),
    );
    expect(() => program.buildKernels(fakeAdapter())).toThrow(VfxDiagnosticError);

    for (const factory of [
      () =>
        velocityCone({
          angle: 0,
          direction: [1, 0, 0],
          space: 'camera' as never,
          speed: 1,
        }),
      () => linearForce({ force: [1, 0, 0], space: 'camera' as never }),
    ]) {
      expect(factory).toThrowError(
        expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'NACHI_MODULE_SPACE_INVALID' })],
        }),
      );
    }
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
    expect(module.access?.reads).toContain('Emitter.updateInterpolatedTransform');
  });

  it('uses the measured simplex amplitude correction constant', () => {
    expect(TURBULENCE_SIMPLEX_AMPLITUDE).toBe(0.286);
  });

  it('uses the measured simplex-curl derivative correction constant', () => {
    expect(CURL_SIMPLEX_DERIVATIVE_AMPLITUDE).toBe(6);
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

  it('compiles onDeath emitTo into a vec4-packed append queue', () => {
    const emitter = defineEmitter({
      attributes: { heat: attribute('heat', { default: 1, type: 'f32' }) },
      capacity: 8,
      events: { onDeath: emitTo('smoke', { inherit: ['position', 'heat'] }) },
      init: [positionSphere({ radius: 1 })],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const program = compileEmitter(emitter);
    const queue = program.events[0]!;

    expect(queue).toMatchObject({
      capacity: 8,
      eventName: 'onDeath',
      payloadGroupCount: 1,
      stateWordCount: 4,
    });
    expect(queue.payloadFields).toEqual([
      expect.objectContaining({ attribute: 'position', group: 0, offset: 0 }),
      expect.objectContaining({ attribute: 'heat', group: 0, offset: 3 }),
    ]);
    expect(program.meta.eventQueues).toEqual(program.events);
  });

  it('unions inherited fields once across multiple onDeath handlers', () => {
    const emitter = defineEmitter({
      capacity: 4,
      events: {
        onDeath: [
          emitTo('smoke', { inherit: ['position'] }),
          emitTo('flash', { inherit: ['position', 'velocity'] }),
        ],
      },
      init: [
        positionSphere({ radius: 1 }),
        velocityCone({ angle: 0, direction: [0, 1, 0], speed: 1 }),
      ],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const queue = compileEmitter(emitter).events[0]!;

    expect(queue.handlers).toHaveLength(2);
    expect(queue.payloadFields.map(({ attribute }) => attribute)).toEqual(['position', 'velocity']);
    expect(queue.payloadGroupCount).toBe(2);
  });

  it('diagnoses unknown inherited producer attributes', () => {
    const emitter = {
      ...baseEmitter({ integration: 'none' }),
      events: { onDeath: emitTo('smoke', { inherit: ['typo'] }) },
    };
    expect(compileEmitter(emitter).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_INHERIT_UNKNOWN' }),
    );
  });

  it('compiles onCollision through the shared event payload queue', () => {
    const emitter = defineEmitter({
      capacity: 1,
      events: { onCollision: emitTo('smoke', { inherit: ['position'] }) },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
      update: [collidePlane({ mode: 'bounce', normal: [0, 1, 0], offset: 0 })],
    });
    const program = compileEmitter(emitter);
    expect(program.diagnostics).toEqual([]);
    expect(program.events[0]).toMatchObject({
      eventName: 'onCollision',
      payloadFields: [expect.objectContaining({ attribute: 'position' })],
    });
    expect(program.buildKernels(fakeAdapter()).eventOutputs.onCollision).toBeDefined();
  });

  it('diagnoses onCustom until tslModule emitEvent(condition) is materialized', () => {
    const emitter = defineEmitter({
      capacity: 1,
      events: { onCustom: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    expect(compileEmitter(emitter).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_ON_CUSTOM_UNIMPLEMENTED' }),
    );
  });

  it('materializes event reset and producer resources on WebGPU', () => {
    const emitter = defineEmitter({
      capacity: 2,
      events: { onDeath: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const built = compileEmitter(emitter).buildKernels(fakeAdapter());

    expect(built.eventOutputs.onDeath).toMatchObject({
      queue: expect.objectContaining({ eventName: 'onDeath' }),
      reset: expect.any(FakeCompute),
    });
  });

  it('rejects event queue materialization on WebGL2', () => {
    const emitter = defineEmitter({
      capacity: 2,
      events: { onDeath: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const adapter = fakeAdapter();
    expect(() =>
      compileEmitter(emitter).buildKernels({
        ...adapter,
        capabilities: {
          atomics: false,
          backend: 'webgl2',
          indirectDispatch: false,
          indirectDraw: false,
        },
      }),
    ).toThrow(VfxDiagnosticError);
  });

  it('keeps a payload-less queue addressable with one vec4 group', () => {
    const emitter = defineEmitter({
      capacity: 3,
      events: { onDeath: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const queue = compileEmitter(emitter).events[0]!;
    expect(queue.payloadFields).toEqual([]);
    expect(queue.payloadGroupCount).toBe(1);
  });

  it('does not allow an inherited field to straddle vec4 payload groups', () => {
    const emitter = defineEmitter({
      attributes: {
        direction: attribute('direction', { default: [0, 1, 0], type: 'vec3' }),
        offset: attribute('offset', { default: [0, 0], type: 'vec2' }),
      },
      capacity: 2,
      events: { onDeath: emitTo('smoke', { inherit: ['direction', 'offset'] }) },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    expect(compileEmitter(emitter).events[0]?.payloadFields).toEqual([
      expect.objectContaining({ attribute: 'direction', group: 0, offset: 0 }),
      expect.objectContaining({ attribute: 'offset', group: 1, offset: 0 }),
    ]);
  });

  it('publishes all three event resources in storage budget metadata', () => {
    const emitter = defineEmitter({
      capacity: 2,
      events: { onDeath: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const eventBuffers = compileEmitter(emitter).meta.storageBuffers.filter(({ name }) =>
      name.startsWith('NachiEvent'),
    );
    expect(eventBuffers.map(({ name }) => name)).toEqual([
      'NachiEventState.onDeath',
      'NachiEventPayload.onDeath',
      'NachiEventIndirect.onDeath',
    ]);
  });

  it('diagnoses matrix event payload fields in M5', () => {
    const emitter = {
      ...baseEmitter({ integration: 'none' }),
      attributes: {
        matrix: attribute('matrix', {
          default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          type: 'mat3',
        }),
      },
      events: { onDeath: emitTo('smoke', { inherit: ['matrix'] }) },
    };
    expect(compileEmitter(emitter).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_EVENT_PAYLOAD_TYPE_UNSUPPORTED' }),
    );
  });

  it('reuses effect-owned event resources during kernel materialization', () => {
    const emitter = defineEmitter({
      capacity: 2,
      events: { onDeath: emitTo('smoke') },
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const adapter = fakeAdapter();
    const program = compileEmitter(emitter);
    const resources = allocateEventQueueResources(adapter, program.events[0]!, 'sparks');
    const built = program.buildKernels(adapter, { eventOutputs: { onDeath: resources } });
    expect(built.eventOutputs.onDeath?.state).toBe(resources.state);
    expect(built.eventOutputs.onDeath?.payload).toBe(resources.payload);
  });

  it('round-trips vec4-packed payloads through the selected CPU bank and slot', () => {
    const emitter = defineEmitter({
      attributes: { heat: attribute('heat', { default: 0, type: 'f32' }) },
      capacity: 3,
      events: { onDeath: emitTo('smoke', { inherit: ['position', 'heat'] }) },
      init: [positionSphere({ radius: 1 })],
      integration: 'none',
      render: computeRender,
      spawn: burst({ count: 1 }),
    });
    const queue = compileEmitter(emitter).events[0]!;
    const storage = new Float32Array(queue.capacity * queue.payloadGroupCount * 2 * 4);

    writeEventPayloadRecord(storage, queue, 1, 2, {
      heat: 0.75,
      position: [-0.288, 0.955, 0.071],
    });

    expect(readEventPayloadRecord(storage, queue, 1, 2)).toEqual({
      heat: 0.75,
      position: [-0.2879999876022339, 0.9549999833106995, 0.07100000232458115],
    });
    expect(readEventPayloadRecord(storage, queue, 0, 2)).toEqual({
      heat: 0,
      position: [0, 0, 0],
    });
  });
});
