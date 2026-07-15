# RFC 004: Module coordinate spaces

> Language: English (this page) / [日本語](./004-module-spaces.ja.md)

- **Status:** Implemented through H2-6 on 2026-07-15
- **Scope:** `@nachi-vfx/core` emitter modules, grid modules, and `@nachi-vfx/format`
  compatibility normalization
- **Normative references:** [RFC 001](./001-api.md) §§4.3, 6.1, 9, 10.7;
  [RFC 003](./003-versioning.md) §§2-4
- **Decision dates:** H1-5 on 2026-07-13; H2-6 extension on 2026-07-14

## 1. Inventory and global rules

This inventory is checked against every public built-in helper in `packages/core/src/api.ts`,
`grid2d.ts`, and `grid3d.ts`, and against its consumers in the compiler, scheduler, and Three
materializers. A row remains present and says **N/A** when a module has no coordinate-bearing input;
this makes the table a completeness checklist rather than a list of only the interesting cases.
Compiler-owned modules are recorded separately after the public stages.

Particle `position` and `velocity` storage is world-space. Public emitter transforms contain
translation and rotation only: there is no public emitter scale. A local radius, length, or offset
therefore has the same magnitude in world units. Adding scale requires a new RFC because it would
change distance, normal, collision-response, grid, and interpolation rules.

“Spawn transform” below means `Emitter.spawnInterpolatedTransform`, whose per-birth phase is
specified by RFC 001 §9. “Update midpoint” means the single H2-6 sample specified in §3. “Current”
means the un-interpolated composed `Emitter.transform` at the current simulation endpoint.

## 2. Exhaustive built-in inventory

### 2.1 Spawn and Init

| Stage | API | Coordinate or unit contract | Selector and omitted default | Transform sample |
| --- | --- | --- | --- | --- |
| Spawn | `burst` | N/A; `count` is particles | N/A | N/A |
| Spawn | `rate` | N/A spatially; particles per emitter-local second | N/A | N/A |
| Spawn | `perDistance` | Particles per **world-space unit** travelled by the composed emitter transform; one previous-to-current straight chord per simulation step | N/A | Previous and current endpoints for distance; births use the spawn transform |
| Init | `positionSphere` | `center`, `radius`, and `arc.axis` are emitter-local; output position is world-space | Fixed emitter-local | Spawn transform |
| Init | `positionMeshSurface` | Source vertices/normals are mesh-local in the emitter frame; output position and retained normal are world-space | Fixed mesh/emitter-local | Spawn transform |
| Init | `velocityCone` | `direction` is interpreted in the selected frame; stored velocity is world-space | `world` / `emitter`; **default `world`** | Emitter selection uses the same spawn transform as that birth, direction form (`w = 0`); world selection reads no transform |
| Init | `velocityMeshNormal` | Consumes the world-space normal produced by `positionMeshSurface`; stored velocity is world-space | Fixed world-space | N/A |
| Init | `lifetime` | N/A | N/A | N/A |
| Init | `lightIntensity` | N/A | N/A | N/A |

### 2.2 Update

