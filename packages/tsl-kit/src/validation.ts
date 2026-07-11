import { Color } from 'three';
import type Node from 'three/src/nodes/core/Node.js';

import { color, float, vec2 } from './tsl.js';
import {
  TslKitDiagnosticError,
  type ColorInput,
  type ScalarInput,
  type Vec2Input,
} from './types.js';

type TextureLike = { readonly isTexture?: boolean };

export function scalar(input: ScalarInput, path: string, minimum?: number): Node<'float'> {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || (minimum !== undefined && input < minimum)) {
      invalid(path, minimum === undefined ? 'must be finite' : `must be finite and >= ${minimum}`);
    }
    return float(input);
  }
  if (!isNode(input)) invalid(path, 'must be a number or TSL node');
  return float(input);
}

export function positiveScalar(input: ScalarInput, path: string): Node<'float'> {
  if (typeof input === 'number' && (!Number.isFinite(input) || input <= 0)) {
    invalid(path, 'must be finite and > 0');
  }
  return scalar(input, path);
}

export function vector2(input: Vec2Input, path: string): Node<'vec2'> {
  if (!isNode(input)) {
    const tuple = input as readonly [number, number];
    if (tuple.length !== 2 || !Number.isFinite(tuple[0]) || !Number.isFinite(tuple[1])) {
      invalid(path, 'must contain two finite numbers');
    }
    return vec2(tuple[0], tuple[1]);
  }
  return vec2(input);
}

export function color3(input: ColorInput, path: string): Node<'vec3'> {
  if (isNode(input)) return color(input as Node<'float'>).rgb;
  if (typeof input === 'string') {
    if (!isThreeColorString(input)) invalid(path, 'must be a valid Three.js CSS color string');
    return color(input).rgb;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > 0xffffff) {
      invalid(path, 'numeric colors must be finite and within 0x000000..0xffffff');
    }
    return color(input).rgb;
  }
  const candidate = input as Color;
  if (
    candidate.isColor !== true ||
    !Number.isFinite(candidate.r) ||
    !Number.isFinite(candidate.g) ||
    !Number.isFinite(candidate.b)
  ) {
    invalid(path, 'must be a finite Three.js Color or TSL node');
  }
  return color(candidate).rgb;
}

export function textureInput<TextureType extends TextureLike>(
  input: TextureType,
  path: string,
): TextureType {
  if (input?.isTexture !== true) {
    throw new TslKitDiagnosticError({
      code: 'NACHI_TSLKIT_TEXTURE_REQUIRED',
      message: 'must be a Three.js Texture',
      path,
    });
  }
  return input;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && (value as { isNode?: unknown }).isNode === true
  );
}

function isThreeColorString(value: string): boolean {
  if (/^#[A-Fa-f\d]{3}(?:[A-Fa-f\d]{3})?$/.test(value)) return true;
  if (Object.hasOwn(Color.NAMES, value.toLowerCase())) return true;
  const functional = /^(rgb|rgba|hsl|hsla)\(([^)]*)\)$/.exec(value);
  if (!functional) return false;
  const model = functional[1];
  const components = functional[2] ?? '';
  if (model === 'rgb' || model === 'rgba') {
    return (
      /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*\d*\.?\d+\s*)?$/.test(components) ||
      /^\s*\d+%\s*,\s*\d+%\s*,\s*\d+%\s*(?:,\s*\d*\.?\d+\s*)?$/.test(components)
    );
  }
  return /^\s*\d*\.?\d+\s*,\s*\d*\.?\d+%\s*,\s*\d*\.?\d+%\s*(?:,\s*\d*\.?\d+\s*)?$/.test(
    components,
  );
}

function invalid(path: string, message: string): never {
  throw new TslKitDiagnosticError({
    code: 'NACHI_TSLKIT_INVALID_PARAMETER',
    message,
    path,
  });
}
