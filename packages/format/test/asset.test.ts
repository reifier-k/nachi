import {
  VfxDiagnosticError,
  at,
  attribute,
  billboard,
  burst,
  cameraShake,
  colorOverLife,
  curve,
  curlNoise,
  defineEffect,
  defineEmitter,
  defineGrid2D,
  defineGrid2DStageFunction,
  defineGrid3D,
  defineGrid3DStageFunction,
  defineNeighborGrid,
  defineSimStage,
  defineParameter,
  defineTslFunction,
  decalRenderer,
  drag,
  boids,
  collideBox,
  collidePlane,
  collideSphere,
  compileEmitter,
  createCoreKernelModuleRegistry,
  emitTo,
  gradient,
  gravity,
  gridAdvect,
  gridInject,
  gridTslModule,
  grid3DAdvect,
  grid3DInject,
  grid3DTslModule,
  Grid2DStageRegistry,
  Grid3DStageRegistry,
  hitStop,
  lifetime,
  lightIntensity,
  linearForce,
  marker,
  meshRenderer,
  parameter,
  play,
  pointAttractor,
  positionSphere,
  pbdDistanceConstraint,
  rate,
  range,
  sizeOverLife,
  stop,
  timeline,
  tslModule,
  velocityCone,
  vortex,
  type TextureRef,
} from '@nachi-vfx/core';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi-vfx/trails';
import { describe, expect, it } from 'vitest';

import {
  EFFECT_ASSET_FORMAT,
  EFFECT_ASSET_VERSION,
  EffectAssetMigrationRegistry,
  defaultEffectAssetMigrations,
  effectAssetSchemaV1,
  effectAssetSchemaV2,
  loadEffect,
  serializeEffect,
  validateEffectAsset,
} from '../src/index.js';

const texture = (uri: string): TextureRef => ({ assetType: 'texture', kind: 'asset-ref', uri });

function diagnosticCodes(callback: () => unknown): string[] {
  try {
    callback();
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(VfxDiagnosticError);
    return (error as VfxDiagnosticError).diagnostics.map(({ code }) => code);
  }
}

function thrownDiagnostics(callback: () => unknown) {
  try {
    callback();
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(VfxDiagnosticError);
    return (error as VfxDiagnosticError).diagnostics;
  }
}

function moduleConditionalTypes(schema: { readonly allOf: readonly unknown[] }): string[] {
  return schema.allOf.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || !('if' in entry)) return [];
    const condition = entry.if;
    if (typeof condition !== 'object' || condition === null || !('properties' in condition)) {
      return [];
    }
    const properties = condition.properties;
    if (typeof properties !== 'object' || properties === null || !('type' in properties)) return [];
    const type = properties.type;
    return typeof type === 'object' &&
      type !== null &&
      'const' in type &&
      typeof type.const === 'string'
      ? [type.const]
      : [];
  });
}

function representativeEffect() {
  const heat = attribute('heat', { default: 0, type: 'f32' });
  const gravityParameter = defineParameter('User.gravity', {
    default: -9.8,
    mutable: true,
    type: 'f32',
  });
  const sparks = defineEmitter({
    attributes: { heat },
    bounds: { center: [0, 0.2, 0], radius: 3 },
    capacity: 256,
    events: { onDeath: emitTo('smoke', { inherit: ['position', 'velocity'] }) },
    init: [
      positionSphere({
        arc: { axis: [0, 1, 0], thetaMax: 120 },
        center: range([0.1, 0, -0.1], [0.2, 0.1, 0.1]),
        radius: range(0.1, 0.3),
        surfaceOnly: true,
      }),
      velocityCone({ angle: 35, direction: [0, 1, 0], speed: range(2, 6) }),
      lifetime(range(0.4, 0.9)),
      lightIntensity(2),
    ],
    lifecycle: { duration: 1.5, loopCount: 2, prewarm: 0.1, startDelay: 0.05 },
    offset: [1, 0.5, -2],
    parameters: { 'User.gravity': gravityParameter },
    quality: {
      low: {
        capacityScale: 0.4,
        features: { lit: false, soft: false, sorted: false },
        spawnRateScale: 0.5,
      },
    },
    render: billboard({
      blending: 'alpha',
      lit: { normalMap: texture('asset://normal'), roughness: 0.7 },
      soft: { fadeDistance: 0.035 },
      sorted: true,
    }),
    spawn: burst({ count: 48, cycles: 2, interval: 0.2 }),
    update: [
      gravity(parameter('User.gravity', -9.8)),
      drag(0.25),
      curlNoise({ frequency: 0.8, strength: 1.4 }),
      sizeOverLife(curve([0, 0], [0.2, 1], [1, 0])),
      colorOverLife(gradient('#11223344', '#88ccffff', '#00000000')),
    ],
  });
  const smoke = defineEmitter({
    capacity: 64,
    init: [positionSphere({ radius: 0 }), lifetime(0.5)],
    render: meshRenderer({
      alignment: { mode: 'velocity' },
      geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'asset://quad' },
    }),
    spawn: burst({ count: 0 }),
    update: [drag(0.8)],
  });
  return defineEffect({
    elements: {
      post: {
        config: { preset: 'bloom', strength: 1.1 },
        kind: 'visual-element',
        type: 'test/post',
        version: 1,
      },
      smoke,
      sparks,
    },
    parameters: { 'User.gravity': gravityParameter },
    scalability: {
      culling: { distance: { fadeEnd: 40, fadeStart: 25 }, frustum: true },
      significance: { priority: 2 },
    },
    timeline: timeline(
      [
        at(0, play('sparks'), marker('start', { source: 'json' })),
        at(0.1, cameraShake({ duration: 0.2, frequency: 24, strength: 0.3 }), hitStop(40)),
        at(0.4, stop('sparks')),
      ],
      { duration: 0.6, loop: 2, speed: 1.25 },
    ),
  });
}

