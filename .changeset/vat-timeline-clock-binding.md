---
'@nachi-vfx/mesh-fx': minor
'@nachi-vfx/timeline': minor
---

Retain cloneable VAT binding metadata and rebuild ordered position/normal VAT layers for timeline
mesh clones. Package-owned VAT clocks now follow latest-play element-local time with independent
source/clone uniforms, while standalone writes, explicit external clocks, borrowed textures, and
existing fxMaterial lifecycle controls retain their prior contracts. Authored final node or material
replacement is preserved without reviving detached VAT graphs or stale timeline-owned clocks.
Absolute position and last-write normal composition now clone and drive only their ordered
graph-reachable control union.
