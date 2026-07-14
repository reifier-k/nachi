---
'@nachi-vfx/timeline': patch
---

Keep an emitter element's final local time in `getElementState()` after it completes, matching the
existing mesh-element behavior instead of resetting completed emitters to zero.
