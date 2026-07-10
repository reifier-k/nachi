# Development guide

This monorepo is building a Niagara-parity VFX library around Three Shading Language (TSL), with WebGPU-native simulation/rendering and an explicit WebGL2 fallback. Read [PLAN.md](./PLAN.md) for the design principles and north-star API, then [ROADMAP.md](./ROADMAP.md) for milestones and the parity matrix.

## Repository layout

- `packages/core`: public `@nachi/core` API types and future compiler/runtime.
- `apps/playground`: Vite/TypeScript playground plus compute and depth spikes.
- `tools`: Playwright-based WebGPU probes, spike collection, and screenshots.
- `docs/rfc`: normative design RFCs; keep implementation and RFC terminology aligned.

## Commands

```sh
pnpm dev        # Vite on 0.0.0.0:5173 (required before browser tools)
pnpm test       # Vitest
pnpm typecheck  # all workspace TypeScript projects
pnpm lint       # ESLint flat config
pnpm build      # all workspace builds
```

Tooling (run `pnpm dev` first unless noted):

```sh
node tools/webgpu-probe.mjs [--adapter swiftshader|vulkan|default]
node tools/spike-runner.mjs [http://127.0.0.1:5173/spike-compute/?backend=webgpu]
node tools/spike-runner.mjs http://127.0.0.1:5173/spike-depth/?backend=webgpu
node tools/screenshot.mjs [url] [output.png] [--backend webgl|webgpu]
node tools/screenshot.mjs http://127.0.0.1:5173/spike-depth/ artifacts/depth.png --backend webgl --compare-depth-fade
```

`webgpu-probe` serves its own localhost page. `spike-runner` adds `headless=1` and reads `data-spike-result` plus the `nachi.perf-baseline` record in `data-perf-result`. Screenshot regression defaults to WebGL2 because headless WebGPU cannot present a canvas.

## Three-layer verification

1. Headless Chromium with SwiftShader/lavapipe: deterministic compute/readback correctness and WebGL2 screenshots, not performance claims.
2. Windows-side real-GPU browser against the WSL dev server: visual validation, indirect draw execution, and GPU performance.
3. Physical mobile devices: 30 fps mobile budget and device-specific behavior (M11+).

## Headless WebGPU constraints

- Navigate to a real `http://localhost`/`127.0.0.1` URL; `about:blank`, `data:`, and direct files do not expose WebGPU reliably.
- Playwright must launch full Chromium with `channel: 'chromium'` and `--enable-unsafe-webgpu`; do not use the headless-shell binary.
- SwiftShader supports compute/readback here, but presenting a WebGPU canvas immediately destroys the device. Use offscreen/readback mode (`headless=1`) or force WebGL2 for screenshots.
- Do not add browser-download postinstall hooks. The expected Chromium installation is managed outside the repository.
- Dev servers must stay bound to `0.0.0.0` so a Windows-side browser can reach the WSL server.
