# nachi

Code-first, TSL/WebGPU-native VFX for Three.js, designed around Niagara's staged simulation model.
Nachi is pre-1.0; M12 now includes JSON assets, advanced simulation, React Three Fiber bindings,
release automation, and a buildable documentation gallery.

## Packages

| Package           | Purpose                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@nachi/core`     | Definitions, particle modules, compiler, GPU scheduler, scalability, sim cache, debugger, Grid2D/3D, and neighbor grids |
| `@nachi/format`   | Strict `nachi-effect` v1 JSON schema, serializer/loader, migrations, and asset inheritance                              |
| `@nachi/react`    | Thin R3F provider, hook, component lifecycle, and `Object3D` attachment                                                 |
| `@nachi/timeline` | Effect-local sequencing, camera shake, hit stop, markers, and mesh-fx lifecycle                                         |
| `@nachi/trails`   | GPU ribbons and trails                                                                                                  |
| `@nachi/mesh-fx`  | Procedural effect geometry, `fxMaterial`, and Blender VAT playback                                                      |
| `@nachi/post`     | RenderPipeline distortion, radial blur, bloom presets, and WebGPU WBOIT                                                 |
| `@nachi/tsl-kit`  | Standalone Three.js TSL shader building blocks                                                                          |

The repository also contains the Vite [playground](./apps/playground) and static
[documentation site](./apps/docs).

## Install

Core Three.js usage:

```sh
pnpm add @nachi/core three@0.185.1
```

React Three Fiber usage keeps React, R3F, and Three as peers:

```sh
pnpm add @nachi/core @nachi/react react @react-three/fiber three@0.185.1
```

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

const sparks = defineEmitter({
  capacity: 512,
  spawn: burst({ count: 120 }),
  init: [positionSphere({ radius: 0.2 }), lifetime(0.8)],
  update: [gravity(-9.8), drag(0.35)],
  render: billboard({ blending: 'additive' }),
});

const effect = defineEffect({ elements: { sparks } });
const system = new VFXSystem(runtimeRenderer);
const instance = system.spawn(effect, { position: [0, 1, 0], seed: 42 });

await system.update(deltaSeconds);
instance.release();
```

In R3F, mount the runtime adapter once and let the binding own instance cleanup:

```tsx
<Canvas>
  <VFXSystemProvider renderer={runtimeRenderer}>
    <VFXEffect definition={effect} attachTo={weaponSocket} />
  </VFXSystemProvider>
</Canvas>
```

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

## Development and release checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm prettier
pnpm build
pnpm docs:build
pnpm release:dry  # build + every package ESM import gate + npm publish --dry-run
```

Changesets are independently versioned: run `pnpm changeset`, then `pnpm version-packages` when a
release versioning pass is intended. `release:dry` never publishes.

Design and status: [PLAN.md](./PLAN.md), [ROADMAP.md](./ROADMAP.md), normative
[API RFC](./docs/rfc/001-api.md), and the
[Effekseer compatibility study](./docs/rfc/002-effekseer-compatibility.md).
