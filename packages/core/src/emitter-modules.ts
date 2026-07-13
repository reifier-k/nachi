import type {
  AttributeSchema,
  EmitterConfig,
  ModuleDefinition,
  ModuleStage,
  ParameterSchema,
  VfxDiagnostic,
} from './types.js';
import { MAX_PREWARM_SECONDS } from './limits.js';
import { collectCoreModuleConfigDiagnostics } from './module-validation.js';

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
  if (lifecycle.prewarm !== undefined && lifecycle.prewarm > MAX_PREWARM_SECONDS) {
    diagnostics.push(
      compileDiagnostic(
        'NACHI_LIFECYCLE_PREWARM_LIMIT_EXCEEDED',
        `Emitter lifecycle prewarm must not exceed ${MAX_PREWARM_SECONDS} seconds.`,
        'lifecycle.prewarm',
      ),
    );
  }
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
  const hasDerivedBurstEnvelope = (
    Array.isArray(config.spawn) ? config.spawn : [config.spawn]
  ).some((module) => {
    if (module.type !== 'core/burst') return false;
    const { cycles, interval } = module.config as { cycles?: unknown; interval?: unknown };
    return (
      typeof cycles === 'number' &&
      Number.isSafeInteger(cycles) &&
      cycles > 1 &&
      typeof interval === 'number' &&
      Number.isFinite(interval) &&
      interval > 0
    );
  });
  if (
    (lifecycle.duration === 0 || (lifecycle.duration === undefined && !hasDerivedBurstEnvelope)) &&
    (lifecycle.loopCount ?? 1) !== 1
  ) {
    diagnostics.push(
      compileDiagnostic(
        'NACHI_LIFECYCLE_LOOP_DURATION_REQUIRED',
        'A looping emitter requires a positive explicit duration or a derived multi-cycle burst envelope.',
        'lifecycle.duration',
      ),
    );
  }
  return diagnostics;
}

/** Compile-time diagnostics for statically degenerate M4 behavior configurations. */
export function collectEmitterBehaviorConfigDiagnostics(
  config: EmitterConfig<AttributeSchema, ParameterSchema>,
): VfxDiagnostic[] {
  return collectEmitterModules(config).flatMap(({ module, path }) =>
    collectCoreModuleConfigDiagnostics(
      module.type,
      module.config as Readonly<Record<string, unknown>>,
      `${path}.config`,
    ).filter(
      ({ code }) =>
        code.startsWith('NACHI_COLLISION_') ||
        code === 'NACHI_VELOCITY_CONE_DIRECTION_INVALID' ||
        code === 'NACHI_VORTEX_AXIS_INVALID' ||
        code === 'NACHI_FORCE_FREQUENCY_INVALID' ||
        code === 'NACHI_POINT_ATTRACTOR_RADIUS_INVALID' ||
        code.startsWith('NACHI_KILL_VOLUME_'),
    ),
  );
}
