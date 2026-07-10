import * as THREE from 'three/webgpu';

type RendererOptions = NonNullable<ConstructorParameters<typeof THREE.WebGPURenderer>[0]>;
type PracticalLimitName =
  | 'maxBufferSize'
  | 'maxStorageBufferBindingSize'
  | 'maxStorageBuffersPerShaderStage';

type AdapterLike = {
  readonly limits: Readonly<Record<PracticalLimitName, number>>;
};

type NavigatorGpuLike = {
  requestAdapter(options?: Readonly<Record<string, unknown>>): Promise<AdapterLike | null>;
};

const PRACTICAL_LIMITS: readonly PracticalLimitName[] = [
  'maxStorageBuffersPerShaderStage',
  'maxStorageBufferBindingSize',
  'maxBufferSize',
];

async function adapterRequiredLimits(options: RendererOptions): Promise<Record<string, number>> {
  const gpu = (navigator as Navigator & { readonly gpu?: NavigatorGpuLike }).gpu;
  if (!gpu || options.forceWebGL) return {};

  const adapter = await gpu.requestAdapter({
    powerPreference: options.powerPreference,
    xrCompatible: false,
  });
  if (!adapter) return {};

  return Object.fromEntries(PRACTICAL_LIMITS.map((name) => [name, adapter.limits[name]]));
}

/** Creates Three's renderer while opting into the practical limits exposed by its WebGPU adapter. */
export async function createPlaygroundRenderer(
  options: RendererOptions = {},
): Promise<THREE.WebGPURenderer> {
  const supported = await adapterRequiredLimits(options);
  const requiredLimits = { ...supported };
  for (const [name, value] of Object.entries(options.requiredLimits ?? {})) {
    requiredLimits[name] = Math.max(requiredLimits[name] ?? 0, value);
  }
  return new THREE.WebGPURenderer({ ...options, requiredLimits });
}
