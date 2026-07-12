import { attributeStorageComponentIndex } from './attributes.js';
import { VfxDiagnosticError } from './diagnostics.js';
import type { VfxEmitterRuntimeView, VfxRuntimeRenderer } from './system.js';
import type {
  AttributeSnapshot,
  AttributeSnapshotRow,
  CaptureAttributesOptions,
  DebugAttributeValue,
  ResolvedAttribute,
  ResolvedAttributeSchema,
  VfxDiagnostic,
} from './types.js';

type LogicalArray = Float32Array | Int32Array | Uint32Array;

export type DebugMetric<T> =
  | { readonly reason: null; readonly status: 'available'; readonly value: T }
  | {
      readonly code: string;
      readonly reason: string;
      readonly status: 'error' | 'pending' | 'unavailable';
      readonly value: null;
    };

export interface DebugGpuPassTiming {
  readonly computeMs: number | null;
  readonly reason: string | null;
  readonly renderMs: number | null;
  readonly status: 'available' | 'error' | 'pending' | 'unavailable';
}

export interface EmitterProfileCounters {
  readonly aliveCount: number | undefined;
  readonly capacity: number;
  readonly computeDispatches: number;
  readonly cpuUpdateMs: number;
  readonly emitterId: string;
  readonly indirectDraws: number | undefined;
  readonly instanceId: string;
  readonly spawnCount: number;
}

export interface EmitterProfileSnapshot {
  readonly alive: DebugMetric<number>;
  readonly capacity: number;
  readonly computeDispatches: number;
  readonly cpuUpdateMs: number;
  readonly emitterId: string;
  readonly indirectDraws: DebugMetric<number>;
  readonly instanceId: string;
  readonly spawnCount: number;
}

export interface VfxProfileSnapshot {
  readonly emitters: readonly EmitterProfileSnapshot[];
  readonly frame: number;
  readonly gpu: {
    readonly computeMs: DebugMetric<number>;
    readonly granularity: 'pass';
    readonly renderMs: DebugMetric<number>;
  };
  readonly system: {
    readonly alive: DebugMetric<number>;
    readonly capacity: number;
    readonly computeDispatches: number;
    readonly cpuUpdateMs: number;
    readonly indirectDraws: DebugMetric<number>;
    readonly spawnCount: number;
  };
}

export interface CaptureProfileOptions {
  /** Cached pass timing from the nachi.perf-baseline v1 owner. No timestamp query is issued here. */
  readonly gpuTiming?: DebugGpuPassTiming;
}

export interface VfxSystemDebug {
  captureProfile(options?: CaptureProfileOptions): Promise<VfxProfileSnapshot>;
}

export interface FormatAttributeSnapshotInput {
  readonly aliveIndices: Uint32Array;
  readonly attributes: readonly ResolvedAttribute[];
  readonly backend?: 'webgl2' | 'webgpu';
  readonly capacity: number;
  readonly emitterId: string;
  readonly logicalValues: ReadonlyMap<string, LogicalArray>;
  readonly options?: CaptureAttributesOptions;
}

function runtimeDiagnostic(
  code: string,
  message: string,
  path?: string,
  severity: VfxDiagnostic['severity'] = 'error',
): VfxDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase: 'runtime',
    severity,
  };
}

function validateCaptureOptions(
  options: CaptureAttributesOptions | undefined,
  attributes: readonly ResolvedAttribute[],
): { readonly limit: number | undefined; readonly offset: number } {
  const offset = options?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new VfxDiagnosticError([
      runtimeDiagnostic(
        'NACHI_DEBUG_ATTRIBUTE_OFFSET_INVALID',
        'Attribute capture offset must be a non-negative safe integer.',
        'options.offset',
      ),
    ]);
  }
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new VfxDiagnosticError([
      runtimeDiagnostic(
        'NACHI_DEBUG_ATTRIBUTE_LIMIT_INVALID',
        'Attribute capture limit must be a non-negative safe integer.',
        'options.limit',
      ),
    ]);
  }
  const known = new Set(attributes.map(({ name }) => name));
  const unknown = options?.attributes?.filter((name) => !known.has(name)) ?? [];
  if (unknown.length > 0) {
    throw new VfxDiagnosticError(
      unknown.map((name) =>
        runtimeDiagnostic(
          'NACHI_DEBUG_ATTRIBUTE_UNKNOWN',
          `Logical attribute Particles.${name} is not declared by this emitter.`,
          `options.attributes.${name}`,
        ),
      ),
    );
  }
  return { limit, offset };
}

