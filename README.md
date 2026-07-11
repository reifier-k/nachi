# nachi

Niagara parity through a code-first, TSL/WebGPU-native VFX library for Three.js.

**Status:** M11 batches 1-2 implemented: quality/culling/significance plus deterministic simulation
cache baking and zero-simulation replay now complement M10 post effects, sorting/WBOIT, and lit
billboards. The remaining M11 spreadsheet/profiler/mobile work is pre-alpha.

Simulation caches use `bakeSimulation(system, effect, { frames, frameRate, compression, loop })` and
`replaySimulation(system, effect, cache)`. Assets stay loader-friendly as metadata JSON plus an
`ArrayBuffer`; only render-read attributes are recorded. Float32 and component-wise u16 quantization,
nearest/linear playback, endpoint-validated loops, time scale, play/stop, and memory estimates are
available. WebGL2 supports compatible burst baking but reports replay unsupported until its renderer
can bind restored alive indirection.

Project references: [PLAN.md](./PLAN.md), [ROADMAP.md](./ROADMAP.md), and [CLAUDE.md](./CLAUDE.md).
