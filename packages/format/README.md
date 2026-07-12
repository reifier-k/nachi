# @nachi/format

Strict JSON assets for nachi effects. `serializeEffect()` emits the versioned
`{ format: 'nachi-effect', version: 1, effect }` envelope; `loadEffect()` validates and returns an
ordinary normalized core definition. Migration steps and external emitter inheritance are explicit.

```ts
const document = serializeEffect(effect);
const loaded = loadEffect(document, { resolveAsset });
```

Format-owned structures reject unknown fields and non-JSON values with path-specific diagnostics.
Inline TSL/functions and live engine resources must be replaced by registered or asset references.
