import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  billboard,
  bakeSdf,
  burst,
  compileEmitter,
  collideSceneDepth,
  collideSdf,
  defineEmitter,
  curve,
  flipbook,
  killVolume,
  linearForce,
  lifetime,
  lightIntensity,
  lightRenderer,
  decalRenderer,
  meshRenderer,
  pointAttractor,
  parseFga,
  positionSphere,
  positionMeshSurface,
  rotationOverLife,
  turbulence,
  vectorField,
  velocityOverLife,
  velocityMeshNormal,
  vortex,
  createCoreKernelModuleRegistry,
} from '@nachi/core';
import type { EffectInstanceState } from '@nachi/core';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi/trails';
import { materializeThreeRibbonDraw } from '@nachi/trails/three';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeGeometryResolver,
  createThreeMeshSurfaceResolver,
  createThreeMeshSurfaceResource,
  createThreeSdfResolver,
  createThreeSdfResource,
  createThreeSpriteGeometry,
  createThreeTextureResolver,
  createThreeTransformSource,
  createThreeVectorFieldResolver,
  createThreeVectorFieldResource,
  directionEulerAngles,
  materializeThreeMeshDraw,
  materializeThreeLightDraw,
  materializeThreeDecalDraw,
  materializeThreeSpriteDraw,
} from './three-kernel-adapter.js';

