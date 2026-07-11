export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export type ColorInput = string | Vec3 | Vec4;
/** Euler inputs are radians in XYZ order; four-component inputs are quaternions. */
export type RotationInput =
  | Vec3
  | Vec4
  | { readonly x: number; readonly y: number; readonly z: number };
export type PositionInput = Vec3 | { readonly x: number; readonly y: number; readonly z: number };

export type ParameterNamespace = 'Emitter' | 'Particles' | 'System' | 'User';
export type ParameterPath<
  Namespace extends ParameterNamespace = ParameterNamespace,
  Name extends string = string,
> = `${Namespace}.${Name}`;
export type UserParameterPath<Name extends string = string> = ParameterPath<'User', Name>;
export type ParticleAttributePath<Name extends string = string> = ParameterPath<'Particles', Name>;
export type DataReference = ParameterPath;
export type EmitterEventQueuePath<Name extends string = string> = ParameterPath<
  'Emitter',
  `events.${Name}`
>;
export type EmitterEventPayloadPath<Name extends string = string> = ParameterPath<
  'Emitter',
  `eventPayload.${Name}`
>;

export type AttributeType =
  | 'bool'
  | 'color'
  | 'f32'
  | 'i32'
  | 'mat3'
  | 'mat4'
  | 'quat'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4';

export interface AttributeTypeMap {
  bool: boolean;
  color: Vec4;
  f32: number;
  i32: number;
  mat3: readonly number[];
  mat4: readonly number[];
  quat: Vec4;
  u32: number;
  vec2: Vec2;
  vec3: Vec3;
  vec4: Vec4;
}

export interface BuiltInParticleAttributes {
  age: number;
  alive: boolean;
  color: Vec4;
  lifetime: number;
  mass: number;
  normalizedAge: number;
  position: Vec3;
  rotation: Vec4;
  scale: Vec3;
  size: number;
  spriteRotation: number;
  /** Monotonically increments each time this physical slot is allocated. */
  spawnGeneration: number;
  velocity: Vec3;
}

export interface RangeGenerator<T> {
  readonly kind: 'range';
  readonly distribution: 'uniform';
  readonly max: T;
  readonly min: T;
}

export type CurveInterpolation = 'constant' | 'cubic' | 'linear';

export interface CurveKey<T> {
  readonly interpolation?: CurveInterpolation;
  readonly time: number;
  readonly value: T;
}

export interface CurveGenerator<T> {
  readonly kind: 'curve';
  readonly keys: readonly CurveKey<T>[];
}

export interface GradientStop {
  readonly color: ColorInput;
  readonly position: number;
}

export interface GradientGenerator {
  readonly kind: 'gradient';
  readonly stops: readonly GradientStop[];
}

export interface ParameterGenerator<T = JsonValue> {
  readonly kind: 'parameter';
  readonly path: ParameterPath;
  readonly fallback?: T;
}

export type ValueGenerator<T> = CurveGenerator<T> | ParameterGenerator<T> | RangeGenerator<T>;
export type ValueInput<T> = T | ValueGenerator<T>;

export interface AttributeDefinition<
  Name extends string = string,
  Type extends AttributeType = AttributeType,
> {
  readonly kind: 'attribute';
  readonly name: Name;
  readonly type: Type;
  readonly default: ValueInput<AttributeTypeMap[Type]>;
  readonly transient?: boolean;
}

export type AttributeSchema = Readonly<Record<string, AttributeDefinition>>;

/** Logical component count. Backend layout owns padding (for example, mat3 has physical stride 12). */
export type AttributeComponentCount = 1 | 2 | 3 | 4 | 9 | 16;
export type TslStorageType =
  | 'float'
  | 'int'
  | 'ivec4'
  | 'mat3'
  | 'mat4'
  | 'uint'
  | 'uvec4'
  | 'vec2'
  | 'vec3'
  | 'vec4';
export type ResolvedAttributeSource = 'built-in' | 'custom';

