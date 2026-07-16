# @nachi-vfx/core

## 0.2.0

### Minor Changes

- be240d0: Keep duration-omitted `rate` and `perDistance` emitters active until they are explicitly stopped,
  while preserving finite derived envelopes for burst-only emitters and explicit finite durations.
  Timeline track completion now truncates and releases active children at the final boundary as well
  as loop boundaries, so unbounded continuous children cannot keep a completed track alive.
- 1762675: Use numeric effect creation order for equal-significance budgets and equal-depth coarse alpha
  ordering, and canonicalize routing between multiple event producers and one target. Equal-priority
  light candidates now use logical particle spawn order instead of physical storage slots; light
  selection statistics expose that spawn order. These changes affect exact ties and saturated event
  or light winner selection while keeping public effect IDs compatible. The coarse-sort helper uses
  numeric sequence ties only when every entry provides a safe integer, otherwise preserving its
  stable-key ordering for the whole collection.

  Compile historical five-read light-renderer manifests with the current `spawnOrder` dependency so
  old effect JSON materializes the same deterministic light schema and draw instead of silently
  dropping it.

- db962e3: Discard per-distance transform history whenever a core- or timeline-owned fixed-step accumulator
  drops excess time, while keeping retained rate substeps and subsequent movement continuous. Debug
  attribute capture also adds opt-in `order: 'physical-slot'` sorting before pagination; the default
  compaction order and its allocation behavior remain unchanged.

  Fixed-step drop latching now uses per-advance metadata even after cumulative counters lose numeric
  precision, fixed intervals must exceed `1e-10` seconds, and debug capture rejects non-enum orders or
  out-of-capacity physical membership instead of fabricating zero-valued rows.

  Fixed-step ceilings must remain finite, and huge finite deltas are partitioned with remaining-capacity
  arithmetic so frame-local and cumulative drop accounting never becomes `NaN`.

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
- 62aab5e: Make NeighborGrid `origin` emitter-local so bucket insertion and all neighbor lookups follow
  instance translation/rotation and `EmitterConfig.offset`, while particle snapshots and distance
  math remain world-space. Add dominant out-of-bounds capture diagnostics and the forward-compatible
  `VFXSystemOptions.onRuntimeDiagnostic` delivery seam.
- 0379e0c: Deliver contained runtime diagnostics through a default one-line console reporter, replacement
  handler, or explicit null opt-out while retaining instance diagnostics. Core now covers GPU,
  attachment, device-loss, preparation, capacity, and readback-observed overflow sources; timeline
  delivers its own failures without duplicating child-core reports; and prepared Three light draws
  rebind light-limit warnings to their live owner. React documents and verifies mutable instance error
  observation after a resolved provider update.

  Do not let hidden preparation instances consume the one-shot late device-loss delivery intended for
  the first caller-owned spawn, and do not append diagnostic-handler failures after an instance has
  already reached the released state.

- 1d390ce: BREAKING: upgrade simulation caches to lineage-aware format version 2. Every emitter now records a
  lossless u32 `Particles.spawnOrder` stream so linear replay never interpolates a reused physical
  slot and loop validation compares logical particles independently of compaction order. Version 1 and
  missing-version caches are rejected and must be re-baked. The binary asset grows by four bytes per
  particle slot per frame; the lineage stream does not add to ordinary per-frame replay uploads, and
  emitters whose renderer does not read `spawnOrder` do not retain birth-order lifecycle overhead.
- 4097480: Key Update-stage deterministic ranges and custom `context.random()` calls by particle spawn order,
  emitter seed, module/sample slot, and the actual update-dispatch ordinal. Physical free-list slot
  reuse no longer changes logical particle results, while repeated Update dispatches retain temporal
  variation and identical seed/schedule/step sequences remain reproducible.
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

## 0.1.0

### Minor Changes

- fff9517: Fix multi-cycle burst effects whose earlier particles die while later cycles spawn. As amended in
  RFC 001's emitter lifecycle contract, when `lifecycle.duration` is absent, core now derives an
  active duration from the burst envelope plus statically known particle-lifetime grace, allowing
  every authored cycle to fire while preserving explicit numeric durations, other lifecycle fields,
  seeds, and the WebGL2 safety gate. This is an intentional behavior change for effects that omit an
  explicit duration: multi-cycle bursts no longer silently stop after cycle 0. Co-authored `rate` and
  `perDistance` modules on the same emitter now also emit during the derived window, whereas the
  previous zero-length window suppressed them.
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
- deaa4f6: Key all core Init randomness, including `positionSphere`, `positionMeshSurface`, `velocityCone`,
  `lifetime(range(...))`, and ranged attribute defaults, by deterministic particle `spawnOrder`
  instead of physical free-list slot identity. Recycled slots now receive fresh samples and identical
  seeds remain reproducible when parallel death compaction changes free-list reuse order.

  This intentionally changes concrete random values—and therefore rendered appearance—for emitters
  whose Init modules use random distributions. Screenshot and other visual baselines may need to be
  recorded again even though the authored distributions and seeds are unchanged.

- a892228: Add emitter-local placement controls: `positionSphere` now supports a sampled `center` and an
  area-uniform spherical-cap `arc`, while emitter definitions support an `offset` composed into the
  shared emitter transform. Format v1 assets round-trip the new fields with strict validation.
- b4b9f22: Add resource-oriented effect preparation APIs. Core and timeline systems can now compile compute,
  draw, grid, and mesh-fx resources without advancing effect time; the Three integration supplies a
  retained draw-pipeline preparer with custom draw handlers, and post pipelines can prepare their
  scene/post graph against the live output context. Preparation supports progress reporting and
  abort signals.
- a77b084: Change the omitted `space` default for vortex, point-attractor, and analytic-collider modules to
  emitter space. RFC 004 classifies the semantic change as core-major, but because no public version
  has been released, it is folded into the initial heavily experimental 0.1.0 release plan.

  Preserve legacy version-1 asset meaning by loading omitted selectors as explicit world space and
  serialize both legacy and newly authored definitions with canonical explicit selectors while
  keeping the version-1 envelope.

- c7275f3: Interpolate emitter transforms within rate, burst, and per-distance spawn batches. Moving emitters
  now place new particles along the traveled segment using deterministic spawn-order phases, while
  stationary emitters retain the existing transform path bit-for-bit and pooled emitter reuse resets
  transform history before respawn.

  Extend the public kernel-adapter contract with matrix construction and implement the new required
  `KernelTslAdapter.mat4` capability in the Three.js adapter for interpolated transform codegen.

### Patch Changes

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
