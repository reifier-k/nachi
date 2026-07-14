# RFC 004: Module coordinate spaces

> Language: English (this page) / [日本語](./004-module-spaces.ja.md)

- **Status:** Implemented in H1-5 on 2026-07-14
- **Scope:** `@nachi-vfx/core` emitter modules and `@nachi-vfx/format` compatibility normalization
- **Normative references:** [RFC 001](./001-api.md) §§4.3, 9; [RFC 003](./003-versioning.md) §§2-4
- **Decision date:** 2026-07-13

## 1. Inventory method

This inventory was extracted from the implementation rather than from helper names alone. The
review enumerated `position`, `center`, `axis`, `normal`, `direction`, `origin`, and field-bound
inputs in `packages/core/src/types.ts`, `grid2d.ts`, and `grid3d.ts`, then checked every consumer in
`packages/core/src/compiler.ts`, `system.ts`, and the Three renderer materializers. Rows with no
author-facing coordinate are retained when they implicitly consume world-space particle position
(`collideSdf`, light, decal, and scene depth), because those fixed frames constrain the decision.

## 2. Current space inventory (before H1-5)

“Fixed” means there is no `space` selector and therefore no omitted-selector default to change.
Particle position and velocity storage is world-space throughout the simulation.

| API / module                                  | Spatial input or consumer                                | Current space when omitted                                                    | `space` selectable?      | H1-5 default impact                             |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `EmitterConfig.offset`                        | emitter element origin translation                       | emitter-local, fixed; composed as `instanceTransform * translate(offset)`     | No                       | None (added in H1-4)                            |
| `EmitterBounds.center`                        | conservative culling/significance sphere center          | emitter-local, fixed                                                          | No                       | None                                            |
| `positionSphere`                              | `center`, `arc.axis`, surface cap / spherical sector     | emitter-local, fixed; result is transformed once to world                     | No                       | None (center/arc added in H1-4)                 |
| `positionMeshSurface`                         | mesh vertices and sampled normal                         | mesh/emitter-local, fixed; transformed once to world                          | No                       | None                                            |
| `velocityCone`                                | `direction`                                              | world-space direction, fixed                                                  | No                       | None; a future selector is separate work        |
| `vortex`                                      | `center`, `axis`                                         | **world**                                                                     | Yes: `world` / `emitter` | **Change omitted default to `emitter`**         |
| `pointAttractor`                              | `position` (and its distance/radius evaluation)          | **world**                                                                     | Yes: `world` / `emitter` | **Change omitted default to `emitter`**         |
| `turbulence`, `curlNoise`                     | implicit procedural-field sample position                | world-space particle position, fixed                                          | No                       | None; a future selector is separate work        |
| `vectorField`                                 | field bounds and implicit sample position                | field/world coordinates, fixed                                                | No                       | None; a future field transform is separate work |
| `collidePlane`                                | `normal`, `offset`                                       | **world**                                                                     | Yes: `world` / `emitter` | **Change omitted default to `emitter`**         |
| `collideSphere`                               | `center`, `radius`                                       | **world**                                                                     | Yes: `world` / `emitter` | **Change omitted default to `emitter`**         |
| `collideBox`                                  | `center`, `size`                                         | **world**                                                                     | Yes: `world` / `emitter` | **Change omitted default to `emitter`**         |
| `collideSceneDepth`                           | particle position, camera matrices, copied depth         | world/view/screen pipeline, fixed                                             | No                       | None; intrinsically camera/world-bound          |
| `collideSdf`                                  | SDF bounds and implicit sample position                  | field/world coordinates, fixed                                                | No                       | None; a future field transform is separate work |
| `killVolume`                                  | `center`; plane `normal`, `offset`; shape dimensions     | emitter-local, fixed                                                          | No                       | None                                            |
| `billboard` custom-axis alignment             | `alignment.axis`                                         | world-space direction, fixed (converted to view space)                        | No                       | None                                            |
| `billboard.sortCenter`                        | coarse transparency-sort center                          | emitter-local, fixed                                                          | No                       | None                                            |
| `meshRenderer` custom-axis alignment          | `alignment.axis`                                         | world-space direction, fixed                                                  | No                       | None                                            |
| `meshRenderer.sortCenter`                     | coarse transparency-sort center                          | emitter-local, fixed                                                          | No                       | None                                            |
| `lightRenderer`                               | implicit `Particles.position`                            | world-space particle position, fixed                                          | No                       | None                                            |
| `decalRenderer`                               | implicit `Particles.position` / rotation and scene depth | world-space projection box, fixed                                             | No                       | None; intrinsically world/depth-bound           |
| `emitTo(..., { inherit: ['position', ...] })` | event payload position/velocity                          | world-space particle snapshot, fixed                                          | No                       | None                                            |
| `NeighborGrid` / `boids` / PBD                | grid `origin`, particle positions                        | world-space grid, fixed                                                       | No                       | None                                            |
| `gridInject`, `grid3DInject`                  | `center`                                                 | normalized Grid2D/Grid3D coordinates, fixed and independent of emitter frames | No                       | None                                            |