export interface ResolvedAttributePhysicalAllocation {
  /** Index into ResolvedAttributeSchema.storageArrays. */
  readonly bufferIndex: number;
  /** Vec4 record within a particle's packed stride. Dedicated buffers always use group 0. */
  readonly group: number;
  /** First component lane within the vec4 record. Dedicated buffers always use offset 0. */
  readonly offset: 0 | 1 | 2 | 3;
  readonly packed: boolean;
}

export interface ResolvedAttribute {
  readonly components: AttributeComponentCount;
  readonly default: ValueInput<AttributeTypeMap[AttributeType]>;
  readonly logicalType: AttributeType;
  readonly name: string;
  readonly path: ParticleAttributePath;
  readonly physical: ResolvedAttributePhysicalAllocation;
  readonly source: ResolvedAttributeSource;
  /** Stable logical enumeration order. Physical storage is selected by physical.bufferIndex. */
  readonly storageIndex: number;
  readonly storageType: TslStorageType;
  readonly transient: boolean;
}

export interface ResolvedAttributeStorage {
  readonly attributes: readonly string[];
  readonly componentType: 'float' | 'int' | 'uint';
  /** Number of vec4 records per particle. Dedicated buffers use a stride of one. */
  readonly groupCount: number;
  readonly index: number;
  readonly kind: 'instanced-array';
  readonly length: number;
  readonly name: string;
  readonly packed: boolean;
  readonly type: TslStorageType;
}

export interface ResolvedAttributeSchema {
  readonly attributes: readonly ResolvedAttribute[];
  readonly byName: Readonly<Record<string, ResolvedAttribute>>;
  readonly capacity: number;
  readonly kind: 'resolved-attribute-schema';
  readonly layout: 'soa';
  readonly storageArrays: readonly ResolvedAttributeStorage[];
}

export interface ParameterDefinition<
  Path extends ParameterPath = ParameterPath,
  Type extends AttributeType = AttributeType,
> {
  readonly kind: 'parameter-definition';
  readonly path: Path;
  readonly type: Type;
  readonly default: AttributeTypeMap[Type];
  readonly mutable?: boolean;
}

export type ParameterSchema = Readonly<Record<ParameterPath, ParameterDefinition>>;
export type EmptyParameterSchema = Readonly<Record<string, never>>;

export type ModuleStage = 'event' | 'init' | 'render' | 'spawn' | 'update';

export interface ModuleAccess {
  readonly reads: readonly DataReference[];
  readonly writes: readonly DataReference[];
  readonly optionalReads?: readonly DataReference[];
}

export interface ModuleDefinition<
  Stage extends ModuleStage = ModuleStage,
  Config extends object = Record<string, JsonValue>,
> {
  readonly access?: ModuleAccess;
  readonly config: Readonly<Config>;
  readonly kind: 'module';
  readonly label?: string;
  readonly stage: Stage;
  readonly type: string;
  readonly version: number;
}

export type SpawnModule = ModuleDefinition<'spawn', object>;
export type InitModule = ModuleDefinition<'init', object>;
export type UpdateModule = ModuleDefinition<'update', object>;
export type EventModule = ModuleDefinition<'event', object>;
export type RenderModule = ModuleDefinition<'render', object>;

export interface ModuleRegistration<
  Stage extends ModuleStage = ModuleStage,
  Config extends object = Record<string, JsonValue>,
> {
  readonly type: string;
  readonly version: number;
  readonly stage: Stage;
  readonly access: ModuleAccess;
  readonly validate?: (config: Readonly<Config>) => readonly VfxDiagnostic[];
  readonly compile: (context: TslCompileContext, config: Readonly<Config>) => void;
}

export interface TslExpression<T> {
  readonly valueType?: T;
  add(value: T | TslExpression<T>): TslExpression<T>;
  div(value: number | TslExpression<number>): TslExpression<T>;
  mul(value: number | TslExpression<number>): TslExpression<T>;
  sub(value: T | TslExpression<T>): TslExpression<T>;
  /** Explicit numeric conversion for integer-backed bindings such as spawnOrder. */
  toFloat(): TslExpression<number>;
}

