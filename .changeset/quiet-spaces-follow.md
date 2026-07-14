---
'@nachi-vfx/core': minor
'@nachi-vfx/format': minor
---

Change the omitted `space` default for vortex, point-attractor, and analytic-collider modules to
emitter space. RFC 004 classifies the semantic change as core-major, but because no public version
has been released, it is folded into the initial heavily experimental 0.1.0 release plan.

Preserve legacy version-1 asset meaning by loading omitted selectors as explicit world space and
serialize both legacy and newly authored definitions with canonical explicit selectors while
keeping the version-1 envelope.
