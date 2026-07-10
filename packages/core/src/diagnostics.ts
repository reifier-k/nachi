import type { VfxDiagnostic } from './types.js';

export class VfxDiagnosticError extends Error {
  readonly diagnostics: readonly VfxDiagnostic[];

  constructor(diagnostics: readonly VfxDiagnostic[]) {
    super(
      diagnostics.length === 0
        ? 'VFX validation failed without a diagnostic.'
        : diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
    );
    this.name = 'VfxDiagnosticError';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}
