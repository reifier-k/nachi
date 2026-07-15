---
'@nachi-vfx/core': minor
---

BREAKING: upgrade simulation caches to lineage-aware format version 2. Every emitter now records a
lossless u32 `Particles.spawnOrder` stream so linear replay never interpolates a reused physical
slot and loop validation compares logical particles independently of compaction order. Version 1 and
missing-version caches are rejected and must be re-baked. The binary asset grows by four bytes per
particle slot per frame; the lineage stream does not add to ordinary per-frame replay uploads, and
emitters whose renderer does not read `spawnOrder` do not retain birth-order lifecycle overhead.
