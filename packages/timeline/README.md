# @nachi/timeline

Deterministic effect-local sequencing for `@nachi/core`, including `play`/`stop`, hit stop,
decaying PCG camera shake, gameplay markers, timeline loop/speed, and automatic lifecycle binding
for `@nachi/mesh-fx` meshes.

Three.js is an exact `three@0.185.1` peer because timeline mesh-fx lifecycle integration shares
live Three resources with the application.

```ts
import { curve, defineEmitter } from '@nachi/core';
import { slashArc } from '@nachi/mesh-fx';
import {
  VFXSystem,
  at,
  cameraShake,
  defineEffect,
  fxMaterial,
  hitStop,
  play,
} from '@nachi/timeline';

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

new VFXSystem(renderer, scene).spawn(skill);
```

Timeline entries and actions are plain serializable data. Raw Three meshes are stored as ephemeral
runtime resources while the effect document contains a serializable `timeline/mesh-fx` placeholder.
Use `meshFxElement(mesh, { duration })` to override the automatic one-second mesh lifetime.
`opacityOverLife` accepts the same linear core `curve()` or mesh-fx tuple form as dissolve lifetime
authoring. Timeline evaluates numeric/curve inputs from normalized mesh life and writes the result
through `material.fx.setOpacity()`; a TSL node remains a compile-time binding. Because both own the
same channel, `opacity` and `opacityOverLife` cannot be specified together.

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
