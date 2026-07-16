# @nachi-vfx/post

## 0.2.1

### Patch Changes

- e0efe43: Align every public package on a single shared version line. All nine packages now form one
  Changesets fixed group (RFC 003 §1) and release together with the same version; this release
  converges `@nachi-vfx/react` (previously 0.1.1) and `@nachi-vfx/tsl-kit` (previously 0.1.0) onto
  the shared line. No functional changes.

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
- b4b9f22: Add resource-oriented effect preparation APIs. Core and timeline systems can now compile compute,
  draw, grid, and mesh-fx resources without advancing effect time; the Three integration supplies a
  retained draw-pipeline preparer with custom draw handlers, and post pipelines can prepare their
  scene/post graph against the live output context. Preparation supports progress reporting and
  abort signals.
