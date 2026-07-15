import type { AttributeType, ParameterPath, ParameterSchema } from './types.js';

export interface BuiltInUniformDefinition {
  readonly default: unknown;
  /** Whether parameter(path) can materialize this uniform in particle kernels. */
  readonly materializedParameter: boolean;
  readonly path: ParameterPath;
  readonly type: AttributeType;
}

/** Runtime source of truth for built-in uniform paths, logical types, defaults, and materialization. */
export const BUILT_IN_UNIFORM_DEFINITIONS = [
  { default: 0, materializedParameter: true, path: 'System.time', type: 'f32' },
  { default: 1 / 60, materializedParameter: true, path: 'System.deltaTime', type: 'f32' },
  {
    default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    materializedParameter: true,
    path: 'System.projectionMatrix',
    type: 'mat4',
  },
  {
    default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    materializedParameter: true,
    path: 'System.viewMatrix',
    type: 'mat4',
  },
  { default: [1, 1], materializedParameter: true, path: 'System.viewportSize', type: 'vec2' },
  { default: 1, materializedParameter: false, path: 'System.visibility', type: 'f32' },
  { default: 0, materializedParameter: true, path: 'Emitter.age', type: 'f32' },
  { default: 1 / 60, materializedParameter: true, path: 'Emitter.deltaTime', type: 'f32' },
  { default: 1, materializedParameter: true, path: 'Emitter.eventReadBank', type: 'u32' },
  { default: 0, materializedParameter: true, path: 'Emitter.eventWriteBank', type: 'u32' },
  { default: 0, materializedParameter: true, path: 'Emitter.localTime', type: 'f32' },
  { default: 0, materializedParameter: false, path: 'Emitter.logicalCapacity', type: 'u32' },
  { default: 0, materializedParameter: true, path: 'Emitter.loopIndex', type: 'u32' },
  { default: 0, materializedParameter: false, path: 'Emitter.interpolationActive', type: 'u32' },
  {
    default: [0, 0, 0, 1],
    materializedParameter: false,
    path: 'Emitter.previousRotation',
    type: 'quat',
  },
  {
    default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    materializedParameter: false,
    path: 'Emitter.previousTransform',
    type: 'mat4',
  },
  {
    default: [0, 0, 0, 1],
    materializedParameter: false,
    path: 'Emitter.rotation',
    type: 'quat',
  },
  { default: 0, materializedParameter: true, path: 'Emitter.seed', type: 'u32' },
  { default: 0, materializedParameter: false, path: 'Emitter.spawnCount', type: 'u32' },
  { default: 0, materializedParameter: true, path: 'Emitter.spawnGeneration', type: 'u32' },
  { default: 1, materializedParameter: false, path: 'Emitter.spawnPhaseStart', type: 'f32' },
  { default: 0, materializedParameter: false, path: 'Emitter.spawnPhaseStep', type: 'f32' },
  {
    default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    materializedParameter: true,
    path: 'Emitter.transform',
    type: 'mat4',
  },
  { default: 0, materializedParameter: true, path: 'Emitter.updateRandomStep', type: 'u32' },
] as const satisfies readonly BuiltInUniformDefinition[];

const BUILT_IN_UNIFORM_BY_PATH = new Map<ParameterPath, BuiltInUniformDefinition>(
  BUILT_IN_UNIFORM_DEFINITIONS.map((definition) => [definition.path, definition]),
);

export const MATERIALIZED_PARAMETER_PATHS = new Set<ParameterPath>(
  BUILT_IN_UNIFORM_DEFINITIONS.filter(({ materializedParameter }) => materializedParameter).map(
    ({ path }) => path,
  ),
);

export function materializedParameterType(
  path: ParameterPath,
  parameters?: ParameterSchema,
): AttributeType | undefined {
  if (path.startsWith('User.')) return parameters?.[path]?.type;
  const definition = BUILT_IN_UNIFORM_BY_PATH.get(path);
  return definition?.materializedParameter === true ? definition.type : undefined;
}