| API | Coordinate or unit contract | Selector and omitted default | Emitter transform sample |
| --- | --- | --- | --- |
| `gravity` | World-space acceleration; scalar form uses the fixed world gravity axis | Fixed world-space; no selector | N/A |
| `drag` | Scalar damping of stored world-space velocity | N/A; rotationally invariant | N/A |
| `boids` | Neighbor positions/velocities and measured distances are world-space; traversal `radius` is an integer cubic cell radius, while `separationRadius` is multiplied by `cellSize` to obtain a world threshold; grid `origin` is emitter-local | Fixed mixed NeighborGrid contract | **Current**, never midpoint |
| `pbdDistanceConstraint` | Bucket snapshots and `distance` are world-space; optional traversal `radius` is an integer cubic cell radius; lookup volume origin is emitter-local | Fixed mixed NeighborGrid contract | **Current**, never midpoint |
| `neighborGridTslModule` | Custom neighbor snapshots/measured distances are world-space; traversal `radius` is an integer cubic cell radius; lookup volume origin is emitter-local | Fixed mixed NeighborGrid contract | **Current**, never midpoint |
| `curlNoise` | Samples the world-space particle position; frequency is inverse world length | Fixed world-space | N/A |
| `vortex` | `center` and `axis` use the selected frame; acceleration is returned to world-space | `world` / `emitter`; default `emitter` | Update midpoint only for `emitter` |
| `pointAttractor` | `position`, radius, and attenuation distance use the selected frame; acceleration is returned to world-space | `world` / `emitter`; default `emitter` | Update midpoint only for `emitter` |
| `linearForce` | Acceleration vector uses the selected frame; stored velocity is world-space | `world` / `emitter`; **default `world`** | Update midpoint, direction form (`w = 0`), only for `emitter` |
| `turbulence` | Samples world-space particle position; frequency is inverse world length | Fixed world-space | N/A |
| `vectorField` | Field bounds, sample position, and sampled vector are field/world coordinates | Fixed field/world-space | N/A |
| `collidePlane` | `normal` and `offset` use the selected frame; local `offset` is a world-length magnitude | `world` / `emitter`; default `emitter` | Update midpoint only for `emitter` |
| `collideSphere` | `center` and `radius` use the selected frame; local radius is a world-length magnitude | `world` / `emitter`; default `emitter` | Update midpoint only for `emitter` |
| `collideBox` | `center` and `size` use the selected frame; local extents are world-length magnitudes | `world` / `emitter`; default `emitter` | Update midpoint only for `emitter` |
| `collideSceneDepth` | World position -> view/clip/screen depth pipeline; `surfaceOffset` is world length and `thickness` is linear view depth | Fixed world/camera-space | N/A |
| `collideSdf` | SDF bounds, samples, gradients, thickness, and response are field/world coordinates | Fixed field/world-space | N/A |
| `orientToVelocity` | Reads world-space velocity and writes particle orientation | Fixed world-space velocity | N/A |
| `sizeOverLife` | N/A spatially; normalized lifetime curve | N/A | N/A |
| `intensityOverLife` | N/A spatially; normalized lifetime curve | N/A | N/A |
| `rotationOverLife` | N/A spatially; sprite-plane angle | N/A | N/A |
| `velocityOverLife` | Scalar multiplier of stored world-space velocity | N/A; rotationally invariant | N/A |
| `killVolume` | `center`, `normal`, `offset`, radius, and size are emitter-local; dimensions remain world-length magnitudes | Fixed emitter-local | Update midpoint |
| `colorOverLife` | N/A | N/A | N/A |

For analytic emitter-space collision response, the inverse transform used to evaluate the particle
and the forward transform used to return corrected position, normal-relative velocity, and force
to world-space MUST be the exact same sampled transform expression. Implementations MUST NOT sample
the two directions independently.

### 2.3 Event and Render

| Stage | API | Coordinate or unit contract | Selector / transform |
| --- | --- | --- | --- |
| Event | `emitTo` | Inherited `position` and `velocity` are world-space particle snapshots; other inherited attributes are N/A unless their schema defines a frame | Fixed world snapshot / N/A |
| Render | `billboard` | Particle position/velocity are world-space; `custom-axis.axis` is a world direction; `sortCenter` is emitter-local; soft fade distance is normalized camera depth, not world length | Fixed contracts; coarse sort uses current emitter transform |
| Render | `faceCamera` | Alias of camera-facing `billboard`; particle position is world-space | Fixed world/camera-space |
| Render | `meshRenderer` | Particle position/velocity are world-space; `custom-axis.axis` is a world direction; `sortCenter` is emitter-local | Fixed contracts; coarse sort uses current emitter transform |
| Render | `lightRenderer` | Particle position is world-space; `Particles.size * radiusScale` is a world-space light distance | Fixed world-space |
| Render | `decalRenderer` | Particle position/rotation define a world-space projection box sampled against scene depth | Fixed world/depth-space |
| Render data | `flipbook` | N/A spatially; atlas UV/frame data | N/A |

### 2.4 Grid2D, Grid3D, and NeighborGrid

