// The showcase pages share the playground spike harness (renderer bootstrap,
// drained readback, perf-baseline records) so both apps keep one
// implementation of the headless WebGPU constraints documented in CLAUDE.md.
export { createPerformanceMonitor, createTimestampQueryPoolDrain } from '../../playground/src/perf';
export { allPanelsHaveForeground, createDrainedReadback } from '../../playground/src/readback';
export { readLogicalAttribute } from '../../playground/src/three-runtime-readback';
export { createPlaygroundRenderer } from '../../playground/src/webgpu-renderer';
