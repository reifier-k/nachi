import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  VFXSystem,
  at,
  billboard,
  burst,
  cameraShake,
  colorOverLife,
  curlNoise,
  curve,
  defineEffect,
  defineEmitter,
  defineParameter,
  defineTslFunction,
  drag,
  emitTo,
  flipbook,
  gradient,
  gravity,
  hitStop,
  lifetime,
  parameter,
  play,
  positionSphere,
  range,
  sizeOverLife,
  tslModule,
  velocityCone,
} from '../src/index.js';
import type {
  FxMaterialFactory,
  PolarUvFactory,
  PositionInput,
  RotationInput,
  SlashArcFactory,
  TextureRef,
  TslExpression,
  TslParticleBindings,
  UpdateModule,
  Vec3,
  VisualElementDefinition,
} from '../src/index.js';

declare const explosionTex: TextureRef;
declare const noiseTex: TextureRef;
declare const flash: VisualElementDefinition;
declare const shockwave: VisualElementDefinition;
declare const hitPoint: PositionInput;
declare const swingDir: RotationInput;
declare const renderer: { readonly kind: 'renderer' };
declare const scene: { readonly kind: 'scene' };
declare const slashArc: SlashArcFactory;
declare const fxMaterial: FxMaterialFactory;
declare const polarUV: PolarUvFactory;

declare function myCustomField(position: TslExpression<Vec3>): TslExpression<Vec3>;

function northStarApiExample() {
  const sparks = defineEmitter({
    capacity: 500,
    spawn: burst({ count: 200 }),
    init: [
      positionSphere({ radius: 0.2 }),
      velocityCone({ direction: [0, 1, 0], angle: 30, speed: range(4, 8) }),
      lifetime(range(0.4, 0.9)),
    ],
    update: [
      gravity(-9.8),
      drag(0.5),
      curlNoise({ strength: 2, frequency: 0.5 }),
      sizeOverLife(curve([0, 0], [0.1, 1], [1, 0])),
      colorOverLife(gradient('#ffd27d', '#ff5a00', '#000000')),
    ],
    events: {
      onDeath: emitTo('smokePuffs', { inherit: ['position', 'velocity'] }),
    },
    render: billboard({
      map: flipbook(explosionTex, { cols: 8, rows: 8, motionVectors: true }),
      blending: 'additive',
      soft: true,
    }),
  });

  const arc = slashArc({
    angle: 140,
    material: fxMaterial({
      uv: polarUV().flow({ speed: [2, 0] }),
      dissolve: { texture: noiseTex, overLife: curve([0, 0], [1, 1]) },
      fresnel: { color: '#66ddff', power: 2 },
      blending: 'additive',
    }),
  });

  const skillSlash = defineEffect({
    elements: { arc, sparks, flash, shockwave },
    timeline: [
      at(0.0, play('flash')),
      at(0.05, play('arc'), cameraShake({ strength: 0.3 }), hitStop(40)),
      at(0.08, play('sparks')),
      at(0.1, play('shockwave')),
    ],
  });

  const fx = new VFXSystem(renderer, scene);
  fx.spawn(skillSlash, { position: hitPoint, rotation: swingDir });

  return skillSlash;
}

function customTslBehaviorExample(): UpdateModule {
  return tslModule(({ position, velocity, age }) => {
    void age;
    return {
      velocity: velocity.add(myCustomField(position)),
    };
  });
}

function registeredTslBehaviorExample(): UpdateModule {
  const behavior = defineTslFunction('game/custom-field', ({ position, velocity }) => ({
    velocity: velocity.add(myCustomField(position)),
  }));
  return tslModule(behavior.ref);
}

function parameterizedEffectExample() {
  const effect = defineEffect({
    elements: { flash },
    parameters: {
      'User.intensity': defineParameter('User.intensity', {
        type: 'f32',
        default: 1,
        mutable: true,
      }),
    },
  });
  const fx = new VFXSystem(renderer, scene);
  const instance = fx.spawn(effect, {
    parameters: { 'User.intensity': 0.5 },
  });
  instance.setParameter('User.intensity', 0.75);
  // @ts-expect-error User parameter paths are derived from the effect definition.
  instance.setParameter('User.typo', 0.75);
  // @ts-expect-error User parameter values are derived from their declared logical type.
  instance.setParameter('User.intensity', 'high');
  return effect;
}

function invalidTimelineTargetExample() {
  return defineEffect({
    elements: { flash },
    // @ts-expect-error Effect timelines may only target declared element keys.
    timeline: [at(0, play('typo'))],
  });
}

