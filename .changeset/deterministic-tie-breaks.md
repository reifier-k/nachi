---
'@nachi-vfx/core': minor
'@nachi-vfx/three': minor
---

Use numeric effect creation order for equal-significance budgets and equal-depth coarse alpha
ordering, and canonicalize routing between multiple event producers and one target. Equal-priority
light candidates now use logical particle spawn order instead of physical storage slots; light
selection statistics expose that spawn order. These changes affect exact ties and saturated event
or light winner selection while keeping public effect IDs compatible. The coarse-sort helper uses
numeric sequence ties only when every entry provides a safe integer, otherwise preserving its
stable-key ordering for the whole collection.

Compile historical five-read light-renderer manifests with the current `spawnOrder` dependency so
old effect JSON materializes the same deterministic light schema and draw instead of silently
dropping it.
