# @nachi-vfx/react

## 0.2.3

### Patch Changes

- 47eeb84: Documentation-only release. Add the effect authoring guide and Agent Skills-format skill
  (`skills/nachi-effect-authoring`: bootstrap recipe, full module catalog, and scale-based
  skill-effect production recipes), installable into consuming projects via
  `npx skills add reifier-k/nachi --skill nachi-effect-authoring`. README (EN/JA) and the
  development guide link the guide. No functional changes.
- Updated dependencies [47eeb84]
  - @nachi-vfx/core@0.2.3

## 0.2.2

### Patch Changes

- @nachi-vfx/core@0.2.2

## 0.2.1

### Patch Changes

- e0efe43: Align every public package on a single shared version line. All nine packages now form one
  Changesets fixed group (RFC 003 §1) and release together with the same version; this release
  converges `@nachi-vfx/react` (previously 0.1.1) and `@nachi-vfx/tsl-kit` (previously 0.1.0) onto
  the shared line. No functional changes.
- Updated dependencies [e0efe43]
  - @nachi-vfx/core@0.2.1

## 0.1.1

### Patch Changes

- 0379e0c: Deliver contained runtime diagnostics through a default one-line console reporter, replacement
  handler, or explicit null opt-out while retaining instance diagnostics. Core now covers GPU,
  attachment, device-loss, preparation, capacity, and readback-observed overflow sources; timeline
  delivers its own failures without duplicating child-core reports; and prepared Three light draws
  rebind light-limit warnings to their live owner. React documents and verifies mutable instance error
  observation after a resolved provider update.

  Do not let hidden preparation instances consume the one-shot late device-loss delivery intended for
  the first caller-owned spawn, and do not append diagnostic-handler failures after an instance has
  already reached the released state.

- Updated dependencies [be240d0]
- Updated dependencies [1762675]
- Updated dependencies [db962e3]
- Updated dependencies [f9e8f1d]
- Updated dependencies [14b9704]
- Updated dependencies [62aab5e]
- Updated dependencies [0379e0c]
- Updated dependencies [1d390ce]
- Updated dependencies [4097480]
- Updated dependencies [9f610d5]
- Updated dependencies [b03ac85]
  - @nachi-vfx/core@0.2.0

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

- Updated dependencies [fff9517]
- Updated dependencies [03d34f9]
- Updated dependencies [a173df1]
- Updated dependencies [cdd8c2e]
- Updated dependencies [deaa4f6]
- Updated dependencies [a892228]
- Updated dependencies [b4b9f22]
- Updated dependencies [a77b084]
- Updated dependencies [c7275f3]
  - @nachi-vfx/core@0.1.0
