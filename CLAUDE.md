# Development guide

This monorepo is building a Niagara-parity VFX library around Three Shading Language (TSL), with WebGPU-native simulation/rendering and an explicit WebGL2 fallback. Read [PLAN.md](./PLAN.md) for the design principles and north-star API, then [ROADMAP.md](./ROADMAP.md) for milestones and the parity matrix.

## Repository layout

- `packages/core`: public `@nachi/core` API types, compiler, and particle runtime.
- `packages/format`: `nachi-effect` JSON schema, strict serializer/loader, migrations, and asset inheritance.
- `packages/react`: thin React Three Fiber provider/hook/component lifecycle binding.
- `packages/trails`: ribbon/trail definitions and renderer integration.
- `packages/tsl-kit`: standalone reusable Three Shading Language helpers.
- `packages/mesh-fx`: procedural effect meshes, materials, and VAT runtime.
- `packages/post`: RenderPipeline distortion/blur/bloom plus native-WebGPU weighted blended OIT.
- `packages/timeline`: effect composition, sequencing, hit stop, and mesh-fx lifecycle runtime.
- `apps/playground`: Vite/TypeScript playground plus compute and depth spikes.
- `apps/docs`: lightweight Vite static documentation and seven-effect demo gallery.
- `tools`: Playwright-based WebGPU probes, spike collection, and screenshots.
- `docs/rfc`: normative design RFCs; keep implementation and RFC terminology aligned.

## Commands

```sh
pnpm dev        # Vite on 0.0.0.0:5173 (required before browser tools)
pnpm test       # Vitest
pnpm typecheck  # all workspace TypeScript projects
pnpm lint       # ESLint flat config
pnpm build      # all workspace builds
pnpm docs:build # static documentation artifact in apps/docs/dist
pnpm changeset  # record independently versioned package changes
pnpm release:dry # build + all package ESM gates + npm publish --dry-run; never publishes
```

Tooling (run `pnpm dev` first unless noted):

```sh
node tools/webgpu-probe.mjs [--adapter swiftshader|vulkan|default]
node tools/spike-runner.mjs [http://127.0.0.1:5173/spike-compute/?backend=webgpu]
node tools/spike-runner.mjs http://127.0.0.1:5173/spike-depth/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m1-kernel/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m2-runtime/?backend=webgpu\&scenario=lifecycle
node tools/spike-runner.mjs http://127.0.0.1:5173/m2-runtime/?backend=webgpu\&scenario=time
node tools/spike-runner.mjs http://127.0.0.1:5173/m2-runtime/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m3-sprites/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-explosion/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m4-behaviors/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m5-events/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-ambient/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m6-collision/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-character/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m7-ribbons/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-slash/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-tslkit/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-tslkit/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-meshfx/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-meshfx/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-vat/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m8-vat/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-charge/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m9-compose/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m9-timeline/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m10-post/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m10-post/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m10-sort/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m10-sort/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m10-lit/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-ultimate/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-scale/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-scale/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-cache/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-cache/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-debug/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m11-debug/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-grid/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-grid/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-neighbors/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/m12-neighbors/?backend=webgl
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-fluid/?backend=webgpu
node tools/spike-runner.mjs http://127.0.0.1:5173/golden-fluid/?backend=webgl
node tools/golden-explosion-runner.mjs http://127.0.0.1:5173/golden-explosion/ artifacts
node tools/screenshot.mjs [url] [output.png] [--backend webgl|webgpu]
node tools/screenshot.mjs http://127.0.0.1:5173/spike-depth/ artifacts/depth.png --backend webgl --compare-depth-fade
```

`webgpu-probe` serves its own localhost page. `spike-runner` adds `headless=1` and reads `data-spike-result` plus the `nachi.perf-baseline` record in `data-perf-result`. Screenshot regression defaults to WebGL2 because headless WebGPU cannot present a canvas.
When localhost binding is unavailable, build first and use an intercepted secure origin without a
listener: `node tools/spike-runner.mjs 'https://nachi.local/m11-cache/?backend=webgpu' --dist apps/playground/dist`.
For pages that publish artifact screenshots, existing PNGs pass when the exact changed-pixel ratio is below `0.5%`; use `--update-screenshots` to intentionally re-record the baselines.