export interface BuiltInTslParticleBindings {
  readonly age: TslExpression<number>;
  readonly alive: TslExpression<boolean>;
  readonly color: TslExpression<Vec4>;
  readonly intensity: TslExpression<number>;
  readonly lifetime: TslExpression<number>;
  readonly mass: TslExpression<number>;
  readonly normalizedAge: TslExpression<number>;
  readonly position: TslExpression<Vec3>;
  readonly rotation: TslExpression<Vec4>;
  readonly scale: TslExpression<Vec3>;
  readonly size: TslExpression<number>;
  readonly spriteRotation: TslExpression<number>;
  readonly spawnGeneration: TslExpression<number>;
  readonly spawnOrder: TslExpression<number>;
  readonly velocity: TslExpression<Vec3>;
}

export type NoCustomAttributes = Record<never, never>;

export type TslParticleBindings<
  CustomAttributes extends Readonly<Record<string, unknown>> = NoCustomAttributes,
> = BuiltInTslParticleBindings & {
  readonly [Name in keyof CustomAttributes as `custom.${Extract<Name, string>}`]: TslExpression<
    CustomAttributes[Name]
  >;
};

export type TslModuleOutputs<Bindings extends object> = Partial<{
  [Key in keyof Bindings]: Bindings[Key];
}>;

export type TslModuleFactory<Bindings extends object = TslParticleBindings> = (
  bindings: Readonly<Bindings>,
) => TslModuleOutputs<Bindings>;

export interface TslFunctionRef<Bindings extends object = TslParticleBindings> {
  readonly kind: 'function-ref';
  readonly id: string;
  readonly version: number;
  /** Type-only carrier; this property is never materialized or serialized. */
  readonly __bindings?: Bindings;
}

export interface TslFunctionRegistration<Bindings extends object = TslParticleBindings> {
  readonly kind: 'tsl-function-registration';
  readonly ref: TslFunctionRef<Bindings>;
  readonly factory: TslModuleFactory<Bindings>;
}

export interface TslModuleOptions<Stage extends 'init' | 'update' = 'init' | 'update'> {
  readonly access?: ModuleAccess;
  readonly stage?: Stage;
}

export interface TslModuleConfig<Bindings extends object = TslParticleBindings> {
  readonly source: { readonly kind: 'inline' } | TslFunctionRef<Bindings>;
}

export interface TslModuleDefinition<
  Stage extends 'init' | 'update' = 'init' | 'update',
  Bindings extends object = TslParticleBindings,
> extends ModuleDefinition<Stage, TslModuleConfig<Bindings>> {
  /** Non-enumerable authoring data. It is never written into the JSON asset. */
  readonly factory?: TslModuleFactory<Bindings>;
}

/**
 * `context.emitEvent(condition)` is reserved for a future Update-only custom-event API and is
 * intentionally absent from the M5 compile context.
 */
export interface TslCompileContext {
  readonly stage: ModuleStage;
  readonly attributes: Readonly<Record<string, TslExpression<unknown>>>;
  readonly parameters: Readonly<Record<ParameterPath, TslExpression<unknown>>>;
}

export interface BurstOptions {
  readonly count: ValueInput<number>;
  readonly cycles?: number;
  readonly interval?: number;
}

export interface RateSpawnOptions {
  /** Particles emitted per emitter-local second. */
  readonly rate: number;
}

export interface PerDistanceSpawnOptions {
  /** Particles emitted per world-space unit travelled by Emitter.transform. */
  readonly rate: number;
}

export interface PositionSphereOptions {
  readonly radius: ValueInput<number>;
  readonly surfaceOnly?: boolean;
}

export interface VelocityConeOptions {
  readonly angle: ValueInput<number>;
  readonly direction: Vec3;
  readonly speed: ValueInput<number>;
}

export interface CurlNoiseOptions {
  readonly frequency: ValueInput<number>;
  readonly strength: ValueInput<number>;
}

export interface VortexOptions {
  readonly axis: Vec3;
  readonly center?: ValueInput<Vec3>;
  /** Optional acceleration towards the vortex axis. */
  readonly inwardStrength?: ValueInput<number>;
  /** Coordinate space for axis and center. Defaults to world. */
  readonly space?: 'emitter' | 'world';
  readonly strength: ValueInput<number>;
}

