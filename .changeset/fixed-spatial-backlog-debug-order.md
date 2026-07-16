---
'@nachi-vfx/core': minor
'@nachi-vfx/timeline': patch
---

Discard per-distance transform history whenever a core- or timeline-owned fixed-step accumulator
drops excess time, while keeping retained rate substeps and subsequent movement continuous. Debug
attribute capture also adds opt-in `order: 'physical-slot'` sorting before pagination; the default
compaction order and its allocation behavior remain unchanged.

Fixed-step drop latching now uses per-advance metadata even after cumulative counters lose numeric
precision, fixed intervals must exceed `1e-10` seconds, and debug capture rejects non-enum orders or
out-of-capacity physical membership instead of fabricating zero-valued rows.

Fixed-step ceilings must remain finite, and huge finite deltas are partitioned with remaining-capacity
arithmetic so frame-local and cumulative drop accounting never becomes `NaN`.