function invalidEffectSpawnExample(): void {
  const fx = new VFXSystem(renderer, scene);
  // @ts-expect-error Spawn requires a complete structurally typed effect definition.
  fx.spawn({ kind: 'effect' } as const);
}

type HeatBindings = TslParticleBindings<{ heat: number }>;

function customAttributeTslExample(): UpdateModule {
  return tslModule<HeatBindings>((bindings) => ({
    'custom.heat': bindings['custom.heat'],
  }));
}

function invalidCustomAttributeTslExample(): UpdateModule {
  return tslModule<HeatBindings>((bindings) => ({
    // @ts-expect-error Custom TSL bindings are restricted to declared custom.* keys.
    'custom.heat': bindings['custom.temperature'],
  }));
}

describe('PLAN.md north-star API', () => {
  it('type-checks the effect composition sketch', () => {
    expectTypeOf(northStarApiExample).returns.toMatchTypeOf<{ readonly kind: 'effect' }>();
    expectTypeOf(parameterizedEffectExample).returns.toMatchTypeOf<{ readonly kind: 'effect' }>();
    expectTypeOf(invalidTimelineTargetExample).returns.toMatchTypeOf<{ readonly kind: 'effect' }>();
    expectTypeOf(invalidEffectSpawnExample).returns.toEqualTypeOf<void>();
  });

  it('type-checks the inline TSL escape hatch', () => {
    expectTypeOf(customTslBehaviorExample).returns.toMatchTypeOf<UpdateModule>();
    expectTypeOf(registeredTslBehaviorExample).returns.toMatchTypeOf<UpdateModule>();
    expectTypeOf(customAttributeTslExample).returns.toMatchTypeOf<UpdateModule>();
    expectTypeOf(invalidCustomAttributeTslExample).returns.toMatchTypeOf<UpdateModule>();
  });

  it('distinguishes traced access from a declared empty manifest', () => {
    const traced = tslModule(({ velocity }) => ({ velocity }));
    expect(traced).not.toHaveProperty('access');

    const declared = tslModule(({ velocity }) => ({ velocity }), {
      access: { reads: [], writes: [] },
    });
    expect(declared.access).toEqual({ reads: [], writes: [] });
  });

  it('normalizes parameter generator reads and event queue writes', () => {
    const parameterizedGravity = gravity(parameter('User.gravity', -9.8));
    expect(parameterizedGravity.access?.reads).toContain('User.gravity');

    const emitter = defineEmitter({
      capacity: 1,
      spawn: burst({ count: 1 }),
      events: {
        onDeath: [emitTo('smoke'), emitTo('flash')],
      },
      render: billboard({}),
    });
    const handlers = emitter.events?.onDeath;
    expect(Array.isArray(handlers)).toBe(true);
    if (Array.isArray(handlers)) {
      expect(handlers[0]?.access?.writes).toContain('Emitter.events.onDeath');
      expect(handlers[1]?.access?.writes).toContain('Emitter.events.onDeath');
      expect(handlers[0]?.access?.writes).not.toContain('Emitter.events.pending');
      expect(handlers[1]?.access?.writes).not.toContain('Emitter.events.pending');
    }
  });

  it('uses emitter-local scaled time for force integration', () => {
    for (const module of [gravity(-9.8), drag(0.5), curlNoise({ strength: 1, frequency: 2 })]) {
      expect(module.access?.reads).toContain('Emitter.deltaTime');
      expect(module.access?.reads).not.toContain('System.deltaTime');
    }
  });

  it('rejects compiler-reserved module labels on user-authored emitters', () => {
    const reservedSpawn = { ...burst({ count: 1 }), label: '$custom' };
    expect(() =>
      defineEmitter({
        capacity: 1,
        spawn: reservedSpawn,
        render: billboard({}),
      }),
    ).toThrow('compiler-reserved "$" prefix');
  });

  it('rejects parameter record keys that differ from their declared paths', () => {
    const mismatchedParameters = {
      'User.alias': defineParameter('User.actual', { default: 1, type: 'f32' }),
    };
    const emitter = defineEmitter({
      capacity: 1,
      spawn: burst({ count: 1 }),
      render: billboard({}),
    });

    expect(() =>
      defineEmitter({
        capacity: 1,
        parameters: mismatchedParameters,
        spawn: burst({ count: 1 }),
        render: billboard({}),
      }),
    ).toThrow('Parameter key "User.alias" must match its declared path "User.actual".');
    expect(() =>
      defineEffect({
        elements: { emitter },
        parameters: mismatchedParameters,
      }),
    ).toThrow('Parameter key "User.alias" must match its declared path "User.actual".');
  });
});
