import type Node from 'three/src/nodes/core/Node.js';

import { abs, cos, fract, length, mix, sin, texture, uv, vec2 } from './tsl';
import type { ScalarInput, TextureInput, Vec2Input } from './types';
import { scalar, textureInput, vector2 } from './validation';

export interface UvFlowConfig {
  readonly speed: Vec2Input;
  readonly time: ScalarInput;
  readonly uv?: Node<'vec2'>;
}

export function uvFlow(config: UvFlowConfig): Node<'vec2'> {
  const sourceUv = config.uv === undefined ? defaultUv() : vector2(config.uv, 'uvFlow.uv');
  return sourceUv.add(
    vector2(config.speed, 'uvFlow.speed').mul(scalar(config.time, 'uvFlow.time')),
  );
}

export interface PolarUVConfig {
  readonly center?: Vec2Input;
  /** Counter-clockwise angle in radians before normalization to one turn. */
  readonly rotation?: ScalarInput;
  readonly uv?: Node<'vec2'>;
}

export function polarUV(config: PolarUVConfig = {}): Node<'vec2'> {
  const sourceUv = config.uv === undefined ? defaultUv() : vector2(config.uv, 'polarUV.uv');
  const centered = sourceUv.sub(vector2(config.center ?? [0.5, 0.5], 'polarUV.center'));
  const rotation = scalar(config.rotation ?? 0, 'polarUV.rotation');
  // Expand the standard CCW formula so this public convention stays explicit.
  // Three r185's vec2 rotate() agrees with it; the known transpose trap applies
  // to the vec3/Euler route and hand-written matrix literal layout instead.
  const rotated = vec2(
    centered.x.mul(cos(rotation)).sub(centered.y.mul(sin(rotation))),
    centered.x.mul(sin(rotation)).add(centered.y.mul(cos(rotation))),
  );
  const angle = fract(
    rotated.y
      .atan(rotated.x)
      .div(Math.PI * 2)
      .add(0.5),
  );
  return vec2(angle, length(rotated));
}

export interface DistortionUVConfig {
  readonly noiseTexture: TextureInput;
  readonly speed?: Vec2Input;
  readonly strength: ScalarInput;
  readonly time: ScalarInput;
  readonly uv?: Node<'vec2'>;
}

export function distortionUV(config: DistortionUVConfig): Node<'vec2'> {
  const sourceUv = config.uv === undefined ? defaultUv() : vector2(config.uv, 'distortionUV.uv');
  const noiseUv = sourceUv.add(
    vector2(config.speed ?? [0, 0], 'distortionUV.speed').mul(
      scalar(config.time, 'distortionUV.time'),
    ),
  );
  const noise = texture(textureInput(config.noiseTexture, 'distortionUV.noiseTexture'), noiseUv).rg;
  return sourceUv.add(noise.mul(2).sub(1).mul(scalar(config.strength, 'distortionUV.strength')));
}

export interface FlowMapConfig {
  readonly flowTexture: TextureInput;
  readonly map: TextureInput;
  readonly speed?: ScalarInput;
  readonly strength?: ScalarInput;
  readonly time: ScalarInput;
  readonly uv?: Node<'vec2'>;
}

/** Samples a base texture twice and returns the standard two-phase blended RGBA value. */
export function flowMap(config: FlowMapConfig): Node<'vec4'> {
  const sourceUv = config.uv === undefined ? defaultUv() : vector2(config.uv, 'flowMap.uv');
  const flow = texture(textureInput(config.flowTexture, 'flowMap.flowTexture'), sourceUv)
    .rg.mul(2)
    .sub(1)
    .mul(scalar(config.strength ?? 1, 'flowMap.strength'));
  const phase0 = fract(
    scalar(config.time, 'flowMap.time').mul(scalar(config.speed ?? 1, 'flowMap.speed')),
  );
  const phase1 = fract(phase0.add(0.5));
  const uv0 = sourceUv.sub(flow.mul(phase0));
  const uv1 = sourceUv.sub(flow.mul(phase1));
  const weight0 = abs(phase0.mul(2).sub(1));
  const map = textureInput(config.map, 'flowMap.map');
  return mix(texture(map, uv1), texture(map, uv0), weight0);
}

function defaultUv(): Node<'vec2'> {
  return uv();
}
