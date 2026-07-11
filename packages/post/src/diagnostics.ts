export type PostDiagnostic = Readonly<{
  code: 'NACHI_POST_EXTERNAL_BINDING' | 'NACHI_POST_INVALID_ORDER' | 'NACHI_POST_INVALID_PARAMETER';
  message: string;
  path: string;
}>;

export class PostDiagnosticError extends Error {
  readonly diagnostic: PostDiagnostic;

  constructor(diagnostic: PostDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`);
    this.name = 'PostDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export function invalid(path: string, message: string): never {
  throw new PostDiagnosticError({ code: 'NACHI_POST_INVALID_PARAMETER', message, path });
}

export function invalidOrder(path: string, message: string): never {
  throw new PostDiagnosticError({ code: 'NACHI_POST_INVALID_ORDER', message, path });
}

export function externalBinding(path: string): never {
  throw new PostDiagnosticError({
    code: 'NACHI_POST_EXTERNAL_BINDING',
    message: 'is externally bound and cannot be assigned through PostPipeline controls',
    path,
  });
}

export function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) invalid(path, 'must be finite');
  return value;
}

export function nonNegative(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0) invalid(path, 'must be finite and >= 0');
  return value;
}

export function positive(value: number, path: string): number {
  if (!Number.isFinite(value) || value <= 0) invalid(path, 'must be finite and > 0');
  return value;
}

export function unit(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalid(path, 'must be within [0, 1]');
  return value;
}

export function integer(value: number, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(path, `must be an integer within [${minimum}, ${maximum}]`);
  }
  return value;
}
