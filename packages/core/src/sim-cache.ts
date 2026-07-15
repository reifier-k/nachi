import {
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
  attributeStorageComponentIndex,
  resolveAttributeSchema,
} from './attributes.js';
import { tslModule } from './api.js';
import { VfxDiagnosticError } from './diagnostics.js';
import { applyEmitterQualityTier } from './scalability.js';
import { simulationCacheSpawnOrderRequestTotal } from './internal-sim-cache-lineage.js';
import type { VfxRuntimeRenderer } from './system.js';
import type {
  AttributeType,
  AttributeSchema,
  EffectDefinition,
  EffectElements,
  EffectInstance,
  EffectSpawnOptions,
  EmptyParameterSchema,
  EmitterDefinition,
  ParameterSchema,
  QualityTier,
  ResolvedAttribute,
  ResolvedAttributeSchema,
  ResolvedAttributeStorage,
  VfxDiagnostic,
} from './types.js';
import type { VFXSystem, VfxEmitterRuntimeView } from './system.js';

export type SimulationCacheCompression = 'float32' | 'quantized-u16';
export type SimulationCacheInterpolation = 'linear' | 'nearest';
export const SIMULATION_CACHE_VERSION = 2 as const;

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
  /** Per-physical-slot logical birth identity for every cache frame. */
  readonly lineageFrameStrideBytes: number;
  readonly lineageOffsetBytes: number;
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
    readonly continuous: boolean;
    readonly enabled: boolean;
    readonly integerAttributesMatch: boolean;
    readonly lineageMatch: boolean;
    readonly maximumAttributeError: number;
    readonly tolerance: number;
  };
  readonly qualityTier: QualityTier;
  readonly sampleStartFrame: number;
  readonly sourceBackend: 'webgl2' | 'webgpu';
  readonly uploadBytesPerFrame: number;
  readonly version: 2;
}

export interface SimulationCache {
  readonly data: ArrayBuffer;
  /** Non-fatal limitations observed while baking this cache. */
  readonly diagnostics: readonly VfxDiagnostic[];
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

export type LogicalArray = Float32Array | Int32Array | Uint32Array;

type RecordedEmitterFrame = {
  readonly aliveIndices: Uint32Array;
  readonly attributes: ReadonlyMap<string, LogicalArray>;
  readonly birthIndices?: Uint32Array;
  readonly lineage: Uint32Array;
  readonly nextSpawnOrder?: number;
};

type RecordedEmitter = {
  readonly capacity: number;
  readonly frames: RecordedEmitterFrame[];
  readonly key: string;
  readonly rendererUsesSpawnOrder: boolean;
  readonly selected: readonly ResolvedAttribute[];
  uploadBytesPerFrame: number;
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

export function validateSimulationCachePayloadSize(dataBytes: number): void {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0x7fff_ffff) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_SIZE_LIMIT_EXCEEDED',
      `Simulation-cache payload requires ${dataBytes} bytes, exceeding the supported 2147483647-byte ArrayBuffer limit.`,
      'options.frames',
    );
  }
}

function assertLittleEndian(): void {
  const bytes = new Uint8Array(new Uint16Array([0x0102]).buffer);
  if (bytes[0] !== 0x02) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_ENDIAN_UNSUPPORTED',
      'Simulation-cache binary encoding requires a little-endian host.',
    );
  }
}

type PayloadRegion = { readonly end: number; readonly path: string; readonly start: number };

function payloadRegion(
  regions: PayloadRegion[],
  offset: number,
  stride: number,
  frames: number,
  alignment: number,
  byteLength: number,
  path: string,
): void {
  const size = stride * frames;
  const end = offset + size;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(stride) ||
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(end) ||
    offset < 0 ||
    stride <= 0 ||
    offset % alignment !== 0 ||
    stride % alignment !== 0 ||
    end > byteLength
  ) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      `${path} has an unsafe, unaligned, or out-of-bounds binary region.`,
      path,
    );
  }
  regions.push({ end, path, start: offset });
}

