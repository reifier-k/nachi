---
'@nachi/core': major
'@nachi/format': minor
---

Change the omitted `space` default for vortex, point-attractor, and analytic-collider modules to
emitter space. This is classified as a core major even though 1.0 has not yet been published; the
pre-1.0 release state does not downgrade RFC 004's breaking-change classification.

Preserve legacy version-1 asset meaning by loading omitted selectors as explicit world space and
serialize both legacy and newly authored definitions with canonical explicit selectors while
keeping the version-1 envelope.
