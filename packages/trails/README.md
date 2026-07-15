# @nachi-vfx/trails

GPU ribbon/trail authoring and Three.js integration for nachi. Register the package's compiler
extensions with core, then use `ribbon()` and `ribbonId()` in an emitter. Birth-order storage keeps
strip ordering independent from alive compaction.

Three.js is an exact `three@0.185.1` peer for the `@nachi-vfx/trails/three` materializer.

The renderer requires WebGPU storage buffers and indirect draw; WebGL2 reports
`NACHI_RIBBON_WEBGL2_UNSUPPORTED` instead of silently selecting a different trail algorithm.

`ribbonId()` accepts a non-negative u32 integer or
`{ mode: 'alternating', count, offset? }`. Count is a positive u32 value, offset is non-negative,
and `offset + count - 1` must remain within u32; count `2^32` is rejected before it can wrap to zero
in the shader. `ribbon()` accepts only `stretched` or `tiled` UV mode. Compilation requires every
statically authored ID to be lower than `maxRibbons`; `NACHI_RIBBON_ID_OUT_OF_RANGE` prevents silent
strand loss. Factory and registered compiler paths share the package-owned validators.

`materializeThreeRibbonDraw()` returns a draw with `dispose(renderer?)`. Reuse that mesh while its
emitter is alive, or call `dispose()` before replacing it. Ribbon draws participate in the official
Three runtime's visibility, render-order, profiling, pooling, and kernel-release lifecycle; a draw
must not be rendered after its effect instance is released.

Use `draw.setUserVisible(false)` to hide a ribbon independently of runtime culling and
`draw.setUserVisible(true)` to return to runtime visibility. The final rule is
`runtimeVisible && userVisible`, with `userVisible` defaulting to `true`. Assigning
`draw.mesh.visible` directly is not persistent because the Three runtime owns that field.