describe('effect asset v2 and v1 compatibility', () => {
  it('keeps invalid JSON-loaded ribbon config on the compile-diagnostic path', () => {
    const document = serializeEffect(
      defineEffect({
        elements: {
          trail: defineEmitter({
            attributes: { ribbonId: ribbonIdAttribute() },
            capacity: 4,
            init: [lifetime(1), ribbonId(0)],
            integration: 'none',
            render: ribbon({ width: 0.2 }),
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    const invalidDocument = JSON.parse(JSON.stringify(document)) as {
      effect: {
        elements: { trail: { render: { config: { taper?: { end: number; start: number } } } } };
      };
    };
    invalidDocument.effect.elements.trail.render.config.taper = { end: 0.6, start: 0.6 };

    const loaded = loadEffect(invalidDocument);
    const loadedTrail = loaded.elements.trail;
    expect(loadedTrail?.kind).toBe('emitter');
    if (loadedTrail?.kind !== 'emitter') throw new Error('Expected the trail emitter to load.');
    const program = compileEmitter(loadedTrail, {
      registry: registerTrails(createCoreKernelModuleRegistry()),
    });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_RIBBON_TAPER_INVALID',
        path: 'render[0].config.taper',
        phase: 'compile',
      }),
    );
  });

  it('round-trips every module stage, render data, timeline, scalability, User.*, curves, and RGBA colors', () => {
    const definition = representativeEffect();
    const document = serializeEffect(definition);
    expect(document.format).toBe(EFFECT_ASSET_FORMAT);
    expect(document.version).toBe(EFFECT_ASSET_VERSION);
    expect(Object.keys(document)).toEqual(['format', 'version', 'effect']);

    const loaded = loadEffect(JSON.stringify(document));
    expect(serializeEffect(loaded)).toEqual(document);
    expect(loaded).toEqual(definition);

    const serialized = JSON.stringify(document);
    expect(serialized).toContain('#11223344');
    expect(serialized).toContain('User.gravity');
    expect(serialized).toContain('"kind":"curve"');
    expect(serialized).toContain('"stage":"spawn"');
    expect(serialized).toContain('"stage":"init"');
    expect(serialized).toContain('"stage":"update"');
    expect(serialized).toContain('"stage":"event"');
    expect(serialized).toContain('"stage":"render"');
  });

  it('keeps omitted and explicit continuous-spawn durations distinct through the asset format', () => {
    const definition = defineEffect({
      elements: {
        explicit: defineEmitter({
          capacity: 4,
          lifecycle: { duration: 0.25, startDelay: 0.05 },
          render: billboard({}),
          spawn: rate(8),
        }),
        omitted: defineEmitter({
          capacity: 4,
          render: billboard({}),
          spawn: rate(8),
        }),
      },
    });

    const document = serializeEffect(definition);
    const loaded = loadEffect(document);

    expect(loaded.elements.explicit).toMatchObject({
      lifecycle: { duration: 0.25, startDelay: 0.05 },
    });
    expect(loaded.elements.omitted).not.toHaveProperty('lifecycle');
    expect(serializeEffect(loaded)).toEqual(document);
    expect(JSON.stringify(document)).not.toContain('Infinity');

    const invalid = structuredClone(document) as unknown as {
      effect: { elements: { explicit: { lifecycle: { duration: number } } } };
    };
    invalid.effect.elements.explicit.lifecycle.duration = Infinity;
    expect(validateEffectAsset(invalid)).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_TYPE_MISMATCH',
        path: '$.effect.elements.explicit.lifecycle.duration',
      }),
    );
  });

  it('validates timeline duration and loop semantics in the asset format', () => {
    const invalid = {
      effect: {
        elements: {},
        kind: 'effect',
        timeline: {
          duration: 0,
          entries: [{ actions: [{ kind: 'marker', name: 'late' }], at: 1 }],
          kind: 'timeline',
          loop: 0,
        },
      },
      format: 'nachi-effect',
      version: 1,
    };
    expect(validateEffectAsset(invalid).map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_ASSET_TIMELINE_DURATION_INVALID',
        'NACHI_ASSET_TIMELINE_LOOP_INVALID',
      ]),
    );
  });

  it.each([
    [{ durationMs: -1, kind: 'hit-stop' }, 'NACHI_ASSET_TIMELINE_HIT_STOP_INVALID'],
    [{ durationMs: 1, kind: 'hit-stop', timeScale: -0.1 }, 'NACHI_ASSET_TIMELINE_HIT_STOP_INVALID'],
    [{ kind: 'camera-shake', strength: -1 }, 'NACHI_ASSET_TIMELINE_CAMERA_SHAKE_INVALID'],
    [
      { frequency: 0, kind: 'camera-shake', strength: 1 },
      'NACHI_ASSET_TIMELINE_CAMERA_SHAKE_INVALID',
    ],
    [{ kind: 'marker', name: '' }, 'NACHI_ASSET_TIMELINE_MARKER_INVALID'],
  ])('matches authoring validation for timeline action %j', (action, code) => {
    const document = {
      effect: {
        elements: {},
        kind: 'effect',
        timeline: [{ actions: [action], at: 0 }],
      },
      format: 'nachi-effect',
      version: 1,
    };

    expect(validateEffectAsset(document)).toContainEqual(expect.objectContaining({ code }));
    expect(() => loadEffect(document)).toThrow(VfxDiagnosticError);
  });

  it('publishes historical v1 and current v2 schemas and loads the current envelope', () => {
    const document = serializeEffect(representativeEffect());
    expect(effectAssetSchemaV1.properties.format.const).toBe('nachi-effect');
    expect(effectAssetSchemaV1.properties.version.const).toBe(1);
    expect(effectAssetSchemaV2.properties.version.const).toBe(2);
    expect(effectAssetSchemaV1.$defs.emitter.properties.attributes).toEqual({
      $ref: '#/$defs/attributes',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.bounds).toEqual({
      $ref: '#/$defs/bounds',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.events).toEqual({
      $ref: '#/$defs/events',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.lifecycle).toEqual({
      $ref: '#/$defs/lifecycle',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.offset).toEqual({
      $ref: '#/$defs/vec3',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.parameters).toEqual({
      $ref: '#/$defs/parameters',
    });
    expect(effectAssetSchemaV1.$defs.emitter.properties.quality).toEqual({
      $ref: '#/$defs/quality',
    });
    expect(effectAssetSchemaV1.$defs.emitterExtension.properties.overrides).toEqual({
      $ref: '#/$defs/emitterOverrides',
    });
    expect(effectAssetSchemaV1.properties.effect.properties.parameters).toEqual({
      $ref: '#/$defs/parameters',
    });
    expect(effectAssetSchemaV1.properties.effect.properties.scalability).toEqual({
      $ref: '#/$defs/scalability',
    });
    expect(effectAssetSchemaV1.properties.effect.properties.timeline).toEqual({
      $ref: '#/$defs/timeline',
    });
    for (const name of [
      'attribute',
      'bounds',
      'lifecycle',
      'parameter',
      'quality',
      'qualityFeatures',
      'qualityTier',
      'emitterOverrides',
      'moduleOverride',
      'positionSphereArc',
      'positionSphereConfig',
      'scalability',
      'timelineEntry',
    ] as const) {
      expect(effectAssetSchemaV1.$defs[name].additionalProperties).toBe(false);
    }
    expect(loadEffect(document)).toEqual(document.effect);
  });

  it('inherits every v1 module conditional into v2 before adding unique renderer conditionals', () => {
    const legacyConditionals = effectAssetSchemaV1.$defs.module.allOf;
    const currentConditionals = effectAssetSchemaV2.$defs.module.allOf;
    const legacyTypes = moduleConditionalTypes(effectAssetSchemaV1.$defs.module);
    const currentTypes = moduleConditionalTypes(effectAssetSchemaV2.$defs.module);

    expect(currentConditionals.slice(0, legacyConditionals.length)).toEqual(legacyConditionals);
    expect(currentConditionals).toHaveLength(legacyConditionals.length + 3);
    expect(currentTypes).toEqual(expect.arrayContaining(legacyTypes));
    expect(new Set(currentTypes.filter((type) => !legacyTypes.includes(type)))).toEqual(
      new Set(['core/billboard', 'core/decal-renderer', 'core/mesh-renderer']),
    );
    expect(new Set(currentTypes).size).toBe(currentTypes.length);

    const valid = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            init: [positionSphere({ radius: 1 })],
            render: billboard({}),
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    expect(validateEffectAsset(valid)).toEqual([]);
    const invalid = structuredClone(valid) as unknown as {
      effect: { elements: { particles: { init: Array<{ config: Record<string, unknown> }> } } };
    };
    invalid.effect.elements.particles.init[0]!.config.futurePositionField = true;
    expect(validateEffectAsset(invalid)).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.particles.init[0].config.futurePositionField',
      }),
    );
  });

  it('migrates v1 to v2 by changing only the envelope without mutating the source payload', () => {
    const legacyBillboard = { ...billboard({ sorted: false }), version: 1 } as const;
    const current = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            render: legacyBillboard,
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    const legacy = { ...current, version: 1 as const };
    const before = JSON.stringify(legacy);
    const migrated = defaultEffectAssetMigrations.migrate(legacy) as typeof current;

    expect(migrated).not.toBe(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.effect).toBe(legacy.effect);
    expect(JSON.stringify(migrated.effect)).toBe(JSON.stringify(legacy.effect));
    expect(JSON.stringify(legacy)).toBe(before);
    expect(
      (migrated.effect as { elements: { particles: { render: { version: number } } } }).elements
        .particles.render.version,
    ).toBe(1);
  });

  it('keeps v1 renderer configs generic but closes built-in renderer@2 configs in v2', () => {
    const current = serializeEffect(representativeEffect());
    const invalid = structuredClone(current) as typeof current;
    const render = (
      invalid.effect as {
        elements: { sparks: { render: { config: Record<string, unknown> } } };
      }
    ).elements.sparks.render;
    render.config.futureReaderField = true;

    expect(validateEffectAsset(invalid)).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.sparks.render.config.futureReaderField',
      }),
    );
    const legacy = structuredClone(invalid) as unknown as {
      effect: { elements: { sparks: { render: { version: number } } } };
      version: number;
    };
    legacy.version = 1;
    legacy.effect.elements.sparks.render.version = 1;
    expect(validateEffectAsset(legacy)).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_ASSET_UNKNOWN_FIELD' }),
    );
  });

  it('strictly validates nested built-in renderer@2 config while renderer@1 stays generic', () => {
    const current = serializeEffect(representativeEffect());
    const invalid = structuredClone(current) as unknown as {
      effect: {
        elements: {
          sparks: {
            render: {
              config: {
                alignment?: { axis: [number, number, number]; mode: string };
                lit: { futureLightingField?: boolean; roughness?: number };
              };
              version: number;
            };
          };
        };
      };
      version: number;
    };
    const render = invalid.effect.elements.sparks.render;
    render.config.alignment = { axis: [0, 1, 0], mode: 'camera-facing' };
    render.config.lit.futureLightingField = true;
    render.config.lit.roughness = 2;

    const diagnostics = validateEffectAsset(invalid);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.sparks.render.config.alignment.axis',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.sparks.render.config.lit.futureLightingField',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_VALUE_INVALID',
        path: '$.effect.elements.sparks.render.config.lit.roughness',
      }),
    );

    invalid.version = 1;
    render.version = 1;
    expect(validateEffectAsset(invalid)).not.toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('$.effect.elements.sparks.render.config'),
      }),
    );
  });

  it('strictly validates renderer@2 produced by a custom v1-to-v2 migration', () => {
    const current = serializeEffect(representativeEffect());
    const legacy = structuredClone({ ...current, version: 1 }) as unknown as {
      effect: {
        elements: {
          sparks: {
            render: {
              config: {
                futureReaderField?: boolean;
                lit: { roughness?: number };
              };
              version: number;
            };
          };
        };
      };
      format: string;
      version: number;
    };
    legacy.effect.elements.sparks.render.version = 1;
    const migrations = new EffectAssetMigrationRegistry().register(1, 2, (document) => {
      const migrated = structuredClone(document) as typeof legacy;
      migrated.version = 2;
      const render = migrated.effect.elements.sparks.render;
      render.version = 2;
      render.config.futureReaderField = true;
      render.config.lit.roughness = 2;
      return migrated;
    });

    const expected = [
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.sparks.render.config.futureReaderField',
      }),
      expect.objectContaining({
        code: 'NACHI_ASSET_VALUE_INVALID',
        path: '$.effect.elements.sparks.render.config.lit.roughness',
      }),
    ];
    expect(validateEffectAsset(legacy, { migrations })).toEqual(expect.arrayContaining(expected));
    expect(thrownDiagnostics(() => loadEffect(legacy, { migrations }))).toEqual(
      expect.arrayContaining(expected),
    );
  });

  it('checks the v1 reserved renderer version only in actual render slots', () => {
    const current = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            integration: 'none',
            render: { ...billboard({}), version: 1 },
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    const legacy = structuredClone({ ...current, version: 1 }) as unknown as {
      effect: {
        elements: {
          particles: {
            spawn: { config: Record<string, unknown> };
          };
        };
      };
      version: number;
    };
    legacy.effect.elements.particles.spawn.config.opaquePayload = {
      config: {},
      kind: 'module',
      stage: 'render',
      type: 'core/billboard',
      version: 2,
    };

    expect(validateEffectAsset(legacy)).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED' }),
    );
    expect(defaultEffectAssetMigrations.migrate(legacy)).toMatchObject({ version: 2 });
  });

  it.each([
    ['billboard', billboard({ blending: 'alpha' })],
    [
      'mesh',
      meshRenderer({
        blending: 'alpha',
        geometry: { assetType: 'geometry', kind: 'asset-ref', uri: 'mesh' },
      }),
    ],
    ['decal', decalRenderer({ blending: 'alpha', sorted: true })],
  ])('rejects reserved renderer@2 in a v1 envelope before migration: %s', (_name, render) => {
    const current = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            integration: 'none',
            render,
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    const legacyEnvelope = { ...current, version: 1 };
    expect(validateEffectAsset(legacyEnvelope)).toContainEqual(
      expect.objectContaining({ code: 'NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED' }),
    );
    expect(() => defaultEffectAssetMigrations.migrate(legacyEnvelope)).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({ code: 'NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED' }),
        ],
      }),
    );
    expect(diagnosticCodes(() => loadEffect(legacyEnvelope))).toContain(
      'NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED',
    );
  });

  it('round-trips emitter offset and strict positionSphere center/arc config', () => {
    const effect = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          init: [
            positionSphere({
              arc: { axis: [1, 0, 0], thetaMax: range(30, 75) },
              center: [1, 2, 3],
              radius: 0.25,
            }),
          ],
          offset: [-2, 0.5, 4],
          render: billboard({}),
          spawn: burst({ count: 4 }),
        }),
      },
    });
    const document = serializeEffect(effect);

    expect(serializeEffect(loadEffect(document))).toEqual(document);

    const unknownConfig = structuredClone(document) as unknown as {
      effect: { elements: { particles: { init: Array<{ config: Record<string, unknown> }> } } };
    };
    unknownConfig.effect.elements.particles.init[0]!.config.mystery = true;
    expect(diagnosticCodes(() => loadEffect(unknownConfig))).toContain('NACHI_ASSET_UNKNOWN_FIELD');

    const unknownArc = structuredClone(document) as unknown as {
      effect: {
        elements: {
          particles: { init: Array<{ config: { arc: Record<string, unknown> } }> };
        };
      };
    };
    unknownArc.effect.elements.particles.init[0]!.config.arc.mystery = true;
    expect(diagnosticCodes(() => loadEffect(unknownArc))).toContain('NACHI_ASSET_UNKNOWN_FIELD');

    const invalidRange = structuredClone(document) as unknown as {
      effect: {
        elements: {
          particles: { init: Array<{ config: { radius: unknown } }> };
        };
      };
    };
    invalidRange.effect.elements.particles.init[0]!.config.radius = {
      distribution: 'uniform',
      kind: 'range',
      max: 0.2,
      min: [0.1],
    };
    const invalidRangePath = '$.effect.elements.particles.init[0].config.radius.min';
    expect(
      validateEffectAsset(invalidRange).filter(({ path }) => path === invalidRangePath),
    ).toHaveLength(1);

    const invalidCurve = structuredClone(document) as unknown as {
      effect: {
        elements: {
          particles: { init: Array<{ config: { radius: unknown } }> };
        };
      };
    };
    invalidCurve.effect.elements.particles.init[0]!.config.radius = {
      keys: [
        { time: 0, value: [0.1] },
        { time: 1, value: 0.2 },
      ],
      kind: 'curve',
    };
    const invalidCurvePath = '$.effect.elements.particles.init[0].config.radius.keys[0].value';
    expect(
      validateEffectAsset(invalidCurve).filter(({ path }) => path === invalidCurvePath),
    ).toHaveLength(1);
  });

  it('normalizes omitted v1 module spaces to world and writes every selector canonically', () => {
    const authored = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          integration: 'none',
          render: billboard({}),
          spawn: burst({ count: 1 }),
          update: [
            vortex({ axis: [0, 1, 0], strength: 1 }),
            pointAttractor({ position: [0, 0, 0], strength: 1 }),
            collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 0 }),
            collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1 }),
            collideBox({ center: [0, 0, 0], mode: 'stick', size: [1, 1, 1] }),
          ],
        }),
      },
    });
    const omittedAuthoringDefinition = structuredClone(authored);
    const omittedAuthoringModules = omittedAuthoringDefinition.elements.particles.update!;
    for (const module of omittedAuthoringModules) {
      delete (module.config as { space?: string }).space;
    }
    const canonicalAuthored = serializeEffect(omittedAuthoringDefinition);
    const authoredModules = (
      canonicalAuthored.effect as {
        elements: { particles: { update: Array<{ config: { space?: string } }> } };
      }
    ).elements.particles.update;
    expect(authoredModules.map(({ config }) => config.space)).toEqual(
      Array.from({ length: 5 }, () => 'emitter'),
    );

    // Compatibility fixture: these selectors were all omitted by a pre-H1-5 v1 writer.
    const omittedSelectorV1Fixture = structuredClone(canonicalAuthored);
    const fixtureModules = (
      omittedSelectorV1Fixture.effect as {
        elements: {
          particles: {
            update: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              version: number;
            }>;
          };
        };
      }
    ).elements.particles.update;
    for (const module of fixtureModules) {
      module.version = 1;
      delete module.config.space;
      module.access!.reads = module.access!.reads.map((path) =>
        path === 'Emitter.updateInterpolatedTransform' ? 'Emitter.transform' : path,
      );
    }

    const loaded = loadEffect(omittedSelectorV1Fixture);
    const loadedEmitter = loaded.elements.particles;
    expect(loadedEmitter?.kind).toBe('emitter');
    if (loadedEmitter?.kind !== 'emitter') throw new Error('Expected the fixture emitter to load.');
    expect(
      loadedEmitter.update?.map(({ config }) => (config as { readonly space?: string }).space),
    ).toEqual(Array.from({ length: 5 }, () => 'world'));

    const canonicalLegacy = serializeEffect(loaded);
    expect(canonicalLegacy.version).toBe(2);
    const legacyModules = (
      canonicalLegacy.effect as {
        elements: { particles: { update: Array<{ config: { space?: string } }> } };
      }
    ).elements.particles.update;
    expect(legacyModules.map(({ config }) => config.space)).toEqual(
      Array.from({ length: 5 }, () => 'world'),
    );
    expect(serializeEffect(loadEffect(canonicalLegacy))).toEqual(canonicalLegacy);
  });

  it('normalizes new selector spaces without mutating legacy v1 documents or access manifests', () => {
    const authored = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], speed: 1 }), lifetime(1)],
          integration: 'none',
          render: billboard({}),
          spawn: burst({ count: 1 }),
          update: [linearForce({ force: [0, 1, 0] })],
        }),
      },
    });
    const canonical = serializeEffect(authored);
    const canonicalEmitter = (
      canonical.effect as {
        elements: {
          particles: {
            init: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              type: string;
              version: number;
            }>;
            update: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              type: string;
              version: number;
            }>;
          };
        };
      }
    ).elements.particles;
    expect(canonicalEmitter.init[0]?.config.space).toBe('world');
    expect(canonicalEmitter.update[0]?.config.space).toBe('world');
    expect(canonicalEmitter.init[0]?.version).toBe(2);
    expect(canonicalEmitter.update[0]?.version).toBe(2);

    const legacy = structuredClone(canonical);
    const legacyEmitter = (
      legacy.effect as (typeof canonical)['effect'] & {
        elements: {
          particles: {
            init: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              type: string;
              version: number;
            }>;
            update: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              type: string;
              version: number;
            }>;
          };
        };
      }
    ).elements.particles;
    legacyEmitter.init[0]!.version = 1;
    legacyEmitter.update[0]!.version = 1;
    delete legacyEmitter.init[0]!.config.space;
    delete legacyEmitter.update[0]!.config.space;
    legacyEmitter.init[0]!.access!.reads = legacyEmitter.init[0]!.access!.reads.filter(
      (path) => path !== 'Emitter.spawnInterpolatedTransform',
    );
    legacyEmitter.update[0]!.access!.reads = legacyEmitter.update[0]!.access!.reads.filter(
      (path) => path !== 'Emitter.updateInterpolatedTransform',
    );
    const sourceBeforeLoad = structuredClone(legacy);
    const loaded = loadEffect(legacy);
    expect(legacy).toEqual(sourceBeforeLoad);

    const loadedEmitter = loaded.elements.particles;
    expect(loadedEmitter?.kind).toBe('emitter');
    if (loadedEmitter?.kind !== 'emitter') throw new Error('Expected an emitter.');
    const [loadedInit] = loadedEmitter.init ?? [];
    const [loadedUpdate] = loadedEmitter.update ?? [];
    if (!loadedInit || !loadedUpdate) throw new Error('Expected Init and Update modules.');
    expect((loadedInit.config as { space?: string }).space).toBe('world');
    expect((loadedUpdate.config as { space?: string }).space).toBe('world');
    expect(loadedInit.version).toBe(1);
    expect(loadedUpdate.version).toBe(1);
    const loadedBeforeCompile = structuredClone(loaded);
    expect(compileEmitter(loadedEmitter).diagnostics).toEqual([]);
    expect(loaded).toEqual(loadedBeforeCompile);

    const firstCanonical = serializeEffect(loaded);
    expect(serializeEffect(loadEffect(firstCanonical))).toEqual(firstCanonical);
  });

  it('round-trips emitter selectors and strictly rejects invalid or unknown selector config', () => {
    const emitter = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            init: [
              velocityCone({
                angle: 0,
                direction: [1, 0, 0],
                space: 'emitter',
                speed: 1,
              }),
            ],
            integration: 'none',
            render: { ...billboard({}), version: 1 },
            spawn: burst({ count: 1 }),
            update: [linearForce({ force: [0, 1, 0], space: 'emitter' })],
          }),
        },
      }),
    );
    const serializedEmitter = (
      emitter.effect as {
        elements: {
          particles: { init: Array<{ version: number }>; update: Array<{ version: number }> };
        };
      }
    ).elements.particles;
    expect(serializedEmitter.init[0]?.version).toBe(2);
    expect(serializedEmitter.update[0]?.version).toBe(2);
    expect(serializeEffect(loadEffect(emitter))).toEqual(emitter);

    const invalid = structuredClone(emitter) as unknown as {
      effect: {
        elements: {
          particles: {
            init: Array<{ config: { mystery?: boolean; space?: string } }>;
            update: Array<{ config: { space?: string } }>;
          };
        };
      };
    };
    invalid.effect.elements.particles.init[0]!.config.mystery = true;
    invalid.effect.elements.particles.update[0]!.config.space = 'camera';
    const diagnostics = validateEffectAsset(invalid);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_UNKNOWN_FIELD',
        path: '$.effect.elements.particles.init[0].config.mystery',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_VALUE_INVALID',
        path: '$.effect.elements.particles.update[0].config.space',
      }),
    );
  });

  it('preserves module-v1 meaning while version 2 owns H2-6 behavior', () => {
    const document = serializeEffect(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            init: [
              velocityCone({
                angle: 0,
                direction: [1, 0, 0],
                space: 'emitter',
                speed: 1,
              }),
            ],
            integration: 'none',
            render: { ...billboard({}), version: 1 },
            spawn: burst({ count: 1 }),
            update: [
              linearForce({ force: [0, 1, 0], space: 'emitter' }),
              pointAttractor({ position: [0, 0, 0], space: 'emitter', strength: 1 }),
            ],
          }),
        },
      }),
    );
    const legacy = structuredClone(document) as unknown as {
      effect: {
        elements: {
          particles: {
            init: Array<{ config: { space?: string }; version: number }>;
            update: Array<{
              access?: { reads: string[] };
              config: { space?: string };
              type: string;
              version: number;
            }>;
          };
        };
      };
    };
    const emitter = legacy.effect.elements.particles;
    emitter.init[0]!.version = 1;
    emitter.update[0]!.version = 1;
    emitter.update[1]!.version = 1;
    emitter.update[1]!.access!.reads = emitter.update[1]!.access!.reads.map((path) =>
      path === 'Emitter.updateInterpolatedTransform' ? 'Emitter.transform' : path,
    );

    const loaded = loadEffect(legacy);
    const loadedEmitter = loaded.elements.particles;
    if (loadedEmitter?.kind !== 'emitter') throw new Error('Expected an emitter.');
    expect(loadedEmitter.init?.[0]).toMatchObject({ config: { space: 'world' }, version: 1 });
    expect(loadedEmitter.update?.[0]).toMatchObject({ config: { space: 'world' }, version: 1 });
    expect(loadedEmitter.update?.[1]).toMatchObject({ config: { space: 'emitter' }, version: 1 });
    expect(compileEmitter(loadedEmitter).diagnostics).toEqual([]);

    const roundTrip = serializeEffect(loaded);
    const roundTripEmitter = (
      roundTrip.effect as {
        elements: {
          particles: {
            init: Array<{ config: { space?: string }; version: number }>;
            update: Array<{ config: { space?: string }; version: number }>;
          };
        };
      }
    ).elements.particles;
    expect(roundTripEmitter.init[0]).toMatchObject({ config: { space: 'world' }, version: 1 });
    expect(roundTripEmitter.update[0]).toMatchObject({ config: { space: 'world' }, version: 1 });
    expect(roundTripEmitter.update[1]).toMatchObject({ config: { space: 'emitter' }, version: 1 });
  });

  it('supports an explicit future migration registration point', () => {
    const current = serializeEffect(representativeEffect());
    const version2 = { ...current, version: 2 };
    const migrations = new EffectAssetMigrationRegistry().register(2, 1, (document) => ({
      ...document,
      version: 1,
    }));
    expect(serializeEffect(loadEffect(version2, { migrations }))).toEqual(current);
  });

  it('rejects type mismatches, unknown fields, and unknown versions with NACHI_ASSET diagnostics', () => {
    const current = serializeEffect(representativeEffect());
    expect(diagnosticCodes(() => loadEffect({ ...current, version: 99 }))).toContain(
      'NACHI_ASSET_VERSION_UNSUPPORTED',
    );
    expect(diagnosticCodes(() => loadEffect({ ...current, mystery: true }))).toContain(
      'NACHI_ASSET_UNKNOWN_FIELD',
    );
    expect(
      diagnosticCodes(() =>
        loadEffect({
          ...current,
          effect: { ...(current.effect as Record<string, unknown>), elements: [] },
        }),
      ),
    ).toContain('NACHI_ASSET_TYPE_MISMATCH');
    const invalidDefault = JSON.parse(JSON.stringify(current)) as {
      effect: { parameters: Record<string, { default: unknown }> };
    };
    invalidDefault.effect.parameters['User.gravity']!.default = [1, 2, 3];
    expect(diagnosticCodes(() => loadEffect(invalidDefault))).toContain(
      'NACHI_ASSET_TYPE_MISMATCH',
    );
    expect(diagnosticCodes(() => loadEffect('{broken'))).toContain('NACHI_ASSET_JSON_INVALID');
  });

  it('rejects inline TSL factories with a registration hint and rejects raw runtime resources', () => {
    const inline = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          init: [positionSphere({ radius: 0 }), lifetime(1)],
          render: billboard({}),
          spawn: burst({ count: 1 }),
          update: [tslModule(({ velocity }) => ({ velocity }))],
        }),
      },
    });
    const [inlineDiagnostic] = thrownDiagnostics(() => serializeEffect(inline));
    expect(inlineDiagnostic).toEqual(
      expect.objectContaining({
        code: 'NACHI_ASSET_INLINE_FUNCTION_UNRESOLVED',
        hint: expect.stringContaining('Register the factory'),
        path: '$.effect.elements.particles.update[0].config.source',
        phase: 'serialize',
      }),
    );

    const withResource = defineEffect({
      elements: {
        resource: {
          config: { texture: new (class RuntimeTexture {})() },
          kind: 'visual-element',
          type: 'test/resource',
          version: 1,
        },
      },
    });
    expect(diagnosticCodes(() => serializeEffect(withResource))).toContain(
      'NACHI_ASSET_NON_SERIALIZABLE',
    );
  });

  it('round-trips registered function references without executable source', () => {
    const registration = defineTslFunction(
      'game/follow-field',
      ({ velocity }) => ({ velocity }),
      1,
    );
    const registered = defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 1,
          init: [positionSphere({ radius: 0 }), lifetime(1)],
          render: billboard({}),
          spawn: burst({ count: 1 }),
          update: [
            tslModule(registration, {
              access: {
                reads: ['Particles.velocity'],
                writes: ['Particles.velocity'],
              },
            }),
          ],
        }),
      },
    });
    const document = serializeEffect(registered);
    const serializedModule = (document.effect as { elements: { particles: { update: unknown[] } } })
      .elements.particles.update[0] as { config: { source: unknown }; factory?: unknown };
    expect(serializedModule.config.source).toEqual(registration.ref);
    expect('factory' in serializedModule).toBe(false);
    expect(serializeEffect(loadEffect(document))).toEqual(document);
  });

  it('diagnoses excessive JSON depth instead of leaking RangeError', () => {
    const root: unknown[] = [];
    let cursor = root;
    for (let depth = 0; depth < 200_000; depth += 1) {
      const nested: unknown[] = [];
      cursor.push(nested);
      cursor = nested;
    }
    const document = {
      effect: {
        elements: {
          particles: {
            capacity: 1,
            kind: 'emitter',
            render: { ...billboard({}), version: 1 },
            spawn: {
              config: { root },
              kind: 'module',
              stage: 'spawn',
              type: 'test/deep',
              version: 1,
            },
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };

    expect(diagnosticCodes(() => loadEffect(document))).toContain('NACHI_ASSET_MAX_DEPTH_EXCEEDED');
  });

  it('clones object input subtrees before returning a loaded definition', () => {
    const document = {
      effect: {
        elements: {
          visual: {
            config: { nested: { value: 1 } },
            kind: 'visual-element',
            type: 'test/clone',
            version: 1,
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    const loaded = loadEffect(document);
    const loadedNested = (loaded.elements.visual as { config: { nested: { value: number } } })
      .config.nested;

    expect(loadedNested).not.toBe(document.effect.elements.visual.config.nested);
    loadedNested.value = 2;
    expect(document.effect.elements.visual.config.nested.value).toBe(1);
  });

  it('validates tagged range, curve, and gradient generator payload types', () => {
    const documentFor = (value: unknown) => ({
      effect: {
        elements: {
          visual: { config: { value }, kind: 'visual-element', type: 'test/tag', version: 1 },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    });

    expect(
      diagnosticCodes(() =>
        loadEffect(documentFor({ distribution: 'uniform', kind: 'range', max: [1, 2], min: 0 })),
      ),
    ).toContain('NACHI_ASSET_TYPE_MISMATCH');
    expect(
      diagnosticCodes(() =>
        loadEffect(
          documentFor({
            keys: [
              { time: 0, value: 0 },
              { time: 'later', value: 1 },
            ],
            kind: 'curve',
          }),
        ),
      ),
    ).toContain('NACHI_ASSET_TYPE_MISMATCH');
    expect(
      diagnosticCodes(() =>
        loadEffect(
          documentFor({
            kind: 'gradient',
            stops: [
              { color: '#fff', position: 0 },
              { color: 42, position: 1 },
            ],
          }),
        ),
      ),
    ).toContain('NACHI_ASSET_TYPE_MISMATCH');
  });

  it('diagnoses sparse arrays in parsed object input', () => {
    const sparseInit = new Array(1);
    const document = {
      effect: {
        elements: {
          particles: {
            capacity: 1,
            init: sparseInit,
            kind: 'emitter',
            render: { ...billboard({}), version: 1 },
            spawn: burst({ count: 1 }),
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };

    expect(diagnosticCodes(() => loadEffect(document))).toContain('NACHI_ASSET_SPARSE_ARRAY');
  });
});

describe('asset-reference emitter inheritance', () => {
  it('resolves external emitter refs through M9 defineEmitter merge semantics', () => {
    const baseEmitter = defineEmitter({
      capacity: 16,
      init: [positionSphere({ radius: 0 }), lifetime(1)],
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 4 }),
      update: [
        { ...gravity(-9.8), label: 'gravity' },
        { ...drag(0.2), label: 'drag' },
      ],
    });
    const baseDocument = serializeEffect(defineEffect({ elements: { base: baseEmitter } }));
    const replacement = { ...gravity(-3), label: 'gravity' };
    const childDocument = {
      effect: {
        elements: {
          child: {
            extends: 'library://base#base',
            kind: 'emitter-extends',
            overrides: {
              update: {
                mode: 'merge',
                modules: [replacement],
                order: ['gravity'],
                remove: ['drag'],
              },
            },
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    const loaded = loadEffect(childDocument, {
      resolveAsset: (assetId) => {
        expect(assetId).toBe('library://base');
        return baseDocument;
      },
    });
    const expected = defineEmitter(baseEmitter, {
      update: { mode: 'merge', modules: [replacement], order: ['gravity'], remove: ['drag'] },
    });
    expect(loaded.elements.child).toEqual(expected);
  });

  it('re-serializes a two-hop external inheritance chain whose base has no optional stages', () => {
    const baseDocument = serializeEffect(
      defineEffect({
        elements: {
          base: defineEmitter({
            capacity: 8,
            render: billboard({ blending: 'additive' }),
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    const middleDocument = {
      effect: {
        elements: {
          middle: {
            extends: 'library://base#base',
            kind: 'emitter-extends',
            overrides: { capacity: 12 },
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    const childDocument = {
      effect: {
        elements: {
          child: {
            extends: 'library://middle#middle',
            kind: 'emitter-extends',
            overrides: { capacity: 16 },
          },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    const loaded = loadEffect(childDocument, {
      resolveAsset: (assetId) => {
        if (assetId === 'library://middle') return middleDocument;
        if (assetId === 'library://base') return baseDocument;
        throw new Error(`Unexpected asset ${assetId}`);
      },
    });
    const child = loaded.elements.child!;

    expect('init' in child).toBe(false);
    expect('update' in child).toBe(false);
    const serialized = serializeEffect(loaded);
    expect(serializeEffect(loadEffect(serialized))).toEqual(serialized);
  });

  it('rejects element keys and references containing the reference delimiter', () => {
    const baseElement = {
      capacity: 1,
      kind: 'emitter',
      render: { ...billboard({}), version: 1 },
      spawn: burst({ count: 1 }),
    };
    const invalidKey = {
      effect: { elements: { 'a#b': baseElement }, kind: 'effect' },
      format: 'nachi-effect',
      version: 1,
    };
    expect(diagnosticCodes(() => loadEffect(invalidKey))).toContain(
      'NACHI_ASSET_ELEMENT_KEY_INVALID',
    );

    let resolverCalled = false;
    const invalidReference = {
      effect: {
        elements: {
          child: { extends: '#a#b', kind: 'emitter-extends', overrides: {} },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    expect(
      diagnosticCodes(() =>
        loadEffect(invalidReference, {
          resolveAsset: () => {
            resolverCalled = true;
            return invalidKey;
          },
        }),
      ),
    ).toContain('NACHI_ASSET_EXTENDS_REFERENCE_INVALID');
    expect(resolverCalled).toBe(false);
  });

  it('diagnoses cyclic local extends chains and never returns a partial definition', () => {
    const cyclic = {
      effect: {
        elements: {
          first: { extends: '#second', kind: 'emitter-extends', overrides: {} },
          second: { extends: '#first', kind: 'emitter-extends', overrides: {} },
        },
        kind: 'effect',
      },
      format: 'nachi-effect',
      version: 1,
    };
    expect(diagnosticCodes(() => loadEffect(cyclic))).toContain('NACHI_ASSET_EXTENDS_CYCLE');
  });

  it('round-trips declarative Grid2D data interfaces and simulation stages', () => {
    const fluid = defineGrid2D({
      channels: {
        density: { default: 0, type: 'f32' },
        temperature: { default: 0, type: 'f32' },
        velocity: { default: [0, 0], type: 'vec2' },
        pressure: { default: 0, type: 'f32' },
      },
      resolution: [24, 16],
    });
    const registered = defineGrid2DStageFunction('test/grid-decay', ({ read }) => ({
      density: read('density') as never,
    }));
    const effect = defineEffect({
      elements: {
        fluid,
        inject: defineSimStage({
          phase: 'before-particles',
          target: 'fluid',
          update: gridInject({ center: [0.3, 0.2], radius: 0.1, values: { density: 2 } }),
        }),
        advect: defineSimStage({ iterations: 3, target: 'fluid', update: gridAdvect() }),
        registered: defineSimStage({ target: 'fluid', update: gridTslModule(registered) }),
      },
    });
    const document = serializeEffect(effect);
    expect(diagnosticCodes(() => loadEffect(document))).toContain(
      'NACHI_ASSET_GRID_STAGE_FUNCTION_UNRESOLVED',
    );
    expect(
      serializeEffect(
        loadEffect(document, {
          grid2DStageRegistry: new Grid2DStageRegistry().register(registered),
        }),
      ),
    ).toEqual(document);
  });

  it('rejects unknown built-in grid stage sources during validation and load', () => {
    const document = serializeEffect(
      defineEffect({
        elements: {
          fluid: defineGrid2D({ channels: { density: { type: 'f32' } }, resolution: [2, 2] }),
          update: defineSimStage({ target: 'fluid', update: gridAdvect() }),
        },
      }),
    );
    const invalid = structuredClone(document);
    const effect = invalid.effect as unknown as {
      elements: { update: { update: { source: string } } };
    };
    effect.elements.update.update.source = 'core/grid2d-typo';
    expect(validateEffectAsset(invalid)).toContainEqual(
      expect.objectContaining({ code: 'NACHI_ASSET_GRID_STAGE_SOURCE_UNKNOWN' }),
    );
    expect(diagnosticCodes(() => loadEffect(invalid))).toContain(
      'NACHI_ASSET_GRID_STAGE_SOURCE_UNKNOWN',
    );
  });

  it('validates grid inject values against the target channel declaration', () => {
    const document = serializeEffect(
      defineEffect({
        elements: {
          fluid: defineGrid2D({
            channels: { density: { type: 'f32' }, velocity: { type: 'vec2' } },
            resolution: [2, 2],
          }),
          inject: defineSimStage({
            target: 'fluid',
            update: gridInject({ center: [0, 0], radius: 1, values: { velocity: [1, 2] } }),
          }),
        },
      }),
    );
    const invalid = structuredClone(document) as unknown as {
      effect: { elements: { inject: { update: { config: { values: { velocity: unknown } } } } } };
    };
    invalid.effect.elements.inject.update.config.values.velocity = 1;
    expect(validateEffectAsset(invalid)).toContainEqual(
      expect.objectContaining({ code: 'NACHI_GRID2D_STAGE_VALUE_INVALID' }),
    );
    expect(diagnosticCodes(() => loadEffect(invalid))).toContain(
      'NACHI_GRID2D_STAGE_VALUE_INVALID',
    );
  });

  it('enforces asset capacity, prewarm, and PBD iteration limits', () => {
    const neighbors = defineNeighborGrid({ resolution: [2, 2, 2] });
    const document = serializeEffect(
      defineEffect({
        elements: {
          neighbors,
          particles: defineEmitter({
            capacity: 1,
            lifecycle: { prewarm: 1 },
            render: billboard({}),
            spawn: burst({ count: 1 }),
            update: [pbdDistanceConstraint({ distance: 1, grid: 'neighbors', iterations: 1 })],
          }),
        },
      }),
    );
    const invalid = structuredClone(document) as unknown as {
      effect: {
        elements: {
          particles: {
            capacity: number;
            lifecycle: { prewarm: number };
            update: [{ config: { iterations: number } }];
          };
        };
      };
    };
    invalid.effect.elements.particles.capacity = 2 ** 22 + 1;
    invalid.effect.elements.particles.lifecycle.prewarm = 301;
    invalid.effect.elements.particles.update[0].config.iterations = 65;
    expect(validateEffectAsset(invalid).map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_ASSET_CAPACITY_LIMIT_EXCEEDED',
        'NACHI_ASSET_PREWARM_LIMIT_EXCEEDED',
        'NACHI_ASSET_PBD_ITERATIONS_LIMIT_EXCEEDED',
      ]),
    );
  });

  it('rejects inline Grid2D TSL while preserving the registered declarative subset', () => {
    const fluid = defineGrid2D({ channels: { density: { type: 'f32' } }, resolution: [4, 4] });
    const effect = defineEffect({
      elements: {
        fluid,
        custom: defineSimStage({
          target: 'fluid',
          update: gridTslModule(({ read }) => ({ density: read('density') as never })),
        }),
      },
    });
    expect(diagnosticCodes(() => serializeEffect(effect))).toContain('NACHI_ASSET_INLINE_FUNCTION');
  });

  it('round-trips declarative Grid3D data interfaces and registered simulation stages', () => {
    const volume = defineGrid3D({
      channels: {
        density: { default: 0, type: 'f32' },
        velocity: { default: [0, 0.4, 0], type: 'vec3' },
        temperature: { default: 0, type: 'f32' },
        pressure: { default: 0, type: 'f32' },
      },
      resolution: [32, 40, 24],
    });
    const registered = defineGrid3DStageFunction('test/volume-decay', ({ read }) => ({
      density: read('density') as never,
    }));
    const effect = defineEffect({
      elements: {
        volume,
        inject: defineSimStage({
          phase: 'before-particles',
          target: 'volume',
          update: grid3DInject({
            center: [0.4, 0.1, 0.55],
            radius: 0.08,
            values: { density: 2, velocity: [0.2, 1, -0.1] },
          }),
        }),
        advect: defineSimStage({ target: 'volume', update: grid3DAdvect() }),
        registered: defineSimStage({ target: 'volume', update: grid3DTslModule(registered) }),
      },
    });
    const document = serializeEffect(effect);
    expect(
      serializeEffect(
        loadEffect(document, {
          grid3DStageRegistry: new Grid3DStageRegistry().register(registered),
        }),
      ),
    ).toEqual(document);
  });

  it('round-trips the NeighborGrid v1 payload in the canonical v2 envelope', () => {
    const neighbors = defineNeighborGrid({
      cellCapacity: 24,
      cellSize: 0.5,
      origin: [-4, -2, -4],
      resolution: [16, 8, 16],
    });
    const flock = defineEmitter({
      capacity: 256,
      render: billboard({}),
      spawn: burst({ count: 64 }),
      update: [
        boids({ cohesion: 0.8, grid: 'neighbors', radius: 1 }),
        pbdDistanceConstraint({ distance: 0.25, grid: 'neighbors', radius: 1 }),
      ],
    });
    const effect = defineEffect({ elements: { flock, neighbors } });
    const document = serializeEffect(effect);
    expect(document).toMatchObject({ format: 'nachi-effect', version: 2 });
    expect((document.effect as { elements: { neighbors: unknown } }).elements.neighbors).toEqual({
      cellCapacity: 24,
      cellSize: 0.5,
      kind: 'neighbor-grid',
      origin: [-4, -2, -4],
      resolution: [16, 8, 16],
      version: 1,
    });
    const loaded = loadEffect(document);
    expect(serializeEffect(loaded)).toEqual(document);
    expect(loaded.elements.neighbors).toEqual(neighbors);

    const legacyDocument = structuredClone(document) as unknown as {
      effect: {
        elements: {
          flock: { update: Array<{ access: { reads: string[] } }> };
        };
      };
    };
    for (const module of legacyDocument.effect.elements.flock.update) {
      module.access.reads = module.access.reads.filter((read) => read !== 'Emitter.transform');
    }
    const legacyLoaded = loadEffect(legacyDocument);
    expect(serializeEffect(legacyLoaded)).toEqual(legacyDocument);
    const compiledLegacy = compileEmitter(legacyLoaded.elements.flock as typeof flock, {
      neighborGrids: { neighbors: legacyLoaded.elements.neighbors as typeof neighbors },
    });
    expect(compiledLegacy.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'NACHI_MODULE_ACCESS_MISMATCH' }),
    );
    expect(
      compiledLegacy.kernels.update.modules
        .filter(({ type }) => type === 'core/boids' || type === 'core/pbd-distance-constraint')
        .every(({ access }) => access.reads.includes('Emitter.transform')),
    ).toBe(true);
  });

  it('rejects inline Grid3D TSL', () => {
    const volume = defineGrid3D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 4, 4],
    });
    const effect = defineEffect({
      elements: {
        volume,
        custom: defineSimStage({
          target: 'volume',
          update: grid3DTslModule(({ read }) => ({ density: read('density') as never })),
        }),
      },
    });
    expect(diagnosticCodes(() => serializeEffect(effect))).toContain('NACHI_ASSET_INLINE_FUNCTION');
  });
});