function rowValue(
  attribute: ResolvedAttribute,
  values: LogicalArray,
  physicalSlot: number,
): DebugAttributeValue {
  const start = physicalSlot * attribute.components;
  if (attribute.components === 1) {
    const value = values[start] ?? 0;
    return attribute.logicalType === 'bool' ? value !== 0 : value;
  }
  return Array.from(values.subarray(start, start + attribute.components));
}

/** Pure table formatter used by the GPU capture path and CPU-only regression tests. */
export function formatAttributeSnapshot(input: FormatAttributeSnapshotInput): AttributeSnapshot {
  const { limit, offset } = validateCaptureOptions(input.options, input.attributes);
  const selectedNames = input.options?.attributes;
  const attributesByName = new Map(
    input.attributes.map((attribute) => [attribute.name, attribute]),
  );
  const selected =
    selectedNames === undefined
      ? input.attributes
      : [...new Set(selectedNames)].map((name) => attributesByName.get(name)!);
  const aliasedNames = new Set(
    input.backend === 'webgl2'
      ? selected.filter(({ physical }) => physical.group >= 1).map(({ name }) => name)
      : [],
  );
  const totalAlive = input.aliveIndices.length;
  const end = Math.min(totalAlive, limit === undefined ? totalAlive : offset + limit);
  const first = Math.min(offset, totalAlive);
  const rows: AttributeSnapshotRow[] = [];
  const generationAttribute = attributesByName.get('spawnGeneration');
  const orderAttribute = attributesByName.get('spawnOrder');
  const generationValues = input.logicalValues.get('spawnGeneration');
  const orderValues = input.logicalValues.get('spawnOrder');
  for (let aliveIndex = first; aliveIndex < end; aliveIndex += 1) {
    const physicalSlot = input.aliveIndices[aliveIndex]!;
    const values = Object.fromEntries(
      selected.map((attribute) => {
        const logical = input.logicalValues.get(attribute.name);
        if (!logical)
          throw new Error(`Logical readback for Particles.${attribute.name} is missing.`);
        return [attribute.name, rowValue(attribute, logical, physicalSlot)] as const;
      }),
    );
    const generation =
      generationAttribute && generationValues
        ? rowValue(generationAttribute, generationValues, physicalSlot)
        : undefined;
    const order =
      orderAttribute && orderValues
        ? rowValue(orderAttribute, orderValues, physicalSlot)
        : undefined;
    rows.push({
      aliveIndex,
      attributes: values,
      physicalSlot,
      ...(typeof generation === 'number' ? { spawnGeneration: generation } : {}),
      ...(typeof order === 'number' ? { spawnOrder: order } : {}),
    });
  }
  return {
    aliveCount: totalAlive,
    capacity: input.capacity,
    columns: selected.map(({ components, logicalType, name }) => ({
      ...(aliasedNames.has(name) ? { aliased: true as const } : {}),
      components,
      logicalType,
      name,
    })),
    diagnostics: [...aliasedNames].map((name) =>
      runtimeDiagnostic(
        'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED',
        `Logical attribute Particles.${name} aliases the corresponding packed group-0 component in the WebGL2 transform-feedback fallback.`,
        `Particles.${name}`,
        'warning',
      ),
    ),
    emitterId: input.emitterId,
    latencyFrames: 1,
    rows,
    truncation: {
      limit: limit ?? null,
      offset,
      returned: rows.length,
      totalAlive,
      truncated: first > 0 || end < totalAlive,
    },
  };
}

