import { resolveAttributeSchema } from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import {
  collectEmitterLifecycleDiagnostics,
  collectEmitterModuleLabelDiagnostics,
  collectParameterDeclarationDiagnostics,
} from './emitter-modules.js';
import type {
  AttributeDefinition,
  AttributeSchema,
  AttributeType,
  AttributeTypeMap,
  BillboardOptions,
  BurstOptions,
  CameraShakeAction,
  CollideSdfOptions,
  ColorInput,
  CollideBoxOptions,
  CollidePlaneOptions,
  CollideSceneDepthOptions,
  CollideSphereOptions,
  CurlNoiseOptions,
  CurveGenerator,
  CurveKey,
  DataReference,
  EffectConfig,
  EffectDefinition,
  EffectElements,
  EmitToOptions,
  EmitterConfig,
  EmitterDefinition,
  EmitterModuleListOverride,
  EmitterModuleSelector,
  EmitterOverrideConfig,
  EventModule,
  FlipbookDefinition,
  MeshRendererOptions,
  MarkerAction,
  GradientGenerator,
  HitStopAction,
  InitModule,
  JsonValue,
  KillVolumeOptions,
  LinearForceOptions,
  ModuleAccess,
  ModuleDefinition,
  ModuleStage,
  ParameterDefinition,
  ParameterGenerator,
  ParameterPath,
  ParameterSchema,
  PerDistanceSpawnOptions,
  PlayAction,
  PositionMeshSurfaceOptions,
  PositionSphereOptions,
  PointAttractorOptions,
  RangeGenerator,
  RateSpawnOptions,
  RenderModule,
  LightRendererOptions,
  DecalRendererOptions,
  SpawnModule,
  StopAction,
  TextureRef,
  TurbulenceOptions,
  TimelineAction,
  TimelineActionTarget,
  TimelineEntry,
  TimelineDefinition,
  TslFunctionRef,
  TslFunctionRegistration,
  TslModuleDefinition,
  TslModuleFactory,
  TslModuleOptions,
  TslParticleBindings,
  UpdateModule,
  VectorFieldOptions,
  ValueInput,
  Vec2,
  Vec3,
  Vec4,
  VelocityConeOptions,
  VelocityMeshNormalOptions,
  VortexOptions,
  ComposedEffectParameterSchema,
  Grid2DDefinition,
  Grid2DChannelSchema,
  Grid2DStageModuleDefinition,
  SimStageDefinition,
} from './types.js';

export function defineGrid2D<const Channels extends Grid2DChannelSchema>(config: {
  readonly boundary?: 'clamp';
  readonly channels: Channels;
  readonly resolution: readonly [number, number];
}): Grid2DDefinition<Channels> {
  return {
    boundary: config.boundary ?? 'clamp',
    channels: config.channels,
    kind: 'grid2d',
    resolution: config.resolution,
    version: 1,
  };
}

export function defineSimStage(config: {
  readonly iterations?: number;
  readonly phase?: 'after-particles' | 'before-particles';
  readonly target: string;
  readonly update: Grid2DStageModuleDefinition;
}): SimStageDefinition {
  return {
    iterations: config.iterations ?? 1,
    kind: 'sim-stage',
    phase: config.phase ?? 'after-particles',
    target: config.target,
    update: config.update,
    version: 1,
  };
}

function createModule<Stage extends ModuleStage, Config extends object>(
  stage: Stage,
  type: string,
  config: Config,
  access?: ModuleAccess,
): ModuleDefinition<Stage, Config> {
  const parameterReads = collectParameterReads(config);
  const normalizedAccess =
    access === undefined && parameterReads.length === 0
      ? undefined
      : {
          ...access,
          reads: [...new Set([...(access?.reads ?? []), ...parameterReads])],
          writes: access?.writes ?? [],
        };
  const definition = {
    config,
    kind: 'module',
    stage,
    type,
    version: 1,
  };

  return (
    normalizedAccess === undefined ? definition : { ...definition, access: normalizedAccess }
  ) as ModuleDefinition<Stage, Config>;
}

function collectParameterReads(value: unknown): DataReference[] {
  const references = new Set<DataReference>();
  const visited = new WeakSet<object>();

  const visit = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || visited.has(candidate)) return;
    visited.add(candidate);

    if (
      'kind' in candidate &&
      candidate.kind === 'parameter' &&
      'path' in candidate &&
      typeof candidate.path === 'string' &&
      /^(Emitter|Particles|System|User)\./.test(candidate.path)
    ) {
      references.add(candidate.path as DataReference);
    }

    for (const nestedValue of Object.values(candidate)) visit(nestedValue);
  };

  visit(value);
  return [...references];
}

