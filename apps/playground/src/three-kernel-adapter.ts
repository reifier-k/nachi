import type {
  BakedLut,
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
import { TSL_STORAGE_TYPE_PHYSICAL_LENGTHS } from '@nachi/core';
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  atomicAdd,
  atomicStore,
  cos,
  float,
  instanceIndex,
  instancedArray,
  int,
  mat3,
  mat4,
  sin,
  storage,
  texture,
  uint,
  uniform,
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

function asNode(value: unknown): KernelNode {
  return value as KernelNode;
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

export async function readStorage(
  renderer: THREE.WebGPURenderer,
  storage: KernelStorageNode,
  type: 'float' | 'uint',
): Promise<Float32Array | Uint32Array> {
  const buffer = await renderer.getArrayBufferAsync(storage.value as never);
  return type === 'uint' ? new Uint32Array(buffer) : new Float32Array(buffer);
}
