import type {
  AttributeSchema,
  EmitterConfig,
  ModuleDefinition,
  ModuleStage,
  ParameterSchema,
  VfxDiagnostic,
} from './types.js';

export type LocatedEmitterModule = {
  readonly module: ModuleDefinition<ModuleStage, object>;
  readonly path: string;
  readonly stageIndex: number;
};

function appendModules(
  target: LocatedEmitterModule[],
  stageCounts: Map<ModuleStage, number>,
  path: string,
  value:
    | ModuleDefinition<ModuleStage, object>
    | readonly ModuleDefinition<ModuleStage, object>[]
    | undefined,
): void {
  if (value === undefined) return;
  const modules = Array.isArray(value) ? value : [value];
  for (const [pathIndex, module] of modules.entries()) {
    const stageIndex = stageCounts.get(module.stage) ?? 0;
    target.push({ module, path: `${path}[${pathIndex}]`, stageIndex });
    stageCounts.set(module.stage, stageIndex + 1);
  }
}

export function collectEmitterModules(
  config: EmitterConfig<AttributeSchema, ParameterSchema>,
): LocatedEmitterModule[] {
  const modules: LocatedEmitterModule[] = [];
  const stageCounts = new Map<ModuleStage, number>();
  appendModules(modules, stageCounts, 'spawn', config.spawn);
  appendModules(modules, stageCounts, 'init', config.init);
  appendModules(modules, stageCounts, 'update', config.update);
  for (const [eventName, handlers] of Object.entries(config.events ?? {})) {
    appendModules(modules, stageCounts, `events.${eventName}`, handlers);
  }
  appendModules(modules, stageCounts, 'render', config.render);
  return modules;
}

function compileDiagnostic(code: string, message: string, path: string): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity: 'error' };
}

export function collectEmitterModuleLabelDiagnostics(
  config: EmitterConfig<AttributeSchema, ParameterSchema>,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const labelsByStage = new Map<ModuleStage, Map<string, string>>();

  for (const { module, path } of collectEmitterModules(config)) {
    const { label } = module;
    if (label === undefined) continue;
    if (label.length === 0) {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_MODULE_LABEL_EMPTY',
          'Module labels must be non-empty when provided.',
          `${path}.label`,
        ),
      );
      continue;
    }
    if (label.startsWith('$')) {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_MODULE_RESERVED_LABEL',
          `Module label "${label}" uses the compiler-reserved "$" prefix.`,
          `${path}.label`,
        ),
      );
    }

    let stageLabels = labelsByStage.get(module.stage);
    if (stageLabels === undefined) {
      stageLabels = new Map();
      labelsByStage.set(module.stage, stageLabels);
    }
    const previousPath = stageLabels.get(label);
    if (previousPath === undefined) {
      stageLabels.set(label, path);
    } else {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_MODULE_DUPLICATE_LABEL',
          `Module label "${label}" is duplicated in the ${module.stage} stage (first declared at ${previousPath}).`,
          `${path}.label`,
        ),
      );
    }
  }

  return diagnostics;
}

export function collectParameterDeclarationDiagnostics(
  parameters: ParameterSchema | undefined,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  for (const [key, definition] of Object.entries(parameters ?? {})) {
    if (key !== definition.path) {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_PARAMETER_KEY_MISMATCH',
          `Parameter key "${key}" must match its declared path "${definition.path}".`,
          `parameters.${key}.path`,
        ),
      );
    }
    if (!key.startsWith('User.') || !definition.path.startsWith('User.')) {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_PARAMETER_NAMESPACE_INVALID',
          `Parameter declaration "${key}" must use the User.* namespace.`,
          `parameters.${key}`,
        ),
      );
    }
  }
  return diagnostics;
}

export function collectEmitterLifecycleDiagnostics(
  config: EmitterConfig<AttributeSchema, ParameterSchema>,
): VfxDiagnostic[] {
  const lifecycle = config.lifecycle;
  if (!lifecycle) return [];
  const diagnostics: VfxDiagnostic[] = [];
  const nonNegativeFinite = (
    value: number | undefined,
    field: 'duration' | 'prewarm' | 'startDelay',
  ) => {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      diagnostics.push(
        compileDiagnostic(
          'NACHI_LIFECYCLE_VALUE_INVALID',
          `Emitter lifecycle ${field} must be a non-negative finite number.`,
          `lifecycle.${field}`,
        ),
      );
    }
  };
  nonNegativeFinite(lifecycle.duration, 'duration');
  nonNegativeFinite(lifecycle.prewarm, 'prewarm');
  nonNegativeFinite(lifecycle.startDelay, 'startDelay');
  if (
    lifecycle.loopCount !== undefined &&
    lifecycle.loopCount !== 'infinite' &&
    (!Number.isSafeInteger(lifecycle.loopCount) || lifecycle.loopCount <= 0)
  ) {
    diagnostics.push(
      compileDiagnostic(
        'NACHI_LIFECYCLE_LOOP_COUNT_INVALID',
        'Emitter lifecycle loopCount must be a positive safe integer or "infinite".',
        'lifecycle.loopCount',
      ),
    );
  }
  if ((lifecycle.duration ?? 0) === 0 && (lifecycle.loopCount ?? 1) !== 1) {
    diagnostics.push(
      compileDiagnostic(
        'NACHI_LIFECYCLE_LOOP_DURATION_REQUIRED',
        'A looping emitter requires a positive lifecycle duration.',
        'lifecycle.duration',
      ),
    );
  }
  return diagnostics;
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

