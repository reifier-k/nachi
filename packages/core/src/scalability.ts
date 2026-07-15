import type {
  EmitterDefinition,
  EmitterQualityTierOverride,
  EffectScalabilityStatus,
  QualityFeatureGates,
  QualityTier,
  RenderModule,
  Vec3,
} from './types.js';

export interface DeviceQualityProfile {
  readonly adapterInfo?: Readonly<Record<string, string>>;
  readonly backend: 'webgl2' | 'webgpu';
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface QualityTierSelection {
  readonly profile: DeviceQualityProfile;
  readonly reasons: readonly string[];
  readonly source: 'auto' | 'override';
  readonly tier: QualityTier;
}

export interface DetectDeviceQualityOptions {
  readonly adapter?: GpuAdapterLike;
  readonly fallbackBackend?: 'none' | 'webgl2';
  readonly gpu?: GpuEntryLike;
  readonly override?: QualityTier;
}

interface GpuAdapterLike {
  readonly features?: Iterable<string> | { has(name: string): boolean };
  readonly info?: Readonly<Record<string, unknown>>;
  readonly limits?: Readonly<Record<string, unknown>>;
}

interface GpuEntryLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

export interface ResolvedEmitterQuality {
  readonly capacityScale: number;
  readonly features: Required<QualityFeatureGates>;
  readonly spawnRateScale: number;
}

export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number;
}

export interface ScalabilityCamera {
  /** Clip-space depth convention. Omission preserves the WebGPU [0, 1] default. */
  readonly coordinateSystem?: 'webgl' | 'webgpu';
  readonly projectionMatrix: readonly number[];
  readonly viewMatrix: readonly number[];
  readonly viewportSize: readonly [number, number];
}

export interface SignificanceInput {
  readonly camera: ScalabilityCamera;
  readonly priority: number;
  readonly sphere: BoundingSphere;
}

const QUALITY_PRESETS: Readonly<Record<QualityTier, ResolvedEmitterQuality>> = {
  low: {
    capacityScale: 0.25,
    features: { lit: false, soft: false, sorted: false },
    spawnRateScale: 0.25,
  },
  medium: {
    capacityScale: 0.5,
    features: { lit: false, soft: true, sorted: false },
    spawnRateScale: 0.5,
  },
  high: {
    capacityScale: 0.75,
    features: { lit: true, soft: true, sorted: true },
    spawnRateScale: 0.75,
  },
  epic: {
    capacityScale: 1,
    features: { lit: true, soft: true, sorted: true },
    spawnRateScale: 1,
  },
};

const LIMIT_NAMES = [
  'maxBufferSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
] as const;

