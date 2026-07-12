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
export {
  Grid2DStageRegistry,
  defineGrid2DStageFunction,
  grid2DSnapshotChannel,
  gridAdvect,
  gridBuoyancy,
  gridCellIndex,
  gridInject,
  gridPressureJacobi,
  gridProjectVelocity,
  gridTslModule,
  rasterizeGrid2DPoints,
  resolveGrid2DChannelLayout,
  sampleGrid2DBilinear,
  simStageExecutionOrder,
  simStageSubmissionCount,
} from './grid2d.js';
export type {
  Grid2DStageContext,
  Grid2DStageFactory,
  Grid2DStageFunctionRegistration,
  GridAdvectOptions,
  GridBuoyancyOptions,
  GridPressureOptions,
  GridSourceOptions,
} from './grid2d.js';
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
