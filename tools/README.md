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

It covers Grid2D, WBOIT, VAT, textured ribbons, NeighborGrid, and all six showcase pages.
