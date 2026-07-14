import { describe, expect, it } from 'vitest';

import {
  PCG_RANDOM_CONSTANTS,
  hashModuleLabel,
  pcgHashUint32,
  pcgRandomFloat,
  pcgRandomFloatNode,
  resolveModuleSlot,
  resolveRandomSampleSlot,
} from '../src/index.js';
import type { TslPcgFloatNode, TslPcgUintNode } from '../src/index.js';

type TraceOperation = readonly [name: string, operand: number];

class TraceFloat implements TslPcgFloatNode<TraceFloat> {
  constructor(
    readonly value: number,
    readonly operations: TraceOperation[],
  ) {}

  mul(value: number): TraceFloat {
    this.operations.push(['float.mul', value]);
    return new TraceFloat(this.value * value, this.operations);
  }
}

class TraceUint implements TslPcgUintNode<TraceUint, TraceFloat> {
  constructor(
    readonly value: number,
    readonly operations: TraceOperation[],
  ) {}

  add(value: number | TraceUint): TraceUint {
    const operand = readUint(value);
    this.operations.push(['uint.add', operand]);
    return new TraceUint((this.value + operand) >>> 0, this.operations);
  }

  bitXor(value: number | TraceUint): TraceUint {
    const operand = readUint(value);
    this.operations.push(['uint.bitXor', operand]);
    return new TraceUint((this.value ^ operand) >>> 0, this.operations);
  }

  mul(value: number | TraceUint): TraceUint {
    const operand = readUint(value);
    this.operations.push(['uint.mul', operand]);
    return new TraceUint(Math.imul(this.value, operand) >>> 0, this.operations);
  }

  shiftRight(value: number | TraceUint): TraceUint {
    const operand = readUint(value);
    this.operations.push(['uint.shiftRight', operand]);
    return new TraceUint(this.value >>> (operand & 31), this.operations);
  }

  toFloat(): TraceFloat {
    this.operations.push(['uint.toFloat', 0]);
    return new TraceFloat(this.value, this.operations);
  }
}

function readUint(value: number | TraceUint): number {
  return typeof value === 'number' ? value >>> 0 : value.value;
}

