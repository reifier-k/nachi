# @nachi-vfx/three

The official Three.js r185 runtime adapter for `@nachi-vfx/core`. It supplies the TSL kernel adapter,
WebGPU submission bridge, Three resource resolvers, transform sources, and billboard, mesh, light,
and decal draw materializers needed to render a `VFXSystem`.

```sh
pnpm add @nachi-vfx/core @nachi-vfx/three three@0.185.1
# TypeScript projects also need Three's separately published declarations:
pnpm add -D @types/three@0.185.0
```

`three@0.185.1` is an exact peer because the adapter integrates with Three's TSL, storage-buffer,
indirect-draw, and WebGPU renderer contracts. Upgrade Three and this package together.

## Minimal billboard draw

```ts
import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  positionSphere,
} from '@nachi-vfx/core';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  disposeThreeDraw,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 5;

const adapter = createThreeKernelAdapter({ backend: 'webgpu' });
const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter);
const system = new VFXSystem(runtimeRenderer, scene);
const effect = defineEffect({
  elements: {
    sparks: defineEmitter({
      capacity: 128,
      init: [positionSphere({ radius: 0.2 }), lifetime(0.8)],
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 64 }),
    }),
  },
});

const instance = system.spawn(effect, { position: [0, 1, 0], seed: 42 });
const emitter = instance.getEmitter('sparks');
if (!emitter) throw new Error('The sparks emitter was not created.');
const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
scene.add(draw);

await system.update(1 / 60);
renderer.render(scene, camera);

// When this mesh is no longer reused by the host:
disposeThreeDraw(emitter.kernels, draw, renderer);
```

Use `createThreeTextureResolver()` for billboard/decal maps,
`createThreeGeometryResolver()` for mesh draws, and the vector-field, SDF, or mesh-surface resource
helpers for matching core modules. Light materialization returns a bounded PointLight pool whose
`update()` method is driven by the host. These APIs expose ordinary Three objects so scene
ownership, render targets, cameras, and disposal remain explicit application responsibilities.

Sprite, mesh, decal, and light materialization results expose `setUserVisible(visible)`. Final draw
visibility is `runtimeVisible && userVisible`, where runtime visibility continues to own culling,
completion, stop, and pooling transitions. The user component defaults to `true`, so existing hosts
do not change. Do not assign the returned Three object's `.visible` directly: a later runtime
visibility update overwrites that field. Use `setUserVisible(false)` for a persistent user hide and
`setUserVisible(true)` to return control to the current runtime state. Light draws apply the same
contract to their returned `group` while keeping every pooled child PointLight shader-stably
visible.

## Preparing first-use pipelines

Use `createThreeEffectPreparer()` with core or timeline `system.prepare()` to compile draw
pipelines during a loading screen instead of simulating an animation cycle:

```ts
const preparer = createThreeEffectPreparer(renderer, scene, camera, {
  // When using @nachi-vfx/post, compile draws against its internal scene-pass target.
  compileTarget: post.sceneRenderTarget,
  sprite: { resolveTexture },
});
await system.prepare(effect, { preparer, signal, onProgress });
const instance = system.spawn(effect);
const emitter = instance.getEmitter('particles');
const draw =
  (emitter && preparer.takePreparedDraw<THREE.Mesh>(emitter)) ??
  (emitter && materializeThreeSpriteDraw(emitter.program, emitter.kernels));

// The preparer retains hidden pipeline anchors until the application no longer needs the cache.
window.addEventListener('pagehide', () => preparer.dispose(), { once: true });
```

Billboard, mesh, light, and decal draws are built in. Register external draw kinds such as ribbon
through `drawPreparers`; an unregistered kind rejects preparation explicitly. `takePreparedDraw()`
transfers the exact prepared draw to the matching live emitter, including auxiliary compute nodes
used by light or custom draws. Keep the preparer alive through first use—disposing it immediately
removes any pipeline references that have not been transferred.

`compileTarget` must match the target used by the live scene render. Omitting it uses the currently
bound renderer target, which is appropriate for direct scene rendering. `@nachi-vfx/post` users should
pass `post.sceneRenderTarget`; render-pipeline cache keys include target format, sample count, and
color space. Draw preparers that add lights should return `affectsLighting: true`; built-in light
draws do this automatically so existing scene materials are compiled against that light resource.
Preparation does not enumerate combinations of independently spawned light draws; hosts that vary
the simultaneous light set should keep that set structurally stable or prepare those variants
explicitly at the application level.

## Draw and pooled-kernel lifetime

Materialized draws are registered against their `BuiltEmitterKernels` so culling, render order, and
profiling see the same object set. A host that replaces a materialized sprite, mesh, decal, light,
or ribbon MUST reuse the existing Three object or dispose/unmaterialize the old draw first.
`disposeThreeDraw(kernels, object, renderer)` unregisters a Three draw, removes it from its parent,
and releases its owned geometry, material, instance attribute, and tracked GPU attributes. Calling
`EffectInstance.release()` may move kernels into the core pool; the runtime disposes registered
draws before pooling, so a later spawn that reuses those kernels must materialize and attach a new
draw. Do not retain and render a draw after its instance has been released.

Raw logical-attribute GPU readback used by repository smokes is intentionally not exported. Runtime
debugging should use core's serialized `instance.debug.captureAttributes()` surface.
