import { MAX_PBD_ITERATIONS } from './limits.js';
import type {
  BillboardOptions,
  BoidsOptions,
  DecalRendererOptions,
  MeshRendererOptions,
  PbdDistanceConstraintOptions,
  VfxDiagnostic,
} from './types.js';

function diagnostic(
  code: string,
  message: string,
  path: string,
  severity: 'error' | 'warning' = 'error',
): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity };
}

function fieldPath(path: string, field: string): string {
  return field.length === 0 ? path : `${path}.${field}`;
}

function staticScalarMinimum(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'range' && 'min' in value && typeof value.min === 'number') return value.min;
  if (value.kind === 'parameter' && 'fallback' in value && typeof value.fallback === 'number') {
    return value.fallback;
  }
  return undefined;
}

function staticScalarMaximum(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'range' && 'max' in value && typeof value.max === 'number') return value.max;
  if (value.kind === 'parameter' && 'fallback' in value && typeof value.fallback === 'number') {
    return value.fallback;
  }
  return undefined;
}

function isFiniteVector(value: unknown, length: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function staticGeneratorValues(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [value];
  if (!('kind' in value)) return [value];
  if (value.kind === 'range') {
    return ['min' in value ? value.min : undefined, 'max' in value ? value.max : undefined];
  }
  if (value.kind === 'parameter') {
    return 'fallback' in value && value.fallback !== undefined ? [value.fallback] : [];
  }
  if (value.kind === 'curve' && 'keys' in value && Array.isArray(value.keys)) {
    return value.keys.map((key) =>
      typeof key === 'object' && key !== null && 'value' in key ? key.value : undefined,
    );
  }
  return [value];
}

function isStaticFiniteVectorInput(value: unknown, length: number): boolean {
  return staticGeneratorValues(value).every((candidate) => isFiniteVector(candidate, length));
}

function isStaticScalarInRange(value: unknown, exclusiveMinimum: number, maximum: number): boolean {
  const candidates = staticGeneratorValues(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'range' &&
    candidates.length === 2 &&
    typeof candidates[0] === 'number' &&
    typeof candidates[1] === 'number' &&
    candidates[0] > candidates[1]
  ) {
    return false;
  }
  return candidates.every(
    (candidate) =>
      typeof candidate === 'number' &&
      Number.isFinite(candidate) &&
      candidate > exclusiveMinimum &&
      candidate <= maximum,
  );
}

/** Static emitter constraints shared by defineEmitter() and direct compiler input. */
export function collectEmitterOffsetDiagnostics(offset: unknown, path = 'offset'): VfxDiagnostic[] {
  if (offset === undefined || isFiniteVector(offset, 3)) return [];
  return [
    diagnostic('NACHI_EMITTER_OFFSET_INVALID', 'Emitter offset must be a finite vec3.', path),
  ];
}

function validateStaticScalarRange(value: unknown, minimum: number, maximum: number): boolean {
  const staticMinimum = staticScalarMinimum(value);
  const staticMaximum = staticScalarMaximum(value);
  return !(
    (staticMinimum !== undefined && (!Number.isFinite(staticMinimum) || staticMinimum < minimum)) ||
    (staticMaximum !== undefined && (!Number.isFinite(staticMaximum) || staticMaximum > maximum))
  );
}

function collectBurstDiagnostics(
  config: Readonly<Record<string, unknown>>,
  path: string,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const invalidCount = (value: unknown): boolean =>
    typeof value !== 'number' || !Number.isFinite(value) || value < 0;
  let countInvalid = false;
  if (typeof config.count === 'object' && config.count !== null && 'kind' in config.count) {
    if (config.count.kind === 'range') {
      const range = config.count as { max?: unknown; min?: unknown };
      countInvalid =
        invalidCount(range.min) ||
        invalidCount(range.max) ||
        (range.min as number) > (range.max as number);
    } else if (config.count.kind === 'parameter') {
      const generator = config.count as { fallback?: unknown };
      countInvalid = generator.fallback !== undefined && invalidCount(generator.fallback);
    } else {
      countInvalid = true;
    }
  } else {
    countInvalid = invalidCount(config.count);
  }
  if (countInvalid) {
    diagnostics.push(
      diagnostic(
        'NACHI_BURST_COUNT_INVALID',
        'Burst count must be a non-negative finite number or a valid range/parameter generator.',
        fieldPath(path, 'count'),
      ),
    );
  }
  if (
    config.cycles !== undefined &&
    (!Number.isSafeInteger(config.cycles) || (config.cycles as number) <= 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BURST_CYCLES_INVALID',
        'Burst cycles must be a positive safe integer.',
        fieldPath(path, 'cycles'),
      ),
    );
  }
  if (
    config.interval !== undefined &&
    (typeof config.interval !== 'number' ||
      !Number.isFinite(config.interval) ||
      config.interval <= 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BURST_INTERVAL_INVALID',
        'Burst interval must be a positive finite number.',
        fieldPath(path, 'interval'),
      ),
    );
  }
  if (config.cycles !== undefined && config.cycles !== 1 && config.interval === undefined) {
    diagnostics.push(
      diagnostic(
        'NACHI_BURST_INTERVAL_REQUIRED',
        'Burst interval is required when cycles is greater than one.',
        fieldPath(path, 'interval'),
      ),
    );
  }
  return diagnostics;
}

