---
'@nachi/core': minor
'@nachi/format': minor
---

Add emitter-local placement controls: `positionSphere` now supports a sampled `center` and an
area-uniform spherical-cap `arc`, while emitter definitions support an `offset` composed into the
shared emitter transform. Format v1 assets round-trip the new fields with strict validation.