function addEventQueueWrite(module: EventModule, eventName: string): EventModule {
  const queue = `Emitter.events.${eventName}` as const;
  const normalizedWrites = (module.access?.writes ?? []).filter(
    (reference) => reference !== 'Emitter.events.pending',
  );
  return {
    ...module,
    access: {
      ...module.access,
      reads: module.access?.reads ?? [],
      writes: [...new Set([...normalizedWrites, queue])],
    },
  };
}

export function range<T extends number | Vec2 | Vec3 | Vec4>(min: T, max: T): RangeGenerator<T> {
  // The stage compiler resolves this with pcgRandomFloatNode(particleIndex, emitterSeed,
  // moduleSlot, Particles.spawnGeneration). Spawn-policy ranges use their emission-batch
  // generation on CPU because no physical particle has been allocated at that stage yet.
  return { distribution: 'uniform', kind: 'range', max, min };
}

export function curve<T extends number | Vec2 | Vec3 | Vec4>(
  ...points: readonly [readonly [number, T], readonly [number, T], ...(readonly [number, T])[]]
): CurveGenerator<T> {
  const keys: CurveKey<T>[] = points.map(([time, value]) => ({ time, value }));
  return { keys, kind: 'curve' };
}

export function gradient(
  ...colors: readonly [ColorInput, ColorInput, ...ColorInput[]]
): GradientGenerator {
  const lastIndex = colors.length - 1;
  return {
    kind: 'gradient',
    stops: colors.map((color, index) => ({ color, position: index / lastIndex })),
  };
}

export function parameter<T extends JsonValue>(
  path: ParameterPath,
  fallback?: T,
): ParameterGenerator<T> {
  return fallback === undefined
    ? { kind: 'parameter', path }
    : { fallback, kind: 'parameter', path };
}

export function defineParameter<const Path extends ParameterPath, const Type extends AttributeType>(
  path: Path,
  options: {
    readonly default: AttributeTypeMap[Type];
    readonly mutable?: boolean;
    readonly type: Type;
  },
): ParameterDefinition<Path, Type> {
  return { kind: 'parameter-definition', path, ...options };
}

export function attribute<const Name extends string, const Type extends AttributeType>(
  name: Name,
  options: {
    readonly default: ValueInput<AttributeTypeMap[Type]>;
    readonly transient?: boolean;
    readonly type: Type;
  },
): AttributeDefinition<Name, Type> {
  return { kind: 'attribute', name, ...options };
}

type InheritedEmitterDefinition<
  BaseAttributes extends AttributeSchema,
  BaseParameters extends ParameterSchema,
  OverrideAttributes extends AttributeSchema,
  OverrideParameters extends ParameterSchema,
> = EmitterDefinition<
  Omit<BaseAttributes, DefinedKeys<OverrideAttributes>> &
    Pick<OverrideAttributes, DefinedKeys<OverrideAttributes>>,
  Omit<BaseParameters, DefinedKeys<OverrideParameters>> &
    Pick<OverrideParameters, DefinedKeys<OverrideParameters>>
>;

type DefinedKeys<Schema> = {
  [Key in keyof Schema]: [Schema[Key]] extends [never] ? never : Key;
}[keyof Schema];

type LocatedModule<Module extends ModuleDefinition<ModuleStage, object>> = {
  readonly identity: string;
  readonly module: Module;
};

function withoutUndefined<Value extends object>(value: Value | undefined): Partial<Value> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<Value>;
}

function mergeEmitterQuality(
  base: EmitterDefinition['quality'],
  patch: EmitterOverrideConfig['quality'],
): EmitterDefinition['quality'] {
  const quality = Object.fromEntries(
    (['low', 'medium', 'high', 'epic'] as const).flatMap((tier) => {
      const inherited = base?.[tier];
      const override = patch?.[tier];
      if (!inherited && !override) return [];
      const inheritedValues = withoutUndefined({ ...inherited, features: undefined });
      const overrideValues = withoutUndefined({ ...override, features: undefined });
      const features = {
        ...(inherited?.features ?? {}),
        ...withoutUndefined(override?.features),
      };
      const merged = {
        ...inheritedValues,
        ...withoutUndefined(overrideValues),
        ...(Object.keys(features).length === 0 ? {} : { features }),
      };
      if (Object.keys(merged).length === 0) return [];
      return [[tier, merged]];
    }),
  );
  return Object.keys(quality).length === 0 ? undefined : quality;
}

function moduleIdentity(module: ModuleDefinition<ModuleStage, object>, index: number): string {
  return module.label === undefined ? `index:${index}` : `label:${module.label}`;
}

function selectorIdentity(selector: EmitterModuleSelector): string {
  return typeof selector === 'number' ? `index:${selector}` : `label:${selector}`;
}

