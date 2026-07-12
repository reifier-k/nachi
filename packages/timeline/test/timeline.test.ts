import {
  EffectClock,
  VFXSystem as CoreVFXSystem,
  at as coreAt,
  billboard,
  burst,
  curve,
  defineEffect as defineCoreEffect,
  defineEmitter,
  defineParameter,
  emitTo,
  lifetime,
  marker as coreMarker,
  timeline as coreTimeline,
  type EffectDefinition,
  type EffectInstanceState,
  type VfxDiagnostic,
  type VfxEffectInstance,
  VfxDiagnosticError,
} from '@nachi/core';
import { fxMaterial as meshFxMaterial, ring, slashArc } from '@nachi/mesh-fx';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  VFXSystem,
  at,
  bindMeshFxResources,
  cameraShake,
  defineEffect,
  fxMaterial,
  getMeshFxResources,
  hitStop,
  lowerCurve,
  marker,
  meshFxElement,
  play,
  stop,
  timeline,
} from '../src/index.js';
import { cloneTimelineFxMaterial } from '../src/authoring.js';
import { timelineCoreOptions } from '../src/runtime.js';

function mesh(duration = 1) {
  return meshFxElement(
    slashArc({
      angle: 120,
      material: fxMaterial({
        dissolve: {
          overLife: curve([0, 0], [0.25, 0.8], [1, 1]),
          texture: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1),
        },
      }),
    }),
    { duration },
  );
}

function fakeChildInstance(
  initialState: EffectInstanceState = 'active',
  diagnostics: VfxDiagnostic[] = [],
  emitterView?: ReturnType<VfxEffectInstance['getEmitter']>,
) {
  const clock = new EffectClock();
  let state = initialState;
  const applyHitStop = vi.fn((durationMs: number, timeScale = 0) =>
    clock.applyHitStop(durationMs, timeScale),
  );
  const child = {
    applyHitStop,
    definition: { elements: {}, kind: 'effect' },
    diagnostics,
    get localTime() {
      return clock.localTime;
    },
    get state() {
      return state;
    },
    get timeScale() {
      return clock.timeScale;
    },
    getEmitter: () => emitterView,
    id: 'fake-timeline-child',
    on: () => () => undefined,
    release: () => {
      state = 'released';
    },
    setParameter: () => undefined,
    setTimeScale: (value: number) => clock.setTimeScale(value),
    setTransform: () => undefined,
    stop: () => {
      state = 'stopped';
    },
  } as unknown as VfxEffectInstance;
  return { advance: (delta: number) => clock.advance(delta), applyHitStop, child };
}

describe('@nachi/timeline authoring', () => {
  it('returns pure timeline data, sorts entries stably, and adapts mesh resources out of band', () => {
    const effect = defineEffect({
      elements: { arc: mesh() },
      timeline: [at(0.1, stop('arc')), at(0, play('arc')), at(0.1, marker('impact'))],
    });

    expect(effect.timeline).toMatchObject({
      duration: 0.1,
      entries: [
        { at: 0, actions: [{ kind: 'play', target: 'arc' }] },
        { at: 0.1, actions: [{ kind: 'stop', target: 'arc' }] },
        { at: 0.1, actions: [{ kind: 'marker', name: 'impact' }] },
      ],
      kind: 'timeline',
      speed: 1,
    });
    const serialized = JSON.parse(JSON.stringify(effect));
    expect(serialized.elements.arc).toEqual({
      config: { duration: 1, resource: 'arc' },
      kind: 'visual-element',
      type: 'timeline/mesh-fx',
      version: 1,
    });
  });

  it('lowers core curves to mesh-fx tuples and diagnoses unsupported keys', () => {
    expect(lowerCurve(curve([0, 0], [0.2, 0.75], [1, 1]))).toEqual([
      [0, 0],
      [0.2, 0.75],
      [1, 1],
    ]);
    expect(() =>
      lowerCurve({
        keys: [
          { time: 0, value: 0 },
          { interpolation: 'constant', time: 1, value: 1 },
        ],
        kind: 'curve',
      }),
    ).toThrow('linear curve keys only');
  });

  it('rebinds JSON mesh-fx references through an explicit external resource resolver', async () => {
    const authored = defineEffect({
      elements: { arc: mesh(0.3) },
      timeline: [at(0, play('arc'))],
    });
    const loaded = JSON.parse(JSON.stringify(authored)) as typeof authored;
    const resources = getMeshFxResources(authored);
    bindMeshFxResources(loaded, ({ resource }) => resources.get(resource)?.mesh);

    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(loaded);
    await system.update(0);
    expect(instance.getElementState('arc')).toMatchObject({ playing: true, visible: true });
    expect(scene.children.some(({ userData }) => Boolean(userData.nachiMeshFx))).toBe(true);
  });

  it('copies material configs before retaining them for instance cloning', () => {
    const config: { time?: number } = {};
    const material = fxMaterial(config);
    config.time = 1;

    const clone = cloneTimelineFxMaterial(material);
    expect(clone.fx.time).not.toBeNull();
  });

  it('diagnoses raw mesh-fx materials whose controls cannot be regenerated', () => {
    const effect = defineEffect({
      elements: { arc: slashArc({ angle: 90, material: meshFxMaterial() }) },
      timeline: [at(0, play('arc'))],
    });

    expect(() => new VFXSystem({}, new THREE.Scene()).spawn(effect)).toThrow(
      '@nachi/timeline fxMaterial()',
    );
  });

  it('rejects externally bound mesh-fx time during timeline authoring', () => {
    const arc = slashArc({ angle: 90, material: fxMaterial({ time: 0 }) });

    expect(() => defineEffect({ elements: { arc }, timeline: [at(0, play('arc'))] })).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'NACHI_TIMELINE_MESH_FX_TIME_BINDING_UNSUPPORTED',
            path: 'elements.arc.material.time',
          }),
        ],
      }),
    );
  });

  it('rejects unknown targets and invalid loop duration synchronously', () => {
    expect(() =>
      defineEffect({
        elements: { arc: mesh() },
        timeline: [at(0, play('missing'))] as never,
      }),
    ).toThrow('Unknown timeline target');
    expect(() =>
      defineEffect({
        elements: { arc: mesh() },
        timeline: timeline([at(0, play('arc'))], { loop: true }),
      }),
    ).toThrow('positive duration');
  });
});

