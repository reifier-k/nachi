import {
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
  packedComponentIndex,
  resolvePackedAttributeAddress,
} from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import type { VfxRuntimeRenderer } from './system.js';
import type {
  AttributeType,
  EffectDefinition,
  EffectElements,
  EffectInstance,
  EffectSpawnOptions,
  EmptyParameterSchema,
  ParameterSchema,
  ResolvedAttribute,
  ResolvedAttributeSchema,
  ResolvedAttributeStorage,
} from './types.js';
import type { VFXSystem, VfxEmitterRuntimeView } from './system.js';

export type SimulationCacheCompression = 'float32' | 'quantized-u16';
export type SimulationCacheInterpolation = 'linear' | 'nearest';

type CacheAttributeEncoding = 'float32' | 'int32' | 'quantized-u16' | 'uint32';

export interface SimulationCacheAttributeMetadata {
  readonly components: number;
  readonly encoding: CacheAttributeEncoding;
  readonly frameStrideBytes: number;
  readonly logicalType: AttributeType;
  readonly name: string;
  readonly offsetBytes: number;
  readonly quantization?: {
    readonly maximum: readonly number[];
    readonly minimum: readonly number[];
  };
}

export interface SimulationCacheEmitterMetadata {
  readonly aliveCounts: readonly number[];
  readonly aliveIndicesFrameStrideBytes: number;
  readonly aliveIndicesOffsetBytes: number;
  readonly attributes: readonly SimulationCacheAttributeMetadata[];
  readonly birthIndicesFrameStrideBytes?: number;
  readonly birthIndicesOffsetBytes?: number;
  readonly capacity: number;
  readonly key: string;
  readonly nextSpawnOrders?: readonly number[];
}

export interface SimulationCacheMetadata {
  readonly compression: SimulationCacheCompression;
  readonly durationSeconds: number;
  readonly emitters: readonly SimulationCacheEmitterMetadata[];
  readonly frameCount: number;
  readonly frameRate: number;
  readonly interpolation: SimulationCacheInterpolation;
  readonly kind: 'nachi-simulation-cache-metadata';
  readonly loop: {
    readonly aliveIndicesMatch: boolean;
    readonly continuous: boolean;
    readonly enabled: boolean;
    readonly integerAttributesMatch: boolean;
    readonly maximumAttributeError: number;
    readonly tolerance: number;
  };
  readonly sampleStartFrame: number;
  readonly sourceBackend: 'webgl2' | 'webgpu';
  readonly uploadBytesPerFrame: number;
  readonly version: 1;
}

export interface SimulationCache {
  readonly data: ArrayBuffer;
  readonly kind: 'simulation-cache';
  readonly metadata: SimulationCacheMetadata;
}

type AnyEffectDefinition = EffectDefinition<EffectElements, ParameterSchema>;

export interface BakeSimulationOptions<Definition = AnyEffectDefinition> {
  readonly compression?: SimulationCacheCompression;
  readonly frameRate?: number;
  readonly frames: number;
  readonly interpolation?: SimulationCacheInterpolation;
  readonly loop?: boolean;
  readonly loopTolerance?: number;
  readonly sampleStartFrame?: number;
  readonly spawn?: EffectSpawnOptions<Definition>;
}

export interface SimulationCacheReplayOptions<Definition = AnyEffectDefinition> {
  readonly interpolation?: SimulationCacheInterpolation;
  readonly loop?: boolean;
  readonly spawn?: EffectSpawnOptions<Definition>;
  readonly timeScale?: number;
}

export type SimulationCachePlaybackState = 'complete' | 'paused' | 'playing' | 'released';

export interface SimulationCacheMemoryEstimate {
  readonly binaryBytes: number;
  readonly metadataBytes: number;
  readonly totalBytes: number;
  readonly uploadBytesPerFrame: number;
}

type LogicalArray = Float32Array | Int32Array | Uint32Array;

type RecordedEmitterFrame = {
  readonly aliveIndices: Uint32Array;
  readonly attributes: ReadonlyMap<string, LogicalArray>;
  readonly birthIndices?: Uint32Array;
  readonly nextSpawnOrder?: number;
};

type RecordedEmitter = {
  readonly capacity: number;
  readonly frames: RecordedEmitterFrame[];
  readonly key: string;
  readonly lifecycleWordCount: number;
  readonly schema: ResolvedAttributeSchema;
  readonly selected: readonly ResolvedAttribute[];
};

function runtimeRenderer(system: VFXSystem): VfxRuntimeRenderer {
  const candidate = system.renderer as Partial<VfxRuntimeRenderer>;
  if (!candidate.kernelAdapter || typeof candidate.submitCompute !== 'function') {
    throw new Error('Simulation caching requires a VfxRuntimeRenderer.');
  }
  return candidate as VfxRuntimeRenderer;
}