function mergeModuleList<Module extends ModuleDefinition<ModuleStage, object>>(
  baseValue: Module | readonly Module[] | undefined,
  override: EmitterModuleListOverride<Module> | undefined,
  path: 'init' | 'render' | 'update',
): readonly Module[] | undefined {
  if (override === undefined) {
    return baseValue === undefined
      ? undefined
      : Array.isArray(baseValue)
        ? [...baseValue]
        : [baseValue as Module];
  }
  const base = (
    baseValue === undefined ? [] : Array.isArray(baseValue) ? [...baseValue] : [baseValue as Module]
  ) as readonly Module[];
  const additions = override.modules ?? [];
  const expectedStage = path;
  const diagnostics = additions.flatMap((module, index) =>
    module.stage === expectedStage
      ? []
      : [
          {
            code: 'NACHI_EMITTER_INHERITANCE_STAGE_MISMATCH',
            message: `Inherited ${path} override contains a ${module.stage} module.`,
            path: `${path}.modules[${index}]`,
            phase: 'compile' as const,
            severity: 'error' as const,
          },
        ],
  );
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);

  if ((override.mode ?? 'merge') === 'replace') return [...additions];

  let located: LocatedModule<Module>[] = base.map((module, index) => ({
    identity: moduleIdentity(module, index),
    module,
  }));
  const knownBaseIdentities = new Set(located.map(({ identity }) => identity));
  const selectorDiagnostics: Array<{
    readonly reason: 'duplicate-order' | 'unknown';
    readonly selector: EmitterModuleSelector;
  }> = [];
  for (const selector of override.remove ?? []) {
    const identity = selectorIdentity(selector);
    if (!knownBaseIdentities.has(identity)) {
      selectorDiagnostics.push({ reason: 'unknown', selector });
    }
    located = located.filter((entry) => entry.identity !== identity);
  }

  if ((override.mode ?? 'merge') === 'append') {
    located.push(
      ...additions.map((module, index) => ({
        identity:
          module.label === undefined ? `index:${base.length + index}` : `label:${module.label}`,
        module,
      })),
    );
  } else {
    for (const [index, module] of additions.entries()) {
      const requestedIdentity = moduleIdentity(module, index);
      const targetIndex = located.findIndex(({ identity }) => identity === requestedIdentity);
      if (targetIndex >= 0) {
        const target = located[targetIndex]!;
        located[targetIndex] = { identity: target.identity, module };
      } else {
        located.push({
          identity: requestedIdentity,
          module,
        });
      }
    }
  }

  if (override.order) {
    const selected = new Set<string>();
    const reordered: LocatedModule<Module>[] = [];
    for (const selector of override.order) {
      const identity = selectorIdentity(selector);
      const entry = located.find((candidate) => candidate.identity === identity);
      if (!entry) {
        selectorDiagnostics.push({ reason: 'unknown', selector });
        continue;
      }
      if (selected.has(identity)) {
        selectorDiagnostics.push({ reason: 'duplicate-order', selector });
        continue;
      }
      selected.add(identity);
      reordered.push(entry);
    }
    located = [...reordered, ...located.filter(({ identity }) => !selected.has(identity))];
  }
  if (selectorDiagnostics.length > 0) {
    throw new VfxDiagnosticError(
      selectorDiagnostics.map(({ reason, selector }) => ({
        code: 'NACHI_EMITTER_INHERITANCE_TARGET_UNKNOWN',
        message:
          reason === 'duplicate-order'
            ? `Inherited ${path} override order contains duplicate module selector ${JSON.stringify(selector)}.`
            : `Inherited ${path} override cannot resolve module selector ${JSON.stringify(selector)}.`,
        path,
        phase: 'compile',
        severity: 'error',
      })),
    );
  }
  return located.map(({ module }) => module);
}

function collectInheritanceSchemaDiagnostics(
  base: EmitterDefinition<AttributeSchema, ParameterSchema>,
  overrides: EmitterOverrideConfig<AttributeSchema, ParameterSchema>,
) {
  const diagnostics = [];
  for (const [name, definition] of Object.entries(withoutUndefined(overrides.attributes))) {
    if (definition === undefined) continue;
    const inherited = base.attributes?.[name];
    if (inherited && inherited.type !== definition.type) {
      diagnostics.push({
        code: 'NACHI_EMITTER_INHERITANCE_ATTRIBUTE_TYPE_MISMATCH',
        message: `Inherited attribute "${name}" changes type from ${inherited.type} to ${definition.type}.`,
        path: `attributes.${name}`,
        phase: 'compile' as const,
        severity: 'error' as const,
      });
    }
  }
  for (const [path, definition] of Object.entries(withoutUndefined(overrides.parameters))) {
    if (definition === undefined) continue;
    const inherited = base.parameters?.[path as ParameterPath];
    if (inherited && inherited.type !== definition.type) {
      diagnostics.push({
        code: 'NACHI_EMITTER_INHERITANCE_PARAMETER_TYPE_MISMATCH',
        message: `Inherited parameter "${path}" changes type from ${inherited.type} to ${definition.type}.`,
        path: `parameters.${path}`,
        phase: 'compile' as const,
        severity: 'error' as const,
      });
    }
  }
  return diagnostics;
}

