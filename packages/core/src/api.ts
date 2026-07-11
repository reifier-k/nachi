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
  EventModule,
  FlipbookDefinition,
  MeshRendererOptions,
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
  SpawnModule,
  StopAction,
  TextureRef,
  TurbulenceOptions,
  TimelineAction,
  TimelineActionTarget,
  TimelineEntry,
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
} from './types.js';

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

export function defineEmitter<
  const Attributes extends AttributeSchema = AttributeSchema,
  const Parameters extends ParameterSchema = Readonly<Record<string, never>>,
>(config: EmitterConfig<Attributes, Parameters>): EmitterDefinition<Attributes, Parameters> {
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
    ...resolveAttributeSchema<Attributes, Parameters>(normalizedConfig).diagnostics,
    ...collectEmitterLifecycleDiagnostics(normalizedConfig),
    ...collectEmitterModuleLabelDiagnostics(normalizedConfig),
    ...collectParameterDeclarationDiagnostics(normalizedConfig.parameters),
  ];
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new VfxDiagnosticError(diagnostics);
  }

  return { ...normalizedConfig, kind: 'emitter' } as EmitterDefinition<Attributes, Parameters>;
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
    reads: ['Particles.color', 'Particles.position', 'Particles.scale', ...orientationRead],
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

export function at<const Actions extends readonly TimelineAction[]>(
  time: number,
  ...actions: Actions
): TimelineEntry<TimelineActionTarget<Actions[number]>> {
  return { actions, at: time } as TimelineEntry<TimelineActionTarget<Actions[number]>>;
}

export function defineEffect<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = Readonly<Record<string, never>>,
>(config: EffectConfig<Elements, Parameters>): EffectDefinition<Elements, Parameters> {
  const diagnostics = collectParameterDeclarationDiagnostics(config.parameters);
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    throw new VfxDiagnosticError(diagnostics);
  }
  return { ...config, kind: 'effect' } as EffectDefinition<Elements, Parameters>;
}
