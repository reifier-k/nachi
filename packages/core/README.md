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

Debug attribute snapshots preserve backend compaction order by default. Pass
`{ order: 'physical-slot', offset, limit }` to sort the full alive membership before pagination when
you need pages independent of compaction order for the same physical membership; each row's
`aliveIndex` still identifies its original compact membership index. This is physical identity, not
persistent lineage, and does not promise identical slot allocation between backends. Only omission
or `undefined` selects the default order; `null` and other non-enum values are invalid. Capture
rejects a returned compaction row whose physical slot is outside capacity with
`NACHI_DEBUG_PHYSICAL_SLOT_OUT_OF_RANGE`; physical-slot order validates the full membership before
sorting and pagination.

## Simulation-cache format

Simulation caches use format version 2. This is a breaking cache-file boundary: every cached
emitter carries lossless u32 `spawnOrder` lineage for alive births (and the next spawn-order state
when that attribute is materialized), so interpolation and loop continuity cannot confuse a reused
physical slot with the particle that previously occupied it. Version-1 caches are not inferred or
migrated; re-bake them with the current runtime. Loading an old cache fails explicitly with
`NACHI_SIM_CACHE_VERSION_UNSUPPORTED`.

## Input validation

Built-in module factories reject malformed ordinary `ValueInput` constants, ranges, parameter
fallbacks, and curve values synchronously; direct/JSON module data runs the same checks at compile
time. Required ValueInput fields cannot be missing or `undefined`, while optional field omission
retains its documented default. Parameter generators require a string path even when their fallback
is omitted. Every scalar or vec3 field, including nested `positionSphere.arc.thetaMax`, validates
finite shape and the declared type of both `User.*` and materialized built-in parameters from the
shared uniform definition. `turbulence.octaves` is an integer from 1 through 4. Collision modes are
exactly `bounce`, `kill`, or `stick`; plane, sphere, box, and SDF collisions require one, while
scene-depth collision may omit it. A normalized-age reader without age+lifetime writers or an
explicit normalized-age writer receives `NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME`.

Spawn `position`/`rotation`, `instance.setTransform()`, and attachment transforms are checked before
uniform writes. Spawn may omit position, but live transforms and attachment samples require one.
Positions are finite vec3 values; rotations are finite Euler vec3 or quaternion vec4 values.
Invalid untyped JavaScript input never consumes an instance ID, replaces an attachment, or partially
changes the live transform. Each operation reads the position/rotation properties, tuple length and
components, or object `x/y/z` components once into an owned frozen snapshot. Validation, matrix
construction, and uniform writes use only that snapshot, so mutable accessors cannot pass validation
and then supply a different value during commit.

System spawn reads `timeScale` and `priority` once, validates those primitive snapshots before ID
allocation, and passes the same values to the instance clock and significance calculation. An
accessor cannot return a valid value for validation and a different value for construction; an
invalid first value does not consume an ID. Direct `VfxEffectInstance` construction still validates
its clock value through `EffectClock`.

Attachment sampling is guarded by an operation revision at both direct `attachTo()` and scheduled
update boundaries. If a transform getter reentrantly attaches again, detaches, releases, or attempts
an invalid attachment that it catches, that nested operation invalidates the outer sample. This also
applies when the nested attachment uses the same source object, so stale poses cannot overwrite the
newer operation. Runtime checks the revision both after the source getter and again after snapshotting
the returned transform, preserving quiet release/replacement while also catching reentry from
transform property or component accessors.

## Runtime diagnostic delivery

`VFXSystem` reports runtime failures and warnings when they occur. Omit `onRuntimeDiagnostic` for
one-line `console.error`/`console.warn` output, pass a function to replace that reporter, or pass
`null` to silence delivery. The diagnostic is still retained on its owning effect instance when
delivery is replaced or disabled.

```ts
const system = new VFXSystem(runtimeRenderer, scene, {
  onRuntimeDiagnostic: (diagnostic) => telemetry.record(diagnostic),
});

// Explicitly silent delivery; instance.state and instance.diagnostics still update.
const quietSystem = new VFXSystem(runtimeRenderer, scene, { onRuntimeDiagnostic: null });
```

The runtime path covers post-spawn GPU submission and attachment failures, device loss, preparation
failures, runtime camera/quality/capacity warnings, NeighborGrid warnings, and exact spawn/event
overflow when alive-count readback is enabled. Spawn-time compile, kernel-build, and resource
materialization failures remain on `onBuildDiagnostic`; this includes
`NACHI_RUNTIME_MATERIALIZATION_FAILED` despite its historical name. Runtime delivery does not add a
readback: with `aliveCountReadbackInterval` omitted, exact free-list and event overflow remain
unreported. Device loss is delivered once per system occurrence while every affected instance
stores it. A throwing replacement handler is contained, records
`NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED` on an owning instance, and is retried for later diagnostics.
An ownerless system source has no instance storage target, so its failure fallback is console-only
and limited to once per system. Build diagnostics remain exclusively owned by `onBuildDiagnostic`.

## Measured update deltas

`system.update()` without an argument measures elapsed wall time. The first omitted call advances
zero; later calls are capped at 0.25 seconds by default so a suspended tab or RAF does not send one
unbounded variable step into lifetime, spawning, or integration. Configure a positive
`maxMeasuredDeltaSeconds`, or pass `Infinity` to restore uncapped measurement. An explicit
`system.update(deltaSeconds)` is never capped and does not reset the measured clock.

The cumulative `measuredDeltaDroppedSeconds`, `fixedStepDroppedSeconds`, and `droppedSeconds`
getters expose the measured discard, the existing fixed-step backlog discard, and their sum. The
measured cap runs before fixed partitioning, so the components do not double-count. See
[RFC 001](../../docs/rfc/001-api.md) for queue ordering, mixed explicit/measured calls, and clock
validation. `fixedTimeStep.stepSeconds` must be strictly greater than `1e-10` seconds; `0`, `1e-12`,
and `1e-10` throw `RangeError: stepSeconds must be greater than 1e-10 seconds.` The product
`stepSeconds * maxSubSteps` must also remain finite or construction throws
`RangeError: stepSeconds * maxSubSteps must be a finite number.` Fixed accumulation computes retained
time from the finite remaining capacity, so adding a huge finite delta cannot turn the frame-local
drop or accumulator into `NaN`; only the cumulative drop may eventually overflow to `Infinity`.

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

## Transparent ordering

The current `billboard()`, `meshRenderer()`, and `decalRenderer()` helpers emit renderer module v2.
Alpha and premultiplied draws default to WebGPU particle sorting; use `sorted: false` for the faster,
explicitly unordered compact-alive path. Additive and multiply billboard/mesh draws default to
unsorted. Low/medium quality tiers gate sorting off, while high/epic retain it. Module-v1 definitions
keep their historical behavior.

`renderOrderOffset` is a signed-integer core bucket offset and `sortCenter` is an emitter-local point
for draw-level coarse ordering. `VFXSystem` ranks participating compiled draws far-to-near and sends
draw-index assignments to the renderer. A system accepts at most `2^20 - 1` automatic transparent
draw entries and rejects an overflowing spawn before retaining its resources. Version-2 decals also
capture the emitter's interpolated rotation at birth; authored Init rotation remains a later
world-space override. See [RFC 006](../../docs/rfc/006-transparent-draw-order.md) for exact v1/v2,
quality, camera, pooling, and numeric contracts.

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
