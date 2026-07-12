# @nachi/react

Thin React Three Fiber bindings for `@nachi/core`. React, R3F, and Three.js are peer dependencies;
the package does not create a second renderer or VFX runtime.

```tsx
<Canvas>
  <VFXSystemProvider renderer={runtimeRenderer}>
    <VFXEffect definition={sparks} position={[0, 1, 0]} />
  </VFXSystemProvider>
</Canvas>
```

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
