# @nachi/core

Renderer-independent authoring, compilation, scheduling, deterministic lifecycle, scalability,
simulation caches, debugging, and data interfaces for nachi VFX.

Install the Three.js runtime adapter with core to create a renderable system:

```sh
pnpm add @nachi/core @nachi/three three@0.185.1
# TypeScript projects also need Three's separately published declarations:
pnpm add -D @types/three@0.185.0
```

`@nachi/core` deliberately does not import Three.js. Use `createThreeKernelAdapter()` and
`createThreeRuntimeRenderer()` from `@nachi/three`, then materialize each spawned emitter's draw and
add it to your Three scene. See the repository
[Quick start](https://github.com/reifier-k/nachi#quick-start) and the
[`@nachi/three` README](https://github.com/reifier-k/nachi/tree/main/packages/three#readme) for a
complete rendering example.

The public authoring surface includes emitter/effect definitions, built-in Init/Update/Render
modules, typed `User.*` parameters, `VFXSystem`, JSON-compatible registries, fixed-step execution,
quality and significance controls, simulation bake/replay, debug snapshots, Grid2D/Grid3D, neighbor
grids, boids, and PBD constraints. Backend capability failures are explicit diagnostics; core does
not silently replace WebGPU behavior with CPU simulation.
