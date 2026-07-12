# nachi

Niagara parity through a code-first, TSL/WebGPU-native VFX library for Three.js.

**Status:** M11 implementation batches complete: quality/culling/significance, deterministic
simulation caches, typed GPU attribute snapshots, and frame-local system/emitter profiling now
complement M10 post effects, sorting/WBOIT, and lit billboards. Mobile validation and the separate
M11 audit remain pre-alpha gates.

Simulation caches use `bakeSimulation(system, effect, { frames, frameRate, compression, loop })` and
`replaySimulation(system, effect, cache)`. Assets stay loader-friendly as metadata JSON plus an
`ArrayBuffer`; only render-read attributes are recorded. Float32 and component-wise u16 quantization,
nearest/linear playback, endpoint-validated loops, time scale, play/stop, and memory estimates are
available. WebGL2 supports compatible burst baking but reports replay unsupported until its renderer
can bind restored alive indirection.

Runtime debugging uses
`await instance.debug.captureAttributes(emitterId, { attributes, offset, limit })` and
`system.debug.captureProfile({ gpuTiming })`. Attribute rows preserve alive/physical-slot and
spawn-generation/order lineage with explicit truncation metadata. Profiler GPU values reuse the
cached `nachi.perf-baseline` v1 pass timing; unavailable timestamps remain null with diagnostics.

Project references: [PLAN.md](./PLAN.md), [ROADMAP.md](./ROADMAP.md), and [CLAUDE.md](./CLAUDE.md).
