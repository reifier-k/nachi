import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  NoColorSpace,
  RGBAFormat,
} from 'three';
import type Node from 'three/src/nodes/core/Node.js';
import { float } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MeshFxDiagnosticError,
  applyVat,
  cone,
  createConeGeometry,
  createCylinderGeometry,
  createMagicCircleGeometry,
  createRingGeometry,
  createSlashArcGeometry,
  cylinder,
  fxMaterial,
  magicCircle,
  polarUV,
  ring,
  resolveVatFrames,
  slashArc,
  uvFlow,
} from '../src';

function texture(): DataTexture {
  const result = new DataTexture(
    new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]),
    2,
    1,
    RGBAFormat,
  );
  result.needsUpdate = true;
  return result;
}

function expectCounts(
  geometry: ReturnType<typeof createRingGeometry>,
  vertices: number,
  indices: number,
): void {
  expect(geometry.getAttribute('position').count).toBe(vertices);
  expect(geometry.getAttribute('normal').count).toBe(vertices);
  expect(geometry.getAttribute('uv').count).toBe(vertices);
  expect(geometry.index?.count).toBe(indices);
}

describe('@nachi/mesh-fx analytic geometry', () => {
  it('builds a tapered slash arc with arc/radius UVs and +Z normals', () => {
    const geometry = createSlashArcGeometry({
      angle: 90,
      radius: 2,
      innerRadius: 1,
      segments: 2,
      taper: 0.5,
    });
    expectCounts(geometry, 6, 12);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    expect(position.getX(0)).toBeCloseTo(1.25 / Math.sqrt(2), 6);
    expect(position.getY(0)).toBeCloseTo(-1.25 / Math.sqrt(2), 6);
    expect(position.getX(2)).toBeCloseTo(1, 6);
    expect(position.getY(2)).toBeCloseTo(0, 6);
    expect(position.getX(3)).toBeCloseTo(2, 6);
    expect(uv.getX(2)).toBeCloseTo(0.5, 7);
    expect(uv.getY(2)).toBe(0);
    expect(normal.getZ(5)).toBe(1);
    const index = geometry.index!;
    const a = index.getX(0);
    const b = index.getX(1);
    const c = index.getX(2);
    const crossZ =
      (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
      (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a));
    expect(crossZ).toBeGreaterThan(0);
  });

  it('builds a ring with a duplicated seam and angle/radius UVs', () => {
    const geometry = createRingGeometry({ innerRadius: 0.5, outerRadius: 1, segments: 4 });
    expectCounts(geometry, 10, 24);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    expect([position.getX(0), position.getY(0)]).toEqual([0.5, 0]);
    expect([position.getX(1), position.getY(1)]).toEqual([1, 0]);
    expect(position.getX(8)).toBeCloseTo(0.5, 7);
    expect(position.getY(8)).toBeCloseTo(0, 7);
    expect([uv.getX(8), uv.getY(8)]).toEqual([1, 0]);
  });

  it('builds an uncapped cylinder with circumference/height UVs', () => {
    const geometry = createCylinderGeometry({
      radius: 0.5,
      height: 2,
      radialSegments: 4,
      heightSegments: 2,
    });
    expectCounts(geometry, 15, 48);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([0.5, -1, 0]);
    expect([normal.getX(0), normal.getY(0), normal.getZ(0)]).toEqual([1, 0, 0]);
    expect([uv.getX(14), uv.getY(14)]).toEqual([1, 1]);
  });

  it('builds an open cone with analytic slope normals', () => {
    const geometry = createConeGeometry({
      radius: 1,
      height: 2,
      radialSegments: 4,
      heightSegments: 1,
    });
    expectCounts(geometry, 10, 24);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    expect([position.getX(5), position.getY(5), position.getZ(5)]).toEqual([0, 1, 0]);
    expect(normal.getX(0)).toBeCloseTo(2 / Math.sqrt(5), 6);
    expect(normal.getY(0)).toBeCloseTo(1 / Math.sqrt(5), 6);
    expect(Math.hypot(normal.getX(0), normal.getY(0), normal.getZ(0))).toBeCloseTo(1, 6);
  });

  it('splits a magic circle into concentric uv1 islands while primary UV stays Cartesian', () => {
    const geometry = createMagicCircleGeometry({ radius: 2, rings: 2, segments: 4 });
    expectCounts(geometry, 20, 48);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const uv1 = geometry.getAttribute('uv1');
    expect(uv1.count).toBe(20);
    expect([position.getX(11), position.getY(11)]).toEqual([2, 0]);
    expect([uv.getX(11), uv.getY(11)]).toEqual([1, 0.5]);
    expect([uv1.getX(10), uv1.getY(10), uv1.getX(11), uv1.getY(11)]).toEqual([0, 0, 0, 1]);
  });

  it('returns self-describing Three meshes suitable for effect element adaptation', () => {
    const meshes = [slashArc({ angle: 120 }), ring(), cylinder(), cone(), magicCircle()];
    expect(meshes.map((mesh) => mesh.userData.nachiMeshFx.kind)).toEqual([
      'slashArc',
      'ring',
      'cylinder',
      'cone',
      'magicCircle',
    ]);
    expect(meshes.every((mesh) => mesh.isMesh && mesh.userData.nachiMeshFx.version === 1)).toBe(
      true,
    );
  });
});

