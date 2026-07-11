import type Node from 'three/src/nodes/core/Node.js';

import { clamp, dot, normalView, positionViewDirection, pow, vec3 } from './tsl.js';
import type { ColorInput, ScalarInput } from './types.js';
import { color3, positiveScalar, scalar } from './validation.js';

export interface FresnelConfig {
  readonly color?: ColorInput;
  readonly normal?: Node<'vec3'>;
  readonly power?: ScalarInput;
  readonly viewDirection?: Node<'vec3'>;
}

/** Returns a standalone colored Fresnel mask. */
export function fresnel(config: FresnelConfig = {}): Node<'vec3'> {
  return color3(config.color ?? 0xffffff, 'fresnel.color').mul(
    fresnelFactor(config, 'fresnel.power'),
  );
}

export interface RimLightConfig {
  readonly baseColor: ColorInput;
  readonly intensity?: ScalarInput;
  readonly lightColor?: ColorInput;
  readonly normal?: Node<'vec3'>;
  readonly power?: ScalarInput;
  readonly viewDirection?: Node<'vec3'>;
}

/** Returns baseColor + colored, intensity-scaled Fresnel light. */
export function rimLight(config: RimLightConfig): Node<'vec3'> {
  const factor = fresnelFactor(
    {
      ...(config.normal === undefined ? {} : { normal: config.normal }),
      ...(config.power === undefined ? {} : { power: config.power }),
      ...(config.viewDirection === undefined ? {} : { viewDirection: config.viewDirection }),
    },
    'rimLight.power',
  );
  const light = color3(config.lightColor ?? 0xffffff, 'rimLight.lightColor').mul(
    factor.mul(scalar(config.intensity ?? 1, 'rimLight.intensity', 0)),
  );
  return color3(config.baseColor, 'rimLight.baseColor').add(light);
}

function fresnelFactor(
  config: Pick<FresnelConfig, 'normal' | 'power' | 'viewDirection'>,
  powerPath: string,
): Node<'float'> {
  const normal = vec3(config.normal ?? normalView).normalize();
  const view = vec3(config.viewDirection ?? positionViewDirection).normalize();
  const cosine = clamp(dot(normal, view), 0, 1);
  return pow(cosine.oneMinus(), positiveScalar(config.power ?? 5, powerPath));
}
