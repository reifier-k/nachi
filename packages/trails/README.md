# @nachi/trails

GPU ribbon/trail authoring and Three.js integration for nachi. Register the package's compiler
extensions with core, then use `ribbon()` and `ribbonId()` in an emitter. Birth-order storage keeps
strip ordering independent from alive compaction.

Three.js is an exact `three@0.185.1` peer for the `@nachi/trails/three` materializer.

The renderer requires WebGPU storage buffers and indirect draw; WebGL2 reports
`NACHI_RIBBON_WEBGL2_UNSUPPORTED` instead of silently selecting a different trail algorithm.
