---
'@nachi/core': minor
---

Key all core Init randomness, including `positionSphere`, `positionMeshSurface`, `velocityCone`,
`lifetime(range(...))`, and ranged attribute defaults, by deterministic particle `spawnOrder`
instead of physical free-list slot identity. Recycled slots now receive fresh samples and identical
seeds remain reproducible when parallel death compaction changes free-list reuse order.

This intentionally changes concrete random values—and therefore rendered appearance—for emitters
whose Init modules use random distributions. Screenshot and other visual baselines may need to be
recorded again even though the authored distributions and seeds are unchanged.
