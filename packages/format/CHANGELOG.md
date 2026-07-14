# @nachi-vfx/format

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
