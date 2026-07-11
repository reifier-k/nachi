import {
  VfxDiagnosticError,
  defineEffect as defineCoreEffect,
  type ComposedEffectParameterSchema,
  type CurveGenerator,
  type EffectDefinition,
  type EffectElementDefinition,
  type EmptyParameterSchema,
  type ParameterSchema,
  type TimelineAction,
  type TimelineDefinition,
  type TimelineEntry,
  type VisualElementDefinition,
} from '@nachi/core';
import {
  fxMaterial as createMeshFxMaterial,
  type FxDissolveConfig,
  type FxMaterialConfig,
  type FxNodeMaterial,
  type MeshFxMesh,
  type OverLifeCurve,
  type OverLifeInput,
} from '@nachi/mesh-fx';

export type TimelineAuthoringElement = EffectElementDefinition | MeshFxElement | MeshFxMesh;
export type TimelineAuthoringElements = Readonly<Record<string, TimelineAuthoringElement>>;

export interface MeshFxElement {
  readonly duration: number;
  readonly kind: 'timeline-mesh-fx';
  readonly mesh: MeshFxMesh;
}

type MeshFxPlaceholder = VisualElementDefinition<{
  readonly duration: number;
  readonly resource: string;
}>;

type NormalizedElements<Elements extends TimelineAuthoringElements> = Readonly<{
  [Key in keyof Elements]: Elements[Key] extends MeshFxMesh | MeshFxElement
    ? MeshFxPlaceholder
    : Elements[Key] extends EffectElementDefinition
      ? Elements[Key]
      : never;
}>;

export interface TimelineEffectConfig<
  Elements extends TimelineAuthoringElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> {
  readonly elements: Elements;
  readonly parameters?: Parameters;
  readonly timeline?:
    | TimelineDefinition<Extract<keyof Elements, string>>
    | readonly TimelineEntry<Extract<keyof Elements, string>>[];
}

export type TimelineEffectDefinition<
  Elements extends TimelineAuthoringElements = TimelineAuthoringElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> = EffectDefinition<
  NormalizedElements<Elements>,
  ComposedEffectParameterSchema<NormalizedElements<Elements>, Parameters>
>;

export interface MeshFxRuntimeResource {
  readonly duration: number;
  readonly mesh: MeshFxMesh;
}

const effectMeshResources = new WeakMap<object, ReadonlyMap<string, MeshFxRuntimeResource>>();
const materialConfigs = new WeakMap<FxNodeMaterial, TimelineFxMaterialConfig>();

export function meshFxElement(
  mesh: MeshFxMesh,
  options: { readonly duration?: number } = {},
): MeshFxElement {
  const duration = options.duration ?? 1;
  requirePositive(duration, 'meshFxElement.duration');
  return Object.freeze({ duration, kind: 'timeline-mesh-fx' as const, mesh });
}

export function defineEffect<
  const Elements extends TimelineAuthoringElements,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(
  config: TimelineEffectConfig<Elements, Parameters>,
): TimelineEffectDefinition<Elements, Parameters> {
  const resources = new Map<string, MeshFxRuntimeResource>();
  const normalizedElements = Object.fromEntries(
    Object.entries(config.elements).map(([key, element]) => {
      const resource = asMeshFxResource(element);
      if (!resource) return [key, element];
      resources.set(key, resource);
      return [
        key,
        {
          config: { duration: resource.duration, resource: key },
          kind: 'visual-element',
          type: 'timeline/mesh-fx',
          version: 1,
        } satisfies MeshFxPlaceholder,
      ];
    }),
  ) as NormalizedElements<Elements>;
  const normalizedTimeline = normalizeTimeline(
    config.timeline,
    new Set(Object.keys(config.elements)),
  );
  const definition = defineCoreEffect({
    elements: normalizedElements,
    ...(config.parameters === undefined ? {} : { parameters: config.parameters }),
    ...(normalizedTimeline === undefined ? {} : { timeline: normalizedTimeline }),
  });
  if (resources.size > 0) effectMeshResources.set(definition, resources);
  return definition as TimelineEffectDefinition<Elements, Parameters>;
}

export function getMeshFxResources(definition: object): ReadonlyMap<string, MeshFxRuntimeResource> {
  return effectMeshResources.get(definition) ?? new Map();
}