describe('three kernel adapter', () => {
  it('materializes a bounded PointLight pool and projection-box decal', async () => {
    const lightProgram = compileEmitter(
      defineEmitter({
        capacity: 12,
        init: [positionSphere({ radius: 1 }), lifetime(1), lightIntensity(4)],
        integration: 'none',
        render: lightRenderer({ maxLights: 3 }),
        spawn: burst({ count: 12 }),
      }),
    );
    const lightKernels = lightProgram.buildKernels(createThreeKernelAdapter());
    const lightDraw = materializeThreeLightDraw(lightProgram, lightKernels);
    expect(lightDraw.lights).toHaveLength(3);
    expect(lightDraw.lights.every(({ visible }) => visible)).toBe(true);
    expect(lightDraw.lights.every(({ intensity }) => intensity === 0)).toBe(true);
    expect(lightDraw.selectionBuffers).toHaveLength(2);
    expect(lightDraw.selectionKernels).toHaveLength(2);
    expectTypeOf<Parameters<typeof lightDraw.update>[1]>().toEqualTypeOf<
      EffectInstanceState | undefined
    >();
    const lightScene = new THREE.Scene();
    lightScene.add(lightDraw.group);
    const completeState: EffectInstanceState = 'complete';
    await lightDraw.update({} as THREE.WebGPURenderer, completeState);
    expect(lightDraw.group.parent).toBeNull();
    expect(lightDraw.lights.every(({ intensity }) => intensity === 0)).toBe(true);

    const depth = new THREE.DataTexture(
      new Float32Array([1]),
      1,
      1,
      THREE.RedFormat,
      THREE.FloatType,
    );
    depth.needsUpdate = true;
    const decalProgram = compileEmitter(
      defineEmitter({
        capacity: 2,
        init: [positionSphere({ radius: 0 }), lifetime(1)],
        integration: 'none',
        render: decalRenderer({ sizeScale: 2 }),
        spawn: burst({ count: 1 }),
      }),
    );
    const decalKernels = decalProgram.buildKernels(
      createThreeKernelAdapter({ sceneDepthTexture: depth }),
    );
    const decal = materializeThreeDecalDraw(decalProgram, decalKernels, 0, {
      sceneDepthTexture: depth,
    });
    const decalIndirect = decalKernels.drawIndirect!
      .indirectResource as THREE.IndirectStorageBufferAttribute;
    expect(decal.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect(decal.geometry.getIndirect()).toBeDefined();
    expect(decalIndirect.updateRanges).toEqual([
      { count: 1, start: decalKernels.drawIndirectOffsetBytes! / 4 },
    ]);
    expect(() =>
      materializeThreeDecalDraw(
        decalProgram,
        { ...decalKernels, capabilityPath: 'webgl2-cpu-readback' },
        0,
        { sceneDepthTexture: depth },
      ),
    ).toThrowError('NACHI_DECAL_WEBGL2_UNSUPPORTED');
  });

  it('materializes an external @nachi/trails GPU birth-ring draw', () => {
    const registry = registerTrails(createCoreKernelModuleRegistry());
    const program = compileEmitter(
      defineEmitter({
        attributes: { ribbonId: ribbonIdAttribute() },
        capacity: 8,
        init: [lifetime(1), ribbonId({ count: 2, mode: 'alternating' })],
        integration: 'none',
        render: ribbon({ maxRibbons: 2, uv: { mode: 'stretched' }, width: 0.2 }),
        spawn: burst({ count: 8 }),
      }),
      { registry },
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const draw = materializeThreeRibbonDraw(program, kernels);

    expect(program.draws[0]).toMatchObject({ kind: 'ribbon', requiresBackend: 'webgpu' });
    expect(draw.prepareKernel).toBeDefined();
    expect(draw.mesh.geometry.getIndirect()).toBe(draw.indirect);
    expect(() =>
      materializeThreeRibbonDraw(program, {
        ...kernels,
        capabilityPath: 'webgl2-cpu-readback',
      }),
    ).toThrowError('NACHI_RIBBON_WEBGL2_UNSUPPORTED');
  });

  it('builds an area CDF and position texture from BufferGeometry triangles', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0], 3),
    );
    const resource = createThreeMeshSurfaceResource(
      new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()),
      6,
    );
    const cdf = resource.cdfTexture.image.data as Float32Array;
    expect(resource.triangleCount).toBe(2);
    expect(cdf[0]).toBeCloseTo(0.5);
    expect(cdf[1]).toBe(1);
    expect(resource.positionTexture.image.width).toBe(6);
  });

  it('samples the mesh CDF in statistically area-proportional frequencies', () => {
    const geometry = new THREE.BufferGeometry();
    // Areas 0.5 and 2.0, hence expected probabilities 0.2 and 0.8.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0], 3),
    );
    const resource = createThreeMeshSurfaceResource(
      new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()),
      6,
    );
    const cdf = resource.cdfTexture.image.data as Float32Array;
    const counts = [0, 0];
    let state = 0x1234_5678;
    for (let sampleIndex = 0; sampleIndex < 20_000; sampleIndex += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const sample = state / 0x1_0000_0000;
      const triangle = sample <= (cdf[0] ?? 0) ? 0 : 1;
      counts[triangle] = (counts[triangle] ?? 0) + 1;
    }
    const expected = [4_000, 16_000];
    const chiSquare = counts.reduce((sum, count, index) => {
      const delta = count - expected[index]!;
      return sum + (delta * delta) / expected[index]!;
    }, 0);
    expect(cdf[0]).toBeCloseTo(0.2, 6);
    expect(chiSquare).toBeLessThan(10.83); // df=1, p=0.001
  });

  it('rejects a one-row mesh texture wider than maxTextureDimension2D', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    expect(() => createThreeMeshSurfaceResource(mesh, 5)).toThrowError(
      'NACHI_MESH_SURFACE_TEXTURE_TOO_WIDE: Mesh surface sampling requires 6 texels, exceeding maxTextureDimension2D 5.',
    );
  });

  it('updates CPU-skinned triangle positions after a bone transform', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute(
      'skinIndex',
      new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4),
    );
    geometry.setAttribute(
      'skinWeight',
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    const bone = new THREE.Bone();
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    const resource = createThreeMeshSurfaceResource(mesh);
    const positions = resource.positionTexture.image.data as Float32Array;
    const before = positions.slice();
    bone.position.y = 0.5;
    resource.updateFromMesh(mesh);
    expect(positions[1]).toBeCloseTo((before[1] ?? 0) + 0.5);
  });

  it('materializes analytic SDF data as a bounds-aware 3D texture', () => {
    const resource = createThreeSdfResource(
      bakeSdf({
        boundsMax: [1, 1, 1],
        boundsMin: [-1, -1, -1],
        resolution: [3, 3, 3],
        shapes: [{ center: [0, 0, 0], radius: 0.5, shape: 'sphere' }],
      }),
      true,
    );
    expect(resource.texture.image).toMatchObject({ width: 3, height: 3, depth: 3 });
    expect(resource.texture.minFilter).toBe(THREE.LinearFilter);
    expect((resource.texture.image.data as Float32Array)[13]).toBeCloseTo(-0.5);
  });

  it('builds mesh-surface init and SDF collision graphs through resolvers', () => {
    const meshRef = { assetType: 'mesh', kind: 'asset-ref', uri: 'character.mesh' } as const;
    const sdfRef = { assetType: 'sdf', kind: 'asset-ref', uri: 'character.sdf' } as const;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    const meshResource = createThreeMeshSurfaceResource(
      new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()),
    );
    const sdfResource = createThreeSdfResource(
      bakeSdf({
        boundsMax: [1, 1, 1],
        boundsMin: [-1, -1, -1],
        resolution: [3, 3, 3],
        shapes: [{ center: [0, 0, 0], radius: 0.5, shape: 'sphere' }],
      }),
    );
    const adapter = createThreeKernelAdapter({
      resolveMeshSurface: createThreeMeshSurfaceResolver(new Map([[meshRef.uri, meshResource]])),
      resolveSdf: createThreeSdfResolver(new Map([[sdfRef.uri, sdfResource]])),
    });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        init: [
          positionMeshSurface({ mesh: meshRef, mode: 'surface' }),
          velocityMeshNormal({ speed: 1 }),
        ],
        integration: 'none',
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [collideSdf({ field: sdfRef, mode: 'bounce' })],
      }),
    );
    expect(() => program.buildKernels(adapter)).not.toThrow();
  });

  it('adapts an Object3D world transform for EffectInstance.attachTo', () => {
    const parent = new THREE.Object3D();
    const socket = new THREE.Object3D();
    parent.add(socket);
    parent.position.set(1, 2, 3);
    socket.position.set(0, 0.5, 0);
    const transform = createThreeTransformSource(socket).getWorldTransform();
    expect(transform.position).toEqual([1, 2.5, 3]);
    expect(transform.rotation).toHaveLength(4);
  });

  it('advertises scene-depth compute support only when an explicit depth copy is bound', () => {
    const texture = new THREE.DataTexture(new Float32Array([0.5, 0, 0, 1]), 1, 1);
    expect(createThreeKernelAdapter().capabilities.sceneDepth).toBe(false);
    expect(createThreeKernelAdapter({ sceneDepthTexture: texture }).capabilities.sceneDepth).toBe(
      true,
    );
  });

  it('derives scene-depth sample count from a render target and normalizes samples zero', () => {
    const multisampled = new THREE.RenderTarget(1, 1, { samples: 4 });
    const singleSampled = new THREE.RenderTarget(1, 1, { samples: 0 });

    expect(
      createThreeKernelAdapter({ sceneDepthTexture: multisampled.texture }).capabilities
        .sceneDepthSampleCount,
    ).toBe(4);
    expect(
      createThreeKernelAdapter({ sceneDepthTexture: singleSampled.texture }).capabilities
        .sceneDepthSampleCount,
    ).toBe(1);
  });

  it('builds collideSceneDepth against a sampleable previous-frame color texture', () => {
    const depth = new THREE.DataTexture(new Float32Array([0.5, 0, 0, 1]), 1, 1);
    depth.needsUpdate = true;
    const adapter = createThreeKernelAdapter({ sceneDepthTexture: depth });
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        integration: 'none',
        render: billboard({}),
        spawn: burst({ count: 1 }),
        update: [collideSceneDepth({ mode: 'stick' })],
      }),
    );
    expect(() => program.buildKernels(adapter)).not.toThrow();
  });

  it('exposes the bound previous-frame depth sampler to compute nodes', () => {
    const depth = new THREE.DataTexture(new Float32Array([0.25, 0, 0, 1]), 1, 1);
    const adapter = createThreeKernelAdapter({ sceneDepthTexture: depth });
    expect(adapter.sampleSceneDepth).toBeTypeOf('function');
    expect(() => adapter.sampleSceneDepth?.(adapter.vec2(0.5, 0.5))).not.toThrow();
  });

  it('materializes parsed FGA data as a bounds-aware Three.js 3D texture', () => {
    const parsed = parseFga('2 1 1 -1 -2 -3 1 2 3 1 2 3 -1 -2 -3');
    const resource = createThreeVectorFieldResource(parsed);
    const data = resource.texture.image.data as Float32Array;

    expect(resource.boundsMin).toEqual([-1, -2, -3]);
    expect(resource.boundsMax).toEqual([1, 2, 3]);
    expect(resource.texture.image).toMatchObject({ width: 2, height: 1, depth: 1 });
    expect(resource.texture.minFilter).toBe(THREE.NearestFilter);
    expect(resource.texture.magFilter).toBe(THREE.NearestFilter);
    expect(resource.texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(resource.texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(resource.texture.wrapR).toBe(THREE.RepeatWrapping);
    expect(resource.resolution).toEqual([2, 1, 1]);
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
    const indirect = kernels.drawIndirect!.indirectResource as THREE.IndirectStorageBufferAttribute;

    expect(mesh.isInstancedMesh).toBe(true);
    expect(mesh.geometry.getIndex()?.count).toBe(6);
    expect(mesh.geometry.getIndirect()).toBe(kernels.drawIndirect!.indirectResource);
    expect(words[offset]).toBe(6);
    expect(indirect.updateRanges).toEqual([{ count: 1, start: offset }]);
    expect(mesh.material.blending).toBe(2);
  });

  it('keeps unlit sprites on SpriteNodeMaterial and routes lit sprites through standard lighting', () => {
    const normalRef = { assetType: 'texture', kind: 'asset-ref', uri: 'normal' } as const;
    const normalMap = new THREE.DataTexture(new Uint8Array([255, 128, 255, 255]), 1, 1);
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.needsUpdate = true;
    const definition = (lit: boolean) =>
      defineEmitter({
        capacity: 1,
        render: billboard(
          lit ? { lit: { normalMap: normalRef, roughness: 0.7 } } : { blending: 'alpha' },
        ),
        spawn: burst({ count: 1 }),
      });
    const adapter = createThreeKernelAdapter();
    const unlitProgram = compileEmitter(definition(false));
    const litProgram = compileEmitter(definition(true));
    const unlit = materializeThreeSpriteDraw(unlitProgram, unlitProgram.buildKernels(adapter));
    const lit = materializeThreeSpriteDraw(litProgram, litProgram.buildKernels(adapter), 0, {
      resolveTexture: createThreeTextureResolver(new Map([[normalRef.uri, normalMap]])),
    });

    expect(unlit.material).toBeInstanceOf(THREE.SpriteNodeMaterial);
    expect(lit.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(lit.material.normalNode).not.toBeNull();
    expect((lit.material as THREE.MeshStandardNodeMaterial).lights).toBe(true);
    expect((lit.material as THREE.MeshStandardNodeMaterial).roughness).toBe(0.7);
  });

  it('rejects color-managed normal textures before building a lit sprite graph', () => {
    const normalRef = { assetType: 'texture', kind: 'asset-ref', uri: 'bad-normal' } as const;
    const normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    normalMap.colorSpace = THREE.SRGBColorSpace;
    const program = compileEmitter(
      defineEmitter({
        capacity: 1,
        render: billboard({ lit: { normalMap: normalRef } }),
        spawn: burst({ count: 1 }),
      }),
    );

    expect(() =>
      materializeThreeSpriteDraw(program, program.buildKernels(createThreeKernelAdapter()), 0, {
        resolveTexture: createThreeTextureResolver(new Map([[normalRef.uri, normalMap]])),
      }),
    ).toThrow(/NoColorSpace/);
  });

  it('binds opt-in sorted indirection instead of the compact alive array', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 5,
        init: [positionSphere({ radius: 1 }), lifetime(1)],
        integration: 'none',
        render: billboard({ blending: 'alpha', sorted: true }),
        spawn: burst({ count: 5 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const mesh = materializeThreeSpriteDraw(program, kernels);
    const graphBuffers = new Set<unknown>();
    const visit = (node: unknown) => {
      const candidate = node as { value?: unknown };
      if (candidate.value !== undefined) graphBuffers.add(candidate.value);
    };
    for (const root of [
      mesh.material.positionNode,
      mesh.material.scaleNode,
      mesh.material.rotationNode,
      mesh.material.colorNode,
      mesh.material.opacityNode,
    ]) {
      (root as { traverse(callback: (node: unknown) => void): void } | null)?.traverse(visit);
    }

    expect(kernels.sortPaddedCapacity).toBe(8);
    expect(kernels.sortedIndices).toBeDefined();
    expect(kernels.sortPasses).toHaveLength(6);
    expect(graphBuffers).toContain(kernels.sortedIndices!.value);
  });

  it('fully initializes indirect words before compute and uses partial updates afterward', async () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 4 }),
      }),
    );
    const adapter = createThreeKernelAdapter();
    const kernels = program.buildKernels(adapter);
    const indirect = kernels.drawIndirect!.indirectResource as THREE.IndirectStorageBufferAttribute;
    const initialWords = Array.from(indirect.array as Uint32Array);
    const uploads: { ranges: { count: number; start: number }[]; type: number; words: number[] }[] =
      [];
    const renderer = {
      _attributes: {
        update(attribute: THREE.IndirectStorageBufferAttribute, type: number) {
          uploads.push({
            ranges: attribute.updateRanges.map((range) => ({ ...range })),
            type,
            words: Array.from(attribute.array as Uint32Array),
          });
        },
      },
      compute() {},
      async computeAsync() {},
      async getArrayBufferAsync() {
        return new ArrayBuffer(0);
      },
    } as unknown as THREE.WebGPURenderer;
    const runtime = createThreeRuntimeRenderer(renderer, adapter);

    expect(indirect.version).toBe(1);
    expect(indirect.updateRanges).toEqual([]);
    expect(initialWords.every((word) => word === 0)).toBe(true);
    await runtime.submitCompute(kernels.initialize);
    expect(uploads).toEqual([{ ranges: [], type: 4, words: initialWords }]);

    materializeThreeSpriteDraw(program, kernels);
    const offset = kernels.drawIndirectOffsetBytes! / Uint32Array.BYTES_PER_ELEMENT;
    const drawRecord = Array.from((indirect.array as Uint32Array).slice(offset, offset + 5));
    expect(indirect.version).toBe(2);
    expect(indirect.updateRanges).toEqual([{ count: 1, start: offset }]);
    expect(drawRecord).toEqual([6, 0, 0, 0, 0]);
  });

  it('zeros the draw indirect instance count when kernels enter the effect pool', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 4 }),
      }),
    );
    const adapter = createThreeKernelAdapter();
    const kernels = program.buildKernels(adapter);
    const renderer = {
      async computeAsync() {},
      async getArrayBufferAsync() {
        return new ArrayBuffer(0);
      },
    } as unknown as THREE.WebGPURenderer;
    const runtime = createThreeRuntimeRenderer(renderer, adapter);
    const indirect = kernels.drawIndirect!.indirectResource as THREE.IndirectStorageBufferAttribute;
    const instanceCountOffset =
      kernels.drawIndirectOffsetBytes! / Uint32Array.BYTES_PER_ELEMENT + 1;
    (indirect.array as Uint32Array)[instanceCountOffset] = 4;

    runtime.prepareKernelsForPooling?.(kernels);

    expect((indirect.array as Uint32Array)[instanceCountOffset]).toBe(0);
    expect(indirect.updateRanges).toContainEqual({ count: 1, start: instanceCountOffset });
  });

  it('keeps the first materialize-to-render indirect record fully defined', () => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 2,
        render: billboard({}),
        spawn: burst({ count: 2 }),
      }),
    );
    const kernels = program.buildKernels(createThreeKernelAdapter());
    const indirect = kernels.drawIndirect!.indirectResource as THREE.IndirectStorageBufferAttribute;

    materializeThreeSpriteDraw(program, kernels);
    const offset = kernels.drawIndirectOffsetBytes! / Uint32Array.BYTES_PER_ELEMENT;
    expect(Array.from((indirect.array as Uint32Array).slice(offset, offset + 5))).toEqual([
      6, 0, 0, 0, 0,
    ]);
    // On first render, r185 createAttribute() copies this entire CPU array despite the range.
    expect(indirect.updateRanges).toEqual([{ count: 1, start: offset }]);
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
