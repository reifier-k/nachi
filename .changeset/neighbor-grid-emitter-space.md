---
'@nachi-vfx/core': minor
---

Make NeighborGrid `origin` emitter-local so bucket insertion and all neighbor lookups follow
instance translation/rotation and `EmitterConfig.offset`, while particle snapshots and distance
math remain world-space. Add dominant out-of-bounds capture diagnostics and the forward-compatible
`VFXSystemOptions.onRuntimeDiagnostic` delivery seam.
