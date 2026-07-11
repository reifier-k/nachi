# @nachi/mesh-fx

Procedural effect meshes and a declarative Three.js `NodeMaterial` factory. The package is
standalone: it depends on `@nachi/tsl-kit` and Three.js, but not `@nachi/core`.

```ts
import { fxMaterial, polarUV, slashArc } from '@nachi/mesh-fx';

const material = fxMaterial({
  color: '#66ddff',
  uv: polarUV().flow({ speed: [0.35, 0] }),
  dissolve: {
    texture: noiseTexture,
    overLife: [
      [0, 0],
      [1, 1],
    ],
    edgeColor: '#ffffff',
  },
  fresnel: { color: '#2aa8ff', power: 2 },
  blending: 'additive',
});

const arc = slashArc({
  angle: 140,
  radius: 1.2,
  innerRadius: 0.6,
  taper: 0.8,
  segments: 48,
  material,
});

material.fx.setTime(2);
material.fx.setNormalizedLife(0.4);
scene.add(arc);
```

Factories include `slashArc`, `ring`, open `cylinder`, open `cone`, and `magicCircle`. The matching
`create*Geometry` exports are useful when mesh ownership belongs to an application. `slashArc` and
`ring` expose angle/radius UVs; `cylinder` and `cone` expose circumference/height UVs. `magicCircle`
uses centered Cartesian primary UVs for `polarUV()` and publishes concentric angle/radius islands
as `uv1`.

`fxMaterial` creates writable time and normalized-life uniforms when they are omitted. Pass TSL
nodes through `time` and `normalizedLife` to bind an effect-local clock instead. M9 will supply the
timeline adapter; no wall clock is read implicitly.

Three.js is a peer dependency pinned to the r185 compatibility line. The package is ESM-only and
declares `sideEffects: false`.