function collectBehaviorDiagnostics(
  type: string,
  config: Readonly<Record<string, unknown>>,
  path: string,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  if (type === 'core/position-sphere') {
    if (config.center !== undefined && !isStaticFiniteVectorInput(config.center, 3)) {
      diagnostics.push(
        diagnostic(
          'NACHI_POSITION_SPHERE_CENTER_INVALID',
          'Position-sphere center must resolve to a finite vec3.',
          fieldPath(path, 'center'),
        ),
      );
    }
    if (config.arc !== undefined) {
      const arc = config.arc;
      if (typeof arc !== 'object' || arc === null || Array.isArray(arc)) {
        diagnostics.push(
          diagnostic(
            'NACHI_POSITION_SPHERE_ARC_THETA_INVALID',
            'Position-sphere arc thetaMax must remain within (0, 180] degrees.',
            fieldPath(path, 'arc.thetaMax'),
          ),
        );
      } else {
        const arcConfig = arc as Readonly<Record<string, unknown>>;
        if (!isStaticScalarInRange(arcConfig.thetaMax, 0, 180)) {
          diagnostics.push(
            diagnostic(
              'NACHI_POSITION_SPHERE_ARC_THETA_INVALID',
              'Position-sphere arc thetaMax must remain within (0, 180] degrees.',
              fieldPath(path, 'arc.thetaMax'),
            ),
          );
        }
        if (
          arcConfig.axis !== undefined &&
          (!isFiniteVector(arcConfig.axis, 3) || Math.hypot(...arcConfig.axis) === 0)
        ) {
          diagnostics.push(
            diagnostic(
              'NACHI_POSITION_SPHERE_ARC_AXIS_INVALID',
              'Position-sphere arc axis must be a finite non-zero vec3.',
              fieldPath(path, 'arc.axis'),
            ),
          );
        }
      }
    }
  }
  if (type.startsWith('core/collide-')) {
    for (const coefficient of ['bounce', 'friction'] as const) {
      if (!validateStaticScalarRange(config[coefficient], 0, 1)) {
        diagnostics.push(
          diagnostic(
            'NACHI_COLLISION_RESPONSE_INVALID',
            `Collision ${coefficient} must remain within the inclusive range [0, 1].`,
            fieldPath(path, coefficient),
          ),
        );
      }
    }
  }

  if (type === 'core/collide-plane') {
    const normal = config.normal;
    if (!isFiniteVector(normal, 3) || Math.hypot(...normal) === 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_PLANE_NORMAL_INVALID',
          'Collision plane normal must be a finite non-zero vec3.',
          fieldPath(path, 'normal'),
        ),
      );
    }
  } else if (type === 'core/collide-sphere') {
    const radius = staticScalarMinimum(config.radius);
    if (radius !== undefined && (!Number.isFinite(radius) || radius <= 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_SPHERE_RADIUS_INVALID',
          'Collision sphere radius must be positive and finite.',
          fieldPath(path, 'radius'),
        ),
      );
    }
  } else if (type === 'core/collide-box') {
    const size = config.size;
    if (
      Array.isArray(size) &&
      (!isFiniteVector(size, 3) || size.some((component) => component <= 0))
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_BOX_SIZE_INVALID',
          'Collision box size must be a finite vec3 with positive components.',
          fieldPath(path, 'size'),
        ),
      );
    }
  } else if (type === 'core/collide-scene-depth') {
    const surfaceOffset = staticScalarMinimum(config.surfaceOffset);
    if (surfaceOffset !== undefined && (!Number.isFinite(surfaceOffset) || surfaceOffset < 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_DEPTH_OFFSET_INVALID',
          'Scene-depth collision surfaceOffset must be non-negative and finite.',
          fieldPath(path, 'surfaceOffset'),
        ),
      );
    }
    const thickness = staticScalarMinimum(config.thickness);
    if (thickness !== undefined && (!Number.isFinite(thickness) || thickness <= 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_DEPTH_THICKNESS_INVALID',
          'Scene-depth collision thickness must be positive and finite.',
          fieldPath(path, 'thickness'),
        ),
      );
    }
  } else if (type === 'core/collide-sdf') {
    const thickness = staticScalarMinimum(config.thickness);
    if (thickness !== undefined && (!Number.isFinite(thickness) || thickness <= 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_COLLISION_SDF_THICKNESS_INVALID',
          'SDF collision thickness must be positive and finite.',
          fieldPath(path, 'thickness'),
        ),
      );
    }
  }

  if (type === 'core/velocity-cone') {
    const direction = config.direction;
    if (!isFiniteVector(direction, 3) || Math.hypot(...direction) === 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_VELOCITY_CONE_DIRECTION_INVALID',
          'Velocity-cone direction must be a finite non-zero vec3.',
          fieldPath(path, 'direction'),
        ),
      );
    }
  }

  if (type === 'core/vortex') {
    const axis = config.axis;
    if (!isFiniteVector(axis, 3) || Math.hypot(...axis) === 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_VORTEX_AXIS_INVALID',
          'Vortex axis must be a finite non-zero vec3.',
          fieldPath(path, 'axis'),
        ),
      );
    }
  }

  if (type === 'core/curl-noise' || type === 'core/turbulence') {
    const frequency = staticScalarMinimum(config.frequency);
    if (frequency !== undefined && (!Number.isFinite(frequency) || frequency <= 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_FORCE_FREQUENCY_INVALID',
          `${type} frequency must remain positive and finite.`,
          fieldPath(path, 'frequency'),
        ),
      );
    }
  }

  if (type === 'core/point-attractor') {
    const radius = staticScalarMinimum(config.radius);
    if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) {
      diagnostics.push(
        diagnostic(
          'NACHI_POINT_ATTRACTOR_RADIUS_INVALID',
          'Point-attractor radius must be a non-negative finite number.',
          fieldPath(path, 'radius'),
        ),
      );
    }
  }

  if (type === 'core/kill-volume') {
    if (config.shape === 'plane') {
      const normal = config.normal;
      if (!isFiniteVector(normal, 3) || Math.hypot(...normal) === 0) {
        diagnostics.push(
          diagnostic(
            'NACHI_KILL_VOLUME_NORMAL_INVALID',
            'Kill-volume plane normal must be a finite non-zero vec3.',
            fieldPath(path, 'normal'),
          ),
        );
      }
    } else if (config.shape === 'sphere') {
      const radius = staticScalarMinimum(config.radius);
      if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) {
        diagnostics.push(
          diagnostic(
            'NACHI_KILL_VOLUME_RADIUS_INVALID',
            'Kill-volume sphere radius must be a non-negative finite number.',
            fieldPath(path, 'radius'),
          ),
        );
      }
    } else if (config.shape === 'box') {
      const size = config.size;
      if (
        Array.isArray(size) &&
        (!isFiniteVector(size, 3) || size.some((component) => component <= 0))
      ) {
        diagnostics.push(
          diagnostic(
            'NACHI_KILL_VOLUME_SIZE_INVALID',
            'Kill-volume box size must be a finite vec3 with positive components.',
            fieldPath(path, 'size'),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function collectNeighborDiagnostics(
  type: string,
  config: Readonly<Record<string, unknown>>,
  path: string,
): VfxDiagnostic[] {
  if (
    type !== 'core/boids' &&
    type !== 'core/pbd-distance-constraint' &&
    type !== 'core/neighbor-grid-tsl'
  ) {
    return [];
  }
  const diagnostics: VfxDiagnostic[] = [];
  const radius = config.radius;
  if (radius !== undefined && (!Number.isSafeInteger(radius) || (radius as number) < 0)) {
    diagnostics.push(
      diagnostic(
        'NACHI_NEIGHBOR_GRID_RADIUS_INVALID',
        'NeighborGrid search radius must be a non-negative safe integer in cell units.',
        fieldPath(path, 'radius'),
      ),
    );
  }
  if (type === 'core/boids') {
    const flock = config as unknown as BoidsOptions;
    for (const field of ['alignment', 'cohesion', 'maxAcceleration', 'separation'] as const) {
      if (flock[field] !== undefined && !Number.isFinite(flock[field])) {
        diagnostics.push(
          diagnostic(
            'NACHI_BOIDS_VALUE_INVALID',
            `Boids ${field} must be finite.`,
            fieldPath(path, field),
          ),
        );
      }
    }
    if (
      flock.separationRadius !== undefined &&
      (!Number.isFinite(flock.separationRadius) || flock.separationRadius < 0)
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_BOIDS_VALUE_INVALID',
          'Boids separationRadius must be finite and non-negative in cell units.',
          fieldPath(path, 'separationRadius'),
        ),
      );
    }
    const searchRadius = flock.radius ?? 1;
    if (
      flock.separationRadius !== undefined &&
      Number.isFinite(flock.separationRadius) &&
      flock.separationRadius >= 0 &&
      Number.isSafeInteger(searchRadius) &&
      searchRadius >= 0 &&
      flock.separationRadius > searchRadius
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_BOIDS_SEPARATION_RADIUS_EXCEEDS_SEARCH',
          `Boids separationRadius ${flock.separationRadius} exceeds the search radius ${searchRadius}; separation is limited to neighbors inside the search radius.`,
          fieldPath(path, 'separationRadius'),
          'warning',
        ),
      );
    }
  }
  if (type === 'core/pbd-distance-constraint') {
    const pbd = config as unknown as PbdDistanceConstraintOptions;
    if (!Number.isFinite(pbd.distance) || pbd.distance <= 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_PBD_DISTANCE_INVALID',
          'PBD constraint distance must be positive and finite.',
          fieldPath(path, 'distance'),
        ),
      );
    }
    if (!Number.isSafeInteger(pbd.iterations ?? 1) || (pbd.iterations ?? 1) <= 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_PBD_ITERATIONS_INVALID',
          'PBD iterations must be a positive safe integer.',
          fieldPath(path, 'iterations'),
        ),
      );
    } else if ((pbd.iterations ?? 1) > MAX_PBD_ITERATIONS) {
      diagnostics.push(
        diagnostic(
          'NACHI_PBD_ITERATIONS_LIMIT_EXCEEDED',
          `PBD iterations must not exceed ${MAX_PBD_ITERATIONS}.`,
          fieldPath(path, 'iterations'),
        ),
      );
    }
    if (
      !Number.isFinite(pbd.stiffness ?? 1) ||
      (pbd.stiffness ?? 1) < 0 ||
      (pbd.stiffness ?? 1) > 1
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_PBD_STIFFNESS_INVALID',
          'PBD stiffness must be finite in [0, 1].',
          fieldPath(path, 'stiffness'),
        ),
      );
    }
  }
  return diagnostics;
}

