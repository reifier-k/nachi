# @nachi/timeline

Deterministic effect-local sequencing for `@nachi/core`, including `play`/`stop`, hit stop,
decaying PCG camera shake, gameplay markers, timeline loop/speed, and automatic lifecycle binding
for `@nachi/mesh-fx` meshes.

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
