---
'@nachi-vfx/core': minor
'@nachi-vfx/format': minor
---

Add world/emitter selectors to velocity cones and linear forces while preserving their world-space
defaults and legacy shader output. Emitter-space Update forces, analytic colliders, and kill volumes
now share one previous/current midpoint transform sample in module version 2. Module-v1 world/current
endpoint semantics remain registered, and format loading validates and canonicalizes the new
selector fields without implicitly upgrading or changing legacy records.
