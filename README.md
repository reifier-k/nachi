# nachi

Niagara parity through a code-first, TSL/WebGPU-native VFX library for Three.js.

**Status:** M12 asset batch 1 implemented: `@nachi/format` provides the strict `nachi-effect` v1
JSON envelope, schema, serializer/loader, explicit migrations, and asset-reference emitter
inheritance. Golden #5 now runs from a JSON-loaded definition and compares its timeline actions and
GPU particle bytes with the code-authored control. M12 integration review remains a pre-alpha gate.

```ts
import { loadEffect, serializeEffect } from '@nachi/format';

const document = serializeEffect(effect);
const loaded = loadEffect(JSON.stringify(document));
```

Only the declarative subset is accepted. Inline `tslModule()` callbacks, raw Three.js resources,
class instances, functions, and cyclic graphs fail with path-specific `NACHI_ASSET_*` diagnostics;
registered function/resource references—including `tslModule(defineTslFunction(...))`—remain JSON
data.

Simulation caches use `bakeSimulation(system, effect, { frames, frameRate, compression, loop })` and
`replaySimulation(system, effect, cache)`. Assets stay loader-friendly as metadata JSON plus an
`ArrayBuffer`; only render-read attributes are recorded. Float32 and component-wise u16 quantization,
nearest/linear playback, endpoint-validated loops, time scale, play/stop, and memory estimates are
available. WebGL2 supports compatible burst baking but reports replay unsupported until its renderer
can bind restored alive indirection.

Runtime debugging uses
`await instance.debug.captureAttributes(emitterId, { attributes, offset, limit })` and
`system.debug.captureProfile({ gpuTiming })`. Attribute rows preserve alive/physical-slot and
spawn-generation/order lineage with explicit truncation metadata. Profiler GPU values reuse the
cached `nachi.perf-baseline` v1 pass timing; unavailable timestamps remain null with diagnostics.

Project references: [PLAN.md](./PLAN.md), [ROADMAP.md](./ROADMAP.md), and [CLAUDE.md](./CLAUDE.md).
