# @nachi-vfx/react

Thin React Three Fiber bindings for `@nachi-vfx/core`. React, R3F, and Three.js are peer dependencies;
the package does not create a second renderer or VFX runtime.

```sh
pnpm add @nachi-vfx/core @nachi-vfx/three @nachi-vfx/react react@^19 @react-three/fiber@^9 three@0.185.1
pnpm add -D @types/three@0.185.0
```

```tsx
import {
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  positionSphere,
} from '@nachi-vfx/core';
import { VFXSystemProvider, useEffectInstance } from '@nachi-vfx/react';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three/webgpu';

const effect = defineEffect({
  elements: {
    sparks: defineEmitter({
      capacity: 256,
      init: [positionSphere({ radius: 0.2 }), lifetime(0.8)],
      render: billboard({ blending: 'additive' }),
      spawn: burst({ count: 80 }),
    }),
  },
});

const threeRenderer = new THREE.WebGPURenderer({ antialias: true });
await threeRenderer.init();
const kernelAdapter = createThreeKernelAdapter({ backend: 'webgpu' });
const runtimeRenderer = createThreeRuntimeRenderer(threeRenderer, kernelAdapter);

function Sparks() {
  const scene = useThree((state) => state.scene);
  const instance = useEffectInstance(effect, { position: [0, 1, 0], seed: 42 });

  useEffect(() => {
    const emitter = instance?.getEmitter('sparks');
    if (!emitter) return;
    const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
    scene.add(draw);
    return () => {
      scene.remove(draw);
      draw.geometry.dispose();
      draw.material.dispose();
    };
  }, [instance, scene]);

  return null;
}

export function App() {
  return (
    <Canvas gl={threeRenderer} camera={{ position: [0, 1, 5] }}>
      <VFXSystemProvider renderer={runtimeRenderer}>
        <Sparks />
      </VFXSystemProvider>
    </Canvas>
  );
}
```

`three@0.185.1` is an exact peer. TypeScript projects also need `@types/three@0.185.0` because Three
publishes its declarations separately.

`VFXSystemProvider` copies the active R3F camera matrices and pixel viewport to core, then calls
`system.update(delta)` from `useFrame`. Camera synchronization is enabled by default so distance and
frustum culling, significance, scene-depth effects, and transparent sorting use the rendered view;
set `syncCamera={false}` only when camera state is supplied manually. `useEffectInstance()` spawns on
mount, forwards live parameter/transform/time-scale changes, supports `attachTo` with a Three
`Object3D`, and always releases on unmount. Seed and priority are spawn-only and restart the
instance when changed. Parameter values are retained by the binding only after core validation and
forwarding succeeds. Keep `definition` at module scope (or otherwise referentially stable), because
a new reference respawns the instance. `attachTo` owns the complete live transform and overwrites
position and rotation supplied at spawn or through props on each scheduled step.
