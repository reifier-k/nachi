# @nachi-vfx/core

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