function assertAcyclicAuthoringValue(value: unknown): void {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate !== 'object' || candidate === null) return;
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return;
    if (active.has(candidate)) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_EMITTER_INHERITANCE_CYCLE',
          message: 'Emitter inheritance input contains a cyclic object graph.',
          path,
          phase: 'compile',
          severity: 'error',
        },
      ]);
    }
    active.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) visit(nested, `${path}.${key}`);
    active.delete(candidate);
  };
  visit(value, 'emitter');
}

export function defineEmitter<
  const Attributes extends AttributeSchema = AttributeSchema,
  const Parameters extends ParameterSchema = Readonly<Record<string, never>>,
>(config: EmitterConfig<Attributes, Parameters>): EmitterDefinition<Attributes, Parameters>;

export function defineEmitter<
  const BaseAttributes extends AttributeSchema,
  const BaseParameters extends ParameterSchema,
  const OverrideAttributes extends AttributeSchema = Readonly<Record<string, never>>,
  const OverrideParameters extends ParameterSchema = Readonly<Record<string, never>>,
>(
  base: EmitterDefinition<BaseAttributes, BaseParameters>,
  overrides: EmitterOverrideConfig<OverrideAttributes, OverrideParameters>,
): InheritedEmitterDefinition<
  BaseAttributes,
  BaseParameters,
  OverrideAttributes,
  OverrideParameters
>;

export function defineEmitter(
  baseOrConfig: EmitterConfig | EmitterDefinition,
  overrides?: EmitterOverrideConfig,
): EmitterDefinition;
export function defineEmitter(
  baseOrConfig: EmitterConfig | EmitterDefinition,
  overrides?: EmitterOverrideConfig,
): EmitterDefinition {
  return defineEmitterImplementation(baseOrConfig, overrides);
}

function defineEmitterImplementation(
  baseOrConfig:
    | EmitterConfig<AttributeSchema, ParameterSchema>
    | EmitterDefinition<AttributeSchema, ParameterSchema>,
  overrides?: EmitterOverrideConfig<AttributeSchema, ParameterSchema>,
): EmitterDefinition {
  if (overrides !== undefined) {
    assertAcyclicAuthoringValue(baseOrConfig);
    assertAcyclicAuthoringValue(overrides);
  }
  if (overrides !== undefined && (!('kind' in baseOrConfig) || baseOrConfig.kind !== 'emitter')) {
    throw new VfxDiagnosticError([
      {
        code: 'NACHI_EMITTER_INHERITANCE_BASE_TYPE_MISMATCH',
        message: 'defineEmitter(base, overrides) requires an emitter definition as its base.',
        path: 'base',
        phase: 'compile',
        severity: 'error',
      },
    ]);
  }
  const base = baseOrConfig as EmitterConfig<AttributeSchema, ParameterSchema> &
    Partial<EmitterDefinition<AttributeSchema, ParameterSchema>>;
  const normalizedQuality =
    overrides === undefined
      ? mergeEmitterQuality(undefined, base.quality)
      : mergeEmitterQuality(base.quality, overrides.quality);
  const config =
    overrides === undefined
      ? ({
          ...withoutUndefined({ ...base, quality: undefined }),
          ...(normalizedQuality === undefined ? {} : { quality: normalizedQuality }),
        } as EmitterConfig<AttributeSchema, ParameterSchema>)
      : ({
          ...base,
          ...withoutUndefined({ ...overrides, quality: undefined }),
          attributes: {
            ...(base.attributes ?? {}),
            ...withoutUndefined(overrides.attributes),
          },
          events: { ...(base.events ?? {}), ...withoutUndefined(overrides.events) },
          ...(base.init === undefined && overrides.init === undefined
            ? {}
            : { init: mergeModuleList<InitModule>(base.init, overrides.init, 'init') }),
          lifecycle: { ...(base.lifecycle ?? {}), ...withoutUndefined(overrides.lifecycle) },
          parameters: {
            ...(base.parameters ?? {}),
            ...withoutUndefined(overrides.parameters),
          },
          ...(normalizedQuality === undefined ? {} : { quality: normalizedQuality }),
          render: mergeModuleList<RenderModule>(base.render, overrides.render, 'render'),
          ...(base.update === undefined && overrides.update === undefined
            ? {}
            : { update: mergeModuleList<UpdateModule>(base.update, overrides.update, 'update') }),
        } as EmitterConfig<AttributeSchema, ParameterSchema>);
  const inheritanceDiagnostics =
    overrides === undefined
      ? []
      : collectInheritanceSchemaDiagnostics(
          baseOrConfig as EmitterDefinition<AttributeSchema, ParameterSchema>,
          overrides,
        );
  const events = config.events
    ? Object.fromEntries(
        Object.entries(config.events).map(([eventName, handlers]) => [
          eventName,
          Array.isArray(handlers)
            ? handlers.map((handler) => addEventQueueWrite(handler, eventName))
            : addEventQueueWrite(handlers as EventModule, eventName),
        ]),
      )
    : undefined;
  const normalizedConfig = events === undefined ? config : { ...config, events };
  const diagnostics = [
    ...inheritanceDiagnostics,
    ...resolveAttributeSchema(normalizedConfig).diagnostics,
    ...collectEmitterLifecycleDiagnostics(normalizedConfig),
    ...collectEmitterModuleLabelDiagnostics(normalizedConfig),
    ...collectParameterDeclarationDiagnostics(normalizedConfig.parameters),
    ...(normalizedConfig.bounds &&
    (!Number.isFinite(normalizedConfig.bounds.radius) || normalizedConfig.bounds.radius < 0)
      ? [
          {
            code: 'NACHI_BOUNDS_INVALID',
            message: 'Emitter bounds radius must be a non-negative finite number.',
            path: 'bounds.radius',
            phase: 'compile' as const,
            severity: 'error' as const,
          },
        ]
      : []),
    ...(normalizedConfig.bounds?.center?.some((component) => !Number.isFinite(component))
      ? [
          {
            code: 'NACHI_BOUNDS_INVALID',
            message: 'Emitter bounds center must contain finite components.',
            path: 'bounds.center',
            phase: 'compile' as const,
            severity: 'error' as const,
          },
        ]
      : []),
    ...Object.entries(normalizedConfig.quality ?? {}).flatMap(([tier, quality]) =>
      ['capacityScale', 'spawnRateScale'].flatMap((key) => {
        const value = quality?.[key as 'capacityScale' | 'spawnRateScale'];
        return value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)
          ? [
              {
                code: 'NACHI_QUALITY_SCALE_INVALID',
                message: `${key} must be a finite number in [0, 1].`,
                path: `quality.${tier}.${key}`,
                phase: 'compile' as const,
                severity: 'error' as const,
              },
            ]
          : [];
      }),
    ),
  ];
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new VfxDiagnosticError(diagnostics);
  }

  return { ...normalizedConfig, kind: 'emitter' } as EmitterDefinition;
}

