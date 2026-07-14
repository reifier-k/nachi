# @nachi-vfx/trails

GPU ribbon/trail authoring and Three.js integration for nachi. Register the package's compiler
extensions with core, then use `ribbon()` and `ribbonId()` in an emitter. Birth-order storage keeps
strip ordering independent from alive compaction.

Three.js is an exact `three@0.185.1` peer for the `@nachi-vfx/trails/three` materializer.

The renderer requires WebGPU storage buffers and indirect draw; WebGL2 reports
`NACHI_RIBBON_WEBGL2_UNSUPPORTED` instead of silently selecting a different trail algorithm.

`materializeThreeRibbonDraw()` returns a draw with `dispose(renderer?)`. Reuse that mesh while its
emitter is alive, or call `dispose()` before replacing it. Ribbon draws participate in the official
Three runtime's visibility, render-order, profiling, pooling, and kernel-release lifecycle; a draw
must not be rendered after its effect instance is released.

Use `draw.setUserVisible(false)` to hide a ribbon independently of runtime culling and
`draw.setUserVisible(true)` to return to runtime visibility. The final rule is
`runtimeVisible && userVisible`, with `userVisible` defaulting to `true`. Assigning
`draw.mesh.visible` directly is not persistent because the Three runtime owns that field.