export interface PointAttractorOptions {
  /** Power applied to distance attenuation. Defaults to 2. */
  readonly falloff?: ValueInput<number>;
  readonly position: ValueInput<Vec3>;
  /** Optional world-space influence radius. */
  readonly radius?: ValueInput<number>;
  /** Coordinate space for position. Defaults to world. */
  readonly space?: 'emitter' | 'world';
  /** Positive values attract and negative values repel. */
  readonly strength: ValueInput<number>;
}

export interface LinearForceOptions {
  readonly force: ValueInput<Vec3>;
}

export interface TurbulenceOptions {
  readonly frequency: ValueInput<number>;
  /** Fractal simplex octave count, clamped to 1-4. Defaults to 3. */
  readonly octaves?: number;
  readonly strength: ValueInput<number>;
}

export interface VectorFieldOptions {
  readonly field: FieldRef;
  readonly strength: ValueInput<number>;
  /** Repeats the field outside its declared bounds instead of clamping. */
  readonly tiling?: boolean;
}

export interface PositionMeshSurfaceOptions {
  readonly mesh: MeshRef;
  readonly mode: 'surface';
}

export interface VelocityMeshNormalOptions {
  readonly speed: ValueInput<number>;
}

export type CollisionMode = 'bounce' | 'kill' | 'stick';
export type CollisionSpace = 'emitter' | 'world';

interface CollisionResponseOptions {
  /** Normal restitution coefficient. Defaults to 1. */
  readonly bounce?: ValueInput<number>;
  /** Tangential velocity loss in the inclusive range [0, 1]. Defaults to 0. */
  readonly friction?: ValueInput<number>;
  readonly mode: CollisionMode;
  /** Collider coordinate space. Defaults to world. */
  readonly space?: CollisionSpace;
}

export interface CollidePlaneOptions extends CollisionResponseOptions {
  readonly normal: Vec3;
  readonly offset: ValueInput<number>;
}

export interface CollideSphereOptions extends CollisionResponseOptions {
  readonly center: ValueInput<Vec3>;
  readonly radius: ValueInput<number>;
}

export interface CollideBoxOptions extends CollisionResponseOptions {
  readonly center: ValueInput<Vec3>;
  readonly size: ValueInput<Vec3>;
}

export interface CollideSceneDepthOptions {
  /** Normal restitution coefficient. Defaults to 1. */
  readonly bounce?: ValueInput<number>;
  /** Tangential velocity loss in the inclusive range [0, 1]. Defaults to 0. */
  readonly friction?: ValueInput<number>;
  /** Defaults to bounce. */
  readonly mode?: CollisionMode;
  /** World-space separation applied after reconstructing the scene surface. Defaults to 0.001. */
  readonly surfaceOffset?: ValueInput<number>;
  /** Maximum linear view-depth penetration accepted as a collision. Defaults to 0.1. */
  readonly thickness?: ValueInput<number>;
}

export interface CollideSdfOptions extends Omit<CollisionResponseOptions, 'space'> {
  readonly field: SdfRef;
  /** Maximum penetration eligible for correction. Omitted accepts every negative distance. */
  readonly thickness?: ValueInput<number>;
}

export type SdfShape =
  | {
      readonly center: Vec3;
      readonly radius: number;
      readonly shape: 'sphere';
    }
  | {
      readonly center: Vec3;
      readonly size: Vec3;
      readonly shape: 'box';
    };

export interface BakeSdfOptions {
  readonly boundsMax: Vec3;
  readonly boundsMin: Vec3;
  readonly resolution: readonly [number, number, number];
  /** Shapes are combined as a signed-distance union. */
  readonly shapes: readonly SdfShape[];
}

export interface ParsedSdfField {
  readonly boundsMax: Vec3;
  readonly boundsMin: Vec3;
  readonly distances: Float32Array;
  readonly resolution: readonly [number, number, number];
}