describe('deterministic PCG random', () => {
  it('uses the same constants and operation order in the JS mirror and TSL node builder', () => {
    expect(PCG_RANDOM_CONSTANTS).toEqual({
      emitterSeedMix: 0x85ebca77,
      moduleSlotMix: 0xc2b2ae3d,
      outputMultiplier: 277_803_737,
      outputShift: 22,
      particleIndexMix: 0x9e3779b1,
      sampleOffsetMix: 0x7f4a7c15,
      spawnGenerationMix: 0x27d4eb2f,
      stateIncrement: 2_891_336_453,
      stateMultiplier: 747_796_405,
      stateShift: 28,
      stateShiftOffset: 4,
      uint32ToUnitFloat: 1 / 2 ** 32,
    });

    const spawnOrder = 123;
    const operations: TraceOperation[] = [];
    const nodeValue = pcgRandomFloatNode<TraceFloat, TraceUint>(
      new TraceUint(spawnOrder, operations),
      new TraceUint(456, operations),
      9,
      new TraceUint(7, operations),
    );

    expect(nodeValue.value).toBe(pcgRandomFloat(spawnOrder, 456, 9, 7));
    expect(operations.map(([name]) => name)).toEqual([
      'uint.mul',
      'uint.mul',
      'uint.bitXor',
      'uint.bitXor',
      'uint.mul',
      'uint.bitXor',
      'uint.mul',
      'uint.add',
      'uint.shiftRight',
      'uint.add',
      'uint.shiftRight',
      'uint.bitXor',
      'uint.mul',
      'uint.shiftRight',
      'uint.bitXor',
      'uint.toFloat',
      'float.mul',
    ]);
    expect(operations[0]?.[1]).toBe(0x9e3779b1);
    expect(operations[1]?.[1]).toBe(0x85ebca77);
    expect(operations[4]?.[1]).toBe(0x27d4eb2f);
    expect(operations[6]?.[1]).toBe(747_796_405);
    expect(operations[7]?.[1]).toBe(2_891_336_453);
    expect(operations[12]?.[1]).toBe(277_803_737);
  });

  it('preserves existing bits when spawn order equals the former particle key', () => {
    expect(pcgRandomFloat(0, 42, 9, 0)).toBe(0.6018068888224661);
  });

  it('returns deterministic values for identical inputs', () => {
    const expected = pcgRandomFloat(12_345, 678, 9, 2);
    expect(pcgRandomFloat(12_345, 678, 9, 2)).toBe(expected);
    expect(pcgRandomFloat(12_345, 678, 9, 2)).toBe(expected);
  });

  it('stays in [0, 1) with a coarse uniform distribution', () => {
    const bins = Array.from({ length: 10 }, () => 0);
    let total = 0;
    for (let particleIndex = 0; particleIndex < 10_000; particleIndex += 1) {
      const value = pcgRandomFloat(particleIndex, 73, 5, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      total += value;
      const bin = Math.min(Math.floor(value * bins.length), bins.length - 1);
      bins[bin] = (bins[bin] ?? 0) + 1;
    }

    expect(total / 10_000).toBeGreaterThan(0.49);
    expect(total / 10_000).toBeLessThan(0.51);
    expect(Math.min(...bins)).toBeGreaterThan(850);
    expect(Math.max(...bins)).toBeLessThan(1150);
  });

  it('changes streams when the emitter seed changes', () => {
    const differences = Array.from(
      { length: 256 },
      (_, particleIndex) =>
        pcgRandomFloat(particleIndex, 10, 3, 0) !== pcgRandomFloat(particleIndex, 11, 3, 0),
    ).filter(Boolean);
    expect(differences.length).toBeGreaterThan(250);
  });

  it('changes streams when the module slot changes', () => {
    const differences = Array.from(
      { length: 256 },
      (_, particleIndex) =>
        pcgRandomFloat(particleIndex, 10, 3, 0) !== pcgRandomFloat(particleIndex, 10, 4, 0),
    ).filter(Boolean);
    expect(differences.length).toBeGreaterThan(250);
  });

  it('mixes sample offsets into the slot axis without the old particle-index collision', () => {
    const moduleSlot = 17;
    expect(resolveRandomSampleSlot(moduleSlot, 0)).toBe(moduleSlot);
    expect(
      new Set(
        Array.from({ length: 256 }, (_, offset) => resolveRandomSampleSlot(moduleSlot, offset)),
      ).size,
    ).toBe(256);

    const formerCollisionDistance = 0x9e37;
    const offsetSample = pcgRandomFloat(0, 73, resolveRandomSampleSlot(moduleSlot, 1), 0);
    const distantParticle = pcgRandomFloat(
      formerCollisionDistance,
      73,
      resolveRandomSampleSlot(moduleSlot, 0),
      0,
    );
    expect(offsetSample).not.toBe(distantParticle);
  });

  it('keeps adjacent spawn-order and sample-stream cells distinct', () => {
    const moduleSlot = 17;
    const samples = Array.from({ length: 256 }, (_, spawnOrder) =>
      Array.from({ length: 8 }, (_unused, stream) =>
        pcgRandomFloat(spawnOrder, 73, resolveRandomSampleSlot(moduleSlot, stream), 0),
      ),
    ).flat();

    expect(new Set(samples).size).toBe(samples.length);
  });

  it('changes streams when the spawn generation changes', () => {
    const differences = Array.from(
      { length: 256 },
      (_, particleIndex) =>
        pcgRandomFloat(particleIndex, 10, 3, 0) !== pcgRandomFloat(particleIndex, 10, 3, 1),
    ).filter(Boolean);
    expect(differences.length).toBeGreaterThan(250);
  });

  it('prefers a stable non-empty module label over the normalized stage index', () => {
    const module = { label: 'stable-smoke', stage: 'update' } as const;
    expect(resolveModuleSlot(module, 0)).toBe(resolveModuleSlot(module, 99));
    expect(resolveModuleSlot(module, 0)).toBe(
      (hashModuleLabel('stable-smoke') ^ hashModuleLabel('update')) >>> 0,
    );
  });

  it('uses the normalized stage index for an unlabeled module', () => {
    expect(resolveModuleSlot({ stage: 'init' }, 0)).toBe(hashModuleLabel('init'));
    expect(resolveModuleSlot({ stage: 'init' }, 7)).toBe((hashModuleLabel('init') ^ 7) >>> 0);
    expect(resolveModuleSlot({ label: '', stage: 'init' }, 9)).toBe(
      (hashModuleLabel('init') ^ 9) >>> 0,
    );
  });

  it('separates equal module identities across stages', () => {
    expect(resolveModuleSlot({ stage: 'init' }, 1)).not.toBe(
      resolveModuleSlot({ stage: 'update' }, 1),
    );
    expect(resolveModuleSlot({ label: 'shared', stage: 'init' }, 1)).not.toBe(
      resolveModuleSlot({ label: 'shared', stage: 'update' }, 1),
    );
  });

  it('hashes module labels deterministically and distinguishes label text', () => {
    expect(hashModuleLabel('init')).toBe(380_752_755);
    expect(hashModuleLabel('update')).toBe(672_109_684);
    expect(hashModuleLabel('stable-smoke')).toBe(2_072_313_442);
    expect(hashModuleLabel('火花')).toBe(hashModuleLabel('火花'));
    expect(hashModuleLabel('fire')).not.toBe(hashModuleLabel('smoke'));
  });

  it('exposes the underlying PCG uint hash as a deterministic mirror primitive', () => {
    expect(pcgHashUint32(0)).toBe(pcgHashUint32(0));
    expect(pcgHashUint32(0)).not.toBe(pcgHashUint32(1));
  });
});
