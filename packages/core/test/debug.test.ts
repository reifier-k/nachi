import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  attributeStorageComponentIndex,
  billboard,
  burst,
  compileEmitter,
  defineEmitter,
  positionSphere,
  tslModule,
} from '../src/index.js';
import {
  aggregateProfileFrame,
  captureEmitterAttributes,
  formatAttributeSnapshot,
} from '../src/debug.js';
import type {
  KernelStorageNode,
  ResolvedAttribute,
  VfxEmitterRuntimeView,
  VfxRuntimeRenderer,
} from '../src/index.js';

function resolved(
  name: string,
  logicalType: ResolvedAttribute['logicalType'],
  components: ResolvedAttribute['components'],
): ResolvedAttribute {
  return {
    components,
    default: 0,
    logicalType,
    name,
    path: `Particles.${name}`,
    physical: { bufferIndex: 0, group: 0, offset: 0, packed: false },
    source: 'built-in',
    storageIndex: 0,
    storageType: components === 1 ? 'float' : 'vec3',
    transient: false,
  } as ResolvedAttribute;
}

describe('M11 attribute spreadsheet formatting', () => {
  const attributes = [
    resolved('heat', 'f32', 1),
    resolved('position', 'vec3', 3),
    resolved('spawnGeneration', 'u32', 1),
    resolved('spawnOrder', 'u32', 1),
  ];
  const logicalValues = new Map<string, Float32Array | Uint32Array>([
    ['heat', new Float32Array([10, 20, 30, 40])],
    ['position', new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])],
    ['spawnGeneration', new Uint32Array([1, 2, 3, 4])],
    ['spawnOrder', new Uint32Array([100, 101, 102, 103])],
  ]);

  it('maps compact alive order to physical slots and typed logical values', () => {
    const snapshot = formatAttributeSnapshot({
      aliveIndices: new Uint32Array([2, 0, 3]),
      attributes,
      capacity: 4,
      emitterId: 'fixture',
      logicalValues,
    });

    expect(snapshot.rows).toEqual([
      {
        aliveIndex: 0,
        attributes: { heat: 30, position: [6, 7, 8], spawnGeneration: 3, spawnOrder: 102 },
        physicalSlot: 2,
        spawnGeneration: 3,
        spawnOrder: 102,
      },
      {
        aliveIndex: 1,
        attributes: { heat: 10, position: [0, 1, 2], spawnGeneration: 1, spawnOrder: 100 },
        physicalSlot: 0,
        spawnGeneration: 1,
        spawnOrder: 100,
      },
      {
        aliveIndex: 2,
        attributes: { heat: 40, position: [9, 10, 11], spawnGeneration: 4, spawnOrder: 103 },
        physicalSlot: 3,
        spawnGeneration: 4,
        spawnOrder: 103,
      },
    ]);
    expect(snapshot.truncation).toEqual({
      limit: null,
      offset: 0,
      returned: 3,
      totalAlive: 3,
      truncated: false,
    });
  });

  it('selects columns and reports every explicit truncation boundary', () => {
    const snapshot = formatAttributeSnapshot({
      aliveIndices: new Uint32Array([2, 0, 3]),
      attributes,
      capacity: 4,
      emitterId: 'fixture',
      logicalValues,
      options: { attributes: ['heat'], limit: 1, offset: 1 },
    });

    expect(snapshot.columns.map(({ name }) => name)).toEqual(['heat']);
    expect(snapshot.rows).toEqual([
      {
        aliveIndex: 1,
        attributes: { heat: 10 },
        physicalSlot: 0,
        spawnGeneration: 1,
        spawnOrder: 100,
      },
    ]);
    expect(snapshot.truncation).toEqual({
      limit: 1,
      offset: 1,
      returned: 1,
      totalAlive: 3,
      truncated: true,
    });
  });

  it('applies physical-slot ordering before pagination across backend membership orders', () => {
    const capture = (backend: 'webgl2' | 'webgpu', aliveIndices: readonly number[]) =>
      formatAttributeSnapshot({
        aliveIndices: Uint32Array.from(aliveIndices),
        attributes,
        backend,
        capacity: 4,
        emitterId: backend,
        logicalValues,
        options: { attributes: ['heat'], limit: 1, offset: 1, order: 'physical-slot' },
      });
    const webgpu = capture('webgpu', [3, 0, 2]);
    const webgl2 = capture('webgl2', [0, 2, 3]);

    expect(webgpu.rows).toEqual([
      {
        aliveIndex: 2,
        attributes: { heat: 30 },
        physicalSlot: 2,
        spawnGeneration: 3,
        spawnOrder: 102,
      },
    ]);
    expect(webgl2.rows).toEqual([
      {
        aliveIndex: 1,
        attributes: { heat: 30 },
        physicalSlot: 2,
        spawnGeneration: 3,
        spawnOrder: 102,
      },
    ]);
    expect(webgpu.truncation).toEqual(webgl2.truncation);
  });

  it('preserves duplicate physical slots with a compact-index tie-break and warning', () => {
    const snapshot = formatAttributeSnapshot({
      aliveIndices: new Uint32Array([2, 0, 2]),
      attributes,
      capacity: 4,
      emitterId: 'hostile-membership',
      logicalValues,
      options: { attributes: ['heat'], order: 'physical-slot' },
    });

    expect(snapshot.rows.map(({ aliveIndex, physicalSlot }) => [physicalSlot, aliveIndex])).toEqual(
      [
        [0, 1],
        [2, 0],
        [2, 2],
      ],
    );
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_DEBUG_DUPLICATE_PHYSICAL_SLOT',
        path: 'aliveIndices.2',
        severity: 'warning',
      }),
    );
  });

  it('deduplicates repeated requested columns while preserving first-request order', () => {
    const snapshot = formatAttributeSnapshot({
      aliveIndices: new Uint32Array(),
      attributes,
      capacity: 4,
      emitterId: 'fixture',
      logicalValues,
      options: { attributes: ['position', 'heat', 'position'] },
    });

    expect(snapshot.columns.map(({ name }) => name)).toEqual(['position', 'heat']);
  });

  it('diagnoses an unknown requested logical column', () => {
    expect(() =>
      formatAttributeSnapshot({
        aliveIndices: new Uint32Array(),
        attributes,
        capacity: 4,
        emitterId: 'fixture',
        logicalValues,
        options: { attributes: ['missing'] },
      }),
    ).toThrow(VfxDiagnosticError);
  });

  it('diagnoses every non-enum row order from untyped input instead of defaulting null', () => {
    for (const order of ['spawn-order', null, 1, {}]) {
      let thrown: unknown;
      try {
        formatAttributeSnapshot({
          aliveIndices: new Uint32Array(),
          attributes,
          capacity: 4,
          emitterId: 'fixture',
          logicalValues,
          options: { order } as never,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(VfxDiagnosticError);
      expect((thrown as VfxDiagnosticError).diagnostics).toEqual([
        expect.objectContaining({
          code: 'NACHI_DEBUG_ATTRIBUTE_ORDER_INVALID',
          path: 'options.order',
        }),
      ]);
    }
  });

  it('rejects an out-of-range physical slot on a returned compaction page', () => {
    let thrown: unknown;
    try {
      formatAttributeSnapshot({
        aliveIndices: new Uint32Array([4, 0]),
        attributes,
        capacity: 4,
        emitterId: 'invalid-membership',
        logicalValues,
        options: { attributes: ['heat'], limit: 1 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VfxDiagnosticError);
    expect((thrown as VfxDiagnosticError).diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_DEBUG_PHYSICAL_SLOT_OUT_OF_RANGE',
        path: 'aliveIndices.0',
      }),
    ]);
  });

  it('keeps default compaction validation page-local without scanning skipped rows', () => {
    const snapshot = formatAttributeSnapshot({
      aliveIndices: new Uint32Array([4, 0]),
      attributes,
      capacity: 4,
      emitterId: 'page-local-membership',
      logicalValues,
      options: { attributes: ['heat'], limit: 1, offset: 1 },
    });

    expect(snapshot.rows).toEqual([
      expect.objectContaining({ attributes: { heat: 10 }, physicalSlot: 0 }),
    ]);
  });

  it('validates full physical-slot membership before pagination and sorting', () => {
    let thrown: unknown;
    try {
      formatAttributeSnapshot({
        aliveIndices: new Uint32Array([0, 4]),
        attributes,
        capacity: 4,
        emitterId: 'invalid-stable-membership',
        logicalValues,
        options: { attributes: ['heat'], limit: 1, order: 'physical-slot' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VfxDiagnosticError);
    expect((thrown as VfxDiagnosticError).diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_DEBUG_PHYSICAL_SLOT_OUT_OF_RANGE',
        path: 'aliveIndices.1',
      }),
    ]);
  });

  it('accepts empty stable membership and rejects the u32 maximum at capacity', () => {
    expect(
      formatAttributeSnapshot({
        aliveIndices: new Uint32Array(),
        attributes,
        capacity: 4,
        emitterId: 'empty-membership',
        logicalValues,
        options: { order: 'physical-slot' },
      }).rows,
    ).toEqual([]);

    let thrown: unknown;
    try {
      formatAttributeSnapshot({
        aliveIndices: new Uint32Array([0xffff_ffff]),
        attributes,
        capacity: 4,
        emitterId: 'u32-boundary-membership',
        logicalValues,
        options: { order: 'physical-slot' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VfxDiagnosticError);
    expect((thrown as VfxDiagnosticError).diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_DEBUG_PHYSICAL_SLOT_OUT_OF_RANGE',
        path: 'aliveIndices.0',
      }),
    ]);
  });
});

describe('M11 WebGL2 attribute readback layout', () => {
  it('marks packed group-1 columns whose WebGL2 values alias group 0', async () => {
    const analyticLifetime = tslModule(
      ({ spawnOrder }) => ({ lifetime: spawnOrder.toFloat().mul(3).add(1.5) }),
      { stage: 'init' },
    );
    const definition = defineEmitter({
      capacity: 4,
      init: [positionSphere({ radius: 0 }), analyticLifetime],
      integration: 'none',
      lifecycle: { duration: 10 },
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 4 }),
    });
    const program = compileEmitter(definition);
    const schema = program.attributeSchema;
    const lifetime = schema.byName.lifetime!;
    const position = schema.byName.position!;
    const size = schema.byName.size!;
    const spriteRotation = schema.byName.spriteRotation!;
    const floatStorage = schema.storageArrays[lifetime.physical.bufferIndex]!;

    expect(floatStorage.groupCount).toBe(2);
    expect(lifetime.physical).toMatchObject({ group: 0, offset: 3, packed: true });
    expect(position.physical).toMatchObject({ group: 0, offset: 0, packed: true });
    expect(size.physical).toMatchObject({ group: 1, offset: 0, packed: true });
    expect(spriteRotation.physical).toMatchObject({ group: 1, offset: 1, packed: true });
    expect(
      Array.from({ length: 4 }, (_, particle) =>
        attributeStorageComponentIndex(lifetime, floatStorage, 'webgl2', particle, 0),
      ),
    ).toEqual([3, 7, 11, 15]);
    expect(
      Array.from({ length: 4 }, (_, particle) =>
        attributeStorageComponentIndex(lifetime, floatStorage, 'webgpu', particle, 0),
      ),
    ).toEqual([3, 11, 19, 27]);

    const storageNodes = Object.fromEntries(
      schema.storageArrays.map((storage) => [storage.name, {} as KernelStorageNode]),
    );
    const lifecycleNode = {} as KernelStorageNode;
    const readbacks = new Map<KernelStorageNode, ArrayBuffer>([
      [lifecycleNode, new Uint32Array(1).buffer],
    ]);
    const physical = schema.storageArrays.map((storage) => {
      const length = storage.length * 4;
      return storage.componentType === 'uint' ? new Uint32Array(length) : new Float32Array(length);
    });
    const set = (name: string, particle: number, value: number, component = 0): void => {
      const attribute = schema.byName[name]!;
      const storage = schema.storageArrays[attribute.physical.bufferIndex]!;
      physical[storage.index]![
        attributeStorageComponentIndex(attribute, storage, 'webgl2', particle, component)
      ] = value;
    };
    for (let particle = 0; particle < schema.capacity; particle += 1) {
      set('position', particle, particle + 10, 0);
      set('position', particle, particle + 20, 1);
      set('position', particle, particle + 30, 2);
      set('lifetime', particle, particle * 3 + 1.5);
      set('alive', particle, 1);
      set('spawnGeneration', particle, 7);
      set('spawnOrder', particle, particle);
    }
    for (const storage of schema.storageArrays) {
      readbacks.set(storageNodes[storage.name]!, physical[storage.index]!.buffer as ArrayBuffer);
    }

    const reads: KernelStorageNode[] = [];
    const renderer = {
      kernelAdapter: { capabilities: { backend: 'webgl2' } },
      readStorage: (storage: KernelStorageNode) => {
        reads.push(storage);
        return Promise.resolve(readbacks.get(storage)!.slice(0));
      },
      submitCompute: () => undefined,
    } as unknown as VfxRuntimeRenderer;
    const view = {
      definition,
      kernels: {
        aliveCount: lifecycleNode,
        aliveIndicesOffset: 0,
        counterOffsets: { aliveCount: 0 },
        storages: storageNodes,
      },
      program,
    } as unknown as VfxEmitterRuntimeView;

    const snapshot = await captureEmitterAttributes(renderer, view, 'fixture', {
      attributes: ['lifetime', 'position', 'size', 'spriteRotation'],
    });

    expect(snapshot.rows.map((row) => row.spawnOrder)).toEqual([0, 1, 2, 3]);
    expect(snapshot.rows.map((row) => row.attributes.lifetime)).toEqual([1.5, 4.5, 7.5, 10.5]);
    expect(snapshot.rows.map((row) => row.spawnGeneration)).toEqual([7, 7, 7, 7]);
    expect(snapshot.columns.find(({ name }) => name === 'size')).toMatchObject({ aliased: true });
    expect(snapshot.columns.find(({ name }) => name === 'spriteRotation')).toMatchObject({
      aliased: true,
    });
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED',
        path: 'Particles.size',
        severity: 'warning',
      }),
      expect.objectContaining({
        code: 'NACHI_DEBUG_WEBGL2_ATTRIBUTE_ALIASED',
        path: 'Particles.spriteRotation',
        severity: 'warning',
      }),
    ]);
    expect(
      snapshot.rows.every((row) => {
        const positionValue = row.attributes.position;
        return Array.isArray(positionValue) && row.attributes.size === positionValue[0];
      }),
    ).toBe(true);
    expect(
      snapshot.rows.every((row) => {
        const positionValue = row.attributes.position;
        return Array.isArray(positionValue) && row.attributes.spriteRotation === positionValue[1];
      }),
    ).toBe(true);
    expect(reads).not.toContain(lifecycleNode);
  });
});

