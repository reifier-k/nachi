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