describe('@nachi/mesh-fx Blender VAT runtime', () => {
  function vatTexture(width = 3, height = 4): DataTexture {
    const result = new DataTexture(
      new Float32Array(width * height * 4),
      width,
      height,
      RGBAFormat,
      FloatType,
    );
    result.colorSpace = NoColorSpace;
    result.needsUpdate = true;
    return result;
  }

  function vatMesh(width = 3): THREE.Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(width * 3), 3));
    geometry.setAttribute(
      'uv1',
      new BufferAttribute(
        new Float32Array(
          Array.from({ length: width }, (_, index) => [(index + 0.5) / width, 0]).flat(),
        ),
        2,
      ),
    );
    return new THREE.Mesh(geometry, new THREE.MeshStandardNodeMaterial());
  }

  it('resolves nearest and linear frame playback over an inclusive looping range', () => {
    expect(
      resolveVatFrames(0.125, {
        fps: 4,
        frameCount: 4,
        interpolation: 'linear',
        loop: true,
      }),
    ).toEqual({ frame0: 0, frame1: 1, mix: 0.5 });
    expect(
      resolveVatFrames(0.875, {
        fps: 4,
        frameCount: 4,
        interpolation: 'linear',
        loop: true,
      }),
    ).toEqual({ frame0: 3, frame1: 0, mix: 0.5 });
    expect(
      resolveVatFrames(0.125, {
        fps: 4,
        frameCount: 4,
        interpolation: 'nearest',
        loop: true,
      }),
    ).toEqual({ frame0: 1, frame1: 1, mix: 0 });
  });

  it('diagnoses unsupported interpolation in the standalone frame resolver', () => {
    expect(() =>
      resolveVatFrames(0, {
        fps: 4,
        frameCount: 4,
        interpolation: 'cubic' as never,
      }),
    ).toThrow(MeshFxDiagnosticError);
    try {
      resolveVatFrames(0, {
        fps: 4,
        frameCount: 4,
        interpolation: 'cubic' as never,
      });
    } catch (error) {
      expect((error as MeshFxDiagnosticError).diagnostic).toMatchObject({
        code: 'NACHI_MESH_FX_INVALID_PARAMETER',
        path: 'resolveVatFrames.interpolation',
      });
    }
  });

  it('applies position and normal VAT nodes with package-owned or external clocks', () => {
    const mesh = vatMesh();
    const controls = applyVat(mesh, {
      fps: 8,
      frameCount: 4,
      normalTexture: vatTexture(),
      positionTexture: vatTexture(),
    });
    expect((mesh.material as THREE.MeshStandardNodeMaterial).positionNode?.isNode).toBe(true);
    expect((mesh.material as THREE.MeshStandardNodeMaterial).normalNode?.isNode).toBe(true);
    expect(mesh.frustumCulled).toBe(false);
    controls.setFrame(2.5);
    expect(controls.time?.value).toBe(2.5 / 8);

    const external = applyVat(vatMesh(), {
      axisMap: 'xz-y',
      fps: 8,
      frameCount: 4,
      positionTexture: vatTexture(),
      time: float(0.25),
    });
    expect(external.time).toBeNull();
    expect(() => external.setTime(0.5)).toThrow(MeshFxDiagnosticError);
  });

  it('keeps controls.sampleAtTime aligned with an inclusive frameRange', () => {
    const controls = applyVat(vatMesh(), {
      fps: 1,
      frameCount: 10,
      frameRange: [2, 5],
      positionTexture: vatTexture(3, 10),
    });

    expect(controls.sampleAtTime(0)).toEqual({ frame0: 2, frame1: 3, mix: 0 });
    expect(controls.sampleAtTime(3.5)).toEqual({ frame0: 5, frame1: 2, mix: 0.5 });
    expect(controls.sampleAtTime(4)).toEqual({ frame0: 2, frame1: 3, mix: 0 });
  });

  it('requires Blender vertex_anim uv1 by default and allows an explicit raw vertex-index fallback', () => {
    const mesh = vatMesh();
    mesh.geometry.deleteAttribute('uv1');
    expect(() => applyVat(mesh, { fps: 8, frameCount: 4, positionTexture: vatTexture() })).toThrow(
      MeshFxDiagnosticError,
    );
    const controls = applyVat(mesh, {
      fps: 8,
      frameCount: 4,
      positionTexture: vatTexture(),
      vertexLookup: 'vertex-index',
    });
    expect(controls.frameCount).toBe(4);
  });

  it('diagnoses missing textures, layout/count mismatch, float format, and frame overflow', () => {
    const cases = [
      () =>
        applyVat(vatMesh(), {
          fps: 24,
          frameCount: 4,
          positionTexture: undefined as never,
        }),
      () => applyVat(vatMesh(2), { fps: 24, frameCount: 4, positionTexture: vatTexture(3, 4) }),
      () => applyVat(vatMesh(), { fps: 24, frameCount: 4, positionTexture: vatTexture(3, 3) }),
      () => applyVat(vatMesh(), { fps: 24, frameCount: 4, positionTexture: texture() }),
      () =>
        applyVat(vatMesh(), {
          fps: 24,
          frameCount: 4,
          frameRange: [1, 4],
          positionTexture: vatTexture(),
        }),
      () => {
        const controls = applyVat(vatMesh(), {
          fps: 4,
          frameCount: 4,
          loop: false,
          positionTexture: vatTexture(),
        });
        controls.setTime(1);
      },
    ];
    for (const build of cases) expect(build).toThrow(MeshFxDiagnosticError);
  });
});