function collectBillboardDiagnostics(config: BillboardOptions, path: string): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const blending = config.blending ?? 'alpha';
  if (!['additive', 'alpha', 'multiply', 'premultiplied'].includes(blending)) {
    diagnostics.push(
      diagnostic(
        'NACHI_RENDER_BLENDING_INVALID',
        'Billboard blending must be "additive", "alpha", "multiply", or "premultiplied".',
        fieldPath(path, 'blending'),
      ),
    );
  }
  if (config.sortCenter !== undefined && !isFiniteVector(config.sortCenter, 3)) {
    diagnostics.push(
      diagnostic(
        'NACHI_PARTICLE_SORT_CENTER_INVALID',
        'Emitter sortCenter must be a finite local-space vec3.',
        fieldPath(path, 'sortCenter'),
      ),
    );
  }
  if (config.sorted === true && blending !== 'alpha' && blending !== 'premultiplied') {
    diagnostics.push(
      diagnostic(
        'NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED',
        'Particle depth sorting is only meaningful for alpha or premultiplied blending.',
        fieldPath(path, 'sorted'),
      ),
    );
  }
  const alignment = config.alignment ?? { mode: 'camera-facing' as const };
  if (
    alignment.mode === 'custom-axis' &&
    (!isFiniteVector(alignment.axis, 3) || Math.hypot(...alignment.axis) === 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_AXIS_INVALID',
        'Billboard custom alignment axis must be a finite, non-zero vec3.',
        fieldPath(path, 'alignment.axis'),
      ),
    );
  }
  if (
    alignment.mode === 'velocity-stretch' &&
    alignment.factor !== undefined &&
    (!Number.isFinite(alignment.factor) || alignment.factor < 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_STRETCH_INVALID',
        'Billboard velocity stretch factor must be a non-negative finite number.',
        fieldPath(path, 'alignment.factor'),
      ),
    );
  }
  const cutoutVertices = config.cutout?.vertices ?? 4;
  if (!Number.isInteger(cutoutVertices) || cutoutVertices < 4 || cutoutVertices > 8) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_CUTOUT_VERTICES_INVALID',
        'Billboard cutout vertices must be an integer from 4 through 8.',
        fieldPath(path, 'cutout.vertices'),
      ),
    );
  }
  const litOptions = typeof config.lit === 'object' ? config.lit : undefined;
  if (
    litOptions?.metalness !== undefined &&
    (!Number.isFinite(litOptions.metalness) || litOptions.metalness < 0 || litOptions.metalness > 1)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_LIT_METALNESS_INVALID',
        'Lit billboard metalness must be a finite number from zero through one.',
        fieldPath(path, 'lit.metalness'),
      ),
    );
  }
  if (
    litOptions?.roughness !== undefined &&
    (!Number.isFinite(litOptions.roughness) || litOptions.roughness < 0 || litOptions.roughness > 1)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_LIT_ROUGHNESS_INVALID',
        'Lit billboard roughness must be a finite number from zero through one.',
        fieldPath(path, 'lit.roughness'),
      ),
    );
  }
  const flipbook = config.map?.kind === 'flipbook' ? config.map : undefined;
  if (
    flipbook &&
    (!Number.isSafeInteger(flipbook.cols) ||
      flipbook.cols <= 0 ||
      !Number.isSafeInteger(flipbook.rows) ||
      flipbook.rows <= 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_FLIPBOOK_GRID_INVALID',
        'Flipbook cols and rows must be positive safe integers.',
        fieldPath(path, 'map'),
      ),
    );
  }
  if (flipbook?.motionVectors === true && flipbook.interpolate !== false) {
    diagnostics.push(
      diagnostic(
        'NACHI_FLIPBOOK_MOTION_VECTOR_FALLBACK',
        'Flipbook motion-vector blending was requested without a motion-vector TextureRef; using plain frame interpolation.',
        fieldPath(path, 'map.motionVectors'),
        'warning',
      ),
    );
  }
  if (flipbook?.motionVectors && flipbook.interpolate === false) {
    diagnostics.push(
      diagnostic(
        'NACHI_FLIPBOOK_MOTION_VECTORS_IGNORED',
        'Flipbook motion vectors require frame interpolation and are ignored when interpolate is false.',
        fieldPath(path, 'map.motionVectors'),
        'warning',
      ),
    );
  }
  const softFadeDistance =
    config.soft === true
      ? undefined
      : typeof config.soft === 'object'
        ? config.soft.fadeDistance
        : undefined;
  if (
    softFadeDistance !== undefined &&
    (!Number.isFinite(softFadeDistance) || softFadeDistance <= 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_BILLBOARD_SOFT_DISTANCE_INVALID',
        'Billboard soft fadeDistance must be a positive finite number.',
        fieldPath(path, 'soft.fadeDistance'),
      ),
    );
  }
  return diagnostics;
}

