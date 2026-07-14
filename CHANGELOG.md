# Changelog

This repository uses Changesets and independent package versions. The release owner will move the
prepared entries into concrete version headings during the 0.1.0 versioning pass; no version bump is
part of this FA preparation batch.

## Unreleased — 0.1.0 heavily experimental preview

This preview is not production-ready. APIs, behavior, performance, compatibility, and package
boundaries may change significantly between releases.

### Runtime and authoring

- Added the code-first staged particle model, deterministic generators, typed parameters, GPU
  lifecycle/indirect rendering, events, collision, render modules, quality management, simulation
  caching, debugging, Grid2D/3D fluids, neighbor grids, boids, and PBD in `@nachi-vfx/core`.
- Added strict version-1 JSON assets, migrations, registered executable references, resource
  binding, and referenced emitter inheritance in `@nachi-vfx/format`.
- Added deterministic sequencing, markers, camera shake, hit stop, and mesh lifecycle composition
  in `@nachi-vfx/timeline`, plus GPU ribbons in `@nachi-vfx/trails`.

### Rendering and integrations

- Added standalone TSL material helpers, procedural effect meshes, flement-compatible VAT,
  RenderPipeline post effects, weighted blended OIT, and React Three Fiber lifecycle bindings.
- Pinned the supported Three.js runtime to `three@0.185.1`; Three, React, and R3F integrations use
  peer dependencies so applications retain ownership of framework runtimes.

### Release readiness

- Added dry-run packaging and ESM import gates, a seven-effect documentation gallery, FA parity,
  bundle/tree-shaking, dependency-license reports, robust multi-sample GPU timing, and a documented
  future 1.0 versioning/deprecation policy.
- Documented explicit WebGL2 and advanced-feature residuals. Unsupported paths continue to fail
  with structured `NACHI_*` diagnostics instead of silent semantic fallbacks.
