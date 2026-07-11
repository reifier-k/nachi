import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, type Material } from 'three';

import { finite, integer, invalid, nonNegative, positive, unit } from './diagnostics';

export interface MeshFxElementMetadata {
  readonly kind: 'slashArc' | 'ring' | 'cylinder' | 'cone' | 'magicCircle';
  readonly version: 1;
}

export type MeshFxMesh = Mesh<BufferGeometry, Material> & {
  readonly userData: { nachiMeshFx: MeshFxElementMetadata } & Record<string, unknown>;
};

interface MaterialOption {
  readonly material?: Material;
}

export interface SlashArcOptions extends MaterialOption {
  /** Sweep angle in degrees. */
  readonly angle: number;
  readonly radius?: number;
  readonly innerRadius?: number;
  readonly segments?: number;
  /** Fraction of half-width removed at both tips. */
  readonly taper?: number;
  /** Center angle in degrees; zero points along +X. */
  readonly rotation?: number;
}

export function createSlashArcGeometry(options: SlashArcOptions): BufferGeometry {
  const angle = positive(options.angle, 'slashArc.angle');
  if (angle > 360) invalid('slashArc.angle', 'must be <= 360 degrees');
  const radius = positive(options.radius ?? 1, 'slashArc.radius');
  const innerRadius = nonNegative(options.innerRadius ?? radius * 0.55, 'slashArc.innerRadius');
  if (innerRadius >= radius) invalid('slashArc.innerRadius', 'must be smaller than radius');
  const segments = integer(options.segments ?? 32, 'slashArc.segments', 1);
  const taper = unit(options.taper ?? 0, 'slashArc.taper');
  const centerAngle = finite(options.rotation ?? 0, 'slashArc.rotation') * (Math.PI / 180);
  const sweep = angle * (Math.PI / 180);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const middle = (radius + innerRadius) * 0.5;
  const halfWidth = (radius - innerRadius) * 0.5;

  for (let column = 0; column <= segments; column += 1) {
    const u = column / segments;
    const theta = centerAngle + (u - 0.5) * sweep;
    const widthScale = 1 - taper * Math.abs(2 * u - 1);
    for (let row = 0; row < 2; row += 1) {
      const v = row;
      const radial = middle + (v * 2 - 1) * halfWidth * widthScale;
      positions.push(Math.cos(theta) * radial, Math.sin(theta) * radial, 0);
      normals.push(0, 0, 1);
      uvs.push(u, v);
    }
  }
  for (let column = 0; column < segments; column += 1) {
    const a = column * 2;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  return geometry(positions, normals, uvs, indices);
}

export function slashArc(options: SlashArcOptions): MeshFxMesh {
  return mesh('slashArc', createSlashArcGeometry(options), options.material);
}

export interface RingOptions extends MaterialOption {
  readonly innerRadius?: number;
  readonly outerRadius?: number;
  readonly segments?: number;
  readonly thetaStart?: number;
}

export function createRingGeometry(options: RingOptions = {}): BufferGeometry {
  const innerRadius = nonNegative(options.innerRadius ?? 0.5, 'ring.innerRadius');
  const outerRadius = positive(options.outerRadius ?? 1, 'ring.outerRadius');
  if (innerRadius >= outerRadius) invalid('ring.innerRadius', 'must be smaller than outerRadius');
  const segments = integer(options.segments ?? 48, 'ring.segments', 3);
  const thetaStart = finite(options.thetaStart ?? 0, 'ring.thetaStart');
  return annulusGeometry(innerRadius, outerRadius, segments, thetaStart);
}

export function ring(options: RingOptions = {}): MeshFxMesh {
  return mesh('ring', createRingGeometry(options), options.material);
}

export interface CylinderOptions extends MaterialOption {
  readonly radius?: number;
  readonly height?: number;
  readonly radialSegments?: number;
  readonly heightSegments?: number;
  readonly thetaStart?: number;
}

export function createCylinderGeometry(options: CylinderOptions = {}): BufferGeometry {
  const radius = positive(options.radius ?? 0.5, 'cylinder.radius');
  const height = positive(options.height ?? 1, 'cylinder.height');
  const radialSegments = integer(options.radialSegments ?? 32, 'cylinder.radialSegments', 3);
  const heightSegments = integer(options.heightSegments ?? 1, 'cylinder.heightSegments', 1);
  const thetaStart = finite(options.thetaStart ?? 0, 'cylinder.thetaStart');
  return lateralGeometry(radius, radius, height, radialSegments, heightSegments, thetaStart, false);
}

export function cylinder(options: CylinderOptions = {}): MeshFxMesh {
  return mesh('cylinder', createCylinderGeometry(options), options.material);
}

export interface ConeOptions extends MaterialOption {
  readonly radius?: number;
  readonly height?: number;
  readonly radialSegments?: number;
  readonly heightSegments?: number;
  readonly thetaStart?: number;
}

export function createConeGeometry(options: ConeOptions = {}): BufferGeometry {
  const radius = positive(options.radius ?? 0.75, 'cone.radius');
  const height = positive(options.height ?? 1, 'cone.height');
  const radialSegments = integer(options.radialSegments ?? 32, 'cone.radialSegments', 3);
  const heightSegments = integer(options.heightSegments ?? 1, 'cone.heightSegments', 1);
  const thetaStart = finite(options.thetaStart ?? 0, 'cone.thetaStart');
  return lateralGeometry(radius, 0, height, radialSegments, heightSegments, thetaStart, true);
}

export function cone(options: ConeOptions = {}): MeshFxMesh {
  return mesh('cone', createConeGeometry(options), options.material);
}

export interface MagicCircleOptions extends MaterialOption {
  readonly radius?: number;
  readonly rings?: number;
  readonly segments?: number;
  readonly thetaStart?: number;
}

export function createMagicCircleGeometry(options: MagicCircleOptions = {}): BufferGeometry {
  const radius = positive(options.radius ?? 1, 'magicCircle.radius');
  const rings = integer(options.rings ?? 4, 'magicCircle.rings', 1);
  const segments = integer(options.segments ?? 64, 'magicCircle.segments', 3);
  const thetaStart = finite(options.thetaStart ?? 0, 'magicCircle.thetaStart');
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uv1: number[] = [];
  const indices: number[] = [];

  // Each radial band duplicates both boundaries. This creates stable concentric UV1 islands and
  // permits future per-band material groups without changing primary polarUV-compatible UVs.
  for (let band = 0; band < rings; band += 1) {
    const inner = (band / rings) * radius;
    const outer = ((band + 1) / rings) * radius;
    const base = positions.length / 3;
    for (let column = 0; column <= segments; column += 1) {
      const u = column / segments;
      const theta = thetaStart + u * Math.PI * 2;
      for (let row = 0; row < 2; row += 1) {
        const radial = row === 0 ? inner : outer;
        const x = Math.cos(theta) * radial;
        const y = Math.sin(theta) * radial;
        positions.push(x, y, 0);
        normals.push(0, 0, 1);
        uvs.push(x / (2 * radius) + 0.5, y / (2 * radius) + 0.5);
        uv1.push(u, row);
      }
    }
    for (let column = 0; column < segments; column += 1) {
      const a = base + column * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const result = geometry(positions, normals, uvs, indices);
  result.setAttribute('uv1', new BufferAttribute(new Float32Array(uv1), 2));
  return result;
}

export function magicCircle(options: MagicCircleOptions = {}): MeshFxMesh {
  return mesh('magicCircle', createMagicCircleGeometry(options), options.material);
}

function annulusGeometry(
  innerRadius: number,
  outerRadius: number,
  segments: number,
  thetaStart: number,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let column = 0; column <= segments; column += 1) {
    const u = column / segments;
    const theta = thetaStart + u * Math.PI * 2;
    for (let row = 0; row < 2; row += 1) {
      const radial = row === 0 ? innerRadius : outerRadius;
      positions.push(Math.cos(theta) * radial, Math.sin(theta) * radial, 0);
      normals.push(0, 0, 1);
      uvs.push(u, row);
    }
  }
  for (let column = 0; column < segments; column += 1) {
    const a = column * 2;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  return geometry(positions, normals, uvs, indices);
}

function lateralGeometry(
  bottomRadius: number,
  topRadius: number,
  height: number,
  radialSegments: number,
  heightSegments: number,
  thetaStart: number,
  coneNormals: boolean,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const slope = coneNormals ? bottomRadius / height : 0;
  const normalLength = Math.hypot(1, slope);
  for (let row = 0; row <= heightSegments; row += 1) {
    const v = row / heightSegments;
    const radius = bottomRadius + (topRadius - bottomRadius) * v;
    const y = (v - 0.5) * height;
    for (let column = 0; column <= radialSegments; column += 1) {
      const u = column / radialSegments;
      const theta = thetaStart + u * Math.PI * 2;
      const cosine = Math.cos(theta);
      const sine = Math.sin(theta);
      positions.push(cosine * radius, y, sine * radius);
      normals.push(cosine / normalLength, slope / normalLength, sine / normalLength);
      uvs.push(u, v);
    }
  }
  const stride = radialSegments + 1;
  for (let row = 0; row < heightSegments; row += 1) {
    for (let column = 0; column < radialSegments; column += 1) {
      const a = row * stride + column;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return geometry(positions, normals, uvs, indices);
}

function geometry(
  positions: readonly number[],
  normals: readonly number[],
  uvs: readonly number[],
  indices: readonly number[],
): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  result.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  result.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  result.setIndex([...indices]);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function mesh(
  kind: MeshFxElementMetadata['kind'],
  geometry: BufferGeometry,
  suppliedMaterial: Material | undefined,
): MeshFxMesh {
  const result = new Mesh(geometry, suppliedMaterial ?? new MeshBasicMaterial({ color: 0xffffff }));
  result.name = `nachi:${kind}`;
  result.userData.nachiMeshFx = { kind, version: 1 } satisfies MeshFxElementMetadata;
  return result as MeshFxMesh;
}