Core `defineEffect()` composes elements and parameters but deliberately does not runtime-validate
timeline targets or timeline values. That validation belongs to `@nachi/timeline` authoring and its
defensive runtime normalization, including for definitions created through the core compatibility
factories.

Alpha render modules can opt into WebGPU particle sorting with `sorted: true`; core preserves the
non-deterministic compaction array and sorts a separate draw indirection after every compaction.
Use `sortCenter` for emitter-level coarse ordering. WBOIT materials assign
`createWboitOutput()` to `NodeMaterial.mrtNode`, not `outputNode`; WBOIT and bitonic sorting are
normally alternatives.

Lit billboards use `billboard({ lit: true })` or
`billboard({ lit: { normalMap, roughness, metalness } })`. The Three
adapter keeps MeshStandard physical lighting and substitutes only the Sprite position path;
tangent-space normal maps are rotated into the camera-facing view basis before assignment to
Three r185's view-space `normalNode`. Normal textures must use `NoColorSpace`. Keep the unlit
SpriteNodeMaterial path as the invariant control in renderer changes.

M11 scalability is declared on emitter `quality` tiers plus effect `scalability`. Runtime
spawn/capacity/fade changes do not recompile; soft/lit/sorted gates do. `setQualityTier()` preserves
live structural state and emits `NACHI_QUALITY_RESTART_REQUIRED` when the next spawn must use a new
compile/pool variant. Fully culled effects pause local time and GPU simulation. Significance budget
decisions and their distance/screen/priority components are exposed on `instance.scalability`.

M11 simulation caches record only logical attributes declared by render reads plus lossless alive
indirection. `bakeSimulation()` advances a constant frame step and returns metadata+ArrayBuffer;
`replaySimulation()` restores the existing packed GPU buffers without scheduling simulation kernels.
Float interpolation applies only to slots alive in both frames. Loop caches require a continuous
duplicated endpoint. Keep the v1 per-frame upload path and WebGL2 replay diagnostic aligned with RFC
§10.5 unless a later RFC explicitly adds all-frame residency or a WebGL2 alive-index renderer path.
On WebGL2, any behavioral spawn/init/update access to packed group 1 or above is a build error
(`NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED`), because Three r185 transform feedback would alias it
onto group 0. Do not restore the former reduced-prefix silent-corruption behavior. Group-0-only
reduced runtime emitters remain valid (including the existing WebGL2 smoke pages), but all float
attributes share `packed_float` and lifecycle implicitly adds age/lifetime/normalizedAge. Position
plus lifecycle therefore requires six float components and group 1, so there is no renderable
lifecycle fixture for WebGL2 cache equivalence under the strict gate. Treat WebGL2 bake as
diagnostic-only/effectively unsupported, and keep numerical bake equivalence in the WebGPU branch.

M11 runtime debugging is exposed through `instance.debug.captureAttributes()` and
`system.debug.captureProfile()`. Attribute capture must reuse renderer storage readback and compiled
logical packing, retain explicit truncation, and report one-frame-late asynchronous semantics.
WebGL2 capture may mark a declared higher-group column `aliased` when only the compiler defaults pass
materialized it; that inspection warning coexists with, and does not bypass, the behavioral build
gate above.
Profiler counters reset per top-level system update. Feed it the cached `nachi.perf-baseline` v1 GPU
record; do not add another timestamp resolver or infer GPU time from CPU duration. Keep long-run
correctness renderers timestamp-free and use a separate short perf capture when dispatch counts are
large.

The current perf record is schemaVersion 2. It always includes a `sampleWindow` with four warm-up
samples followed by 16 measured samples by default, and reports median/p95 aggregates per scope and
for the total. SwiftShader values remain smoke observations rather than performance claims; FA
performance budgets must use robust aggregates such as the median from warmed samples on the
relevant hardware.

