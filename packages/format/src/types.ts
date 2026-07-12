import type {
  EffectDefinition,
  EffectElements,
  EmitterOverrideConfig,
  JsonValue,
  ParameterSchema,
  VfxAssetDocument,
} from '@nachi/core';

export const EFFECT_ASSET_FORMAT = 'nachi-effect' as const;
export const EFFECT_ASSET_VERSION = 1 as const;

export interface EffectAssetDocumentV1 extends VfxAssetDocument {
  readonly format: typeof EFFECT_ASSET_FORMAT;
  readonly version: typeof EFFECT_ASSET_VERSION;
  readonly effect: JsonValue;
}

/**
 * An emitter inheritance node stored only in an asset document. `loadEffect()` resolves it to an
 * ordinary eager `EmitterDefinition`, preserving the M9 runtime/compiler boundary.
 */
export interface EmitterAssetExtension {
  readonly kind: 'emitter-extends';
  /** Exactly one `#` separates the optional asset ID from an element key that cannot contain `#`. */
  readonly extends: string;
  readonly overrides: EmitterOverrideConfig;
}

export interface LoadEffectOptions {
  /** Stable identity used by local/external inheritance cycle diagnostics. Defaults to `$root`. */
  readonly assetId?: string;
  readonly migrations?: EffectAssetMigrationRegistryLike;
  /** Synchronous document resolver. External resources remain owned by the application. */
  readonly resolveAsset?: (assetId: string) => unknown;
}

export interface EffectAssetMigrationContext {
  readonly fromVersion: number;
  readonly toVersion: number;
}

export type EffectAssetMigration = (
  document: Readonly<Record<string, unknown>>,
  context: EffectAssetMigrationContext,
) => unknown;

export interface EffectAssetMigrationRegistryLike {
  migrate(document: unknown, targetVersion?: number): unknown;
}

export type LoadedEffectDefinition = EffectDefinition<EffectElements, ParameterSchema>;
