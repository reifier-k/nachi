# @nachi/tsl-kit

Standalone Three.js TSL shader building blocks. This package does not depend on `@nachi/core` or
the nachi runtime; it works directly with ordinary Three.js `NodeMaterial` classes.

```sh
pnpm add @nachi/tsl-kit three
# TypeScript projects also need Three's separately published declarations:
pnpm add -D @types/three@0.185
```

The current compatibility range is Three.js r185 (`>=0.185.0 <0.186.0`). TSL is not yet a stable
cross-release API, so upgrade `three` and `@nachi/tsl-kit` together. The emitted declarations refer
to `three` node types; `@types/three` is therefore an optional peer for JavaScript consumers but a
required development dependency for TypeScript consumers.

## Plain Three.js example

```ts
import * as THREE from 'three/webgpu';
import { texture, uniform, uv } from 'three/tsl';
import { dissolve, polarUV, uvFlow } from '@nachi/tsl-kit';

const threshold = uniform(0.35);
const localTime = uniform(0);
const flowed = uvFlow({
  uv: polarUV({ uv: uv(), rotation: 0.2 }),
  speed: [0.15, 0],
  time: localTime,
});
const cut = dissolve({
  noiseTexture,
  uv: flowed,
  threshold,
  edgeWidth: 0.08,
  edgeColor: '#66ddff',
});

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = texture(albedoTexture, flowed).rgb;
material.emissiveNode = cut.rgb;
material.opacityNode = cut.a;
material.alphaTest = 0.5; // cut.a is binary; this performs the actual fragment cutout

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(mesh);

// Drive caller-owned time. The kit never reads wall-clock time implicitly.
localTime.value = elapsedSeconds;
threshold.value = normalizedLife;
```

All helpers accept a declarative configuration object and return a TSL node:

- `dissolve()` returns `vec4(edgeEmission, coverage)`. The threshold accepts a number or node.
- `uvFlow()` returns unwrapped scrolling UVs so the texture's wrapping mode remains authoritative.
- `polarUV()` returns `(normalizedAngle, radius)` with a configurable center and CCW rotation.
- `fresnel()` returns only the colored view-angle mask.
- `rimLight()` is the compositing preset: `baseColor + lightColor * intensity * fresnelFactor`.
- `distortionUV()` returns UVs displaced by a time-scrolled RG noise texture.
- `flowMap()` samples the supplied base map in two half-cycle-offset phases and returns blended RGBA.

`time` is always an explicit number or TSL node. Use a caller-owned `uniform()` when effect-local
time, pausing, or time scaling matters. Constant validation failures throw `TslKitDiagnosticError`
with a stable diagnostic code and parameter path.

CPU mirrors for coordinate conventions and tests are exported from `@nachi/tsl-kit/math`.
