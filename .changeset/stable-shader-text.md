---
'@nachi-vfx/three': minor
---

Stable shader text across draw materializations so Three's program/pipeline caches hit.

Breaking (types): `materializeThreeSpriteDraw`, `materializeThreeMeshDraw`, and
`materializeThreeDecalDraw` now return `THREE.Mesh<THREE.InstancedBufferGeometry, …>` instead of
`THREE.InstancedMesh`. Code that read `.count`, `.instanceMatrix`, or called `setMatrixAt()` on the
returned object must stop: instancing is driven by the indirect draw arguments and
`geometry.instanceCount` (the capacity ceiling).

- Sprite/mesh/decal draws are now `THREE.Mesh` + `InstancedBufferGeometry` (instance ceiling =
  capacity; the actual count still comes from the indirect draw arguments) instead of
  `THREE.InstancedMesh`. InstancedMesh injected an `instanceMatrix` uniform buffer whose WGSL name
  embeds the node id and whose array length embeds the capacity, so every materialized draw had
  unique shader text and every spawn recompiled its render pipeline synchronously.
- Draw-side storage bindings get fixed names (`NachiAttr<n>`, `NachiAlive`, `NachiSorted`)
  instead of Three's `NodeBuffer_<id>`.
- The alive-index offset and sorted padded capacity are uniforms rather than literals.

Measured on a 34-effect game: preload render pipelines 357 → 93, spawn-time synchronous
`createRenderPipeline` calls for particle draws 208 → 0.
- Numeric constants (`constant()` and plain-number `uint()`) are emitted as uniforms on WebGPU
  instead of shader literals, so structurally identical emitters share compute shader text too
  (354 → 117 unique compute modules on the same game). WebGL2 keeps literals (its transform-feedback
  resources are isolated by shader identity); `createThreeKernelAdapter({ literalConstants: true })`
  restores literals on WebGPU for tests that pin or inspect WGSL text.