export interface ParsedVectorField {
  readonly boundsMax: Vec3;
  readonly boundsMin: Vec3;
  readonly resolution: readonly [number, number, number];
  /** X-major, then Y, then Z vec3 samples. */
  readonly vectors: Float32Array;
}

interface KillVolumeBaseOptions {
  readonly mode: 'inside' | 'outside';
}

export type KillVolumeOptions =
  | (KillVolumeBaseOptions & {
      readonly center?: ValueInput<Vec3>;
      readonly shape: 'box';
      readonly size: ValueInput<Vec3>;
    })
  | (KillVolumeBaseOptions & {
      readonly center?: ValueInput<Vec3>;
      readonly radius: ValueInput<number>;
      readonly shape: 'sphere';
    })
  | (KillVolumeBaseOptions & {
      /** Local-space plane normal, normalized before testing. The inside half-space has dot(normalize(normal), p) <= offset. */
      readonly normal: Vec3;
      readonly offset?: ValueInput<number>;
      readonly shape: 'plane';
    });

export type BlendingMode = 'additive' | 'alpha' | 'multiply' | 'premultiplied';

export interface AssetRef<AssetType extends string = string> {
  readonly kind: 'asset-ref';
  readonly assetType: AssetType;
  readonly uri: string;
}

export type TextureRef = AssetRef<'texture'>;
export type GeometryRef = AssetRef<'geometry'>;
export type FieldRef = AssetRef<'vector-field'>;
export type MeshRef = AssetRef<'mesh'>;
export type SdfRef = AssetRef<'sdf'>;

/** Playback reads Particles.normalizedAge; without a lifetime writer it remains on frame 0. */
export interface FlipbookDefinition {
  readonly kind: 'flipbook';
  readonly texture: TextureRef;
  /** Atlas columns. Frames advance left-to-right, then top-to-bottom. */
  readonly cols: number;
  /** Atlas rows. Frame 0 is the top-left cell, including for flipY textures. */
  readonly rows: number;
  /** Defaults to true. False selects discrete frames without adjacent-frame blending. */
  readonly interpolate?: boolean;
  /** A TextureRef enables MV UV warping. True without a resource falls back with a warning. */
  readonly motionVectors?: boolean | TextureRef;
}

export interface BillboardOptions {
  readonly alignment?:
    | { readonly mode: 'camera-facing' }
    | { readonly mode: 'custom-axis'; readonly axis: Vec3 }
    | { readonly mode: 'velocity-aligned' }
    | { readonly mode: 'velocity-stretch'; readonly factor?: number };
  readonly blending?: BlendingMode;
  /**
   * Routes the sprite through Three's standard physical-lighting model. The optional normal map
   * is tangent-space data and must resolve to a linear/NoColorSpace texture.
   */
  readonly lit?:
    | boolean
    | {
        readonly metalness?: number;
        readonly normalMap?: TextureRef;
        readonly roughness?: number;
      };
  /** WebGPU-only back-to-front particle sorting by camera depth. Alpha modes only. */
  readonly sorted?: boolean;
  /** Local-space center used by emitter-level coarse sorting. Defaults to the emitter origin. */
  readonly sortCenter?: Vec3;
  readonly cutout?: { readonly vertices: 4 | 5 | 6 | 7 | 8 };
  readonly map?: FlipbookDefinition | TextureRef;
  /**
   * Enables scene-depth intersection fading. fadeDistance is measured in Three.js linearized
   * normalized camera-depth units; true uses the spike-calibrated default of 0.035.
   */
  readonly soft?: boolean | { readonly fadeDistance: number };
}

export interface MeshRendererOptions {
  readonly alignment?:
    | { readonly mode: 'custom-axis'; readonly axis: Vec3 }
    | { readonly mode: 'none' }
    | { readonly mode: 'quaternion' }
    | { readonly mode: 'velocity' };
  readonly blending?: BlendingMode;
  /** WebGPU-only back-to-front particle sorting by camera depth. Alpha modes only. */
  readonly sorted?: boolean;
  /** Local-space center used by emitter-level coarse sorting. Defaults to the emitter origin. */
  readonly sortCenter?: Vec3;
  readonly geometry: GeometryRef;
}

