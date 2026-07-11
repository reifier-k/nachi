export type MeshFxDiagnostic = Readonly<{
  code:
    | 'NACHI_MESHFX_INVALID_PARAMETER'
    | 'NACHI_MESHFX_TEXTURE_REQUIRED'
    | 'NACHI_VAT_FLOAT_TEXTURE_REQUIRED'
    | 'NACHI_VAT_FRAME_RANGE'
    | 'NACHI_VAT_LAYOUT_MISMATCH'
    | 'NACHI_VAT_NODE_MATERIAL_REQUIRED'
    | 'NACHI_VAT_VERTEX_COUNT_MISMATCH';
  message: string;
  path: string;
}>;

export class MeshFxDiagnosticError extends Error {
  readonly diagnostic: MeshFxDiagnostic;

  constructor(diagnostic: MeshFxDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`);
    this.name = 'MeshFxDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export function invalid(path: string, message: string): never {
  throw new MeshFxDiagnosticError({ code: 'NACHI_MESHFX_INVALID_PARAMETER', message, path });
}

export function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) invalid(path, 'must be finite');
  return value;
}

export function positive(value: number, path: string): number {
  if (!Number.isFinite(value) || value <= 0) invalid(path, 'must be finite and > 0');
  return value;
}

export function nonNegative(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0) invalid(path, 'must be finite and >= 0');
  return value;
}

export function integer(value: number, path: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum)
    invalid(path, `must be an integer >= ${minimum}`);
  return value;
}

export function unit(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalid(path, 'must be within [0, 1]');
  return value;
}
