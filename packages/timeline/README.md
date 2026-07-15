# @nachi-vfx/timeline

Deterministic effect-local sequencing for `@nachi-vfx/core`, including `play`/`stop`, hit stop,
decaying PCG camera shake, gameplay markers, timeline loop/speed, and automatic lifecycle binding
for `@nachi-vfx/mesh-fx` meshes.

Three.js is an exact `three@0.185.1` peer because timeline mesh-fx lifecycle integration shares
live Three resources with the application.

`timelineSystem.update()` uses the same optional wall-clock contract as core: the first omitted call
advances zero, later measured deltas default to a 0.25-second cap, a positive
`maxMeasuredDeltaSeconds` changes it, and `Infinity` disables it. Explicit deltas bypass the cap.
Timeline owns this measurement and its optional fixed-step accumulator, then sends explicit action/
loop/mesh/VAT boundary segments to core. Its cumulative `measuredDeltaDroppedSeconds`,
`fixedStepDroppedSeconds`, and `droppedSeconds` getters therefore report each discard once. See
[RFC 001](../../docs/rfc/001-api.md) for clock mixing and FIFO invocation semantics.

Timeline accepts core's `onRuntimeDiagnostic` option. Omission reports timeline-owned validation,
action/callback, attachment/update, boundary, companion, cleanup, and mesh-preparation diagnostics
as one-line console messages; a function replaces delivery and `null` disables it. Diagnostics are
still retained on the timeline instance. Core emitter children use the same option through the
inner core system; when timeline copies an already delivered child failure into its own diagnostic
list, it does not deliver it a second time. A throwing handler is contained and reported as
`NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED` without rejecting the frame update.

```ts
import { curve, defineEmitter } from '@nachi-vfx/core';
import { slashArc } from '@nachi-vfx/mesh-fx';
import {
  VFXSystem,
  at,
  cameraShake,
  defineEffect,
  fxMaterial,
  hitStop,
  play,
} from '@nachi-vfx/timeline';

const arc = slashArc({
  angle: 140,
  material: fxMaterial({
    dissolve: { texture: noise, overLife: curve([0, 0], [1, 1]) },
    opacityOverLife: curve([0, 0.8], [0.7, 0.8], [1, 0]),
  }),
});
const skill = defineEffect({
  elements: { arc, sparks: defineEmitter(/* ... */) },
  timeline: [at(0.05, play('arc'), cameraShake({ strength: 0.3 }), hitStop(40))],
});

const instance = new VFXSystem(renderer, scene).spawn(skill);
instance.setUserVisible('arc', false);
```

Timeline entries and actions are plain serializable data. Raw Three meshes are stored as ephemeral
runtime resources while the effect document contains a serializable `timeline/mesh-fx` placeholder.
Use `meshFxElement(mesh, { duration })` to override the automatic one-second mesh lifetime.
`opacityOverLife` accepts the same linear core `curve()` or mesh-fx tuple form as dissolve lifetime
authoring. Timeline evaluates numeric/curve inputs from normalized mesh life and writes the result
through `material.fx.setOpacity()`; a TSL node remains a compile-time binding. Because both own the
same channel, `opacity` and `opacityOverLife` cannot be specified together.

At `spawn()`, each timeline mesh receives an independent material graph and package-owned uniforms,
then snapshots the source material's current Three.js `MeshBasicMaterial` state. This includes the
current value written through `fx.setOpacity()` plus ordinary render state such as `side`, depth and
stencil controls, blending, `colorWrite`, clipping planes, `name`, and a deep copy of `userData`.
Later changes to the source or another instance do not change that snapshot. Textures and other
externally owned resources retain Three's normal shared-reference clone semantics.

Meshes configured with `applyVat()` receive the same clone and lifecycle treatment. Timeline
rebuilds the source's ordered graph-reachable VAT layers after material cloning, preserving an
existing pre-VAT position node and avoiding both fxMaterial graph loss and generic NodeMaterial
graph/uniform aliasing. Reachable controls are the ordered unique union of position layers from the
latest `absolute` layer onward and the latest normal-producing layer. An older clock survives only
when its normal remains the final normal; clocks represented by neither final channel are not cloned
or driven. Omitted VAT `time` creates one independent package-owned clock per clone;
its current source value is part of the spawn/prepare snapshot, and every mesh `play()` resets it to
zero. While the element is playing, timeline writes seconds since that latest play from the same
scaled segment delta used by mesh life. Time scale zero, hit stop, explicit stop, natural expiry,
and completed/stopped instances therefore freeze it; loop replay and a fresh instance restart at
zero. This VAT clock is separate from `material.fx.time`, which keeps its established effect-local
timeline clock, and from `fx.normalizedLife`.