export interface LightRendererOptions {
  /** Hard CPU PointLight-pool bound. Defaults to 8. */
  readonly maxLights?: number;
  /** Multiplies Particles.size to obtain PointLight.distance. Defaults to 1. */
  readonly radiusScale?: number;
  /** GPU top-N selection key. */
  readonly priority?: 'intensity' | 'intensity-radius';
}

export interface DecalRendererOptions {
  readonly blending?: Extract<BlendingMode, 'alpha' | 'premultiplied'>;
  /** Multiplies Particles.size to obtain the projection-box edge length. Defaults to 1. */
  readonly sizeScale?: number;
  /** Multiplies alpha by 1 - normalizedAge. Defaults to true. */
  readonly fadeOverLife?: boolean;
  readonly map?: TextureRef;
}

export interface EmitToOptions {
  readonly inherit?: readonly string[];
}

export type ParticleEventName = 'onCollision' | 'onCustom' | 'onDeath' | 'onSpawn' | (string & {});

export interface EmitterLifecycle {
  readonly duration?: number;
  readonly loopCount?: number | 'infinite';
  readonly prewarm?: number;
  readonly startDelay?: number;
}

export type EmitterIntegration = 'euler' | 'none';

export interface EmitterConfig<
  Attributes extends AttributeSchema = AttributeSchema,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> {
  readonly capacity: number;
  readonly attributes?: Attributes;
  readonly events?: Partial<Record<ParticleEventName, EventModule | readonly EventModule[]>>;
  readonly init?: readonly InitModule[];
  readonly integration?: EmitterIntegration;
  readonly lifecycle?: EmitterLifecycle;
  readonly parameters?: Parameters;
  readonly render: RenderModule | readonly RenderModule[];
  readonly spawn: SpawnModule | readonly SpawnModule[];
  readonly update?: readonly UpdateModule[];
}

export interface EmitterDefinition<
  Attributes extends AttributeSchema = AttributeSchema,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> extends EmitterConfig<Attributes, Parameters> {
  readonly kind: 'emitter';
}

export type EmitterModuleSelector = number | string;

/**
 * Declarative patch for an inherited ordered module stack. `merge` is the default: labeled child
 * modules replace the same label and unlabeled child modules replace the same normalized index.
 */
export interface EmitterModuleListOverride<Module extends ModuleDefinition<ModuleStage, object>> {
  readonly mode?: 'append' | 'merge' | 'replace';
  readonly modules?: readonly Module[];
  readonly order?: readonly EmitterModuleSelector[];
  readonly remove?: readonly EmitterModuleSelector[];
}

export interface EmitterOverrideConfig<
  Attributes extends AttributeSchema = AttributeSchema,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> {
  readonly attributes?: Attributes;
  readonly capacity?: number;
  readonly events?: Partial<Record<ParticleEventName, EventModule | readonly EventModule[]>>;
  readonly init?: EmitterModuleListOverride<InitModule>;
  readonly integration?: EmitterIntegration;
  readonly lifecycle?: EmitterLifecycle;
  readonly parameters?: Parameters;
  readonly render?: EmitterModuleListOverride<RenderModule>;
  /** Spawn policy is replaced as a unit; it is not a particle module-stack inheritance patch. */
  readonly spawn?: SpawnModule | readonly SpawnModule[];
  readonly update?: EmitterModuleListOverride<UpdateModule>;
}

export interface VisualElementDefinition<Config extends object = object> {
  readonly config: Readonly<Config>;
  readonly kind: 'visual-element';
  readonly type: string;
  readonly version: number;
}

export type EffectElementDefinition =
  | EmitterDefinition<AttributeSchema, ParameterSchema>
  | VisualElementDefinition;
export type EffectElements = Readonly<Record<string, EffectElementDefinition>>;

export interface PlayAction<Target extends string = string> {
  readonly kind: 'play';
  readonly target: Target;
}

export interface StopAction<Target extends string = string> {
  readonly kind: 'stop';
  readonly target: Target;
}

export interface CameraShakeAction {
  readonly kind: 'camera-shake';
  readonly duration?: number;
  readonly frequency?: number;
  readonly strength: number;
}

