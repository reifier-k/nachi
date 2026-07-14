---
'@nachi-vfx/core': minor
'@nachi-vfx/trails': minor
---

Validate engine-independent module configuration at factory call time while retaining the same
compile diagnostics for JSON-loaded definitions. This is an intentional fail-fast behavior change:
invalid core module factories and `ribbon()`/`ribbonId()` now throw `VfxDiagnosticError`
synchronously.

Core also reports spawn-time build diagnostics through a configurable console hook, warns when a
lifetime has no age path, lowers plain TSL binding-operation literals to typed nodes, rejects invalid
binding inputs before GPU submission, and attaches emitter and kernel context to GPU submission
failures.