function collectMeshDiagnostics(config: MeshRendererOptions, path: string): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const blending = config.blending ?? 'alpha';
  if (!['additive', 'alpha', 'multiply', 'premultiplied'].includes(blending)) {
    diagnostics.push(
      diagnostic(
        'NACHI_RENDER_BLENDING_INVALID',
        'Mesh renderer blending must be "additive", "alpha", "multiply", or "premultiplied".',
        fieldPath(path, 'blending'),
      ),
    );
  }
  if (config.sortCenter !== undefined && !isFiniteVector(config.sortCenter, 3)) {
    diagnostics.push(
      diagnostic(
        'NACHI_PARTICLE_SORT_CENTER_INVALID',
        'Emitter sortCenter must be a finite local-space vec3.',
        fieldPath(path, 'sortCenter'),
      ),
    );
  }
  if (config.sorted === true && blending !== 'alpha' && blending !== 'premultiplied') {
    diagnostics.push(
      diagnostic(
        'NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED',
        'Particle depth sorting is only meaningful for alpha or premultiplied blending.',
        fieldPath(path, 'sorted'),
      ),
    );
  }
  const alignment = config.alignment ?? { mode: 'none' as const };
  if (
    alignment.mode === 'custom-axis' &&
    (!isFiniteVector(alignment.axis, 3) || Math.hypot(...alignment.axis) === 0)
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_MESH_AXIS_INVALID',
        'Mesh renderer custom alignment axis must be a finite, non-zero vec3.',
        fieldPath(path, 'alignment.axis'),
      ),
    );
  }
  if (
    config.geometry.kind !== 'asset-ref' ||
    config.geometry.assetType !== 'geometry' ||
    config.geometry.uri.length === 0
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_MESH_GEOMETRY_INVALID',
        'Mesh renderer geometry must be a non-empty GeometryRef.',
        fieldPath(path, 'geometry'),
      ),
    );
  }
  return diagnostics;
}