export type TimelineOverLifeInput = OverLifeInput | CurveGenerator<number>;
export type TimelineFxDissolveConfig = Omit<FxDissolveConfig, 'overLife'> & {
  readonly overLife: TimelineOverLifeInput;
};
export type TimelineFxMaterialConfig = Omit<FxMaterialConfig, 'dissolve'> & {
  readonly dissolve?: TimelineFxDissolveConfig;
};

export function lowerCurve(input: CurveGenerator<number>): OverLifeCurve {
  const diagnostics = input.keys.flatMap((key, index) => {
    const failures = [];
    if (!Number.isFinite(key.time) || key.time < 0 || key.time > 1) {
      failures.push(
        diagnostic(
          'NACHI_TIMELINE_CURVE_TIME_INVALID',
          `Curve key ${index} time must be in [0, 1].`,
          `keys[${index}].time`,
        ),
      );
    }
    if (!Number.isFinite(key.value) || key.value < 0 || key.value > 1) {
      failures.push(
        diagnostic(
          'NACHI_TIMELINE_CURVE_VALUE_INVALID',
          `Curve key ${index} value must be in [0, 1].`,
          `keys[${index}].value`,
        ),
      );
    }
    if ((key.interpolation ?? 'linear') !== 'linear') {
      failures.push(
        diagnostic(
          'NACHI_TIMELINE_CURVE_INTERPOLATION_UNSUPPORTED',
          'mesh-fx lowering supports linear curve keys only.',
          `keys[${index}].interpolation`,
        ),
      );
    }
    return failures;
  });
  if (input.keys.length < 2)
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_CURVE_KEYS_INVALID',
        'mesh-fx curves require at least two keys.',
        'keys',
      ),
    );
  for (let index = 1; index < input.keys.length; index += 1) {
    if (input.keys[index]!.time <= input.keys[index - 1]!.time) {
      diagnostics.push(
        diagnostic(
          'NACHI_TIMELINE_CURVE_ORDER_INVALID',
          'mesh-fx curve times must be strictly increasing.',
          `keys[${index}].time`,
        ),
      );
    }
  }
  if (input.keys[0]?.time !== 0 || input.keys.at(-1)?.time !== 1) {
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_CURVE_ENDPOINT_INVALID',
        'mesh-fx curves require endpoints at 0 and 1.',
        'keys',
      ),
    );
  }
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  return Object.freeze(input.keys.map(({ time, value }) => Object.freeze([time, value] as const)));
}

export function fxMaterial(config: TimelineFxMaterialConfig = {}): FxNodeMaterial {
  const lowered = config.dissolve
    ? {
        ...config,
        dissolve: {
          ...config.dissolve,
          overLife: isCoreCurve(config.dissolve.overLife)
            ? lowerCurve(config.dissolve.overLife)
            : config.dissolve.overLife,
        },
      }
    : config;
  const storedConfig = Object.freeze({
    ...lowered,
    ...(lowered.dissolve === undefined ? {} : { dissolve: Object.freeze({ ...lowered.dissolve }) }),
    ...(lowered.fresnel === undefined ? {} : { fresnel: Object.freeze({ ...lowered.fresnel }) }),
  }) as TimelineFxMaterialConfig;
  const material = createMeshFxMaterial(storedConfig as FxMaterialConfig);
  materialConfigs.set(material, storedConfig);
  return material;
}

export function cloneTimelineFxMaterial(
  material: FxNodeMaterial,
  path = 'material',
): FxNodeMaterial {
  const config = materialConfigs.get(material);
  if (config) return fxMaterial(config);
  throw new VfxDiagnosticError([
    diagnostic(
      'NACHI_TIMELINE_MESH_FX_MATERIAL_CLONE_UNSUPPORTED',
      'mesh-fx materials used in timeline elements must be created with @nachi/timeline fxMaterial() so instance controls can be regenerated safely.',
      path,
    ),
  ]);
}

