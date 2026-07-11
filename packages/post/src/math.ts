export type Vec2 = readonly [number, number];

export interface ShockwaveMathConfig {
  readonly center: Vec2;
  readonly radius: number;
  readonly ringWidth: number;
  readonly strength: number;
  readonly speed?: number;
  readonly startTime?: number;
  readonly duration?: number;
  readonly enabled?: number;
}

export interface HeatHazeMathConfig {
  readonly center: Vec2;
  readonly size: Vec2;
  readonly strength: number;
  readonly scale?: number;
  readonly speed?: Vec2;
  readonly feather?: number;
  readonly enabled?: number;
}

export function shockwaveOffsetCpu(uv: Vec2, source: ShockwaveMathConfig, time: number): Vec2 {
  const dx = uv[0] - source.center[0];
  const dy = uv[1] - source.center[1];
  const distance = Math.hypot(dx, dy);
  const elapsed = time - (source.startTime ?? 0);
  const duration = source.duration ?? 1;
  if (elapsed < 0 || elapsed > duration || distance <= 1e-6) return [0, 0];
  const radius = source.radius + (source.speed ?? 0) * elapsed;
  const ring = clamp01(1 - Math.abs(distance - radius) / source.ringWidth);
  const envelope = clamp01(1 - elapsed / duration);
  const magnitude = source.strength * ring * envelope * (source.enabled ?? 1);
  return [(dx / distance) * magnitude, (dy / distance) * magnitude];
}

export function heatHazeOffsetCpu(uv: Vec2, region: HeatHazeMathConfig, time: number): Vec2 {
  const halfX = region.size[0] * 0.5;
  const halfY = region.size[1] * 0.5;
  const edge =
    1 -
    Math.max(
      Math.abs(uv[0] - region.center[0]) / halfX,
      Math.abs(uv[1] - region.center[1]) / halfY,
    );
  const mask = smoothstep(0, region.feather ?? 0.2, edge);
  if (mask <= 0) return [0, 0];
  if ((region.enabled ?? 1) === 0 || region.strength === 0) return [0, 0];
  const scale = region.scale ?? 32;
  const speed = region.speed ?? [0.11, -0.07];
  const px = uv[0] * scale + time * speed[0] * scale;
  const py = uv[1] * scale + time * speed[1] * scale;
  const noiseX = valueNoise(px, py, 12.9898, 78.233);
  const noiseY = valueNoise(px, py, 39.3468, 11.1351);
  const magnitude = region.strength * mask * (region.enabled ?? 1);
  return [noiseX * magnitude, noiseY * magnitude];
}

export function radialBlurSampleUvs(
  uv: Vec2,
  center: Vec2,
  strength: number,
  samples: number,
): readonly Vec2[] {
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('samples must be >= 1');
  if (samples === 1) return [uv];
  return Array.from({ length: samples }, (_, index) => {
    const phase = index / (samples - 1);
    return [
      clampSampleUv(uv[0] + (center[0] - uv[0]) * strength * phase),
      clampSampleUv(uv[1] + (center[1] - uv[1]) * strength * phase),
    ] as const;
  });
}

function valueNoise(x: number, y: number, xCoefficient: number, yCoefficient: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = x - cellX;
  const localY = y - cellY;
  const blendX = localX * localX * (3 - 2 * localX);
  const blendY = localY * localY * (3 - 2 * localY);
  const bottom = mix(
    hashNoise(cellX, cellY, xCoefficient, yCoefficient),
    hashNoise(cellX + 1, cellY, xCoefficient, yCoefficient),
    blendX,
  );
  const top = mix(
    hashNoise(cellX, cellY + 1, xCoefficient, yCoefficient),
    hashNoise(cellX + 1, cellY + 1, xCoefficient, yCoefficient),
    blendX,
  );
  return mix(bottom, top, blendY);
}

function hashNoise(x: number, y: number, xCoefficient: number, yCoefficient: number): number {
  const value = Math.sin(x * xCoefficient + y * yCoefficient) * 43_758.5453;
  return 2 * (value - Math.floor(value)) - 1;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampSampleUv(value: number): number {
  return Math.min(0.999, Math.max(0.001, value));
}

function mix(start: number, end: number, phase: number): number {
  return start * (1 - phase) + end * phase;
}

function smoothstep(low: number, high: number, value: number): number {
  const phase = clamp01((value - low) / (high - low));
  return phase * phase * (3 - 2 * phase);
}
