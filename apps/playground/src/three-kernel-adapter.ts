import type {
  BakedLut,
  BuiltEmitterKernels,
  CompiledDrawIndirectDescription,
  CompiledEmitterProgram,
  EffectInstanceState,
  EffectTransformSource,
  GeometryRef,
  FieldRef,
  KernelNode,
  KernelIndirectStorageNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  MeshRef,
  ParameterPath,
  ParsedSdfField,
  ParsedVectorField,
  SdfRef,
  TextureRef,
  Vec3,
  TslStorageType,
  VfxDeviceLossInfo,
  VfxRuntimeRenderer,
} from '@nachi/core';
import {
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
  packedComponentIndex,
  resolvePackedAttributeAddress,
} from '@nachi/core';
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicStore,
  cos,
  cameraViewMatrix,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  int,
  inverse,
  mat3,
  mat4,
  linearDepth,
  mix,
  mod,
  mx_atan2,
  positionGeometry,
  rotate,
  select,
  sin,
  screenUV,
  storage,
  texture,
  texture3D,
  uv,
  uint,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
} from 'three/tsl';
import { snoise } from 'three/examples/jsm/tsl/math/curlNoise.js';

export interface ThreeKernelAdapterOptions {
  readonly backend?: 'webgl2' | 'webgpu';
  readonly linearFloat32Filtering?: boolean;
  readonly maxStorageBuffersPerShaderStage?: number;
  readonly maxTransformFeedbackSeparateAttribs?: number;
  readonly resolveMeshSurface?: ThreeMeshSurfaceResolver;
  readonly resolveSdf?: ThreeSdfResolver;
  readonly resolveVectorField?: ThreeVectorFieldResolver;
  /** Sampleable color copy of the previous frame's normalized scene depth. */
  readonly sceneDepthTexture?: THREE.Texture;
  /** Source sample count. Three.js `samples: 0` is normalized to one non-MSAA sample. */
  readonly sceneDepthSampleCount?: number;
}

export interface ThreeSpriteMaterializationOptions {
  readonly resolveTexture?: ThreeTextureResolver;
}

export interface ThreeMeshMaterializationOptions {
  readonly resolveGeometry: ThreeGeometryResolver;
}

export type ThreeTextureResolver = (reference: TextureRef) => THREE.Texture | undefined;
export type ThreeGeometryResolver = (reference: GeometryRef) => THREE.BufferGeometry | undefined;
export interface ThreeVectorFieldResource {
  readonly boundsMax: Vec3;
  readonly boundsMin: Vec3;
  readonly resolution: readonly [number, number, number];
  readonly texture: THREE.Data3DTexture;
}
export type ThreeVectorFieldResolver = (
  reference: FieldRef,
) => ThreeVectorFieldResource | undefined;
export interface ThreeSdfResource {
  readonly boundsMax: Vec3;
  readonly boundsMin: Vec3;
  readonly resolution: readonly [number, number, number];
  readonly texture: THREE.Data3DTexture;
}
export type ThreeSdfResolver = (reference: SdfRef) => ThreeSdfResource | undefined;
export interface ThreeMeshSurfaceResource {
  readonly cdfTexture: THREE.DataTexture;
  readonly positionTexture: THREE.DataTexture;
  readonly triangleCount: number;
  updateFromMesh(mesh: THREE.Mesh | THREE.SkinnedMesh): void;
}
export type ThreeMeshSurfaceResolver = (reference: MeshRef) => ThreeMeshSurfaceResource | undefined;

export function createThreeTextureResolver(
  textures: ReadonlyMap<string, THREE.Texture>,
): ThreeTextureResolver {
  return (reference) => textures.get(reference.uri);
}

export function createThreeGeometryResolver(
  geometries: ReadonlyMap<string, THREE.BufferGeometry>,
): ThreeGeometryResolver {
  return (reference) => geometries.get(reference.uri);
}

export function createThreeTransformSource(object: THREE.Object3D): EffectTransformSource {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  return {
    getWorldTransform: () => {
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(position);
      object.getWorldQuaternion(rotation);
      return {
        position: [position.x, position.y, position.z],
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      };
    },
  };
}

export function createThreeVectorFieldResource(
  field: ParsedVectorField,
  linearFloat32Filtering = false,
): ThreeVectorFieldResource {
  const [width, height, depth] = field.resolution;
  const rgba = new Float32Array(width * height * depth * 4);
  for (let sample = 0; sample < field.vectors.length / 3; sample += 1) {
    rgba[sample * 4] = field.vectors[sample * 3] ?? 0;
    rgba[sample * 4 + 1] = field.vectors[sample * 3 + 1] ?? 0;
    rgba[sample * 4 + 2] = field.vectors[sample * 3 + 2] ?? 0;
    rgba[sample * 4 + 3] = 1;
  }
  const texture = new THREE.Data3DTexture(rgba, width, height, depth);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.FloatType;
  const filter = linearFloat32Filtering ? THREE.LinearFilter : THREE.NearestFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return {
    boundsMax: field.boundsMax,
    boundsMin: field.boundsMin,
    resolution: field.resolution,
    texture,
  };
}

export function createThreeVectorFieldResolver(
  fields: ReadonlyMap<string, ThreeVectorFieldResource>,
): ThreeVectorFieldResolver {
  return (reference) => fields.get(reference.uri);
}

export function createThreeSdfResource(
  field: ParsedSdfField,
  linearFloat32Filtering = false,
): ThreeSdfResource {
  const [width, height, depth] = field.resolution;
  const texture = new THREE.Data3DTexture(field.distances.slice(), width, height, depth);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  const filter = linearFloat32Filtering ? THREE.LinearFilter : THREE.NearestFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return {
    boundsMax: field.boundsMax,
    boundsMin: field.boundsMin,
    resolution: field.resolution,
    texture,
  };
}

export function createThreeSdfResolver(
  fields: ReadonlyMap<string, ThreeSdfResource>,
): ThreeSdfResolver {
  return (reference) => fields.get(reference.uri);
}