describe('@nachi/mesh-fx fxMaterial', () => {
  it('deep-freezes fluent UV authoring arrays and tuple inputs', () => {
    const center: [number, number] = [0.25, 0.75];
    const speed: [number, number] = [0.3, -0.1];
    const authoring = polarUV({ center }).flow({ speed });
    const cartesianSpeed: [number, number] = [0, -2];
    const cartesian = uvFlow({ speed: cartesianSpeed });

    expect(Object.isFrozen(authoring)).toBe(true);
    expect(Object.isFrozen(authoring.center)).toBe(true);
    expect(Object.isFrozen(authoring.flows)).toBe(true);
    expect(Object.isFrozen(authoring.flows[0])).toBe(true);
    expect(Object.isFrozen(authoring.flows[0]?.speed)).toBe(true);
    expect(Object.isFrozen(cartesian.speed)).toBe(true);
    expect(() => ((authoring.center as unknown as number[])[0] = 1)).toThrow(TypeError);
    expect(() => (authoring.flows as unknown[]).push({ speed: [1, 1] })).toThrow(TypeError);
    expect(() => ((authoring.flows[0]!.speed as unknown as number[])[0] = 1)).toThrow(TypeError);
    expect(() => ((cartesian.speed as unknown as number[])[1] = 1)).toThrow(TypeError);

    center[0] = 0.9;
    speed[0] = 0.9;
    cartesianSpeed[1] = 0.9;
    expect(authoring.center).toEqual([0.25, 0.75]);
    expect(authoring.flows[0]!.speed).toEqual([0.3, -0.1]);
    expect(cartesian.speed).toEqual([0, -2]);
  });

  it('lowers polar flow, dissolve curve, and Fresnel to one NodeMaterial graph', () => {
    const material = fxMaterial({
      color: '#102040',
      uv: polarUV({ rotation: Math.PI / 7 }).flow({ speed: [0.3, -0.1] }),
      dissolve: {
        texture: texture(),
        overLife: [
          [0, 0.1],
          [0.4, 0.2],
          [1, 0.9],
        ],
        edgeColor: '#ff8040',
      },
      fresnel: { color: '#66ddff', power: 2 },
      blending: 'additive',
    });
    expect(material.isNodeMaterial).toBe(true);
    expect(material.colorNode?.isNode).toBe(true);
    expect(material.opacityNode?.isNode).toBe(true);
    expectTypeOf(material.colorNode).toMatchTypeOf<Node | null>();
    let graphSize = 0;
    material.colorNode?.traverse(() => {
      graphSize += 1;
    });
    expect(graphSize).toBeGreaterThan(20);
    material.fx.setTime(2);
    material.fx.setNormalizedLife(0.65);
    expect(material.fx.time?.value).toBe(2);
    expect(material.fx.normalizedLife?.value).toBe(0.65);
  });

  it('accepts externally bound effect time and rejects standalone mutation', () => {
    const material = fxMaterial({ time: float(1), normalizedLife: float(0.5) });
    expect(material.fx.time).toBeNull();
    expect(material.fx.normalizedLife).toBeNull();
    expect(() => material.fx.setTime(2)).toThrow(MeshFxDiagnosticError);
    expect(() => material.fx.setNormalizedLife(0.4)).toThrow(MeshFxDiagnosticError);
  });

  it('lowers Cartesian UV flow for cylinder-style longitudinal animation', () => {
    const material = fxMaterial({ map: texture(), time: 0.5, uv: uvFlow({ speed: [0, -2] }) });
    let graphSize = 0;
    material.colorNode?.traverse(() => {
      graphSize += 1;
    });
    expect(graphSize).toBeGreaterThan(8);
  });

  it('reports stable synchronous diagnostics for invalid authoring data', () => {
    const invalidCases = [
      () => createSlashArcGeometry({ angle: 0 }),
      () => createRingGeometry({ innerRadius: 1, outerRadius: 1 }),
      () => createCylinderGeometry({ radialSegments: 2 }),
      () => createConeGeometry({ height: Number.NaN }),
      () => createMagicCircleGeometry({ rings: 0 }),
      () => polarUV().flow({ speed: [Number.NaN, 0] }),
      () => fxMaterial({ blending: 'screen' as never }),
      () => fxMaterial({ time: Number.NaN }),
      () => fxMaterial({ normalizedLife: 1.1 }),
      () =>
        fxMaterial({
          dissolve: {
            texture: {} as DataTexture,
            overLife: [
              [0, 0],
              [1, 1],
            ],
          },
        }),
      () =>
        fxMaterial({
          dissolve: {
            texture: texture(),
            overLife: [
              [0, 0],
              [0.5, 1],
            ],
          },
        }),
      () => fxMaterial({ fresnel: { power: 0 } }),
    ];
    for (const build of invalidCases) expect(build).toThrow(MeshFxDiagnosticError);
  });
});
