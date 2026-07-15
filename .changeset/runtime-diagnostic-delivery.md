---
'@nachi-vfx/core': minor
'@nachi-vfx/three': minor
'@nachi-vfx/timeline': minor
'@nachi-vfx/react': patch
---

Deliver contained runtime diagnostics through a default one-line console reporter, replacement
handler, or explicit null opt-out while retaining instance diagnostics. Core now covers GPU,
attachment, device-loss, preparation, capacity, and readback-observed overflow sources; timeline
delivers its own failures without duplicating child-core reports; and prepared Three light draws
rebind light-limit warnings to their live owner. React documents and verifies mutable instance error
observation after a resolved provider update.