| API | Coordinate and unit contract | Emitter transform |
| --- | --- | --- |
| `defineGrid2D`, `defineGrid3D`, `defineSimStage` | Grid index/cell space is independent of emitter transforms | None |
| `gridInject`, `grid3DInject` | `center` and `radius` are normalized `[0, 1]` Grid2D/volume coordinates, independent of resolution and emitter frames; values are additions per second | None |
| `gridAdvect`, `grid3DAdvect` | Backtrace and sampling use cell space; velocity channels are **grid cells per second**; dissipation is inverse seconds | None |
| `gridBuoyancy`, `grid3DBuoyancy` | Writes the velocity channel in grid cells per second; the buoyancy axis is grid +Y | None |
| `gridPressureJacobi`, `grid3DPressureJacobi` | Neighbor samples and pressure differences use cell space | None |
| `gridProjectVelocity`, `grid3DProjectVelocity` | Velocity channels and pressure gradients use cell space; velocity remains grid cells per second | None |
| `gridTslModule`, `grid3DTslModule` | `context.cell` and `sample(..., cell)` are cell coordinates; custom channel units are author-defined | None |
| `defineNeighborGrid` | `origin` is the emitter-local minimum corner; `cellSize` is a world-length magnitude; `resolution * cellSize` defines the local volume | **Current** composed emitter transform |
| `boids`, `pbdDistanceConstraint`, `neighborGridTslModule` | Bucket-time/live positions and measured distances are world-space. Traversal `radius` is an integer cubic cell radius; boids `separationRadius` is in `cellSize` units and becomes a world threshold after multiplication; PBD `distance` alone is authored directly in world units. Only cell lookup maps through the current emitter frame | **Current** for bucket insertion and every visitor lookup |

NeighborGrid intentionally does not use the Update midpoint. Its rebuild and all consumers form one
current-endpoint data interface. Mixing midpoint bucket insertion with current lookup, or vice
versa, would produce incoherent cells.

### 2.5 Compiler-owned modules and custom modules

| Module | Contract |
| --- | --- |
| `$defaults` (Init) | N/A; initializes declared particle attributes |
| `$age` (Update) | N/A; lifetime bookkeeping |
| `$integrate` (Update) | Integrates stored world-space velocity into world-space position |
| `tslModule` / registered modules | The access manifest and module documentation MUST declare the frame of every coordinate-bearing custom input/output |

## 3. H2-6 selector and Update midpoint decision

H1-5 changed the omitted default to `emitter` for `vortex`, `pointAttractor`, `collidePlane`,
`collideSphere`, and `collideBox`. H2-6 adds selectors to `velocityCone` and `linearForce`, but their
omitted default is deliberately **`world`** to preserve their v1 behavior and generated shader.
`gravity` remains world-only. Therefore there is no longer a valid global rule that every omitted
selector means emitter-space; the module-specific defaults in §2 are normative.

H2-6 behavior belongs to module **version 2** for `velocityCone`, `linearForce`, `vortex`,
`pointAttractor`, the three analytic colliders, and `killVolume`. Their module-v1 implementations
remain registered with pre-H2-6 meaning: cone/linear selectors are ignored as world-space, and the
existing emitter-space Update consumers sample the current endpoint. This version boundary is
required by RFC 003 §4 because a pre-H2-6 reader accepted unknown config fields and could otherwise
silently execute a new emitter selector as world-space.

Every Update-stage built-in that follows an emitter-space force, analytic collider, or kill volume
uses one compiler-provided `Emitter.updateInterpolatedTransform` sample at exact phase `0.5`:

- translation is `lerp(previousTranslation, currentTranslation, 0.5)`;
- rotation is shortest-path quaternion slerp at `0.5`;
- scale is absent and is not interpolated;
- exact stationary previous/current transforms take the direct current-transform branch, preserving
  the prior output bits;
- the expression is cached once per update kernel graph and shared by all consumers.

This is a **one-sample temporal integration approximation**. It is not continuous collision
detection (CCD), a swept-volume intersection, multi-point quadrature, or substep synthesis. A thin
volume can still be crossed between previous, midpoint, and current without being observed.
Applications that require stronger guarantees must use fixed substeps or a future explicit CCD
feature.

## 4. History lifecycle

