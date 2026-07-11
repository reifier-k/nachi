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

## Blender VAT runtime

`applyVat()` applies a one-frame-per-row Vertex Animation Texture to any single Three.js
`NodeMaterial` mesh. It creates a writable standalone time uniform when `time` is omitted, or accepts
an externally owned TSL clock for effect-local playback.

```ts
import { applyVat } from '@nachi/mesh-fx';

const vat = applyVat(mesh, {
  positionTexture, // FloatType or HalfFloatType, NoColorSpace
  normalTexture, // optional; Blender normals default to 0..1 encoding
  frameCount: 48,
  fps: 24,
  interpolation: 'linear',
  positionEncoding: 'remapped',
  positionRange: { min: -0.82, max: 1.14 },
});

vat.setTime(0.5);
vat.setFrame(20);
```

The default compatibility profile follows the Blender Extensions VAT exporter: texture X is the
vertex index, texture Y is the frame, frames are ordered top-to-bottom, positions are offsets, the
reported normalization range is one global min/max pair, normals decode from `[0, 1]`, and Blender
XYZ is sampled as Three.js XZY. This default `axisMap: 'xzy'` is the exporter's mirrored axis swap;
use `axisMap: 'xz-y'` for the right-handed Z-up to Y-up rotation `(x, z, -y)`. The generated
`vertex_anim` lookup UV is expected as `uv1`; use the explicit `vertexLookup: 'vertex-index'`
fallback only when mesh and VAT were generated in identical
vertex order. `frameOrder` defaults to `'top-to-bottom'`. It describes GPU texel-row order after
loading: load VAT textures with `texture.flipY = false`; if a loader has already flipped rows, use
the opposite `frameOrder`. Set `'bottom-to-top'` for an unmodified exporter Y-flip output.

Position VATs must be linear float/half-float textures and their width must exactly match the mesh's
position-attribute count. The v1 runtime deliberately rejects wrapped/cropped layouts and normalized
PNG position textures; convert them to a non-color float texture or export OpenEXR. Variable topology
is not representable. Dynamic VAT bounds disable frustum culling by default; applications may opt out
after supplying conservative mesh bounds.
