import { DataTexture, RGBAFormat } from 'three';
import type Node from 'three/src/nodes/core/Node.js';
import { float } from 'three/tsl';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MeshFxDiagnosticError,
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
  slashArc,
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

describe('@nachi/mesh-fx fxMaterial', () => {
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
