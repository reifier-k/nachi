export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export function uvFlowCpu(uv: Vec2, speed: Vec2, time: number): Vec2 {
  finiteVec2(uv, 'uv');
  finiteVec2(speed, 'speed');
  finite(time, 'time');
  return [uv[0] + speed[0] * time, uv[1] + speed[1] * time];
}

export function polarUVCpu(
  uv: Vec2,
  options: { readonly center?: Vec2; readonly rotation?: number } = {},
): Vec2 {
  finiteVec2(uv, 'uv');
  const center = options.center ?? [0.5, 0.5];
  const rotation = options.rotation ?? 0;
  finiteVec2(center, 'center');
  finite(rotation, 'rotation');
  const x = uv[0] - center[0];
  const y = uv[1] - center[1];
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedX = x * cosine - y * sine;
  const rotatedY = x * sine + y * cosine;
  const angle = fract(Math.atan2(rotatedY, rotatedX) / (Math.PI * 2) + 0.5);
  return [angle, Math.hypot(rotatedX, rotatedY)];
}

export function fresnelFactorCpu(normal: Vec3, viewDirection: Vec3, power = 5): number {
  const n = normalize(normal, 'normal');
  const v = normalize(viewDirection, 'viewDirection');
  if (!Number.isFinite(power) || power <= 0) throw new RangeError('power must be finite and > 0');
  const cosine = clamp(n[0] * v[0] + n[1] * v[1] + n[2] * v[2], 0, 1);
  return (1 - cosine) ** power;
}

export function dissolveCpu(
  noise: number,
  threshold: number,
  edgeWidth: number,
): {
  readonly coverage: 0 | 1;
  readonly edge: 0 | 1;
} {
  finite(noise, 'noise');
  finite(threshold, 'threshold');
  if (!Number.isFinite(edgeWidth) || edgeWidth < 0) {
    throw new RangeError('edgeWidth must be finite and >= 0');
  }
  const coverage = noise >= threshold ? 1 : 0;
  const edge = coverage === 1 && noise < threshold + edgeWidth ? 1 : 0;
  return { coverage, edge };
}

export function distortionUVCpu(uv: Vec2, noiseRg: Vec2, strength: number): Vec2 {
  finiteVec2(uv, 'uv');
  finiteVec2(noiseRg, 'noiseRg');
  finite(strength, 'strength');
  return [uv[0] + (noiseRg[0] * 2 - 1) * strength, uv[1] + (noiseRg[1] * 2 - 1) * strength];
}

export type FlowMapPhases = Readonly<{
  phase0: number;
  phase1: number;
  uv0: Vec2;
  uv1: Vec2;
  weight0: number;
  weight1: number;
}>;

export function flowMapPhasesCpu(options: {
  readonly flow: Vec2;
  readonly speed?: number;
  readonly strength?: number;
  readonly time: number;
  readonly uv: Vec2;
}): FlowMapPhases {
  finiteVec2(options.uv, 'uv');
  finiteVec2(options.flow, 'flow');
  const speed = options.speed ?? 1;
  const strength = options.strength ?? 1;
  finite(options.time, 'time');
  finite(speed, 'speed');
  finite(strength, 'strength');
  const phase0 = fract(options.time * speed);
  const phase1 = fract(phase0 + 0.5);
  const dx = options.flow[0] * strength;
  const dy = options.flow[1] * strength;
  const weight0 = Math.abs(phase0 * 2 - 1);
  return {
    phase0,
    phase1,
    uv0: [options.uv[0] - dx * phase0, options.uv[1] - dy * phase0],
    uv1: [options.uv[0] - dx * phase1, options.uv[1] - dy * phase1],
    weight0,
    weight1: 1 - weight0,
  };
}

export function blendFlowMapSamplesCpu<T extends readonly number[]>(
  sample0: T,
  sample1: T,
  weight0: number,
): number[] {
  if (sample0.length !== sample1.length) throw new RangeError('samples must have equal length');
  if (!Number.isFinite(weight0) || weight0 < 0 || weight0 > 1) {
    throw new RangeError('weight0 must be within [0, 1]');
  }
  return sample0.map((value, index) => value * weight0 + (sample1[index] ?? 0) * (1 - weight0));
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function finiteVec2(value: Vec2, name: string): void {
  finite(value[0], `${name}[0]`);
  finite(value[1], `${name}[1]`);
}

function normalize(value: Vec3, name: string): Vec3 {
  value.forEach((component, index) => finite(component, `${name}[${index}]`));
  const magnitude = Math.hypot(...value);
  if (magnitude === 0) throw new RangeError(`${name} must not be zero`);
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