function physicalArray(
  storage: ResolvedAttributeSchema['storageArrays'][number],
  buffer: ArrayBuffer,
): LogicalArray {
  if (storage.componentType === 'uint') return new Uint32Array(buffer);
  if (storage.componentType === 'int') return new Int32Array(buffer);
  return new Float32Array(buffer);
}

function logicalArray(attribute: ResolvedAttribute, capacity: number): LogicalArray {
  const length = capacity * attribute.components;
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
  const output = logicalArray(attribute, schema.capacity);
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

/** Reads one coherent logical-attribute snapshot through the renderer's existing storage path. */
export async function captureEmitterAttributes(
  renderer: VfxRuntimeRenderer,
  view: VfxEmitterRuntimeView,
  emitterId: string,
  options?: CaptureAttributesOptions,
): Promise<AttributeSnapshot> {
  if (!renderer.readStorage) {
    throw new VfxDiagnosticError([
      runtimeDiagnostic(
        'NACHI_DEBUG_ATTRIBUTE_READBACK_UNAVAILABLE',
        'The renderer does not expose GPU storage readback for attribute capture.',
      ),
    ]);
  }
  const schema = view.program.attributeSchema;
  const backend = renderer.kernelAdapter.capabilities.backend;
  const allAttributes = schema.attributes;
  validateCaptureOptions(options, allAttributes);
  const requestedNames = new Set(options?.attributes ?? allAttributes.map(({ name }) => name));
  // Lineage is returned even when it was not selected as a visible column.
  for (const name of ['spawnGeneration', 'spawnOrder']) {
    if (schema.byName[name]) requestedNames.add(name);
  }
  if (backend === 'webgl2') requestedNames.add('alive');
  const attributes = [...requestedNames].map((name) => schema.byName[name]!).filter(Boolean);
  const storageIndexes = [...new Set(attributes.map(({ physical }) => physical.bufferIndex))];
  const [lifecycleBuffer, ...buffers] = await Promise.all([
    backend === 'webgpu' ? renderer.readStorage(view.kernels.aliveCount) : undefined,
    ...storageIndexes.map((index) => {
      const storage = schema.storageArrays[index];
      const node = storage && view.kernels.storages[storage.name];
      if (!storage || !node) throw new Error(`Materialized storage ${String(index)} is missing.`);
      return renderer.readStorage!(node);
    }),
  ]);
  const physicalByIndex = new Map(
    storageIndexes.map((storageIndex, index) => [
      storageIndex,
      physicalArray(schema.storageArrays[storageIndex]!, buffers[index]!),
    ]),
  );
  const logicalValues = new Map(
    attributes.map((attribute) => [
      attribute.name,
      extractLogicalAttribute(
        attribute,
        schema,
        physicalByIndex.get(attribute.physical.bufferIndex)!,
        backend,
      ),
    ]),
  );
  let aliveIndices: Uint32Array;
  if (backend === 'webgl2') {
    const alive = logicalValues.get('alive');
    aliveIndices = Uint32Array.from(
      Array.from({ length: schema.capacity }, (_, index) => index).filter(
        (index) => (alive?.[index] ?? 0) !== 0,
      ),
    );
  } else {
    if (!lifecycleBuffer) throw new Error('WebGPU lifecycle readback is missing.');
    const lifecycle = new Uint32Array(lifecycleBuffer);
    const count = Math.min(lifecycle[view.kernels.counterOffsets.aliveCount] ?? 0, schema.capacity);
    aliveIndices = lifecycle
      .subarray(view.kernels.aliveIndicesOffset, view.kernels.aliveIndicesOffset + count)
      .slice();
  }
  return formatAttributeSnapshot({
    aliveIndices,
    attributes: allAttributes,
    backend,
    capacity: schema.capacity,
    emitterId,
    logicalValues,
    ...(options === undefined ? {} : { options }),
  });
}

function available(value: number): DebugMetric<number> {
  return { reason: null, status: 'available', value };
}

function unavailable(code: string, reason: string): DebugMetric<number> {
  return { code, reason, status: 'unavailable', value: null };
}

function gpuMetric(
  timing: DebugGpuPassTiming | undefined,
  path: 'computeMs' | 'renderMs',
  backend: 'webgl2' | 'webgpu',
): DebugMetric<number> {
  if (backend === 'webgl2' && path === 'computeMs') {
    return unavailable(
      'NACHI_PROFILE_GPU_TIMESTAMP_WEBGL2_COMPUTE_UNAVAILABLE',
      'The reduced WebGL2 transform-feedback path has no compute-pass timestamp scope.',
    );
  }
  if (!timing) {
    return unavailable(
      'NACHI_PROFILE_GPU_TIMESTAMP_UNAVAILABLE',
      'No nachi.perf-baseline v1 timestamp sample was supplied.',
    );
  }
  const value = timing[path];
  if (timing.status === 'available' && value !== null) return available(value);
  return {
    code: 'NACHI_PROFILE_GPU_TIMESTAMP_UNAVAILABLE',
    reason: timing.reason ?? `GPU ${path} is ${timing.status}.`,
    status: timing.status === 'available' ? 'pending' : timing.status,
    value: null,
  };
}

/** Pure frame aggregation. Timestamp values are shared perf-baseline samples, never new queries. */
export function aggregateProfileFrame(
  frame: number,
  counters: readonly EmitterProfileCounters[],
  gpuTiming?: DebugGpuPassTiming,
  backend: 'webgl2' | 'webgpu' = 'webgpu',
): VfxProfileSnapshot {
  const emitters = counters.map(
    (counter): EmitterProfileSnapshot => ({
      alive:
        counter.aliveCount === undefined
          ? unavailable(
              'NACHI_PROFILE_ALIVE_READBACK_UNAVAILABLE',
              'Enable aliveCountReadbackInterval to expose an authoritative GPU alive count.',
            )
          : available(counter.aliveCount),
      capacity: counter.capacity,
      computeDispatches: counter.computeDispatches,
      cpuUpdateMs: counter.cpuUpdateMs,
      emitterId: counter.emitterId,
      indirectDraws:
        counter.indirectDraws === undefined
          ? unavailable(
              'NACHI_PROFILE_INDIRECT_DRAW_WEBGL2_UNAVAILABLE',
              'WebGL2 reduced mode has no indirect-draw path.',
            )
          : available(counter.indirectDraws),
      instanceId: counter.instanceId,
      spawnCount: counter.spawnCount,
    }),
  );
  const aliveValues = emitters.map(({ alive }) => alive);
  const drawValues = emitters.map(({ indirectDraws }) => indirectDraws);
  return {
    emitters,
    frame,
    gpu: {
      computeMs: gpuMetric(gpuTiming, 'computeMs', backend),
      granularity: 'pass',
      renderMs: gpuMetric(gpuTiming, 'renderMs', backend),
    },
    system: {
      alive: aliveValues.every(({ status }) => status === 'available')
        ? available(aliveValues.reduce((total, metric) => total + (metric.value ?? 0), 0))
        : unavailable(
            'NACHI_PROFILE_ALIVE_READBACK_UNAVAILABLE',
            'At least one emitter has no authoritative GPU alive count.',
          ),
      capacity: emitters.reduce((total, { capacity }) => total + capacity, 0),
      computeDispatches: emitters.reduce(
        (total, { computeDispatches }) => total + computeDispatches,
        0,
      ),
      cpuUpdateMs: emitters.reduce((total, { cpuUpdateMs }) => total + cpuUpdateMs, 0),
      indirectDraws: drawValues.every(({ status }) => status === 'available')
        ? available(drawValues.reduce((total, metric) => total + (metric.value ?? 0), 0))
        : unavailable(
            'NACHI_PROFILE_INDIRECT_DRAW_WEBGL2_UNAVAILABLE',
            'At least one emitter uses a backend without indirect draw.',
          ),
      spawnCount: emitters.reduce((total, { spawnCount }) => total + spawnCount, 0),
    },
  };
}
