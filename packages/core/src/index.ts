/** The package version, kept in sync with packages/core/package.json. */
export const VERSION = '0.0.0' as const;

export * from './api.js';
export * from './attributes.js';
export * from './compiler.js';
export * from './limits.js';
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
export {
  Grid3DStageRegistry,
  defineGrid3DStageFunction,
  estimateGrid3DMemory,
  grid3DAdvect,
  grid3DBuoyancy,
  grid3DCellIndex,
  grid3DInject,
  grid3DPressureJacobi,
  grid3DProjectVelocity,
  grid3DSnapshotChannel,
  grid3DTslModule,
  rasterizeGrid3DPoints,
  resolveGrid3DChannelLayout,
  sampleGrid3DTrilinear,
} from './grid3d.js';
export type {
  Grid3DAdvectOptions,
  Grid3DBuoyancyOptions,
  Grid3DPressureOptions,
  Grid3DSourceOptions,
  Grid3DStageContext,
  Grid3DStageFactory,
  Grid3DStageFunctionRegistration,
} from './grid3d.js';
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
export {
  NEIGHBOR_GRID_EMPTY_SLOT,
  bucketNeighborGridPoints,
  enumerateNeighborGridCells,
  neighborGridCellCount,
  neighborGridCellIndex,
  neighborGridPositionCell,
  validateNeighborGridDefinition,
} from './neighbor-grid.js';
export type { CpuNeighborGridBuckets } from './neighbor-grid.js';
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