export interface HitStopAction {
  readonly kind: 'hit-stop';
  readonly durationMs: number;
  readonly timeScale?: number;
}

export interface MarkerAction {
  readonly kind: 'marker';
  readonly name: string;
  readonly payload?: JsonValue;
}

export type TimelineAction<Target extends string = string> =
  | CameraShakeAction
  | HitStopAction
  | MarkerAction
  | PlayAction<Target>
  | StopAction<Target>;

export type TimelineActionTarget<Action> =
  Action extends PlayAction<infer Target>
    ? Target
    : Action extends StopAction<infer Target>
      ? Target
      : never;

export interface TimelineEntry<Target extends string = string> {
  readonly actions: readonly TimelineAction<Target>[];
  readonly at: number;
}

export interface TimelineDefinition<Target extends string = string> {
  readonly duration?: number;
  readonly entries: readonly TimelineEntry<Target>[];
  readonly kind: 'timeline';
  readonly loop?: boolean | number;
  readonly speed?: number;
}

export interface EffectConfig<
  Elements extends EffectElements = EffectElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> {
  readonly elements: Elements;
  readonly parameters?: Parameters;
  readonly timeline?:
    | TimelineDefinition<Extract<keyof Elements, string>>
    | readonly TimelineEntry<Extract<keyof Elements, string>>[];
}

export interface EffectDefinition<
  Elements extends EffectElements = EffectElements,
  Parameters extends ParameterSchema = EmptyParameterSchema,
> extends EffectConfig<Elements, Parameters> {
  readonly kind: 'effect';
}

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

type ElementParameterUnion<Elements extends EffectElements> = {
  [Key in keyof Elements]: Elements[Key] extends {
    readonly kind: 'emitter';
    readonly parameters?: infer Parameters;
  }
    ? Parameters extends ParameterSchema
      ? Parameters
      : never
    : never;
}[keyof Elements];

type ElementParameterSchema<Elements extends EffectElements> = [
  ElementParameterUnion<Elements>,
] extends [never]
  ? EmptyParameterSchema
  : UnionToIntersection<ElementParameterUnion<Elements>>;

/** Effect declarations override compatible child declarations; child-only User.* paths are lifted. */
export type ComposedEffectParameterSchema<
  Elements extends EffectElements,
  Parameters extends ParameterSchema,
> = Readonly<{
  [Path in Extract<
    | keyof Parameters
    | {
        [Key in keyof ElementParameterSchema<Elements>]: [
          ElementParameterSchema<Elements>[Key],
        ] extends [never]
          ? never
          : Key;
      }[keyof ElementParameterSchema<Elements>],
    ParameterPath
  >]: Path extends keyof Parameters
    ? Parameters[Path] extends ParameterDefinition
      ? Parameters[Path]
      : never
    : Path extends keyof ElementParameterSchema<Elements>
      ? ElementParameterSchema<Elements>[Path] extends ParameterDefinition
        ? ElementParameterSchema<Elements>[Path]
        : never
      : never;
}>;

export type DefinitionParameterSchema<Definition> = Definition extends {
  readonly parameters?: infer Parameters;
}
  ? Parameters extends ParameterSchema
    ? Parameters
    : EmptyParameterSchema
  : EmptyParameterSchema;

export type UserParameterKeys<Definition> = Extract<
  keyof DefinitionParameterSchema<Definition>,
  UserParameterPath
>;

export type DefinitionParameterValue<Definition, Path extends UserParameterKeys<Definition>> =
  DefinitionParameterSchema<Definition>[Path] extends ParameterDefinition<ParameterPath, infer Type>
    ? AttributeTypeMap[Type]
    : never;

export type DefinitionParameterValues<Definition> = Readonly<
  Partial<{
    [Path in UserParameterKeys<Definition>]: DefinitionParameterValue<Definition, Path>;
  }>
>;

export interface EffectSpawnOptions<Definition = EffectDefinition> {
  readonly parameters?: DefinitionParameterValues<Definition>;
  readonly position?: PositionInput;
  readonly rotation?: RotationInput;
  readonly seed?: number;
  readonly timeScale?: number;
}

