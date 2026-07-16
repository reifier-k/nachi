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
  perDistance,
  rate,
  timeline as coreTimeline,
  type EffectDefinition,
  type EffectInstanceState,
  type KernelComputeNode,
  type KernelNode,
  type KernelTslAdapter,
  type VfxDiagnostic,
  type VfxEffectInstance,
  type VfxRuntimeRenderer,
  VfxDiagnosticError,
} from '@nachi-vfx/core';
import { fxMaterial as meshFxMaterial, ring, slashArc, type MeshFxMesh } from '@nachi-vfx/mesh-fx';
import * as THREE from 'three';
import { float } from 'three/tsl';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

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
  type TimelineMeshFxElementKey,
} from '../src/index.js';
import { cloneTimelineFxMaterial } from '../src/authoring.js';
import { timelineCoreOptions } from '../src/runtime.js';
import { TimelineEffectInstance } from '../src/runtime.js';

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
  const setTimeScale = vi.fn((value: number) => clock.setTimeScale(value));
  const setTransform = vi.fn();
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
    setTimeScale,
    setTransform,
    stop: () => {
      state = 'stopped';
    },
  } as unknown as VfxEffectInstance;
  return {
    advance: (delta: number) => clock.advance(delta),
    applyHitStop,
    child,
    setTransform,
    setTimeScale,
    setState: (value: EffectInstanceState) => {
      state = value;
    },
  };
}

function fakeKernelNode(value: unknown = 0): KernelNode {
  const components = new Set(['a', 'b', 'g', 'r', 'w', 'x', 'xy', 'xyz', 'y', 'z']);
  let proxy: KernelNode;
  const target = {
    value,
    element: () => proxy,
    setName: () => proxy,
    toAtomic: () => proxy,
  };
  proxy = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      if (typeof property === 'string' && components.has(property)) return proxy;
      return () => proxy;
    },
  }) as unknown as KernelNode;
  return proxy;
}

function fakeRuntimeRenderer(): VfxRuntimeRenderer & { readonly submissions: string[] } {
  const node = () => fakeKernelNode();
  const adapterTarget = {
    capabilities: {
      atomics: true,
      backend: 'webgpu' as const,
      indirectDispatch: true,
      indirectDraw: true,
    },
    instanceIndex: node(),
    branch: (_condition: KernelNode, whenTrue: () => void) => whenTrue(),
    constant: (value: unknown) => fakeKernelNode(value),
    fn: (callback: () => void) => {
      callback();
      let compute: KernelComputeNode;
      const target = {
        name: '',
        compute: () => compute,
        computeKernel: () => compute,
        setName(name: string) {
          target.name = name;
          return compute;
        },
      };
      compute = target as unknown as KernelComputeNode;
      return compute;
    },
    indirectArray: () => Object.assign(node(), { indirectResource: {} }),
    instancedArray: node,
    loop: (_parameters: unknown, callback: (index: KernelNode) => void) => callback(node()),
    uniform: (value: unknown) => fakeKernelNode(value),
  };
  const adapter = new Proxy(adapterTarget, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return node;
    },
  }) as unknown as KernelTslAdapter;
  const submissions: string[] = [];
  const submitCompute = (kernel: KernelComputeNode) => {
    submissions.push((kernel as unknown as { name: string }).name);
  };
  return {
    kernelAdapter: adapter,
    submissions,
    submitCompute,
    submitComputeIndirect: submitCompute,
  };
}

