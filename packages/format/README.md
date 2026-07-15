# @nachi-vfx/format

Strict JSON assets for nachi effects. `serializeEffect()` emits the versioned
`{ format: 'nachi-effect', version: 2, effect }` envelope; `loadEffect()` validates and returns an
ordinary normalized core definition. Migration steps and external emitter inheritance are explicit.

```ts
const document = serializeEffect(effect);
const loaded = loadEffect(document, {
  resolveAsset,
  grid2DStageRegistry,
  grid3DStageRegistry,
});
```

Format-owned structures reject unknown fields and non-JSON values with path-specific diagnostics.
Inline TSL/functions and live engine resources must be replaced by registered or asset references.
Built-in grid-stage source strings are checked against the core vocabulary, and serialized custom
grid-stage references must resolve in the matching registry passed to `loadEffect()`.

Timeline actions use the authoring invariants: hit-stop duration/scale are non-negative,
camera-shake strength/duration are non-negative and frequency is positive, and marker names are
non-empty. The exported JSON schemas publish those bounds, while validation/loading retain
path-specific `NACHI_ASSET_TIMELINE_*` diagnostics.

The default v1 → v2 migration changes only the envelope version and never upgrades module versions.
Historical renderer module-v1 configs retain generic payload validation and their old compiler
meaning. Renderer module-v2 billboard, mesh, and decal configs are closed recursively, including
alignment, asset references, flipbooks, lighting, soft-particle, and cutout objects. A renderer-v2
module placed in an actual render slot of a v1 envelope is rejected before migration, preventing an
old generic config from being silently reinterpreted; renderer-shaped values inside opaque module
config payloads remain untouched. The v1 schema/type stay exported for explicit migration tooling.
