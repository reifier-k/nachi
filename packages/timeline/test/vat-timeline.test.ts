import {
  applyVat,
  ring,
  setVatTimelineTime,
  type VatConfig,
  type VatControls,
} from '@nachi-vfx/mesh-fx';
import { context, uniform, vec3 } from 'three/tsl';
import { DataTexture, FloatType, NoColorSpace, RGBAFormat, Scene, type Texture } from 'three';
import * as THREE from 'three/webgpu';
import type Node from 'three/src/nodes/core/Node.js';
import { describe, expect, it, vi } from 'vitest';

import { getVatControls } from '../../mesh-fx/src/vat.js';

import {
  VFXSystem,
  at,
  defineEffect,
  fxMaterial,
  meshFxElement,
  play,
  stop,
  timeline,
} from '../src/index.js';

function vatTexture(width: number, height = 4): DataTexture {
  const texture = new DataTexture(new Float32Array(width * height * 4), width, height, RGBAFormat);
  texture.type = FloatType;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function vatRing(
  material: THREE.NodeMaterial,
  options: Partial<VatConfig> = {},
): {
  readonly controls: VatControls;
  readonly mesh: ReturnType<typeof ring>;
  readonly normalTexture?: Texture;
  readonly positionTexture: Texture;
} {
  const mesh = ring({ material });
  const width = mesh.geometry.getAttribute('position').count;
  const positionTexture = options.positionTexture ?? vatTexture(width);
  const controls = applyVat(mesh, {
    fps: 4,
    frameCount: 4,
    positionTexture,
    vertexLookup: 'vertex-index',
    ...options,
  });
  return {
    controls,
    mesh,
    ...(options.normalTexture === undefined ? {} : { normalTexture: options.normalTexture }),
    positionTexture,
  };
}

function vatRingWithNormal(material: THREE.NodeMaterial) {
  const mesh = ring({ material });
  const width = mesh.geometry.getAttribute('position').count;
  const positionTexture = vatTexture(width);
  const normalTexture = vatTexture(width);
  const controls = applyVat(mesh, {
    fps: 4,
    frameCount: 4,
    normalTexture,
    positionTexture,
    vertexLookup: 'vertex-index',
  });
  return { controls, mesh, normalTexture, positionTexture };
}

const materialCases = [
  ['fxMaterial', () => fxMaterial()],
  ['generic NodeMaterial', () => new THREE.MeshBasicNodeMaterial()],
] as const;

function namedClones(scene: Scene, name: string): THREE.Mesh[] {
  return scene.children.filter((child) => child.name === name) as THREE.Mesh[];
}

function onlyVatControl(mesh: THREE.Mesh): VatControls {
  const controls = getVatControls(mesh);
  expect(controls).toHaveLength(1);
  return controls[0]!;
}

function containsNode(root: Node | null, expected: Node): boolean {
  let found = false;
  root?.traverse((node) => {
    if (node === expected) found = true;
  });
  return found;
}

function containsTexture(root: Node | null, expected: Texture): boolean {
  let found = false;
  root?.traverse((node) => {
    if ((node as Node & { value?: unknown }).value === expected) found = true;
  });
  return found;
}

function meshVertexWgsl(mesh: THREE.Mesh): string {
  const renderer = {
    backend: {
      capabilities: { getUniformBufferLimit: () => 64 },
      compatibilityMode: false,
      utils: {
        getTextureSampleData: () => ({ isMSAA: false, primarySamples: 1, samples: 1 }),
      },
    },
    contextNode: context({}),
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    getMRT: () => null,
    getRenderTarget: () => null,
    hasFeature: () => false,
    library: new THREE.BasicNodeLibrary(),
    lighting: { enabled: false },
  };
  const NodeBuilder = THREE.WGSLNodeBuilder as unknown as new (
    object: unknown,
    renderer: unknown,
  ) => {
    build(): void;
    camera: THREE.Camera;
    scene: THREE.Scene;
    vertexShader: string;
  };
  const builder = new NodeBuilder(mesh, renderer);
  builder.camera = new THREE.PerspectiveCamera();
  builder.scene = new THREE.Scene();
  builder.build();
  return builder.vertexShader;
}

describe('@nachi-vfx/timeline VAT lifecycle binding', () => {
  it('rebuilds fx and ordinary NodeMaterial VAT graphs with independent owned clock snapshots', async () => {
    const fxNormal = vatTexture(ring().geometry.getAttribute('position').count);
    const ordinaryNormal = vatTexture(ring().geometry.getAttribute('position').count);
    const fx = vatRing(fxMaterial(), { normalTexture: fxNormal });
    const ordinary = vatRing(new THREE.MeshBasicNodeMaterial(), {
      normalTexture: ordinaryNormal,
    });
    fx.mesh.name = 'vat-fx-owned';
    ordinary.mesh.name = 'vat-ordinary-owned';
    fx.controls.setTime(0.25);
    ordinary.controls.setTime(0.375);
    const effect = defineEffect({
      elements: {
        fx: meshFxElement(fx.mesh, { duration: 2 }),
        ordinary: meshFxElement(ordinary.mesh, { duration: 2 }),
      },
      timeline: [at(0, play('fx'), play('ordinary'))],
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    const first = system.spawn(effect);
    const second = system.spawn(effect);
    const [fxA, fxB] = namedClones(scene, 'vat-fx-owned');
    const [ordinaryA, ordinaryB] = namedClones(scene, 'vat-ordinary-owned');
    const fxAControl = onlyVatControl(fxA!);
    const fxBControl = onlyVatControl(fxB!);
    const ordinaryAControl = onlyVatControl(ordinaryA!);
    const ordinaryBControl = onlyVatControl(ordinaryB!);

    expect(fxAControl.time?.value).toBe(0.25);
    expect(fxBControl.time?.value).toBe(0.25);
    expect(ordinaryAControl.time?.value).toBe(0.375);
    expect(ordinaryBControl.time?.value).toBe(0.375);
    expect(fxAControl.time).not.toBe(fxBControl.time);
    expect(fxAControl.time).not.toBe(fx.controls.time);
    expect(ordinaryAControl.time).not.toBe(ordinaryBControl.time);
    expect(ordinaryAControl.time).not.toBe(ordinary.controls.time);
    for (const [source, cloneA, cloneB] of [
      [fx.mesh, fxA!, fxB!],
      [ordinary.mesh, ordinaryA!, ordinaryB!],
    ] as const) {
      const sourceMaterial = source.material as THREE.MeshBasicNodeMaterial;
      const materialA = cloneA.material as THREE.MeshBasicNodeMaterial;
      const materialB = cloneB.material as THREE.MeshBasicNodeMaterial;
      expect(materialA.positionNode).not.toBeNull();
      expect(materialA.normalNode).not.toBeNull();
      expect(materialA.positionNode).not.toBe(sourceMaterial.positionNode);
      expect(materialB.positionNode).not.toBe(materialA.positionNode);
      expect(materialA.normalNode).not.toBe(sourceMaterial.normalNode);
      expect(materialB.normalNode).not.toBe(materialA.normalNode);
    }
    expect(
      containsTexture(
        (fxA!.material as THREE.MeshBasicNodeMaterial).positionNode,
        fx.positionTexture,
      ),
    ).toBe(true);
    expect(
      containsTexture(
        (ordinaryA!.material as THREE.MeshBasicNodeMaterial).normalNode,
        ordinaryNormal,
      ),
    ).toBe(true);

    fx.controls.setTime(0.75);
    ordinary.controls.setTime(0.75);
    expect(fxAControl.time?.value).toBe(0.25);
    expect(ordinaryAControl.time?.value).toBe(0.375);
    await system.update(0);
    expect(fxAControl.time?.value).toBe(0);
    expect(fxBControl.time?.value).toBe(0);
    expect(ordinaryAControl.time?.value).toBe(0);
    expect(ordinaryBControl.time?.value).toBe(0);
    await system.update(0.2);
    expect(fxAControl.time?.value).toBeCloseTo(0.2, 10);
    expect(fxBControl.time?.value).toBeCloseTo(0.2, 10);
    first.stop();
    await system.update(0.1);
    expect(fxAControl.time?.value).toBeCloseTo(0.2, 10);
    expect(fxBControl.time?.value).toBeCloseTo(0.3, 10);

    first.release();
    second.release();
  });

  it('uses latest-play element time across scaling, zero-scale pause, hit stop, expiry, and loop replay', async () => {
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-clock-lifecycle';
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh, { duration: 0.4 }) },
      timeline: timeline([at(0, play('vat'))], { duration: 0.5, loop: 2 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);
    const clone = namedClones(scene, 'vat-clock-lifecycle')[0]!;
    const controls = onlyVatControl(clone);

    await system.update(0);
    expect(controls.time?.value).toBe(0);
    instance.setTimeScale(2);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.2, 10);
    instance.setTimeScale(0);
    await system.update(0.2);
    expect(controls.time?.value).toBeCloseTo(0.2, 10);
    instance.setTimeScale(0.5);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.25, 10);
    instance.applyHitStop(100, 0);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.25, 10);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.3, 10);
    instance.setTimeScale(1);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.4, 10);
    expect(instance.getElementState('vat')).toMatchObject({ playing: false, visible: false });
    await system.update(0.1);
    expect(instance.cycle).toBe(1);
    expect(instance.getElementState('vat')).toMatchObject({ localTime: 0, playing: true });
    expect(controls.time?.value).toBe(0);
    await system.update(0.1);
    expect(controls.time?.value).toBeCloseTo(0.1, 10);

    instance.stop();
    await system.update(0.2);
    expect(controls.time?.value).toBeCloseTo(0.1, 10);
    const fresh = system.spawn(effect);
    const freshClone = namedClones(scene, 'vat-clock-lifecycle').at(-1)!;
    const freshControls = onlyVatControl(freshClone);
    await system.update(0);
    expect(freshControls.time?.value).toBe(0);
    expect(fresh.getElementState('vat')?.localTime).toBe(0);
  });

  it('clamps an omitted-update wall gap before advancing an owned VAT clock', async () => {
    let now = 1_000;
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-measured-delta-clamp';
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh, { duration: 2 }) },
      timeline: timeline([at(0, play('vat'))], { duration: 2 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene, { now: () => now });
    system.spawn(effect);
    const controls = onlyVatControl(namedClones(scene, 'vat-measured-delta-clamp')[0]!);

    await system.update();
    now += 1_000;
    await system.update();

    expect(controls.time?.value).toBeCloseTo(0.25, 10);
    expect(system.measuredDeltaDroppedSeconds).toBeCloseTo(0.75, 10);
  });

  it('keeps the uncapped measured VAT clock available through Infinity', async () => {
    let now = 1_000;
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-measured-delta-infinity';
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh, { duration: 2 }) },
      timeline: timeline([at(0, play('vat'))], { duration: 2 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene, {
      maxMeasuredDeltaSeconds: Number.POSITIVE_INFINITY,
      now: () => now,
    });
    system.spawn(effect);
    const controls = onlyVatControl(namedClones(scene, 'vat-measured-delta-infinity')[0]!);

    await system.update();
    now += 1_000;
    await system.update();

    expect(controls.time?.value).toBeCloseTo(1, 10);
    expect(system.droppedSeconds).toBe(0);
  });

  it('preserves external node and numeric VAT clocks without timeline writes or diagnostics', async () => {
    const externalTime = uniform(0.625);
    const external = vatRing(fxMaterial(), { time: externalTime });
    const numeric = vatRing(new THREE.MeshBasicNodeMaterial(), { time: 0.25 });
    external.mesh.name = 'vat-external-node';
    numeric.mesh.name = 'vat-external-number';
    const effect = defineEffect({
      elements: {
        external: meshFxElement(external.mesh),
        numeric: meshFxElement(numeric.mesh),
      },
      timeline: [at(0, play('external'), play('numeric'))],
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    const instance = system.spawn(effect);
    const externalClone = namedClones(scene, 'vat-external-node')[0]!;
    const numericClone = namedClones(scene, 'vat-external-number')[0]!;
    const externalControl = onlyVatControl(externalClone);
    const numericControl = onlyVatControl(numericClone);

    expect(externalControl.time).toBeNull();
    expect(numericControl.time).toBeNull();
    expect(
      containsNode(
        (externalClone.material as THREE.MeshBasicNodeMaterial).positionNode,
        externalTime,
      ),
    ).toBe(true);
    await system.update(0.3);
    expect(externalTime.value).toBe(0.625);
    externalTime.value = 0.875;
    await system.update(0.2);
    expect(externalTime.value).toBe(0.875);
    expect(instance.diagnostics).toEqual([]);
  });

  it('keeps fx.time track-local while VAT time and normalized life remain latest-play local', async () => {
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-fx-clock-domains';
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh, { duration: 1 }) },
      timeline: timeline([at(0.2, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, 'vat-fx-clock-domains')[0]!;
    const material = clone.material as ReturnType<typeof fxMaterial>;
    const vat = onlyVatControl(clone);

    await system.update(0.2);
    expect(material.fx.time?.value).toBeCloseTo(0.2, 10);
    expect(material.fx.normalizedLife?.value).toBe(0);
    expect(vat.time?.value).toBe(0);
    await system.update(0.1);
    expect(material.fx.time?.value).toBeCloseTo(0.3, 10);
    expect(material.fx.normalizedLife?.value).toBeCloseTo(0.1, 10);
    expect(vat.time?.value).toBeCloseTo(0.1, 10);
  });

  it('replays multiple VAT layers in order and snapshots mutable config and each owned clock', async () => {
    const material = new THREE.MeshBasicNodeMaterial();
    const source = ring({ material });
    source.name = 'vat-layer-stack';
    const width = source.geometry.getAttribute('position').count;
    const firstTexture = vatTexture(width);
    const secondTexture = vatTexture(width);
    const normalTexture = vatTexture(width);
    const frameRange: [number, number] = [0, 2];
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      frameRange,
      positionTexture: firstTexture,
      vertexLookup: 'vertex-index',
    });
    const second = applyVat(source, {
      fps: 8,
      frameCount: 4,
      normalTexture,
      positionTexture: secondTexture,
      vertexLookup: 'vertex-index',
    });
    first.setTime(0.25);
    second.setTime(0.125);
    frameRange[1] = 3;
    const effect = defineEffect({
      elements: { stack: meshFxElement(source) },
      timeline: [at(0, play('stack'))],
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, 'vat-layer-stack')[0]!;
    const cloned = getVatControls(clone);

    expect(cloned).toHaveLength(2);
    expect(cloned[0]?.frameRange).toEqual([0, 2]);
    expect(cloned[0]?.time?.value).toBe(0.25);
    expect(cloned[1]?.time?.value).toBe(0.125);
    expect(cloned[0]?.time).not.toBe(first.time);
    expect(cloned[1]?.time).not.toBe(second.time);
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
    expect(containsTexture(cloneMaterial.positionNode, firstTexture)).toBe(true);
    expect(containsTexture(cloneMaterial.positionNode, secondTexture)).toBe(true);
    expect(containsTexture(cloneMaterial.normalNode, normalTexture)).toBe(true);
    await system.update(0);
    expect(cloned.map(({ time }) => time?.value)).toEqual([0, 0]);
    await system.update(0.2);
    expect(cloned.map(({ time }) => time?.value)).toEqual([0.2, 0.2]);
  });

  it('preserves an explicit pre-VAT fxMaterial base position node without double application', () => {
    const baseOffset = uniform(0.125);
    const material = fxMaterial();
    material.positionNode = vec3(baseOffset, 0, 0);
    const source = vatRing(material);
    source.mesh.name = 'vat-explicit-base-node';
    const effect = defineEffect({ elements: { vat: source.mesh } });
    const scene = new Scene();
    new VFXSystem({}, scene).spawn(effect);
    const clone = namedClones(scene, 'vat-explicit-base-node')[0]!;
    const clonePosition = (clone.material as THREE.MeshBasicNodeMaterial).positionNode;

    expect(clonePosition).not.toBe(material.positionNode);
    expect(containsNode(clonePosition, baseOffset)).toBe(true);
    expect(containsTexture(clonePosition, source.positionTexture)).toBe(true);
  });

  it('uses the VAT rebuild path for prepare clones and preserves external texture ownership', async () => {
    const source = vatRing(fxMaterial());
    source.controls.setTime(0.375);
    const textureDisposed = vi.fn();
    source.positionTexture.addEventListener('dispose', textureDisposed);
    const effect = defineEffect({ elements: { vat: source.mesh } });
    let prepared: THREE.Mesh | undefined;
    const system = new VFXSystem({}, new Scene());

    await system.prepare(effect, {
      preparer: {
        prepareEmitter: vi.fn(),
        prepareObject: ({ object }) => {
          prepared = object as THREE.Mesh;
          const controls = onlyVatControl(prepared);
          expect(controls.time?.value).toBe(0.375);
          expect((prepared.material as THREE.MeshBasicNodeMaterial).positionNode).not.toBeNull();
          return undefined;
        },
      },
    });
    expect(prepared).toBeDefined();
    expect(textureDisposed).not.toHaveBeenCalled();

    let retained: THREE.Mesh | undefined;
    const retainedDisposed = vi.fn();
    await system.prepare(effect, {
      preparer: {
        prepareEmitter: vi.fn(),
        prepareObject: ({ object }) => {
          retained = object as THREE.Mesh;
          (retained.material as THREE.Material).addEventListener('dispose', retainedDisposed);
          expect(onlyVatControl(retained).time?.value).toBe(0.375);
          return { retained: true };
        },
      },
    });
    expect(retainedDisposed).not.toHaveBeenCalled();
    expect(textureDisposed).not.toHaveBeenCalled();
    (retained!.material as THREE.Material).dispose();
    expect(retainedDisposed).toHaveBeenCalledTimes(1);
    expect(textureDisposed).not.toHaveBeenCalled();
  });

  it('disposes a partially rebuilt clone material without touching source VAT resources', () => {
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-invalid-rebuild';
    const image = source.positionTexture.image as { width: number };
    image.width += 1;
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const textureDispose = vi.fn();
    source.positionTexture.addEventListener('dispose', textureDispose);
    const effect = defineEffect({ elements: { vat: source.mesh } });
    const scene = new Scene();

    const instance = new VFXSystem({}, scene).spawn(effect);

    expect(instance.state).toBe('error');
    expect(scene.children).toHaveLength(0);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose.mock.contexts[0]).not.toBe(source.mesh.material);
    expect(textureDispose).not.toHaveBeenCalled();
    materialDispose.mockRestore();
  });

  it('keeps the rebuilt fxMaterial VAT position and normal branches in real clone WGSL', () => {
    const probe = ring();
    const normalTexture = vatTexture(probe.geometry.getAttribute('position').count);
    probe.geometry.dispose();
    probe.material.dispose();
    const source = vatRing(fxMaterial(), { normalTexture });
    source.mesh.name = 'vat-clone-wgsl';
    const effect = defineEffect({ elements: { vat: source.mesh } });
    const scene = new Scene();
    new VFXSystem({}, scene).spawn(effect);
    const clone = namedClones(scene, 'vat-clone-wgsl')[0]!;
    const material = clone.material as THREE.MeshBasicNodeMaterial;
    // MeshBasic does not otherwise consume normals; route the rebuilt normal through color so its
    // vertex-stage texture branch remains live in this direct codegen regression.
    material.colorNode = material.normalNode as typeof material.colorNode;
    const shader = meshVertexWgsl(clone);

    expect(shader).toContain('@vertex');
    expect(shader.match(/textureLoad/g)?.length).toBeGreaterThanOrEqual(4);
    expect(shader).toContain('positionLocal =');
  });

  it('stops driving package-owned VAT clocks after an explicit stop action', async () => {
    const source = vatRing(fxMaterial());
    source.mesh.name = 'vat-stop-action';
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh) },
      timeline: timeline([at(0, play('vat')), at(0.2, stop('vat'))], { duration: 0.5 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const controls = onlyVatControl(namedClones(scene, 'vat-stop-action')[0]!);

    await system.update(0.2);
    expect(controls.time?.value).toBeCloseTo(0.2, 10);
    await system.update(0.2);
    expect(controls.time?.value).toBeCloseTo(0.2, 10);
  });

  it('holds a short non-looping VAT clip for a longer element without weakening standalone writes', async () => {
    const source = vatRing(fxMaterial(), { frameRange: [0, 1], loop: false });
    source.mesh.name = 'vat-short-non-loop-clip';
    expect(() => source.controls.setTime(0.5)).toThrow();
    source.controls.time!.value = 0.75;
    const effect = defineEffect({
      elements: { vat: meshFxElement(source.mesh, { duration: 1 }) },
      timeline: timeline([at(0, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const cloneControls = onlyVatControl(namedClones(scene, 'vat-short-non-loop-clip')[0]!);

    expect(cloneControls.time?.value).toBe(0.75);
    await system.update(0);
    expect(cloneControls.time?.value).toBe(0);
    await expect(system.update(0.5)).resolves.toBeUndefined();
    expect(cloneControls.time?.value).toBe(0.5);
    expect(() => setVatTimelineTime(cloneControls, Number.NaN)).toThrow();
    expect(() => setVatTimelineTime(cloneControls, -0.1)).toThrow();
    expect(cloneControls.time?.value).toBe(0.5);
  });

  it.each(
    materialCases,
  )('preserves an authored post-VAT position and independently rebuilds the active normal for %s', async (_label, createMaterial) => {
    const source = vatRingWithNormal(createMaterial());
    source.mesh.name = `vat-post-position-${_label}`;
    source.controls.setTime(0.125);
    const sourceMaterial = source.mesh.material as THREE.MeshBasicNodeMaterial;
    const oldPosition = sourceMaterial.positionNode!;
    const oldNormal = sourceMaterial.normalNode!;
    const authoredPosition = vec3(uniform(0.375), 0, 0);
    sourceMaterial.positionNode = authoredPosition;
    expect(getVatControls(source.mesh)).toEqual([source.controls]);
    const effect = defineEffect({
      elements: { vat: source.mesh },
      timeline: timeline([at(0.5, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.mesh.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
    const clonedControls = getVatControls(clone);

    expect(cloneMaterial.positionNode).toBe(authoredPosition);
    expect(containsNode(cloneMaterial.positionNode, oldPosition)).toBe(false);
    expect(cloneMaterial.normalNode).not.toBe(oldNormal);
    expect(containsTexture(cloneMaterial.normalNode, source.normalTexture)).toBe(true);
    expect(clonedControls).toHaveLength(1);
    expect(clonedControls[0]?.time).not.toBe(source.controls.time);
    expect(clonedControls[0]?.time?.value).toBe(0.125);
    await system.update(0.5);
    expect(clonedControls[0]?.time?.value).toBe(0);
    await system.update(0.1);
    expect(clonedControls[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(source.controls.time?.value).toBe(0.125);
  });

  it.each(
    materialCases,
  )('does not resurrect a position-only VAT after its final position graph is replaced for %s', async (_label, createMaterial) => {
    const source = vatRing(createMaterial());
    source.mesh.name = `vat-post-position-only-${_label}`;
    source.controls.setTime(0.125);
    const sourceMaterial = source.mesh.material as THREE.MeshBasicNodeMaterial;
    const oldPosition = sourceMaterial.positionNode!;
    const authoredPosition = vec3(uniform(0.375), 0, 0);
    sourceMaterial.positionNode = authoredPosition;
    expect(getVatControls(source.mesh)).toEqual([]);
    const effect = defineEffect({
      elements: { vat: source.mesh },
      timeline: timeline([at(0, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.mesh.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;

    expect(cloneMaterial.positionNode).toBe(authoredPosition);
    expect(containsNode(cloneMaterial.positionNode, oldPosition)).toBe(false);
    expect(getVatControls(clone)).toEqual([]);
    await system.update(0.2);
    expect(source.controls.time?.value).toBe(0.125);
  });

  it.each(
    materialCases,
  )('preserves an authored post-VAT normal and independently rebuilds position layers for %s', async (_label, createMaterial) => {
    const source = vatRingWithNormal(createMaterial());
    source.mesh.name = `vat-post-normal-${_label}`;
    source.controls.setTime(0.125);
    const sourceMaterial = source.mesh.material as THREE.MeshBasicNodeMaterial;
    const oldPosition = sourceMaterial.positionNode!;
    const authoredNormal = vec3(0, 1, 0);
    sourceMaterial.normalNode = authoredNormal;
    expect(getVatControls(source.mesh)).toEqual([source.controls]);
    const effect = defineEffect({
      elements: { vat: source.mesh },
      timeline: timeline([at(0.5, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.mesh.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
    const clonedControls = getVatControls(clone);

    expect(cloneMaterial.normalNode).toBe(authoredNormal);
    expect(cloneMaterial.positionNode).not.toBe(oldPosition);
    expect(containsTexture(cloneMaterial.positionNode, source.positionTexture)).toBe(true);
    expect(clonedControls).toHaveLength(1);
    expect(clonedControls[0]?.time).not.toBe(source.controls.time);
    await system.update(0.6);
    expect(clonedControls[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(source.controls.time?.value).toBe(0.125);
  });

  it.each(
    materialCases,
  )('falls back to authored post-VAT position and normal without stale controls for %s', async (_label, createMaterial) => {
    const source = vatRingWithNormal(createMaterial());
    source.mesh.name = `vat-post-both-${_label}`;
    source.controls.setTime(0.125);
    const sourceMaterial = source.mesh.material as THREE.MeshBasicNodeMaterial;
    const oldPosition = sourceMaterial.positionNode!;
    const oldNormal = sourceMaterial.normalNode!;
    const authoredPosition = vec3(uniform(0.25), 0, 0);
    const authoredNormal = vec3(0, 0, 1);
    sourceMaterial.positionNode = authoredPosition;
    sourceMaterial.normalNode = authoredNormal;
    expect(getVatControls(source.mesh)).toEqual([]);
    const effect = defineEffect({
      elements: { vat: source.mesh },
      timeline: timeline([at(0, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.mesh.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;

    expect(cloneMaterial.positionNode).toBe(authoredPosition);
    expect(cloneMaterial.normalNode).toBe(authoredNormal);
    expect(containsNode(cloneMaterial.positionNode, oldPosition)).toBe(false);
    expect(containsNode(cloneMaterial.normalNode, oldNormal)).toBe(false);
    expect(getVatControls(clone)).toEqual([]);
    await system.update(0.2);
    expect(source.controls.time?.value).toBe(0.125);
  });

  it.each(
    materialCases,
  )('ignores stale VAT metadata after replacing the material with %s', (_label, createMaterial) => {
    const source = vatRingWithNormal(createMaterial());
    source.mesh.name = `vat-replaced-material-${_label}`;
    const oldMaterial = source.mesh.material as THREE.MeshBasicNodeMaterial;
    const oldPosition = oldMaterial.positionNode!;
    const oldNormal = oldMaterial.normalNode!;
    const replacement = createMaterial() as THREE.MeshBasicNodeMaterial;
    const authoredPosition = vec3(uniform(0.5), 0, 0);
    const authoredNormal = vec3(1, 0, 0);
    replacement.positionNode = authoredPosition;
    replacement.normalNode = authoredNormal;
    source.mesh.material = replacement;
    expect(getVatControls(source.mesh)).toEqual([]);
    const effect = defineEffect({ elements: { vat: source.mesh } });
    const scene = new Scene();
    new VFXSystem({}, scene).spawn(effect);
    const clone = namedClones(scene, source.mesh.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;

    expect(cloneMaterial.positionNode).toBe(authoredPosition);
    expect(cloneMaterial.normalNode).toBe(authoredNormal);
    expect(containsNode(cloneMaterial.positionNode, oldPosition)).toBe(false);
    expect(containsNode(cloneMaterial.normalNode, oldNormal)).toBe(false);
    expect(getVatControls(clone)).toEqual([]);
  });

  it.each(
    materialCases,
  )('keeps position VAT layers active when a normal is replaced between applyVat calls for %s', async (_label, createMaterial) => {
    const material = createMaterial() as THREE.MeshBasicNodeMaterial;
    const source = ring({ material });
    source.name = `vat-between-normal-${_label}`;
    const width = source.geometry.getAttribute('position').count;
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      normalTexture: vatTexture(width),
      positionTexture: vatTexture(width),
      vertexLookup: 'vertex-index',
    });
    const authoredNormal = vec3(0, 1, 0);
    material.normalNode = authoredNormal;
    const secondTexture = vatTexture(width);
    const second = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionTexture: secondTexture,
      vertexLookup: 'vertex-index',
    });
    first.setTime(0.125);
    second.setTime(0.25);
    expect(getVatControls(source)).toEqual([first, second]);
    const effect = defineEffect({
      elements: { vat: source },
      timeline: timeline([at(0.5, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.name)[0]!;
    const clonedControls = getVatControls(clone);
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;

    expect(clonedControls).toHaveLength(2);
    expect(clonedControls[0]?.time).not.toBe(first.time);
    expect(clonedControls[1]?.time).not.toBe(second.time);
    expect(cloneMaterial.normalNode).toBe(authoredNormal);
    expect(containsTexture(cloneMaterial.positionNode, secondTexture)).toBe(true);
    await system.update(0.6);
    expect(clonedControls[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(clonedControls[1]?.time?.value).toBeCloseTo(0.1, 10);
    expect([first.time?.value, second.time?.value]).toEqual([0.125, 0.25]);
  });

  it.each(
    materialCases,
  )('starts a new VAT chain from an authored position replacement between calls for %s', (_label, createMaterial) => {
    const material = createMaterial() as THREE.MeshBasicNodeMaterial;
    const source = ring({ material });
    source.name = `vat-between-position-${_label}`;
    const width = source.geometry.getAttribute('position').count;
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionTexture: vatTexture(width),
      vertexLookup: 'vertex-index',
    });
    const oldPosition = material.positionNode!;
    const authoredPosition = vec3(uniform(0.625), 0, 0);
    material.positionNode = authoredPosition;
    const secondTexture = vatTexture(width);
    const second = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionTexture: secondTexture,
      vertexLookup: 'vertex-index',
    });
    expect(getVatControls(source)).toEqual([second]);
    const effect = defineEffect({ elements: { vat: source } });
    const scene = new Scene();
    new VFXSystem({}, scene).spawn(effect);
    const clone = namedClones(scene, source.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
    const clonedControls = getVatControls(clone);

    expect(clonedControls).toHaveLength(1);
    expect(clonedControls[0]?.time).not.toBe(first.time);
    expect(clonedControls[0]?.time).not.toBe(second.time);
    expect(containsNode(cloneMaterial.positionNode, authoredPosition)).toBe(true);
    expect(containsNode(cloneMaterial.positionNode, oldPosition)).toBe(false);
    expect(containsTexture(cloneMaterial.positionNode, secondTexture)).toBe(true);
  });

  it.each(
    materialCases,
  )('keeps only the latest absolute position and normal clock reachable for %s', async (_label, createMaterial) => {
    const material = createMaterial() as THREE.MeshBasicNodeMaterial;
    const source = ring({ material });
    source.name = `vat-absolute-normal-${_label}`;
    const width = source.geometry.getAttribute('position').count;
    const firstPosition = vatTexture(width);
    const firstNormal = vatTexture(width);
    const secondPosition = vatTexture(width);
    const secondNormal = vatTexture(width);
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      normalTexture: firstNormal,
      positionMode: 'offset',
      positionTexture: firstPosition,
      vertexLookup: 'vertex-index',
    });
    const second = applyVat(source, {
      fps: 4,
      frameCount: 4,
      normalTexture: secondNormal,
      positionMode: 'absolute',
      positionTexture: secondPosition,
      vertexLookup: 'vertex-index',
    });
    first.setTime(0.125);
    second.setTime(0.25);

    expect(getVatControls(source)).toEqual([second]);
    expect(containsTexture(material.positionNode, firstPosition)).toBe(false);
    expect(containsTexture(material.positionNode, secondPosition)).toBe(true);
    expect(containsTexture(material.normalNode, firstNormal)).toBe(false);
    expect(containsTexture(material.normalNode, secondNormal)).toBe(true);

    const effect = defineEffect({
      elements: { vat: source },
      timeline: timeline([at(0, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    system.spawn(effect);
    const [cloneA, cloneB] = namedClones(scene, source.name);
    const controlsA = getVatControls(cloneA!);
    const controlsB = getVatControls(cloneB!);

    expect(controlsA).toHaveLength(1);
    expect(controlsB).toHaveLength(1);
    expect(controlsA[0]?.time?.value).toBe(0.25);
    expect(controlsB[0]?.time?.value).toBe(0.25);
    expect(controlsA[0]?.time).not.toBe(controlsB[0]?.time);
    expect(controlsA[0]?.time).not.toBe(second.time);
    for (const clone of [cloneA!, cloneB!]) {
      const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
      expect(containsTexture(cloneMaterial.positionNode, firstPosition)).toBe(false);
      expect(containsTexture(cloneMaterial.positionNode, secondPosition)).toBe(true);
      expect(containsTexture(cloneMaterial.normalNode, firstNormal)).toBe(false);
      expect(containsTexture(cloneMaterial.normalNode, secondNormal)).toBe(true);
    }

    await system.update(0);
    await system.update(0.1);
    expect(controlsA[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(controlsB[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(first.time?.value).toBe(0.125);
    expect(second.time?.value).toBe(0.25);
  });

  it.each(
    materialCases,
  )('unions an older surviving normal clock with a later absolute position clock for %s', async (_label, createMaterial) => {
    const material = createMaterial() as THREE.MeshBasicNodeMaterial;
    const source = ring({ material });
    source.name = `vat-absolute-surviving-normal-${_label}`;
    const width = source.geometry.getAttribute('position').count;
    const firstPosition = vatTexture(width);
    const firstNormal = vatTexture(width);
    const secondPosition = vatTexture(width);
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      normalTexture: firstNormal,
      positionMode: 'offset',
      positionTexture: firstPosition,
      vertexLookup: 'vertex-index',
    });
    const second = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionMode: 'absolute',
      positionTexture: secondPosition,
      vertexLookup: 'vertex-index',
    });
    first.setTime(0.125);
    second.setTime(0.25);

    expect(getVatControls(source)).toEqual([first, second]);
    expect(containsTexture(material.positionNode, firstPosition)).toBe(false);
    expect(containsTexture(material.positionNode, secondPosition)).toBe(true);
    expect(containsTexture(material.normalNode, firstNormal)).toBe(true);

    const effect = defineEffect({
      elements: { vat: source },
      timeline: timeline([at(0, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const clone = namedClones(scene, source.name)[0]!;
    const clonedControls = getVatControls(clone);
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;

    expect(clonedControls).toHaveLength(2);
    expect(clonedControls.map(({ time }) => time?.value)).toEqual([0.125, 0.25]);
    expect(containsTexture(cloneMaterial.positionNode, firstPosition)).toBe(false);
    expect(containsTexture(cloneMaterial.positionNode, secondPosition)).toBe(true);
    expect(containsTexture(cloneMaterial.normalNode, firstNormal)).toBe(true);
    await system.update(0);
    await system.update(0.1);
    expect(clonedControls.map(({ time }) => time?.value)).toEqual([
      expect.closeTo(0.1, 10),
      expect.closeTo(0.1, 10),
    ]);
    expect([first.time?.value, second.time?.value]).toEqual([0.125, 0.25]);
  });

  it.each(
    materialCases,
  )('keeps the last absolute layer and later offsets in clone graph and real WGSL for %s', async (_label, createMaterial) => {
    const material = createMaterial() as THREE.MeshBasicNodeMaterial;
    const source = ring({ material });
    source.name = `vat-absolute-offset-${_label}`;
    const width = source.geometry.getAttribute('position').count;
    const firstTexture = vatTexture(width);
    const secondTexture = vatTexture(width);
    const thirdTexture = vatTexture(width);
    const first = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionMode: 'offset',
      positionTexture: firstTexture,
      vertexLookup: 'vertex-index',
    });
    const second = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionMode: 'absolute',
      positionTexture: secondTexture,
      vertexLookup: 'vertex-index',
    });
    const third = applyVat(source, {
      fps: 4,
      frameCount: 4,
      positionMode: 'offset',
      positionTexture: thirdTexture,
      vertexLookup: 'vertex-index',
    });
    first.setTime(0.125);
    second.setTime(0.25);
    third.setTime(0.375);

    expect(getVatControls(source)).toEqual([second, third]);
    const effect = defineEffect({
      elements: { vat: source },
      timeline: timeline([at(0.5, play('vat'))], { duration: 1 }),
    });
    const scene = new Scene();
    new VFXSystem({}, scene).spawn(effect);
    const clone = namedClones(scene, source.name)[0]!;
    const cloneMaterial = clone.material as THREE.MeshBasicNodeMaterial;
    const clonedControls = getVatControls(clone);

    expect(clonedControls).toHaveLength(2);
    expect(clonedControls.map(({ time }) => time?.value)).toEqual([0.25, 0.375]);
    expect(containsTexture(cloneMaterial.positionNode, firstTexture)).toBe(false);
    expect(containsTexture(cloneMaterial.positionNode, secondTexture)).toBe(true);
    expect(containsTexture(cloneMaterial.positionNode, thirdTexture)).toBe(true);
    expect(meshVertexWgsl(clone).match(/textureLoad/g)?.length).toBeGreaterThanOrEqual(4);
    expect(first.time?.value).toBe(0.125);
  });

  it.each(
    materialCases,
  )('intersects external and owned reachable clocks with post-final channel replacement for %s', async (_label, createMaterial) => {
    const createLayeredSource = (name: string) => {
      const material = createMaterial() as THREE.MeshBasicNodeMaterial;
      const source = ring({ material });
      source.name = name;
      const width = source.geometry.getAttribute('position').count;
      const externalTime = uniform(0.625);
      const external = applyVat(source, {
        fps: 4,
        frameCount: 4,
        normalTexture: vatTexture(width),
        positionMode: 'offset',
        positionTexture: vatTexture(width),
        time: externalTime,
        vertexLookup: 'vertex-index',
      });
      const ownedTexture = vatTexture(width);
      const owned = applyVat(source, {
        fps: 4,
        frameCount: 4,
        positionMode: 'absolute',
        positionTexture: ownedTexture,
        vertexLookup: 'vertex-index',
      });
      owned.setTime(0.25);
      return { external, externalTime, material, owned, ownedTexture, source };
    };
    const positionReplaced = createLayeredSource(`vat-mixed-position-stale-${_label}`);
    const authoredPosition = vec3(uniform(0.5), 0, 0);
    positionReplaced.material.positionNode = authoredPosition;
    expect(getVatControls(positionReplaced.source)).toEqual([positionReplaced.external]);
    const normalReplaced = createLayeredSource(`vat-mixed-normal-stale-${_label}`);
    const authoredNormal = vec3(0, 1, 0);
    normalReplaced.material.normalNode = authoredNormal;
    expect(getVatControls(normalReplaced.source)).toEqual([normalReplaced.owned]);

    const effect = defineEffect({
      elements: {
        normalReplaced: normalReplaced.source,
        positionReplaced: positionReplaced.source,
      },
      timeline: timeline([at(0, play('normalReplaced'), play('positionReplaced'))], {
        duration: 1,
      }),
    });
    const scene = new Scene();
    const system = new VFXSystem({}, scene);
    system.spawn(effect);
    const positionClone = namedClones(scene, positionReplaced.source.name)[0]!;
    const normalClone = namedClones(scene, normalReplaced.source.name)[0]!;
    const positionControls = getVatControls(positionClone);
    const normalControls = getVatControls(normalClone);

    expect(positionControls).toHaveLength(1);
    expect(positionControls[0]?.time).toBeNull();
    expect((positionClone.material as THREE.MeshBasicNodeMaterial).positionNode).toBe(
      authoredPosition,
    );
    expect(normalControls).toHaveLength(1);
    expect(normalControls[0]?.time).not.toBe(normalReplaced.owned.time);
    expect(normalControls[0]?.time?.value).toBe(0.25);
    expect((normalClone.material as THREE.MeshBasicNodeMaterial).normalNode).toBe(authoredNormal);
    expect(
      containsTexture(
        (normalClone.material as THREE.MeshBasicNodeMaterial).positionNode,
        normalReplaced.ownedTexture,
      ),
    ).toBe(true);

    await system.update(0);
    await system.update(0.1);
    expect(positionReplaced.externalTime.value).toBe(0.625);
    expect(positionReplaced.owned.time?.value).toBe(0.25);
    expect(normalControls[0]?.time?.value).toBeCloseTo(0.1, 10);
    expect(normalReplaced.externalTime.value).toBe(0.625);
    expect(normalReplaced.owned.time?.value).toBe(0.25);
  });
});