function finiteLimit(limits: Readonly<Record<string, unknown>> | undefined, name: string): number {
  const value = limits?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function featureNames(features: GpuAdapterLike['features']): string[] {
  if (!features) return [];
  if (Symbol.iterator in Object(features)) return [...(features as Iterable<string>)].sort();
  const featureSet = features as { has(name: string): boolean };
  return ['shader-f16', 'timestamp-query'].filter((name) => featureSet.has(name));
}

function adapterProfile(adapter: GpuAdapterLike): DeviceQualityProfile {
  const adapterInfo = Object.fromEntries(
    Object.entries(adapter.info ?? {}).flatMap(([key, value]) =>
      typeof value === 'string' && value.length > 0 ? [[key, value]] : [],
    ),
  );
  return {
    ...(Object.keys(adapterInfo).length === 0 ? {} : { adapterInfo }),
    backend: 'webgpu',
    features: featureNames(adapter.features),
    limits: Object.fromEntries(
      LIMIT_NAMES.map((name) => [name, finiteLimit(adapter.limits, name)]),
    ),
  };
}

export function selectDeviceQualityTier(profile: DeviceQualityProfile): QualityTierSelection {
  if (profile.backend === 'webgl2') {
    return {
      profile,
      reasons: ['WebGL2 fallback has no atomic/indirect lifecycle parity; selecting low.'],
      source: 'auto',
      tier: 'low',
    };
  }
  const bindingSize = profile.limits.maxStorageBufferBindingSize ?? 0;
  const invocations = profile.limits.maxComputeInvocationsPerWorkgroup ?? 0;
  const buffers = profile.limits.maxStorageBuffersPerShaderStage ?? 0;
  const timestamp = profile.features.includes('timestamp-query');
  const f16 = profile.features.includes('shader-f16');
  if (bindingSize >= 256 * 1024 * 1024 && invocations >= 512 && buffers >= 10 && timestamp && f16) {
    return {
      profile,
      reasons: ['Large storage limits plus timestamp-query and shader-f16 qualify for epic.'],
      source: 'auto',
      tier: 'epic',
    };
  }
  if (bindingSize >= 128 * 1024 * 1024 && invocations >= 256 && buffers >= 8 && timestamp) {
    return {
      profile,
      reasons: [
        'WebGPU default-or-better storage/compute limits with timestamps qualify for high.',
      ],
      source: 'auto',
      tier: 'high',
    };
  }
  return {
    profile,
    reasons: [
      'WebGPU is available, but optional high-tier limit/feature thresholds were not all met; selecting medium.',
    ],
    source: 'auto',
    tier: 'medium',
  };
}

export async function detectDeviceQualityTier(
  options: DetectDeviceQualityOptions = {},
): Promise<QualityTierSelection> {
  if (options.override) {
    return {
      profile: options.adapter
        ? adapterProfile(options.adapter)
        : {
            backend: options.fallbackBackend === 'webgl2' ? 'webgl2' : 'webgpu',
            features: [],
            limits: {},
          },
      reasons: [`Explicit quality override selected ${options.override}.`],
      source: 'override',
      tier: options.override,
    };
  }
  const globalGpu = (globalThis.navigator as unknown as { gpu?: GpuEntryLike } | undefined)?.gpu;
  const adapter = options.adapter ?? (await (options.gpu ?? globalGpu)?.requestAdapter());
  if (adapter) return selectDeviceQualityTier(adapterProfile(adapter));
  const profile: DeviceQualityProfile = {
    backend: 'webgl2',
    features: [],
    limits: {},
  };
  return {
    ...selectDeviceQualityTier(profile),
    reasons: [
      options.fallbackBackend === 'none'
        ? 'No WebGPU adapter or declared WebGL2 fallback was available; selecting low.'
        : 'No WebGPU adapter was available; WebGL2 fallback selects low.',
    ],
  };
}

function qualityScale(value: number | undefined, fallback: number, path: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new RangeError(`${path} must be a finite number in [0, 1].`);
  }
  return resolved;
}

export function resolveEmitterQuality(
  definition: EmitterDefinition,
  tier: QualityTier,
): ResolvedEmitterQuality {
  const preset = QUALITY_PRESETS[tier];
  const override: EmitterQualityTierOverride = definition.quality?.[tier] ?? {};
  return {
    capacityScale: qualityScale(
      override.capacityScale,
      preset.capacityScale,
      `quality.${tier}.capacityScale`,
    ),
    features: {
      lit: override.features?.lit ?? preset.features.lit,
      soft: override.features?.soft ?? preset.features.soft,
      sorted: override.features?.sorted ?? preset.features.sorted,
    },
    spawnRateScale: qualityScale(
      override.spawnRateScale,
      preset.spawnRateScale,
      `quality.${tier}.spawnRateScale`,
    ),
  };
}

function gateRender(module: RenderModule, gates: Required<QualityFeatureGates>): RenderModule {
  if (
    module.type !== 'core/billboard' &&
    module.type !== 'core/mesh-renderer' &&
    module.type !== 'core/decal-renderer'
  )
    return module;
  const config = module.config as Readonly<Record<string, unknown>>;
  const blending = config.blending ?? 'alpha';
  const defaultSorted =
    module.type === 'core/decal-renderer' || blending === 'alpha' || blending === 'premultiplied';
  const preserveUnsupportedExplicitSort =
    module.version === 2 &&
    config.sorted === true &&
    (blending === 'additive' || blending === 'multiply');
  const sorted =
    module.version === 1 && module.type === 'core/decal-renderer'
      ? undefined
      : config.sorted === undefined
        ? module.version === 1
          ? undefined
          : defaultSorted && gates.sorted
        : typeof config.sorted === 'boolean'
          ? preserveUnsupportedExplicitSort || (config.sorted && gates.sorted)
          : config.sorted;
  return {
    ...module,
    config: {
      ...config,
      ...(module.type === 'core/decal-renderer' || config.lit === undefined || gates.lit
        ? {}
        : { lit: false }),
      ...(module.type === 'core/decal-renderer' || config.soft === undefined || gates.soft
        ? {}
        : { soft: false }),
      ...(sorted === undefined ? {} : { sorted }),
    },
  };
}

/** Applies only structural feature gates. Capacity and spawn scales remain runtime values. */
export function applyEmitterQualityTier(
  definition: EmitterDefinition,
  tier: QualityTier,
): EmitterDefinition {
  const resolved = resolveEmitterQuality(definition, tier);
  const render = Array.isArray(definition.render)
    ? definition.render.map((module) => gateRender(module, resolved.features))
    : gateRender(definition.render as RenderModule, resolved.features);
  return { ...definition, render };
}

