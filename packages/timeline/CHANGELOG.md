# @nachi-vfx/timeline

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