export function createThreeMeshSurfaceResource(
  mesh: THREE.Mesh | THREE.SkinnedMesh,
  maxTextureDimension2D = 8192,
): ThreeMeshSurfaceResource {
  if (!Number.isSafeInteger(maxTextureDimension2D) || maxTextureDimension2D <= 0) {
    throw new RangeError('maxTextureDimension2D must be a positive safe integer.');
  }
  const position = mesh.geometry.getAttribute('position');
  if (!position) throw new Error('Mesh surface sampling requires a position attribute.');
  const index = mesh.geometry.getIndex();
  const triangleCount = (index?.count ?? position.count) / 3;
  if (!Number.isSafeInteger(triangleCount) || triangleCount <= 0) {
    throw new Error('Mesh surface sampling requires a non-empty triangle list.');
  }
  const positionTextureWidth = triangleCount * 3;
  if (positionTextureWidth > maxTextureDimension2D) {
    throw new Error(
      `NACHI_MESH_SURFACE_TEXTURE_TOO_WIDE: Mesh surface sampling requires ${positionTextureWidth} texels, exceeding maxTextureDimension2D ${maxTextureDimension2D}.`,
    );
  }
  const positions = new Float32Array(triangleCount * 3 * 4);
  const cdf = new Float32Array(triangleCount);
  const positionTexture = new THREE.DataTexture(
    positions,
    positionTextureWidth,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const cdfTexture = new THREE.DataTexture(cdf, triangleCount, 1, THREE.RedFormat, THREE.FloatType);
  for (const value of [positionTexture, cdfTexture]) {
    value.minFilter = THREE.NearestFilter;
    value.magFilter = THREE.NearestFilter;
    value.wrapS = THREE.ClampToEdgeWrapping;
    value.wrapT = THREE.ClampToEdgeWrapping;
    value.generateMipmaps = false;
  }
  const vertex = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const vertexIndex = (corner: number) => index?.getX(corner) ?? corner;
  const readVertex = (target: THREE.Vector3, sourceIndex: number) => {
    vertex.fromBufferAttribute(position as THREE.BufferAttribute, sourceIndex);
    if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(sourceIndex, vertex);
    target.copy(vertex);
  };
  const resource: ThreeMeshSurfaceResource = {
    cdfTexture,
    positionTexture,
    triangleCount,
    updateFromMesh(source) {
      if (source !== mesh) {
        throw new Error('Mesh surface resources can only update from their source mesh.');
      }
      mesh.updateMatrixWorld(true);
      if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.update();
      let totalArea = 0;
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        readVertex(a, vertexIndex(triangle * 3));
        readVertex(b, vertexIndex(triangle * 3 + 1));
        readVertex(c, vertexIndex(triangle * 3 + 2));
        for (const [corner, value] of [a, b, c].entries()) {
          positions.set([value.x, value.y, value.z, 1], (triangle * 3 + corner) * 4);
        }
        totalArea += edgeA.subVectors(b, a).cross(edgeB.subVectors(c, a)).length() * 0.5;
        cdf[triangle] = totalArea;
      }
      if (!(totalArea > 0)) throw new Error('Mesh surface sampling requires positive total area.');
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        cdf[triangle] = (cdf[triangle] ?? 0) / totalArea;
      }
      positionTexture.needsUpdate = true;
      cdfTexture.needsUpdate = true;
    },
  };
  resource.updateFromMesh(mesh);
  return resource;
}

export function createThreeMeshSurfaceResolver(
  meshes: ReadonlyMap<string, ThreeMeshSurfaceResource>,
): ThreeMeshSurfaceResolver {
  return (reference) => meshes.get(reference.uri);
}

function asNode(value: unknown): KernelNode {
  return value as KernelNode;
}

function nodeLength(value: KernelNode): KernelNode {
  return (value as KernelNode & { length(): KernelNode }).length();
}

function nodeXY(value: KernelNode): KernelNode {
  return (value as KernelNode & { readonly xy: KernelNode }).xy;
}

function nodeCross(left: KernelNode, right: KernelNode): KernelNode {
  return (left as KernelNode & { cross(value: KernelNode): KernelNode }).cross(right);
}