export function qualityStructuralKey(definition: EmitterDefinition, tier: QualityTier): string {
  const effective = applyEmitterQualityTier(definition, tier);
  const render = Array.isArray(effective.render) ? effective.render : [effective.render];
  return JSON.stringify(
    render.map(({ config, type, version }) => ({
      config,
      type,
      version,
    })),
  );
}

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

export function transformBoundingSphere(
  sphere: BoundingSphere,
  matrix: readonly number[],
): BoundingSphere {
  const scale = Math.max(
    Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!),
    Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!),
    Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!),
  );
  return { center: transformPoint(matrix, sphere.center), radius: sphere.radius * scale };
}

export function mergeBoundingSpheres(spheres: readonly BoundingSphere[]): BoundingSphere {
  if (spheres.length === 0) return { center: [0, 0, 0], radius: 1_000 };
  let result = spheres[0]!;
  for (const sphere of spheres.slice(1)) {
    const dx = sphere.center[0] - result.center[0];
    const dy = sphere.center[1] - result.center[1];
    const dz = sphere.center[2] - result.center[2];
    const distance = Math.hypot(dx, dy, dz);
    if (result.radius >= distance + sphere.radius) continue;
    if (sphere.radius >= distance + result.radius) {
      result = sphere;
      continue;
    }
    const radius = (distance + result.radius + sphere.radius) / 2;
    const shift = distance === 0 ? 0 : (radius - result.radius) / distance;
    result = {
      center: [
        result.center[0] + dx * shift,
        result.center[1] + dy * shift,
        result.center[2] + dz * shift,
      ],
      radius,
    };
  }
  return result;
}

export function viewSpaceSphere(sphere: BoundingSphere, viewMatrix: readonly number[]) {
  const center = transformPoint(viewMatrix, sphere.center);
  return { center, distance: Math.hypot(...center), radius: sphere.radius };
}

export function sphereIntersectsFrustum(
  sphere: BoundingSphere,
  camera: ScalabilityCamera,
): boolean {
  const view = viewSpaceSphere(sphere, camera.viewMatrix);
  const [x, y, z] = view.center;
  const p = camera.projectionMatrix;
  const sidePlanes = [
    [p[3]! + p[0]!, p[7]! + p[4]!, p[11]! + p[8]!, p[15]! + p[12]!],
    [p[3]! - p[0]!, p[7]! - p[4]!, p[11]! - p[8]!, p[15]! - p[12]!],
    [p[3]! + p[1]!, p[7]! + p[5]!, p[11]! + p[9]!, p[15]! + p[13]!],
    [p[3]! - p[1]!, p[7]! - p[5]!, p[11]! - p[9]!, p[15]! - p[13]!],
  ];
  const depthPlanes =
    camera.coordinateSystem === 'webgl'
      ? [
          // WebGL clip depth is -W <= Z <= W.
          [p[3]! + p[2]!, p[7]! + p[6]!, p[11]! + p[10]!, p[15]! + p[14]!],
          [p[3]! - p[2]!, p[7]! - p[6]!, p[11]! - p[10]!, p[15]! - p[14]!],
        ]
      : [
          // WebGPU clip depth is 0 <= Z <= W.
          [p[2]!, p[6]!, p[10]!, p[14]!],
          [p[3]! - p[2]!, p[7]! - p[6]!, p[11]! - p[10]!, p[15]! - p[14]!],
        ];
  const planes = [...sidePlanes, ...depthPlanes];
  return planes.every(([a = 0, b = 0, c = 0, d = 0]) => {
    const signedDistance = a * x + b * y + c * z + d;
    return signedDistance >= -sphere.radius * Math.hypot(a, b, c);
  });
}

export function significanceScore(
  input: SignificanceInput,
): EffectScalabilityStatus['significance'] & {
  readonly score: number;
} {
  const view = viewSpaceSphere(input.sphere, input.camera.viewMatrix);
  const distanceScore = 1 / (1 + view.distance);
  const projectedRadius =
    (Math.abs(input.camera.projectionMatrix[5] ?? 1) * input.sphere.radius) /
    Math.max(Math.abs(view.center[2]), input.sphere.radius, 1e-6);
  const screenOccupancy = Math.min(1, projectedRadius * projectedRadius);
  const priorityScore = input.priority * 4;
  const screenScore = screenOccupancy * 2;
  return {
    distance: view.distance,
    distanceScore,
    priority: input.priority,
    priorityScore,
    score: priorityScore + screenScore + distanceScore,
    screenOccupancy,
    screenScore,
  };
}
