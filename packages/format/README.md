# @nachi-vfx/format

Strict JSON assets for nachi effects. `serializeEffect()` emits the versioned
`{ format: 'nachi-effect', version: 1, effect }` envelope; `loadEffect()` validates and returns an
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
