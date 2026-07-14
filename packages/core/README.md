# @nachi-vfx/core

Renderer-independent authoring, compilation, scheduling, deterministic lifecycle, scalability,
simulation caches, debugging, and data interfaces for nachi VFX.

Install the Three.js runtime adapter with core to create a renderable system:

```sh
pnpm add @nachi-vfx/core @nachi-vfx/three three@0.185.1
# TypeScript projects also need Three's separately published declarations:
pnpm add -D @types/three@0.185.0
```

`@nachi-vfx/core` deliberately does not import Three.js. Use `createThreeKernelAdapter()` and
`createThreeRuntimeRenderer()` from `@nachi-vfx/three`, then materialize each spawned emitter's draw and
add it to your Three scene. See the repository
[Quick start](https://github.com/reifier-k/nachi#quick-start) and the
[`@nachi-vfx/three` README](https://github.com/reifier-k/nachi/tree/main/packages/three#readme) for a
complete rendering example.

The public authoring surface includes emitter/effect definitions, built-in Init/Update/Render
modules, typed `User.*` parameters, `VFXSystem`, JSON-compatible registries, fixed-step execution,
quality and significance controls, simulation bake/replay, debug snapshots, Grid2D/Grid3D, neighbor
grids, boids, and PBD constraints. Backend capability failures are explicit diagnostics; core does
not silently replace WebGPU behavior with CPU simulation.

## Resource preparation

`await system.prepare(effect, { signal, onProgress, preparer })` compiles the current quality
tier's emitter and grid pipelines without advancing `system.time` or publishing an effect
instance. Work scales with authored resources, not lifecycle or timeline duration. Successful
emitter and grid resources enter the normal effect pool, so call `prepare()` before the first
`spawn()` when the backend needs the exact prepared node objects. Preparation requires
`maxPoolSize > 0`; it rejects explicitly when pooling is disabled. One call reserves one sequential
first-use bundle—it does not reserve additional copies for overlapping instances. `preparer` is an
optional renderer hook; without it, core prepares compute resources only. Abort and backend
failures reject the promise, roll renderer hooks back, and release partial resources.
