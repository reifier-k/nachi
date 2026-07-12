# Niagara parity report

This report is the FA re-verification index for the 33 completed rows in the
[ROADMAP parity matrix](../ROADMAP.md#niagaraパリティマトリクス). It consolidates the implementation,
existing smoke/test evidence, and the residual difference from Niagara recorded by the M0–M12
audits. It does not turn those residuals into a release-gate decision; FA owns that decision.

## 1. System/emitter hierarchy and emitter inheritance

- **Implementation:** `@nachi/core` `defineEffect()` and `defineEmitter(base, overrides)` provide
  keyed element composition and keyed module-list overrides; `@nachi/format` preserves the result
  through JSON and asset-reference inheritance.
- **Verification:** `/m9-compose/`, `packages/core/test/composition.test.ts`, and
  `packages/format/test/asset.test.ts` cover keyed merge, conflict diagnostics, inheritance cycles,
  and round trips.
- **Residual:** There is no System Spawn/System Update module surface, live propagation after a
  parent asset changes, or editor hierarchy. Inheritance is resolved when definitions/assets load.

## 2. Dynamic particle attributes

- **Implementation:** `@nachi/core` attribute declarations compile per emitter to packed SoA
  storage through `resolveAttributeSchema()` and `compileEmitter()`.
- **Verification:** `/m1-kernel/`, `packages/core/test/attributes.test.ts`, and
  `packages/core/test/compiler.test.ts` cover logical/physical layouts, custom fields, access
  manifests, limits, and GPU materialization.
- **Residual:** Layout is fixed at compilation and constrained by WebGPU storage-buffer limits;
  attributes cannot be added live as in editor-driven Niagara workflows.

## 3. Namespaced parameters

- **Implementation:** `@nachi/core` models `System.*`, `Emitter.*`, `Particles.*`, and typed mutable
  `User.*` references with `parameter()` and effect-level schema composition.
- **Verification:** `/m1-kernel/`, `/m9-compose/`, compiler/composition/system tests, and GPU
  readback verify namespace validation and per-instance `User.*` propagation.
- **Residual:** Public mutation is intentionally limited to `User.*`; object, data-interface, and
  asset-typed user parameters are not supported.

## 4. GPU simulation (compute)

- **Implementation:** `@nachi/core` `compileEmitter()` and `VFXSystem` materialize TSL compute,
  free-list lifecycle, compaction, and indirect dispatch/draw through a renderer adapter.
- **Verification:** `/spike-compute/`, `/m1-kernel/`, `/m2-runtime/`, compiler/system tests, and
  storage-buffer readback validate kernels and lifecycle counters.
- **Residual:** WebGPU is the complete path. WebGL2 transform feedback has no atomics or indirect
  lifecycle parity, and cross-adapter physical-slot allocation order is not guaranteed.

## 5. Spawn: rate, burst, and per-distance

- **Implementation:** `@nachi/core` `rate()`, `burst()`, and `perDistance()` feed GPU allocation and
  capacity diagnostics.
- **Verification:** `/m2-runtime/` plus compiler/system tests cover fractional accumulation,
  timestep splitting, distance accumulation, overflow, and indirect dispatch.
- **Residual:** WebGL2 supports only the explicitly reduced single-burst path when its transform-
  feedback budget permits; Niagara-style custom spawn scripts are not a separate stage surface.

## 6. Emitter lifecycle

- **Implementation:** `@nachi/core` lifecycle config supports start delay, duration, finite/infinite
  loops, and deterministic prewarm through `VFXSystem`.
- **Verification:** `/m2-runtime/` and system tests cover boundaries, loop generations, prewarm
  bit identity, stop, release, and pooling.
- **Residual:** `stop()` is immediate rather than graceful particle drain, and there are no editor
  lifecycle state graphs or arbitrary emitter-state modules.

## 7. Local time and time scale

- **Implementation:** `@nachi/core` effect clocks, fixed-step scheduling, `setTimeScale()`, and
  `applyHitStop()` separate effect/emitter time from host time; `@nachi/timeline` sequences them.
- **Verification:** `/m2-runtime/`, `/m9-timeline/`, system tests, and timeline tests cover split-step
  invariance, fixed-step limits, hit stop, and independent instances.
- **Residual:** Reverse playback and general time seeking are absent; culled effects pause without
  catch-up by design.

## 8. Sprite renderer

- **Implementation:** `@nachi/core` `billboard()` covers camera/velocity/custom-axis facing,
  velocity stretch, cutout geometry, flipbooks, motion-vector blending, and blend modes.
- **Verification:** `/m3-sprites/`, `/golden-explosion/`, and compiler plus Three-adapter tests cover
  twelve renderer cases and pixel/readback checks.
- **Residual:** Arbitrary SubImage index, random starting frame, per-axis rotation curves, multiple
  materials, and multiple renderers per emitter are unavailable.

## 9. Mesh renderer

- **Implementation:** `@nachi/core` `meshRenderer()` supplies instanced geometry with orientation,
  particle color, and scale; playground Three adapters resolve geometry references.
- **Verification:** `/m3-sprites/`, `/golden-explosion/`, compiler tests, and GPU six-direction
  orientation probes verify transforms and instance data.
- **Residual:** Mesh arrays, renderer material slots, per-particle mesh selection, and a lit mesh
  particle path are absent.

## 10. Soft particles

- **Implementation:** `billboard({ soft: ... })` and the Three adapter apply normalized-depth fade
  against a copied linear scene-depth texture.
- **Verification:** `/spike-depth/`, `/m3-sprites/`, `/golden-explosion/`, and adapter tests compare
  hard/soft contributions and asymmetric depth samples.
- **Residual:** It is a single-camera, one-frame-late, non-MSAA path; reverse-z, shared depth-copy
  ownership, WebGL2 compute-depth parity, and world-unit fade distance are absent.

## 11. Forces

- **Implementation:** `@nachi/core` provides `gravity()`, `drag()`, `vortex()`, `pointAttractor()`,
  `linearForce()`, `curlNoise()`, and `turbulence()`.
- **Verification:** `/m4-behaviors/` and compiler tests compare module mathematics, deterministic
  simplex curl, access declarations, and GPU results.
- **Residual:** Particle mass does not alter the built-in force modules, rotational drag is absent,
  and Niagara's broader solver/module catalog requires custom TSL.

## 12. Vector fields (FGA)

- **Implementation:** `@nachi/core` parses ASCII FGA and `vectorField()` samples it trilinearly at
  texel centers.
- **Verification:** `/m4-behaviors/` and `packages/core/test/fga.test.ts` cover parsing, bounds,
  interpolation, transforms, and GPU sampling.
- **Residual:** Fields are world-fixed; binary `.vf`, animated/vector-field atlases, and editor
  vector-field tooling are not supported.

## 13. Orientation, rotation, and kill volumes

- **Implementation:** `@nachi/core` exposes orientation/rotation modules and `killVolume()` with
  sphere/box tests in emitter-local space.
- **Verification:** `/m4-behaviors/` and compiler tests cover shortest-arc quaternion mathematics,
  degenerate cases, rotation evolution, and volume boundaries.
- **Residual:** Kill volumes are fixed emitter-local primitives; there are no scene-query volumes,
  skinned volumes, or Niagara's full orientation module set.

## 14. GPU events and sub-emitters

- **Implementation:** `@nachi/core` event queues and `emitTo()` support GPU `onDeath` and
  begin-contact `onCollision`, with selected inherited float attributes.
- **Verification:** `/m5-events/`, `/m6-collision/`, compiler/system tests, and multi-stage GPU
  readback cover queue drain, overflow, target resolution, and chains.
- **Residual:** `onCustom` and `onSpawn` are reserved, one record emits one child, inheritance is
  limited to at most four float components, and persistent particle IDs are absent.

## 15. Scene-depth collision

- **Implementation:** `collideSceneDepth()` uses WebGPU NDC `z` and linear float depth with
  thickness rejection, normal reconstruction, bounce, and friction.
- **Verification:** `/m6-collision/`, `/spike-depth/`, and Three-adapter tests use dynamic occluders,
  asymmetric pixels, stale-depth tripwires, and GPU numeric probes.
- **Residual:** The path is WebGPU-only, single-camera, one frame late, and non-MSAA; it has no CCD,
  reverse-z, or shared depth ownership.

## 16. Analytic collider and SDF collision

- **Implementation:** `@nachi/core` supplies plane/sphere/box collision plus `bakeSdf()` and
  `collideSdf()` for sampled signed-distance volumes.
- **Verification:** `/m6-collision/`, `packages/core/test/sdf.test.ts`, compiler tests, and four-case
  GPU probes compare pushout, normals, bounce, and SDF sampling.
- **Residual:** Capsule/cylinder and general mesh collision are absent; mesh-to-SDF baking supports
  procedural sphere/box unions rather than a production asset voxelizer, and CCD is absent.

## 17. Mesh-surface sampling

- **Implementation:** `positionMeshSurface()` and `velocityMeshNormal()` consume area-CDF triangle
  textures; playground resource adapters can CPU-skin and re-upload a mesh.
- **Verification:** `/m6-collision/`, `/golden-character/`, compiler tests, and adapter readback cover
  area uniformity, normals, skin updates, and texture limits.
- **Residual:** Vertex/bone sampling, material filters, surface-velocity inheritance, GPU skinning,
  and multi-row/very-large triangle textures are absent.

## 18. Socket/bone attachment

- **Implementation:** `EffectInstance.attachTo()` consumes a transform source; the Three adapter
  wraps `Object3D`/`Bone` world transforms before every scheduled step.
- **Verification:** `/golden-character/` and system/adapter tests cover moving sockets, detach,
  release, initial synchronization, and deterministic repeat.
- **Residual:** Attachment is effect-wide. Niagara-style per-particle bone/socket attachment and
  sampling across a skeleton are not provided.

## 19. Ribbon renderer

- **Implementation:** `@nachi/trails` registers `ribbon()` with a GPU birth-index ring, multiple
  ribbon IDs, indirect segment preparation, and `@nachi/trails/three` materialization.
- **Verification:** `/m7-ribbons/`, `/golden-slash/`, and `packages/trails/test/trails.test.ts` cover
  order, death gaps, wrap, UV, overflow, and eleven GPU/readback cases.
- **Residual:** No width curve, smoothing, twist/custom facing, per-particle width, arbitrary link
  order, or multiple ribbon renderers; it is WebGPU-only, `maxRibbons <= 64`, and retains at most the
  latest `capacity` births.

## 20. Light renderer

- **Implementation:** `@nachi/core` `lightRenderer()` selects GPU top-N particles and the Three
  adapter updates a bounded `PointLight` pool one frame later.
- **Verification:** `/m7-ribbons/`, `/golden-charge/`, `/golden-slash/`, and compiler/adapter tests
  cover selection, limits, pool reuse, and offscreen lighting.
- **Residual:** No inverse-square mode switch, translucency/volumetric flags, arbitrary attribute
  binding, or stable logical-ID tie-break; the bounded CPU light pool differs from Niagara's
  renderer integration.

## 21. Decal renderer

- **Implementation:** `decalRenderer()` reconstructs scene position from depth and projects a
  bounded box through the Three adapter.
- **Verification:** `/m7-ribbons/`, `/golden-slash/`, compiler tests, and offscreen pixel-region
  checks verify projection and explicit backend diagnostics.
- **Residual:** No deferred/GBuffer material integration, receiver-normal rejection, screen-size
  fade, or anisotropic particle size; it is WebGPU-only, one frame late, and single-camera.

## 22. Material expression building blocks

- **Implementation:** `@nachi/tsl-kit` provides dissolve, UV flow, polar UV, Fresnel, lighting,
  depth fade, and distortion helpers; `@nachi/mesh-fx` composes them through `fxMaterial()`.
- **Verification:** `/m8-tslkit/`, `/m8-meshfx/`, tsl-kit/mesh-fx tests, and WebGPU/WebGL2 render-
  target byte comparisons verify each mathematical term.
- **Residual:** The generic `fxMaterial()` surface is unlit and has no procedural-noise graph,
  Material Instance equivalent, or GUI node editor; lit particles use the separate billboard path.

## 23. VAT runtime

- **Implementation:** `@nachi/mesh-fx` decodes flement Blender VAT position/normal textures with
  frame selection and interpolation.
- **Verification:** `/m8-vat/` and mesh-fx tests compare CPU/GPU branches, mirrored-axis convention,
  normal transforms, frame boundaries, and both backends.
- **Residual:** No atlas crop/wrap controls, variable topology, tangent VAT, automatic bounds, or
  general Houdini VAT format matrix.

## 24. Timeline/Sequencer integration

- **Implementation:** `@nachi/timeline` provides `at()`, play/stop/marker/callback actions, loops,
  speed, camera shake, hit stop, and mesh-fx lifecycle on an effect-local timeline.
- **Verification:** `/m9-timeline/`, `/golden-slash/`, `/golden-ultimate/`, and timeline tests cover
  boundary splitting, deterministic shake, loop invariance, errors, and cleanup.
- **Residual:** No keyframe property tracks, seeking, reverse playback, editor Sequencer, or direct
  cross-effect `emitTo`; camera shake and hit stop are nachi additions rather than Niagara features.

## 25. Runtime user-parameter API

- **Implementation:** composed effect definitions derive typed spawn overrides and
  `EffectInstance.setParameter()` for mutable `User.*` values.
- **Verification:** `/m9-compose/` plus core composition/system tests cover typing, runtime
  validation, GPU propagation, immutability, and instance isolation.
- **Residual:** Object/asset/data-interface parameter values and editor-exposed parameter panels
  are absent.

## 26. Post integration and lit particles

- **Implementation:** `@nachi/post` supplies distortion, heat haze, radial blur, bloom presets, and
  pipeline composition; `billboard({ lit: true })` uses Three's physical lighting path.
- **Verification:** `/m10-post/`, `/m10-lit/`, `/golden-explosion/`, `/golden-ultimate/`, post tests,
  and offscreen probes cover both backends where supported and lit normal bases.
- **Residual:** Lit mode is sprite-only; distortion is effect/uniform driven rather than a particle
  distortion buffer, velocity-stretch normal inverse-scale correction is absent, and high-density
  distortion needs a dedicated future path.

## 27. Alpha sorting and OIT

- **Implementation:** `@nachi/core` combines emitter coarse order and GPU bitonic particle sort;
  `@nachi/post` provides weighted blended OIT.
- **Verification:** `/m10-sort/`, `/golden-explosion/`, compiler/post tests, exhaustive 0-1 sort
  probes, reverse-order OIT checks, and status regression tests verify the three layers.
- **Residual:** No custom sort key or translucency priority, sorted capacity is 65,536, sort is
  WebGPU-only and camera-z based, ribbons are outside the rank, and WBOIT lacks opaque-depth
  occlusion in its standalone target.

## 28. Scalability, significance, and pooling

- **Implementation:** `@nachi/core` provides quality tiers, distance/frustum culling, deterministic
  significance ranking, instance/particle budgets, structural quality variants, and bounded pools.
- **Verification:** `/m11-scale/`, `/golden-ambient/`, scalability/system tests, and tier pixel/
  readback probes cover ordering, pause/resume, next-spawn variants, and reuse.
- **Residual:** No shared Effect Type asset, per-platform profiles, occlusion/cull proxy, custom
  significance handler, or dynamic automatic FX-budget downgrade.

## 29. Simulation caching

- **Implementation:** `@nachi/core` `bakeSimulation()` and `replaySimulation()` store renderer-read
  attributes and alive indirection in Float32 or bounded-error u16 cache frames.
- **Verification:** `/m11-cache/`, sim-cache/system tests, and independent analytic GPU probes cover
  endianness, interpolation, loop endpoints, backend checks, and replay without simulation passes.
- **Residual:** No texture/volume baker output, all-attribute cache, Sequencer scrubbing, world-space
  rebasing, velocity extrapolation, grid capture, or WebGL2 replay.

## 30. Debugger and profiler

- **Implementation:** `instance.debug.captureAttributes()` and `system.debug.captureProfile()`
  expose queued snapshots, logical decoding, counters, and shared perf timestamp values.
- **Verification:** `/m11-debug/`, debug/system tests, and backend probes cover FIFO consistency,
  truncation, aliases, unavailable metrics, and one-frame-late frame semantics.
- **Residual:** No continuous spreadsheet stream, System namespace watch, expression filters, FX
  Outliner/session browser, remote session, or module/emitter-level GPU time attribution.

## 31. Asset format and loader

- **Implementation:** `@nachi/format` owns strict `{ format: 'nachi-effect', version: 1, effect }`
  documents, schema, serializer/loader, migration registry, resources, and referenced inheritance.
- **Verification:** `/golden-ultimate/`, `/m9-compose/`, format tests, schema validation, and JSON→GPU
  audit probes cover closed shapes, paths, references, registrations, and round trips.
- **Residual:** Inline TSL must be registered by design, sim-cache embedding/references are not in
  format v1, and there is no GUI asset editor.

## 32. Grid2D/3D fluids

- **Implementation:** `@nachi/core` `defineGrid2D()`, `defineGrid3D()`, `defineSimStage()`, and built-in
  inject/advection/buoyancy/Jacobi/project/sample stages use packed storage and explicit submits.
- **Verification:** `/m12-grid/`, `/golden-fluid/`, grid2d/grid3d/system tests, and GPU snapshots cover
  ordering, bounds, transfer, limits, stability, and 2D/3D sampling.
- **Residual:** No vorticity confinement, MacCormack, obstacle boundary, combustion, ray-marched
  volume renderer, 3D texture storage, or direct bidirectional particle-buffer coupling; Jacobi
  low-frequency convergence is limited and WebGL2 is unsupported.

## 33. Neighbor grid, boids, and PBD

- **Implementation:** `@nachi/core` `defineNeighborGrid()`, `boids()`, `pbdDistanceConstraint()`, and
  `neighborGridTslModule()` use atomic bounded buckets, snapshot neighbors, and submit-separated
  Jacobi constraints.
- **Verification:** `/m12-neighbors/`, neighbor-grid/compiler/system tests, and GPU kernel probes
  cover dynamic loops, overflow, module ordering, snapshots, storage limits, and PBD iterations.
- **Residual:** One emitter owns each grid in v1, neighbor snapshots contain position/velocity only,
  cells have fixed capacity, and XPBD compliance, masses, pins, and collision constraints are absent;
  WebGL2 is unsupported.

## Residual pattern summary

The remaining gaps cluster around four boundaries already made explicit in RFC 001 §16: WebGPU-
only algorithms where WebGL2 lacks atomics/indirect operations, editor/GUI workflows outside the
code-first scope, advanced production variants (volume rendering, obstacles, richer ribbons/VAT),
and cross-system or persistent-identity features. The audits found no residual that is silently
substituted: unsupported paths either remain absent from the API or emit a structured `NACHI_*`
diagnostic.
