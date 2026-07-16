# @nachi-vfx/three

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

- 0379e0c: Deliver contained runtime diagnostics through a default one-line console reporter, replacement
  handler, or explicit null opt-out while retaining instance diagnostics. Core now covers GPU,
  attachment, device-loss, preparation, capacity, and readback-observed overflow sources; timeline
  delivers its own failures without duplicating child-core reports; and prepared Three light draws
  rebind light-limit warnings to their live owner. React documents and verifies mutable instance error
  observation after a resolved provider update.

  Do not let hidden preparation instances consume the one-shot late device-loss delivery intended for
  the first caller-owned spawn, and do not append diagnostic-handler failures after an instance has
  already reached the released state.

- 9f610d5: BREAKING: introduce renderer module v2 and the `nachi-effect` v2 envelope. Alpha and premultiplied
  billboard, mesh, and decal helpers now default to particle sorting; transparent v2 mesh draws no
  longer write depth; v2 decals capture emitter rotation at spawn; and automatic draw order composes
  host base, `renderOrderOffset`, and a fractional coarse rank. Use `sorted: false` for the explicitly
  unordered path, `setRenderOrderBase()` for persistent Three order changes, and renderer module v1
  when loading preserved legacy semantics. Format migrates v1 envelopes without upgrading module
  versions and strictly validates renderer-v2 configs.

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
- c7275f3: Interpolate emitter transforms within rate, burst, and per-distance spawn batches. Moving emitters
  now place new particles along the traveled segment using deterministic spawn-order phases, while
  stationary emitters retain the existing transform path bit-for-bit and pooled emitter reuse resets
  transform history before respawn.

  Extend the public kernel-adapter contract with matrix construction and implement the new required
  `KernelTslAdapter.mat4` capability in the Three.js adapter for interpolated transform codegen.

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