const ATTRIBUTE_COMPONENTS: Readonly<Record<AttributeType, number>> = {
  bool: 1,
  color: 4,
  f32: 1,
  i32: 1,
  mat3: 9,
  mat4: 16,
  quat: 4,
  u32: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

function validateCacheStructureUnchecked(cache: SimulationCache): void {
  const untrusted = cache as unknown as {
    readonly kind?: unknown;
    readonly metadata?: { readonly kind?: unknown; readonly version?: unknown };
  };
  if (untrusted.metadata?.version !== SIMULATION_CACHE_VERSION) {
    const found =
      typeof untrusted.metadata?.version === 'number'
        ? String(untrusted.metadata.version)
        : 'missing';
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_VERSION_UNSUPPORTED',
      `Simulation cache format version ${found} is unsupported; expected ${SIMULATION_CACHE_VERSION}. Re-bake the cache with this runtime.`,
      'metadata.version',
    );
  }
  if (
    untrusted.kind !== 'simulation-cache' ||
    untrusted.metadata.kind !== 'nachi-simulation-cache-metadata'
  ) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      'Simulation cache kind metadata is invalid.',
      'metadata.kind',
    );
  }
  if (!(cache.data instanceof ArrayBuffer)) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      'Simulation cache data must be an ArrayBuffer.',
      'data',
    );
  }
  if (cache.data.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      'Simulation cache payload length must be aligned to four bytes.',
      'data',
    );
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
    !['low', 'medium', 'high', 'epic'].includes(cache.metadata.qualityTier) ||
    !Number.isSafeInteger(cache.metadata.uploadBytesPerFrame) ||
    cache.metadata.uploadBytesPerFrame < 0 ||
    !Array.isArray(cache.metadata.emitters) ||
    typeof cache.metadata.loop.continuous !== 'boolean' ||
    typeof cache.metadata.loop.enabled !== 'boolean' ||
    typeof cache.metadata.loop.integerAttributesMatch !== 'boolean' ||
    typeof cache.metadata.loop.lineageMatch !== 'boolean' ||
    !Number.isFinite(cache.metadata.loop.maximumAttributeError) ||
    cache.metadata.loop.maximumAttributeError < 0 ||
    !Number.isFinite(cache.metadata.loop.tolerance) ||
    cache.metadata.loop.tolerance < 0 ||
    cache.metadata.loop.continuous !==
      (cache.metadata.loop.lineageMatch &&
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
  const regions: PayloadRegion[] = [];
  for (const emitter of cache.metadata.emitters) {
    if (
      typeof emitter.key !== 'string' ||
      emitter.key.length === 0 ||
      keys.has(emitter.key) ||
      !Number.isSafeInteger(emitter.capacity) ||
      emitter.capacity <= 0 ||
      !Array.isArray(emitter.aliveCounts) ||
      !Array.isArray(emitter.attributes)
    ) {
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
        (count: number) => !Number.isSafeInteger(count) || count < 0 || count > emitter.capacity,
      ) ||
      emitter.aliveIndicesFrameStrideBytes !== emitter.capacity * 4
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter ${emitter.key} alive-index metadata is outside the binary payload.`,
        `metadata.emitters.${emitter.key}.aliveIndicesOffsetBytes`,
      );
    }
    payloadRegion(
      regions,
      emitter.aliveIndicesOffsetBytes,
      emitter.aliveIndicesFrameStrideBytes,
      frameCount,
      Uint32Array.BYTES_PER_ELEMENT,
      cache.data.byteLength,
      `metadata.emitters.${emitter.key}.aliveIndicesOffsetBytes`,
    );
    if (emitter.lineageFrameStrideBytes !== emitter.capacity * 4) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter ${emitter.key} lineage metadata is invalid.`,
        `metadata.emitters.${emitter.key}.lineageOffsetBytes`,
      );
    }
    payloadRegion(
      regions,
      emitter.lineageOffsetBytes,
      emitter.lineageFrameStrideBytes,
      frameCount,
      Uint32Array.BYTES_PER_ELEMENT,
      cache.data.byteLength,
      `metadata.emitters.${emitter.key}.lineageOffsetBytes`,
    );
    for (let frame = 0; frame < frameCount; frame += 1) {
      const count = emitter.aliveCounts[frame]!;
      const alive = new Uint32Array(
        cache.data,
        emitter.aliveIndicesOffsetBytes + frame * emitter.aliveIndicesFrameStrideBytes,
        count,
      );
      const lineage = new Uint32Array(
        cache.data,
        emitter.lineageOffsetBytes + frame * emitter.lineageFrameStrideBytes,
        emitter.capacity,
      );
      const seenPhysicalIndices = new Set<number>();
      const seenLineage = new Set<number>();
      for (const physicalIndex of alive) {
        if (physicalIndex >= emitter.capacity || seenPhysicalIndices.has(physicalIndex)) {
          throw cacheDiagnostic(
            'NACHI_SIM_CACHE_METADATA_INVALID',
            `Emitter ${emitter.key} frame ${frame} has an out-of-capacity or duplicate alive index.`,
            `metadata.emitters.${emitter.key}.aliveIndices`,
          );
        }
        seenPhysicalIndices.add(physicalIndex);
        const logicalLineage = lineage[physicalIndex]!;
        if (seenLineage.has(logicalLineage)) {
          throw cacheDiagnostic(
            'NACHI_SIM_CACHE_METADATA_INVALID',
            `Emitter ${emitter.key} frame ${frame} has duplicate alive lineage values.`,
            `metadata.emitters.${emitter.key}.lineageOffsetBytes`,
          );
        }
        seenLineage.add(logicalLineage);
      }
    }
    const hasBirthOrder = emitter.birthIndicesOffsetBytes !== undefined;
    if (
      hasBirthOrder !== (emitter.birthIndicesFrameStrideBytes !== undefined) ||
      hasBirthOrder !== (emitter.nextSpawnOrders !== undefined) ||
      (hasBirthOrder &&
        (emitter.birthIndicesFrameStrideBytes !== emitter.capacity * 4 ||
          emitter.nextSpawnOrders!.length !== frameCount ||
          emitter.nextSpawnOrders!.some(
            (value: number) => !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff,
          ) ||
          !Array.isArray(emitter.nextSpawnOrders)))
    ) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Emitter ${emitter.key} birth-order metadata is invalid.`,
        `metadata.emitters.${emitter.key}.birthIndicesOffsetBytes`,
      );
    }
    if (hasBirthOrder) {
      payloadRegion(
        regions,
        emitter.birthIndicesOffsetBytes!,
        emitter.birthIndicesFrameStrideBytes!,
        frameCount,
        Uint32Array.BYTES_PER_ELEMENT,
        cache.data.byteLength,
        `metadata.emitters.${emitter.key}.birthIndicesOffsetBytes`,
      );
    }
    const attributeNames = new Set<string>();
    for (const attribute of emitter.attributes) {
      const logicalType = attribute.logicalType as AttributeType;
      const validEncoding = ['float32', 'int32', 'quantized-u16', 'uint32'].includes(
        attribute.encoding,
      );
      const bytesPerComponent = attribute.encoding === 'quantized-u16' ? 2 : 4;
      const expectedStride = emitter.capacity * attribute.components * bytesPerComponent;
      const expectedEncoding =
        attribute.logicalType === 'bool' || attribute.logicalType === 'u32'
          ? 'uint32'
          : attribute.logicalType === 'i32'
            ? 'int32'
            : cache.metadata.compression === 'quantized-u16'
              ? 'quantized-u16'
              : 'float32';
      if (
        typeof attribute.name !== 'string' ||
        attribute.name.length === 0 ||
        attributeNames.has(attribute.name) ||
        !validEncoding ||
        !(attribute.logicalType in ATTRIBUTE_COMPONENTS) ||
        !Number.isSafeInteger(attribute.components) ||
        attribute.components !== ATTRIBUTE_COMPONENTS[logicalType] ||
        attribute.encoding !== expectedEncoding ||
        attribute.frameStrideBytes !== expectedStride ||
        (attribute.encoding === 'quantized-u16') !== (attribute.quantization !== undefined)
      ) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_METADATA_INVALID',
          `Emitter ${emitter.key} attribute ${attribute.name} has an invalid binary layout.`,
          `metadata.emitters.${emitter.key}.attributes.${attribute.name}`,
        );
      }
      attributeNames.add(attribute.name);
      payloadRegion(
        regions,
        attribute.offsetBytes,
        attribute.frameStrideBytes,
        frameCount,
        bytesPerComponent,
        cache.data.byteLength,
        `metadata.emitters.${emitter.key}.attributes.${attribute.name}.offsetBytes`,
      );
      if (
        attribute.encoding === 'quantized-u16' &&
        (attribute.quantization?.minimum.length !== attribute.components ||
          attribute.quantization.maximum.length !== attribute.components ||
          attribute.quantization.minimum.some((value: number) => !Number.isFinite(value)) ||
          attribute.quantization.maximum.some((value: number) => !Number.isFinite(value)) ||
          attribute.quantization.minimum.some(
            (value: number, component: number) =>
              value > attribute.quantization!.maximum[component]!,
          ))
      ) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_METADATA_INVALID',
          `Emitter ${emitter.key} attribute ${attribute.name} has invalid quantization bounds.`,
          `metadata.emitters.${emitter.key}.attributes.${attribute.name}.quantization`,
        );
      }
    }
  }
  regions.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < regions.length; index += 1) {
    const previous = regions[index - 1]!;
    const current = regions[index]!;
    if (current.start < previous.end) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_METADATA_INVALID',
        `Simulation cache payload regions overlap: ${previous.path} and ${current.path}.`,
        current.path,
      );
    }
  }
  const encodedEnd = align(regions.at(-1)?.end ?? 0, Uint32Array.BYTES_PER_ELEMENT);
  if (encodedEnd !== cache.data.byteLength) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      'Simulation cache payload length does not match its declared binary regions.',
      'data',
    );
  }
}

function validateCacheStructure(cache: SimulationCache): void {
  assertLittleEndian();
  try {
    validateCacheStructureUnchecked(cache);
  } catch (error) {
    if (error instanceof VfxDiagnosticError) throw error;
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_METADATA_INVALID',
      `Malformed simulation cache metadata: ${error instanceof Error ? error.message : String(error)}.`,
      'metadata',
    );
  }
}

function renderAttributeNames(
  view: VfxEmitterRuntimeView,
  replaySchema: ResolvedAttributeSchema,
): readonly string[] {
  const names = new Set<string>();
  const renderModules = Array.isArray(view.definition.render)
    ? view.definition.render
    : [view.definition.render];
  for (const module of renderModules) {
    for (const path of module.access?.reads ?? []) {
      if (path.startsWith('Particles.')) names.add(path.slice('Particles.'.length));
    }
    for (const path of module.access?.optionalReads ?? []) {
      if (!path.startsWith('Particles.')) continue;
      const name = path.slice('Particles.'.length);
      if (replaySchema.byName[name] !== undefined) names.add(name);
    }
  }
  for (const draw of view.program.draws) {
    for (const name of draw.vertex.attributes) {
      if (replaySchema.byName[name] !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

function selectedAttributes(
  view: VfxEmitterRuntimeView,
  replaySchema = view.program.attributeSchema,
): readonly ResolvedAttribute[] {
  return renderAttributeNames(view, replaySchema).map((name) => {
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

function replayUploadBytesPerFrame(
  schema: ResolvedAttributeSchema,
  selectedNames: ReadonlySet<string>,
): number {
  const selectedStorageIndexes = new Set(
    [...selectedNames].map((name) => {
      const attribute = schema.byName[name];
      if (!attribute) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_SCHEMA_MISMATCH',
          `Replay schema is missing cached render attribute Particles.${name}.`,
          `attributes.${name}`,
        );
      }
      return attribute.physical.bufferIndex;
    }),
  );
  return (
    [...selectedStorageIndexes].reduce((total, storageIndex) => {
      const storage = schema.storageArrays[storageIndex]!;
      return total + storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] * 4;
    }, 0) +
    (4 +
      (schema.byName.spawnOrder === undefined ? 0 : 2) +
      2 * schema.capacity +
      (schema.byName.spawnOrder === undefined ? 0 : schema.capacity)) *
      4 +
    4
  );
}

const CACHE_LINEAGE_INIT_MODULE = tslModule(() => ({}), {
  access: { reads: ['Particles.spawnOrder'], writes: [] },
  stage: 'init',
});

function withSimulationCacheLineage(
  definition: AnyEffectDefinition,
  missingLineage: ReadonlySet<string>,
): AnyEffectDefinition {
  if (missingLineage.size === 0) return definition;
  const elements = Object.fromEntries(
    Object.entries(definition.elements).map(([key, element]) => {
      if (element.kind !== 'emitter' || !missingLineage.has(key)) return [key, element];
      return [key, { ...element, init: [...(element.init ?? []), CACHE_LINEAGE_INIT_MODULE] }];
    }),
  );
  return { ...definition, elements };
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
  backend: 'webgl2' | 'webgpu',
): LogicalArray {
  const storage = schema.storageArrays[attribute.physical.bufferIndex];
  if (!storage) throw new Error(`Physical storage for Particles.${attribute.name} is missing.`);
  const output = logicalArray(attribute, schema.capacity * attribute.components);
  for (let particle = 0; particle < schema.capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      output[particle * attribute.components + component] =
        physical[
          attributeStorageComponentIndex(attribute, storage, backend, particle, component)
        ] ?? 0;
    }
  }
  return output;
}

async function recordEmitterFrame(
  renderer: VfxRuntimeRenderer,
  view: VfxEmitterRuntimeView,
  selected: readonly ResolvedAttribute[],
  rendererUsesSpawnOrder: boolean,
): Promise<RecordedEmitterFrame> {
  if (!view.initialized) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_EMITTER_UNINITIALIZED',
      'Simulation-cache readback requires an initialized emitter.',
    );
  }
  if (!renderer.readStorage) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_READBACK_UNAVAILABLE',
      'The renderer does not expose GPU storage readback required for simulation baking.',
    );
  }
  const schema = view.program.attributeSchema;
  const lineageAttribute = schema.byName.spawnOrder;
  if (!lineageAttribute) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_LINEAGE_UNAVAILABLE',
      'The simulation-cache bake variant did not materialize Particles.spawnOrder lineage.',
      'Particles.spawnOrder',
    );
  }
  const storageIndexes = [
    ...new Set([
      ...selected.map(({ physical }) => physical.bufferIndex),
      lineageAttribute.physical.bufferIndex,
    ]),
  ];
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
  const physicalByIndex = new Map<number, LogicalArray>();
  for (const [bufferIndex, buffer] of storageIndexes.map(
    (storageIndex, index) => [storageIndex, storageBuffers[index]!] as const,
  )) {
    physicalByIndex.set(
      bufferIndex,
      typedPhysicalArray(schema.storageArrays[bufferIndex]!, buffer),
    );
  }
  const lineagePhysical = physicalByIndex.get(lineageAttribute.physical.bufferIndex);
  if (!lineagePhysical) throw new Error('Readback for cache lineage is missing.');
  const lineage = extractLogicalAttribute(
    lineageAttribute,
    schema,
    lineagePhysical,
    renderer.kernelAdapter.capabilities.backend,
  );
  if (!(lineage instanceof Uint32Array)) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_LINEAGE_UNAVAILABLE',
      'Particles.spawnOrder lineage must use lossless u32 storage.',
      'Particles.spawnOrder',
    );
  }
  return {
    aliveIndices: aliveIndices.subarray(0, Math.min(aliveCount, schema.capacity)).slice(),
    attributes: new Map(
      selected.map((attribute) => {
        const physical = physicalByIndex.get(attribute.physical.bufferIndex);
        if (!physical) throw new Error(`Readback for Particles.${attribute.name} is missing.`);
        return [
          attribute.name,
          extractLogicalAttribute(
            attribute,
            schema,
            physical,
            renderer.kernelAdapter.capabilities.backend,
          ),
        ] as const;
      }),
    ),
    ...(rendererUsesSpawnOrder
      ? {
          birthIndices: lifecycle
            .subarray(
              view.kernels.birthIndicesOffset,
              view.kernels.birthIndicesOffset + schema.capacity,
            )
            .slice(),
        }
      : {}),
    lineage,
    nextSpawnOrder: lifecycle[view.kernels.nextSpawnOrderOffset] ?? 0,
  };
}

const CACHE_LINEAGE_SAFETY_LIMIT = 0x8000_0000;

function validateRecordedFrameLineage(
  emitterKey: string,
  frame: RecordedEmitterFrame,
  frameIndex: number,
): Map<number, number> {
  if ((frame.nextSpawnOrder ?? 0) >= CACHE_LINEAGE_SAFETY_LIMIT) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_LINEAGE_WRAP_RISK',
      `Emitter ${emitterKey} reached the spawnOrder half-range safety limit while baking frame ${frameIndex}. Restart and bake a shorter window before u32 lineage can wrap.`,
      `metadata.emitters.${emitterKey}.lineageOffsetBytes`,
    );
  }
  const physicalByLineage = new Map<number, number>();
  for (const physicalIndex of frame.aliveIndices) {
    const lineage = frame.lineage[physicalIndex];
    if (lineage === undefined || physicalByLineage.has(lineage)) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_LINEAGE_DUPLICATE',
        `Emitter ${emitterKey} frame ${frameIndex} contains missing or duplicate alive spawnOrder lineage.`,
        `metadata.emitters.${emitterKey}.lineageOffsetBytes`,
      );
    }
    physicalByLineage.set(lineage, physicalIndex);
  }
  return physicalByLineage;
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
    const firstByLineage = validateRecordedFrameLineage(emitter.key, first, 0);
    const lastFrameIndex = emitter.frames.length - 1;
    const lastByLineage = validateRecordedFrameLineage(emitter.key, last, lastFrameIndex);
    if (
      firstByLineage.size !== lastByLineage.size ||
      [...firstByLineage.keys()].some((lineage) => !lastByLineage.has(lineage))
    ) {
      sameAlive = false;
    }
    for (const attribute of emitter.selected) {
      const left = first.attributes.get(attribute.name)!;
      const right = last.attributes.get(attribute.name)!;
      for (const [lineage, leftParticle] of firstByLineage) {
        const rightParticle = lastByLineage.get(lineage);
        if (rightParticle === undefined) continue;
        for (let component = 0; component < attribute.components; component += 1) {
          const leftIndex = leftParticle * attribute.components + component;
          const rightIndex = rightParticle * attribute.components + component;
          if (left instanceof Float32Array) {
            maximum = Math.max(maximum, Math.abs(left[leftIndex]! - right[rightIndex]!));
          } else if (left[leftIndex] !== right[rightIndex]) {
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
    if (!Number.isFinite(maximum[component]! - minimum[component]!)) {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_QUANTIZATION_EXTENT_INVALID',
        `Particles.${attribute.name} has a non-finite quantization extent.`,
        `attributes.${attribute.name}`,
      );
    }
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
  > & {
    readonly diagnostics: readonly VfxDiagnostic[];
    readonly qualityTier: QualityTier;
    readonly sourceBackend: 'webgl2' | 'webgpu';
  },
): SimulationCache {
  for (const emitter of recorded) {
    for (const [frameIndex, frame] of emitter.frames.entries()) {
      validateRecordedFrameLineage(emitter.key, frame, frameIndex);
    }
  }
  let offset = 0;
  let uploadBytesPerFrame = 0;
  const emitters: SimulationCacheEmitterMetadata[] = [];
  for (const emitter of recorded) {
    offset = align(offset, 4);
    const aliveIndicesOffsetBytes = offset;
    const aliveIndicesFrameStrideBytes = emitter.capacity * Uint32Array.BYTES_PER_ELEMENT;
    offset += aliveIndicesFrameStrideBytes * options.frames;
    offset = align(offset, Uint32Array.BYTES_PER_ELEMENT);
    const lineageOffsetBytes = offset;
    const lineageFrameStrideBytes = emitter.capacity * Uint32Array.BYTES_PER_ELEMENT;
    offset += lineageFrameStrideBytes * options.frames;
    const hasBirthOrder = emitter.rendererUsesSpawnOrder;
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
      lineageFrameStrideBytes,
      lineageOffsetBytes,
    });
    uploadBytesPerFrame += emitter.uploadBytesPerFrame;
  }
  const dataBytes = align(offset, 4);
  validateSimulationCachePayloadSize(dataBytes);
  const data = new ArrayBuffer(dataBytes);
  for (const [emitterIndex, emitter] of recorded.entries()) {
    const metadata = emitters[emitterIndex]!;
    for (const [frameIndex, frame] of emitter.frames.entries()) {
      new Uint32Array(
        data,
        metadata.aliveIndicesOffsetBytes + frameIndex * metadata.aliveIndicesFrameStrideBytes,
        metadata.capacity,
      ).set(frame.aliveIndices);
      new Uint32Array(
        data,
        metadata.lineageOffsetBytes + frameIndex * metadata.lineageFrameStrideBytes,
        metadata.capacity,
      ).set(frame.lineage);
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
    diagnostics: options.diagnostics,
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
        continuous,
        enabled: options.loop,
        integerAttributesMatch: loopError.continuousIntegers,
        lineageMatch: loopError.sameAlive,
        maximumAttributeError: loopError.maximum,
        tolerance: options.loopTolerance,
      },
      qualityTier: options.qualityTier,
      sampleStartFrame: options.sampleStartFrame,
      sourceBackend: options.sourceBackend,
      uploadBytesPerFrame,
      version: SIMULATION_CACHE_VERSION,
    },
  };
}

async function validateSimulationCacheBakeLineageCounters(
  renderer: VfxRuntimeRenderer,
  views: readonly VfxEmitterRuntimeView[],
): Promise<void> {
  const candidates = views.filter(
    (view) => simulationCacheSpawnOrderRequestTotal(view) >= CACHE_LINEAGE_SAFETY_LIMIT,
  );
  if (candidates.length === 0) return;
  if (!renderer.readStorage) {
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_READBACK_UNAVAILABLE',
      'The renderer does not expose GPU storage readback required for simulation baking.',
    );
  }
  await Promise.all(
    candidates.map(async (view) => {
      const lifecycle = new Uint32Array(await renderer.readStorage!(view.kernels.aliveCount));
      if ((lifecycle[view.kernels.nextSpawnOrderOffset] ?? 0) >= CACHE_LINEAGE_SAFETY_LIMIT) {
        throw cacheDiagnostic(
          'NACHI_SIM_CACHE_LINEAGE_WRAP_RISK',
          'Simulation-cache baking crossed the spawnOrder half-range safety limit during warmup. Restart and bake a shorter window.',
          'Particles.spawnOrder',
        );
      }
    }),
  );
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
  assertLittleEndian();
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
  const diagnostics: VfxDiagnostic[] = Object.entries(definition.elements)
    .filter(([, element]) => element.kind === 'grid2d' || element.kind === 'grid3d')
    .map(([key, element]) => ({
      code:
        element.kind === 'grid3d'
          ? 'NACHI_SIM_CACHE_GRID3D_NOT_RECORDED'
          : 'NACHI_SIM_CACHE_GRID2D_NOT_RECORDED',
      message: `Simulation cache v2 does not record ${element.kind === 'grid3d' ? 'Grid3D' : 'Grid2D'} state for element "${key}"; baking executes its stages, while replay neither restores nor advances that state.`,
      path: `elements.${key}`,
      phase: 'runtime',
      severity: 'warning',
    }));
  const originalDefinition = definition as unknown as AnyEffectDefinition;
  const originalSchemas = new Map<string, ResolvedAttributeSchema>();
  const missingLineage = new Set<string>();
  for (const [key, element] of Object.entries(originalDefinition.elements)) {
    if (element.kind !== 'emitter') continue;
    const qualityEmitter = applyEmitterQualityTier(
      element as unknown as EmitterDefinition,
      system.qualitySelection.tier,
    ) as EmitterDefinition<AttributeSchema, ParameterSchema>;
    const schemaResult = resolveAttributeSchema(qualityEmitter);
    if (!schemaResult.ok || !schemaResult.value) {
      throw new VfxDiagnosticError(schemaResult.diagnostics);
    }
    originalSchemas.set(key, schemaResult.value);
    if (schemaResult.value.byName.spawnOrder === undefined) missingLineage.add(key);
  }
  const bakeDefinition = withSimulationCacheLineage(originalDefinition, missingLineage);
  const warmOriginalPool = (): void => {
    if (bakeDefinition === originalDefinition) return;
    const ordinary = system.spawn(
      originalDefinition,
      options.spawn as EffectSpawnOptions<AnyEffectDefinition> | undefined,
    );
    if (ordinary.state === 'error') {
      const ordinaryDiagnostics = ordinary.diagnostics;
      ordinary.release();
      throw new VfxDiagnosticError(ordinaryDiagnostics);
    }
    ordinary.release();
  };
  const instance = system.spawn(
    bakeDefinition,
    options.spawn as EffectSpawnOptions<AnyEffectDefinition> | undefined,
  );
  if (instance.state === 'error') {
    const bakeDiagnostics = instance.diagnostics;
    instance.releaseUnpooled();
    try {
      warmOriginalPool();
    } catch {
      // Preserve the bake-only variant's primary build diagnostics.
    }
    throw new VfxDiagnosticError(bakeDiagnostics);
  }
  if (instance.scalability.action !== 'full') {
    const action = instance.scalability.action;
    const reasons = instance.scalability.reasons.join(', ') || 'unspecified';
    if (bakeDefinition === originalDefinition) instance.release();
    else instance.releaseUnpooled();
    warmOriginalPool();
    throw cacheDiagnostic(
      'NACHI_SIM_CACHE_SCALABILITY_SUPPRESSED',
      `Simulation baking requires full scalability execution; instance action is ${action} (${reasons}).`,
      'instance.scalability',
    );
  }
  const entries = Object.entries(bakeDefinition.elements).filter(
    (entry) => entry[1].kind === 'emitter',
  );
  let recorded: RecordedEmitter[] = [];
  let recordingFailed = false;
  let recordingFailure: unknown;
  try {
    recorded = entries.map(([key]) => {
      const view = instance.getEmitter(key);
      if (!view) throw new Error(`Runtime emitter ${key} is missing during simulation bake.`);
      const originalSchema = originalSchemas.get(key);
      if (!originalSchema) throw new Error(`Original replay schema for ${key} is missing.`);
      const selected = selectedAttributes(view, originalSchema);
      const selectedNames = new Set(selected.map(({ name }) => name));
      return {
        capacity: view.program.attributeSchema.capacity,
        frames: [],
        key,
        rendererUsesSpawnOrder: selected.some(({ name }) => name === 'spawnOrder'),
        selected,
        uploadBytesPerFrame: replayUploadBytesPerFrame(originalSchema, selectedNames),
      };
    });
    await system.update(0);
    await validateSimulationCacheBakeLineageCounters(
      renderer,
      recorded.map(({ key }) => instance.getEmitter(key)!),
    );
    if (instance.scalability.action !== 'full') {
      throw cacheDiagnostic(
        'NACHI_SIM_CACHE_SCALABILITY_SUPPRESSED',
        `Simulation baking was suppressed by scalability action ${instance.scalability.action}.`,
        'instance.scalability',
      );
    }
    const step = 1 / frameRate;
    for (let frame = 0; frame < sampleStartFrame; frame += 1) {
      await system.update(step);
      await validateSimulationCacheBakeLineageCounters(
        renderer,
        recorded.map(({ key }) => instance.getEmitter(key)!),
      );
    }
    for (let frame = 0; frame < options.frames; frame += 1) {
      if (frame > 0) await system.update(step);
      await Promise.all(
        recorded.map(async (emitter) => {
          if (instance.scalability.action !== 'full') {
            throw cacheDiagnostic(
              'NACHI_SIM_CACHE_SCALABILITY_SUPPRESSED',
              `Simulation baking was suppressed by scalability action ${instance.scalability.action}.`,
              'instance.scalability',
            );
          }
          const view = instance.getEmitter(emitter.key);
          if (!view) throw new Error(`Runtime emitter ${emitter.key} disappeared during bake.`);
          emitter.frames.push(
            await recordEmitterFrame(
              renderer,
              view,
              emitter.selected,
              emitter.rendererUsesSpawnOrder,
            ),
          );
        }),
      );
    }
  } catch (error) {
    recordingFailed = true;
    recordingFailure = error;
  } finally {
    if (bakeDefinition === originalDefinition) instance.release();
    else instance.releaseUnpooled();
  }
  if (bakeDefinition !== originalDefinition) {
    // v1 left one ordinary-definition resource bundle in the caller's pool. Rebuild that bundle
    // only after the larger bake-only variant has been retired, preserving pool observability
    // without holding both schemas at peak GPU residency.
    try {
      warmOriginalPool();
    } catch (error) {
      if (!recordingFailed) throw error;
    }
  }
  if (recordingFailed) throw recordingFailure;
  return buildCache(recorded, {
    compression: options.compression ?? 'float32',
    frameRate,
    frames: options.frames,
    interpolation: options.interpolation ?? 'nearest',
    loop: options.loop ?? false,
    loopTolerance,
    qualityTier: system.qualitySelection.tier,
    sampleStartFrame,
    sourceBackend: renderer.kernelAdapter.capabilities.backend,
    diagnostics,
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

function lineageFrame(
  cache: SimulationCache,
  emitter: SimulationCacheEmitterMetadata,
  frame: number,
): Uint32Array {
  return new Uint32Array(
    cache.data,
    emitter.lineageOffsetBytes + frame * emitter.lineageFrameStrideBytes,
    emitter.capacity,
  ).slice();
}

export function interpolateSimulationCacheAttribute(
  left: LogicalArray,
  right: LogicalArray,
  alpha: number,
  leftAlive: ReadonlySet<number>,
  rightAlive: ReadonlySet<number>,
  leftLineage: Uint32Array,
  rightLineage: Uint32Array,
  nearestIsRight: boolean,
  components: number,
): LogicalArray {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || alpha === 0) {
    return (nearestIsRight ? right : left).slice() as LogicalArray;
  }
  const output = (nearestIsRight ? right : left).slice();
  for (const particle of leftAlive) {
    if (!rightAlive.has(particle) || leftLineage[particle] !== rightLineage[particle]) continue;
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
  const currentHasBirthOrder = selectedAttributes(view).some(({ name }) => name === 'spawnOrder');
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
  backend: 'webgl2' | 'webgpu',
): void {
  for (let particle = 0; particle < capacity; particle += 1) {
    for (let component = 0; component < attribute.components; component += 1) {
      target[attributeStorageComponentIndex(attribute, storage, backend, particle, component)] =
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
        'Simulation-cache replay requires the WebGPU indirect-draw upload path; WebGL2 simulation-cache use is diagnostic-only because renderable lifecycle emitters exceed packed group 0.',
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
      const leftLineage = lineageFrame(this.#cache, emitterMetadata, leftFrame);
      const rightLineage =
        rightFrame === leftFrame
          ? leftLineage
          : lineageFrame(this.#cache, emitterMetadata, rightFrame);
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
          interpolateSimulationCacheAttribute(
            left,
            right,
            alpha,
            leftAlive,
            rightAlive,
            leftLineage,
            rightLineage,
            nearestIsRight,
            cachedAttribute.components,
          ),
          attribute,
          storage,
          schema.capacity,
          this.#renderer.kernelAdapter.capabilities.backend,
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
      await this.#renderer.flushStorageWrites?.();
      this.#renderer.markStorageReplayReady?.(view.kernels);
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