function vectorValues(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Expected a ${length}-component value.`);
  }
  return value.map(Number);
}

function constantNode(
  value: unknown,
  type: Parameters<KernelTslAdapter['constant']>[1],
): KernelNode {
  switch (type) {
    case 'bool':
      return asNode(uint(value ? 1 : 0));
    case 'i32':
      return asNode(int(Number(value)));
    case 'u32':
      return asNode(uint(Number(value)));
    case 'f32':
      return asNode(float(Number(value)));
    case 'vec2': {
      const values = vectorValues(value, 2);
      return asNode(vec2(values[0], values[1]));
    }
    case 'vec3': {
      const values = vectorValues(value, 3);
      return asNode(vec3(values[0], values[1], values[2]));
    }
    case 'color':
    case 'quat':
    case 'vec4': {
      const values = vectorValues(value, 4);
      return asNode(vec4(values[0], values[1], values[2], values[3]));
    }
    case 'mat3': {
      const values = vectorValues(value, 9);
      const create = mat3 as unknown as (...components: number[]) => unknown;
      return asNode(create(...values));
    }
    case 'mat4': {
      const values = vectorValues(value, 16);
      const create = mat4 as unknown as (...components: number[]) => unknown;
      return asNode(create(...values));
    }
  }
}

function uniformValue(value: unknown, type: Parameters<KernelTslAdapter['uniform']>[1]): unknown {
  if (type === 'mat3') return new THREE.Matrix3().fromArray(vectorValues(value, 9));
  if (type === 'mat4') return new THREE.Matrix4().fromArray(vectorValues(value, 16));
  if (type === 'vec2') return new THREE.Vector2().fromArray(vectorValues(value, 2));
  if (type === 'vec3') return new THREE.Vector3().fromArray(vectorValues(value, 3));
  if (type === 'vec4') return new THREE.Vector4().fromArray(vectorValues(value, 4));
  if (type === 'uint' && typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function createDataTexture(lut: BakedLut, linearFloat32Filtering: boolean): THREE.DataTexture {
  const format = lut.channels === 1 ? THREE.RedFormat : THREE.RGBAFormat;
  const dataTexture = new THREE.DataTexture(lut.data, lut.width, 1, format, THREE.FloatType);
  const filter = linearFloat32Filtering ? THREE.LinearFilter : THREE.NearestFilter;
  dataTexture.minFilter = filter;
  dataTexture.magFilter = filter;
  dataTexture.wrapS = THREE.ClampToEdgeWrapping;
  dataTexture.wrapT = THREE.ClampToEdgeWrapping;
  dataTexture.needsUpdate = true;
  return dataTexture;
}

const createInstancedArray = instancedArray as unknown as (
  length: number,
  type: TslStorageType,
) => unknown;
const createUniform = uniform as unknown as (value: unknown, type: string) => unknown;

type StorageArray = Float32Array | Int32Array | Uint32Array;
type StorageArrayConstructor = new (length: number) => StorageArray;

const THREE_INDIRECT_ATTRIBUTE_TYPE = 4;
const indirectAttributesByAdapter = new WeakMap<
  KernelTslAdapter,
  Set<THREE.IndirectStorageBufferAttribute>
>();

function materializeInstancedArray(length: number, type: TslStorageType): KernelStorageNode {
  const node = createInstancedArray(length, type) as KernelStorageNode;
  const attribute = node.value as { array: StorageArray };
  const physicalLength = length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[type];
  if (attribute.array.length !== physicalLength) {
    const ArrayConstructor = attribute.array.constructor as StorageArrayConstructor;
    attribute.array = new ArrayConstructor(physicalLength);
  }
  return node;
}

export function createThreeKernelAdapter(
  options: ThreeKernelAdapterOptions = {},
): KernelTslAdapter {
  const indirectAttributes = new Set<THREE.IndirectStorageBufferAttribute>();
  const sourceRenderTarget = options.sceneDepthTexture as
    | (THREE.Texture & { readonly renderTarget?: { readonly samples?: number } })
    | undefined;
  const configuredSceneDepthSampleCount =
    options.sceneDepthSampleCount ?? sourceRenderTarget?.renderTarget?.samples ?? 1;
  if (
    !Number.isSafeInteger(configuredSceneDepthSampleCount) ||
    configuredSceneDepthSampleCount < 0
  ) {
    throw new RangeError('sceneDepthSampleCount must be a non-negative safe integer.');
  }
  const sceneDepthSampleCount =
    configuredSceneDepthSampleCount === 0 ? 1 : configuredSceneDepthSampleCount;
  const base: KernelTslAdapter = {
    capabilities: {
      atomics: options.backend !== 'webgl2',
      backend: options.backend ?? 'webgpu',
      indirectDispatch: options.backend !== 'webgl2',
      indirectDraw: options.backend !== 'webgl2',
      sceneDepth: options.sceneDepthTexture !== undefined,
      ...(options.sceneDepthTexture === undefined ? {} : { sceneDepthSampleCount }),
    },
    instanceIndex: asNode(instanceIndex),
    atomicAdd: (target, value, returnValue = false) =>
      returnValue
        ? asNode(
            new THREE.AtomicFunctionNode(
              THREE.AtomicFunctionNode.ATOMIC_ADD,
              target as never,
              value as never,
            ),
          )
        : asNode(atomicAdd(target as never, value as never)),
    atomicLoad: (target) =>
      asNode(
        new THREE.AtomicFunctionNode(THREE.AtomicFunctionNode.ATOMIC_LOAD, target as never, null),
      ),
    atomicStore: (target, value) => {
      atomicStore(target as never, value as never);
    },
    atan2: (y, x) => asNode(mx_atan2(y as never, x as never)),
    branch: (condition, whenTrue, whenFalse) => {
      const branch = If(condition as never, () => {
        whenTrue();
      });
      if (whenFalse) {
        branch.Else(() => {
          whenFalse();
        });
      }
    },
    constant: constantNode,
    cos: (value) => asNode(cos(value as never)),
    dataTexture: (lut) => createDataTexture(lut, options.linearFloat32Filtering ?? false),
    fn: (callback) => Fn(callback)() as unknown as ReturnType<KernelTslAdapter['fn']>,
    instancedArray: materializeInstancedArray,
    indirectArray: (values) => {
      const attribute = new THREE.IndirectStorageBufferAttribute(values, 1);
      // Establish an explicit, range-free initialization epoch. Three r185 copies the entire
      // CPU array when Attributes first creates the GPU buffer; later epochs may use ranges.
      attribute.needsUpdate = true;
      indirectAttributes.add(attribute);
      const node = storage(
        attribute,
        'uint',
        values.length,
      ) as unknown as KernelIndirectStorageNode;
      Object.defineProperty(node, 'indirectResource', { value: attribute });
      return node;
    },
    inverse: (value) => asNode(inverse(value as never)),
    sampleTexture: (value, uv) => asNode(texture(value as THREE.Texture, uv as never)),
    ...(options.sceneDepthTexture === undefined
      ? {}
      : {
          sampleSceneDepth: (uv: KernelNode) =>
            asNode(texture(options.sceneDepthTexture!, uv as never)).r,
        }),
    sampleMeshSurface: (reference, triangleSample, barycentricA, barycentricB) => {
      const resource = options.resolveMeshSurface?.(reference);
      if (!resource) {
        throw new Error(`No mesh-surface resolver supplied for resource "${reference.uri}".`);
      }
      const cdfSample = (triangle: KernelNode) =>
        asNode(
          texture(
            resource.cdfTexture,
            vec2(triangle.add(0.5).div(resource.triangleCount) as never, 0.5),
          ),
        ).r;
      let low = asNode(float(0));
      let high = asNode(float(resource.triangleCount - 1));
      const searchSteps = Math.ceil(Math.log2(resource.triangleCount));
      for (let step = 0; step < searchSteps; step += 1) {
        const middle = asNode(floor(low.add(high).mul(0.5) as never));
        const beforeOrAt = triangleSample.lessThanEqual(cdfSample(middle));
        low = asNode(select(beforeOrAt as never, low as never, middle.add(1) as never));
        high = asNode(select(beforeOrAt as never, middle as never, high as never));
      }
      const triangle = low;
      const vertex = (corner: number) => {
        const texel = triangle.mul(3).add(corner);
        return asNode(
          texture(
            resource.positionTexture,
            vec2(texel.add(0.5).div(resource.triangleCount * 3) as never, 0.5),
          ),
        ).xyz;
      };
      const a = vertex(0);
      const b = vertex(1);
      const c = vertex(2);
      const sqrtA = barycentricA.sqrt();
      const weightA = asNode(float(1)).sub(sqrtA);
      const weightB = sqrtA.mul(asNode(float(1)).sub(barycentricB));
      const weightC = sqrtA.mul(barycentricB);
      const position = a.mul(weightA).add(b.mul(weightB)).add(c.mul(weightC));
      const rawNormal = nodeCross(b.sub(a), c.sub(a));
      const normal = rawNormal.div(nodeLength(rawNormal).clamp(0.000001, 1e20));
      return { normal, position };
    },
    sampleSdf: (reference, position) => {
      const field = options.resolveSdf?.(reference);
      if (!field) throw new Error(`No SDF resolver supplied for resource "${reference.uri}".`);
      const extent = field.boundsMax.map(
        (value, axis) => value - (field.boundsMin[axis] ?? value),
      ) as unknown as Vec3;
      const spacing = field.resolution.map(
        (dimension, axis) => extent[axis]! / (dimension - 1),
      ) as unknown as Vec3;
      const sample = (samplePosition: KernelNode) => {
        const normalized = samplePosition
          .sub(asNode(vec3(...field.boundsMin)))
          .div(asNode(vec3(...extent)))
          .clamp(0, 1);
        const texelScale = field.resolution.map(
          (dimension) => (dimension - 1) / dimension,
        ) as unknown as Vec3;
        const texelOffset = field.resolution.map((dimension) => 0.5 / dimension) as unknown as Vec3;
        const coordinates = normalized
          .mul(asNode(vec3(...texelScale)))
          .add(asNode(vec3(...texelOffset)));
        return asNode(texture3D(field.texture).sample(coordinates as never)).r;
      };
      const x = asNode(vec3(spacing[0], 0, 0));
      const y = asNode(vec3(0, spacing[1], 0));
      const z = asNode(vec3(0, 0, spacing[2]));
      const gradient = asNode(
        vec3(
          sample(position.add(x))
            .sub(sample(position.sub(x)))
            .div(2 * spacing[0]) as never,
          sample(position.add(y))
            .sub(sample(position.sub(y)))
            .div(2 * spacing[1]) as never,
          sample(position.add(z))
            .sub(sample(position.sub(z)))
            .div(2 * spacing[2]) as never,
        ),
      );
      return { distance: sample(position), gradient };
    },
    sampleVectorField: (reference, position, tiling) => {
      const field = options.resolveVectorField?.(reference);
      if (!field) {
        throw new Error(`No vector-field resolver supplied for resource "${reference.uri}".`);
      }
      const extent = field.boundsMax.map(
        (value, axis) => value - (field.boundsMin[axis] ?? value),
      ) as unknown as Vec3;
      const normalized = position
        .sub(asNode(vec3(...field.boundsMin)))
        .div(asNode(vec3(...extent)));
      const cornerCoordinates = tiling ? normalized : normalized.clamp(0, 1);
      const texelScale = field.resolution.map(
        (dimension) => (dimension - 1) / dimension,
      ) as unknown as Vec3;
      const texelOffset = field.resolution.map((dimension) => 0.5 / dimension) as unknown as Vec3;
      const coordinates = cornerCoordinates
        .mul(asNode(vec3(...texelScale)))
        .add(asNode(vec3(...texelOffset)));
      return asNode(texture3D(field.texture).sample(coordinates as never)).xyz;
    },
    select: (condition, whenTrue, whenFalse) =>
      asNode(select(condition as never, whenTrue as never, whenFalse as never)),
    simplexNoise: (position) => asNode(snoise(position as never)),
    sin: (value) => asNode(sin(value as never)),
    uniform: (value, type) =>
      createUniform(uniformValue(value, type), type) as ReturnType<KernelTslAdapter['uniform']>,
    uint: (value) => asNode(uint(value as never)),
    vec2: (x, y) => asNode(vec2(x as never, y as never)),
    vec3: (x, y, z) => asNode(vec3(x as never, y as never, z as never)),
    vec4: (x, y, z, w) => asNode(vec4(x as never, y as never, z as never, w as never)),
  };
  const deviceLimits = {
    ...(options.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: options.maxStorageBuffersPerShaderStage }),
    ...(options.maxTransformFeedbackSeparateAttribs === undefined
      ? {}
      : {
          maxTransformFeedbackSeparateAttribs: options.maxTransformFeedbackSeparateAttribs,
        }),
  };
  const adapter = Object.keys(deviceLimits).length === 0 ? base : { ...base, deviceLimits };
  indirectAttributesByAdapter.set(adapter, indirectAttributes);
  return adapter;
}

export function setThreeUniformValue(
  uniformNode: KernelUniformNode,
  _path: ParameterPath,
  value: unknown,
): void {
  const current = uniformNode.value;
  if (current instanceof THREE.Matrix3) {
    current.fromArray(vectorValues(value, 9));
  } else if (current instanceof THREE.Matrix4) {
    current.fromArray(vectorValues(value, 16));
  } else if (current instanceof THREE.Vector2) {
    current.fromArray(vectorValues(value, 2));
  } else if (current instanceof THREE.Vector3) {
    current.fromArray(vectorValues(value, 3));
  } else if (current instanceof THREE.Vector4) {
    current.fromArray(vectorValues(value, 4));
  } else {
    uniformNode.value = value;
  }
}

export function createThreeRuntimeRenderer(
  renderer: THREE.WebGPURenderer,
  kernelAdapter: KernelTslAdapter,
  deviceLost?: Promise<VfxDeviceLossInfo>,
  setInstanceCount?: VfxRuntimeRenderer['setInstanceCount'],
): VfxRuntimeRenderer {
  const initializedIndirectAttributes = new WeakSet<THREE.IndirectStorageBufferAttribute>();
  const initializeIndirectAttributes = (): void => {
    const attributes = (
      renderer as unknown as {
        readonly _attributes?: {
          update(attribute: THREE.IndirectStorageBufferAttribute, type: number): void;
        };
      }
    )._attributes;
    if (!attributes) {
      throw new Error(
        'Three renderer must be initialized before submitting Nachi compute kernels.',
      );
    }
    for (const attribute of indirectAttributesByAdapter.get(kernelAdapter) ?? []) {
      if (initializedIndirectAttributes.has(attribute)) continue;
      // Use Three's shared Attributes manager so the full upload and its version bookkeeping
      // happen atomically before any compute kernel can write instanceCount on the GPU.
      attributes.update(attribute, THREE_INDIRECT_ATTRIBUTE_TYPE);
      attribute.clearUpdateRanges();
      initializedIndirectAttributes.add(attribute);
    }
  };
  const prepareKernelsForPooling = (kernels: BuiltEmitterKernels): void => {
    if (!kernels.drawIndirect || kernels.drawIndirectOffsetBytes === undefined) return;
    const indirect = kernels.drawIndirect.indirectResource as THREE.IndirectStorageBufferAttribute;
    const instanceCountOffset = kernels.drawIndirectOffsetBytes / Uint32Array.BYTES_PER_ELEMENT + 1;
    const words = indirect.array as Uint32Array;
    words[instanceCountOffset] = 0;
    indirect.addUpdateRange(instanceCountOffset, 1);
    indirect.needsUpdate = true;
  };
  const base = {
    kernelAdapter,
    prepareKernelsForPooling,
    readStorage: (storageNode: KernelStorageNode) =>
      renderer.getArrayBufferAsync(storageNode.value as never),
    setUniformValue: setThreeUniformValue,
    ...(setInstanceCount === undefined ? {} : { setInstanceCount }),
    submitCompute: (kernel: Parameters<VfxRuntimeRenderer['submitCompute']>[0]) => {
      initializeIndirectAttributes();
      return renderer.computeAsync(kernel as never);
    },
    submitComputeIndirect: (
      kernel: Parameters<VfxRuntimeRenderer['submitCompute']>[0],
      indirectResource: unknown,
    ) => {
      initializeIndirectAttributes();
      return renderer.compute(kernel as never, indirectResource as never);
    },
  };
  return deviceLost === undefined ? base : { ...base, deviceLost };
}

function spriteBlending(mode: 'additive' | 'alpha' | 'multiply' | 'premultiplied'): {
  blending: THREE.Blending;
  premultipliedAlpha: boolean;
} {
  if (mode === 'additive') {
    return { blending: THREE.AdditiveBlending, premultipliedAlpha: false };
  }
  if (mode === 'multiply') {
    return { blending: THREE.MultiplyBlending, premultipliedAlpha: true };
  }
  return {
    blending: THREE.NormalBlending,
    premultipliedAlpha: mode === 'premultiplied',
  };
}

function primeIndirectIndexCount(
  indirect: THREE.IndirectStorageBufferAttribute,
  drawArgumentsOffsetBytes: number,
  indexCount: number,
): void {
  const words = indirect.array as Uint32Array;
  const word = drawArgumentsOffsetBytes / Uint32Array.BYTES_PER_ELEMENT;
  words[word] = indexCount;
  // Only upload word 0 of this draw record. A full buffer upload here would overwrite the GPU
  // compaction result in word 1 (instanceCount) when materialization happens after simulation.
  indirect.addUpdateRange(word, 1);
  indirect.needsUpdate = true;
}

export function createThreeSpriteGeometry(vertexCount: 4 | 5 | 6 | 7 | 8): THREE.BufferGeometry {
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let index = 0; index < vertexCount; index += 1) {
    const quad = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ] as const;
    const phase = vertexCount === 8 ? Math.PI / vertexCount : 0;
    const angle = -Math.PI / 2 + phase + (index / vertexCount) * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const radius = 0.5 / Math.max(Math.abs(cosine), Math.abs(sine));
    const x = vertexCount === 4 ? quad[index]![0] : cosine * radius;
    const y = vertexCount === 4 ? quad[index]![1] : sine * radius;
    positions.set([x, y, 0], index * 3);
    uvs.set([x + 0.5, y + 0.5], index * 2);
  }
  const indices: number[] = [];
  for (let triangle = 1; triangle < vertexCount - 1; triangle += 1) {
    indices.push(0, triangle, triangle + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function createThreeParticleStorageBindings(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
) {
  const vertexStorages = program.attributeSchema.storageArrays.map((description) => {
    const computeStorage = kernels.storages[description.name];
    if (!computeStorage) throw new Error(`Particle storage "${description.name}" is missing.`);
    return (
      storage(computeStorage.value as never, description.type, description.length) as unknown as {
        toReadOnly(): KernelStorageNode;
      }
    ).toReadOnly();
  });
  const logicalAttribute = (name: string, physicalIndex: KernelNode): KernelNode => {
    const attribute = program.attributeSchema.byName[name];
    if (!attribute) throw new Error(`Particle attribute "${name}" is missing.`);
    const storageDescription =
      program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
    const storageNode =
      storageDescription === undefined ? undefined : vertexStorages[storageDescription.index];
    if (!storageDescription || !storageNode) {
      throw new Error(`Particle storage for "${name}" is missing.`);
    }
    const address = storageDescription.packed
      ? resolvePackedAttributeAddress(attribute, storageDescription)
      : undefined;
    const index = storageDescription.packed
      ? physicalIndex.mul(asNode(uint(address!.particleStride))).add(asNode(uint(address!.group)))
      : physicalIndex;
    const element = storageNode.element(index);
    if (!storageDescription.packed) return element;
    const lanes = [element.x, element.y, element.z, element.w].slice(
      address!.offset,
      address!.offset + attribute.components,
    );
    if (attribute.components === 1) return lanes[0]!;
    if (attribute.components === 2) return asNode(vec2(lanes[0] as never, lanes[1] as never));
    if (attribute.components === 3) {
      return asNode(vec3(lanes[0] as never, lanes[1] as never, lanes[2] as never));
    }
    throw new Error(`Packed particle attribute "${name}" has unsupported width.`);
  };
  return { logicalAttribute };
}

function createThreeParticleVertexBindings(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  indirect: CompiledDrawIndirectDescription,
) {
  const { logicalAttribute } = createThreeParticleStorageBindings(program, kernels);
  const lifecycleRead = (
    storage(
      kernels.aliveIndices.value as never,
      'uint',
      program.meta.lifecycleStorage.buffers.state.wordCount,
    ) as unknown as { toReadOnly(): KernelStorageNode }
  ).toReadOnly();
  const aliveIndex = asNode(uint(instanceIndex)).add(
    asNode(uint(indirect.aliveIndicesOffsetWords)),
  );
  return { compactedIndex: lifecycleRead.element(aliveIndex), logicalAttribute };
}

/** Materializes one compiler draw description without exposing physical packing to author code. */
export function materializeThreeSpriteDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeSpriteMaterializationOptions = {},
): THREE.InstancedMesh<THREE.BufferGeometry, THREE.SpriteNodeMaterial> {
  const draw = program.draws[drawIndex];
  if (!draw || draw.kind !== 'billboard') {
    throw new Error(`Compiled sprite draw ${drawIndex} is missing.`);
  }
  if (!kernels.drawIndirect || kernels.drawIndirectOffsetBytes === undefined) {
    throw new Error('Compiled sprite rendering requires the WebGPU indirect-draw lifecycle path.');
  }
  if (draw.indirect.drawArgumentsOffsetBytes !== kernels.drawIndirectOffsetBytes) {
    throw new Error('Compiled draw and lifecycle indirect offsets disagree.');
  }

  const { compactedIndex, logicalAttribute } = createThreeParticleVertexBindings(
    program,
    kernels,
    draw.indirect,
  );
  const particlePosition = logicalAttribute('position', compactedIndex);
  const particleSize = logicalAttribute('size', compactedIndex);
  const particleColor = logicalAttribute('color', compactedIndex);
  const spriteRotation = logicalAttribute('spriteRotation', compactedIndex);
  const alignment = draw.vertex.alignment;

  let rotationNode = spriteRotation;
  let scaleNode = asNode(vec2(particleSize as never, particleSize as never));
  if (alignment.mode === 'velocity-aligned' || alignment.mode === 'velocity-stretch') {
    const velocity = logicalAttribute('velocity', compactedIndex);
    const viewVelocity = asNode(cameraViewMatrix.mul(vec4(velocity as never, 0))).xyz;
    rotationNode = asNode(mx_atan2(viewVelocity.x.mul(-1) as never, viewVelocity.y as never)).add(
      spriteRotation,
    );
    if (alignment.mode === 'velocity-stretch') {
      const factor = alignment.factor ?? 1;
      scaleNode = asNode(
        vec2(
          particleSize as never,
          particleSize.mul(nodeLength(viewVelocity).mul(factor).add(1)) as never,
        ),
      );
    }
  } else if (alignment.mode === 'custom-axis') {
    const viewAxis = asNode(cameraViewMatrix.mul(vec4(...alignment.axis, 0))).xyz;
    rotationNode = asNode(mx_atan2(viewAxis.x.mul(-1) as never, viewAxis.y as never)).add(
      spriteRotation,
    );
  }

  let fragmentColor = asNode(varying(particleColor as never));
  if (draw.fragment.map) {
    const map = options.resolveTexture?.(draw.fragment.map);
    if (!map) {
      throw new Error(`No texture resolver supplied for sprite map "${draw.fragment.map.uri}".`);
    }
    const flipbook = draw.fragment.flipbook;
    if (flipbook) {
      const localUv = asNode(uv());
      const progress = asNode(
        varying(logicalAttribute(flipbook.progressAttribute, compactedIndex) as never),
      ).clamp(0, 1);
      const frameCount = flipbook.cols * flipbook.rows;
      const framePosition = flipbook.interpolate
        ? progress.mul(frameCount).clamp(0, frameCount - 1)
        : asNode(floor(progress.mul(frameCount) as never)).clamp(0, frameCount - 1);
      const firstFrame = asNode(floor(framePosition as never));
      const secondFrame = firstFrame.add(1).clamp(0, frameCount - 1);
      const frameBlend = flipbook.interpolate
        ? asNode(fract(framePosition as never))
        : asNode(float(0));
      const atlasUv = (frame: KernelNode, sourceUv: KernelNode, flipY: boolean): KernelNode => {
        const column = asNode(mod(frame as never, flipbook.cols));
        const topDownRow = asNode(floor(frame.div(flipbook.cols) as never));
        const row = flipY ? asNode(float(flipbook.rows - 1)).sub(topDownRow) : topDownRow;
        const cellUv = sourceUv.clamp(0.001, 0.999);
        return asNode(
          vec2(
            cellUv.x.add(column).div(flipbook.cols) as never,
            cellUv.y.add(row).div(flipbook.rows) as never,
          ),
        );
      };
      let firstUv = atlasUv(firstFrame, localUv, map.flipY);
      let secondUv = atlasUv(secondFrame, localUv, map.flipY);
      if (flipbook.interpolate && flipbook.motionVectors) {
        const motionTexture = options.resolveTexture?.(flipbook.motionVectors);
        if (!motionTexture) {
          throw new Error(
            `No texture resolver supplied for flipbook motion vectors "${flipbook.motionVectors.uri}".`,
          );
        }
        const firstMotionUv = atlasUv(firstFrame, localUv, motionTexture.flipY);
        const secondMotionUv = atlasUv(secondFrame, localUv, motionTexture.flipY);
        const firstMotion = nodeXY(asNode(texture(motionTexture, firstMotionUv as never)))
          .mul(2)
          .sub(1);
        const secondMotion = nodeXY(asNode(texture(motionTexture, secondMotionUv as never)))
          .mul(2)
          .sub(1);
        firstUv = atlasUv(firstFrame, localUv.sub(firstMotion.mul(frameBlend)), map.flipY);
        secondUv = atlasUv(
          secondFrame,
          localUv.add(secondMotion.mul(asNode(float(1)).sub(frameBlend))),
          map.flipY,
        );
      }
      const firstSample = asNode(texture(map, firstUv as never));
      const mapSample = flipbook.interpolate
        ? asNode(mix(firstSample as never, texture(map, secondUv as never), frameBlend as never))
        : firstSample;
      fragmentColor = fragmentColor.mul(mapSample);
    } else {
      fragmentColor = fragmentColor.mul(asNode(texture(map, uv())));
    }
  }
  const softFade = draw.fragment.soft
    ? asNode(linearDepth(viewportDepthTexture(screenUV)))
        .sub(asNode(linearDepth()))
        .div(draw.fragment.soft.fadeDistance)
        .clamp(0, 1)
    : asNode(float(1));
  const blend = spriteBlending(draw.fragment.blending);
  const material = new THREE.SpriteNodeMaterial({
    blending: blend.blending,
    depthTest: true,
    depthWrite: false,
    premultipliedAlpha: blend.premultipliedAlpha,
    transparent: true,
  });
  material.positionNode = particlePosition as never;
  material.rotationNode = rotationNode as never;
  material.scaleNode = scaleNode as never;
  material.colorNode = fragmentColor.rgb as never;
  material.opacityNode = fragmentColor.a.mul(softFade) as never;

  const geometry = createThreeSpriteGeometry(draw.geometry.vertexCount);
  const indirect = kernels.drawIndirect.indirectResource as THREE.IndirectStorageBufferAttribute;
  primeIndirectIndexCount(
    indirect,
    draw.indirect.drawArgumentsOffsetBytes,
    draw.geometry.indexCount,
  );
  geometry.setIndirect(indirect, draw.indirect.drawArgumentsOffsetBytes);

  const mesh = new THREE.InstancedMesh(geometry, material, program.attributeSchema.capacity);
  const identity = new THREE.Matrix4();
  for (let index = 0; index < program.attributeSchema.capacity; index += 1) {
    mesh.setMatrixAt(index, identity);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function indexedGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  if (geometry.getIndex()) return geometry;
  const vertexCount = geometry.getAttribute('position')?.count ?? 0;
  if (vertexCount === 0) throw new Error('Mesh renderer geometry has no position vertices.');
  geometry.setIndex(Array.from({ length: vertexCount }, (_, index) => index));
  return geometry;
}

export function directionEulerAngles(
  direction: readonly [number, number, number],
): readonly [number, 0, number] {
  const [x, y, z] = direction;
  return [-Math.atan2(z, y), 0, Math.atan2(x, Math.hypot(y, z))];
}

function directionEuler(direction: KernelNode): KernelNode {
  const yzLength = asNode(direction.y.mul(direction.y).add(direction.z.mul(direction.z)).sqrt());
  return asNode(
    vec3(
      asNode(mx_atan2(direction.z as never, direction.y as never)).mul(-1) as never,
      0,
      mx_atan2(direction.x as never, yzLength as never) as never,
    ),
  );
}

function rotateByQuaternion(position: KernelNode, quaternion: KernelNode): KernelNode {
  const twiceCross = nodeCross(quaternion.xyz, position).mul(2);
  return position.add(twiceCross.mul(quaternion.w)).add(nodeCross(quaternion.xyz, twiceCross));
}

/** Materializes a compiled mesh renderer through the same packed/alive-index path as sprites. */
export function materializeThreeMeshDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeMeshMaterializationOptions,
): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial> {
  const draw = program.draws[drawIndex];
  if (!draw || draw.kind !== 'mesh') {
    throw new Error(`Compiled mesh draw ${drawIndex} is missing.`);
  }
  if (!kernels.drawIndirect || kernels.drawIndirectOffsetBytes === undefined) {
    throw new Error('Compiled mesh rendering requires the WebGPU indirect-draw lifecycle path.');
  }
  if (draw.indirect.drawArgumentsOffsetBytes !== kernels.drawIndirectOffsetBytes) {
    throw new Error('Compiled mesh draw and lifecycle indirect offsets disagree.');
  }
  const resolvedGeometry = options.resolveGeometry(draw.geometry.resource);
  if (!resolvedGeometry) {
    throw new Error(
      `No geometry resolver supplied for mesh resource "${draw.geometry.resource.uri}".`,
    );
  }
  const geometry = indexedGeometry(resolvedGeometry);
  const indexCount = geometry.getIndex()?.count ?? 0;
  if (indexCount === 0) throw new Error('Mesh renderer geometry has no drawable indices.');
  const { compactedIndex, logicalAttribute } = createThreeParticleVertexBindings(
    program,
    kernels,
    draw.indirect,
  );
  const particlePosition = logicalAttribute('position', compactedIndex);
  const particleScale = logicalAttribute('scale', compactedIndex);
  const particleColor = logicalAttribute('color', compactedIndex);
  let localPosition = asNode(positionGeometry).mul(particleScale);
  if (draw.vertex.alignment.mode === 'velocity') {
    localPosition = asNode(
      rotate(
        localPosition as never,
        directionEuler(logicalAttribute('velocity', compactedIndex)) as never,
      ),
    );
  } else if (draw.vertex.alignment.mode === 'custom-axis') {
    localPosition = asNode(
      rotate(
        localPosition as never,
        directionEuler(asNode(vec3(...draw.vertex.alignment.axis))) as never,
      ),
    );
  } else if (draw.vertex.alignment.mode === 'quaternion') {
    localPosition = rotateByQuaternion(localPosition, logicalAttribute('rotation', compactedIndex));
  }
  const blend = spriteBlending(draw.fragment.blending);
  const fragmentColor = asNode(varying(particleColor as never));
  const transparent =
    draw.fragment.blending === 'alpha' || draw.fragment.blending === 'premultiplied';
  const material = new THREE.MeshBasicNodeMaterial({
    blending: blend.blending,
    depthTest: true,
    depthWrite: true,
    premultipliedAlpha: blend.premultipliedAlpha,
    transparent,
  });
  material.positionNode = localPosition.add(particlePosition) as never;
  material.colorNode = fragmentColor.rgb as never;
  material.opacityNode = fragmentColor.a as never;

  const indirect = kernels.drawIndirect.indirectResource as THREE.IndirectStorageBufferAttribute;
  primeIndirectIndexCount(indirect, draw.indirect.drawArgumentsOffsetBytes, indexCount);
  geometry.setIndirect(indirect, draw.indirect.drawArgumentsOffsetBytes);

  const mesh = new THREE.InstancedMesh(geometry, material, program.attributeSchema.capacity);
  const identity = new THREE.Matrix4();
  for (let index = 0; index < program.attributeSchema.capacity; index += 1) {
    mesh.setMatrixAt(index, identity);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

type MutableNode = KernelNode & {
  abs(): MutableNode;
  assign(value: unknown): MutableNode;
  greaterThan(value: unknown): MutableNode;
  or(value: unknown): MutableNode;
  toVar(): MutableNode;
};

function mutable(value: unknown): MutableNode {
  return value as MutableNode;
}

export interface ThreeLightSelectionStats {
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly selected: readonly {
    readonly color: readonly [number, number, number];
    readonly intensity: number;
    readonly physicalIndex: number;
    readonly position: readonly [number, number, number];
    readonly priority: number;
    readonly radius: number;
  }[];
}

export interface ThreeLightPoolDraw {
  dispose(): void;
  readonly group: THREE.Group;
  readonly lights: readonly THREE.PointLight[];
  readonly selectionBuffers: readonly KernelStorageNode[];
  readonly selectionKernels: readonly unknown[];
  readonly stats: ThreeLightSelectionStats;
  update(
    renderer: THREE.WebGPURenderer,
    effectState?: EffectInstanceState,
  ): Promise<ThreeLightSelectionStats>;
}

export interface ThreeLightPoolOptions {
  readonly onDiagnostic?: (diagnostic: {
    readonly code: 'NACHI_LIGHT_LIMIT_EXCEEDED';
    readonly message: string;
  }) => void;
}

/** GPU top-N selection followed by one fixed-size, one-frame-late readback into PointLight pool. */
export function materializeThreeLightDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeLightPoolOptions = {},
): ThreeLightPoolDraw {
  const draw = program.draws[drawIndex];
  if (!draw || draw.kind !== 'light')
    throw new Error(`Compiled light draw ${drawIndex} is missing.`);
  if (kernels.capabilityPath !== 'webgpu-atomic-indirect') {
    throw new Error('NACHI_LIGHT_WEBGL2_UNSUPPORTED: Light top-N selection requires WebGPU.');
  }
  const { logicalAttribute } = createThreeParticleStorageBindings(program, kernels);
  const recordCount = 1 + draw.maxLights * 3;
  const selectionBuffers = [0, 1].map((bufferIndex) =>
    instancedArray(recordCount, 'vec4').setName(`NachiLightSelection${bufferIndex}`),
  ) as unknown as KernelStorageNode[];
  const selectionKernels = selectionBuffers.map((selection, bufferIndex) =>
    Fn(() => {
      const candidateCount = mutable(uint(0).toVar());
      for (let slot = 0; slot < draw.maxLights; slot += 1) {
        const base = 1 + slot * 3;
        selection.element(uint(base) as never).assign(vec4(0, 0, 0, -1 - slot) as never);
        selection.element(uint(base + 1) as never).assign(vec4(0, 0, 0, 0) as never);
        selection.element(uint(base + 2) as never).assign(vec4(0, 0, 0, -1) as never);
      }
      Loop(
        {
          condition: '<',
          end: uint(program.attributeSchema.capacity),
          start: uint(0),
          type: 'uint',
        },
        ({ i }) => {
          const physical = asNode(uint(i));
          const intensity = logicalAttribute('intensity', physical);
          const radius = logicalAttribute('size', physical).mul(draw.radiusScale);
          const priority = draw.priority === 'intensity-radius' ? intensity.mul(radius) : intensity;
          const valid = logicalAttribute('alive', physical)
            .equal(uint(1) as never)
            .and(intensity.greaterThanEqual(0.000001))
            .and(radius.greaterThanEqual(0.000001));
          If(valid as never, () => {
            candidateCount.addAssign(uint(1) as never);
            const minimumPriority = mutable(float(1e30).toVar());
            const minimumSlot = mutable(uint(0).toVar());
            for (let slot = 0; slot < draw.maxLights; slot += 1) {
              const slotPriority = selection.element(uint(1 + slot * 3) as never).w;
              If(slotPriority.lessThan(minimumPriority) as never, () => {
                minimumPriority.assign(slotPriority);
                minimumSlot.assign(uint(slot));
              });
            }
            If(mutable(priority).greaterThan(minimumPriority) as never, () => {
              const base = minimumSlot.mul(asNode(uint(3))).add(asNode(uint(1)));
              const position = logicalAttribute('position', physical);
              const color = logicalAttribute('color', physical);
              selection
                .element(base as never)
                .assign(
                  vec4(
                    position.x as never,
                    position.y as never,
                    position.z as never,
                    priority as never,
                  ) as never,
                );
              selection
                .element(base.add(asNode(uint(1))) as never)
                .assign(
                  vec4(
                    color.r as never,
                    color.g as never,
                    color.b as never,
                    intensity as never,
                  ) as never,
                );
              selection
                .element(base.add(asNode(uint(2))) as never)
                .assign(vec4(radius as never, physical as never, 0, 0) as never);
            });
          });
        },
      );
      const selectedCount = select(
        candidateCount.greaterThanEqual(asNode(uint(draw.maxLights))) as never,
        uint(draw.maxLights),
        candidateCount as never,
      );
      selection
        .element(uint(0) as never)
        .assign(vec4(selectedCount as never, candidateCount as never, 0, 0) as never);
    })()
      .compute(1, [1])
      .setName(`NachiLightSelect${bufferIndex}`),
  );
  const group = new THREE.Group();
  group.name = 'NachiPointLightPool';
  const lights = Array.from({ length: draw.maxLights }, (_, index) => {
    const light = new THREE.PointLight(0xffffff, 0, 0, 2);
    light.name = `NachiPointLight${index}`;
    // Keep the visible-light id set stable. Toggling visibility changes r185 LightsNode's cache
    // key and recompiles a pipeline; intensity zero is the shader-stable off state.
    light.visible = true;
    group.add(light);
    return light;
  });
  let frame = 0;
  let pending: Promise<ArrayBuffer> | undefined;
  let warned = false;
  let disposed = false;
  let stats: ThreeLightSelectionStats = { candidateCount: 0, selected: [], selectedCount: 0 };
  const apply = (buffer: ArrayBuffer): ThreeLightSelectionStats => {
    const values = new Float32Array(buffer);
    const selectedCount = Math.min(draw.maxLights, Math.max(0, Math.round(values[0] ?? 0)));
    const candidateCount = Math.max(0, Math.round(values[1] ?? 0));
    const selected: ThreeLightSelectionStats['selected'][number][] = [];
    for (let slot = 0; slot < draw.maxLights; slot += 1) {
      const base = (1 + slot * 3) * 4;
      const priority = values[base + 3] ?? -1;
      if (priority < 0 || selected.length >= selectedCount) continue;
      const entry = {
        color: [values[base + 4] ?? 0, values[base + 5] ?? 0, values[base + 6] ?? 0] as const,
        intensity: values[base + 7] ?? 0,
        physicalIndex: Math.round(values[base + 9] ?? -1),
        position: [values[base] ?? 0, values[base + 1] ?? 0, values[base + 2] ?? 0] as const,
        priority,
        radius: values[base + 8] ?? 0,
      };
      selected.push(entry);
    }
    selected.sort(
      (left, right) => right.priority - left.priority || left.physicalIndex - right.physicalIndex,
    );
    for (let index = 0; index < lights.length; index += 1) {
      const light = lights[index]!;
      const entry = selected[index];
      light.visible = true;
      light.intensity = entry?.intensity ?? 0;
      light.distance = entry?.radius ?? 0;
      if (entry) {
        light.position.fromArray(entry.position);
        light.color.setRGB(...entry.color);
      }
    }
    if (candidateCount > draw.maxLights && !warned) {
      warned = true;
      options.onDiagnostic?.({
        code: 'NACHI_LIGHT_LIMIT_EXCEEDED',
        message: `${candidateCount} eligible particle lights exceeded maxLights ${draw.maxLights}; GPU intensity priority selected the bounded pool.`,
      });
    }
    stats = { candidateCount, selected, selectedCount: selected.length };
    return stats;
  };
  const result: ThreeLightPoolDraw = {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const light of lights) light.intensity = 0;
      group.removeFromParent();
    },
    group,
    lights,
    selectionBuffers,
    selectionKernels,
    get stats() {
      return stats;
    },
    async update(renderer, effectState = 'active') {
      if (effectState !== 'active') {
        result.dispose();
        return stats;
      }
      if (disposed) return stats;
      const index = frame % 2;
      frame += 1;
      const previous = pending;
      await renderer.computeAsync(selectionKernels[index] as never);
      pending = renderer.getArrayBufferAsync(selectionBuffers[index]!.value as never);
      return previous ? apply(await previous) : stats;
    },
  };
  return result;
}

export interface ThreeDecalMaterializationOptions {
  readonly resolveTexture?: ThreeTextureResolver;
  /** M6 linear, non-sRGB, previous-frame normalized depth copy. */
  readonly sceneDepthTexture: THREE.Texture;
}

/** Projection-box decal using WebGPU [0,1] NDC scene-depth world-position reconstruction. */
export function materializeThreeDecalDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeDecalMaterializationOptions,
): THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicNodeMaterial> {
  const draw = program.draws[drawIndex];
  if (!draw || draw.kind !== 'decal')
    throw new Error(`Compiled decal draw ${drawIndex} is missing.`);
  if (kernels.capabilityPath !== 'webgpu-atomic-indirect') {
    throw new Error('NACHI_DECAL_WEBGL2_UNSUPPORTED: Projection decals require WebGPU.');
  }
  if (!options.sceneDepthTexture) {
    throw new Error(
      'NACHI_DECAL_SCENE_DEPTH_UNAVAILABLE: A previous-frame depth copy is required.',
    );
  }
  if (!kernels.drawIndirect || kernels.drawIndirectOffsetBytes === undefined) {
    throw new Error('Compiled decal rendering requires the WebGPU indirect-draw lifecycle path.');
  }
  const { compactedIndex, logicalAttribute } = createThreeParticleVertexBindings(
    program,
    kernels,
    draw.indirect,
  );
  const center = logicalAttribute('position', compactedIndex);
  const quaternion = logicalAttribute('rotation', compactedIndex);
  const size = logicalAttribute('size', compactedIndex).mul(draw.sizeScale);
  const particleColor = asNode(varying(logicalAttribute('color', compactedIndex) as never));
  const normalizedAge = asNode(varying(logicalAttribute('normalizedAge', compactedIndex) as never));
  const fragmentCenter = asNode(varying(center as never));
  const fragmentQuaternion = asNode(varying(quaternion as never));
  const fragmentSize = asNode(varying(size as never));
  const sceneDepth = asNode(texture(options.sceneDepthTexture, screenUV)).r;
  const clip = asNode(
    vec4(
      asNode(screenUV.x).mul(2).sub(1) as never,
      asNode(float(1)).sub(asNode(screenUV.y).mul(2)) as never,
      sceneDepth as never,
      1,
    ),
  );
  const viewH = asNode(cameraProjectionMatrixInverse.mul(clip as never));
  const viewPosition = viewH.xyz.div(viewH.w);
  const worldPosition = asNode(cameraWorldMatrix.mul(vec4(viewPosition as never, 1))).xyz;
  const inverseQuaternion = asNode(
    vec4(
      fragmentQuaternion.x.mul(-1) as never,
      fragmentQuaternion.y.mul(-1) as never,
      fragmentQuaternion.z.mul(-1) as never,
      fragmentQuaternion.w as never,
    ),
  );
  const local = rotateByQuaternion(worldPosition.sub(fragmentCenter), inverseQuaternion);
  const halfSize = fragmentSize.mul(0.5);
  const inside = mutable(local.x)
    .abs()
    .lessThanEqual(halfSize)
    .and(mutable(local.y).abs().lessThanEqual(halfSize))
    .and(mutable(local.z).abs().lessThanEqual(halfSize))
    .and(sceneDepth.lessThan(0.999999));
  const decalUv = asNode(
    vec2(local.x.div(fragmentSize).add(0.5) as never, local.y.div(fragmentSize).add(0.5) as never),
  );
  let fragmentColor = particleColor;
  if (draw.fragment.map) {
    const map = options.resolveTexture?.(draw.fragment.map);
    if (!map)
      throw new Error(`No texture resolver supplied for decal map "${draw.fragment.map.uri}".`);
    fragmentColor = asNode(fragmentColor.mul(asNode(texture(map, decalUv as never))));
  }
  const lifeFade = draw.fadeOverLife
    ? asNode(float(1)).sub(normalizedAge).clamp(0, 1)
    : asNode(float(1));
  const opacity = asNode(select(inside as never, fragmentColor.a.mul(lifeFade) as never, float(0)));
  const material = new THREE.MeshBasicNodeMaterial({
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
    premultipliedAlpha: draw.fragment.blending === 'premultiplied',
    side: THREE.BackSide,
    transparent: true,
  });
  const localVertex = asNode(positionGeometry).mul(size);
  material.positionNode = rotateByQuaternion(localVertex, quaternion).add(center) as never;
  material.colorNode = fragmentColor.rgb as never;
  material.opacityNode = opacity as never;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const indirect = kernels.drawIndirect.indirectResource as THREE.IndirectStorageBufferAttribute;
  primeIndirectIndexCount(
    indirect,
    draw.indirect.drawArgumentsOffsetBytes,
    geometry.getIndex()?.count ?? 36,
  );
  geometry.setIndirect(indirect, draw.indirect.drawArgumentsOffsetBytes);
  const mesh = new THREE.InstancedMesh(geometry, material, program.attributeSchema.capacity);
  const identity = new THREE.Matrix4();
  for (let index = 0; index < program.attributeSchema.capacity; index += 1)
    mesh.setMatrixAt(index, identity);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

export async function readStorage(
  renderer: THREE.WebGPURenderer,
  storage: KernelStorageNode,
  type: 'float' | 'uint',
): Promise<Float32Array | Uint32Array> {
  const buffer = await renderer.getArrayBufferAsync(storage.value as never);
  return type === 'uint' ? new Uint32Array(buffer) : new Float32Array(buffer);
}

/** Readback helper used by smokes; returns the logical SoA view rather than packed vec4 storage. */
export async function readLogicalAttribute(
  renderer: THREE.WebGPURenderer,
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  name: string,
): Promise<Float32Array | Int32Array | Uint32Array> {
  const attribute = program.attributeSchema.byName[name];
  if (!attribute) throw new Error(`Logical attribute "${name}" is missing.`);
  const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
  const storageNode = storage === undefined ? undefined : kernels.storages[storage.name];
  if (!storage || !storageNode) throw new Error(`Physical storage for "${name}" is missing.`);
  const buffer = await renderer.getArrayBufferAsync(storageNode.value as never);
  const ArrayType =
    storage.componentType === 'uint'
      ? Uint32Array
      : storage.componentType === 'int'
        ? Int32Array
        : Float32Array;
  const physical = new ArrayType(buffer);
  const logical = new ArrayType(program.attributeSchema.capacity * attribute.components);
  const packedAddress = storage.packed
    ? resolvePackedAttributeAddress(attribute, storage)
    : undefined;
  for (let particle = 0; particle < program.attributeSchema.capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      const physicalComponent =
        attribute.logicalType === 'mat3'
          ? Math.floor(component / 3) * 4 + (component % 3)
          : component;
      const sourceIndex = storage.packed
        ? packedComponentIndex(particle, packedAddress!, component)
        : particle * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] + physicalComponent;
      logical[particle * attribute.components + component] = physical[sourceIndex] ?? 0;
    }
  }
  return logical;
}