export function burst(options: BurstOptions): SpawnModule {
  return createModule('spawn', 'core/burst', options, {
    reads: ['Emitter.localTime'],
    writes: ['Emitter.spawnCount'],
  });
}

export function rate(options: RateSpawnOptions | number): SpawnModule {
  const config = typeof options === 'number' ? { rate: options } : options;
  return createModule('spawn', 'core/rate', config, {
    reads: ['Emitter.deltaTime'],
    writes: ['Emitter.spawnCount'],
  });
}

export function perDistance(options: PerDistanceSpawnOptions | number): SpawnModule {
  const config = typeof options === 'number' ? { rate: options } : options;
  return createModule('spawn', 'core/per-distance', config, {
    reads: ['Emitter.transform'],
    writes: ['Emitter.spawnCount'],
  });
}

export function positionSphere(options: PositionSphereOptions): InitModule {
  return createModule('init', 'core/position-sphere', options, {
    reads: ['Emitter.transform', 'Emitter.seed', 'Particles.spawnGeneration'],
    writes: ['Particles.position'],
  });
}

export function positionMeshSurface(options: PositionMeshSurfaceOptions): InitModule {
  return createModule('init', 'core/position-mesh-surface', options, {
    reads: ['Emitter.seed', 'Emitter.transform', 'Particles.spawnGeneration'],
    writes: ['Particles.position', 'Particles.surfaceNormal'],
  });
}

export function velocityCone(options: VelocityConeOptions): InitModule {
  return createModule('init', 'core/velocity-cone', options, {
    reads: ['Emitter.seed', 'Particles.spawnGeneration'],
    writes: ['Particles.velocity'],
  });
}

export function velocityMeshNormal(options: VelocityMeshNormalOptions): InitModule {
  return createModule('init', 'core/velocity-mesh-normal', options, {
    reads: ['Particles.surfaceNormal'],
    writes: ['Particles.velocity'],
  });
}

export function lifetime(value: ValueInput<number>): InitModule {
  return createModule(
    'init',
    'core/lifetime',
    { value },
    {
      reads: [],
      writes: ['Particles.age', 'Particles.lifetime'],
    },
  );
}

