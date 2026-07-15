---
'@nachi-vfx/core': minor
---

Key Update-stage deterministic ranges and custom `context.random()` calls by particle spawn order,
emitter seed, module/sample slot, and the actual update-dispatch ordinal. Physical free-list slot
reuse no longer changes logical particle results, while repeated Update dispatches retain temporal
variation and identical seed/schedule/step sequences remain reproducible.
