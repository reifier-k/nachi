import type Node from 'three/src/nodes/core/Node.js';

import { step, texture, vec4 } from './tsl';
import type { ColorInput, ScalarInput, TextureInput } from './types';
import { color3, scalar, textureInput, vector2 } from './validation';

export interface DissolveConfig {
  readonly edgeColor?: ColorInput;
  readonly edgeWidth?: ScalarInput;
  readonly noiseTexture: TextureInput;
  readonly threshold: ScalarInput;
  readonly uv?: Node<'vec2'>;
}

/**
 * Returns vec4(edge emission RGB, binary coverage A). Assign `.a` to
 * `opacityNode` and use a positive material `alphaTest` for a true cutout.
 */
export function dissolve(config: DissolveConfig): Node<'vec4'> {
  const sourceUv = config.uv === undefined ? undefined : vector2(config.uv, 'dissolve.uv');
  const noise = texture(textureInput(config.noiseTexture, 'dissolve.noiseTexture'), sourceUv).r;
  const threshold = scalar(config.threshold, 'dissolve.threshold');
  const edgeWidth = scalar(config.edgeWidth ?? 0.05, 'dissolve.edgeWidth', 0);
  const coverage = step(threshold, noise);
  const beyondEdge = step(threshold.add(edgeWidth), noise);
  const edge = coverage.sub(beyondEdge);
  return vec4(color3(config.edgeColor ?? 0xffffff, 'dissolve.edgeColor').mul(edge), coverage);
}
