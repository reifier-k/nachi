---
'@nachi/core': minor
---

Fix multi-cycle burst effects whose earlier particles die while later cycles spawn. As amended in
RFC 001's emitter lifecycle contract, when `lifecycle.duration` is absent, core now derives an
active duration from the burst envelope plus statically known particle-lifetime grace, allowing
every authored cycle to fire while preserving explicit numeric durations, other lifecycle fields,
seeds, and the WebGL2 safety gate. This is an intentional behavior change for effects that omit an
explicit duration: multi-cycle bursts no longer silently stop after cycle 0. Co-authored `rate` and
`perDistance` modules on the same emitter now also emit during the derived window, whereas the
previous zero-length window suppressed them.
