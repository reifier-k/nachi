# @nachi-vfx/mesh-fx

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

- 7cef420: Retain cloneable VAT binding metadata and rebuild ordered position/normal VAT layers for timeline
  mesh clones. Package-owned VAT clocks now follow latest-play element-local time with independent
  source/clone uniforms, while standalone writes, explicit external clocks, borrowed textures, and
  existing fxMaterial lifecycle controls retain their prior contracts. Authored final node or material
  replacement is preserved without reviving detached VAT graphs or stale timeline-owned clocks.
  Absolute position and last-write normal composition now clone and drive only their ordered
  graph-reachable control union.

  Keep a still-installed VAT normal binding active when authored position replacement starts a new
  position chain and the next application is position-only. Timeline clones rebuild that normal graph
  with clone-owned clocks; a newly supplied normal texture still replaces the prior binding.

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
- 93379b0: Add writable scalar opacity controls, independently authored dissolve UVs, and configurable
  dissolve-edge intensity/map modulation to mesh-fx materials. Timeline materials can now drive the
  writable opacity channel with normalized-life curves through `opacityOverLife`.

### Patch Changes

- Updated dependencies [a173df1]
- Updated dependencies [088fd06]
  - @nachi-vfx/tsl-kit@0.1.0