export interface EffectWorldTransform {
  readonly position: PositionInput;
  readonly rotation?: RotationInput;
}

export interface EffectTransformSource {
  getWorldTransform(): EffectWorldTransform;
}

export type EffectInstanceState = 'active' | 'complete' | 'error' | 'released' | 'stopped';

export interface EffectEventSummary {
  /** Aggregate since the previous configured readback, never an individual particle payload. */
  readonly count: number;
  readonly event: 'death' | (string & {});
}

export type EffectEventCallback = (summary: EffectEventSummary) => void;

export interface EffectInstance<Definition = EffectDefinition> {
  readonly definition: Definition;
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly id: string;
  readonly localTime: number;
  readonly state: EffectInstanceState;
  readonly timeScale: number;
  applyHitStop(durationMs: number, timeScale?: number): void;
  attachTo(source: EffectTransformSource): void;
  detach(): void;
  on(event: 'death' | (string & {}), callback: EffectEventCallback): () => void;
  release(): void;
  setParameter<Path extends UserParameterKeys<Definition>>(
    path: Path,
    value: DefinitionParameterValue<Definition, Path>,
  ): void;
  setTimeScale(timeScale: number): void;
  setTransform(position: PositionInput, rotation?: RotationInput): void;
  /** Stops scheduling immediately. GPU resources remain owned until release(). */
  stop(): void;
}

export interface FxMaterialDefinition {
  readonly kind: 'fx-material';
  readonly options: FxMaterialOptions;
}

export interface UvDefinition {
  readonly kind: 'uv';
  readonly type: string;
  readonly flow?: { readonly speed: Vec2 };
}

export interface PolarUvBuilder {
  flow(options: { readonly speed: Vec2 }): UvDefinition;
}

export interface FxMaterialOptions {
  readonly blending?: BlendingMode;
  readonly dissolve?: {
    readonly overLife: CurveGenerator<number>;
    readonly texture: TextureRef;
  };
  readonly fresnel?: {
    readonly color: ColorInput;
    readonly power: number;
  };
  readonly uv?: UvDefinition;
}

export interface SlashArcOptions {
  readonly angle: number;
  readonly material: FxMaterialDefinition;
}

export type SlashArcFactory = (
  options: SlashArcOptions,
) => VisualElementDefinition<SlashArcOptions>;
export type FxMaterialFactory = (options: FxMaterialOptions) => FxMaterialDefinition;
export type PolarUvFactory = () => PolarUvBuilder;

export type DiagnosticPhase = 'compile' | 'deserialize' | 'runtime' | 'serialize';
export type DiagnosticSeverity = 'error' | 'warning';

export interface VfxDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly phase: DiagnosticPhase;
  readonly severity: DiagnosticSeverity;
  readonly hint?: string;
}

export interface VfxAssetDocument {
  readonly kind: 'vfx-effect';
  readonly schema: 'com.nachi.effect';
  readonly schemaVersion: number;
  readonly effect: JsonValue;
}

export type RuntimeCallback = (...arguments_: unknown[]) => unknown;

export interface CallbackRef {
  readonly kind: 'callback-ref';
  readonly id: string;
  readonly version: number;
}

export interface CallbackRegistration {
  readonly kind: 'callback-registration';
  readonly ref: CallbackRef;
  readonly callback: RuntimeCallback;
}

export interface VfxRegistry {
  registerCallback(registration: CallbackRegistration): void;
  registerModule(registration: ModuleRegistration): void;
  registerTsl(registration: TslFunctionRegistration): void;
  resolveCallback(reference: CallbackRef): RuntimeCallback | undefined;
  resolveModule(type: string, version: number): ModuleRegistration | undefined;
  resolveTsl<Bindings extends object>(
    reference: TslFunctionRef<Bindings>,
  ): TslModuleFactory<Bindings> | undefined;
}

export interface CompileResult<T> {
  readonly diagnostics: readonly VfxDiagnostic[];
  readonly ok: boolean;
  readonly value?: T;
}
