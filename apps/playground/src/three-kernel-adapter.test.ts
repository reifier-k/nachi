import { describe, expect, it } from 'vitest';
import {
  billboard,
  burst,
  compileEmitter,
  defineEmitter,
  curve,
  flipbook,
  killVolume,
  linearForce,
  lifetime,
  meshRenderer,
  pointAttractor,
  parseFga,
  positionSphere,
  rotationOverLife,
  turbulence,
  vectorField,
  velocityOverLife,
  vortex,
} from '@nachi/core';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeGeometryResolver,
  createThreeSpriteGeometry,
  createThreeTextureResolver,
  createThreeVectorFieldResolver,
  createThreeVectorFieldResource,
  directionEulerAngles,
  materializeThreeMeshDraw,
  materializeThreeSpriteDraw,
} from './three-kernel-adapter.js';

describe('three kernel adapter', () => {
  it('materializes parsed FGA data as a bounds-aware Three.js 3D texture', () => {
    const parsed = parseFga('2 1 1 -1 -2 -3 1 2 3 1 2 3 -1 -2 -3');
    const resource = createThreeVectorFieldResource(parsed);
    const data = resource.texture.image.data as Float32Array;

    expect(resource.boundsMin).toEqual([-1, -2, -3]);
    expect(resource.boundsMax).toEqual([1, 2, 3]);
    expect(resource.texture.image).toMatchObject({ width: 2, height: 1, depth: 1 });
    expect(resource.texture.minFilter).toBe(THREE.NearestFilter);
    expect(resource.texture.magFilter).toBe(THREE.NearestFilter);
    expect([...data]).toEqual([1, 2, 3, 1, -1, -2, -3, 1]);
  });

  it('enables trilinear vector-field sampling when float32 filtering is supported', () => {
    const resource = createThreeVectorFieldResource(
      parseFga('1 1 1 -1 -1 -1 1 1 1 0.5 0 -0.5'),
      true,
    );

    expect(resource.texture.minFilter).toBe(THREE.LinearFilter);
    expect(resource.texture.magFilter).toBe(THREE.LinearFilter);
  });

  it('resolves a FieldRef and builds the vector-field texture sample graph', () => {
    const reference = {
      assetType: 'vector-field',
      kind: 'asset-ref',
      uri: 'procedural://test/vortex.fga',
    } as const;
    const resource = createThreeVectorFieldResource(parseFga('1 1 1 -1 -1 -1 1 1 1 0.5 0 -0.5'));
    const adapter = createThreeKernelAdapter({
      resolveVectorField: createThreeVectorFieldResolver(new Map([[reference.uri, resource]])),
    });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [vectorField({ field: reference, strength: 2, tiling: true })],
      }),
    );

    expect(() => program.buildKernels(adapter)).not.toThrow();
    expect(() => adapter.sampleVectorField(reference, adapter.vec3(0, 0, 0), true)).not.toThrow();
  });

  it('rejects an unresolved required vector-field reference during materialization', () => {
    const reference = {
      assetType: 'vector-field',
      kind: 'asset-ref',
      uri: 'missing.fga',
    } as const;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [vectorField({ field: reference, strength: 1 })],
      }),
    );

    const adapter = createThreeKernelAdapter();
    program.buildKernels(adapter);
    expect(() => adapter.sampleVectorField(reference, adapter.vec3(0, 0, 0), false)).toThrow(
      'No vector-field resolver supplied for resource "missing.fga".',
    );
  });

  it('materializes all M4 behavior modules as Three.js TSL graphs', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        init: [positionSphere({ radius: 1 })],
        render: billboard({}),
        spawn: burst({ count: 4 }),
        update: [
          vortex({ axis: [0, 1, 0], inwardStrength: 0.2, strength: 2 }),
          pointAttractor({ falloff: 1, position: [0, 0, 0], radius: 4, strength: 3 }),
          linearForce({ force: [1, 2, 3] }),
          turbulence({ frequency: 0.5, octaves: 4, strength: 1 }),
          rotationOverLife(curve([0, 0], [1, 2])),
          velocityOverLife(curve([0, 1], [1, 0])),
          killVolume({ center: [0, 0, 0], mode: 'outside', shape: 'box', size: [4, 4, 4] }),
        ],
      }),
    );

    expect(program.diagnostics).toEqual([]);
    expect(() => program.buildKernels(createThreeKernelAdapter())).not.toThrow();
  });

  it('materializes mat3 storage with its vec4-aligned physical length', () => {
    const storage = createThreeKernelAdapter().instancedArray(1, 'mat3');
    const attribute = storage.value as { array: Float32Array; count: number };

    expect(attribute.count).toBe(1);
    expect(attribute.array.length).toBe(12);
    expect(attribute.array.byteLength).toBe(48);
  });

  it('materializes a packed sprite InstancedMesh and primes indirect indexCount', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 4 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels);
    const offset = kernels.drawIndirectOffsetBytes! / Uint32Array.BYTES_PER_ELEMENT;
    const words = (kernels.drawIndirect!.indirectResource as { array: Uint32Array }).array;

    expect(mesh.isInstancedMesh).toBe(true);
    expect(mesh.geometry.getIndex()?.count).toBe(6);
    expect(mesh.geometry.getIndirect()).toBe(kernels.drawIndirect!.indirectResource);
    expect(words[offset]).toBe(6);
    expect(mesh.material.blending).toBe(2);
  });

  it('uses premultiplied alpha for Three.js multiply blending', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ blending: 'multiply' }),
        spawn: burst({ count: 1 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels);

    expect(mesh.material.premultipliedAlpha).toBe(true);
  });

  it('builds cutout geometry with quad-space UVs', () => {
    const geometry = createThreeSpriteGeometry(6);
    const positions = geometry.getAttribute('position');
    const uvs = geometry.getAttribute('uv');

    expect(positions.count).toBe(6);
    expect(uvs.count).toBe(6);
    expect(geometry.getIndex()?.count).toBe(12);
    expect(Array.from(uvs.array).every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('offsets the octagonal cutout phase away from cardinal vertices', () => {
    const geometry = createThreeSpriteGeometry(8);
    const positions = geometry.getAttribute('position');

    expect(positions.getX(0)).not.toBeCloseTo(0);
    expect(positions.getY(0)).toBeCloseTo(-0.5);
    expect(geometry.getIndex()?.count).toBe(18);
  });

  it('materializes flipbook, motion-vector, and soft-particle nodes through TextureRef resolution', () => {
    const atlasRef = { assetType: 'texture', kind: 'asset-ref', uri: 'atlas' } as const;
    const motionRef = { assetType: 'texture', kind: 'asset-ref', uri: 'motion' } as const;
    const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const motion = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
    const resolver = createThreeTextureResolver(
      new Map([
        ['atlas', atlas],
        ['motion', motion],
      ]),
    );
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [lifetime(1)],
        render: billboard({
          cutout: { vertices: 6 },
          map: flipbook(atlasRef, { cols: 2, motionVectors: motionRef, rows: 2 }),
          soft: true,
        }),
        spawn: burst({ count: 1 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels, 0, { resolveTexture: resolver });

    expect(resolver(atlasRef)).toBe(atlas);
    expect(mesh.geometry.getAttribute('position').count).toBe(6);
    expect(mesh.geometry.getIndex()?.count).toBe(12);
    expect(mesh.material.opacityNode).not.toBeNull();
  });

  it('materializes non-indexed geometry as an indirect mesh particle draw', () => {
    const geometryRef = { assetType: 'geometry', kind: 'asset-ref', uri: 'debris' } as const;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0.25, 0, -0.1, -0.1, 0, 0.1, -0.1, 0], 3),
    );
    const program = compileEmitter(
      defineEmitter({
        capacity: 3,
        render: meshRenderer({ alignment: { mode: 'quaternion' }, geometry: geometryRef }),
        spawn: burst({ count: 2 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeMeshDraw(program, kernels, 0, {
      resolveGeometry: createThreeGeometryResolver(new Map([['debris', geometry]])),
    });

    expect(geometry.getIndex()).toBeNull();
    expect(mesh.geometry.getIndex()?.count).toBe(3);
    expect(mesh.material.positionNode).not.toBeNull();
    expect(mesh.material.colorNode).not.toBeNull();
    expect(mesh.material.transparent).toBe(true);
  });

  it('maps mesh +Y to five directions using the transposed TSL rotate convention', () => {
    const directions = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [-1, 0, 0],
      [0.3, 0.8, 0.5],
    ] as const;
    const applyTslRotate = (
      position: THREE.Vector3,
      euler: readonly [number, number, number],
    ): THREE.Vector3 => {
      // three r185 RotateNode constructs its mat4 columns as transposed standard rotations.
      const matrix = new THREE.Matrix4()
        .makeRotationX(-euler[0])
        .multiply(new THREE.Matrix4().makeRotationY(-euler[1]))
        .multiply(new THREE.Matrix4().makeRotationZ(-euler[2]));
      return position.applyMatrix4(matrix);
    };

    for (const direction of directions) {
      const expected = new THREE.Vector3(...direction).normalize();
      const euler = directionEulerAngles(direction);
      const actual = applyTslRotate(new THREE.Vector3(0, 1, 0), euler).normalize();
      for (let component = 0; component < 3; component += 1) {
        expect(actual.getComponent(component)).toBeCloseTo(expected.getComponent(component), 6);
      }
    }
  });

  it('uses the opaque render-list path for non-alpha mesh blending', () => {
    const geometryRef = { assetType: 'geometry', kind: 'asset-ref', uri: 'debris' } as const;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: meshRenderer({ blending: 'additive', geometry: geometryRef }),
        spawn: burst({ count: 1 }),
      }),
    );
    const mesh = materializeThreeMeshDraw(
      program,
      program.buildKernels(createThreeKernelAdapter()),
      0,
      { resolveGeometry: createThreeGeometryResolver(new Map([['debris', geometry]])) },
    );

    expect(mesh.material.transparent).toBe(false);
  });
});
