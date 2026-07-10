import type {
  BakedLut,
  BuiltEmitterKernels,
  CompiledEmitterProgram,
  KernelNode,
  KernelIndirectStorageNode,
  KernelStorageNode,
  KernelTslAdapter,
  KernelUniformNode,
  ParameterPath,
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
  atomicAdd,
  atomicStore,
  cos,
  cameraViewMatrix,
  float,
  instanceIndex,
  instancedArray,
  int,
  mat3,
  mat4,
  mx_atan2,
  sin,
  storage,
  texture,
  uv,
  uint,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export interface ThreeKernelAdapterOptions {
  readonly backend?: 'webgl2' | 'webgpu';
  readonly linearFloat32Filtering?: boolean;
  readonly maxStorageBuffersPerShaderStage?: number;
  readonly maxTransformFeedbackSeparateAttribs?: number;
}

export interface ThreeSpriteMaterializationOptions {
  readonly resolveTexture?: (uri: string) => THREE.Texture;
}

function asNode(value: unknown): KernelNode {
  return value as KernelNode;
}

function nodeLength(value: KernelNode): KernelNode {
  return (value as KernelNode & { length(): KernelNode }).length();
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
  const base: KernelTslAdapter = {
    capabilities: {
      atomics: options.backend !== 'webgl2',
      backend: options.backend ?? 'webgpu',
      indirectDispatch: options.backend !== 'webgl2',
      indirectDraw: options.backend !== 'webgl2',
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
      const node = storage(
        attribute,
        'uint',
        values.length,
      ) as unknown as KernelIndirectStorageNode;
      Object.defineProperty(node, 'indirectResource', { value: attribute });
      return node;
    },
    sampleTexture: (value, uv) => asNode(texture(value as THREE.Texture, uv as never)),
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
  return Object.keys(deviceLimits).length === 0 ? base : { ...base, deviceLimits };
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
  const base = {
    kernelAdapter,
    readStorage: (storageNode: KernelStorageNode) =>
      renderer.getArrayBufferAsync(storageNode.value as never),
    setUniformValue: setThreeUniformValue,
    ...(setInstanceCount === undefined ? {} : { setInstanceCount }),
    submitCompute: (kernel: Parameters<VfxRuntimeRenderer['submitCompute']>[0]) =>
      renderer.computeAsync(kernel as never),
    submitComputeIndirect: (
      kernel: Parameters<VfxRuntimeRenderer['submitCompute']>[0],
      indirectResource: unknown,
    ) => renderer.compute(kernel as never, indirectResource as never),
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

/** Materializes one compiler draw description without exposing physical packing to author code. */
export function materializeThreeSpriteDraw(
  program: CompiledEmitterProgram,
  kernels: BuiltEmitterKernels,
  drawIndex = 0,
  options: ThreeSpriteMaterializationOptions = {},
): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.SpriteNodeMaterial> {
  const draw = program.draws[drawIndex];
  if (!draw) throw new Error(`Compiled sprite draw ${drawIndex} is missing.`);
  if (!kernels.drawIndirect || kernels.drawIndirectOffsetBytes === undefined) {
    throw new Error('Compiled sprite rendering requires the WebGPU indirect-draw lifecycle path.');
  }
  if (draw.indirect.drawArgumentsOffsetBytes !== kernels.drawIndirectOffsetBytes) {
    throw new Error('Compiled draw and lifecycle indirect offsets disagree.');
  }

  const vertexStorages = program.attributeSchema.storageArrays.map((description) => {
    const computeStorage = kernels.storages[description.name];
    if (!computeStorage) throw new Error(`Sprite storage "${description.name}" is missing.`);
    return (
      storage(computeStorage.value as never, description.type, description.length) as unknown as {
        toReadOnly(): KernelStorageNode;
      }
    ).toReadOnly();
  });
  const lifecycleRead = (
    storage(
      kernels.aliveIndices.value as never,
      'uint',
      program.meta.lifecycleStorage.buffers.state.wordCount,
    ) as unknown as { toReadOnly(): KernelStorageNode }
  ).toReadOnly();

  const logicalAttribute = (name: string, physicalIndex: KernelNode): KernelNode => {
    const attribute = program.attributeSchema.byName[name];
    if (!attribute) throw new Error(`Sprite attribute "${name}" is missing.`);
    const storage = program.attributeSchema.storageArrays[attribute.physical.bufferIndex];
    const storageNode = storage === undefined ? undefined : vertexStorages[storage.index];
    if (!storage || !storageNode) throw new Error(`Sprite storage for "${name}" is missing.`);
    const address = storage.packed ? resolvePackedAttributeAddress(attribute, storage) : undefined;
    const index = storage.packed
      ? physicalIndex.mul(asNode(uint(address!.particleStride))).add(asNode(uint(address!.group)))
      : physicalIndex;
    const element = storageNode.element(index);
    if (!storage.packed) return element;
    const lanes = [element.x, element.y, element.z, element.w].slice(
      address!.offset,
      address!.offset + attribute.components,
    );
    if (attribute.components === 1) return lanes[0]!;
    if (attribute.components === 2) return asNode(vec2(lanes[0] as never, lanes[1] as never));
    if (attribute.components === 3) {
      return asNode(vec3(lanes[0] as never, lanes[1] as never, lanes[2] as never));
    }
    throw new Error(`Packed sprite attribute "${name}" has unsupported width.`);
  };

  const aliveIndex = asNode(uint(instanceIndex)).add(
    asNode(uint(draw.indirect.aliveIndicesOffsetWords)),
  );
  const compactedIndex = lifecycleRead.element(aliveIndex);
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
    const map = options.resolveTexture?.(draw.fragment.map.uri);
    if (!map) {
      throw new Error(`No texture resolver supplied for sprite map "${draw.fragment.map.uri}".`);
    }
    fragmentColor = fragmentColor.mul(asNode(texture(map, uv())));
  }
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
  material.opacityNode = fragmentColor.a as never;

  const geometry = new THREE.PlaneGeometry(1, 1);
  const indirect = kernels.drawIndirect.indirectResource as THREE.IndirectStorageBufferAttribute;
  const indirectWords = indirect.array as Uint32Array;
  const indexCountWord = draw.indirect.drawArgumentsOffsetBytes / Uint32Array.BYTES_PER_ELEMENT;
  indirectWords[indexCountWord] = draw.geometry.indexCount;
  indirect.needsUpdate = true;
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
