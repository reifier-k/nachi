---
'@nachi-vfx/trails': patch
---

Fix a `NACHI_THREE_RENDER_ORDER_COMPOSITION_INVALID` crash when a materialized ribbon draw is
re-composed by the `@nachi-vfx/three` runtime. Ribbon draws share the kernel-owned draw registry
with three's built-in draws (both key it by the same global symbol) so ribbons ride the shared
runtime visibility/culling path, but the trails registration omitted the `base`/`offset`/`drawIndex`
fields that three's render-order composition reads from every registry entry. Draw-pool activation
or a `setRenderOrder` pass therefore threw. The ribbon registration now mirrors three's
`registerDrawObject` shape — the ribbon's absolute renderOrder as `base`, zero `offset`, and
`drawIndex` -1 to opt out of transparent draw-order rank — so the composition pass accepts ribbon
entries while preserving the shared visibility integration.
