# Verification tools

Run repository tools from the repository root. In particular, `spike-runner.mjs` rejects any other
working directory because relative `artifacts/` paths and `--dist` directories are resolved from
the cwd.

The runner can execute a development-server URL or intercept a secure origin from a built
playground directory:

```sh
node tools/spike-runner.mjs 'http://127.0.0.1:5173/repro-readback/?drain=0'
node tools/spike-runner.mjs 'http://127.0.0.1:5173/repro-readback/?drain=1'
node tools/spike-runner.mjs 'https://nachi.local/repro-readback/?drain=1' --dist apps/playground/dist
```

Recorded conclusion (2026-07-14): raw Three r185 with a plain `RenderTarget`,
`MeshBasicNodeMaterial`, and no presentation produced valid first full-size readbacks with
`drain=0` after 18, 30, 60, and 120 readback-free frames. The issue did not reproduce without
nachi's compute pipeline; it did reproduce in `wuwa-slash` when compute and rendering were combined.
No upstream Three issue will be filed.

Element screenshots selected by `data-artifact-screenshots` are saved at their CSS layout
dimensions, not at a canvas's native backing-store dimensions. Treat page-published readback
statistics such as `panelStats` as authoritative for pixel analysis; PNG artifacts are for visual
inspection.

Committed screenshot baselines live in `tools/baselines/`; `artifacts/` only contains disposable
local output. A missing baseline is always a failure. Create or replace one deliberately with
`--update-screenshots`; CI never uses that flag and rejects dirty or untracked files under the
baseline directory. Screenshot specs may include normalized `regions` with an absolute
`minimumForegroundPixels` and a `maximumChangedPixelRatio`; both the baseline and current image
must clear the absolute floor, so two identically empty images cannot pass.

`spike-runner.mjs` treats browser warnings, errors, and uncaught page errors as failures. A page
that intentionally emits a diagnostic may publish `data-expected-diagnostics` as a JSON array of
`{"type":"warning|error|pageerror","text":"required substring"}` records. Each record matches one
diagnostic only; unexpected diagnostics and expectations that never occur both fail.

The runner also validates `nachi.perf-baseline` v2 completion. Pages publish their requested GPU
timestamp scopes, and every requested scope plus the total must finish its warmed sample window.
`pending`, `error`, or a requested-but-unavailable scope fails. Adapter-level timestamp-query
unavailability is allowed only when a structured `unavailableCause` identifies the active backend's
missing timestamp-query capability. Renderer configuration causes such as `trackTimestamp: false`,
missing/mismatched causes, and malformed or incomplete warmup counters fail; timings themselves
remain measurements rather than SwiftShader performance claims.

Run the expanded GPU suite while playground and showcase dev servers are listening on ports 5173
and 5174:

```sh
pnpm verify:gpu
```

The 19-entry suite covers M2 lifecycle/continuous-spawn, M3 rendering/burst-envelope and canonical
event routing, M9 inheritance/pooling plus timeline mesh-fx state ownership, Grid2D, WBOIT,
logical light top-N selection, VAT, textured ribbons, NeighborGrid,
H2-6 world/emitter selectors plus shared Update-midpoint collision response, H2-7 renderer-v2
particle/coarse ordering, mesh depth, decal spawn orientation, quality/pool boundaries on the
existing `/m10-sort/` page, all six showcase pages, and the WebGPU/WebGL M11 cache entries described
below.

The permanent `/m9-timeline/` entry renders a back-facing DoubleSide mesh, compares current opacity
0.2 against an otherwise identical authoring-opacity 0.8 control, and mutates the source after the
clone to prove causally that spawn-time state reaches the GPU and remains independent. It also checks
node/uniform graph independence, shared geometry identity, and pixel readbacks around a stop/replay
while user visibility remains false. `?forceFailure=timeline-user-visible` releases only that user override before the replay
readback; direct `spike-runner.mjs` execution must fail with exactly
`meshFxStateOwnershipGpu=false`. `/m9-compose/` remains the independent inheritance, pooling, and
dirty-lane M9 regression. Headless M9 runs publish readback contracts without adding screenshot
baselines.

The same `/m9-timeline/` entry also rebuilds a real fxMaterial+VAT mesh for two timeline clones and
uses vertex/pixel-centroid readback to distinguish normal advance, time-scale changes, zero-scale
pause, hit stop, resume, stop, loop reset, clone clock independence, and an untouched external VAT
clock. `?forceFailure=timeline-vat-clock` leaves the measured evidence intact but makes exactly
`vatTimelineClockGpu=false`; the direct runner must fail. `/m8-vat/?backend=webgpu` and
`/m8-vat/?backend=webgl` remain the standalone cross-backend VAT regression.

The existing `/m11-cache/` page also verifies simulation-cache v2 lineage. Its WebGPU fixture bakes
a capacity-one emitter whose physical slot is reused by a different `spawnOrder` between two cache
frames, then proves that a linear sample at fraction 0.25 chooses the left/nearest frame in both GPU
attributes and pixels instead of morphing unrelated particles. WebGL2 keeps the structured
unsupported bake/replay diagnostics. The isolated `?forceFailure=lineage-alias` fault aliases the
two recorded lineage values; run it directly with `spike-runner.mjs` and require only
`slotReuseLineageNearest` to fail. This adds two permanent backend entries to the former 15-entry
suite; H2-9 subsequently adds the two M9 entries described above.

Simulation-cache assets now require metadata/payload version 2. Version 1 or missing-version caches
fail with `NACHI_SIM_CACHE_VERSION_UNSUPPORTED` and must be re-baked. The mandatory lossless lineage
stream adds `4 * capacity * frameCount` binary bytes per emitter before alignment, but is not an
additional ordinary per-frame replay upload.

The M10 fixture accepts five isolated fault names through `forceFailure`:
`default-unsorted`, `mesh-depth-write`, `rank-overwrite`, `decal-no-spawn-rotation`, and
`pool-stale-order`. Run each through `spike-runner.mjs`; exactly its corresponding validation must
be false and diagnostics must remain clean. `?backend=webgl` is the explicit negative path and must
publish both `NACHI_PARTICLE_SORT_WEBGL2_UNSUPPORTED` and `NACHI_WBOIT_WEBGL2_UNSUPPORTED` as
successful structured checks. Optional `?quality=low` or `?quality=medium` keeps the M10 perf
fixture's particle count fixed while proving the sorted-off budget path.