export function gravity(value: ValueInput<number | Vec3>): UpdateModule {
  return createModule(
    'update',
    'core/gravity',
    { value },
    {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
  );
}

export function drag(value: ValueInput<number>): UpdateModule {
  return createModule(
    'update',
    'core/drag',
    { value },
    {
      reads: ['Emitter.deltaTime', 'Particles.velocity'],
      writes: ['Particles.velocity'],
    },
  );
}

export function curlNoise(options: CurlNoiseOptions): UpdateModule {
  return createModule('update', 'core/curl-noise', options, {
    reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

export function vortex(options: VortexOptions): UpdateModule {
  return createModule('update', 'core/vortex', options, {
    reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

export function pointAttractor(options: PointAttractorOptions): UpdateModule {
  return createModule('update', 'core/point-attractor', options, {
    reads: ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

export function linearForce(options: LinearForceOptions): UpdateModule {
  return createModule('update', 'core/linear-force', options, {
    reads: ['Emitter.deltaTime', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

export function turbulence(options: TurbulenceOptions): UpdateModule {
  return createModule('update', 'core/turbulence', options, {
    reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

export function vectorField(options: VectorFieldOptions): UpdateModule {
  return createModule('update', 'core/vector-field', options, {
    reads: ['Emitter.deltaTime', 'Particles.position', 'Particles.velocity'],
    writes: ['Particles.velocity'],
  });
}

const COLLISION_ACCESS: ModuleAccess = {
  reads: ['Emitter.transform', 'Particles.position', 'Particles.velocity'],
  writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
};

export function collidePlane(options: CollidePlaneOptions): UpdateModule {
  return createModule('update', 'core/collide-plane', options, COLLISION_ACCESS);
}

export function collideSphere(options: CollideSphereOptions): UpdateModule {
  return createModule('update', 'core/collide-sphere', options, COLLISION_ACCESS);
}

export function collideBox(options: CollideBoxOptions): UpdateModule {
  return createModule('update', 'core/collide-box', options, COLLISION_ACCESS);
}

export function collideSceneDepth(options: CollideSceneDepthOptions = {}): UpdateModule {
  return createModule('update', 'core/collide-scene-depth', options, {
    reads: [
      'System.projectionMatrix',
      'System.viewMatrix',
      'System.viewportSize',
      'Particles.position',
      'Particles.velocity',
    ],
    writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
  });
}

export function collideSdf(options: CollideSdfOptions): UpdateModule {
  return createModule('update', 'core/collide-sdf', options, {
    reads: ['Particles.position', 'Particles.velocity'],
    writes: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
  });
}

export function orientToVelocity(): UpdateModule {
  return createModule(
    'update',
    'core/orient-to-velocity',
    {},
    {
      reads: ['Particles.rotation', 'Particles.spriteRotation', 'Particles.velocity'],
      writes: ['Particles.rotation', 'Particles.spriteRotation'],
    },
  );
}

export function sizeOverLife(value: CurveGenerator<number>): UpdateModule {
  return createModule(
    'update',
    'core/size-over-life',
    { value },
    {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.size'],
    },
  );
}

export function lightIntensity(value: ValueInput<number>): InitModule {
  return createModule(
    'init',
    'core/light-intensity',
    { value },
    {
      reads: [],
      writes: ['Particles.intensity'],
    },
  );
}

export function intensityOverLife(value: CurveGenerator<number>): UpdateModule {
  return createModule(
    'update',
    'core/intensity-over-life',
    { value },
    {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.intensity'],
    },
  );
}

export function rotationOverLife(value: CurveGenerator<number>): UpdateModule {
  return createModule(
    'update',
    'core/rotation-over-life',
    { value },
    {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.spriteRotation'],
    },
  );
}

export function velocityOverLife(value: CurveGenerator<number>): UpdateModule {
  return createModule(
    'update',
    'core/velocity-over-life',
    { value },
    {
      reads: [
        'Emitter.deltaTime',
        'Particles.lifetime',
        'Particles.normalizedAge',
        'Particles.velocity',
      ],
      writes: ['Particles.velocity'],
    },
  );
}

export function killVolume(options: KillVolumeOptions): UpdateModule {
  return createModule('update', 'core/kill-volume', options, {
    reads: ['Emitter.transform', 'Particles.position'],
    writes: ['Particles.alive'],
  });
}

export function colorOverLife(value: GradientGenerator): UpdateModule {
  return createModule(
    'update',
    'core/color-over-life',
    { value },
    {
      reads: ['Particles.normalizedAge'],
      writes: ['Particles.color'],
    },
  );
}

export function emitTo(target: string, options: EmitToOptions = {}): EventModule {
  const inheritedAttributes = options.inherit?.map((name) => `Particles.${name}` as const) ?? [];
  return createModule(
    'event',
    'core/emit-to',
    { ...options, target },
    {
      reads: inheritedAttributes,
      writes: ['Emitter.events.pending'],
    },
  );
}

export function flipbook(
  texture: TextureRef,
  options: Omit<FlipbookDefinition, 'kind' | 'texture'>,
): FlipbookDefinition {
  return { ...options, kind: 'flipbook', texture };
}

export function billboard(options: BillboardOptions): RenderModule {
  const velocityRead =
    options.alignment?.mode === 'velocity-aligned' || options.alignment?.mode === 'velocity-stretch'
      ? (['Particles.velocity'] as const)
      : [];
  const flipbookRead =
    options.map?.kind === 'flipbook' ? (['Particles.normalizedAge'] as const) : [];
  return createModule('render', 'core/billboard', options, {
    reads: [
      'Particles.color',
      'Particles.position',
      'Particles.size',
      'Particles.spriteRotation',
      ...velocityRead,
      ...flipbookRead,
      ...(options.sorted ? (['System.viewMatrix'] as const) : []),
    ],
    writes: [],
  });
}

export function faceCamera(options: Omit<BillboardOptions, 'alignment'> = {}): RenderModule {
  return billboard({ ...options, alignment: { mode: 'camera-facing' } });
}

export function meshRenderer(options: MeshRendererOptions): RenderModule {
  const orientationRead =
    options.alignment?.mode === 'velocity'
      ? (['Particles.velocity'] as const)
      : options.alignment?.mode === 'quaternion'
        ? (['Particles.rotation'] as const)
        : [];
  return createModule('render', 'core/mesh-renderer', options, {
    reads: [
      'Particles.color',
      'Particles.position',
      'Particles.scale',
      ...orientationRead,
      ...(options.sorted ? (['System.viewMatrix'] as const) : []),
    ],
    writes: [],
  });
}

export function lightRenderer(options: LightRendererOptions = {}): RenderModule {
  return createModule('render', 'core/light-renderer', options, {
    reads: [
      'Particles.alive',
      'Particles.color',
      'Particles.intensity',
      'Particles.position',
      'Particles.size',
    ],
    writes: [],
  });
}

export function decalRenderer(options: DecalRendererOptions = {}): RenderModule {
  return createModule('render', 'core/decal-renderer', options, {
    reads: [
      'Particles.color',
      'Particles.normalizedAge',
      'Particles.position',
      'Particles.rotation',
      'Particles.size',
    ],
    writes: [],
  });
}

export function defineTslFunction<Bindings extends object = TslParticleBindings>(
  id: string,
  factory: TslModuleFactory<Bindings>,
  version = 1,
): TslFunctionRegistration<Bindings> {
  return {
    factory,
    kind: 'tsl-function-registration',
    ref: { id, kind: 'function-ref', version },
  };
}

export function tslModule<
  Bindings extends object = TslParticleBindings,
  Stage extends 'init' | 'update' = 'update',
>(
  factory: TslModuleFactory<Bindings>,
  options?: TslModuleOptions<Stage>,
): TslModuleDefinition<Stage, Bindings>;
export function tslModule<
  Bindings extends object = TslParticleBindings,
  Stage extends 'init' | 'update' = 'update',
>(
  reference: TslFunctionRef<Bindings>,
  options?: TslModuleOptions<Stage>,
): TslModuleDefinition<Stage, Bindings>;
export function tslModule<
  Bindings extends object = TslParticleBindings,
  Stage extends 'init' | 'update' = 'update',
>(
  registration: TslFunctionRegistration<Bindings>,
  options?: TslModuleOptions<Stage>,
): TslModuleDefinition<Stage, Bindings>;
export function tslModule(
  source: TslFunctionRef | TslFunctionRegistration | TslModuleFactory,
  options: TslModuleOptions = {},
): TslModuleDefinition {
  const stage = options.stage ?? 'update';
  const serializedSource =
    typeof source === 'function'
      ? { kind: 'inline' as const }
      : source.kind === 'tsl-function-registration'
        ? source.ref
        : source;
  const module = createModule(
    stage,
    'core/tsl-module',
    { source: serializedSource },
    options.access,
  ) as TslModuleDefinition;

  const factory =
    typeof source === 'function'
      ? source
      : source.kind === 'tsl-function-registration'
        ? source.factory
        : undefined;
  if (factory) {
    Object.defineProperty(module, 'factory', {
      enumerable: false,
      value: factory,
    });
  }

  return module;
}

export function play<const Target extends string>(target: Target): PlayAction<Target> {
  return { kind: 'play', target };
}

export function stop<const Target extends string>(target: Target): StopAction<Target> {
  return { kind: 'stop', target };
}

export function cameraShake(options: Omit<CameraShakeAction, 'kind'>): CameraShakeAction {
  return { ...options, kind: 'camera-shake' };
}

export function hitStop(durationMs: number, timeScale?: number): HitStopAction {
  return timeScale === undefined
    ? { durationMs, kind: 'hit-stop' }
    : { durationMs, kind: 'hit-stop', timeScale };
}

export function marker(name: string, payload?: JsonValue): MarkerAction {
  return payload === undefined ? { kind: 'marker', name } : { kind: 'marker', name, payload };
}

export function at<const Actions extends readonly TimelineAction[]>(
  time: number,
  ...actions: Actions
): TimelineEntry<TimelineActionTarget<Actions[number]>> {
  return { actions, at: time } as TimelineEntry<TimelineActionTarget<Actions[number]>>;
}

export function timeline<Target extends string>(
  entries: readonly TimelineEntry<Target>[],
  options: Omit<TimelineDefinition<Target>, 'entries' | 'kind'> = {},
): TimelineDefinition<Target> {
  return { ...options, entries, kind: 'timeline' };
}

export function defineEffect<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = Readonly<Record<string, never>>,
>(
  config: EffectConfig<Elements, Parameters>,
): EffectDefinition<Elements, ComposedEffectParameterSchema<Elements, Parameters>> {
  const explicit = (config.parameters ?? {}) as ParameterSchema;
  const declarations = new Map<
    ParameterPath,
    { definition: ParameterDefinition; path: string }[]
  >();
  for (const [elementKey, element] of Object.entries(config.elements)) {
    if (element.kind !== 'emitter') continue;
    for (const [path, definition] of Object.entries(element.parameters ?? {})) {
      const entries = declarations.get(path as ParameterPath) ?? [];
      entries.push({ definition, path: `elements.${elementKey}.parameters.${path}` });
      declarations.set(path as ParameterPath, entries);
    }
  }
  const diagnostics = [...collectParameterDeclarationDiagnostics(explicit)];
  const composed: Record<string, ParameterDefinition> = {};
  for (const [path, entries] of declarations) {
    const authoritative = explicit[path];
    const first = authoritative ?? entries[0]?.definition;
    if (!first) continue;
    const conflicts = entries.filter(({ definition }) => {
      if (definition.type !== first.type) return true;
      if (authoritative) return false;
      return (
        definition.mutable !== first.mutable ||
        JSON.stringify(definition.default) !== JSON.stringify(first.default)
      );
    });
    diagnostics.push(
      ...conflicts.map(({ definition, path: declarationPath }) => ({
        code: 'NACHI_EFFECT_PARAMETER_CONFLICT',
        message: authoritative
          ? `Composed parameter "${path}" conflicts with the effect-level parameter schema (${first.type} versus ${definition.type}).`
          : `Sibling emitter declarations for composed parameter "${path}" disagree (type/default/mutability: ${first.type}/${JSON.stringify(first.default)}/${String(first.mutable === true)} versus ${definition.type}/${JSON.stringify(definition.default)}/${String(definition.mutable === true)}).`,
        path: declarationPath,
        phase: 'compile' as const,
        severity: 'error' as const,
      })),
    );
    composed[path] = first;
  }
  Object.assign(composed, explicit);
  diagnostics.push(...collectParameterDeclarationDiagnostics(composed));
  const distance = config.scalability?.culling?.distance;
  if (
    distance &&
    (!Number.isFinite(distance.fadeEnd) ||
      distance.fadeEnd < 0 ||
      (distance.fadeStart !== undefined &&
        (!Number.isFinite(distance.fadeStart) ||
          distance.fadeStart < 0 ||
          distance.fadeStart > distance.fadeEnd)))
  ) {
    diagnostics.push({
      code: 'NACHI_CULL_DISTANCE_INVALID',
      message: 'Culling fadeStart/fadeEnd must be finite, non-negative, and fadeStart <= fadeEnd.',
      path: 'scalability.culling.distance',
      phase: 'compile',
      severity: 'error',
    });
  }
  const priority = config.scalability?.significance?.priority;
  if (priority !== undefined && !Number.isFinite(priority)) {
    diagnostics.push({
      code: 'NACHI_SIGNIFICANCE_PRIORITY_INVALID',
      message: 'Effect significance priority must be finite.',
      path: 'scalability.significance.priority',
      phase: 'compile',
      severity: 'error',
    });
  }
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new VfxDiagnosticError(diagnostics);
  }
  const elements = Object.fromEntries(
    Object.entries(config.elements).map(([key, element]) => [
      key,
      element.kind === 'emitter'
        ? { ...element, parameters: { ...(element.parameters ?? {}), ...composed } }
        : element,
    ]),
  ) as Elements;
  return {
    ...config,
    elements,
    ...(Object.keys(composed).length === 0 ? {} : { parameters: composed }),
    kind: 'effect',
  } as EffectDefinition<Elements, ComposedEffectParameterSchema<Elements, Parameters>>;
}
