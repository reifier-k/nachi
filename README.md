# nachi

> Language: English (this page) / [日本語](./README.ja.md)

> [!WARNING]
> **HEAVY EXPERIMENTAL — v0.1.0 is not production-ready.** APIs, behavior, performance,
> compatibility, and package boundaries may change significantly between releases.

Code-first, TSL/WebGPU-native VFX for Three.js, designed around Niagara's staged simulation model.
Nachi v0.1.0 is an experimental preview; M12 includes JSON assets, advanced simulation, React Three
Fiber bindings, release automation, and a buildable documentation gallery.

## Packages

| Package           | Purpose                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@nachi/core`     | Definitions, particle modules, compiler, GPU scheduler, scalability, sim cache, debugger, Grid2D/3D, and neighbor grids |
| `@nachi/three`    | Three.js WebGPU kernel/runtime adapter, resource resolvers, and particle draw materializers                             |
| `@nachi/format`   | Strict `nachi-effect` v1 JSON schema, serializer/loader, migrations, and asset inheritance                              |
| `@nachi/react`    | Thin R3F provider, hook, component lifecycle, and `Object3D` attachment                                                 |
| `@nachi/timeline` | Effect-local sequencing, camera shake, hit stop, markers, and mesh-fx lifecycle                                         |
| `@nachi/trails`   | GPU ribbons and trails                                                                                                  |
| `@nachi/mesh-fx`  | Procedural effect geometry, `fxMaterial`, and Blender VAT playback                                                      |
| `@nachi/post`     | RenderPipeline distortion, radial blur, bloom presets, and WebGPU WBOIT                                                 |
| `@nachi/tsl-kit`  | Standalone Three.js TSL shader building blocks                                                                          |

The repository also contains the Vite [playground](./apps/playground) and static
[documentation site](./apps/docs).

## Contributions

Bug reports, feature requests, and detailed use-case feedback are welcome through GitHub Issues.
External pull requests are not accepted; accepted changes are implemented and reviewed by the
maintainers, with opt-in co-author credit for substantive issue contributions. See
[CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately according to
[SECURITY.md](./SECURITY.md).

## Install

Core Three.js usage:

```sh
pnpm add @nachi/core @nachi/three three@0.185.1
```

React Three Fiber usage keeps React, R3F, and Three as peers:

```sh
pnpm add @nachi/core @nachi/three @nachi/react react@^19 @react-three/fiber@^9 three@0.185.1
```

Packages that expose Three.js types (`@nachi/three`, `@nachi/tsl-kit`, `@nachi/mesh-fx`, `@nachi/trails`,
`@nachi/timeline`, `@nachi/post`, and `@nachi/react`) also expect the separately published matching
declarations in TypeScript projects:

```sh
pnpm add -D @types/three@0.185.0
```

`three@0.185.1` is the supported and tested runtime. Do not deduplicate these integrations onto a
different Three minor version.

`VFXSystemProvider` synchronizes the active R3F camera and pixel viewport with core before each
update by default. Pass `syncCamera={false}` only when the application calls `system.setCamera()`
itself.

## Quick start

```ts
import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  drag,
  gravity,
  lifetime,
  positionSphere,
} from '@nachi/core';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1, 5);

const kernelAdapter = createThreeKernelAdapter({ backend: 'webgpu' });
const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter);

const sparks = defineEmitter({
  capacity: 512,
  spawn: burst({ count: 120 }),
  init: [positionSphere({ radius: 0.2 }), lifetime(0.8)],
  update: [gravity(-9.8), drag(0.35)],
  render: billboard({ blending: 'additive' }),
});

const effect = defineEffect({ elements: { sparks } });
const system = new VFXSystem(runtimeRenderer, scene);
const instance = system.spawn(effect, { position: [0, 1, 0], seed: 42 });
const emitter = instance.getEmitter('sparks');
if (!emitter) throw new Error('The sparks emitter was not created.');

const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
scene.add(draw);

let previousTime = performance.now();
async function frame(time: number) {
  const deltaSeconds = Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;
  await system.update(deltaSeconds);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// When the effect is no longer needed:
// scene.remove(draw); instance.release(); draw.geometry.dispose(); draw.material.dispose();
```

In R3F, create the same adapter once and let the binding own instance cleanup. The complete
materialization example is in [`@nachi/react`](./packages/react/README.md).

`useEffectInstance()` is the hook form. Live `parameters`, transform, time scale, and attachment are
forwarded to core; changing seed or priority creates a fresh instance. Keep `definition` at module
scope (or otherwise referentially stable), because changing its reference respawns the instance.
`attachTo` owns the complete live transform and overwrites spawn/prop position and rotation on each
scheduled step.

## Assets and advanced simulation

```ts
import { loadEffect, serializeEffect } from '@nachi/format';

const document = serializeEffect(effect);
const loaded = loadEffect(JSON.stringify(document));
```

Only the declarative subset is serializable. Inline callbacks, functions, live Three.js resources,
class instances, and cycles fail with path-specific `NACHI_ASSET_*` diagnostics. Grid2D/3D stages,
neighbor-grid declarations, built-in fluid stages, boids, and PBD constraints are part of the v1
declarative model; inline custom grid/neighbor TSL remains code-only.

Simulation caches use `bakeSimulation()` and `replaySimulation()`. Runtime debugging uses
`instance.debug.captureAttributes()` and `system.debug.captureProfile()`.

Three draw objects are lifetime-bound to their emitter kernels. Reuse an existing materialized mesh
or dispose/unmaterialize it before replacement; releasing an instance cleans registered draws before
its kernels enter the pool, and a respawn must attach the newly materialized draw.

## Development and release checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
pnpm docs:build
pnpm esm-all
pnpm release:dry  # build + every package ESM import gate + publish-shaped pnpm pack checks
pnpm golden:regress  # with the playground dev server running; headless SwiftShader golden suite
node tools/bundle-size.mjs
node tools/license-report.mjs
```

Biome is the workspace linter and formatter for JavaScript, TypeScript, JSON, CSS, and HTML.
Markdown and YAML are not automatically formatted.

Changesets are independently versioned: run `pnpm changeset`, then `pnpm version-packages` when a
release versioning pass is intended. `release:dry` never publishes.

Design and status: [PLAN.md](./PLAN.md), [ROADMAP.md](./ROADMAP.md), normative
[API RFC](./docs/rfc/001-api.md), and the
[Effekseer compatibility study](./docs/rfc/002-effekseer-compatibility.md). Release compatibility is
defined by [RFC 003](./docs/rfc/003-versioning.md); FA evidence is summarized by the
[parity](./docs/parity-report.md), [bundle](./docs/bundle-report.md), and
[license](./docs/license-report.md) reports.