function normalizeTimeline<Target extends string>(
  input: TimelineDefinition<Target> | readonly TimelineEntry<Target>[] | undefined,
  targets: ReadonlySet<string>,
): TimelineDefinition<Target> | undefined {
  if (input === undefined) return undefined;
  const source: TimelineDefinition<Target> = Array.isArray(input)
    ? ({ entries: input, kind: 'timeline' } as TimelineDefinition<Target>)
    : (input as TimelineDefinition<Target>);
  const diagnostics = [];
  const entries = source.entries
    .map((entry, authorIndex) => ({ entry, authorIndex }))
    .sort((left, right) => left.entry.at - right.entry.at || left.authorIndex - right.authorIndex)
    .map(({ entry }) => ({ ...entry, actions: [...entry.actions] }));
  for (const [entryIndex, entry] of entries.entries()) {
    if (!Number.isFinite(entry.at) || entry.at < 0)
      diagnostics.push(
        diagnostic(
          'NACHI_TIMELINE_TIME_INVALID',
          'Timeline entry time must be non-negative and finite.',
          `timeline.entries[${entryIndex}].at`,
        ),
      );
    for (const [actionIndex, action] of entry.actions.entries()) {
      validateAction(
        action,
        targets,
        `timeline.entries[${entryIndex}].actions[${actionIndex}]`,
        diagnostics,
      );
    }
  }
  const speed = source.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0)
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_SPEED_INVALID',
        'Timeline speed must be positive and finite.',
        'timeline.speed',
      ),
    );
  const lastTime = entries.at(-1)?.at ?? 0;
  const duration = source.duration ?? lastTime;
  if (!Number.isFinite(duration) || duration < lastTime || duration < 0)
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_DURATION_INVALID',
        'Timeline duration must be finite and no earlier than its last entry.',
        'timeline.duration',
      ),
    );
  if (
    (source.loop === true || (typeof source.loop === 'number' && source.loop > 1)) &&
    duration <= 0
  )
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_LOOP_DURATION_REQUIRED',
        'A looping timeline requires a positive duration.',
        'timeline.duration',
      ),
    );
  if (typeof source.loop === 'number' && (!Number.isSafeInteger(source.loop) || source.loop <= 0))
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_LOOP_INVALID',
        'Timeline loop count must be a positive safe integer.',
        'timeline.loop',
      ),
    );
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  return Object.freeze({
    ...source,
    duration,
    entries: Object.freeze(
      entries.map((entry) => Object.freeze({ ...entry, actions: Object.freeze(entry.actions) })),
    ),
    kind: 'timeline' as const,
    speed,
  });
}

function validateAction(
  action: TimelineAction,
  targets: ReadonlySet<string>,
  path: string,
  diagnostics: ReturnType<typeof diagnostic>[],
): void {
  if ((action.kind === 'play' || action.kind === 'stop') && !targets.has(action.target))
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_TARGET_UNKNOWN',
        `Unknown timeline target "${action.target}".`,
        `${path}.target`,
      ),
    );
  if (
    action.kind === 'hit-stop' &&
    (!Number.isFinite(action.durationMs) ||
      action.durationMs < 0 ||
      (action.timeScale !== undefined &&
        (!Number.isFinite(action.timeScale) || action.timeScale < 0)))
  )
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_HIT_STOP_INVALID',
        'hitStop duration and timeScale must be non-negative finite numbers.',
        path,
      ),
    );
  if (
    action.kind === 'camera-shake' &&
    (!Number.isFinite(action.strength) ||
      action.strength < 0 ||
      (action.duration !== undefined &&
        (!Number.isFinite(action.duration) || action.duration < 0)) ||
      (action.frequency !== undefined &&
        (!Number.isFinite(action.frequency) || action.frequency <= 0)))
  )
    diagnostics.push(
      diagnostic(
        'NACHI_TIMELINE_CAMERA_SHAKE_INVALID',
        'cameraShake strength/duration must be non-negative and frequency must be positive.',
        path,
      ),
    );
  if (action.kind === 'marker' && action.name.length === 0)
    diagnostics.push(
      diagnostic('NACHI_TIMELINE_MARKER_INVALID', 'Marker name must not be empty.', `${path}.name`),
    );
}

function asMeshFxResource(element: TimelineAuthoringElement): MeshFxRuntimeResource | undefined {
  if (
    'kind' in element &&
    element.kind === 'timeline-mesh-fx' &&
    'duration' in element &&
    'mesh' in element
  ) {
    return { duration: element.duration as number, mesh: element.mesh as MeshFxMesh };
  }
  if (
    'isMesh' in element &&
    element.isMesh === true &&
    'userData' in element &&
    typeof element.userData === 'object' &&
    element.userData !== null &&
    'nachiMeshFx' in element.userData
  )
    return { duration: 1, mesh: element as MeshFxMesh };
  return undefined;
}

function isCoreCurve(input: TimelineOverLifeInput): input is CurveGenerator<number> {
  return typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'curve';
}

function requirePositive(value: number, path: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${path} must be positive and finite.`);
}

function diagnostic(code: string, message: string, path: string) {
  return { code, message, path, phase: 'compile' as const, severity: 'error' as const };
}
