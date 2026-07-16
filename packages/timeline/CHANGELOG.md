# @nachi-vfx/timeline

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

- 14b9704: Cap omitted-update wall-clock deltas by default, expose cumulative measured and fixed-step drop
  counters, and apply the same timeline-owned clock contract to mesh, VAT, action, and child-emitter
  segments. Explicit deltas remain uncapped.
- 0379e0c: Deliver contained runtime diagnostics through a default one-line console reporter, replacement
  handler, or explicit null opt-out while retaining instance diagnostics. Core now covers GPU,
  attachment, device-loss, preparation, capacity, and readback-observed overflow sources; timeline
  delivers its own failures without duplicating child-core reports; and prepared Three light draws
  rebind light-limit warnings to their live owner. React documents and verifies mutable instance error
  observation after a resolved provider update.

  Do not let hidden preparation instances consume the one-shot late device-loss delivery intended for
  the first caller-owned spawn, and do not append diagnostic-handler failures after an instance has
  already reached the released state.

- 4a92015: Snapshot each timeline mesh material's current writable controls and Three.js render state at
  spawn, add persistent per-element `setUserVisible()` composition, and define shared mesh geometry as
  an application-owned immutable borrow.
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

### Patch Changes

- be240d0: Keep duration-omitted `rate` and `perDistance` emitters active until they are explicitly stopped,
  while preserving finite derived envelopes for burst-only emitters and explicit finite durations.
  Timeline track completion now truncates and releases active children at the final boundary as well
  as loop boundaries, so unbounded continuous children cannot keep a completed track alive.
- db962e3: Discard per-distance transform history whenever a core- or timeline-owned fixed-step accumulator
  drops excess time, while keeping retained rate substeps and subsequent movement continuous. Debug
  attribute capture also adds opt-in `order: 'physical-slot'` sorting before pagination; the default
  compaction order and its allocation behavior remain unchanged.

  Fixed-step drop latching now uses per-advance metadata even after cumulative counters lose numeric
  precision, fixed intervals must exceed `1e-10` seconds, and debug capture rejects non-enum orders or
  out-of-capacity physical membership instead of fabricating zero-valued rows.

  Fixed-step ceilings must remain finite, and huge finite deltas are partitioned with remaining-capacity
  arithmetic so frame-local and cumulative drop accounting never becomes `NaN`.

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
- Updated dependencies [7cef420]
  - @nachi-vfx/core@0.2.0
  - @nachi-vfx/mesh-fx@0.2.0

## 0.1.0

### Minor Changes

- 8e78309: Compose each timeline mesh-fx clone's authored local position and quaternion with its effect
  transform. Authored scale remains the clone's initial scale, and live effect transform updates no
  longer interfere with application-driven clone scale animation.
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

- b4b9f22: Add resource-oriented effect preparation APIs. Core and timeline systems can now compile compute,
  draw, grid, and mesh-fx resources without advancing effect time; the Three integration supplies a
  retained draw-pipeline preparer with custom draw handlers, and post pipelines can prepare their
  scene/post graph against the live output context. Preparation supports progress reporting and
  abort signals.

### Patch Changes

- fff9517: Keep an emitter element's final local time in `getElementState()` after it completes, matching the
  existing mesh-element behavior instead of resetting completed emitters to zero.
- Updated dependencies [fff9517]
- Updated dependencies [03d34f9]
- Updated dependencies [a173df1]
- Updated dependencies [93379b0]
- Updated dependencies [cdd8c2e]
- Updated dependencies [deaa4f6]
- Updated dependencies [a892228]
- Updated dependencies [b4b9f22]
- Updated dependencies [a77b084]
- Updated dependencies [c7275f3]
  - @nachi-vfx/core@0.1.0
  - @nachi-vfx/mesh-fx@0.1.0
