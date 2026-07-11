import { dissolve, fresnel, polarUV as polarUvNode, rimLight, uvFlow } from '@nachi/tsl-kit';
import type { ColorInput, ScalarInput, TextureInput, Vec2Input } from '@nachi/tsl-kit';
import {
  AdditiveBlending,
  MultiplyBlending,
  NormalBlending,
  type ColorRepresentation,
} from 'three';
import * as THREE from 'three/webgpu';
import { float, mix, select, texture, uniform, uv, vec3 } from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import type UniformNode from 'three/src/nodes/core/UniformNode.js';

import { MeshFxDiagnosticError, finite, invalid, nonNegative, positive, unit } from './diagnostics';

export interface PolarUvAuthoringConfig {
  readonly center?: Vec2Input;
  readonly rotation?: ScalarInput;
}

export interface UvFlowAuthoringConfig {
  readonly speed: Vec2Input;
}

export interface PolarUvAuthoring {
  readonly kind: 'polarUV';
  readonly center?: Vec2Input;
  readonly rotation?: ScalarInput;
  readonly flows: readonly UvFlowAuthoringConfig[];
  flow(config: UvFlowAuthoringConfig): PolarUvAuthoring;
}

export function polarUV(config: PolarUvAuthoringConfig = {}): PolarUvAuthoring {
  if (Array.isArray(config.center)) {
    finite(config.center[0] ?? Number.NaN, 'polarUV.center[0]');
    finite(config.center[1] ?? Number.NaN, 'polarUV.center[1]');
  }
  if (typeof config.rotation === 'number') finite(config.rotation, 'polarUV.rotation');
  return polarBuilder(config, []);
}

function polarBuilder(
  config: PolarUvAuthoringConfig,
  flows: readonly UvFlowAuthoringConfig[],
): PolarUvAuthoring {
  return Object.freeze({
    kind: 'polarUV' as const,
    ...(config.center === undefined ? {} : { center: config.center }),
    ...(config.rotation === undefined ? {} : { rotation: config.rotation }),
    flows,
    flow(flowConfig: UvFlowAuthoringConfig): PolarUvAuthoring {
      validateSpeed(flowConfig.speed, 'polarUV.flow.speed');
      return polarBuilder(config, [...flows, Object.freeze({ ...flowConfig })]);
    },
  });
}

export type OverLifeCurve = readonly (readonly [time: number, value: number])[];
export type OverLifeInput = ScalarInput | OverLifeCurve;
export type FxBlending = 'additive' | 'alpha' | 'multiply' | 'premultiplied';

export interface FxDissolveConfig {
  readonly texture: TextureInput;
  readonly overLife: OverLifeInput;
  readonly edgeColor?: ColorInput;
  readonly edgeWidth?: ScalarInput;
}

export interface FxFresnelConfig {
  readonly color?: ColorInput;
  readonly power?: ScalarInput;
}

export interface FxMaterialConfig {
  readonly color?: ColorRepresentation;
  readonly map?: TextureInput;
  readonly uv?: PolarUvAuthoring;
  readonly dissolve?: FxDissolveConfig;
  readonly fresnel?: FxFresnelConfig;
  readonly blending?: FxBlending;
  readonly opacity?: number;
  /** Standalone clock input. Omit to receive a writable uniform in `material.fx.time`. */
  readonly time?: ScalarInput;
  /** Effect-local normalized age. Omit to receive a writable standalone uniform. */
  readonly normalizedLife?: ScalarInput;
  readonly depthWrite?: boolean;
}

export interface FxMaterialControls {
  readonly time: UniformNode<'float', number> | null;
  readonly normalizedLife: UniformNode<'float', number> | null;
  setTime(value: number): void;
  setNormalizedLife(value: number): void;
}

export type FxNodeMaterial = THREE.MeshBasicNodeMaterial & { readonly fx: FxMaterialControls };

export function fxMaterial(config: FxMaterialConfig = {}): FxNodeMaterial {
  validateConfig(config);
  const timeUniform = config.time === undefined ? uniform(0) : null;
  const lifeUniform = config.normalizedLife === undefined ? uniform(0) : null;
  const timeNode = config.time ?? timeUniform!;
  const lifeNode = config.normalizedLife ?? lifeUniform!;
  const uvNode = lowerUv(config.uv, timeNode);
  const base = config.map
    ? texture(requiredTexture(config.map, 'fxMaterial.map'), uvNode).rgb
    : rimLight({ baseColor: config.color ?? 0xffffff, intensity: 0 });
  let composed: Node<'vec3'> = vec3(base);
  let opacityNode: Node<'float'> = float(config.opacity ?? 1);

  if (config.dissolve) {
    const cut = dissolve({
      noiseTexture: requiredTexture(config.dissolve.texture, 'fxMaterial.dissolve.texture'),
      threshold: lowerOverLife(config.dissolve.overLife, lifeNode),
      uv: uvNode,
      ...(config.dissolve.edgeColor === undefined ? {} : { edgeColor: config.dissolve.edgeColor }),
      ...(config.dissolve.edgeWidth === undefined ? {} : { edgeWidth: config.dissolve.edgeWidth }),
    });
    composed = composed.add(cut.rgb);
    opacityNode = opacityNode.mul(cut.a);
  }
  if (config.fresnel) {
    composed = composed.add(
      fresnel({
        ...(config.fresnel.color === undefined ? {} : { color: config.fresnel.color }),
        ...(config.fresnel.power === undefined ? {} : { power: config.fresnel.power }),
      }),
    );
  }

  const blending = config.blending ?? 'alpha';
  const material = new THREE.MeshBasicNodeMaterial({
    blending: blendingValue(blending),
    depthWrite: config.depthWrite ?? false,
    premultipliedAlpha: blending === 'premultiplied' || blending === 'multiply',
    transparent: true,
  }) as FxNodeMaterial;
  material.colorNode = composed;
  material.opacityNode = opacityNode;
  material.alphaTest = config.dissolve ? 0.001 : 0;
  Object.defineProperty(material, 'fx', {
    configurable: false,
    enumerable: true,
    value: Object.freeze({
      time: timeUniform,
      normalizedLife: lifeUniform,
      setTime(value: number): void {
        if (!timeUniform) invalid('fxMaterial.time', 'is externally bound and cannot be assigned');
        timeUniform.value = finite(value, 'fxMaterial.time');
      },
      setNormalizedLife(value: number): void {
        if (!lifeUniform) {
          invalid('fxMaterial.normalizedLife', 'is externally bound and cannot be assigned');
        }
        lifeUniform.value = unit(value, 'fxMaterial.normalizedLife');
      },
    }) satisfies FxMaterialControls,
  });
  return material;
}