## 3. Problem

The current authoring rule cannot be predicted from a coordinate-bearing field name. A
`positionSphere` center and `killVolume` follow an instance, while an omitted-space
`pointAttractor`, `vortex`, or analytic collider remains at a world coordinate. Moving an effect
instance can therefore separate its particles from its force or collider without any type error.
The existing `space: 'emitter'` path already has the desired transform semantics, including
translation and rotation through `Emitter.transform`; the problem is its inconsistent default and
the lack of one inventory.

Fixed world-bound consumers are a different category. Scene depth and decals necessarily operate
against world/camera data; SDF and vector-field resources currently define their own world-aligned
bounds. This RFC does not pretend those fixed frames are omitted defaults, and H1-5 MUST NOT
silently reinterpret them.

## 4. Decision

For every module that exposes `space: 'world' | 'emitter'`, omission SHALL mean `emitter`.
Emitter-local fixed modules already conform to this authoring rule. Intrinsically world/camera/grid
consumers and modules without a selector retain the fixed spaces in the table.

H1-5 changes the omitted default for exactly:

- `vortex`
- `pointAttractor`
- `collidePlane`
- `collideSphere`
- `collideBox`

H1-4 only adds `positionSphere.center`, `positionSphere.arc`, and `EmitterConfig.offset`; it does
not implement this default change. H1-5 MUST update types/comments, core codegen, diagnostics,
English/Japanese RFC 001 text, JSON compatibility normalization, and GPU regressions together.

## 5. Migration and serialized assets

Code-first definitions that intend the old behavior MUST add `space: 'world'` to every affected
module. Definitions already using either explicit value do not change. Omitted-space definitions
that are intended to follow the effect require no source edit and begin doing so after H1-5.

Existing `nachi-effect` version-1 documents MUST retain their old meaning. H1-5 therefore MUST use
the following compatibility rule instead of silently reinterpreting v1 JSON:

1. `@nachi-vfx/format` loads an affected v1 module with omitted `space` as explicit `space: 'world'`.
2. H1-5 authoring helpers materialize the new default as explicit `space: 'emitter'` in serialized
   module config.
3. Re-serialization is canonical and explicit, so old and new readers agree. The envelope remains
   version 1 because no supported v1 document changes meaning and both selector literals already
   belong to the v1 module shape.

Direct low-level core definitions do not pass through format compatibility normalization; after
H1-5 an omitted selector there follows the new `emitter` rule.

## 6. SemVer and changesets

H1-5 is a **major change to `@nachi-vfx/core`** under RFC 003 §3.1 and §3.5: it changes a documented
public default and deterministic results for the same code-first definition. `@nachi-vfx/format` needs
a **minor** changeset for additive compatibility normalization and canonical explicit output; the
asset envelope does not need a major/version bump because legacy v1 semantics are preserved.

The packages have not yet been publicly released. The release owner can therefore land H1-5 before
the initial release and include the decision in the heavily experimental 0.1.0 preview. The change
remains semantically breaking, but RFC 003 represents breaking changes on the 0.x line with a
`minor` changeset. A later 0.x release would require the next minor; after 1.0, `@nachi-vfx/core` would
require its next major release.

The current H1-4 batch remains additive and carries separate **minor** changesets for
`@nachi-vfx/core` and `@nachi-vfx/format`.

## 7. Verification required in H1-5

- Source migration tests prove explicit `world` reproduces the pre-H1-5 graph and explicit
  `emitter` follows instance translation/rotation.
- Version-1 format fixtures with omitted selectors load as explicit `world` and re-serialize
  canonically.
- Actual Three WGSL codegen is built for every affected module; FakeAdapter-only coverage is not
  sufficient.
- The m4-behaviors GPU readback retains its explicit emitter-space point-attractor check and adds
  discriminating default-vs-explicit checks without changing showcase pages opportunistically.
