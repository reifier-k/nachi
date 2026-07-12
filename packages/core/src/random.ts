import type { ModuleDefinition } from './types.js';

export const PCG_RANDOM_CONSTANTS = {
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
} as const;

export interface TslPcgFloatNode<FloatNode> {
  mul(value: number): FloatNode;
}

export interface TslPcgUintNode<UintNode, FloatNode> {
  add(value: number | UintNode): UintNode;
  bitXor(value: number | UintNode): UintNode;
  mul(value: number | UintNode): UintNode;
  shiftRight(value: number | UintNode): UintNode;
  toFloat(): FloatNode;
}

function moduleSlotSalt(moduleSlot: number): number {
  return Math.imul(moduleSlot >>> 0, PCG_RANDOM_CONSTANTS.moduleSlotMix) >>> 0;
}

export function hashModuleLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function resolveModuleSlot(
  module: Pick<ModuleDefinition, 'label' | 'stage'>,
  normalizedStageIndex: number,
): number {
  const stageSalt = hashModuleLabel(module.stage);
  const identity =
    module.label === undefined || module.label.length === 0
      ? normalizedStageIndex >>> 0
      : hashModuleLabel(module.label);
  return (stageSalt ^ identity) >>> 0;
}

export function resolveRandomSampleSlot(moduleSlot: number, sampleOffset = 0): number {
  // Keep sample identity on the slot axis so large particle indexes cannot alias offset streams.
  return (
    ((moduleSlot >>> 0) ^ Math.imul(sampleOffset >>> 0, PCG_RANDOM_CONSTANTS.sampleOffsetMix)) >>> 0
  );
}

export function pcgHashUint32(input: number): number {
  const state =
    (Math.imul(input >>> 0, PCG_RANDOM_CONSTANTS.stateMultiplier) +
      PCG_RANDOM_CONSTANTS.stateIncrement) >>>
    0;
  const dynamicShift =
    (state >>> PCG_RANDOM_CONSTANTS.stateShift) + PCG_RANDOM_CONSTANTS.stateShiftOffset;
  const word = Math.imul(
    ((state >>> dynamicShift) ^ state) >>> 0,
    PCG_RANDOM_CONSTANTS.outputMultiplier,
  );
  return ((word >>> PCG_RANDOM_CONSTANTS.outputShift) ^ word) >>> 0;
}

export function pcgRandomFloat(
  particleIndex: number,
  emitterSeed: number,
  moduleSlot: number,
  spawnGeneration: number,
): number {
  const mixedInput =
    (Math.imul(particleIndex >>> 0, PCG_RANDOM_CONSTANTS.particleIndexMix) ^
      Math.imul(emitterSeed >>> 0, PCG_RANDOM_CONSTANTS.emitterSeedMix) ^
      moduleSlotSalt(moduleSlot) ^
      Math.imul(spawnGeneration >>> 0, PCG_RANDOM_CONSTANTS.spawnGenerationMix)) >>>
    0;
  // JavaScript stores this mirror in f64; GPU TSL materializes f32. Callers may compare after
  // f32 rounding, but the uint hash and operation order remain bit-identical.
  return pcgHashUint32(mixedInput) * PCG_RANDOM_CONSTANTS.uint32ToUnitFloat;
}

/**
 * Builds the PCG operations on Three.js TSL-compatible uint nodes without importing Three.js.
 * The integer mapping is mathematically [0, 1), but f32 materialization can round the maximum
 * hash to exactly 1.0 (about one sample in 2^25); GPU consumers therefore use [0, 1].
 */
export function pcgRandomFloatNode<
  FloatNode extends TslPcgFloatNode<FloatNode>,
  UintNode extends TslPcgUintNode<UintNode, FloatNode>,
>(
  particleIndex: UintNode,
  emitterSeed: UintNode,
  moduleSlot: number,
  spawnGeneration: UintNode,
): FloatNode {
  const mixedInput = particleIndex
    .mul(PCG_RANDOM_CONSTANTS.particleIndexMix)
    .bitXor(emitterSeed.mul(PCG_RANDOM_CONSTANTS.emitterSeedMix))
    .bitXor(moduleSlotSalt(moduleSlot))
    .bitXor(spawnGeneration.mul(PCG_RANDOM_CONSTANTS.spawnGenerationMix));
  const state = mixedInput
    .mul(PCG_RANDOM_CONSTANTS.stateMultiplier)
    .add(PCG_RANDOM_CONSTANTS.stateIncrement);
  const word = state
    .shiftRight(
      state.shiftRight(PCG_RANDOM_CONSTANTS.stateShift).add(PCG_RANDOM_CONSTANTS.stateShiftOffset),
    )
    .bitXor(state)
    .mul(PCG_RANDOM_CONSTANTS.outputMultiplier);
  return word
    .shiftRight(PCG_RANDOM_CONSTANTS.outputShift)
    .bitXor(word)
    .toFloat()
    .mul(PCG_RANDOM_CONSTANTS.uint32ToUnitFloat);
}
