# @nachi-vfx/tsl-kit

## 0.2.3

### Patch Changes

- 47eeb84: Documentation-only release. Add the effect authoring guide and Agent Skills-format skill
  (`skills/nachi-effect-authoring`: bootstrap recipe, full module catalog, and scale-based
  skill-effect production recipes), installable into consuming projects via
  `npx skills add reifier-k/nachi --skill nachi-effect-authoring`. README (EN/JA) and the
  development guide link the guide. No functional changes.

## 0.2.2

## 0.2.1

### Patch Changes

- e0efe43: Align every public package on a single shared version line. All nine packages now form one
  Changesets fixed group (RFC 003 §1) and release together with the same version; this release
  converges `@nachi-vfx/react` (previously 0.1.1) and `@nachi-vfx/tsl-kit` (previously 0.1.0) onto
  the shared line. No functional changes.

## 0.1.0

### Minor Changes

- a173df1: Release the complete independently versioned nachi package set as the heavily experimental 0.1.0
  preview. The initial public
  surface includes the staged GPU particle runtime, strict versioned assets, simulation caches and
  data interfaces, timeline and trail composition, TSL/mesh/post rendering tools, the public Three.js
  runtime/materialization adapter, and the React Three Fiber lifecycle binding. This release does not
  promise production readiness or API, behavior, performance, compatibility, or package-boundary
  stability. It includes documented backend residuals, package ESM/dry-run gates, and FA reporting
  contracts. This changeset records the coordinated initial release plan only; the version bump is
  intentionally left to the release owner.

### Patch Changes

- 088fd06: Bound CSS color validation work and replace ambiguous component matching to prevent malicious input
  from causing polynomial regular-expression backtracking.
