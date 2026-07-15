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

## Coordinate-space selectors

Particle position and velocity are stored in world space. `velocityCone()` and `linearForce()`
accept `space: 'world' | 'emitter'` and default to `world`, preserving their v1 behavior. Select
`emitter` for a cone or thruster direction that rotates with the effect instance. `gravity()` is
always world-space.

```ts
velocityCone({ angle: 12, direction: [0, 1, 0], space: 'emitter', speed: 4 });
linearForce({ force: [0, 6, 0], space: 'emitter' });
gravity([0, -9.8, 0]);
```

`vortex()`, `pointAttractor()`, and the analytic `collidePlane()`/`collideSphere()`/`collideBox()`
selectors default to `emitter`; their explicit `world` option remains available. `killVolume()` is
fixed emitter-local. Moving emitter-space Update consumers sample one transform at exact phase
`0.5` between the preceding and current simulation endpoints (translation lerp plus shortest-path
quaternion slerp). This midpoint is a one-sample temporal approximation, not CCD, so use fixed
substeps when a thin volume must not be skipped.

NeighborGrid is the intentional exception: its emitter-local `origin` and all bucket/visitor cell
lookups use the current endpoint, while particle snapshots, velocities, and distances remain
world-space. Grid2D/Grid3D injection coordinates are normalized grid coordinates and their velocity
channels are measured in cells per second. The public emitter transform has no scale. See
[RFC 004](../../docs/rfc/004-module-spaces.md) for the exhaustive built-in table, unit rules, and
API-addition checklist.

The eight H2-6 helpers (`velocityCone`, `linearForce`, `vortex`, `pointAttractor`, the three analytic
colliders, and `killVolume`) emit module version 2. Module v1 remains executable with its old
world/current-endpoint meaning, and format round trips never upgrade it implicitly. An older core
without the v2 registrations rejects `type@2` with `NACHI_MODULE_UNKNOWN` instead of silently
misreading a selector.

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