describe('@nachi-vfx/timeline authoring', () => {
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

  it('snapshots current fx controls and Three material state into independent timeline clones', () => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const authoredMaterial = fxMaterial({ map: texture, opacity: 0.8 });
    authoredMaterial.map = texture;
    authoredMaterial.fx.setOpacity(0.2);
    authoredMaterial.fx.setTime(0.4);
    authoredMaterial.fx.setNormalizedLife(0.3);
    authoredMaterial.name = 'current-source-material';
    authoredMaterial.userData = { ownership: { source: 9 } };
    authoredMaterial.side = THREE.DoubleSide;
    authoredMaterial.shadowSide = THREE.BackSide;
    authoredMaterial.depthTest = false;
    authoredMaterial.depthWrite = true;
    authoredMaterial.colorWrite = false;
    authoredMaterial.transparent = false;
    authoredMaterial.blending = THREE.AdditiveBlending;
    authoredMaterial.polygonOffset = true;
    authoredMaterial.polygonOffsetFactor = 2;
    authoredMaterial.polygonOffsetUnits = 3;
    authoredMaterial.wireframe = true;
    authoredMaterial.wireframeLinewidth = 2;
    authoredMaterial.lights = false;
    authoredMaterial.stencilWrite = true;
    authoredMaterial.stencilWriteMask = 0x3f;
    authoredMaterial.stencilFunc = THREE.EqualStencilFunc;
    authoredMaterial.stencilRef = 7;
    authoredMaterial.stencilFuncMask = 0x7f;
    authoredMaterial.stencilFail = THREE.ReplaceStencilOp;
    authoredMaterial.stencilZFail = THREE.IncrementWrapStencilOp;
    authoredMaterial.stencilZPass = THREE.DecrementWrapStencilOp;
    authoredMaterial.toneMapped = false;
    authoredMaterial.visible = false;
    authoredMaterial.clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 2)];
    const authoredMesh = ring({ material: authoredMaterial });
    authoredMesh.name = 'material-state-snapshot';
    const effect = defineEffect({
      elements: { ring: meshFxElement(authoredMesh) },
      timeline: timeline([at(0.5, play('ring'))], { duration: 1 }),
    });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const first = system.spawn(effect);
    const second = system.spawn(effect);
    const [firstMesh, secondMesh] = scene.children.filter(
      ({ name }) => name === 'material-state-snapshot',
    ) as THREE.Mesh[];
    const firstMaterial = firstMesh!.material as ReturnType<typeof fxMaterial>;
    const secondMaterial = secondMesh!.material as ReturnType<typeof fxMaterial>;

    for (const clone of [firstMaterial, secondMaterial]) {
      expect(clone.fx.opacity?.value).toBe(0.2);
      expect(clone.fx.time?.value).toBe(0.4);
      expect(clone.fx.normalizedLife?.value).toBe(0.3);
      expect(clone.name).toBe('current-source-material');
      expect(clone.userData).toEqual({ ownership: { source: 9 } });
      expect(clone.side).toBe(THREE.DoubleSide);
      expect(clone.shadowSide).toBe(THREE.BackSide);
      expect(clone.depthTest).toBe(false);
      expect(clone.depthWrite).toBe(true);
      expect(clone.colorWrite).toBe(false);
      expect(clone.transparent).toBe(false);
      expect(clone.blending).toBe(THREE.AdditiveBlending);
      expect(clone.polygonOffset).toBe(true);
      expect(clone.polygonOffsetFactor).toBe(2);
      expect(clone.polygonOffsetUnits).toBe(3);
      expect(clone.wireframe).toBe(true);
      expect(clone.wireframeLinewidth).toBe(2);
      expect(clone.lights).toBe(false);
      expect(clone.stencilWrite).toBe(true);
      expect(clone.stencilWriteMask).toBe(0x3f);
      expect(clone.stencilFunc).toBe(THREE.EqualStencilFunc);
      expect(clone.stencilRef).toBe(7);
      expect(clone.stencilFuncMask).toBe(0x7f);
      expect(clone.stencilFail).toBe(THREE.ReplaceStencilOp);
      expect(clone.stencilZFail).toBe(THREE.IncrementWrapStencilOp);
      expect(clone.stencilZPass).toBe(THREE.DecrementWrapStencilOp);
      expect(clone.map).toBe(texture);
      expect(clone.toneMapped).toBe(false);
      expect(clone.visible).toBe(false);
      expect(clone.clippingPlanes?.[0]).toEqual(
        expect.objectContaining({ constant: 2, normal: expect.objectContaining({ x: 1 }) }),
      );
    }
    expect(firstMaterial).not.toBe(authoredMaterial);
    expect(secondMaterial).not.toBe(authoredMaterial);
    expect(secondMaterial).not.toBe(firstMaterial);
    expect(firstMaterial.fx.opacity).not.toBe(secondMaterial.fx.opacity);
    expect(firstMaterial.fx.opacity).not.toBe(authoredMaterial.fx.opacity);
    expect(firstMaterial.fx.time).not.toBe(secondMaterial.fx.time);
    expect(firstMaterial.fx.time).not.toBe(authoredMaterial.fx.time);
    expect(firstMaterial.fx.normalizedLife).not.toBe(secondMaterial.fx.normalizedLife);
    expect(firstMaterial.fx.normalizedLife).not.toBe(authoredMaterial.fx.normalizedLife);
    expect(firstMaterial.opacityNode).not.toBe(secondMaterial.opacityNode);
    expect(firstMaterial.opacityNode).not.toBe(authoredMaterial.opacityNode);
    expect(firstMaterial.colorNode).not.toBe(secondMaterial.colorNode);
    expect(firstMaterial.colorNode).not.toBe(authoredMaterial.colorNode);
    expect(firstMaterial.map).toBe(authoredMaterial.map);
    expect(secondMaterial.map).toBe(authoredMaterial.map);
    expect(firstMaterial.userData).not.toBe(secondMaterial.userData);
    expect(firstMaterial.userData.ownership).not.toBe(secondMaterial.userData.ownership);
    expect(firstMaterial.clippingPlanes?.[0]).not.toBe(secondMaterial.clippingPlanes?.[0]);

    firstMaterial.fx.setOpacity(0.6);
    firstMaterial.side = THREE.FrontSide;
    firstMaterial.name = 'first-only';
    firstMaterial.userData.ownership.source = 1;
    firstMaterial.clippingPlanes![0]!.constant = 10;
    firstMaterial.stencilRef = 2;
    authoredMaterial.fx.setOpacity(0.9);
    authoredMaterial.depthTest = true;
    authoredMaterial.stencilFunc = THREE.NeverStencilFunc;
    authoredMaterial.userData.ownership.source = 0;

    expect(secondMaterial.fx.opacity?.value).toBe(0.2);
    expect(secondMaterial.side).toBe(THREE.DoubleSide);
    expect(secondMaterial.name).toBe('current-source-material');
    expect(secondMaterial.depthTest).toBe(false);
    expect(secondMaterial.userData).toEqual({ ownership: { source: 9 } });
    expect(secondMaterial.clippingPlanes?.[0]?.constant).toBe(2);
    expect(secondMaterial.stencilRef).toBe(7);
    expect(secondMaterial.stencilFunc).toBe(THREE.EqualStencilFunc);
    expect(authoredMaterial.fx.opacity?.value).toBe(0.9);
    expect(authoredMaterial.side).toBe(THREE.DoubleSide);
    expect(authoredMaterial.name).toBe('current-source-material');
    expect(authoredMaterial.userData).toEqual({ ownership: { source: 0 } });

    first.release();
    second.release();
    authoredMaterial.dispose();
    authoredMesh.geometry.dispose();
    texture.dispose();
  });

  it('lowers opacityOverLife curves through the writable opacity control', async () => {
    const authoredMaterial = fxMaterial({
      opacityOverLife: curve([0, 0.5], [0.2, 0.5], [1, 0]),
    });
    const authoredMesh = ring({ material: authoredMaterial });
    authoredMesh.name = 'opacity-over-life-probe';
    const effect = defineEffect({
      elements: { ring: meshFxElement(authoredMesh, { duration: 1 }) },
      timeline: [at(0, play('ring'))],
    });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);

    await system.update(0);
    const clone = scene.getObjectByName('opacity-over-life-probe') as THREE.Mesh;
    const material = clone.material as ReturnType<typeof fxMaterial>;
    expect(material.fx.opacity?.value).toBe(0.5);
    await system.update(0.6);
    expect(material.fx.opacity?.value).toBeCloseTo(0.25, 8);
    await system.update(0.2);
    expect(material.fx.opacity?.value).toBeCloseTo(0.125, 8);
  });

  it('keeps opacityOverLife nodes compile-time bound and rejects dual opacity ownership', () => {
    const external = fxMaterial({ opacityOverLife: float(0.4) });
    expect(external.fx.opacity).toBeNull();
    expect(() => external.fx.setOpacity(0.5)).toThrow();
    expect(() => fxMaterial({ opacity: 0.5, opacityOverLife: curve([0, 1], [1, 0]) })).toThrow(
      'both own the mesh-fx opacity channel',
    );
  });

  it('returns an error instance and removes already-added meshes when construction fails', () => {
    const addedFirst = mesh();
    const invalid = slashArc({ angle: 90, material: meshFxMaterial() });
    const effect = defineEffect({
      elements: { addedFirst, invalid },
      timeline: [at(0, play('addedFirst'))],
    });
    const scene = new THREE.Scene();
    const dispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const geometryDispose = vi.spyOn(addedFirst.mesh.geometry, 'dispose');
    const sourceMaterial = addedFirst.mesh.material;
    const invalidSourceMaterial = invalid.material;

    const instance = new VFXSystem({}, scene).spawn(effect);

    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_MESH_FX_MATERIAL_CLONE_UNSUPPORTED' }),
    );
    expect(scene.children).toHaveLength(0);
    expect(() => instance.setUserVisible('addedFirst', false)).toThrow(
      'instance is in the error or released state',
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.contexts[0]).not.toBe(sourceMaterial);
    expect(dispose.mock.contexts[0]).not.toBe(invalidSourceMaterial);
    expect(geometryDispose).not.toHaveBeenCalled();
    dispose.mockRestore();
    geometryDispose.mockRestore();
    sourceMaterial.dispose();
    invalidSourceMaterial.dispose();
    addedFirst.mesh.geometry.dispose();
    invalid.geometry.dispose();
  });

  it('rejects externally bound mesh-fx time during timeline authoring', () => {
    const arc = slashArc({ angle: 90, material: fxMaterial({ time: 0 }) });

    expect(() => defineEffect({ elements: { arc }, timeline: [at(0, play('arc'))] })).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'NACHI_MESH_FX_TIME_BINDING_UNSUPPORTED',
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

describe('@nachi-vfx/timeline runtime', () => {
  it('shares the fixed-step epsilon validation at the timeline system boundary', () => {
    for (const stepSeconds of [0, 1e-12, 1e-10]) {
      expect(
        () =>
          new VFXSystem({}, undefined, {
            fixedTimeStep: { stepSeconds },
          }),
      ).toThrowError('stepSeconds must be greater than 1e-10 seconds.');
    }
    expect(
      new VFXSystem({}, undefined, {
        fixedTimeStep: { stepSeconds: 1.000_001e-10 },
      }).fixedStepDroppedSeconds,
    ).toBe(0);
    expect(
      () =>
        new VFXSystem({}, undefined, {
          fixedTimeStep: { maxSubSteps: 2, stepSeconds: Number.MAX_VALUE },
        }),
    ).toThrowError('stepSeconds * maxSubSteps must be a finite number.');
    expect(
      new VFXSystem({}, undefined, {
        fixedTimeStep: { maxSubSteps: 2, stepSeconds: Number.MAX_VALUE / 2 },
      }).fixedStepDroppedSeconds,
    ).toBe(0);
  });

  it('returns an error instance when an implicit timeline targets an unsupported element', () => {
    const effect = defineCoreEffect({
      elements: {
        unsupported: {
          config: {},
          kind: 'visual-element',
          type: 'test/unsupported',
          version: 1,
        },
      },
    });
    const instance = new VFXSystem({}).spawn(effect);

    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_TIMELINE_ELEMENT_ADAPTER_MISSING' }),
    );
  });

  it('keeps timeline children outside the core significance budget', () => {
    expect(
      timelineCoreOptions({
        maxMeasuredDeltaSeconds: 0.1,
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
    [
      'duration before last entry',
      { duration: 0.1, entries: [coreAt(0.2, coreMarker('late'))], kind: 'timeline' } as const,
      'NACHI_TIMELINE_DURATION_INVALID',
    ],
    [
      'NaN duration',
      { duration: Number.NaN, entries: [], kind: 'timeline' } as const,
      'NACHI_TIMELINE_DURATION_INVALID',
    ],
    [
      'zero-duration loop',
      { duration: 0, entries: [], kind: 'timeline', loop: true } as const,
      'NACHI_TIMELINE_LOOP_DURATION_REQUIRED',
    ],
    [
      'zero loop count',
      { duration: 1, entries: [], kind: 'timeline', loop: 0 } as const,
      'NACHI_TIMELINE_LOOP_INVALID',
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
    const delivered: string[] = [];
    const system = new VFXSystem({}, undefined, {
      onRuntimeDiagnostic: ({ code }) => delivered.push(code),
    });
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
    expect(delivered).toEqual(['NACHI_TIMELINE_ACTION_CALLBACK_FAILED']);
  });

  it('uses default, null, and throwing runtime delivery for timeline-owned failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const effect = defineEffect({
      elements: {},
      timeline: timeline([at(0, marker('fail'))], { duration: 0.1 }),
    });
    const spawnFailing = (system: VFXSystem<unknown, unknown>) => {
      const instance = system.spawn(effect);
      instance.onAction(() => {
        throw new Error('timeline delivery probe');
      });
      return instance;
    };
    try {
      const defaultSystem = new VFXSystem({});
      const defaultInstance = spawnFailing(defaultSystem);
      await defaultSystem.update(0);
      expect(defaultInstance.state).toBe('error');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('[NACHI_TIMELINE_ACTION_CALLBACK_FAILED]'),
      );

      error.mockClear();
      const nullSystem = new VFXSystem({}, undefined, { onRuntimeDiagnostic: null });
      const nullInstance = spawnFailing(nullSystem);
      await nullSystem.update(0);
      expect(nullInstance.state).toBe('error');
      expect(error).not.toHaveBeenCalled();

      let calls = 0;
      const throwingSystem = new VFXSystem({}, undefined, {
        onRuntimeDiagnostic: () => {
          calls += 1;
          throw new Error('timeline runtime handler failed');
        },
      });
      const throwingInstance = spawnFailing(throwingSystem);
      await throwingSystem.update(0);
      expect(calls).toBe(1);
      expect(
        throwingInstance.diagnostics.filter(
          ({ code }) => code === 'NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED',
        ),
      ).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED]'),
      );

      await expect(
        throwingSystem.prepare(defineEffect({ elements: { prepared: mesh() } }), {
          preparer: {
            prepareEmitter: vi.fn(),
            prepareObject: () => {
              throw new Error('ownerless timeline prepare failure');
            },
          },
        }),
      ).rejects.toThrow('ownerless timeline prepare failure');
      expect(calls).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('contains per-instance integration failures while unrelated instances keep advancing', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline([at(0.2, marker('done'))], { duration: 0.2 }),
    });
    const delivered: string[] = [];
    const system = new VFXSystem({}, undefined, {
      onRuntimeDiagnostic: ({ code }) => delivered.push(code),
    });
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
    expect(delivered).toEqual(['NACHI_TIMELINE_INSTANCE_UPDATE_FAILED']);
  });

  it('copies an already-delivered child diagnostic without timeline redelivery', () => {
    const childDiagnostic: VfxDiagnostic = {
      code: 'NACHI_GPU_SUBMISSION_FAILED',
      message: 'child core already delivered this failure',
      phase: 'runtime',
      severity: 'error',
    };
    const child = fakeChildInstance('error', [childDiagnostic]).child;
    const delivered: string[] = [];
    const instance = new TimelineEffectInstance(
      defineEffect({
        elements: {
          child: defineEmitter({
            capacity: 1,
            render: billboard({}),
            spawn: burst({ count: 0 }),
          }),
        },
      }),
      'timeline-child-copy',
      undefined,
      {},
      undefined,
      () => child,
      (_owner, diagnostic) => delivered.push(diagnostic.code),
    );

    instance.beginUpdate();

    expect(instance.state).toBe('error');
    expect(instance.diagnostics).toEqual([childDiagnostic]);
    expect(delivered).toEqual([]);
  });

  it('plays every element for an effect without an authored timeline', async () => {
    const scene = new THREE.Scene();
    const effect = defineEffect({ elements: { arc: mesh() } });
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);

    await system.update(0);
    expect(instance.getElementState('arc')).toMatchObject({ playing: true, visible: true });
  });

  it('composes authored mesh-fx local transforms with spawn and live effect transforms', () => {
    const authored = ring({
      innerRadius: 0.5,
      material: fxMaterial(),
      outerRadius: 1,
    });
    authored.name = 'authored-local-ring';
    authored.position.y = -0.9;
    authored.rotation.x = -Math.PI / 2;
    const effect = defineEffect({ elements: { ring: meshFxElement(authored) } });
    const scene = new THREE.Scene();
    const instance = new VFXSystem({}, scene).spawn(effect, { position: [1, 0, 0] });
    const clone = scene.getObjectByName('authored-local-ring');

    expect(clone).toBeInstanceOf(THREE.Mesh);
    expect(clone?.position.toArray()).toEqual([1, -0.9, 0]);
    expect(clone?.quaternion.x).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(clone?.quaternion.y).toBeCloseTo(0, 10);
    expect(clone?.quaternion.z).toBeCloseTo(0, 10);
    expect(clone?.quaternion.w).toBeCloseTo(Math.SQRT1_2, 10);

    authored.position.set(100, 100, 100);
    authored.quaternion.identity();
    instance.setTransform([2, 3, 4], [0, 0, Math.PI / 2]);

    expect(clone?.position.x).toBeCloseTo(2.9, 10);
    expect(clone?.position.y).toBeCloseTo(3, 10);
    expect(clone?.position.z).toBeCloseTo(4, 10);
    expect(clone?.quaternion.x).toBeCloseTo(-0.5, 10);
    expect(clone?.quaternion.y).toBeCloseTo(-0.5, 10);
    expect(clone?.quaternion.z).toBeCloseTo(0.5, 10);
    expect(clone?.quaternion.w).toBeCloseTo(0.5, 10);
  });

  it('does not overwrite page-driven clone scale during updates or setTransform', async () => {
    const authored = ring({
      innerRadius: 0.5,
      material: fxMaterial(),
      outerRadius: 1,
    });
    authored.name = 'animated-scale-ring';
    authored.scale.set(0.5, 0.75, 1.25);
    const effect = defineEffect({
      elements: { ring: meshFxElement(authored, { duration: 1 }) },
      timeline: [at(0, play('ring'))],
    });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);
    const clone = scene.getObjectByName('animated-scale-ring');

    expect(clone?.scale.toArray()).toEqual([0.5, 0.75, 1.25]);
    await system.update(0.1);
    expect(instance.getElementState('ring')?.playing).toBe(true);
    expect(clone?.scale.toArray()).toEqual([0.5, 0.75, 1.25]);
    clone?.scale.set(2, 3, 4);
    await system.update(0.1);
    expect(clone?.scale.toArray()).toEqual([2, 3, 4]);

    instance.setTransform([1, 2, 3], [0.1, 0.2, 0.3]);
    expect(clone?.scale.toArray()).toEqual([2, 3, 4]);
  });

  it('shares borrowed geometry without disposing it when timeline clones release', () => {
    const sourceMaterial = fxMaterial();
    const authored = ring({ material: sourceMaterial, segments: 8 });
    authored.name = 'borrowed-geometry-ring';
    const position = authored.geometry.getAttribute('position') as THREE.BufferAttribute;
    const geometryDispose = vi.spyOn(authored.geometry, 'dispose');
    const sourceMaterialDispose = vi.spyOn(sourceMaterial, 'dispose');
    const effect = defineEffect({ elements: { ring: authored } });
    const scene = new THREE.Scene();
    const instance = new VFXSystem({}, scene).spawn(effect);
    const clone = scene.getObjectByName('borrowed-geometry-ring') as THREE.Mesh;
    const clonePosition = clone.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cloneMaterialDispose = vi.spyOn(clone.material as THREE.Material, 'dispose');

    expect(clone.geometry).toBe(authored.geometry);
    expect(clonePosition).toBe(position);
    clone.geometry.setDrawRange(3, 6);
    clonePosition.setX(0, 123);
    expect(authored.geometry.drawRange).toEqual({ count: 6, start: 3 });
    expect(position.getX(0)).toBe(123);

    instance.release();
    expect(cloneMaterialDispose).toHaveBeenCalledTimes(1);
    expect(sourceMaterialDispose).not.toHaveBeenCalled();
    expect(geometryDispose).not.toHaveBeenCalled();
    cloneMaterialDispose.mockRestore();
    sourceMaterialDispose.mockRestore();
    geometryDispose.mockRestore();
    sourceMaterial.dispose();
    authored.geometry.dispose();
  });

  it('composes persistent mesh user visibility through play, expiry, stop, loop, and reuse', async () => {
    const child = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 0 }),
    });
    const authored = ring({ material: fxMaterial() });
    authored.name = 'user-visible-ring';
    const effect = defineEffect({
      elements: { child, ring: meshFxElement(authored, { duration: 0.03 }) },
      timeline: timeline(
        [
          at(0, play('ring')),
          at(0.06, play('ring')),
          at(0.08, stop('ring')),
          at(0.1, play('ring')),
        ],
        { duration: 0.12, loop: 2 },
      ),
    });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);
    const clone = scene.getObjectByName('user-visible-ring') as THREE.Mesh;
    const unsafeSet = instance.setUserVisible.bind(instance) as (
      key: string,
      visible: unknown,
    ) => void;

    expectTypeOf<TimelineMeshFxElementKey<typeof effect>>().toEqualTypeOf<'ring'>();
    expect(() => unsafeSet('missing', true)).toThrow('is not an adapted mesh-fx element');
    expect(() => unsafeSet('child', true)).toThrow('is not an adapted mesh-fx element');
    expect(() => unsafeSet('ring', 1)).toThrow('must be a boolean');

    instance.setUserVisible('ring', false);
    instance.setTransform([1, 2, 3], [0.1, 0.2, 0.3]);
    expect(instance.getElementState('ring')?.visible).toBe(false);
    await system.update(0);
    expect(instance.getElementState('ring')).toMatchObject({ playing: true, visible: false });
    expect(clone.visible).toBe(false);
    instance.setUserVisible('ring', true);
    expect(instance.getElementState('ring')?.visible).toBe(true);

    await system.update(0.03);
    expect(instance.getElementState('ring')).toMatchObject({ playing: false, visible: false });
    instance.setUserVisible('ring', false);
    await system.update(0.03);
    expect(instance.getElementState('ring')).toMatchObject({ playing: true, visible: false });
    instance.setUserVisible('ring', true);
    expect(instance.getElementState('ring')?.visible).toBe(true);

    instance.setUserVisible('ring', false);
    await system.update(0.02);
    expect(instance.getElementState('ring')).toMatchObject({ playing: false, visible: false });
    instance.setUserVisible('ring', true);
    expect(instance.getElementState('ring')?.visible).toBe(false);
    await system.update(0.02);
    expect(instance.getElementState('ring')).toMatchObject({ playing: true, visible: true });

    instance.setUserVisible('ring', false);
    await system.update(0.02);
    expect(instance.cycle).toBe(1);
    expect(instance.getElementState('ring')).toMatchObject({ playing: true, visible: false });
    instance.setUserVisible('ring', true);
    expect(instance.getElementState('ring')?.visible).toBe(true);
    instance.stop();
    expect(instance.getElementState('ring')).toMatchObject({ playing: false, visible: false });
    instance.setUserVisible('ring', false);
    expect(instance.getElementState('ring')?.visible).toBe(false);
    instance.release();
    expect(() => instance.setUserVisible('ring', true)).toThrow('has been released');

    const replay = system.spawn(effect);
    await system.update(0);
    expect(replay.getElementState('ring')).toMatchObject({ playing: true, visible: true });
    await system.update(0.24);
    expect(replay.state).toBe('complete');
    expect(replay.getElementState('ring')).toMatchObject({ playing: false, visible: false });
  });

  it('matches the previous effect transform when authored local is identity', () => {
    const authored = ring({
      innerRadius: 0.5,
      material: fxMaterial(),
      outerRadius: 1,
    });
    authored.name = 'identity-local-ring';
    const effect = defineEffect({ elements: { ring: meshFxElement(authored) } });
    const scene = new THREE.Scene();
    new VFXSystem({}, scene).spawn(effect, {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
    });
    const clone = scene.getObjectByName('identity-local-ring');
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));

    expect(clone?.position.toArray()).toEqual([1, 2, 3]);
    expect(clone?.quaternion.x).toBeCloseTo(expected.x, 10);
    expect(clone?.quaternion.y).toBeCloseTo(expected.y, 10);
    expect(clone?.quaternion.z).toBeCloseTo(expected.z, 10);
    expect(clone?.quaternion.w).toBeCloseTo(expected.w, 10);
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

  it('clamps a one-second measured gap before mesh and action clocks', async () => {
    let now = 1_000;
    const scene = new THREE.Scene();
    const effect = defineEffect({
      elements: { arc: mesh(2) },
      timeline: timeline([at(0, play('arc')), at(0.75, marker('crossed'))], { duration: 2 }),
    });
    const system = new VFXSystem({}, scene, { now: () => now });
    const instance = system.spawn(effect);
    const events: string[] = [];
    instance.onAction(({ action }) => {
      if (action.kind === 'marker') events.push(action.name);
    });

    await system.update();
    expect(system.time).toBe(0);
    expect(system.droppedSeconds).toBe(0);
    now += 1_000;
    await system.update();

    expect(system.time).toBe(0.25);
    expect(instance.localTime).toBe(0.25);
    expect(instance.getElementState('arc')?.localTime).toBe(0.25);
    expect(events).toEqual([]);
    expect(system.measuredDeltaDroppedSeconds).toBe(0.75);
    expect(system.fixedStepDroppedSeconds).toBe(0);
    expect(system.droppedSeconds).toBe(0.75);
  });

  it('configures, disables, and explicitly bypasses the timeline-owned measured ceiling', async () => {
    const effect = defineEffect({ elements: { arc: mesh(2) } });
    const cases = [
      { expectedDrop: 0.9, expectedTime: 0.1, maxMeasuredDeltaSeconds: 0.1 },
      { expectedDrop: 0, expectedTime: 1, maxMeasuredDeltaSeconds: Number.POSITIVE_INFINITY },
    ] as const;
    for (const testCase of cases) {
      let now = 1_000;
      const system = new VFXSystem({}, undefined, {
        maxMeasuredDeltaSeconds: testCase.maxMeasuredDeltaSeconds,
        now: () => now,
      });
      system.spawn(effect);
      await system.update();
      now += 1_000;
      await system.update();
      expect(system.time).toBeCloseTo(testCase.expectedTime);
      expect(system.measuredDeltaDroppedSeconds).toBeCloseTo(testCase.expectedDrop);
    }

    let now = 1_000;
    const explicit = new VFXSystem({}, undefined, {
      maxMeasuredDeltaSeconds: 0.1,
      now: () => now,
    });
    const instance = explicit.spawn(effect);
    await explicit.update();
    now += 1_000;
    await explicit.update(1);
    expect(explicit.time).toBe(1);
    expect(instance.localTime).toBe(1);
    expect(explicit.measuredDeltaDroppedSeconds).toBe(0);
  });

  it('reports timeline measured and fixed-step drops separately without double counting', async () => {
    let now = 1_000;
    const system = new VFXSystem({}, undefined, {
      fixedTimeStep: { maxSubSteps: 2, stepSeconds: 0.1 },
      now: () => now,
    });
    system.spawn(defineEffect({ elements: { arc: mesh(3) } }));
    await system.update();
    now += 1_000;
    await system.update();

    expect(system.time).toBeCloseTo(0.2);
    expect(system.measuredDeltaDroppedSeconds).toBeCloseTo(0.75);
    expect(system.fixedStepDroppedSeconds).toBeCloseTo(0.05);
    expect(system.droppedSeconds).toBeCloseTo(0.8);

    await system.update(1);
    expect(system.measuredDeltaDroppedSeconds).toBeCloseTo(0.75);
    expect(system.fixedStepDroppedSeconds).toBeCloseTo(0.85);
    expect(system.droppedSeconds).toBeCloseTo(1.6);
  });

  it('latches core transform history after a timeline-owned fixed-step drop and before retained steps', async () => {
    const events: string[] = [];
    const renderer = fakeRuntimeRenderer();
    const originalDiscard = CoreVFXSystem.prototype.discardTransformBacklog;
    const discardSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'discardTransformBacklog')
      .mockImplementation(function (this: CoreVFXSystem) {
        events.push('discard');
        originalDiscard.call(this);
      });
    try {
      let position: readonly [number, number, number] = [0, 0, 0];
      const system = new VFXSystem(renderer, undefined, {
        fixedTimeStep: { maxSubSteps: 2, stepSeconds: 0.1 },
      });
      const child = defineEmitter({
        capacity: 32,
        integration: 'none',
        render: billboard({ blending: 'additive' }),
        spawn: perDistance({ rate: 2 }),
      });
      const instance = system.spawn(
        defineEffect({
          elements: { child },
          timeline: timeline([at(0, play('child'))], { duration: 3 }),
        }),
      );
      instance.attachTo({
        getWorldTransform: () => {
          events.push('sync');
          return { position };
        },
      });
      await system.update(0);

      position = [10, 0, 0];
      await system.update(0.05);
      expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(0);
      events.length = 0;
      await system.update(0.95);

      expect(system.fixedStepDroppedSeconds).toBeCloseTo(0.8);
      expect(system.time).toBeCloseTo(0.2);
      expect(discardSpy).toHaveBeenCalledTimes(1);
      expect(events.slice(0, 2)).toEqual(['sync', 'discard']);
      const uniforms = instance.getEmitter('child')!.kernels.uniforms;
      expect(uniforms['Emitter.previousTransform']?.value).toEqual(
        uniforms['Emitter.transform']?.value,
      );
      expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(0);

      position = [11, 0, 0];
      await system.update(0.1);
      expect(uniforms['Emitter.spawnCount']?.value).toBe(2);
      expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(1);
    } finally {
      discardSpy.mockRestore();
    }
  });

  it('latches every timeline-owned drop after the cumulative counter reaches 2**53', async () => {
    const renderer = fakeRuntimeRenderer();
    const discardSpy = vi.spyOn(CoreVFXSystem.prototype, 'discardTransformBacklog');
    try {
      let position: readonly [number, number, number] = [0, 0, 0];
      const system = new VFXSystem(renderer, undefined, {
        fixedTimeStep: { maxSubSteps: 2, stepSeconds: 0.1 },
      });
      const child = defineEmitter({
        capacity: 32,
        integration: 'none',
        render: billboard({ blending: 'additive' }),
        spawn: perDistance({ rate: 2 }),
      });
      const instance = system.spawn(
        defineEffect({
          elements: { child },
          timeline: timeline([at(0, play('child'))], { duration: 3 }),
        }),
      );
      instance.attachTo({ getWorldTransform: () => ({ position }) });
      await system.update(0);

      await system.update(2 ** 53);
      expect(system.fixedStepDroppedSeconds).toBe(2 ** 53);
      expect(discardSpy).toHaveBeenCalledTimes(1);

      position = [10, 0, 0];
      await system.update(0.05);
      await system.update(1);
      expect(system.fixedStepDroppedSeconds).toBe(2 ** 53);
      expect(discardSpy).toHaveBeenCalledTimes(2);
      expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(0);

      position = [11, 0, 0];
      await system.update(0.1);
      expect(instance.getEmitter('child')?.kernels.uniforms['Emitter.spawnCount']?.value).toBe(2);
    } finally {
      discardSpy.mockRestore();
    }
  });

  it('latches an overflow-safe huge timeline drop after retaining a partial frame', async () => {
    const stepSeconds = Number.MAX_VALUE / 2;
    const partial = Number.MAX_VALUE / 4;
    const renderer = fakeRuntimeRenderer();
    const discardSpy = vi.spyOn(CoreVFXSystem.prototype, 'discardTransformBacklog');
    try {
      let position: readonly [number, number, number] = [0, 0, 0];
      const system = new VFXSystem(renderer, undefined, {
        fixedTimeStep: { maxSubSteps: 2, stepSeconds },
      });
      const child = defineEmitter({
        capacity: 32,
        integration: 'none',
        render: billboard({ blending: 'additive' }),
        spawn: perDistance({ rate: 2 }),
      });
      const instance = system.spawn(
        defineEffect({
          elements: { child },
          timeline: timeline([at(0, play('child'))], { duration: Number.MAX_VALUE }),
        }),
      );
      instance.attachTo({ getWorldTransform: () => ({ position }) });
      await system.update(0);

      position = [10, 0, 0];
      await system.update(partial);
      expect(system.time).toBe(0);
      await system.update(Number.MAX_VALUE);

      const expectedDrop = Number.MAX_VALUE - (Number.MAX_VALUE - partial);
      expect(system.fixedStepDroppedSeconds).toBe(expectedDrop);
      expect(Number.isFinite(system.fixedStepDroppedSeconds)).toBe(true);
      expect(system.time).toBe(Number.MAX_VALUE);
      expect(discardSpy).toHaveBeenCalledTimes(1);
      expect(renderer.submissions.filter((name) => name === 'NachiEmitterSpawn')).toHaveLength(0);
    } finally {
      discardSpy.mockRestore();
    }
  });

  it('measures concurrent omitted calls at invocation time and leaves explicit calls clock-neutral', async () => {
    const timestamps = [1_000, 2_000, 3_000, 4_000];
    const system = new VFXSystem({}, undefined, { now: () => timestamps.shift()! });
    system.spawn(defineEffect({ elements: { arc: mesh(4) } }));

    const first = system.update();
    const second = system.update();
    const explicit = system.update(0.5);
    const third = system.update();
    expect(system.measuredDeltaDroppedSeconds).toBe(1.5);
    await Promise.all([first, second, explicit, third]);
    expect(system.time).toBe(1);

    await system.update(0.5);
    await system.update();
    expect(system.time).toBe(1.75);
    expect(system.measuredDeltaDroppedSeconds).toBe(2.25);
  });

  it('uses zero for equal or reversed timeline timestamps', async () => {
    let now = 1_000;
    const system = new VFXSystem({}, undefined, { now: () => now });
    system.spawn(defineEffect({ elements: { arc: mesh(2) } }));
    await system.update();
    await system.update();
    now = 900;
    await system.update();
    expect(system.time).toBe(0);
  });

  it('stores a NaN timeline clock and recovers after one rejected finite bridge sample', async () => {
    let now = 1_000;
    const system = new VFXSystem({}, undefined, { now: () => now });
    system.spawn(defineEffect({ elements: { arc: mesh(2) } }));

    await system.update();
    now = Number.NaN;
    await expect(system.update()).rejects.toThrow(RangeError);
    now = 2_000;
    await expect(system.update()).rejects.toThrow(RangeError);
    now = 2_100;
    await system.update();

    expect(system.time).toBeCloseTo(0.1);
    expect(system.droppedSeconds).toBe(0);
  });

  it.each([
    ['positive Infinity', Number.POSITIVE_INFINITY, true],
    ['negative Infinity', Number.NEGATIVE_INFINITY, false],
  ] as const)('stores %s after a valid timeline clock sample and follows its signed recovery boundary', async (_label, nonFinite, immediateRecovery) => {
    let now = 1_000;
    const system = new VFXSystem({}, undefined, { now: () => now });
    system.spawn(defineEffect({ elements: { arc: mesh(2) } }));
    await system.update();

    now = nonFinite;
    await expect(system.update()).rejects.toThrow(RangeError);
    now = 2_000;
    if (immediateRecovery) await expect(system.update()).resolves.toBeUndefined();
    else await expect(system.update()).rejects.toThrow(RangeError);
    expect(system.time).toBe(0);
    now = 2_100;
    await system.update();

    expect(system.time).toBeCloseTo(0.1);
    expect(system.droppedSeconds).toBe(0);
  });

  it.each([
    ['NaN', Number.NaN, false],
    ['positive Infinity', Number.POSITIVE_INFINITY, true],
    ['negative Infinity', Number.NEGATIVE_INFINITY, false],
  ] as const)('rejects an initial %s timeline clock and preserves its signed recovery boundary', async (_label, nonFinite, immediateRecovery) => {
    let now = nonFinite;
    const system = new VFXSystem({}, undefined, { now: () => now });
    system.spawn(defineEffect({ elements: { arc: mesh(2) } }));

    await expect(system.update()).rejects.toThrow(RangeError);
    now = 2_000;
    if (immediateRecovery) await expect(system.update()).resolves.toBeUndefined();
    else await expect(system.update()).rejects.toThrow(RangeError);
    expect(system.time).toBe(0);
    now = 2_100;
    await system.update();

    expect(system.time).toBeCloseTo(0.1);
    expect(system.droppedSeconds).toBe(0);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid timeline maxMeasuredDeltaSeconds %s synchronously', (maxMeasuredDeltaSeconds) => {
    expect(() => new VFXSystem({}, undefined, { maxMeasuredDeltaSeconds })).toThrow(RangeError);
  });

  it.each([null, '0.25'])('rejects timeline runtime type violation %s synchronously', (invalid) => {
    expect(
      () =>
        new VFXSystem({}, undefined, {
          maxMeasuredDeltaSeconds: invalid as unknown as number,
        }),
    ).toThrow(RangeError);
  });

  it('retains the final localTime for both emitter and mesh elements after completion', async () => {
    const child = defineEmitter({
      capacity: 1,
      init: [lifetime(0.05)],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { arc: mesh(0.05), child },
      timeline: timeline([at(0, play('arc'), play('child'))], { duration: 0.05 }),
    });
    const fake = fakeChildInstance('active', [], { aliveCount: 7 } as NonNullable<
      ReturnType<VfxEffectInstance['getEmitter']>
    >);
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    const updateSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'update')
      .mockImplementation((deltaSeconds) => {
        fake.advance(deltaSeconds ?? 0);
        if (fake.child.localTime >= 0.05) fake.setState('complete');
        return Promise.resolve();
      });
    try {
      const system = new VFXSystem({}, new THREE.Scene());
      const instance = system.spawn(effect);

      await system.update(0.05);

      expect(instance.getElementState('arc')).toMatchObject({
        localTime: 0.05,
        playing: false,
        visible: false,
      });
      expect(instance.getElementState('child')).toMatchObject({
        aliveCount: undefined,
        localTime: 0.05,
        playing: false,
        visible: false,
      });
    } finally {
      updateSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it('stops and releases a duration-omitted continuous emitter at the final track boundary', async () => {
    const child = defineEmitter({
      capacity: 8,
      init: [lifetime(0.2)],
      render: billboard({}),
      spawn: rate(20),
    });
    const effect = defineEffect({
      elements: { child },
      timeline: timeline([at(0, play('child'))], { duration: 0.05 }),
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    const updateSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'update')
      .mockImplementation((deltaSeconds) => {
        fake.advance(deltaSeconds ?? 0);
        return Promise.resolve();
      });
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect);

      await system.update(0.05);

      expect(fake.child.state).toBe('released');
      expect(instance.state).toBe('complete');
      expect(instance.getElementState('child')).toMatchObject({
        localTime: 0.05,
        playing: false,
        visible: false,
      });
    } finally {
      updateSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it('truncates a duration-omitted continuous emitter at a positive sub-epsilon boundary', async () => {
    const child = defineEmitter({
      capacity: 8,
      init: [lifetime(0.2)],
      render: billboard({}),
      spawn: rate(20),
    });
    const effect = defineEffect({
      elements: { child },
      timeline: timeline([at(0, play('child'))], { duration: 5e-11 }),
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    const updateSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'update')
      .mockImplementation((deltaSeconds) => {
        fake.advance(deltaSeconds ?? 0);
        return Promise.resolve();
      });
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect);

      await system.update(5e-11);

      expect(fake.child.state).toBe('released');
      expect(instance.state).toBe('complete');
      expect(instance.getElementState('child')).toMatchObject({
        localTime: 0,
        playing: false,
        visible: false,
      });
    } finally {
      updateSpy.mockRestore();
      spawnSpy.mockRestore();
    }
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

  it('keeps a bound companion on the same hit-stop and resume frame boundaries', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline<never>([at(0.05, hitStop(70))], { duration: 0.2 }),
    });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);
    const companion = fakeChildInstance();
    instance.bindCompanion(companion.child);

    const advanceTogether = async (delta: number) => {
      companion.advance(delta);
      await system.update(delta);
      expect(companion.child.localTime).toBeCloseTo(instance.localTime, 12);
    };

    await advanceTogether(0.05);
    expect(companion.applyHitStop).toHaveBeenCalledWith(70, 0);
    await advanceTogether(0.04);
    expect(instance.localTime).toBeCloseTo(0.05, 12);
    await advanceTogether(0.03);
    expect(instance.localTime).toBeCloseTo(0.05, 12);
    await advanceTogether(0.01);
    expect(instance.localTime).toBeCloseTo(0.06, 12);

    instance.setTimeScale(0.5);
    expect(companion.child.timeScale).toBe(0.5);
    expect(companion.setTimeScale).toHaveBeenLastCalledWith(0.5);
  });

  it('synchronizes residual hit stop when a companion binds late', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline<never>([at(0, hitStop(70, 0.25))], { duration: 0.2 }),
    });
    const system = new VFXSystem({});
    const instance = system.spawn(effect);
    await system.update(0.02);
    const companion = fakeChildInstance();

    instance.bindCompanion(companion.child);

    expect(companion.setTimeScale).toHaveBeenCalledWith(1);
    expect(companion.applyHitStop).toHaveBeenCalledTimes(1);
    expect(companion.applyHitStop.mock.calls[0]?.[0]).toBeCloseTo(50, 10);
    expect(companion.applyHitStop.mock.calls[0]?.[1]).toBe(0.25);
  });

  it('automatically drops released companions and supports explicit unbinding', () => {
    const system = new VFXSystem({});
    const instance = system.spawn(defineEffect({ elements: {} }));
    const released = fakeChildInstance();
    instance.bindCompanion(released.child);
    const releasedScaleCalls = released.setTimeScale.mock.calls.length;
    released.child.release();

    expect(() => instance.applyHitStop(20)).not.toThrow();
    instance.setTimeScale(2);
    expect(released.applyHitStop).not.toHaveBeenCalled();
    expect(released.setTimeScale).toHaveBeenCalledTimes(releasedScaleCalls);

    const unavailable = fakeChildInstance();
    unavailable.child.release();
    instance.bindCompanion(unavailable.child);
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_COMPANION_UNAVAILABLE',
        severity: 'warning',
      }),
    );

    const unbound = fakeChildInstance();
    instance.bindCompanion(unbound.child);
    const unboundHitStopCalls = unbound.applyHitStop.mock.calls.length;
    const unboundScaleCalls = unbound.setTimeScale.mock.calls.length;
    instance.unbindCompanion(unbound.child);
    instance.applyHitStop(30, 0.5);
    instance.setTimeScale(3);
    expect(unbound.applyHitStop).toHaveBeenCalledTimes(unboundHitStopCalls);
    expect(unbound.setTimeScale).toHaveBeenCalledTimes(unboundScaleCalls);
  });

  it('uses last-writer-wins time scale while a companion remains bound', () => {
    const system = new VFXSystem({});
    const instance = system.spawn(defineEffect({ elements: {} }));
    const companion = fakeChildInstance();
    instance.bindCompanion(companion.child);

    companion.child.setTimeScale(0.25);
    expect(companion.child.timeScale).toBe(0.25);
    instance.setTimeScale(2);
    expect(companion.child.timeScale).toBe(2);
    companion.child.setTimeScale(3);
    expect(companion.child.timeScale).toBe(3);

    instance.unbindCompanion(companion.child);
    instance.setTimeScale(4);
    expect(companion.child.timeScale).toBe(3);
  });

  it('gates every companion transfer path for error-state instances', () => {
    const system = new VFXSystem({});
    const instance = system.spawn(defineEffect({ elements: {} }));
    const alreadyErrored = fakeChildInstance('error');
    instance.bindCompanion(alreadyErrored.child);
    instance.applyHitStop(10);
    instance.setTimeScale(2);
    expect(alreadyErrored.applyHitStop).not.toHaveBeenCalled();
    expect(alreadyErrored.setTimeScale).not.toHaveBeenCalled();
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_COMPANION_UNAVAILABLE',
        message: expect.stringContaining('error'),
        severity: 'warning',
      }),
    );

    const errorsDuringInitialSync = fakeChildInstance();
    errorsDuringInitialSync.setTimeScale.mockImplementationOnce(() =>
      errorsDuringInitialSync.setState('error'),
    );
    instance.bindCompanion(errorsDuringInitialSync.child);
    expect(errorsDuringInitialSync.setTimeScale).toHaveBeenCalledTimes(1);
    expect(errorsDuringInitialSync.applyHitStop).not.toHaveBeenCalled();

    const becomesErrored = fakeChildInstance();
    instance.bindCompanion(becomesErrored.child);
    const hitStopCallsBeforeError = becomesErrored.applyHitStop.mock.calls.length;
    const scaleCallsBeforeError = becomesErrored.setTimeScale.mock.calls.length;
    becomesErrored.setState('error');
    instance.applyHitStop(10);
    instance.setTimeScale(3);
    expect(becomesErrored.applyHitStop).toHaveBeenCalledTimes(hitStopCallsBeforeError);
    expect(becomesErrored.setTimeScale).toHaveBeenCalledTimes(scaleCallsBeforeError);
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

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    '1',
  ])('rejects invalid timeline spawn timeScale %s synchronously', (timeScale) => {
    const system = new VFXSystem({});
    expect(() =>
      system.spawn(defineEffect({ elements: {} }), { timeScale: timeScale as never }),
    ).toThrowError('timeScale must be a non-negative finite number.');
  });

  it('snapshots accessor-backed spawn timeScale once before ID allocation', () => {
    const system = new VFXSystem({});
    let reads = 0;
    const instance = system.spawn(defineEffect({ elements: {} }), {
      get timeScale() {
        reads += 1;
        return reads === 1 ? 1 : Number.NaN;
      },
    });

    expect(instance.id).toBe('nachi-timeline-1');
    expect(instance.timeScale).toBe(1);
    expect(reads).toBe(1);
  });

  it('rejects the first invalid spawn timeScale read without consuming an ID', () => {
    const definition = defineEffect({ elements: {} });
    const system = new VFXSystem({});
    let reads = 0;
    expect(() =>
      system.spawn(definition, {
        get timeScale() {
          reads += 1;
          return reads === 1 ? Number.NaN : 1;
        },
      }),
    ).toThrowError('timeScale must be a non-negative finite number.');
    expect(reads).toBe(1);
    expect(system.instanceCount).toBe(0);
    expect(system.spawn(definition).id).toBe('nachi-timeline-1');

    expect(
      () =>
        new TimelineEffectInstance(
          definition,
          'direct',
          undefined,
          { timeScale: Number.NaN },
          undefined,
          () => {
            throw new Error('empty effect cannot spawn a child');
          },
          () => undefined,
        ),
    ).toThrowError('timeScale must be a non-negative finite number.');
  });

  it('rejects malformed spawn transforms before ID allocation or mesh construction', () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-spawn-transform';
    const effect = defineEffect({ elements: { ring: meshFxElement(authored) } });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);

    for (const options of [
      { position: [0, Number.NaN, 0] },
      { position: 'origin' },
      { rotation: [0, Number.POSITIVE_INFINITY, 0] },
    ]) {
      expect(() => system.spawn(effect, options as never)).toThrow();
      expect(system.instanceCount).toBe(0);
      expect(scene.getObjectByName('h2-13-spawn-transform')).toBeUndefined();
    }

    const instance = system.spawn(effect);
    expect(instance.id).toBe('nachi-timeline-1');
    expect(scene.getObjectByName('h2-13-spawn-transform')).toBeInstanceOf(THREE.Mesh);
    instance.release();
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('snapshots accessor-backed spawn transforms once before ID and mesh construction', () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-spawn-transform-snapshot';
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const componentReads = [0, 0, 0];
    const position = new Proxy([4, 5, 6], {
      get(target, property, receiver) {
        if (property === '0' || property === '1' || property === '2') {
          const index = Number(property);
          componentReads[index] = componentReads[index]! + 1;
          return componentReads[index] === 1 ? target[index] : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let positionReads = 0;

    const instance = system.spawn(defineEffect({ elements: { ring: meshFxElement(authored) } }), {
      get position() {
        positionReads += 1;
        return position as never;
      },
    });

    expect(instance.id).toBe('nachi-timeline-1');
    expect(positionReads).toBe(1);
    expect(componentReads).toEqual([1, 1, 1]);
    expect(scene.getObjectByName('h2-13-spawn-transform-snapshot')?.position.toArray()).toEqual([
      4, 5, 6,
    ]);
    instance.release();
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('rejects malformed live and attachment transforms without changing pose or source', async () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-live-transform';
    const child = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { child, ring: meshFxElement(authored) },
      timeline: [at(0, play('child'))],
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const scene = new THREE.Scene();
      const system = new VFXSystem({}, scene);
      const instance = system.spawn(effect, { position: [1, 2, 3] });
      const clone = scene.getObjectByName('h2-13-live-transform') as THREE.Mesh;
      expect(clone.position.toArray()).toEqual([1, 2, 3]);

      for (const [position, rotation] of [
        [undefined, undefined],
        ['origin', undefined],
        [[0, Number.NaN, 0], undefined],
        [
          [1, 2, 3],
          [0, Number.POSITIVE_INFINITY, 0],
        ],
      ] as const) {
        expect(() => instance.setTransform(position as never, rotation as never)).toThrow();
        expect(clone.position.toArray()).toEqual([1, 2, 3]);
      }

      let attachedPosition: readonly [number, number, number] = [4, 5, 6];
      let attachedRotation: readonly [number, number, number] = [0, 0, 0.25];
      instance.attachTo({
        getWorldTransform: () => ({ position: attachedPosition, rotation: attachedRotation }),
      });
      expect(clone.position.toArray()).toEqual([4, 5, 6]);
      expect(() =>
        instance.attachTo({ getWorldTransform: () => ({ rotation: [0, 0, 0] }) as never }),
      ).toThrow();
      expect(() => instance.attachTo({ getWorldTransform: () => undefined as never })).toThrow();
      expect(clone.position.toArray()).toEqual([4, 5, 6]);

      attachedPosition = [7, 8, 9];
      attachedRotation = [0, 0, 0.5];
      await system.update(0);
      expect(clone.position.toArray()).toEqual([7, 8, 9]);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({
        position: [7, 8, 9],
        rotation: [0, 0, 0.5],
      });
      const childTransformCalls = fake.setTransform.mock.calls.length;
      expect(() => instance.setTransform([0, Number.NaN, 0])).toThrow();
      expect(fake.setTransform).toHaveBeenCalledTimes(childTransformCalls);
      expect(clone.position.toArray()).toEqual([7, 8, 9]);

      instance.release();
      authored.material.dispose();
      authored.geometry.dispose();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('synchronizes attachment before an initial update(0) time-zero play', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({ elements: { child: emitter }, timeline: [at(0, play('child'))] });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect, { position: [1, 2, 3] });
      let position: readonly [number, number, number] = [4, 5, 6];
      instance.attachTo({ getWorldTransform: () => ({ position }) });
      position = [7, 8, 9];

      await system.update(0);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ position: [7, 8, 9] });
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('snapshots accessor-backed live transform components exactly once', () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-transform-snapshot';
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(defineEffect({ elements: { ring: meshFxElement(authored) } }), {
      position: [1, 2, 3],
    });
    const tupleReads = { components: [0, 0, 0], length: 0 };
    const position = new Proxy([4, 5, 6], {
      get(target, property, receiver) {
        if (property === 'length') {
          tupleReads.length += 1;
          return Reflect.get(target, property, receiver);
        }
        if (property === '0' || property === '1' || property === '2') {
          const index = Number(property);
          tupleReads.components[index] = tupleReads.components[index]! + 1;
          return tupleReads.components[index] === 1 ? target[index] : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => instance.setTransform(position as never)).not.toThrow();
    expect(scene.getObjectByName('h2-13-transform-snapshot')?.position.toArray()).toEqual([
      4, 5, 6,
    ]);
    expect(tupleReads).toEqual({ components: [1, 1, 1], length: 1 });

    const objectReads = [0, 0, 0];
    const objectPosition = {
      get x() {
        objectReads[0] = objectReads[0]! + 1;
        return objectReads[0] === 1 ? 7 : Number.NaN;
      },
      get y() {
        objectReads[1] = objectReads[1]! + 1;
        return objectReads[1] === 1 ? 8 : Number.NaN;
      },
      get z() {
        objectReads[2] = objectReads[2]! + 1;
        return objectReads[2] === 1 ? 9 : Number.NaN;
      },
    };
    expect(() => instance.setTransform(objectPosition)).not.toThrow();
    expect(scene.getObjectByName('h2-13-transform-snapshot')?.position.toArray()).toEqual([
      7, 8, 9,
    ]);
    expect(objectReads).toEqual([1, 1, 1]);

    const rotationReads = { components: [0, 0, 0, 0], length: 0 };
    const rotation = new Proxy([0, 0, 0, 1], {
      get(target, property, receiver) {
        if (property === 'length') {
          rotationReads.length += 1;
          return Reflect.get(target, property, receiver);
        }
        if (property === '0' || property === '1' || property === '2' || property === '3') {
          const index = Number(property);
          rotationReads.components[index] = rotationReads.components[index]! + 1;
          return rotationReads.components[index] === 1 ? target[index] : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => instance.setTransform([10, 11, 12], rotation as never)).not.toThrow();
    expect(scene.getObjectByName('h2-13-transform-snapshot')?.quaternion.toArray()).toEqual([
      0, 0, 0, 1,
    ]);
    expect(rotationReads).toEqual({ components: [1, 1, 1, 1], length: 1 });

    instance.release();
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('keeps a property-getter attachment replacement authoritative for time-zero play', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-property-reentrant-attachment';
    const effect = defineEffect({
      elements: { child: emitter, ring: meshFxElement(authored) },
      timeline: [at(0, play('child'), play('ring'))],
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const scene = new THREE.Scene();
      const system = new VFXSystem({}, scene);
      const instance = system.spawn(effect);
      const replacement = {
        getWorldTransform: () => ({ position: [7, 8, 9] as const }),
      };
      let positionReads = 0;
      let rotationReads = 0;
      const staleTransform = {
        get position() {
          positionReads += 1;
          instance.attachTo(replacement);
          return [40, 50, 60] as const;
        },
        get rotation() {
          rotationReads += 1;
          return undefined;
        },
      };

      instance.attachTo({ getWorldTransform: () => staleTransform as never });
      expect(
        scene.getObjectByName('h2-13-property-reentrant-attachment')?.position.toArray(),
      ).toEqual([7, 8, 9]);
      expect({ positionReads, rotationReads }).toEqual({ positionReads: 1, rotationReads: 1 });
      await system.update(0);

      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ position: [7, 8, 9] });
      expect(
        scene.getObjectByName('h2-13-property-reentrant-attachment')?.position.toArray(),
      ).toEqual([7, 8, 9]);

      instance.attachTo({
        getWorldTransform: () =>
          ({
            get position() {
              instance.detach();
              return [40, 50, 60] as const;
            },
          }) as never,
      });
      expect(
        scene.getObjectByName('h2-13-property-reentrant-attachment')?.position.toArray(),
      ).toEqual([7, 8, 9]);
      instance.release();
    } finally {
      spawnSpy.mockRestore();
      authored.material.dispose();
      authored.geometry.dispose();
    }
  });

  it('keeps an update-time component replacement authoritative for time-zero child and mesh', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-component-reentrant-attachment';
    const effect = defineEffect({
      elements: { child: emitter, ring: meshFxElement(authored) },
      timeline: [at(0, play('child'), play('ring'))],
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const scene = new THREE.Scene();
      const system = new VFXSystem({}, scene);
      const instance = system.spawn(effect);
      const replacement = {
        getWorldTransform: () => ({ position: [7, 8, 9] as const }),
      };
      let replaceDuringSnapshot = false;
      const componentReads = [0, 0, 0];
      const source = {
        getWorldTransform: () => {
          if (!replaceDuringSnapshot) return { position: [1, 2, 3] as const };
          const position = new Proxy([40, 50, 60], {
            get(target, property, receiver) {
              if (property === '0' || property === '1' || property === '2') {
                const index = Number(property);
                componentReads[index] = componentReads[index]! + 1;
                if (index === 0) instance.attachTo(replacement);
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return { position };
        },
      };
      instance.attachTo(source as never);
      replaceDuringSnapshot = true;

      await system.update(0);

      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ position: [7, 8, 9] });
      expect(
        scene.getObjectByName('h2-13-component-reentrant-attachment')?.position.toArray(),
      ).toEqual([7, 8, 9]);
      expect(componentReads).toEqual([1, 1, 1]);
      instance.release();
    } finally {
      spawnSpy.mockRestore();
      authored.material.dispose();
      authored.geometry.dispose();
    }
  });

  it('keeps direct nested attachment operations authoritative through time-zero play', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-direct-reentrant-attachment';
    const effect = defineEffect({
      elements: { child: emitter, ring: meshFxElement(authored) },
      timeline: [at(0, play('child'), play('ring'))],
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const scene = new THREE.Scene();
      const system = new VFXSystem({}, scene);
      const instance = system.spawn(effect);
      const mesh = scene.getObjectByName('h2-13-direct-reentrant-attachment');
      const replacement = {
        getWorldTransform: () => ({ position: [7, 8, 9] as const }),
      };

      instance.attachTo({
        getWorldTransform: () => {
          instance.attachTo(replacement);
          return { position: [40, 50, 60] as const };
        },
      });
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);

      await system.update(0);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ position: [7, 8, 9] });
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);

      instance.attachTo({
        getWorldTransform: () => {
          try {
            instance.attachTo({
              getWorldTransform: () => ({ position: [Number.NaN, 0, 0] }),
            });
          } catch (error) {
            expect(error).toBeInstanceOf(RangeError);
          }
          return { position: [70, 80, 90] as const };
        },
      });
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);
      await system.update(0.01);
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);

      instance.attachTo({
        getWorldTransform: () => {
          instance.detach();
          return { position: [100, 110, 120] as const };
        },
      });
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);
      await system.update(0.01);
      expect(mesh?.position.toArray()).toEqual([7, 8, 9]);

      expect(() =>
        instance.attachTo({
          getWorldTransform: () => {
            instance.release();
            return { position: [130, 140, 150] as const };
          },
        }),
      ).not.toThrow();
      expect(instance.state).toBe('released');
    } finally {
      spawnSpy.mockRestore();
      authored.material.dispose();
      authored.geometry.dispose();
    }
  });

  it('invalidates outer samples for same-source direct and update-time reentry', async () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-same-source-reentry';
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(defineEffect({ elements: { ring: meshFxElement(authored) } }));
    const mesh = scene.getObjectByName('h2-13-same-source-reentry');
    let phase: 'direct-outer' | 'direct-nested' | 'sync-outer' | 'sync-nested' | 'steady' =
      'direct-outer';
    const source = {
      getWorldTransform: () => {
        if (phase === 'direct-outer') {
          phase = 'direct-nested';
          instance.attachTo(source);
          phase = 'steady';
          return { position: [40, 50, 60] as const };
        }
        if (phase === 'sync-outer') {
          phase = 'sync-nested';
          instance.attachTo(source);
          phase = 'steady';
          return { position: [70, 80, 90] as const };
        }
        return { position: [7, 8, 9] as const };
      },
    };

    instance.attachTo(source);
    expect(mesh?.position.toArray()).toEqual([7, 8, 9]);
    phase = 'sync-outer';
    await system.update(0.01);
    expect(mesh?.position.toArray()).toEqual([7, 8, 9]);

    instance.release();
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('keeps a reentrant attachment replacement authoritative for initial time-zero play', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-reentrant-attachment';
    const effect = defineEffect({
      elements: { child: emitter, ring: meshFxElement(authored) },
      timeline: [at(0, play('child'), play('ring'))],
    });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const scene = new THREE.Scene();
      const system = new VFXSystem({}, scene);
      const instance = system.spawn(effect);
      const replacement = {
        getWorldTransform: () => ({ position: [7, 8, 9] as const }),
      };
      let replaceDuringRead = false;
      const original = {
        getWorldTransform: () => {
          if (replaceDuringRead) {
            instance.attachTo(replacement);
            return { position: [40, 50, 60] as const };
          }
          return { position: [1, 2, 3] as const };
        },
      };
      instance.attachTo(original);
      replaceDuringRead = true;

      await system.update(0);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ position: [7, 8, 9] });
      expect(scene.getObjectByName('h2-13-reentrant-attachment')?.position.toArray()).toEqual([
        7, 8, 9,
      ]);
      instance.release();
    } finally {
      spawnSpy.mockRestore();
      authored.material.dispose();
      authored.geometry.dispose();
    }
  });

  it('discards an attachment sample when its source detaches itself', async () => {
    const authored = ring({ material: fxMaterial() });
    authored.name = 'h2-13-reentrant-detach';
    const effect = defineEffect({
      elements: { ring: meshFxElement(authored) },
      timeline: [at(0, play('ring'))],
    });
    const scene = new THREE.Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);
    let detachDuringRead = false;
    let reads = 0;
    const source = {
      getWorldTransform: () => {
        reads += 1;
        if (detachDuringRead) {
          instance.detach();
          return { position: [40, 50, 60] as const };
        }
        return { position: [1, 2, 3] as const };
      },
    };
    instance.attachTo(source);
    detachDuringRead = true;

    await system.update(0);
    await system.update(0);

    expect(scene.getObjectByName('h2-13-reentrant-detach')?.position.toArray()).toEqual([1, 2, 3]);
    expect(reads).toBe(2);
    instance.release();
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('quietly discards an attachment sample after a reentrant release', async () => {
    const authored = ring({ material: fxMaterial() });
    const effect = defineEffect({
      elements: { ring: meshFxElement(authored) },
      timeline: [at(0, play('ring'))],
    });
    const system = new VFXSystem({}, new THREE.Scene());
    const instance = system.spawn(effect);
    let releaseDuringRead = false;
    let stalePropertyReads = 0;
    instance.attachTo({
      getWorldTransform: () => {
        if (releaseDuringRead) {
          instance.release();
          return {
            get position(): never {
              stalePropertyReads += 1;
              throw new Error('released sample must not be read');
            },
          } as never;
        }
        return { position: [40, 50, 60] };
      },
    });
    releaseDuringRead = true;

    await expect(system.update(0)).resolves.toBeUndefined();

    expect(instance.state).toBe('released');
    expect(stalePropertyReads).toBe(0);
    authored.material.dispose();
    authored.geometry.dispose();
  });

  it('passes the effect frame through timeline play while preserving emitter offset data', async () => {
    const emitter = defineEmitter({
      capacity: 1,
      offset: [1, 2, 3],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({ elements: { child: emitter }, timeline: [at(0, play('child'))] });
    const fake = fakeChildInstance();
    const spawnSpy = vi
      .spyOn(CoreVFXSystem.prototype, 'spawn')
      .mockReturnValue(fake.child as never);
    try {
      const system = new VFXSystem({});
      const instance = system.spawn(effect, {
        position: [4, 5, 6],
        rotation: [0, 0, Math.PI / 2],
      });
      await system.update(0);

      const [childDefinition, options] = spawnSpy.mock.calls[0]!;
      expect(childDefinition.elements.child).toMatchObject({ offset: [1, 2, 3] });
      expect(options).toMatchObject({
        position: [4, 5, 6],
        rotation: [0, 0, Math.PI / 2],
      });
      instance.release();
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
      const spawnedDefinition = spawnSpy.mock.calls[0]?.[0];
      expect(spawnedDefinition).toBeDefined();
      expect(Object.keys((spawnedDefinition as EffectDefinition).elements)).toEqual(['source']);
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
    expect(positiveDecay).toContain(0.75);
    expect(positiveDecay).toEqual([...positiveDecay].sort((a, b) => b - a));
    expect(first.filter(({ decay }) => decay === 0)).toHaveLength(1);
    expect(first.at(-1)).toMatchObject({ decay: 0, translation: [0, 0, 0] });
  });

  it('prepares each emitter and mesh once without walking a long timeline', async () => {
    const child = defineEmitter({
      capacity: 1,
      init: [lifetime(1)],
      render: billboard({}),
      spawn: burst({ count: 1 }),
    });
    const effect = defineEffect({
      elements: { arc: mesh(1), child },
      timeline: timeline([at(9_000, play('arc'), play('child'))], { duration: 10_000 }),
    });
    const corePrepare = vi.spyOn(CoreVFXSystem.prototype, 'prepare').mockResolvedValue(undefined);
    const prepareObject = vi.fn();
    const progress: Array<{ completed: number; total: number }> = [];
    try {
      const system = new VFXSystem({}, new THREE.Scene());
      await system.prepare(effect, {
        onProgress: ({ completed, total }) => progress.push({ completed, total }),
        preparer: { prepareEmitter: vi.fn(), prepareObject },
      });

      expect(system.time).toBe(0);
      expect(system.instanceCount).toBe(0);
      expect(corePrepare).toHaveBeenCalledTimes(1);
      expect(Object.keys((corePrepare.mock.calls[0]![0] as EffectDefinition).elements)).toEqual([
        'child',
      ]);
      expect(prepareObject).toHaveBeenCalledTimes(1);
      expect(progress).toEqual([
        { completed: 0, total: 2 },
        { completed: 1, total: 2 },
        { completed: 2, total: 2 },
      ]);
    } finally {
      corePrepare.mockRestore();
    }
  });

  it('keeps borrowed geometry and source materials while disposing or transferring prepared clones', async () => {
    const sourceMaterial = fxMaterial();
    const source = ring({ material: sourceMaterial });
    const effect = defineEffect({ elements: { ring: source } });
    const sourceMaterialDisposed = vi.fn();
    const sourceGeometryDisposed = vi.fn();
    sourceMaterial.addEventListener('dispose', sourceMaterialDisposed);
    source.geometry.addEventListener('dispose', sourceGeometryDisposed);
    const delivered: string[] = [];
    const system = new VFXSystem({}, new THREE.Scene(), {
      onRuntimeDiagnostic: ({ code }) => delivered.push(code),
    });

    let ordinaryObject: MeshFxMesh | undefined;
    const ordinaryDisposed = vi.fn();
    await system.prepare(effect, {
      preparer: {
        prepareEmitter: vi.fn(),
        prepareObject: ({ object }) => {
          ordinaryObject = object;
          object.material.addEventListener('dispose', ordinaryDisposed);
          return undefined;
        },
      },
    });
    expect(ordinaryObject?.geometry).toBe(source.geometry);
    expect(ordinaryObject?.material).not.toBe(sourceMaterial);
    expect(ordinaryDisposed).toHaveBeenCalledTimes(1);

    let thrownObject: MeshFxMesh | undefined;
    const thrownDisposed = vi.fn();
    await expect(
      system.prepare(effect, {
        preparer: {
          prepareEmitter: vi.fn(),
          prepareObject: ({ object }) => {
            thrownObject = object;
            object.material.addEventListener('dispose', thrownDisposed);
            throw new Error('prepare object failed');
          },
        },
      }),
    ).rejects.toThrow('prepare object failed');
    expect(thrownObject?.geometry).toBe(source.geometry);
    expect(thrownObject?.material).not.toBe(sourceMaterial);
    expect(thrownDisposed).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(['NACHI_TIMELINE_PREPARE_FAILED']);

    const controller = new AbortController();
    let abortedObject: MeshFxMesh | undefined;
    const abortedDisposed = vi.fn();
    await expect(
      system.prepare(effect, {
        preparer: {
          prepareEmitter: vi.fn(),
          prepareObject: ({ object }) => {
            abortedObject = object;
            object.material.addEventListener('dispose', abortedDisposed);
            controller.abort();
            return undefined;
          },
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedObject?.geometry).toBe(source.geometry);
    expect(abortedObject?.material).not.toBe(sourceMaterial);
    expect(abortedDisposed).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(['NACHI_TIMELINE_PREPARE_FAILED', 'NACHI_TIMELINE_PREPARE_FAILED']);

    let retainedObject: MeshFxMesh | undefined;
    const retainedDisposed = vi.fn();
    await system.prepare(effect, {
      preparer: {
        prepareEmitter: vi.fn(),
        prepareObject: ({ object }) => {
          retainedObject = object;
          object.material.addEventListener('dispose', retainedDisposed);
          return { retained: true };
        },
      },
    });
    expect(retainedObject?.geometry).toBe(source.geometry);
    expect(retainedObject?.material).not.toBe(sourceMaterial);
    expect(retainedDisposed).not.toHaveBeenCalled();
    expect(sourceMaterialDisposed).not.toHaveBeenCalled();
    expect(sourceGeometryDisposed).not.toHaveBeenCalled();

    // retained:true transfers the cloned material to the preparer; geometry remains source-owned.
    retainedObject!.material.dispose();
    expect(retainedDisposed).toHaveBeenCalledTimes(1);
    expect(sourceGeometryDisposed).not.toHaveBeenCalled();
    sourceMaterial.dispose();
    source.geometry.dispose();
    expect(sourceMaterialDisposed).toHaveBeenCalledTimes(1);
    expect(sourceGeometryDisposed).toHaveBeenCalledTimes(1);
  });

  it('diagnoses and clamps pathological boundary overflow without rejecting', async () => {
    const effect = defineEffect({
      elements: {},
      timeline: timeline<never>([], { duration: 0.000001, loop: true }),
    });
    const delivered: string[] = [];
    const observations: string[][] = [];
    let instance!: { readonly diagnostics: readonly VfxDiagnostic[] };
    let sibling!: { readonly diagnostics: readonly VfxDiagnostic[] };
    const system = new VFXSystem({}, undefined, {
      onRuntimeDiagnostic: ({ code }) => {
        delivered.push(code);
        observations.push([
          instance.diagnostics.at(-1)?.code ?? '',
          sibling.diagnostics.at(-1)?.code ?? '',
        ]);
      },
    });
    instance = system.spawn(effect);
    sibling = system.spawn(effect);

    await expect(system.update(0.010001)).resolves.toBeUndefined();
    expect(instance.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_TIMELINE_BOUNDARY_OVERFLOW',
        severity: 'warning',
      }),
    );
    expect(sibling.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_TIMELINE_BOUNDARY_OVERFLOW' }),
    );
    expect(delivered).toEqual(['NACHI_TIMELINE_BOUNDARY_OVERFLOW']);
    expect(observations).toEqual([
      ['NACHI_TIMELINE_BOUNDARY_OVERFLOW', 'NACHI_TIMELINE_BOUNDARY_OVERFLOW'],
    ]);
    expect(system.time).toBeLessThan(0.010001);
  });

  it('stores shared boundary overflow before containing a throwing handler', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const effect = defineEffect({
      elements: {},
      timeline: timeline<never>([], { duration: 0.000001, loop: true }),
    });
    let instance!: { readonly diagnostics: readonly VfxDiagnostic[] };
    let sibling!: { readonly diagnostics: readonly VfxDiagnostic[] };
    const observations: string[][] = [];
    try {
      const system = new VFXSystem({}, undefined, {
        onRuntimeDiagnostic: () => {
          observations.push([
            instance.diagnostics.at(-1)?.code ?? '',
            sibling.diagnostics.at(-1)?.code ?? '',
          ]);
          throw new Error('timeline boundary handler failed');
        },
      });
      instance = system.spawn(effect);
      sibling = system.spawn(effect);

      await expect(system.update(0.010001)).resolves.toBeUndefined();

      expect(observations).toEqual([
        ['NACHI_TIMELINE_BOUNDARY_OVERFLOW', 'NACHI_TIMELINE_BOUNDARY_OVERFLOW'],
      ]);
      expect(instance.diagnostics.map(({ code }) => code)).toEqual([
        'NACHI_TIMELINE_BOUNDARY_OVERFLOW',
        'NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED',
      ]);
      expect(sibling.diagnostics.map(({ code }) => code)).toEqual([
        'NACHI_TIMELINE_BOUNDARY_OVERFLOW',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