function cacheDiagnostic(code: string, message: string, path?: string): VfxDiagnosticError {
  return new VfxDiagnosticError([
    {
      code,
      message,
      ...(path === undefined ? {} : { path }),
      phase: 'runtime',
      severity: 'error',
    },
  ]);
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function validateCacheStructure(cache: SimulationCache): void {
  if (
    cache.kind !== 'simulation-cache' ||
    cache.metadata.kind !== 'nachi-simulation-cache-metadata' ||
    cache.metadata.version !== 1
  ) {
    throw cacheDiagnostic('NACHI_SIM_CACHE_VERSION_UNSUPPORTED', 'Unsupported simulation cache.');
  }
  const { frameCount, frameRate } = cache.metadata;
  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0 ||
    !Number.isSafeInteger(cache.metadata.sampleStartFrame) ||
    cache.metadata.sampleStartFrame < 0 ||
    Math.abs(cache.metadata.durationSeconds - (frameCount - 1) / frameRate) > 1e-9 ||
    !['float32', 'quantized-u16'].includes(cache.metadata.compression) ||
    !['nearest', 'linear'].includes(cache.metadata.interpolation) ||
    !['webgl2', 'webgpu'].includes(cache.metadata.sourceBackend) ||
    typeof cache.metadata.loop.aliveIndicesMatch !== 'boolean' ||
    typeof cache.metadata.loop.continuous !== 'boolean' ||
    typeof cache.metadata.loop.enabled !== 'boolean' ||
    typeof cache.metadata.loop.integerAttributesMatch !== 'boolean' ||
    !Number.isFinite(cache.metadata.loop.maximumAttributeError) ||
    cache.metadata.loop.maximumAttributeError < 0 ||
    !Number.isFinite(cache.metadata.loop.tolerance) ||
    cache.metadata.loop.tolerance < 0 ||
    cache.metadata.loop.continuous !==
      (cache.metadata.loop.aliveIndicesMatch &&
        cache.metadata.loop.integerAttributesMatch &&
        cache.metadata.loop.maximumAttributeError <= cache.metadata.loop.tolerance)
  ) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      'Simulation cache frameCount and frameRate must be positive.',
      'metadata',
    );
  }
  const keys = new Set<string>();
  for (const emitter of cache.metadata.emitters) {
    if (keys.has(emitter.key) || !Number.isSafeInteger(emitter.capacity) || emitter.capacity <= 0) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter metadata for ${emitter.key} has a duplicate key or invalid capacity.`,
        `metadata.emitters.${emitter.key}`,
      );
    }
    keys.add(emitter.key);
    if (
      emitter.aliveCounts.length !== frameCount ||
      emitter.aliveCounts.some(
        (count) => !Number.isSafeInteger(count) || count < 0 || count > emitter.capacity,
      ) ||
      emitter.aliveIndicesFrameStrideBytes !== emitter.capacity * 4 ||
      emitter.aliveIndicesOffsetBytes < 0 ||
      emitter.aliveIndicesOffsetBytes + emitter.aliveIndicesFrameStrideBytes * frameCount >
        cache.data.byteLength
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter ${emitter.key} alive-index metadata is outside the binary payload.`,
        `metadata.emitters.${emitter.key}.aliveIndicesOffsetBytes`,
      );
    }
    const hasBirthOrder = emitter.birthIndicesOffsetBytes !== undefined;
    if (
      hasBirthOrder !== (emitter.birthIndicesFrameStrideBytes !== undefined) ||
      hasBirthOrder !== (emitter.nextSpawnOrders !== undefined) ||
      (hasBirthOrder &&
        (emitter.birthIndicesFrameStrideBytes !== emitter.capacity * 4 ||
          emitter.nextSpawnOrders!.length !== frameCount ||
          emitter.nextSpawnOrders!.some(
            (value) => !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff,
          ) ||
          emitter.birthIndicesOffsetBytes! < 0 ||
          emitter.birthIndicesOffsetBytes! + emitter.birthIndicesFrameStrideBytes! * frameCount >
            cache.data.byteLength))
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter ${emitter.key} birth-order metadata is invalid.`,
        `metadata.emitters.${emitter.key}.birthIndicesOffsetBytes`,
      );
    }
    const attributeNames = new Set<string>();
    for (const attribute of emitter.attributes) {
      const validEncoding = ['float32', 'int32', 'quantized-u16', 'uint32'].includes(
        attribute.encoding,
      );
      const bytesPerComponent = attribute.encoding === 'quantized-u16' ? 2 : 4;
      const expectedStride = emitter.capacity * attribute.components * bytesPerComponent;
      if (
        attributeNames.has(attribute.name) ||
        !validEncoding ||
        !Number.isSafeInteger(attribute.components) ||
        attribute.components <= 0 ||
        attribute.frameStrideBytes !== expectedStride ||
        attribute.offsetBytes < 0 ||
        attribute.offsetBytes + attribute.frameStrideBytes * frameCount > cache.data.byteLength
      ) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_METADATA_INVALID',
          `Emitter ${emitter.key} attribute ${attribute.name} has an invalid binary layout.`,
          `metadata.emitters.${emitter.key}.attributes.${attribute.name}`,
        );
      }
      attributeNames.add(attribute.name);
      if (
        attribute.encoding === 'quantized-u16' &&
        (attribute.quantization?.minimum.length !== attribute.components ||
          attribute.quantization.maximum.length !== attribute.components ||
          attribute.quantization.minimum.some((value) => !Number.isFinite(value)) ||
          attribute.quantization.maximum.some((value) => !Number.isFinite(value)))
      ) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_METADATA_INVALID',
          `Emitter ${emitter.key} attribute ${attribute.name} has invalid quantization bounds.`,
          `metadata.emitters.${emitter.key}.attributes.${attribute.name}.quantization`,
        );
      }
    }
  }
}

function renderAttributeNames(view: VfxEmitterRuntimeView): readonly string[] {
  const names = new Set<string>();
  const renderModules = Array.isArray(view.definition.render)
    ? view.definition.render
    : [view.definition.render];
  for (const module of renderModules) {
    for (const path of module.access?.reads ?? []) {
      if (path.startsWith('Particles.')) names.add(path.slice('Particles.'.length));
    }
  }
  for (const draw of view.program.draws) {
    for (const name of draw.vertex.attributes) names.add(name);
  }
  return [...names].sort();
}

function selectedAttributes(view: VfxEmitterRuntimeView): readonly ResolvedAttribute[] {
  return renderAttributeNames(view).map((name) => {
    const attribute = view.program.attributeSchema.byName[name];
    if (!attribute) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_RENDER_ATTRIBUTE_MISSING',
        `Render attribute Particles.${name} is absent from the compiled emitter schema.`,
        `elements.${name}.render`,
      );
    }
    if (attribute.transient) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_TRANSIENT_RENDER_ATTRIBUTE',
        `Transient attribute Particles.${name} is required by the replay render path and cannot be cached.`,
        `attributes.${name}.transient`,
      );
    }
    return attribute;
  });
}

function paddedComponent(attribute: ResolvedAttribute, component: number): number {
  return attribute.logicalType === 'mat3'
    ? Math.floor(component / 3) * 4 + (component % 3)
    : component;
}

function physicalComponentIndex(
  attribute: ResolvedAttribute,
  storage: ResolvedAttributeStorage,
  particle: number,
  component: number,
): number {
  if (storage.packed) {
    return packedComponentIndex(
      particle,
      resolvePackedAttributeAddress(attribute, storage),
      component,
    );
  }
  return (
    particle * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] +
    paddedComponent(attribute, component)
  );
}

function typedPhysicalArray(storage: ResolvedAttributeStorage, buffer: ArrayBuffer): LogicalArray {
  if (storage.componentType === 'uint') return new Uint32Array(buffer);
  if (storage.componentType === 'int') return new Int32Array(buffer);
  return new Float32Array(buffer);
}

function logicalArray(attribute: ResolvedAttribute, length: number): LogicalArray {
  if (attribute.logicalType === 'bool' || attribute.logicalType === 'u32') {
    return new Uint32Array(length);
  }
  if (attribute.logicalType === 'i32') return new Int32Array(length);
  return new Float32Array(length);
}

function extractLogicalAttribute(
  attribute: ResolvedAttribute,
  schema: ResolvedAttributeSchema,
  physical: LogicalArray,
): LogicalArray {
  const storage = schema.storageArrays[attribute.physical.bufferIndex];
  if (!storage) throw new Error(`Physical storage for Particles.${attribute.name} is missing.`);
  const output = logicalArray(attribute, schema.capacity * attribute.components);
  for (let particle = 0; particle < schema.capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      output[particle * attribute.components + component] =
        physical[physicalComponentIndex(attribute, storage, particle, component)] ?? 0;
    }
  }
  return output;
}

async function recordEmitterFrame(
  renderer: VfxRuntimeRenderer,
  view: VfxEmitterRuntimeView,
  selected: readonly ResolvedAttribute[],
): Promise<RecordedEmitterFrame> {
  if (!renderer.readStorage) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_READBACK_UNAVAILABLE',
      'The renderer does not expose GPU storage readback required for simulation baking.',
    );
  }
  const schema = view.program.attributeSchema;
  const storageIndexes = [...new Set(selected.map(({ physical }) => physical.bufferIndex))];
  const [lifecycleBuffer, ...storageBuffers] = await Promise.all([
    renderer.readStorage(view.kernels.aliveCount),
    ...storageIndexes.map((index) => {
      const storage = schema.storageArrays[index];
      if (!storage) throw new Error(`Compiled storage ${index} is missing.`);
      const node = view.kernels.storages[storage.name];
      if (!node) throw new Error(`Materialized storage ${storage.name} is missing.`);
      return renderer.readStorage!(node);
    }),
  ]);
  const lifecycle = new Uint32Array(lifecycleBuffer);
  const aliveCount = lifecycle[view.kernels.counterOffsets.aliveCount] ?? 0;
  const aliveIndices = new Uint32Array(schema.capacity);
  for (let index = 0; index < Math.min(aliveCount, schema.capacity); index += 1) {
    aliveIndices[index] = lifecycle[view.kernels.aliveIndicesOffset + index] ?? 0;
  }
  const hasBirthOrder = schema.byName.spawnOrder !== undefined;
  const physicalByIndex = new Map<number, LogicalArray>();
  for (const [bufferIndex, buffer] of storageIndexes.map(
    (storageIndex, index) => [storageIndex, storageBuffers[index]!] as const,
  )) {
    physicalByIndex.set(
      bufferIndex,
      typedPhysicalArray(schema.storageArrays[bufferIndex]!, buffer),
    );
  }
  return {
    aliveIndices: aliveIndices.subarray(0, Math.min(aliveCount, schema.capacity)).slice(),
    attributes: new Map(
      selected.map((attribute) => {
        const physical = physicalByIndex.get(attribute.physical.bufferIndex);
        if (!physical) throw new Error(`Readback for Particles.${attribute.name} is missing.`);
        return [attribute.name, extractLogicalAttribute(attribute, schema, physical)] as const;
      }),
    ),
    ...(hasBirthOrder
      ? {
          birthIndices: lifecycle
            .subarray(
              view.kernels.birthIndicesOffset,
              view.kernels.birthIndicesOffset + schema.capacity,
            )
            .slice(),
          nextSpawnOrder: lifecycle[view.kernels.nextSpawnOrderOffset] ?? 0,
        }
      : {}),
  };
}

function maximumLoopError(recorded: readonly RecordedEmitter[]): {
  readonly continuousIntegers: boolean;
  readonly maximum: number;
  readonly sameAlive: boolean;
} {
  let maximum = 0;
  let continuousIntegers = true;
  let sameAlive = true;
  for (const emitter of recorded) {
    const first = emitter.frames[0]!;
    const last = emitter.frames.at(-1)!;
    if (
      first.aliveIndices.length !== last.aliveIndices.length ||
      first.aliveIndices.some((value, index) => value !== last.aliveIndices[index])
    ) {
      sameAlive = false;
    }
    const aliveParticles = first.aliveIndices;
    for (const attribute of emitter.selected) {
      const left = first.attributes.get(attribute.name)!;
      const right = last.attributes.get(attribute.name)!;
      for (const particle of aliveParticles) {
        for (let component = 0; component < attribute.components; component += 1) {
          const index = particle * attribute.components + component;
          if (left instanceof Float32Array) {
            maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!));
          } else if (left[index] !== right[index]) {
            continuousIntegers = false;
          }
        }
      }
    }
  }
  return { continuousIntegers, maximum, sameAlive };
}

function attributeEncoding(
  attribute: ResolvedAttribute,
  compression: SimulationCacheCompression,
): CacheAttributeEncoding {
  if (attribute.logicalType === 'bool' || attribute.logicalType === 'u32') return 'uint32';
  if (attribute.logicalType === 'i32') return 'int32';
  return compression === 'quantized-u16' ? 'quantized-u16' : 'float32';
}

function quantizationRange(
  emitter: RecordedEmitter,
  attribute: ResolvedAttribute,
): { readonly maximum: number[]; readonly minimum: number[] } {
  const minimum = Array.from({ length: attribute.components }, () => Number.POSITIVE_INFINITY);
  const maximum = Array.from({ length: attribute.components }, () => Number.NEGATIVE_INFINITY);
  for (const frame of emitter.frames) {
    const values = frame.attributes.get(attribute.name)!;
    for (const particle of frame.aliveIndices) {
      for (let component = 0; component < attribute.components; component += 1) {
        const value = values[particle * attribute.components + component]!;
        if (!Number.isFinite(value)) {
          throw cacheDiagnostic(
            'NACHI_SIM_CACHE_QUANTIZATION_NONFINITE',
            `Particles.${attribute.name} contains a non-finite value and cannot use u16 quantization.`,
            `attributes.${attribute.name}`,
          );
        }
        minimum[component] = Math.min(minimum[component]!, value);
        maximum[component] = Math.max(maximum[component]!, value);
      }
    }
  }
  for (let component = 0; component < attribute.components; component += 1) {
    if (minimum[component] === Number.POSITIVE_INFINITY) minimum[component] = 0;
    if (maximum[component] === Number.NEGATIVE_INFINITY) maximum[component] = 0;
  }
  return { maximum, minimum };
}

function buildCache(
  recorded: readonly RecordedEmitter[],
  options: Required<
    Pick<
      BakeSimulationOptions,
      | 'compression'
      | 'frameRate'
      | 'frames'
      | 'interpolation'
      | 'loop'
      | 'loopTolerance'
      | 'sampleStartFrame'
    >
  > & { readonly sourceBackend: 'webgl2' | 'webgpu' },
): SimulationCache {
  let offset = 0;
  let uploadBytesPerFrame = 0;
  const emitters: SimulationCacheEmitterMetadata[] = [];
  for (const emitter of recorded) {
    offset = align(offset, 4);
    const aliveIndicesOffsetBytes = offset;
    const aliveIndicesFrameStrideBytes = emitter.capacity * Uint32Array.BYTES_PER_ELEMENT;
    offset += aliveIndicesFrameStrideBytes * options.frames;
    const hasBirthOrder = emitter.schema.byName.spawnOrder !== undefined;
    let birthIndicesOffsetBytes: number | undefined;
    let birthIndicesFrameStrideBytes: number | undefined;
    if (hasBirthOrder) {
      offset = align(offset, 4);
      birthIndicesOffsetBytes = offset;
      birthIndicesFrameStrideBytes = emitter.capacity * 4;
      offset += birthIndicesFrameStrideBytes * options.frames;
    }
    const attributes: SimulationCacheAttributeMetadata[] = [];
    for (const attribute of emitter.selected) {
      const encoding = attributeEncoding(attribute, options.compression);
      const bytesPerComponent = encoding === 'quantized-u16' ? 2 : 4;
      const frameStrideBytes = emitter.capacity * attribute.components * bytesPerComponent;
      offset = align(offset, bytesPerComponent);
      const offsetBytes = offset;
      offset += frameStrideBytes * options.frames;
      attributes.push({
        components: attribute.components,
        encoding,
        frameStrideBytes,
        logicalType: attribute.logicalType,
        name: attribute.name,
        offsetBytes,
        ...(encoding === 'quantized-u16'
          ? { quantization: quantizationRange(emitter, attribute) }
          : {}),
      });
    }
    emitters.push({
      aliveCounts: emitter.frames.map(({ aliveIndices }) => aliveIndices.length),
      aliveIndicesFrameStrideBytes,
      aliveIndicesOffsetBytes,
      attributes,
      ...(birthIndicesOffsetBytes === undefined
        ? {}
        : {
            birthIndicesFrameStrideBytes: birthIndicesFrameStrideBytes!,
            birthIndicesOffsetBytes,
            nextSpawnOrders: emitter.frames.map(({ nextSpawnOrder }) => nextSpawnOrder ?? 0),
          }),
      capacity: emitter.capacity,
      key: emitter.key,
    });
    const selectedStorageIndexes = new Set(
      emitter.selected.map(({ physical }) => physical.bufferIndex),
    );
    uploadBytesPerFrame +=
      [...selectedStorageIndexes].reduce((total, storageIndex) => {
        const storage = emitter.schema.storageArrays[storageIndex]!;
        return total + storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] * 4;
      }, 0) +
      emitter.lifecycleWordCount * 4 +
      4;
  }
  const data = new ArrayBuffer(align(offset, 4));
  for (const [emitterIndex, emitter] of recorded.entries()) {
    const metadata = emitters[emitterIndex]!;
    for (const [frameIndex, frame] of emitter.frames.entries()) {
      new Uint32Array(
        data,
        metadata.aliveIndicesOffsetBytes + frameIndex * metadata.aliveIndicesFrameStrideBytes,
        metadata.capacity,
      ).set(frame.aliveIndices);
      if (
        metadata.birthIndicesOffsetBytes !== undefined &&
        metadata.birthIndicesFrameStrideBytes !== undefined
      ) {
        new Uint32Array(
          data,
          metadata.birthIndicesOffsetBytes + frameIndex * metadata.birthIndicesFrameStrideBytes,
          metadata.capacity,
        ).set(frame.birthIndices!);
      }
      for (const attribute of metadata.attributes) {
        const source = frame.attributes.get(attribute.name)!;
        const frameOffset = attribute.offsetBytes + frameIndex * attribute.frameStrideBytes;
        if (attribute.encoding === 'quantized-u16') {
          const target = new Uint16Array(data, frameOffset, source.length);
          const range = attribute.quantization!;
          for (let index = 0; index < source.length; index += 1) {
            const component = index % attribute.components;
            const minimum = range.minimum[component]!;
            const extent = range.maximum[component]! - minimum;
            target[index] =
              extent === 0
                ? 0
                : Math.round(Math.min(1, Math.max(0, (source[index]! - minimum) / extent)) * 65535);
          }
        } else if (attribute.encoding === 'uint32') {
          new Uint32Array(data, frameOffset, source.length).set(source);
        } else if (attribute.encoding === 'int32') {
          new Int32Array(data, frameOffset, source.length).set(source);
        } else {
          new Float32Array(data, frameOffset, source.length).set(source);
        }
      }
    }
  }
  const loopError = maximumLoopError(recorded);
  const continuous =
    loopError.sameAlive &&
    loopError.continuousIntegers &&
    loopError.maximum <= options.loopTolerance;
  if (options.loop && !continuous) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_LOOP_DISCONTINUITY',
      `Loop endpoints differ (max float error ${loopError.maximum}, tolerance ${options.loopTolerance}, alive match ${loopError.sameAlive}, integer match ${loopError.continuousIntegers}).`,
      'options.loop',
    );
  }
  return {
    data,
    kind: 'simulation-cache',
    metadata: {
      compression: options.compression,
      durationSeconds: (options.frames - 1) / options.frameRate,
      emitters,
      frameCount: options.frames,
      frameRate: options.frameRate,
      interpolation: options.interpolation,
      kind: 'nachi-simulation-cache-metadata',
      loop: {
        aliveIndicesMatch: loopError.sameAlive,
        continuous,
        enabled: options.loop,
        integerAttributesMatch: loopError.continuousIntegers,
        maximumAttributeError: loopError.maximum,
        tolerance: options.loopTolerance,
      },
      sampleStartFrame: options.sampleStartFrame,
      sourceBackend: options.sourceBackend,
      uploadBytesPerFrame,
      version: 1,
    },
  };
}

/**
 * Advances the supplied system while recording constant-rate snapshots. Use a dedicated VFXSystem
 * for baking so unrelated instances and the caller's live system clock are not advanced. Systems
 * configured with fixedTimeStep are rejected because their accumulator can split or skip cache
 * frame deltas.
 */
export async function bakeSimulation<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(
  system: VFXSystem,
  definition: EffectDefinition<Elements, Parameters>,
  options: BakeSimulationOptions<EffectDefinition<Elements, Parameters>>,
): Promise<SimulationCache> {
  requirePositiveSafeInteger(options.frames, 'frames');
  if (
    options.compression !== undefined &&
    !['float32', 'quantized-u16'].includes(options.compression)
  ) {
    throw new RangeError('compression must be "float32" or "quantized-u16".');
  }
  if (
    options.interpolation !== undefined &&
    !['nearest', 'linear'].includes(options.interpolation)
  ) {
    throw new RangeError('interpolation must be "nearest" or "linear".');
  }
  const frameRate = options.frameRate ?? 60;
  requirePositiveFinite(frameRate, 'frameRate');
  const sampleStartFrame = options.sampleStartFrame ?? 0;
  if (!Number.isSafeInteger(sampleStartFrame) || sampleStartFrame < 0) {
    throw new RangeError('sampleStartFrame must be a non-negative safe integer.');
  }
  const loopTolerance = options.loopTolerance ?? 1e-6;
  if (!Number.isFinite(loopTolerance) || loopTolerance < 0) {
    throw new RangeError('loopTolerance must be finite and non-negative.');
  }
  if (system.usesFixedTimeStep) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_FIXED_TIMESTEP_UNSUPPORTED',
      'Simulation baking requires a variable-step VFXSystem because bakeSimulation supplies its own exact 1 / frameRate steps. Use a dedicated system without fixedTimeStep.',
      'system.fixedTimeStep',
    );
  }
  const renderer = runtimeRenderer(system);
  const instance = system.spawn(definition, options.spawn);
  if (instance.state === 'error') {
    const diagnostics = instance.diagnostics;
    instance.release();
    throw new VfxDiagnosticError(diagnostics);
  }
  const entries = Object.entries(definition.elements).filter(
    (entry) => entry[1].kind === 'emitter',
  );
  let recorded: RecordedEmitter[] = [];
  try {
    recorded = entries.map(([key]) => {
      const view = instance.getEmitter(key);
      if (!view) throw new Error(`Runtime emitter ${key} is missing during simulation bake.`);
      return {
        capacity: view.program.attributeSchema.capacity,
        frames: [],
        key,
        lifecycleWordCount: view.program.meta.lifecycleStorage.buffers.state.wordCount,
        schema: view.program.attributeSchema,
        selected: selectedAttributes(view),
      };
    });
    await system.update(0);
    const step = 1 / frameRate;
    for (let frame = 0; frame < sampleStartFrame; frame += 1) await system.update(step);
    for (let frame = 0; frame < options.frames; frame += 1) {
      if (frame > 0) await system.update(step);
      await Promise.all(
        recorded.map(async (emitter) => {
          const view = instance.getEmitter(emitter.key);
          if (!view) throw new Error(`Runtime emitter ${emitter.key} disappeared during bake.`);
          emitter.frames.push(await recordEmitterFrame(renderer, view, emitter.selected));
        }),
      );
    }
  } finally {
    instance.release();
  }
  return buildCache(recorded, {
    compression: options.compression ?? 'float32',
    frameRate,
    frames: options.frames,
    interpolation: options.interpolation ?? 'nearest',
    loop: options.loop ?? false,
    loopTolerance,
    sampleStartFrame,
    sourceBackend: renderer.kernelAdapter.capabilities.backend,
  });
}

function decodeAttributeFrame(
  cache: SimulationCache,
  metadata: SimulationCacheAttributeMetadata,
  frame: number,
  capacity: number,
): LogicalArray {
  const length = capacity * metadata.components;
  const offset = metadata.offsetBytes + frame * metadata.frameStrideBytes;
  if (metadata.encoding === 'uint32') return new Uint32Array(cache.data, offset, length).slice();
  if (metadata.encoding === 'int32') return new Int32Array(cache.data, offset, length).slice();
  if (metadata.encoding === 'float32') {
    return new Float32Array(cache.data, offset, length).slice();
  }
  const encoded = new Uint16Array(cache.data, offset, length);
  const output = new Float32Array(length);
  const range = metadata.quantization!;
  for (let index = 0; index < length; index += 1) {
    const component = index % metadata.components;
    const minimum = range.minimum[component]!;
    output[index] = minimum + (encoded[index]! / 65535) * (range.maximum[component]! - minimum);
  }
  return output;
}

function aliveFrame(
  cache: SimulationCache,
  emitter: SimulationCacheEmitterMetadata,
  frame: number,
): Uint32Array {
  return new Uint32Array(
    cache.data,
    emitter.aliveIndicesOffsetBytes + frame * emitter.aliveIndicesFrameStrideBytes,
    emitter.aliveCounts[frame] ?? 0,
  ).slice();
}

function interpolateAttribute(
  left: LogicalArray,
  right: LogicalArray,
  alpha: number,
  leftAlive: ReadonlySet<number>,
  rightAlive: ReadonlySet<number>,
  nearestIsRight: boolean,
  components: number,
): LogicalArray {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || alpha === 0) {
    return (nearestIsRight ? right : left).slice() as LogicalArray;
  }
  const output = (nearestIsRight ? right : left).slice();
  for (const particle of leftAlive) {
    if (!rightAlive.has(particle)) continue;
    for (let component = 0; component < components; component += 1) {
      const index = particle * components + component;
      output[index] = left[index]! + (right[index]! - left[index]!) * alpha;
    }
  }
  return output;
}

function validateReplayEmitter(
  view: VfxEmitterRuntimeView,
  cacheEmitter: SimulationCacheEmitterMetadata,
): void {
  const schema = view.program.attributeSchema;
  if (schema.capacity !== cacheEmitter.capacity) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
      `Emitter ${cacheEmitter.key} capacity is ${schema.capacity}; cache requires ${cacheEmitter.capacity}.`,
      `metadata.emitters.${cacheEmitter.key}.capacity`,
    );
  }
  const requiredNames = selectedAttributes(view)
    .map(({ name }) => name)
    .sort();
  const cachedNames = cacheEmitter.attributes.map(({ name }) => name).sort();
  if (
    requiredNames.length !== cachedNames.length ||
    requiredNames.some((name, index) => name !== cachedNames[index])
  ) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
      `Emitter ${cacheEmitter.key} render reads [${requiredNames.join(', ')}]; cache contains [${cachedNames.join(', ')}].`,
      `metadata.emitters.${cacheEmitter.key}.attributes`,
    );
  }
  for (const cached of cacheEmitter.attributes) {
    const current = schema.byName[cached.name];
    if (
      !current ||
      current.logicalType !== cached.logicalType ||
      current.components !== cached.components ||
      current.transient
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
        `Emitter ${cacheEmitter.key} attribute ${cached.name} does not match the cache schema.`,
        `metadata.emitters.${cacheEmitter.key}.attributes.${cached.name}`,
      );
    }
  }
  const currentHasBirthOrder = schema.byName.spawnOrder !== undefined;
  const cacheHasBirthOrder = cacheEmitter.birthIndicesOffsetBytes !== undefined;
  if (currentHasBirthOrder !== cacheHasBirthOrder) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
      `Emitter ${cacheEmitter.key} birth-order lifecycle requirement is ${currentHasBirthOrder ? 'present' : 'absent'}; cache birth-order data is ${cacheHasBirthOrder ? 'present' : 'absent'}.`,
      `metadata.emitters.${cacheEmitter.key}.birthIndicesOffsetBytes`,
    );
  }
}

function storageArray(storage: ResolvedAttributeStorage): LogicalArray {
  const length = storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type];
  if (storage.componentType === 'uint') return new Uint32Array(length);
  if (storage.componentType === 'int') return new Int32Array(length);
  return new Float32Array(length);
}

function writeLogicalAttribute(
  target: LogicalArray,
  source: LogicalArray,
  attribute: ResolvedAttribute,
  storage: ResolvedAttributeStorage,
  capacity: number,
): void {
  for (let particle = 0; particle < capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      target[physicalComponentIndex(attribute, storage, particle, component)] =
        source[particle * attribute.components + component] ?? 0;
    }
  }
}

export class SimulationCachePlayer<Definition = AnyEffectDefinition> {
  readonly instance: EffectInstance<Definition> & {
    getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  };
  readonly #cache: SimulationCache;
  readonly #renderer: VfxRuntimeRenderer;
  readonly #views = new Map<string, VfxEmitterRuntimeView>();
  #interpolation: SimulationCacheInterpolation;
  #loop: boolean;
  #state: SimulationCachePlaybackState = 'paused';
  #time = 0;
  #timeScale: number;

  constructor(
    system: VFXSystem,
    definition: Definition,
    cache: SimulationCache,
    options: SimulationCacheReplayOptions<Definition> = {},
  ) {
    this.#renderer = runtimeRenderer(system);
    validateCacheStructure(cache);
    const replayBackend = this.#renderer.kernelAdapter.capabilities.backend;
    if (cache.metadata.sourceBackend !== replayBackend) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_BACKEND_MISMATCH',
        `Simulation cache was baked on ${cache.metadata.sourceBackend}; replay backend is ${replayBackend}. Cross-backend alive and physical-slot semantics are not guaranteed.`,
        'metadata.sourceBackend',
      );
    }
    if (replayBackend !== 'webgpu') {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_REPLAY_WEBGL2_UNSUPPORTED',
        'Simulation-cache replay requires the WebGPU indirect-draw upload path; WebGL2 baking remains available for compatible burst emitters.',
      );
    }
    if (!this.#renderer.writeStorage) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_UPLOAD_UNAVAILABLE',
        'The renderer does not expose storage uploads required for simulation-cache replay.',
      );
    }
    if (
      options.interpolation !== undefined &&
      !['nearest', 'linear'].includes(options.interpolation)
    ) {
      throw new RangeError('interpolation must be "nearest" or "linear".');
    }
    this.#cache = cache;
    this.#interpolation = options.interpolation ?? cache.metadata.interpolation;
    this.#loop = options.loop ?? cache.metadata.loop.enabled;
    if (this.#loop && !cache.metadata.loop.continuous) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_LOOP_DISCONTINUITY',
        'This cache was not baked with continuous loop endpoints.',
      );
    }
    this.#timeScale = options.timeScale ?? 1;
    requirePositiveFinite(this.#timeScale, 'timeScale');
    const effectEmitterKeys = Object.entries((definition as AnyEffectDefinition).elements)
      .filter(([, element]) => element.kind === 'emitter')
      .map(([key]) => key)
      .sort();
    const cacheEmitterKeys = cache.metadata.emitters.map(({ key }) => key).sort();
    if (
      effectEmitterKeys.length !== cacheEmitterKeys.length ||
      effectEmitterKeys.some((key, index) => key !== cacheEmitterKeys[index])
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
        `Replay effect emitters [${effectEmitterKeys.join(', ')}]; cache contains [${cacheEmitterKeys.join(', ')}].`,
        'metadata.emitters',
      );
    }
    this.instance = system.spawn(
      definition as AnyEffectDefinition,
      options.spawn as EffectSpawnOptions<AnyEffectDefinition>,
    ) as unknown as EffectInstance<Definition> & {
      getEmitter(key: string): VfxEmitterRuntimeView | undefined;
    };
    if (this.instance.state === 'error') {
      const diagnostics = this.instance.diagnostics;
      this.instance.release();
      throw new VfxDiagnosticError(diagnostics);
    }
    try {
      for (const emitter of cache.metadata.emitters) {
        const view = this.instance.getEmitter(emitter.key);
        if (!view) {
          throw cacheDiagnostic(
            'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
            `Emitter ${emitter.key} is missing from the replay effect.`,
          );
        }
        validateReplayEmitter(view, emitter);
        this.#views.set(emitter.key, view);
      }
    } catch (error) {
      this.instance.release();
      throw error;
    }
    this.instance.stop();
  }

  get duration(): number {
    return this.#cache.metadata.durationSeconds;
  }

  get localTime(): number {
    return this.#time;
  }

  get loop(): boolean {
    return this.#loop;
  }

  get state(): SimulationCachePlaybackState {
    return this.#state;
  }

  get timeScale(): number {
    return this.#timeScale;
  }

  play(): void {
    this.#assertNotReleased();
    if (this.#state === 'complete') this.#time = 0;
    this.#state = 'playing';
  }

  stop(): void {
    this.#assertNotReleased();
    this.#state = 'paused';
  }

  setLoop(loop: boolean): void {
    this.#assertNotReleased();
    if (loop && !this.#cache.metadata.loop.continuous) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_LOOP_DISCONTINUITY',
        'This cache was not baked with continuous loop endpoints.',
      );
    }
    this.#loop = loop;
  }

  setTimeScale(timeScale: number): void {
    this.#assertNotReleased();
    requirePositiveFinite(timeScale, 'timeScale');
    this.#timeScale = timeScale;
  }

  async seek(timeSeconds: number): Promise<void> {
    this.#assertNotReleased();
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new RangeError('timeSeconds must be finite and non-negative.');
    }
    this.#time = this.#normalizeTime(timeSeconds);
    await this.#applyCurrentFrame();
  }

  async update(deltaSeconds: number): Promise<void> {
    this.#assertNotReleased();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('deltaSeconds must be finite and non-negative.');
    }
    if (this.#state !== 'playing') return;
    const next = this.#time + deltaSeconds * this.#timeScale;
    if (!this.#loop && next >= this.duration) {
      this.#time = this.duration;
      this.#state = 'complete';
    } else {
      this.#time = this.#normalizeTime(next);
    }
    await this.#applyCurrentFrame();
  }

  release(): void {
    if (this.#state === 'released') return;
    this.instance.release();
    this.#state = 'released';
  }

  async initialize(): Promise<void> {
    this.#assertNotReleased();
    await this.#applyCurrentFrame();
  }

  #normalizeTime(value: number): number {
    if (!this.#loop || this.duration === 0) return Math.min(value, this.duration);
    return ((value % this.duration) + this.duration) % this.duration;
  }

  async #applyCurrentFrame(): Promise<void> {
    const framePosition = this.#time * this.#cache.metadata.frameRate;
    const leftFrame = Math.min(this.#cache.metadata.frameCount - 1, Math.floor(framePosition));
    const rightFrame = Math.min(this.#cache.metadata.frameCount - 1, leftFrame + 1);
    const fraction = rightFrame === leftFrame ? 0 : framePosition - leftFrame;
    const alpha = this.#interpolation === 'linear' ? fraction : 0;
    const nearestIsRight = fraction >= 0.5;
    for (const emitterMetadata of this.#cache.metadata.emitters) {
      const view = this.#views.get(emitterMetadata.key)!;
      const schema = view.program.attributeSchema;
      const leftAliveValues = aliveFrame(this.#cache, emitterMetadata, leftFrame);
      const rightAliveValues = aliveFrame(this.#cache, emitterMetadata, rightFrame);
      const aliveValues = nearestIsRight ? rightAliveValues : leftAliveValues;
      const leftAlive = new Set(leftAliveValues);
      const rightAlive = new Set(rightAliveValues);
      const physical = new Map<number, LogicalArray>();
      for (const cachedAttribute of emitterMetadata.attributes) {
        const attribute = schema.byName[cachedAttribute.name]!;
        const storage = schema.storageArrays[attribute.physical.bufferIndex]!;
        let target = physical.get(storage.index);
        if (!target) {
          target = storageArray(storage);
          physical.set(storage.index, target);
        }
        const left = decodeAttributeFrame(this.#cache, cachedAttribute, leftFrame, schema.capacity);
        const right =
          rightFrame === leftFrame
            ? left
            : decodeAttributeFrame(this.#cache, cachedAttribute, rightFrame, schema.capacity);
        writeLogicalAttribute(
          target,
          interpolateAttribute(
            left,
            right,
            alpha,
            leftAlive,
            rightAlive,
            nearestIsRight,
            cachedAttribute.components,
          ),
          attribute,
          storage,
          schema.capacity,
        );
      }
      for (const [storageIndex, values] of physical) {
        const storage = schema.storageArrays[storageIndex]!;
        this.#renderer.writeStorage!(view.kernels.storages[storage.name]!, values);
      }
      const lifecycle = new Uint32Array(view.program.meta.lifecycleStorage.buffers.state.wordCount);
      lifecycle[view.kernels.counterOffsets.aliveCount] = aliveValues.length;
      lifecycle[view.kernels.counterOffsets.freeCount] = schema.capacity - aliveValues.length;
      lifecycle.set(aliveValues, view.kernels.aliveIndicesOffset);
      if (
        emitterMetadata.birthIndicesOffsetBytes !== undefined &&
        emitterMetadata.birthIndicesFrameStrideBytes !== undefined
      ) {
        lifecycle[view.kernels.nextSpawnOrderOffset] =
          emitterMetadata.nextSpawnOrders?.[nearestIsRight ? rightFrame : leftFrame] ?? 0;
        lifecycle.set(
          new Uint32Array(
            this.#cache.data,
            emitterMetadata.birthIndicesOffsetBytes +
              (nearestIsRight ? rightFrame : leftFrame) *
                emitterMetadata.birthIndicesFrameStrideBytes,
            schema.capacity,
          ),
          view.kernels.birthIndicesOffset,
        );
      }
      this.#renderer.writeStorage!(view.kernels.aliveCount, lifecycle);
      this.#renderer.setInstanceCount?.(view.kernels, aliveValues.length);
      if (view.kernels.drawIndirect && view.kernels.drawIndirectOffsetBytes !== undefined) {
        this.#renderer.writeStorage!(
          view.kernels.drawIndirect,
          new Uint32Array([aliveValues.length]),
          view.kernels.drawIndirectOffsetBytes + Uint32Array.BYTES_PER_ELEMENT,
        );
      }
      if (view.kernels.prepareSort && view.kernels.sortPasses) {
        await this.#renderer.submitCompute(view.kernels.prepareSort);
        for (const pass of view.kernels.sortPasses) await this.#renderer.submitCompute(pass);
      }
    }
  }

  #assertNotReleased(): void {
    if (this.#state === 'released') throw new Error('Simulation cache player has been released.');
  }
}

export async function replaySimulation<
  const Elements extends EffectElements,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(
  system: VFXSystem,
  definition: EffectDefinition<Elements, Parameters>,
  cache: SimulationCache,
  options: SimulationCacheReplayOptions<EffectDefinition<Elements, Parameters>> = {},
): Promise<SimulationCachePlayer<EffectDefinition<Elements, Parameters>>> {
  const player = new SimulationCachePlayer<EffectDefinition<Elements, Parameters>>(
    system,
    definition,
    cache,
    options,
  );
  await player.initialize();
  return player;
}

export function estimateSimulationCacheMemory(
  cache: SimulationCache,
): SimulationCacheMemoryEstimate {
  validateCacheStructure(cache);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(cache.metadata)).byteLength;
  return {
    binaryBytes: cache.data.byteLength,
    metadataBytes,
    totalBytes: cache.data.byteLength + metadataBytes,
    uploadBytesPerFrame: cache.metadata.uploadBytesPerFrame,
  };
}
