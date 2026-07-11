import type Node from 'three/src/nodes/core/Node.js';

import { finite, integer, nonNegative, positive, unit, invalid } from './diagnostics.js';
import type {
  BloomConfig,
  BloomPass,
  BloomPresetName,
  HeatHazeRegion,
  RadialBlurConfig,
  RadialBlurPass,
  ScalarInput,
  ScreenDistortionConfig,
  ScreenDistortionPass,
  ShockwaveSource,
  Vec2Input,
} from './types.js';

export const POST_STANDARD_ORDER = Object.freeze(['distortion', 'radialBlur', 'bloom'] as const);

export const BLOOM_PRESETS: Readonly<Record<BloomPresetName, Readonly<BloomConfig>>> =
  Object.freeze({
    soft: Object.freeze({ strength: 0.65, radius: 0.35, threshold: 0.8 }),
    intense: Object.freeze({ strength: 1.5, radius: 0.72, threshold: 0.55 }),
    cinematic: Object.freeze({ strength: 1, radius: 0.55, threshold: 0.7 }),
  });

export function screenDistortion(config: ScreenDistortionConfig): ScreenDistortionPass {
  const shockwaves = config.shockwaves ?? [];
  const heatHaze = config.heatHaze ?? [];
  if (shockwaves.length + heatHaze.length === 0) {
    invalid('screenDistortion', 'requires at least one shockwave or heat-haze region');
  }
  if (typeof config.time === 'number') finite(config.time, 'screenDistortion.time');
  const immutableShockwaves = Object.freeze(
    shockwaves.map((source, index) => freezeShockwave(source, index)),
  );
  const immutableHeatHaze = Object.freeze(
    heatHaze.map((region, index) => freezeHeatHaze(region, index)),
  );
  return Object.freeze({
    kind: 'distortion' as const,
    config: Object.freeze({
      shockwaves: immutableShockwaves,
      heatHaze: immutableHeatHaze,
      ...(config.time === undefined ? {} : { time: config.time }),
    }),
  });
}

export function radialBlur(config: RadialBlurConfig = {}): RadialBlurPass {
  if (config.center !== undefined) validateVec2(config.center, 'radialBlur.center');
  if (typeof config.strength === 'number') unit(config.strength, 'radialBlur.strength');
  integer(config.samples ?? 8, 'radialBlur.samples', 1, 64);
  return Object.freeze({
    kind: 'radialBlur' as const,
    config: Object.freeze({
      center: immutableVec2(config.center ?? [0.5, 0.5]),
      strength: config.strength ?? 0.15,
      samples: config.samples ?? 8,
    }),
  });
}

export function bloomPreset(
  preset: BloomPresetName = 'soft',
  overrides: Partial<BloomConfig> = {},
): BloomPass {
  const base = BLOOM_PRESETS[preset];
  if (!base) invalid('bloomPreset.preset', 'must be soft, intense, or cinematic');
  const config: BloomConfig = {
    strength: overrides.strength ?? base.strength,
    radius: overrides.radius ?? base.radius,
    threshold: overrides.threshold ?? base.threshold,
    ...(overrides.resolutionScale === undefined
      ? {}
      : { resolutionScale: overrides.resolutionScale }),
  };
  if (typeof config.strength === 'number') nonNegative(config.strength, 'bloom.strength');
  if (typeof config.radius === 'number') unit(config.radius, 'bloom.radius');
  if (typeof config.threshold === 'number') nonNegative(config.threshold, 'bloom.threshold');
  if (config.resolutionScale !== undefined)
    unitPositive(config.resolutionScale, 'bloom.resolutionScale');
  return Object.freeze({ kind: 'bloom' as const, preset, config: Object.freeze(config) });
}

export function validateShockwaveSource(source: ShockwaveSource, index: number): void {
  const path = `screenDistortion.shockwaves[${index}]`;
  validateVec2(source.center, `${path}.center`);
  validateScalar(source.radius, `${path}.radius`, nonNegative);
  validateScalar(source.ringWidth, `${path}.ringWidth`, positive);
  validateScalar(source.strength, `${path}.strength`, finite);
  validateScalar(source.speed ?? 0, `${path}.speed`, finite);
  validateScalar(source.startTime ?? 0, `${path}.startTime`, finite);
  validateScalar(source.duration ?? 1, `${path}.duration`, positive);
  validateScalar(source.enabled ?? 1, `${path}.enabled`, unit);
}

function freezeShockwave(source: ShockwaveSource, index: number): Readonly<ShockwaveSource> {
  validateShockwaveSource(source, index);
  return Object.freeze({
    center: immutableVec2(source.center),
    radius: source.radius,
    ringWidth: source.ringWidth,
    strength: source.strength,
    speed: source.speed ?? 0,
    startTime: source.startTime ?? 0,
    duration: source.duration ?? 1,
    enabled: source.enabled ?? 1,
  });
}

export function validateHeatHazeRegion(region: HeatHazeRegion, index: number): void {
  const path = `screenDistortion.heatHaze[${index}]`;
  validateVec2(region.center, `${path}.center`);
  validatePositiveVec2(region.size, `${path}.size`);
  validateScalar(region.strength, `${path}.strength`, nonNegative);
  validateScalar(region.scale ?? 32, `${path}.scale`, positive);
  validateVec2(region.speed ?? [0.11, -0.07], `${path}.speed`);
  validateScalar(region.feather ?? 0.2, `${path}.feather`, unitPositive);
  validateScalar(region.enabled ?? 1, `${path}.enabled`, unit);
}

function freezeHeatHaze(region: HeatHazeRegion, index: number): Readonly<HeatHazeRegion> {
  validateHeatHazeRegion(region, index);
  return Object.freeze({
    center: immutableVec2(region.center),
    size: immutableVec2(region.size),
    strength: region.strength,
    scale: region.scale ?? 32,
    speed: immutableVec2(region.speed ?? [0.11, -0.07]),
    feather: region.feather ?? 0.2,
    enabled: region.enabled ?? 1,
  });
}

function validateScalar(
  value: ScalarInput,
  path: string,
  numericValidator: (value: number, path: string) => number,
): void {
  if (typeof value === 'number') numericValidator(value, path);
  else if (!isNode(value)) invalid(path, 'must be a number or TSL node');
}

function validateVec2(value: Vec2Input, path: string): void {
  if (isNode(value)) return;
  if (!Array.isArray(value) || value.length !== 2)
    invalid(path, 'must be a vec2 tuple or TSL node');
  finite(value[0] ?? Number.NaN, `${path}[0]`);
  finite(value[1] ?? Number.NaN, `${path}[1]`);
}

function validatePositiveVec2(value: Vec2Input, path: string): void {
  validateVec2(value, path);
  if (!isNode(value)) {
    positive(value[0] ?? Number.NaN, `${path}[0]`);
    positive(value[1] ?? Number.NaN, `${path}[1]`);
  }
}

function immutableVec2(value: Vec2Input): Vec2Input {
  return Array.isArray(value) ? Object.freeze([value[0], value[1]] as const) : value;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && (value as { isNode?: unknown }).isNode === true
  );
}

function unitPositive(value: number, path: string): number {
  if (value <= 0) positive(value, path);
  return unit(value, path);
}
