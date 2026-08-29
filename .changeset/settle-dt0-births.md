---
'@nachi-vfx/core': patch
---

Fix particles born into a frame without an Update step being drawn with their Init values only.

An emitter activated (or re-fired by a loop, or fed by event inputs) in a frame whose emitter delta
is zero — `system.update(0)`, a timeline `hitStop()` / `instance.applyHitStop()` that lands in the
same frame as `play()`, an initialize-only fixed-step frame — encoded its burst and compacted the
alive list, but the Update kernel never ran because every step `<= TIME_EPSILON` is skipped. Every
age-derived attribute (`sizeOverLife`, `colorOverLife`, `intensityOverLife`, `rotationOverLife`,
custom `tslModule` writes) therefore stayed at its Init value until time resumed: default size,
white color, and with velocity-stretch sprites a `|v| × factor` long white streak, for as long as
the hit stop lasted.

`VFXSystem.update()` now finishes each frame with a settle pass: emitters that dispatched a spawn
batch (CPU or event-driven) since their last Update submit one zero-length Update
(`Emitter.deltaTime = 0`). Age, position and velocity are unchanged because every integrator scales
by the delta, over-life modules sample their curves at `normalizedAge = 0`, the alive set is not
recompacted, and the Update random ordinal (`Emitter.updateRandomStep`) is not consumed because no
simulation time elapsed. Frames that already stepped the emitter are untouched, so deterministic
fixed-step results and the committed golden screenshots are pixel-identical. `velocityOverLife` is
guarded to be a no-op at `deltaTime = 0` so a curve that starts at 0 still scales the birth velocity
on the first real step instead of zeroing it.

Observable side effects: one extra Update dispatch (plus neighbor-grid rebuild) on dt=0 birth
frames, and dt-independent Update modules such as PBD constraints or plane collision get one extra
application at birth.
