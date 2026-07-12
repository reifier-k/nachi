# nachi

Niagara parity through a code-first, TSL/WebGPU-native VFX library for Three.js.

**Status:** M12 batches 1–4 implemented. `@nachi/format` provides the strict `nachi-effect` v1
JSON envelope, schema, serializer/loader, explicit migrations, and asset-reference emitter
inheritance. Golden #5 now runs from a JSON-loaded definition and compares its timeline actions and
GPU particle bytes with the code-authored control. Core now also provides effect-element
`defineGrid2D()`/`defineGrid3D()` data interfaces and repeated `defineSimStage()` compute stages,
including `/m12-grid/`, `/m12-neighbors/`, and Golden #7 `/golden-fluid/`. M12 integration review remains a pre-alpha
gate.

```ts
import { loadEffect, serializeEffect } from '@nachi/format';

const document = serializeEffect(effect);
const loaded = loadEffect(JSON.stringify(document));
```

Only the declarative subset is accepted. Inline `tslModule()` callbacks, raw Three.js resources,
class instances, functions, and cyclic graphs fail with path-specific `NACHI_ASSET_*` diagnostics;
registered function/resource references—including `tslModule(defineTslFunction(...))`—remain JSON
data.

```ts
const fluid = defineGrid2D({
  resolution: [64, 64],
  channels: {
    density: { type: 'f32' },
    temperature: { type: 'f32' },
    velocity: { type: 'vec2' },
    pressure: { type: 'f32' },
  },
});

const pressure = defineSimStage({
  target: 'fluid',
  iterations: 8,
  update: gridPressureJacobi(),
});
```

Grid stages run before or after the ordinary particle schedule and use separate backend submissions
for every update/commit iteration. WebGL2 reports `NACHI_GRID2D_WEBGL2_UNSUPPORTED`; it does not
pretend transform feedback supplies arbitrary grid addressing or atomics.

```ts
const smoke = defineGrid3D({
  resolution: [32, 32, 32],
  channels: {
    density: { type: 'f32' },
    velocity: { type: 'vec3', default: [0, 0, 0] },
    temperature: { type: 'f32' },
    pressure: { type: 'f32' },
  },
});

const advect = defineSimStage({ target: 'smoke', update: grid3DAdvect() });
const memory = estimateGrid3DMemory(smoke);
```

Grid3D uses the same packed current/scratch buffers and submit-separated ping-pong contract,
with trilinear sampling and explicit cubic memory estimates. Grid-to-particle density sampling feeds
the minimal slice/billboard volume path. WebGL2 reports `NACHI_GRID3D_WEBGL2_UNSUPPORTED`.

Neighbor search uses `defineNeighborGrid({ resolution, cellSize, cellCapacity, origin })` plus
`boids()`, `pbdDistanceConstraint()`, or the code-only `neighborGridTslModule()` iterator. Buckets
are rebuilt before particle update with fixed atomic slots; overflow is dropped and exposed by
`instance.getNeighborGrid(key).capture()`. Search radius is measured in cells. WebGL2 reports
`NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED`.

```sh
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-neighbors/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-neighbors/?backend=webgl
```

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
