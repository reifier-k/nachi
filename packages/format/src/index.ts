export { loadEffect, serializeEffect, validateEffectAsset } from './asset.js';
export { EffectAssetMigrationRegistry, defaultEffectAssetMigrations } from './migrations.js';
export { effectAssetSchemaV1 } from './schema.js';
export {
  EFFECT_ASSET_FORMAT,
  EFFECT_ASSET_VERSION,
  type EffectAssetDocumentV1,
  type EffectAssetMigration,
  type EffectAssetMigrationContext,
  type EmitterAssetExtension,
  type LoadEffectOptions,
  type LoadedEffectDefinition,
} from './types.js';

export const VERSION = '0.0.0' as const;
