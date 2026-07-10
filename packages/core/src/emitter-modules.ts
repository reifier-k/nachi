import type {
  AttributeSchema,
  EmitterConfig,
  ModuleDefinition,
  ModuleStage,
  ParameterSchema,
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