M12 effect JSON is owned by `@nachi/format`. The v1 envelope is exactly
`{ format: 'nachi-effect', version: 1, effect }`. Keep format-owned structures strict and
path-diagnostic, while leaving registered module `config` fields to their module-version validator.
`loadEffect()` must return an ordinary normalized `EffectDefinition` or throw `NACHI_ASSET_*`; it
must not pass through partial/unknown data. Inline functions and live engine resources remain
non-serializable. Asset emitter `extends` resolves before compilation through M9
`defineEmitter(base, overrides)` semantics. JSON-loaded timeline mesh-fx placeholders require
explicit `bindMeshFxResources()` resolution outside the document.

M12 Grid2D uses `defineGrid2D()` and effect-element `defineSimStage()`. A Grid2D packs logical
channels into one vec4-record storage buffer per state plus one scratch buffer; do not split smoke
channels into SoA buffers and consume the device storage-binding budget. Every stage iteration and
its scratch-to-state commit are separate `submitCompute()` calls because multiple dispatches in one
compute pass do not provide a whole-grid barrier. Built-ins cover injection, semi-Lagrangian
advection/dissipation, buoyancy, Jacobi pressure, and projection. `rasterizeParticles()` uses u32
fixed-point atomics; `sampleParticles()` uses cell-centered bilinear sampling. WebGL2 must retain
the `NACHI_GRID2D_WEBGL2_UNSUPPORTED` diagnostic.

M12 Grid3D uses `defineGrid3D()` plus `grid3D*` stages under the same scheduler and independent
stage/commit submissions. Packed vec4 current/scratch storage, trilinear sampling, fixed-point
particle deposition, and density-to-particle sampling all retain invocation range guards.
`estimateGrid3DMemory()` exposes cubic allocation cost; a binding exceeding `maxStorageBufferBindingSize` or `maxBufferSize` reports
`NACHI_GRID3D_STORAGE_LIMIT_EXCEEDED`. `/golden-fluid/` runs the 32³ Golden #7 reference and a
separate tiny 600-frame stability gate. WebGL2 must report `NACHI_GRID3D_WEBGL2_UNSUPPORTED`.

M12 NeighborGrid is an effect element consumed by exactly one emitter. It uses atomic u32 cell
counts plus fixed cell-major particle-index slots and rebuilds before each particle update.
`cellCapacity` defaults to 32; overflow drops later atomic reservations and is visible through
`getNeighborGrid().capture()`. Keep radius in integer cell units and account for the
`(2r+1)^3 * cellCapacity` scan. PBD iterations require clear/bucket/constraint submit separation;
the Jacobi snapshot is position/velocity only in v1. WebGL2 must report
`NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED`.

`@nachi/react` is lifecycle-only. `VFXSystemProvider` owns one core system and drives it with R3F
`useFrame`; `useEffectInstance()`/`VFXEffect` release the exact spawned handle on cleanup. Live
parameter props must be validated and forwarded by core before the binding records them. React,
R3F, and Three are peers, with Three fixed to 0.185.1 for this release.

Release metadata uses Changesets with independent package versions (`fixed`/`linked` are empty).
The release gate imports every built public export in plain Node ESM and runs `npm publish
--dry-run` for every public package. Do not replace `release:dry` with a real publish command.

## Three-layer verification

1. Headless Chromium with SwiftShader/lavapipe: deterministic compute/readback correctness and WebGL2 screenshots, not performance claims.
2. Windows-side real-GPU browser against the WSL dev server: visual validation, indirect draw execution, and GPU performance.
3. Physical mobile devices: 30 fps mobile budget and device-specific behavior (M11+).

## Headless WebGPU constraints

- Navigate to a real `http://localhost`/`127.0.0.1` URL; `about:blank`, `data:`, and direct files do not expose WebGPU reliably.
- Playwright must launch full Chromium with `channel: 'chromium'` and `--enable-unsafe-webgpu`; do not use the headless-shell binary.
- SwiftShader supports compute/readback here, but presenting a WebGPU canvas immediately destroys the device. Use offscreen/readback mode (`headless=1`) or force WebGL2 for screenshots.
- After many frames without readback, the first full-size readback can be empty; drain the offscreen readback path with a 1×1 read every frame before measured captures.
- Do not add browser-download postinstall hooks. The expected Chromium installation is managed outside the repository.
- Dev servers must stay bound to `0.0.0.0` so a Windows-side browser can reach the WSL server.