function lowerUv(authoring: PolarUvAuthoring | undefined, time: ScalarInput): Node<'vec2'> {
  if (!authoring) return uv();
  if (authoring.kind !== 'polarUV') invalid('fxMaterial.uv.kind', 'must be "polarUV"');
  let node = polarUvNode({
    ...(authoring.center === undefined ? {} : { center: authoring.center }),
    ...(authoring.rotation === undefined ? {} : { rotation: authoring.rotation }),
  });
  for (const flow of authoring.flows) node = uvFlow({ uv: node, speed: flow.speed, time });
  return node;
}

function lowerOverLife(input: OverLifeInput, life: ScalarInput): ScalarInput {
  if (!Array.isArray(input)) return input as ScalarInput;
  const points = input as OverLifeCurve;
  validateCurve(points);
  const lifeNode = typeof life === 'number' ? float(life) : life.toFloat();
  let result: Node<'float'> = float(points.at(-1)![1]);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const [startTime, startValue] = points[index]!;
    const [endTime, endValue] = points[index + 1]!;
    const phase = lifeNode
      .sub(startTime)
      .div(endTime - startTime)
      .clamp(0, 1);
    const segment = mix(float(startValue), float(endValue), phase);
    result = select(lifeNode.lessThan(endTime), segment, result);
  }
  return result;
}

function validateConfig(config: FxMaterialConfig): void {
  if (config.opacity !== undefined) unit(config.opacity, 'fxMaterial.opacity');
  if (typeof config.time === 'number') finite(config.time, 'fxMaterial.time');
  if (typeof config.normalizedLife === 'number') {
    unit(config.normalizedLife, 'fxMaterial.normalizedLife');
  }
  if (
    config.blending &&
    !['additive', 'alpha', 'multiply', 'premultiplied'].includes(config.blending)
  ) {
    invalid('fxMaterial.blending', 'must be additive, alpha, multiply, or premultiplied');
  }
  if (config.dissolve) {
    requiredTexture(config.dissolve.texture, 'fxMaterial.dissolve.texture');
    if (Array.isArray(config.dissolve.overLife))
      validateCurve(config.dissolve.overLife as OverLifeCurve);
    if (typeof config.dissolve.edgeWidth === 'number') {
      nonNegative(config.dissolve.edgeWidth, 'fxMaterial.dissolve.edgeWidth');
    }
  }
  if (typeof config.fresnel?.power === 'number')
    positive(config.fresnel.power, 'fxMaterial.fresnel.power');
}

function validateCurve(points: OverLifeCurve): void {
  if (points.length < 2)
    invalid('fxMaterial.dissolve.overLife', 'curve must contain at least two points');
  let previous = -1;
  for (let index = 0; index < points.length; index += 1) {
    const [time, value] = points[index]!;
    unit(time, `fxMaterial.dissolve.overLife[${index}][0]`);
    unit(value, `fxMaterial.dissolve.overLife[${index}][1]`);
    if (time <= previous)
      invalid('fxMaterial.dissolve.overLife', 'curve times must be strictly increasing');
    previous = time;
  }
  if (points[0]![0] !== 0 || points.at(-1)![0] !== 1) {
    invalid('fxMaterial.dissolve.overLife', 'curve must have endpoints at time 0 and 1');
  }
}

function requiredTexture<TextureType extends TextureInput>(
  input: TextureType,
  path: string,
): TextureType {
  if (input?.isTexture !== true) {
    throw new MeshFxDiagnosticError({
      code: 'NACHI_MESHFX_TEXTURE_REQUIRED',
      message: 'must be a Three.js Texture',
      path,
    });
  }
  return input;
}

function validateSpeed(speed: Vec2Input, path: string): void {
  if (!Array.isArray(speed)) return;
  finite(speed[0] ?? Number.NaN, `${path}[0]`);
  finite(speed[1] ?? Number.NaN, `${path}[1]`);
}

function blendingValue(blending: FxBlending): THREE.Blending {
  if (blending === 'additive') return AdditiveBlending;
  if (blending === 'multiply') return MultiplyBlending;
  return NormalBlending;
}
