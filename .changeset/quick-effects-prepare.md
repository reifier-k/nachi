---
'@nachi/core': minor
'@nachi/timeline': minor
'@nachi/three': minor
'@nachi/post': minor
---

Add resource-oriented effect preparation APIs. Core and timeline systems can now compile compute,
draw, grid, and mesh-fx resources without advancing effect time; the Three integration supplies a
retained draw-pipeline preparer with custom draw handlers, and post pipelines can prepare their
scene/post graph against the live output context. Preparation supports progress reporting and
abort signals.
