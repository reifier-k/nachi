import type { ColorRepresentation, Texture } from 'three';
import type Node from 'three/src/nodes/core/Node.js';

export type TslNode = Node;
export type ScalarNode = Node<'float'> | Node<'int'> | Node<'uint'> | Node<'bool'>;
export type ScalarInput = number | ScalarNode;
export type Vec2Input = readonly [number, number] | Node<'vec2'>;
export type ColorInput = ColorRepresentation | Node<'float'> | Node<'vec3'> | Node<'color'>;

export type TextureInput = Texture;

export type TslKitDiagnostic = Readonly<{
  code: 'NACHI_TSLKIT_INVALID_PARAMETER' | 'NACHI_TSLKIT_TEXTURE_REQUIRED';
  message: string;
  path: string;
}>;

export class TslKitDiagnosticError extends Error {
  readonly diagnostic: TslKitDiagnostic;

  constructor(diagnostic: TslKitDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`);
    this.name = 'TslKitDiagnosticError';
    this.diagnostic = diagnostic;
  }
}
