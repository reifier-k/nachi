---
'@nachi/core': patch
'@nachi/three': minor
'@nachi/trails': minor
'@nachi/timeline': minor
---

Add persistent user visibility controls to Three sprite, mesh, decal, light-pool, and ribbon
materialization results. Runtime culling/lifecycle visibility is now explicitly composed with the
default-true user override, so existing draws retain their behavior while `setUserVisible()` is an
additive public API. Core receives a patch because its existing renderer bridge signature is
unchanged and only clarifies that `setVisibility` publishes the runtime-owned component; the Three
and trails packages receive minors for their new public methods.

Add `TimelineEffectInstance.bindCompanion()` and `unbindCompanion()` as additive timeline APIs.
Bound core instances receive effective time-scale and hit-stop changes synchronously, including
state at bind time. Weak bindings automatically discard released instances and gate every transfer
to error-state companions. Invalid binds and companions entering error report
`NACHI_TIMELINE_COMPANION_UNAVAILABLE`; direct companion controls and timeline forwarding use
documented last-writer-wins semantics. This is a timeline minor; the larger public clock-source
proposal is documented separately and remains unimplemented.
