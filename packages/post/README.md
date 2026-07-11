# @nachi/post

Composable screen-space effects for Three.js r185's TSL `RenderPipeline`. The package provides
shockwave and heat-haze distortion, radial blur, and bloom presets without depending on
`@nachi/core`.

```sh
pnpm add @nachi/post three
# TypeScript projects also need Three's separately published declarations:
pnpm add -D @types/three@0.185
```

The supported peer range is `three >=0.185.0 <0.186.0`. Post nodes are sensitive to Three's TSL
API, so upgrade Three and this package together.

## RenderPipeline integration

```ts
import { bloomPreset, createPostPipeline, radialBlur, screenDistortion } from '@nachi/post';

const post = createPostPipeline(renderer, scene, camera, {
  distortion: screenDistortion({
    shockwaves: [
      {
        center: [0.5, 0.5],
        radius: 0.05,
        ringWidth: 0.04,
        strength: 0.025,
        speed: 0.6,
        duration: 0.8,
      },
    ],
    heatHaze: [
      {
        center: [0.5, 0.35],
        size: [0.45, 0.3],
        strength: 0.008,
      },
    ],
  }),
  radialBlur: radialBlur({ center: [0.5, 0.5], strength: 0.12, samples: 8 }),
  bloom: bloomPreset('soft'),
});

function frame(localTime: number) {
  post.controls.setTime(localTime);
  post.render(); // use this instead of renderer.render(scene, camera)
}
```

The default order is `distortion -> radialBlur -> bloom`. Supply `order`, for example
`['bloom', 'distortion', 'radialBlur']`, to choose another permutation. Every configured pass must
appear exactly once.

`soft`, `intense`, and `cinematic` bloom presets wrap Three r185's `BloomNode`. Overrides can tune
`strength`, `radius`, `threshold`, and internal `resolutionScale`.

## Time and effect-driven distortion

Omitting `screenDistortion.time` creates a package-owned uniform writable through
`post.controls.setTime()`. Supplying a number creates a fixed clock, and supplying a TSL node uses
an externally owned clock; the setter rejects both explicit forms. This is the same standalone
uniform/external-node split used by `fxMaterial`.

Every shockwave and heat-haze field also accepts a number/tuple or a TSL node. Numeric fields become
package-owned uniforms and can be updated with `setShockwave()` or `setHeatHaze()`. A node remains
externally owned. Nachi effects should pass their `User.*` uniform nodes for hit position, radius,
width, strength, and enable state. The gameplay hit already knows those values, so this connection
does not read particle storage back to the CPU. GPU particle readback is deliberately not a hidden
fallback; high-density distortion particles will require a future dedicated distortion buffer.

All coordinates, sizes, radii, widths, strengths, and blur distances are normalized screen UV
units. Shockwaves travel as `radius + speed * (time - startTime)` and fade over `duration`.
Heat-haze regions are axis-aligned rectangles with a feathered edge and deterministic procedural
value noise. Its smoothly interpolated lattice produces low-frequency wobble rather than
pixel-to-pixel white noise. Distortion and multi-sample radial-blur UVs use an inset
`[0.001, 0.999]` clamp.

## Offscreen rendering

The pipeline renders into the renderer's currently selected target. Headless WebGPU must select an
offscreen `RenderTarget`, call `post.render()`, and use `readRenderTargetPixelsAsync()`; do not
present the WebGPU canvas. Use `outputColorTransform: false` when measuring linear pixel thresholds.