describe('M11 profiler aggregation', () => {
  it('sums emitter counters and reuses one pass-level timestamp sample', () => {
    const snapshot = aggregateProfileFrame(
      7,
      [
        {
          aliveCount: 3,
          capacity: 8,
          computeDispatches: 6,
          cpuUpdateMs: 0.25,
          emitterId: 'sparks',
          indirectDraws: 1,
          instanceId: 'a',
          spawnCount: 3,
        },
        {
          aliveCount: 2,
          capacity: 4,
          computeDispatches: 4,
          cpuUpdateMs: 0.5,
          emitterId: 'smoke',
          indirectDraws: 1,
          instanceId: 'a',
          spawnCount: 2,
        },
      ],
      { computeMs: 1.25, reason: null, renderMs: 0.75, status: 'available' },
    );

    expect(snapshot.system).toEqual({
      alive: { reason: null, status: 'available', value: 5 },
      capacity: 12,
      computeDispatches: 10,
      cpuUpdateMs: 0.75,
      indirectDraws: { reason: null, status: 'available', value: 2 },
      spawnCount: 5,
    });
    expect(snapshot.gpu).toEqual({
      computeMs: { reason: null, status: 'available', value: 1.25 },
      granularity: 'pass',
      renderMs: { reason: null, status: 'available', value: 0.75 },
    });
  });

  it('does not disguise unavailable alive, indirect draw, or GPU timing as zero', () => {
    const snapshot = aggregateProfileFrame(1, [
      {
        aliveCount: undefined,
        capacity: 2,
        computeDispatches: 0,
        cpuUpdateMs: 0,
        emitterId: 'webgl',
        indirectDraws: undefined,
        instanceId: 'b',
        spawnCount: 0,
      },
    ]);

    expect(snapshot.system.alive).toMatchObject({ status: 'unavailable', value: null });
    expect(snapshot.system.indirectDraws).toMatchObject({ status: 'unavailable', value: null });
    expect(snapshot.gpu.computeMs).toMatchObject({ status: 'unavailable', value: null });
  });

  it('distinguishes pending alive readback and rejects invalid GPU timing samples', () => {
    const snapshot = aggregateProfileFrame(
      1,
      [
        {
          aliveCount: undefined,
          aliveReadbackEnabled: true,
          capacity: 2,
          computeDispatches: 0,
          cpuUpdateMs: 0,
          emitterId: 'pending',
          indirectDraws: 0,
          instanceId: 'a',
          spawnCount: 0,
        },
      ],
      { computeMs: Number.NaN, reason: null, renderMs: -1, status: 'available' },
    );

    expect(snapshot.emitters[0]?.alive).toMatchObject({
      reason: expect.stringContaining('not yet been measured'),
    });
    expect(snapshot.gpu.computeMs).toMatchObject({
      code: 'NACHI_PROFILE_GPU_TIMESTAMP_INVALID',
      status: 'error',
      value: null,
    });
    expect(snapshot.gpu.renderMs).toMatchObject({
      code: 'NACHI_PROFILE_GPU_TIMESTAMP_INVALID',
      status: 'error',
      value: null,
    });
  });
});
