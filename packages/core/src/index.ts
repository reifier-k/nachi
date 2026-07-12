/** The package version, kept in sync with packages/core/package.json. */
export const VERSION = '0.0.0' as const;

export * from './api.js';
export * from './attributes.js';
export * from './compiler.js';
export type {
  CaptureProfileOptions,
  DebugGpuPassTiming,
  DebugMetric,
  EmitterProfileSnapshot,
  VfxProfileSnapshot,
  VfxSystemDebug,
} from './debug.js';
export * from './diagnostics.js';
export * from './fga.js';
export * from './random.js';
export { detectDeviceQualityTier, selectDeviceQualityTier } from './scalability.js';
export type {
  DetectDeviceQualityOptions,
  DeviceQualityProfile,
  QualityTierSelection,
} from './scalability.js';
export * from './sim-cache.js';
export * from './sdf.js';
export * from './system.js';
export type * from './types.js';