`previousTransform`, `transform`, and `interpolationActive` describe consecutive simulated
endpoints, not arbitrary presentation calls. Construction, the first pre-initialization attachment
sync, a pre-initialization `setTransform`, pool checkout, restart/reset, and direct prewarm entry set
previous equal to current and interpolation inactive. Each consumed system step commits current to
previous after scheduling, including fixed-time substeps, culled instances, and hit-stop steps that
consume movement without advancing particle time. Resuming therefore cannot reuse a stale endpoint.
Error/release paths do not return a poisoned live history to the pool.

Quality and significance changes that only update live parameters do not reconstruct or reset the
emitter. A future path that reconstructs runtime emitter state MUST explicitly choose and test its
history reset rule.

## 5. Migration and serialized assets

Existing `nachi-effect` envelope-version-1 documents and module-version-1 records retain their
historical meaning:

1. Module-v1 `velocityCone` and `linearForce` are unconditionally normalized/executed as `world`,
   even if an old generic writer included `space: 'emitter'`; old readers ignored that field.
2. Module-v1 explicit emitter selectors on the five H1 modules remain valid and sample the current
   endpoint. Omitted selectors in pre-H1 legacy input normalize to explicit `world`.
3. Module-v1 `killVolume` remains emitter-local at the current endpoint.
4. Current authoring helpers emit module version 2 and materialize defaults explicitly: `emitter`
   for the five H1 modules and `world` for `velocityCone` and `linearForce`.
5. Re-serialization preserves the module version, is canonical and explicit, and never mutates the
   input. Loading v1 does not silently upgrade it to v2.

The asset envelope stays version 1 because module records carry their own version. A pre-H2-6 reader
has only the `type@1` registry entry and therefore safely rejects a newly authored `type@2` with
`NACHI_MODULE_UNKNOWN`; it cannot silently reinterpret the selector. Code-first definitions that
want local cone or thruster direction opt into `space: 'emitter'` on the v2 helper.

## 6. Checklist for a new or changed public API

Every proposal that adds a built-in, coordinate-bearing field, transform consumer, or grid channel
MUST update both languages of this RFC and answer all of the following:

1. What frame and unit does every position, direction, normal, distance, velocity, and frequency use?
2. Is the frame fixed or selectable? If selectable, what is the explicit omitted default and legacy
   asset normalization?
3. Is particle storage world-space, emitter-local, camera/view, field, normalized-grid, or cell
   space at that boundary?
4. Does the consumer use per-birth spawn interpolation, Update midpoint, current transform, or no
   emitter transform? Why?
5. Are inverse and forward conversions derived from one shared transform expression?
6. Does emitter rotation affect the input? Does translation use direction form (`w = 0`) where
   required? What happens if scale is introduced later?
7. Which CPU reference, compiler graph, real GPU readback, stationary-bit, serialization, WebGL2
   materialization/rejection, and fault-injection tests discriminate the contract?
8. Which construction, reset, pool, attachment, fixed-step, prewarm, pause/hit-stop, culling,
   quality/restart, error, and release history paths are affected?

## 7. SemVer and verification record

H2-6 is a **minor** change to `@nachi-vfx/core`: the two selectors are additive, while moving
emitter-space Update consumers intentionally change their sampled frame. `@nachi-vfx/format` also
receives a **minor** change for strict validation, compatibility normalization, and canonical
output. RFC 003 represents these changes with minor changesets on the experimental 0.x line.

Required regression coverage is:

- omitted and explicit `world` `velocityCone`/`linearForce` produce the exact pre-H2-6 WGSL hashes;
- explicit emitter selectors rotate on real GPU execution;
- moving collider, kill-volume, and force fixtures compare one step with four substeps against a CPU
  reference, while every affected stationary module matches a fixed pre-H2-6 GPU hash;
- an actual NeighborGrid GPU bucket plus visitor fixture distinguishes current from midpoint;
- format load, compile, reload, and serialize preserve inputs and canonical explicit defaults;
- raw module-v1 moving GPU fixtures reproduce the old endpoint results, while a version-1-only
  registry safely rejects module v2;
- transform-history lifecycle paths and performance v2 median/p95 are recorded in plan 022.
