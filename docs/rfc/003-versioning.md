# RFC 003: Versioning, compatibility, and deprecation

> Language: English (this page) / [日本語](./003-versioning.ja.md)

- **Status:** Adopted for the heavily experimental 0.1 line; the 1.0 stability contract remains proposed
- **Scope:** All public `@nachi/*` packages and the `nachi-effect` asset format
- **Normative references:** [RFC 001](./001-api.md), especially §12, §13, and §16

## 1. Version lines and the meaning of 1.0

Nachi packages use Semantic Versioning and remain independently versioned. A package's `0.x`
line is an implementation and contract-development line: minor releases may contain breaking
changes when a changeset identifies them. Moving a package from `0.x` to `1.0.0` means that every
export reachable through that package's `exports` map is covered by the compatibility contract in
this RFC unless it is explicitly marked experimental.

`1.0.0` does not mean feature parity without the residuals in the FA parity report. It means the
documented code-first surface, structured diagnostics, and version-1 asset documents can be relied
on according to the rules below. Unsupported RFC 001 §16 capabilities do not become implied by the
version number.

The initial changeset requests `minor` for all packages while they are still `0.0.0`, producing the
coordinated `0.1.0` release plan. Version 0.1.0 is a heavily experimental preview and does not grant
the 1.0 compatibility contract. The release owner applies that plan after FA; this RFC does not
perform a version bump.

## 2. Package SemVer policy

- **Patch:** fixes that preserve documented types and behavior, performance improvements without a
  semantic change, documentation, and additional validation of inputs that were already invalid.
- **Minor:** additive exports, optional configuration fields, new modules/actions/diagnostics, and
  expanded backend support whose defaults preserve existing behavior.
- **Major:** any breaking change defined in §3. Each independently versioned package receives the
  required bump. A dependent package also bumps when its public types or runtime compatibility
  range must change.

For pre-1.0 packages, breaking changes use a `minor` changeset so the resulting numeric version
stays on the `0.x` line; compatible fixes use `patch`. The changeset text must still identify the
change as breaking and describe its user-observable impact. After 1.0, the classifications above
map directly to patch, minor, and major releases.

## 3. Breaking changes

The following are breaking after 1.0:

1. Removing, renaming, or changing the type/meaning/default/order of a public export, option,
   module stage, lifecycle transition, clock boundary, or backend fallback documented by RFC 001.
2. Tightening a supported input domain, resource limit, peer range, or browser/backend requirement
   so that previously valid programs fail, unless the old behavior was a documented security or
   correctness defect and the release notes provide the exception rationale.
3. Removing or renaming a structured `NACHI_*` diagnostic code, or changing its documented phase,
   severity, path semantics, or trigger so consumers can no longer handle the same failure. Adding
   a new code is additive; splitting an existing code requires preserving the old code through the
   deprecation window or a major release.
4. Changing a serialized module/config `version` or the `nachi-effect` envelope incompatibly,
   ceasing to load a supported asset version, or removing a migration path. Asset-format changes
   additionally follow §4; a package major alone never silently reinterprets an old document.
5. Changing deterministic results for the same documented seed, definition, timestep partition,
   backend, and physical-slot order, except where RFC 001 explicitly leaves the result
   nondeterministic or adapter-dependent.

Internal files that are not reachable through a package `exports` map, playground DOM datasets,
generated reports, and test helpers are not public API. Public low-level compiler/runtime exports
are covered even when most users consume higher-level helpers.

## 4. Asset-format versioning

Package versions and asset versions are separate axes. The current envelope is:

```ts
{ format: 'nachi-effect', version: 1, effect: /* closed declarative data */ }
```

Adding optional fields that old readers can reject safely may ship in a package minor, but writers
must not emit them as version 1 if that would make the same version ambiguous across readers. Any
incompatible shape or meaning increments the envelope/module format version and supplies an
explicit one-step migration in `EffectAssetMigrationRegistry`. Readers never guess, silently drop
unknown fields, or reinterpret version 1. A supported reader continues to accept version 1 for the
lifetime of the package major; removal requires a package major and release-note migration plan.

The version-1 limitation recorded in RFC 001 remains normative: inline functions require a
registration/reference boundary, and simulation-cache embedding is not part of the envelope.

## 5. Experimental API

The complete 0.1 line is **heavily experimental**. No public export should be treated as
production-ready or as carrying the future 1.0 compatibility contract. Code-only TSL scratch
surfaces (`tslModule()`, `gridTslModule()`, `grid3DTslModule()`, and
`neighborGridTslModule()`) are escape hatches, but the same pre-1.0 release policy applies to them.

RFC 001 §16 items are deferred capabilities, not experimental promises. At or after 1.0, an API
that remains experimental must be visibly exported through an `experimental` subpath or use an
`unstable_` prefix, carry an `@experimental` documentation tag, and be listed here. Experimental
APIs may change in a minor release, but their removal still requires release notes and at least one
minor release of notice when practical.

## 6. Deprecation procedure

The following procedure is required after 1.0 and is a best-effort migration policy during the
heavily experimental 0.x line:

1. Record the replacement and motivation in an accepted RFC or a normative amendment to RFC 001.
2. Mark TypeScript declarations with `@deprecated`, update package/root documentation, and add a
   changeset. If runtime use is observable, emit one structured warning per owning instance/system;
   never warn per particle or frame.
3. Preserve behavior for at least one minor release and, for widely used surfaces, one normal
   release cycle. Provide a mechanical migration example when names or data shapes change.
4. Keep diagnostic aliases and asset migrations for the same window. Deprecation must not alter
   serialized output without an asset-version decision.
5. Remove only in a major release, list the removal in `CHANGELOG.md`, and retain a clear failure or
   migration path. Security fixes may shorten the window, with the reason and impact documented.

## 7. RFC 001 §16 alignment

This policy does not settle or expose any deferred decision from RFC 001 §16. In particular it does
not promise deterministic cross-adapter allocation, full WebGL2 lifecycle parity, reverse-z/MSAA
depth ownership, multi-renderer emitters, persistent IDs, Grid volume ray marching, or Effekseer
import. Those require their recorded design/spike work before a public API can be added. Explicit
unsupported diagnostics and the parity report remain the compatibility boundary until then.
