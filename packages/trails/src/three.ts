import type {
  BuiltEmitterKernels,
  CompiledEmitterProgram,
  KernelStorageNode,
  TextureRef,
  TslStorageType,
} from '@nachi/core';
import { resolvePackedAttributeAddress } from '@nachi/core';
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicLoad,
  cameraPosition,
  cross,
  distance,
  float,
  instancedArray,
  length,
  max,
  min,
  mod,
  select,
  storage,
  texture,
  uint,
  uvec4,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} from 'three/tsl';

import type { CompiledRibbonDrawDescription } from './index.js';

type NodeLike = {
  readonly a: NodeLike;
  readonly w: NodeLike;
  readonly x: NodeLike;
  readonly xyz: NodeLike;
  readonly y: NodeLike;
  readonly z: NodeLike;
  addAssign(value: unknown): NodeLike;
  add(value: unknown): NodeLike;
  and(value: unknown): NodeLike;
  assign(value: unknown): NodeLike;
  clamp(minimum: unknown, maximum: unknown): NodeLike;
  div(value: unknown): NodeLike;
  equal(value: unknown): NodeLike;
  greaterThanEqual(value: unknown): NodeLike;
  mul(value: unknown): NodeLike;
  sub(value: unknown): NodeLike;
  toVar(): NodeLike;
};

function node(value: unknown): NodeLike {
  return value as NodeLike;
}

function readOnly(
  storageNode: KernelStorageNode,
  type: TslStorageType,
  length: number,
): KernelStorageNode {
  return (
    storage(storageNode.value as never, type as never, length) as unknown as {
      toReadOnly(): KernelStorageNode;
    }
  ).toReadOnly();
}

function particleBindings(program: CompiledEmitterProgram, kernels: BuiltEmitterKernels) {
  const storages = program.attributeSchema.storageArrays.map((description) => {
    const computeStorage = kernels.storages[description.name];
    if (!computeStorage) throw new Error(`Particle storage "${description.name}" is missing.`);
    return readOnly(computeStorage, description.type, description.length);
  });
  const logical = (name: string, physicalIndex: NodeLike): NodeLike => {
    const attribute = program.attributeSchema.byName[name];
    if (!attribute) throw new Error(`Particle attribute "${name}" is missing.`);
    const description = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
    const storageNode = description && storages[description.index];
    if (!description || !storageNode) throw new Error(`Particle storage for "${name}" is missing.`);
    const address = description.packed
      ? resolvePackedAttributeAddress(attribute, description)
      : undefined;
    const index = address
      ? physicalIndex.mul(uint(address.particleStride)).add(uint(address.group))
      : physicalIndex;
    const element = node(storageNode.element(index as never));
    if (!address) return element;
    const lanes = [element.x, element.y, element.z, element.w].slice(
      address.offset,
      address.offset + attribute.components,
    );
    if (attribute.components === 1) return lanes[0]!;
    if (attribute.components === 2) return node(vec2(lanes[0] as never, lanes[1] as never));
    if (attribute.components === 3) {
      return node(vec4(lanes[0] as never, lanes[1] as never, lanes[2] as never, 0)).xyz;
    }
    if (attribute.components === 4) {
      return node(vec4(lanes[0] as never, lanes[1] as never, lanes[2] as never, lanes[3] as never));
    }
    throw new Error(`Unsupported packed width for particle attribute "${name}".`);
  };
  return logical;
}

function blendState(blending: CompiledRibbonDrawDescription['fragment']['blending']) {
  if (blending === 'additive') {
    return { blending: THREE.AdditiveBlending, premultipliedAlpha: false };
  }
  if (blending === 'multiply') {
    return { blending: THREE.MultiplyBlending, premultipliedAlpha: true };
  }
  return {
    blending: THREE.NormalBlending,
    premultipliedAlpha: blending === 'premultiplied',
  };
}

export interface ThreeRibbonMaterializationOptions {
  readonly resolveTexture?: (reference: TextureRef) => THREE.Texture | undefined;
}

export interface ThreeRibbonDraw {
  readonly indirect: THREE.IndirectStorageBufferAttribute;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  readonly prepareKernel: unknown;
  readonly segmentIndices: KernelStorageNode;
  readonly segmentValues: KernelStorageNode;
  readonly segmentWidths: KernelStorageNode;
  prepare(renderer: THREE.WebGPURenderer): Promise<void>;
}

/**
 * Materializes the @nachi/trails WebGPU path. Preparation is a GPU-only sequential birth-ring
 * scan; callers submit `prepare()` after simulation compaction and before drawing.
 */
