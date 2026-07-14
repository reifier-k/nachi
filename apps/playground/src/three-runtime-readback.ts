import type {
  BuiltEmitterKernels,
  CompiledEmitterProgram,
  KernelStorageNode,
} from '@nachi-vfx/core';
import { attributeStorageComponentIndex } from '@nachi-vfx/core';
import type * as THREE from 'three/webgpu';

/** Playground smoke helper; reads a raw GPU storage node without extending the public adapter API. */
export async function readStorage(
  renderer: THREE.WebGPURenderer,
  storage: KernelStorageNode,
  type: 'float' | 'uint',
): Promise<Float32Array | Uint32Array> {
  const buffer = await renderer.getArrayBufferAsync(storage.value as never);
  return type === 'uint' ? new Uint32Array(buffer) : new Float32Array(buffer);
}

/** Playground smoke helper; returns the logical SoA view rather than packed vec4 storage. */
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
  const backend = (renderer.backend as { readonly isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'webgpu'
    : 'webgl2';
  for (let particle = 0; particle < program.attributeSchema.capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      const sourceIndex = attributeStorageComponentIndex(
        attribute,
        storage,
        backend,
        particle,
        component,
      );
      logical[particle * attribute.components + component] = physical[sourceIndex] ?? 0;
    }
  }
  return logical;
}