describe('@nachi/timeline runtime', () => {
  it('keeps timeline children outside the core significance budget', () => {
    expect(
      timelineCoreOptions({
        qualityTier: 'high',
        significanceBudget: { maxActiveInstances: 0, maxParticles: 0 },
      }),
    ).toEqual({ qualityTier: 'high' });
  });

  it('keeps updates healthy after releasing an attached instance', async () => {
    const scene = new THREE.Scene();
    const effect = defineEffect({
      elements: { arc: mesh() },
      timeline: [at(0, play('arc'))],
    });
    const system = new VFXSystem({}, scene);
    const released = system.spawn(effect);
    released.attachTo({ getWorldTransform: () => ({ position: [1, 2, 3] }) });
    released.release();
    const unrelated = system.spawn(effect);

    for (let index = 0; index < 3; index += 1) {
      await expect(system.update(0.01)).resolves.toBeUndefined();
    }
    expect(unrelated.getElementState('arc')?.playing).toBe(true);
    expect(system.instanceCount).toBe(1);
  });

  it('normalizes unsorted core timelines and derives their duration defensively', async () => {
    const effect = defineCoreEffect({
      elements: {},
      timeline: coreTimeline([coreAt(0.1, coreMarker('late')), coreAt(0, coreMarker('time-zero'))]),
    });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);
    const markers: string[] = [];
    instance.onAction(({ action }) => {
      if (action.kind === 'marker') markers.push(action.name);
    });

    await system.update(0.1);
    expect(markers).toEqual(['time-zero', 'late']);
    expect(instance.localTime).toBeCloseTo(0.1, 10);
    expect(instance.state).toBe('complete');
  });

  it.each([
    ['zero speed', coreTimeline<never>([], { speed: 0 }), 'NACHI_TIMELINE_SPEED_INVALID'],
    ['negative speed', coreTimeline<never>([], { speed: -1 }), 'NACHI_TIMELINE_SPEED_INVALID'],
    ['NaN speed', coreTimeline<never>([], { speed: Number.NaN }), 'NACHI_TIMELINE_SPEED_INVALID'],
    [
      'negative entry time',
      coreTimeline([coreAt(-0.1, coreMarker('invalid'))]),
      'NACHI_TIMELINE_TIME_INVALID',
    ],
    [
      'NaN entry time',
      coreTimeline([coreAt(Number.NaN, coreMarker('invalid'))]),
      'NACHI_TIMELINE_TIME_INVALID',
    ],
  ])('marks a core-authored timeline with %s as an error', (_label, invalidTimeline, code) => {
    const effect = defineCoreEffect({ elements: {}, timeline: invalidTimeline });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);

    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code, phase: 'runtime', severity: 'error' }),
    );
  });

  it('validates inactive setParameter writes before storing them for a later play', () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const mutable = defineParameter('User.mutable', {
      default: 1,
      mutable: true,
      type: 'f32',
    });
    const immutable = defineParameter('User.immutable', { default: 2, type: 'f32' });
    const effect = defineEffect({
      elements: { child: emitter },
      parameters: { 'User.immutable': immutable, 'User.mutable': mutable },
      timeline: [at(1, play('child'))],
    });
    const instance = new VFXSystem({}).spawn(effect);
    const expectDiagnostic = (operation: () => void, code: string) => {
      try {
        operation();
        throw new Error('Expected parameter validation to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(VfxDiagnosticError);
        expect((error as VfxDiagnosticError).diagnostics).toContainEqual(
          expect.objectContaining({ code }),
        );
      }
    };

    expectDiagnostic(
      () => instance.setParameter('User.missing' as never, 1),
      'NACHI_PARAMETER_UNKNOWN',
    );
    expectDiagnostic(
      () => instance.setParameter('User.mutable', 'bad' as never),
      'NACHI_PARAMETER_TYPE_MISMATCH',
    );
    expectDiagnostic(() => instance.setParameter('User.immutable', 3), 'NACHI_PARAMETER_IMMUTABLE');
  });

  it('contains onAction failures per instance and preserves the full world delta', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline([at(0.09, marker('explode'))], { duration: 0.2 }),
    });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);
    instance.onAction(() => {
      throw new Error('gameplay callback failed');
    });

    await expect(system.update(0.12)).resolves.toBeUndefined();
    expect(system.time).toBeCloseTo(0.12, 10);
    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_ACTION_CALLBACK_FAILED',
        message: 'gameplay callback failed',
        phase: 'runtime',
      }),
    );
  });

  it('contains per-instance integration failures while unrelated instances keep advancing', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline([at(0.2, marker('done'))], { duration: 0.2 }),
    });
    const system = new VFXSystem({});
    const failing = system.spawn(effect);
    let attachmentReads = 0;
    failing.attachTo({
      getWorldTransform: () => {
        attachmentReads += 1;
        if (attachmentReads > 1) throw new Error('transform source failed');
        return { position: [0, 0, 0] };
      },
    });
    const healthy = system.spawn(effect);

    await expect(system.update(0.12)).resolves.toBeUndefined();
    expect(system.time).toBeCloseTo(0.12, 10);
    expect(failing.state).toBe('error');
    expect(failing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_INSTANCE_UPDATE_FAILED',
        message: 'transform source failed',
      }),
    );
    expect(healthy.localTime).toBeCloseTo(0.12, 10);
  });

  it('plays every element for an effect without an authored timeline', async () => {
    const scene = new THREE.Scene();
    const effect = defineEffect({ elements: { arc: mesh() } });
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);

    await system.update(0);
    expect(instance.getElementState('arc')).toMatchObject({ playing: true, visible: true });
  });

  it('fires in stable order, freezes local time while world time advances, and updates mesh life', async () => {
    const scene = new THREE.Scene();
    const effect = defineEffect({
      elements: { arc: mesh(0.2) },
      timeline: timeline(
        [
          at(0, play('arc')),
          at(0.05, marker('before'), hitStop(40), marker('after')),
          at(0.08, stop('arc')),
        ],
        { duration: 0.1 },
      ),
    });
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect, { seed: 7 });
    const events: string[] = [];
    instance.onAction(({ action }) =>
      events.push(action.kind === 'marker' ? action.name : action.kind),
    );

    expect(instance.getElementState('arc')).toMatchObject({ playing: false, visible: false });
    await system.update(0.05);
    expect(events).toEqual(['play', 'before', 'hit-stop', 'after']);
    expect(instance.getElementState('arc')).toMatchObject({
      localTime: 0.05,
      playing: true,
      visible: true,
    });
    expect(instance.localTime).toBeCloseTo(0.05, 10);
    await system.update(0.04);
    expect(system.time).toBeCloseTo(0.09, 10);
    expect(instance.localTime).toBeCloseTo(0.05, 10);
    expect(instance.getElementState('arc')?.localTime).toBeCloseTo(0.05, 10);
    await system.update(0.03);
    expect(instance.localTime).toBeCloseTo(0.08, 10);
    expect(instance.getElementState('arc')).toMatchObject({ playing: false, visible: false });
  });

  it('applies timeline speed and restarts element lifecycle at loop boundaries', async () => {
    const scene = new THREE.Scene();
    const effect = defineEffect({
      elements: { wave: mesh(1) },
      timeline: timeline([at(0, play('wave')), at(0.05, stop('wave'))], {
        duration: 0.1,
        loop: 2,
        speed: 2,
      }),
    });
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);

    await system.update(0.025);
    expect(instance.localTime).toBeCloseTo(0.05, 10);
    expect(instance.getElementState('wave')?.playing).toBe(false);
    await system.update(0.025);
    expect(instance.cycle).toBe(1);
    expect(instance.localTime).toBeCloseTo(0, 10);
    expect(instance.getElementState('wave')).toMatchObject({ localTime: 0, playing: true });
  });

  it('propagates residual hit stop to emitters played while it is active', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      init: [lifetime(1)],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { child: emitter },
      timeline: timeline([at(0, hitStop(100, 0.5)), at(0.01, play('child'))], {
        duration: 0.2,
      }),
    });
    const fake = fakeChildInstance();
    let spawned = false;
    const spawnSpy = vi.spyOn(CoreVFXSystem.prototype, 'spawn').mockImplementation(() => {
      spawned = true;
      return fake.child as never;
    });
    const updateSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'update')
      .mockImplementation((deltaSeconds) => {
        if (spawned) fake.advance(deltaSeconds ?? 0);
        return Promise.resolve();
      });
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect);
      await system.update(0.03);

      expect(fake.applyHitStop).toHaveBeenCalledTimes(1);
      expect(fake.applyHitStop.mock.calls[0]?.[0]).toBeCloseTo(80, 10);
      expect(fake.applyHitStop.mock.calls[0]?.[1]).toBe(0.5);
      expect(instance.getElementState('child')?.localTime).toBeCloseTo(0.005, 10);
    } finally {
      updateSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it('publishes the emitter view created by a play action', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      init: [lifetime(1)],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({ elements: { child: emitter }, timeline: [at(0, play('child'))] });
    const emitterView = { aliveCount: 1 } as NonNullable<
      ReturnType<VfxEffectInstance['getEmitter']>
    >;
    const fake = fakeChildInstance('active', [], emitterView);
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect);
      const played: unknown[] = [];
      instance.onAction((event) => played.push(event.emitter));

      await system.update(0);
      expect(played).toEqual([emitterView]);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('enters error once when a split child cannot resolve a cross-emitter event target', async () => {
    const source = defineEmitter({
      capacity: 1,
      events: { onDeath: emitTo('target') },
      init: [lifetime(0.1)],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const target = defineEmitter({
      capacity: 1,
      init: [lifetime(0.1)],
      render: billboard({}),
      spawn: burst({ count: 0 }),
    });
    const effect = defineEffect({
      elements: { source, target },
      timeline: [at(0, play('source'))],
    });
    const diagnostic: VfxDiagnostic = {
      code: 'NACHI_EVENT_TARGET_UNKNOWN',
      message: 'emitTo() target "target" is not an emitter in this effect.',
      phase: 'compile',
      severity: 'error',
    };
    const fake = fakeChildInstance('error', [diagnostic]);
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect);
      await system.update(0);

      expect(instance.state).toBe('error');
      expect(instance.diagnostics).toEqual([diagnostic]);
      expect(Object.keys((spawnSpy.mock.calls[0]?.[0] as EffectDefinition).elements)).toEqual([
        'source',
      ]);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('generates deterministic PCG shake samples with monotonic decay and a zero tail', async () => {
    const makeRun = async () => {
      const samples: Array<{ decay: number; translation: readonly number[] }> = [];
      const effect = defineEffect({
        elements: { ring: ring({ material: fxMaterial() }) },
        timeline: timeline(
          [at(0, play('ring'), cameraShake({ duration: 0.1, frequency: 20, strength: 0.3 }))],
          { duration: 0.2 },
        ),
      });
      const system = new VFXSystem({}, new THREE.Scene(), {
        cameraShakeTarget: ({ decay, translation }) => samples.push({ decay, translation }),
      });
      system.spawn(effect, { seed: 1234 });
      for (let index = 0; index < 5; index += 1) await system.update(0.025);
      return samples;
    };
    const first = await makeRun();
    const second = await makeRun();
    expect(second).toEqual(first);
    expect(first.some(({ translation }) => translation.some((value) => Math.abs(value) > 0))).toBe(
      true,
    );
    const positiveDecay = first.map(({ decay }) => decay).filter((value) => value > 0);
    expect(positiveDecay).toEqual([...positiveDecay].sort((a, b) => b - a));
    expect(first.filter(({ decay }) => decay === 0)).toHaveLength(1);
    expect(first.at(-1)).toMatchObject({ decay: 0, translation: [0, 0, 0] });
  });

  it('diagnoses and clamps pathological boundary overflow without rejecting', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline<never>([], { duration: 0.000001, loop: true }),
    });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);

    await expect(system.update(0.010001)).resolves.toBeUndefined();
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_BOUNDARY_OVERFLOW',
        severity: 'warning',
      }),
    );
    expect(system.time).toBeLessThan(0.010001);
  });
});
