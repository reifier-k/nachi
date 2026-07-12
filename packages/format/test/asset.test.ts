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
  defineSimStage,
  defineParameter,
  defineTslFunction,
  drag,
  emitTo,
  gradient,
  gravity,
  gridAdvect,
  gridInject,
  gridTslModule,
  hitStop,
  lifetime,
  lightIntensity,
  marker,
  meshRenderer,
  parameter,
  play,
  positionSphere,
  range,
  sizeOverLife,
  stop,
  timeline,
  tslModule,
  velocityCone,
  type TextureRef,
} from '@nachi/core';
import { describe, expect, it } from 'vitest';

import {
  EFFECT_ASSET_FORMAT,
  EFFECT_ASSET_VERSION,
  EffectAssetMigrationRegistry,
  effectAssetSchemaV1,
  loadEffect,
  serializeEffect,
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
      positionSphere({ radius: range(0.1, 0.3), surfaceOnly: true }),
      velocityCone({ angle: 35, direction: [0, 1, 0], speed: range(2, 6) }),
      lifetime(range(0.4, 0.9)),
      lightIntensity(2),
    ],
    lifecycle: { duration: 1.5, loopCount: 2, prewarm: 0.1, startDelay: 0.05 },
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

describe('effect asset v1', () => {
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

  it('publishes the v1 JSON schema and treats v1 -> v1 migration as identity', () => {
    const document = serializeEffect(representativeEffect());
    expect(effectAssetSchemaV1.properties.format.const).toBe('nachi-effect');
    expect(effectAssetSchemaV1.properties.version.const).toBe(1);
    expect(loadEffect(document)).toEqual(document.effect);
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
            render: billboard({}),
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
            render: billboard({}),
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
      render: billboard({}),
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
    expect(serializeEffect(loadEffect(document))).toEqual(document);
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
});
