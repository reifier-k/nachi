import { VfxDiagnosticError, type VfxDiagnostic } from '@nachi-vfx/core';

import { EFFECT_ASSET_FORMAT, EFFECT_ASSET_VERSION, type EffectAssetMigration } from './types.js';

type MigrationEntry = {
  readonly migrate: EffectAssetMigration;
  readonly toVersion: number;
};

function diagnostic(code: string, message: string, path?: string): VfxDiagnostic {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase: 'deserialize',
    severity: 'error',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Explicit, one-step-at-a-time migration graph. No semver or best-effort coercion is inferred. */
export class EffectAssetMigrationRegistry {
  readonly #entries = new Map<number, MigrationEntry>();

  register(fromVersion: number, toVersion: number, migrate: EffectAssetMigration): this {
    if (
      !Number.isSafeInteger(fromVersion) ||
      fromVersion < 1 ||
      !Number.isSafeInteger(toVersion) ||
      toVersion < 1 ||
      fromVersion === toVersion
    ) {
      throw new VfxDiagnosticError([
        diagnostic(
          'NACHI_ASSET_MIGRATION_VERSION_INVALID',
          'Asset migrations require distinct positive integer versions.',
          'version',
        ),
      ]);
    }
    if (this.#entries.has(fromVersion)) {
      throw new VfxDiagnosticError([
        diagnostic(
          'NACHI_ASSET_MIGRATION_CONFLICT',
          `A migration from version ${fromVersion} is already registered.`,
          'version',
        ),
      ]);
    }
    this.#entries.set(fromVersion, { migrate, toVersion });
    return this;
  }

  migrate(document: unknown, targetVersion = EFFECT_ASSET_VERSION): unknown {
    if (!isRecord(document)) return document;
    if (document.format !== EFFECT_ASSET_FORMAT || !Number.isSafeInteger(document.version)) {
      return document;
    }
    let current: unknown = document;
    let version = document.version as number;
    const visited = new Set<number>();
    while (version !== targetVersion) {
      if (visited.has(version)) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_ASSET_MIGRATION_CYCLE',
            `Asset migration graph revisited version ${version}.`,
            'version',
          ),
        ]);
      }
      visited.add(version);
      const entry = this.#entries.get(version);
      if (!entry) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_ASSET_VERSION_UNSUPPORTED',
            `Asset version ${version} cannot be migrated to supported version ${targetVersion}.`,
            'version',
          ),
        ]);
      }
      current = entry.migrate(current as Readonly<Record<string, unknown>>, {
        fromVersion: version,
        toVersion: entry.toVersion,
      });
      if (!isRecord(current) || current.format !== EFFECT_ASSET_FORMAT) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_ASSET_MIGRATION_INVALID_RESULT',
            `Migration ${version} -> ${entry.toVersion} did not return a nachi-effect envelope.`,
          ),
        ]);
      }
      if (current.version !== entry.toVersion) {
        throw new VfxDiagnosticError([
          diagnostic(
            'NACHI_ASSET_MIGRATION_INVALID_RESULT',
            `Migration ${version} -> ${entry.toVersion} returned version ${String(current.version)}.`,
            'version',
          ),
        ]);
      }
      version = entry.toVersion;
    }
    return current;
  }
}

export const defaultEffectAssetMigrations = new EffectAssetMigrationRegistry();