VAT ownership is tracked independently for the position and normal root references. If authoring
code replaces either final root after `applyVat()`, timeline preserves that current root as an
external shared clone binding, does not resurrect the detached VAT graph, and drives only controls
still represented by the other active channel. Replacing both roots or the material yields no stale
VAT controls. Between `applyVat()` calls, replacing only normal keeps the existing VAT position
layers active; replacing position starts a new chain from that authored root. In-place mutation below
an unchanged root cannot be observed, so ownership transfer requires replacing the root reference.

An explicit numeric or TSL `VatConfig.time` remains externally owned and non-writable. Timeline
clones retain that exact external binding, never write it, and emit no binding diagnostic. For an
owned non-looping VAT whose element duration exceeds the clip, the internal lifecycle writer allows
elapsed time past the standalone `setTime()` range and the shader holds the last frame; standalone
validation is unchanged. Textures remain externally owned shared references and are never disposed
by timeline clone, prepare, error, or release cleanup.

`instance.setUserVisible(meshKey, visible)` controls an adapted mesh-fx element without competing
with timeline lifecycle writes. Final visibility is `runtimeVisible && userVisible`; the user value
defaults to `true` and persists through play, stop, natural expiry, loop replay, and transform
updates. Setting it back to `true` returns control to the current runtime state. A non-mesh/unknown
key throws `RangeError`, a non-boolean value throws `TypeError`, and released instances retain the
usual released-instance guard. Each newly spawned instance starts again with `userVisible=true`.
Direct assignment to the cloned `Object3D.visible` field is not a persistent override: the next
visibility publication from `setUserVisible()`, play, stop, expiry, or loop replay may overwrite it.
Always use `setUserVisible()` for user-owned visibility.

Each emitter `play()` action spawns an independent single-element core instance. Renderer
integrations can capture the exact `VfxEmitterRuntimeView` from `event.emitter` in
`TimelineEffectInstance.onAction()`; the field is undefined for mesh-fx and non-play actions.
A captured view is invalid after its child emitter is released; pooled storage may then be reused,
so retaining and using the view can alias a later emitter.

`await timelineSystem.prepare(skill, options)` enumerates each emitter and mesh-fx resource once,
without walking timeline entries or advancing local/world time. It uses the same stable
single-element core definitions as later `play()` actions, so prepared kernels are checked out by
the first real play. Timeline duration, delayed entries, and loop count do not increase preparation
work. Pass a Three effect preparer to include mesh-fx and renderer draw compilation.

Preparation uses the same geometry borrow and cloned-material boundary as playback. A non-retained
success, preparer throw, or abort disposes the temporary cloned material while preserving the source
material and shared geometry. Returning `{ retained: true }` transfers the detached clone and its
material to the preparer; that owner must dispose the cloned material when its retained pipeline is
released. The retained consumer must not dispose the borrowed geometry—the application/resource
owner keeps it alive until the definition, every playback clone, and every retained prepared object
are finished, then disposes the geometry once.

Timeline-external core effects such as socket-following trails can subscribe to the same controls:

```ts
const timelineInstance = timelineSystem.spawn(skill);
const trailInstance = trailSystem.spawn(trail);
timelineInstance.bindCompanion(trailInstance);

// Advance a separate companion system first with the same world delta. A hit-stop action reached
// by the following timeline update then starts at the same frame boundary on both instances.
await trailSystem.update(delta);
await timelineSystem.update(delta);
```

`bindCompanion()` immediately synchronizes the effective timeline time scale and any remaining hit
stop, then forwards later `setTimeScale()` and hit-stop replacements synchronously. Companion and
timeline systems must receive the same world-step sequence. Advancing the companion first prevents
a full-frame-late stop, but exact local-time equality additionally requires the hit-stop action to
align with a companion update boundary. A non-aligned action can differ by less than one companion
update interval because only the timeline sub-segments its update.

For a page-driven socket trail, latch the socket pose from the last completed companion update when
the hit-stop action fires. Keep driving that pose while parent local time is stopped, then release
the latch only after parent local time advances. The next non-stopped companion update consumes the
whole catch-up transform, allowing per-distance interpolation to fill the path instead of H1-7
correctly discarding movement observed during a zero-local-delta step. See
[RFC 005 §3.1](../../docs/rfc/005-effect-local-clock.md#31-bindcompanion-phase-limit-and-socket-driving).

Binding overwrites the companion's current time scale and remaining hit stop. The binding does not
make those controls exclusive: later direct companion writes and timeline forwards are
last-writer-wins. `unbindCompanion()` stops forwarding without resetting the last values. Bindings
are weak and released companions are removed automatically. Error/released companions receive no
forwarded operation; invalid binds and bound companions entering error add
`NACHI_TIMELINE_COMPANION_UNAVAILABLE` to timeline diagnostics.
