import type {
  EffectDefinition,
  EffectElements,
  EmitterOverrideConfig,
  Grid2DStageRegistry,
  Grid3DStageRegistry,
  JsonValue,
  ParameterSchema,
  VfxAssetDocument,
} from '@nachi-vfx/core';

export const EFFECT_ASSET_FORMAT = 'nachi-effect' as const;
export const EFFECT_ASSET_VERSION = 2 as const;

export interface EffectAssetDocumentV1 extends VfxAssetDocument {
  readonly format: typeof EFFECT_ASSET_FORMAT;
  readonly version: 1;
  readonly effect: JsonValue;
}

export interface EffectAssetDocumentV2 extends VfxAssetDocument {
  readonly format: typeof EFFECT_ASSET_FORMAT;
  readonly version: typeof EFFECT_ASSET_VERSION;
  readonly effect: JsonValue;
}

export type EffectAssetDocument = EffectAssetDocumentV2;

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
  /** Registry used to resolve serialized Grid2D stage function references. */
  readonly grid2DStageRegistry?: Pick<Grid2DStageRegistry, 'resolve'>;
  /** Registry used to resolve serialized Grid3D stage function references. */
  readonly grid3DStageRegistry?: Pick<Grid3DStageRegistry, 'resolve'>;
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
