# @nachi-vfx/mesh-fx

Procedural effect meshes and a declarative Three.js `NodeMaterial` factory. The package is
standalone: it depends on `@nachi-vfx/tsl-kit` and Three.js, but not `@nachi-vfx/core`.

```ts
import { fxMaterial, polarUV, slashArc } from '@nachi-vfx/mesh-fx';

const material = fxMaterial({
  color: '#66ddff',
  map: effectTexture,
  uv: polarUV().flow({ speed: [0.35, 0] }),
  dissolve: {
    texture: noiseTexture,
    overLife: [
      [0, 0],
      [1, 1],
    ],
    edgeColor: '#ffffff',
    edgeIntensity: 0.8,
    edgeModulate: 'map',
    uv: 'static',
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
material.fx.setOpacity(0.6);
scene.add(arc);
```

Factories include `slashArc`, `ring`, open `cylinder`, open `cone`, and `magicCircle`. The matching
`create*Geometry` exports are useful when mesh ownership belongs to an application. `slashArc` and
`ring` expose angle/radius UVs; `cylinder` and `cone` expose circumference/height UVs. `magicCircle`
uses centered Cartesian primary UVs for `polarUV()` and publishes concentric angle/radius islands
as `uv1`.

`fxMaterial` creates writable time and normalized-life uniforms when they are omitted. A numeric or
omitted `opacity` likewise creates a writable opacity uniform; a TSL opacity node is composed at
compile time instead, and `setOpacity()` rejects mutation. Pass TSL nodes through `time` and
`normalizedLife` for standalone externally owned bindings. The
`@nachi-vfx/timeline` adapter drives its effect-local clock through the writable controls, so timeline
materials must omit `time`; no wall clock is read implicitly.

By default, `dissolve` samples the same authored UV as `map`, preserving the original composition.
Set `dissolve.uv: 'static'` for the geometry's unmodified UV, or provide a separate `polarUV()` /
`uvFlow()` authoring value. `edgeIntensity` scales edge emission, while `edgeModulate: 'map'`
multiplies it by map luminance (`map` is required); both default to the previous unmodulated edge.

For a stable hold phase, put the dissolve hold threshold below the minimum value of the noise
texture, so a bright edge contour does not remain across the mesh. Match noise frequency to mesh
scale: large meshes need correspondingly finer noise, while small meshes need coarser noise to keep
the same apparent feature size.

Three.js is an exact `three@0.185.1` peer. The package is ESM-only and declares
`sideEffects: false`.

## Geometry ownership with timeline clones

Procedural mesh factories return an application-owned mesh, geometry, and material. When that mesh
is adapted by `@nachi-vfx/timeline`, timeline clones the mesh object and material controls but keeps
the exact same `BufferGeometry` reference. Geometry is therefore an immutable borrowed resource:
attribute, index, group, bounding-volume, or `drawRange` mutation through either the source or any
clone is immediately visible to every other clone.

The application/resource owner must keep the geometry alive while the source definition or any
timeline instance can use it, and call `geometry.dispose()` only after all such instances and any
retained prepared object have been released. Timeline release/error cleanup disposes each cloned
material, but never the borrowed geometry or the source mesh/material. Do not dispose geometry from
an instance lifecycle callback; if mutable per-instance geometry is required, manage separate
application-owned resources outside this shared timeline adapter contract.

## Blender VAT runtime

`applyVat()` applies a one-frame-per-row Vertex Animation Texture to any single Three.js
`NodeMaterial` mesh. It creates a writable standalone time uniform when `time` is omitted, or accepts
an externally owned TSL clock for effect-local playback.

```ts
import { applyVat } from '@nachi-vfx/mesh-fx';

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

`applyVat()` also retains internal, cloneable binding metadata for the timeline adapter. A timeline
clone rebuilds graph-reachable VAT layers in order instead of trusting Three's generic NodeMaterial
clone, which can alias the source VAT graph. Position reachability starts at the latest `absolute`
layer, or the first layer when all are offsets; normal reachability is the latest layer that supplies
a normal texture. Their ordered, de-duplicated union owns the active controls. Package-owned VAT
clocks become independent uniforms for the source and every clone; position/normal textures and
explicit external TSL clock nodes keep their normal shared-reference ownership. A current
package-owned source time is snapshotted when the clone is created, then timeline `play()` resets the
clone to element-local time zero. Detached metadata is compacted without disposing caller-owned
textures or controls, and clone rebuild skips detached graphs entirely.

Clone metadata remains active per channel only while the mesh still uses the material and the exact
position or normal root installed by `applyVat()`. Replacing a final root after VAT application makes
that channel an externally authored, shared clone binding; timeline neither rebuilds its detached VAT
graph nor writes its detached clock. The other channel remains independently active. Replacing only
the normal root between calls preserves the accumulated VAT position layers, while replacing the
position root starts a new VAT chain from that authored root. Replacing both roots or the material
leaves no stale timeline-owned VAT clock. Mutating inside an unchanged root object is not detectable;
replace the root reference when transferring ownership.

Standalone behavior is unchanged: `controls.setTime()` validates a non-looping clip's authored time
range, and external numeric/TSL clocks remain non-writable. Timeline uses a package-internal writer
that still requires a finite, non-negative element-local time but permits the element to outlive a
non-looping clip; the VAT shader then holds its final frame. VAT textures are always caller-owned:
timeline release, failed clone/prepare, and retained preparation never dispose them.
