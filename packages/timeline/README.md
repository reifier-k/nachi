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
