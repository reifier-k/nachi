# @nachi/three

The official Three.js r185 runtime adapter for `@nachi/core`. It supplies the TSL kernel adapter,
WebGPU submission bridge, Three resource resolvers, transform sources, and billboard, mesh, light,
and decal draw materializers needed to render a `VFXSystem`.

```sh
pnpm add @nachi/core @nachi/three three@0.185.1
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
} from '@nachi/core';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  disposeThreeDraw,
  materializeThreeSpriteDraw,
} from '@nachi/three';
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