/** Static module constraints shared by authoring factories and compile-time JSON validation. */
export function collectCoreModuleConfigDiagnostics(
  type: string,
  config: Readonly<Record<string, unknown>>,
  path: string,
): VfxDiagnostic[] {
  if (type === 'core/burst') return collectBurstDiagnostics(config, path);
  if (type === 'core/rate' || type === 'core/per-distance') {
    const rate = config.rate;
    return typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0
      ? [
          diagnostic(
            'NACHI_SPAWN_RATE_INVALID',
            `${type} rate must be a non-negative finite number.`,
            fieldPath(path, 'rate'),
          ),
        ]
      : [];
  }
  if (type === 'core/billboard') {
    return collectBillboardDiagnostics(config as unknown as BillboardOptions, path);
  }
  if (type === 'core/mesh-renderer') {
    return collectMeshDiagnostics(config as unknown as MeshRendererOptions, path);
  }
  if (type === 'core/light-renderer') {
    const diagnostics: VfxDiagnostic[] = [];
    const maxLights = config.maxLights ?? 8;
    const radiusScale = config.radiusScale ?? 1;
    if (
      !Number.isSafeInteger(maxLights) ||
      (maxLights as number) <= 0 ||
      (maxLights as number) > 64
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_LIGHT_COUNT_INVALID',
          'Light renderer maxLights must be a positive safe integer no greater than 64.',
          fieldPath(path, 'maxLights'),
        ),
      );
    }
    if (typeof radiusScale !== 'number' || !Number.isFinite(radiusScale) || radiusScale <= 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_LIGHT_RADIUS_INVALID',
          'Light renderer radiusScale must be a positive finite number.',
          fieldPath(path, 'radiusScale'),
        ),
      );
    }
    if (
      config.priority !== undefined &&
      config.priority !== 'intensity' &&
      config.priority !== 'intensity-radius'
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_LIGHT_PRIORITY_INVALID',
          'Light renderer priority must be "intensity" or "intensity-radius".',
          fieldPath(path, 'priority'),
        ),
      );
    }
    return diagnostics;
  }
  if (type === 'core/decal-renderer') {
    const options = config as unknown as DecalRendererOptions;
    const diagnostics: VfxDiagnostic[] = [];
    const sizeScale = options.sizeScale ?? 1;
    if (!Number.isFinite(sizeScale) || sizeScale <= 0) {
      diagnostics.push(
        diagnostic(
          'NACHI_DECAL_SIZE_INVALID',
          'Decal renderer sizeScale must be a positive finite number.',
          fieldPath(path, 'sizeScale'),
        ),
      );
    }
    if (
      options.blending !== undefined &&
      options.blending !== 'alpha' &&
      options.blending !== 'premultiplied'
    ) {
      diagnostics.push(
        diagnostic(
          'NACHI_DECAL_BLENDING_INVALID',
          'Decal renderer blending must be "alpha" or "premultiplied".',
          fieldPath(path, 'blending'),
        ),
      );
    }
    if (options.fadeOverLife !== undefined && typeof options.fadeOverLife !== 'boolean') {
      diagnostics.push(
        diagnostic(
          'NACHI_DECAL_FADE_OVER_LIFE_INVALID',
          'Decal renderer fadeOverLife must be a boolean.',
          fieldPath(path, 'fadeOverLife'),
        ),
      );
    }
    return diagnostics;
  }
  return [
    ...collectBehaviorDiagnostics(type, config, path),
    ...collectNeighborDiagnostics(type, config, path),
  ];
}