/** Compile-time diagnostics for statically degenerate M4 behavior configurations. */
export function collectEmitterBehaviorConfigDiagnostics(
  config: EmitterConfig<AttributeSchema, ParameterSchema>,
): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  for (const { module, path } of collectEmitterModules(config)) {
    const moduleConfig = module.config as Record<string, unknown>;
    if (module.type.startsWith('core/collide-')) {
      for (const coefficient of ['bounce', 'friction'] as const) {
        const minimum = staticScalarMinimum(moduleConfig[coefficient]);
        const maximum = staticScalarMaximum(moduleConfig[coefficient]);
        if (
          (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0)) ||
          (maximum !== undefined && (!Number.isFinite(maximum) || maximum > 1))
        ) {
          diagnostics.push(
            compileDiagnostic(
              'NACHI_COLLISION_RESPONSE_INVALID',
              `Collision ${coefficient} must remain within the inclusive range [0, 1].`,
              `${path}.config.${coefficient}`,
            ),
          );
        }
      }
    }

    if (module.type === 'core/collide-plane') {
      const normal = moduleConfig.normal;
      if (!isFiniteVector(normal, 3) || Math.hypot(...normal) === 0) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_PLANE_NORMAL_INVALID',
            'Collision plane normal must be a finite non-zero vec3.',
            `${path}.config.normal`,
          ),
        );
      }
    } else if (module.type === 'core/collide-sphere') {
      const radius = staticScalarMinimum(moduleConfig.radius);
      if (radius !== undefined && (!Number.isFinite(radius) || radius <= 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_SPHERE_RADIUS_INVALID',
            'Collision sphere radius must be positive and finite.',
            `${path}.config.radius`,
          ),
        );
      }
    } else if (module.type === 'core/collide-box') {
      const size = moduleConfig.size;
      if (
        Array.isArray(size) &&
        (!isFiniteVector(size, 3) || size.some((component) => component <= 0))
      ) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_BOX_SIZE_INVALID',
            'Collision box size must be a finite vec3 with positive components.',
            `${path}.config.size`,
          ),
        );
      }
    } else if (module.type === 'core/collide-scene-depth') {
      const surfaceOffset = staticScalarMinimum(moduleConfig.surfaceOffset);
      if (surfaceOffset !== undefined && (!Number.isFinite(surfaceOffset) || surfaceOffset < 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_DEPTH_OFFSET_INVALID',
            'Scene-depth collision surfaceOffset must be non-negative and finite.',
            `${path}.config.surfaceOffset`,
          ),
        );
      }
      const thickness = staticScalarMinimum(moduleConfig.thickness);
      if (thickness !== undefined && (!Number.isFinite(thickness) || thickness <= 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_DEPTH_THICKNESS_INVALID',
            'Scene-depth collision thickness must be positive and finite.',
            `${path}.config.thickness`,
          ),
        );
      }
    } else if (module.type === 'core/collide-sdf') {
      const thickness = staticScalarMinimum(moduleConfig.thickness);
      if (thickness !== undefined && (!Number.isFinite(thickness) || thickness <= 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_COLLISION_SDF_THICKNESS_INVALID',
            'SDF collision thickness must be positive and finite.',
            `${path}.config.thickness`,
          ),
        );
      }
    }

    if (module.type === 'core/vortex') {
      const axis = moduleConfig.axis;
      if (!isFiniteVector(axis, 3) || Math.hypot(...axis) === 0) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_VORTEX_AXIS_INVALID',
            'Vortex axis must be a finite non-zero vec3.',
            `${path}.config.axis`,
          ),
        );
      }
    }

    if (module.type === 'core/curl-noise' || module.type === 'core/turbulence') {
      const frequency = staticScalarMinimum(moduleConfig.frequency);
      if (frequency !== undefined && (!Number.isFinite(frequency) || frequency <= 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_FORCE_FREQUENCY_INVALID',
            `${module.type} frequency must remain positive and finite.`,
            `${path}.config.frequency`,
          ),
        );
      }
    }

    if (module.type === 'core/point-attractor') {
      const radius = staticScalarMinimum(moduleConfig.radius);
      if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_POINT_ATTRACTOR_RADIUS_INVALID',
            'Point-attractor radius must be a non-negative finite number.',
            `${path}.config.radius`,
          ),
        );
      }
    }

    if (module.type !== 'core/kill-volume') continue;
    if (moduleConfig.shape === 'plane') {
      const normal = moduleConfig.normal;
      if (!isFiniteVector(normal, 3) || Math.hypot(...normal) === 0) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_KILL_VOLUME_NORMAL_INVALID',
            'Kill-volume plane normal must be a finite non-zero vec3.',
            `${path}.config.normal`,
          ),
        );
      }
    } else if (moduleConfig.shape === 'sphere') {
      const radius = staticScalarMinimum(moduleConfig.radius);
      if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_KILL_VOLUME_RADIUS_INVALID',
            'Kill-volume sphere radius must be a non-negative finite number.',
            `${path}.config.radius`,
          ),
        );
      }
    } else if (moduleConfig.shape === 'box') {
      const size = moduleConfig.size;
      if (
        Array.isArray(size) &&
        (!isFiniteVector(size, 3) || size.some((component) => component <= 0))
      ) {
        diagnostics.push(
          compileDiagnostic(
            'NACHI_KILL_VOLUME_SIZE_INVALID',
            'Kill-volume box size must be a finite vec3 with positive components.',
            `${path}.config.size`,
          ),
        );
      }
    }
  }
  return diagnostics;
}
