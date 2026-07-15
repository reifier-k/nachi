---
'@nachi-vfx/core': minor
'@nachi-vfx/timeline': patch
---

Keep duration-omitted `rate` and `perDistance` emitters active until they are explicitly stopped,
while preserving finite derived envelopes for burst-only emitters and explicit finite durations.
Timeline track completion now truncates and releases active children at the final boundary as well
as loop boundaries, so unbounded continuous children cannot keep a completed track alive.