export function materializeThreeRibbonDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeRibbonMaterializationOptions = {},
): ThreeRibbonDraw {
  const draw = program.draws[drawIndex];
  if (!draw || draw.kind !== 'ribbon') {
    throw new Error(`Compiled ribbon draw ${drawIndex} is missing.`);
  }
  if (kernels.capabilityPath !== 'webgpu-atomic-indirect') {
    throw new Error(
      'NACHI_RIBBON_WEBGL2_UNSUPPORTED: Ribbon preparation requires WebGPU storage, atomics, and indirect draw.',
    );
  }
  const capacity = program.attributeSchema.capacity;
  const maxSegments = draw.geometry.maxSegments;
  const logical = particleBindings(program, kernels);
  const segmentIndices = instancedArray(Math.max(1, maxSegments), 'uvec4').setName(
    'NachiRibbonSegmentIndices',
  ) as unknown as KernelStorageNode;
  const segmentValues = instancedArray(Math.max(1, maxSegments), 'vec4').setName(
    'NachiRibbonSegmentUvT',
  ) as unknown as KernelStorageNode;
  const segmentWidths = instancedArray(Math.max(1, maxSegments), 'vec4').setName(
    'NachiRibbonSegmentWidths',
  ) as unknown as KernelStorageNode;
  const indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 0, 0, 0]), 1);
  const indirectNode = storage(indirect, 'uint', 5).setName('NachiRibbonDrawIndirect');
  const lifecycle = kernels.birthIndices;
  const nextSpawnOrder = () =>
    node(atomicLoad(lifecycle.element(uint(kernels.nextSpawnOrderOffset) as never) as never));
  const birthIndex = (slot: NodeLike) =>
    node(
      atomicLoad(lifecycle.element(slot.add(uint(kernels.birthIndicesOffset)) as never) as never),
    );
  const validPoint = (physical: NodeLike, order: NodeLike, ribbon: number) =>
    logical('alive', physical)
      .equal(uint(1))
      .and(logical('spawnOrder', physical).equal(order))
      .and(logical('ribbonId', physical).equal(uint(ribbon)));
  const taperWidth = (input: NodeLike): NodeLike => {
    const t = node(input);
    let scale = node(float(1));
    if (draw.vertex.taper.start > 0) {
      scale = node(min(scale as never, t.div(draw.vertex.taper.start).clamp(0, 1) as never));
    }
    if (draw.vertex.taper.end > 0) {
      scale = node(
        min(scale as never, node(float(1)).sub(t).div(draw.vertex.taper.end).clamp(0, 1) as never),
      );
    }
    return node(scale.mul(draw.vertex.width));
  };

  const prepareKernel = Fn(() => {
    const segmentCount = node(uint(0).toVar());
    const nextOrder = nextSpawnOrder().toVar();
    const earliestOrder = node(
      select(
        nextOrder.greaterThanEqual(uint(capacity)) as never,
        nextOrder.sub(uint(capacity)) as never,
        uint(0),
      ),
    ).toVar();

    for (let ribbon = 0; ribbon < draw.vertex.maxRibbons; ribbon += 1) {
      const pointCount = node(uint(0).toVar());
      Loop({ condition: '<', end: uint(capacity), start: uint(0), type: 'uint' }, ({ i }) => {
        const loopIndex = node(i);
        const order = earliestOrder.add(loopIndex);
        const slot = node(mod(order as never, uint(capacity)));
        const physical = birthIndex(slot);
        If(validPoint(physical, order, ribbon) as never, () => {
          pointCount.addAssign(uint(1));
        });
      });

      const hasPrevious = node(uint(0).toVar());
      const previousIndex = node(uint(0).toVar());
      const pointOrdinal = node(uint(0).toVar());
      const cumulativeDistance = node(float(0).toVar());
      const previousU = node(float(0).toVar());
      Loop({ condition: '<', end: uint(capacity), start: uint(0), type: 'uint' }, ({ i }) => {
        const order = earliestOrder.add(node(i));
        const slot = node(mod(order as never, uint(capacity)));
        const physical = birthIndex(slot);
        If(validPoint(physical, order, ribbon) as never, () => {
          If(hasPrevious.equal(uint(0)) as never, () => {
            previousIndex.assign(physical);
            hasPrevious.assign(uint(1));
          }).Else(() => {
            const nextOrdinal = pointOrdinal.add(uint(1));
            const denominator = node(float(pointCount.sub(uint(1)) as never));
            const t0 = node(float(pointOrdinal as never)).div(denominator);
            const t1 = node(float(nextOrdinal as never)).div(denominator);
            const nextDistance = cumulativeDistance.add(
              node(
                distance(
                  logical('position', previousIndex) as never,
                  logical('position', physical) as never,
                ),
              ),
            );
            const u1 = draw.uv.mode === 'tiled' ? nextDistance.div(draw.uv.tileLength) : t1;
            segmentIndices
              .element(segmentCount as never)
              .assign(
                uvec4(previousIndex as never, physical as never, uint(ribbon), uint(0)) as never,
              );
            segmentValues
              .element(segmentCount as never)
              .assign(vec4(previousU as never, u1 as never, t0 as never, t1 as never) as never);
            segmentWidths
              .element(segmentCount as never)
              .assign(
                vec4(taperWidth(t0) as never, taperWidth(t1) as never, float(0), float(0)) as never,
              );
            segmentCount.addAssign(uint(1));
            previousIndex.assign(physical);
            pointOrdinal.assign(nextOrdinal);
            cumulativeDistance.assign(nextDistance);
            previousU.assign(u1);
          });
        });
      });
    }
    indirectNode.element(uint(0)).assign(segmentCount.mul(uint(6)) as never);
    indirectNode.element(uint(1)).assign(uint(1));
    indirectNode.element(uint(2)).assign(uint(0));
    indirectNode.element(uint(3)).assign(uint(0));
    indirectNode.element(uint(4)).assign(uint(0));
  })()
    .compute(1, [1])
    .setName('NachiRibbonPrepare');

  const positions = new Float32Array(Math.max(1, maxSegments * 4) * 3);
  const indices: number[] = [];
  for (let segment = 0; segment < maxSegments; segment += 1) {
    const base = segment * 4;
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setIndirect(indirect);

  const indexRead = readOnly(segmentIndices, 'uvec4', Math.max(1, maxSegments));
  const valueRead = readOnly(segmentValues, 'vec4', Math.max(1, maxSegments));
  const widthRead = readOnly(segmentWidths, 'vec4', Math.max(1, maxSegments));
  const segment = node(uint(vertexIndex)).div(uint(4));
  const corner = node(mod(uint(vertexIndex), uint(4)));
  const record = node(indexRead.element(segment as never));
  const values = node(valueRead.element(segment as never));
  const widths = node(widthRead.element(segment as never));
  const useEnd = corner.greaterThanEqual(uint(2));
  const useRight = node(mod(corner as never, uint(2))).equal(uint(1));
  const pointIndex = node(select(useEnd as never, record.y as never, record.x as never));
  const p0 = logical('position', record.x);
  const p1 = logical('position', record.y);
  const center = node(select(useEnd as never, p1 as never, p0 as never));
  const epsilon = node(float(1e-6));
  const segmentDelta = p1.sub(p0);
  const segmentLength = node(length(segmentDelta as never));
  const tangent = segmentDelta.div(node(max(segmentLength as never, epsilon as never)));
  const midpoint = p0.add(p1).mul(0.5);
  const rawSide = node(cross(tangent as never, node(cameraPosition).sub(midpoint) as never));
  const sideLength = node(length(rawSide as never));
  const normalizedSide = rawSide.div(node(max(sideLength as never, epsilon as never)));
  const side = node(
    select(sideLength.greaterThanEqual(epsilon) as never, normalizedSide as never, vec3(1, 0, 0)),
  );
  const signedWidth = node(select(useEnd as never, widths.y as never, widths.x as never))
    .mul(0.5)
    .mul(node(select(useRight as never, float(1), float(-1))));
  const ribbonUv = node(
    vec2(
      select(useEnd as never, values.y as never, values.x as never) as never,
      select(useRight as never, float(1), float(0)) as never,
    ),
  );
  const particleColor = logical('color', pointIndex);
  let fragmentColor = node(varying(particleColor as never));
  if (draw.fragment.map) {
    const map = options.resolveTexture?.(draw.fragment.map);
    if (!map) {
      throw new Error(`No texture resolver supplied for ribbon map "${draw.fragment.map.uri}".`);
    }
    const fragmentUv = node(varying(ribbonUv as never));
    fragmentColor = node(fragmentColor.mul(node(texture(map, fragmentUv as never))));
  }
  const blend = blendState(draw.fragment.blending);
  const material = new THREE.MeshBasicNodeMaterial({
    blending: blend.blending,
    depthTest: true,
    depthWrite: false,
    premultipliedAlpha: blend.premultipliedAlpha,
    transparent: true,
  });
  material.positionNode = center.add(side.mul(signedWidth)) as never;
  material.colorNode = fragmentColor.xyz as never;
  material.opacityNode = fragmentColor.a.mul(node(kernels.uniforms['System.visibility']!)) as never;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  return {
    indirect,
    mesh,
    prepare: async (renderer) => renderer.computeAsync(prepareKernel as never),
    prepareKernel,
    segmentIndices,
    segmentValues,
    segmentWidths,
  };
}

export async function readRibbonSegments(
  renderer: THREE.WebGPURenderer,
  draw: ThreeRibbonDraw,
): Promise<{
  readonly indices: Uint32Array;
  readonly segmentCount: number;
  readonly uvAndParametric: Float32Array;
  readonly widths: Float32Array;
}> {
  const [indirect, indices, values, widths] = await Promise.all([
    renderer.getArrayBufferAsync(draw.indirect as never),
    renderer.getArrayBufferAsync(draw.segmentIndices.value as never),
    renderer.getArrayBufferAsync(draw.segmentValues.value as never),
    renderer.getArrayBufferAsync(draw.segmentWidths.value as never),
  ]);
  const indirectWords = new Uint32Array(indirect);
  return {
    indices: new Uint32Array(indices),
    segmentCount: Math.floor((indirectWords[0] ?? 0) / 6),
    uvAndParametric: new Float32Array(values),
    widths: new Float32Array(widths),
  };
}
