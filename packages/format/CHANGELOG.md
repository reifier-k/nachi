# @nachi-vfx/format

## 0.2.2

### Patch Changes

- @nachi-vfx/core@0.2.2

## 0.2.1

### Patch Changes

- e0efe43: Align every public package on a single shared version line. All nine packages now form one
  Changesets fixed group (RFC 003 §1) and release together with the same version; this release
  converges `@nachi-vfx/react` (previously 0.1.1) and `@nachi-vfx/tsl-kit` (previously 0.1.0) onto
  the shared line. No functional changes.
- Updated dependencies [e0efe43]
  - @nachi-vfx/core@0.2.1

## 0.2.0

### Minor Changes

- f9e8f1d: Reject malformed runtime JavaScript inputs consistently across module ValueInputs, transforms,
  timeline actions and clocks, direct post pipelines, trails IDs/UV bounds, and VAT clocks/booleans.
  ValueInput validation covers nested and required fields, string parameter paths, materialized
  built-in parameter types, collision modes and actual normalized-age write ownership. Core and
  timeline reject invalid live or attachment transforms atomically, trails keep alternating counts
  representable as u32, and timeline also synchronizes attachments before initial time-zero play
  actions. Core and timeline use attachment operation revisions so direct or scheduled getters discard
  stale outer samples after nested replacement, same-source reentry, detach, release, or a caught
  invalid attachment attempt. Transform properties and components are read once into owned frozen
  snapshots, with attachment revisions checked both before and after snapshotting, so mutable accessors
  cannot change validated values or reentrantly restore a stale pose during commit.
  Spawn clock options are also single-read snapshots: core snapshots `timeScale` and `priority`, while
  timeline builds a frozen own-data record from all constructor-consumed options before ID allocation
  and preserves direct-constructor validation.

  Harden hostile simulation-cache and debug membership metadata, including non-array birth-order
  state, fractional physical slots, and duplicate-slot diagnostic paths. Timeline visibility mutation
  now reports the terminal error/released state after mesh cleanup instead of misclassifying the key.

- 9f610d5: BREAKING: introduce renderer module v2 and the `nachi-effect` v2 envelope. Alpha and premultiplied
  billboard, mesh, and decal helpers now default to particle sorting; transparent v2 mesh draws no
  longer write depth; v2 decals capture emitter rotation at spawn; and automatic draw order composes
  host base, `renderOrderOffset`, and a fractional coarse rank. Use `sorted: false` for the explicitly
  unordered path, `setRenderOrderBase()` for persistent Three order changes, and renderer module v1
  when loading preserved legacy semantics. Format migrates v1 envelopes without upgrading module
  versions and strictly validates renderer-v2 configs.
- b03ac85: Add world/emitter selectors to velocity cones and linear forces while preserving their world-space
  defaults and legacy shader output. Emitter-space Update forces, analytic colliders, and kill volumes
  now share one previous/current midpoint transform sample in module version 2. Module-v1 world/current
  endpoint semantics remain registered, and format loading validates and canonicalizes the new
  selector fields without implicitly upgrading or changing legacy records.

  Guard the virtual Update midpoint transform at the kernel stage boundary so a custom non-Update
  module cannot share a cached node across independently built kernel graphs.

### Patch Changes

- Updated dependencies [be240d0]
- Updated dependencies [1762675]
- Updated dependencies [db962e3]
- Updated dependencies [f9e8f1d]
- Updated dependencies [14b9704]
- Updated dependencies [62aab5e]
- Updated dependencies [0379e0c]
- Updated dependencies [1d390ce]
- Updated dependencies [4097480]
- Updated dependencies [9f610d5]
- Updated dependencies [b03ac85]
  - @nachi-vfx/core@0.2.0

## 0.1.0

### Minor Changes

- a173df1: Release the complete independently versioned nachi package set as the heavily experimental 0.1.0
  preview. The initial public
  surface includes the staged GPU particle runtime, strict versioned assets, simulation caches and
  data interfaces, timeline and trail composition, TSL/mesh/post rendering tools, the public Three.js
  runtime/materialization adapter, and the React Three Fiber lifecycle binding. This release does not
  promise production readiness or API, behavior, performance, compatibility, or package-boundary
  stability. It includes documented backend residuals, package ESM/dry-run gates, and FA reporting
  contracts. This changeset records the coordinated initial release plan only; the version bump is
  intentionally left to the release owner.
- a892228: Add emitter-local placement controls: `positionSphere` now supports a sampled `center` and an
  area-uniform spherical-cap `arc`, while emitter definitions support an `offset` composed into the
  shared emitter transform. Format v1 assets round-trip the new fields with strict validation.
- a77b084: Change the omitted `space` default for vortex, point-attractor, and analytic-collider modules to
  emitter space. RFC 004 classifies the semantic change as core-major, but because no public version
  has been released, it is folded into the initial heavily experimental 0.1.0 release plan.

  Preserve legacy version-1 asset meaning by loading omitted selectors as explicit world space and
  serialize both legacy and newly authored definitions with canonical explicit selectors while
  keeping the version-1 envelope.

### Patch Changes

- Updated dependencies [fff9517]
- Updated dependencies [03d34f9]
- Updated dependencies [a173df1]
- Updated dependencies [cdd8c2e]
- Updated dependencies [deaa4f6]
- Updated dependencies [a892228]
- Updated dependencies [b4b9f22]
- Updated dependencies [a77b084]
- Updated dependencies [c7275f3]
  - @nachi-vfx/core@0.1.0
