# @nachi-vfx/trails

## 0.2.2

### Patch Changes

- 113ff31: Fix a `NACHI_THREE_RENDER_ORDER_COMPOSITION_INVALID` crash when a materialized ribbon draw is
  re-composed by the `@nachi-vfx/three` runtime. Ribbon draws share the kernel-owned draw registry
  with three's built-in draws (both key it by the same global symbol) so ribbons ride the shared
  runtime visibility/culling path, but the trails registration omitted the `base`/`offset`/`drawIndex`
  fields that three's render-order composition reads from every registry entry. Draw-pool activation
  or a `setRenderOrder` pass therefore threw. The ribbon registration now mirrors three's
  `registerDrawObject` shape — the ribbon's absolute renderOrder as `base`, zero `offset`, and
  `drawIndex` -1 to opt out of transparent draw-order rank — so the composition pass accepts ribbon
  entries while preserving the shared visibility integration.
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

- 03d34f9: Validate engine-independent module configuration at factory call time while retaining the same
  compile diagnostics for JSON-loaded definitions. This is an intentional fail-fast behavior change:
  invalid core module factories and `ribbon()`/`ribbonId()` now throw `VfxDiagnosticError`
  synchronously.

  Core also reports spawn-time build diagnostics through a configurable console hook, warns when a
  lifetime has no age path, lowers plain TSL binding-operation literals to typed nodes, rejects invalid
  binding inputs before GPU submission, and attaches emitter and kernel context to GPU submission
  failures.

- a173df1: Release the complete independently versioned nachi package set as the heavily experimental 0.1.0
  preview. The initial public
  surface includes the staged GPU particle runtime, strict versioned assets, simulation caches and
  data interfaces, timeline and trail composition, TSL/mesh/post rendering tools, the public Three.js
  runtime/materialization adapter, and the React Three Fiber lifecycle binding. This release does not
  promise production readiness or API, behavior, performance, compatibility, or package-boundary
  stability. It includes documented backend residuals, package ESM/dry-run gates, and FA reporting
  contracts. This changeset records the coordinated initial release plan only; the version bump is
  intentionally left to the release owner.
- cdd8c2e: Add persistent user visibility controls to Three sprite, mesh, decal, light-pool, and ribbon
  materialization results. Runtime culling/lifecycle visibility is now explicitly composed with the
  default-true user override, so existing draws retain their behavior while `setUserVisible()` is an
  additive public API. Core receives a patch because its existing renderer bridge signature is
  unchanged and only clarifies that `setVisibility` publishes the runtime-owned component; the Three
  and trails packages receive minors for their new public methods.

  Add `TimelineEffectInstance.bindCompanion()` and `unbindCompanion()` as additive timeline APIs.
  Bound core instances receive effective time-scale and hit-stop changes synchronously, including
  state at bind time. Weak bindings automatically discard released instances and gate every transfer
  to error-state companions. Invalid binds and companions entering error report
  `NACHI_TIMELINE_COMPANION_UNAVAILABLE`; direct companion controls and timeline forwarding use
  documented last-writer-wins semantics. This is a timeline minor; the larger public clock-source
  proposal is documented separately and remains unimplemented.

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
