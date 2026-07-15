# RFC 006: Transparent draw ordering and decal spawn orientation

> Language: English (this page) / [日本語](./006-transparent-draw-order.ja.md)

- **Status:** Accepted and implemented for H2-7
- **Scope:** `@nachi-vfx/core`, `@nachi-vfx/three`, `@nachi-vfx/format`, and versioned
  `nachi-effect` assets
- **Normative references:** [RFC 001](./001-api.md) §9.4, §9.5, and §13;
  [RFC 003](./003-versioning.md) §2–§4

## 1. Problem and normative goals

Alpha and premultiplied-alpha composition is order dependent. An unsorted Nachi draw reads M2's
atomic compact-alive array directly, so physical free-list allocation, death, and reuse can change
the visible order without changing the authored particle identities. M10 made per-particle sorting
opt-in, gave projection decals no sorted path, wrote depth from transparent mesh particles, and
replaced every registered Three object's `renderOrder` with `1000 + rank`.

This RFC replaces that contract. New alpha and premultiplied billboard, mesh, and decal helpers
default to per-particle sorting; explicit opt-out remains available and explicitly
nondeterministic. Transparent meshes do not write depth. Host order and automatic coarse order are
composed, never substituted. New decals capture emitter orientation at spawn. Old module-v1
documents retain every old meaning.

## 2. Renderer module versions and sorted defaults

`core/billboard`, `core/mesh-renderer`, and `core/decal-renderer` have two supported semantic
versions after this RFC:

| Module | v1 contract | v2 contract |
| --- | --- | --- |
| billboard | omitted `sorted` is `false`; explicit `true` sorts alpha/premultiplied particles | alpha/premultiplied omission is `true`; additive/multiply omission is `false` |
| mesh | same v1 sorted rule; Three writes particle depth | same v2 sorted rule; Three never writes particle depth |
| decal | no particle sort, no automatic coarse rank, particle rotation defaults to identity | alpha/premultiplied omission is `true`, automatic coarse rank participates, and the compiler-owned Init default captures spawn orientation |

Current public helpers MUST emit module version 2 and MUST materialize `sorted` into the config:
`true` for alpha and premultiplied blending and `false` for additive and multiply blending. Explicit
`sorted: false` remains `false`. Explicit `sorted: true` with additive or multiply remains invalid
with `NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED`. A raw v2 module with omitted `sorted` is compiled with
the same blending-dependent default; helper normalization is not the only correctness boundary.
Version-2 billboard, mesh, and decal configs all expose `renderOrderOffset?: number` and
`sortCenter?: Vec3`; the latter remains an emitter-local point and defaults to the emitter origin.

Version 1 is not upgraded implicitly. Its omitted values, explicit values, access manifest, draw
indirection, mesh depth behavior, decal orientation, and decal materializer order remain the old
contract. In particular, a v1 decal config containing an unknown `sorted` field that an old reader
accepted and ignored MUST still run unsorted; a new reader MUST NOT reinterpret it as v2.

The compiler MUST dispatch these direct built-ins by `(type, version)`, accept only the versions
listed above, and emit `NACHI_MODULE_UNKNOWN` for an unsupported version. Direct renderer compiler
branches MUST no longer ignore module versions.

## 3. Meaning of unsorted modes and alternatives

For alpha or premultiplied blending, `sorted: false` means that the vertex instance index addresses
the compact alive-index array. That array has no semantic ordering guarantee. The result may change
after a death/recycle, when a burst is split or combined, across GPU scheduling, or across adapters.
Seed, spawn order, and stable random streams do not turn this physical order into a rendering
contract. This option is a deliberate performance/appearance trade, not a weaker deterministic
sort.

Additive and multiply blending default to `sorted: false`; their supported blend equations do not
require back-to-front order. WBOIT is the approximate order-independent alternative for dense
overlap. A WBOIT integration SHOULD omit the particle sort or specify `sorted: false`; paying for a
bitonic order that the WBOIT accumulation does not consume is wasteful. WBOIT does not become the
default and retains the depth-occlusion limitations documented by `@nachi-vfx/post`.

## 4. Particle sorting, coarse sorting, and mesh depth

Particle sorting and coarse draw sorting solve different levels of the problem:

1. A sorted draw builds a back-to-front indirection for particles inside that draw. Equal depth
   keeps the existing physical-index tie-break.
2. `VFXSystem` ranks alpha/premultiplied draw entries by transformed `sortCenter`. A renderer draws
   one object at a time, so this is only a coarse ordering between emitters; it cannot globally
   merge the particle lists of two overlapping emitters.

Both levels apply to v2 billboard, mesh, and decal draws. Version-1 billboard/mesh retain their M10
coarse participation; version-1 decals retain their materializer-only order. Different integer
order buckets described in §5 deliberately override coarse depth. Authors needing exact dense
cross-emitter overlap SHOULD combine particles into one emitter or use WBOIT.

Every Three mesh particle material for module v2 uses `depthTest: true` and `depthWrite: false` for
all four supported blending modes. Alpha and premultiplied particles therefore blend instead of an
earlier near instance rejecting a later far instance. Version-1 mesh materials retain their old
`depthWrite: true` behavior.

The current one-render-module-per-emitter limit remains. H2-7 does not add indirect argument slots.
The order protocol nevertheless carries a draw index/path so future multiple-draw support cannot
reintroduce one kernel-wide overwrite.

## 5. Exact host-order composition

Order has three components:

- `base`: an adapter/host value owned by the Three materialization registration;
- `renderOrderOffset`: a signed integer stored in the v2 core render-module config; and
- `automatic(rank)`: a core runtime value for alpha/premultiplied coarse ordering.

The exact Three value is:

```text
bucket = base + renderOrderOffset
automatic(rank) = (rank + 1) / 1_048_576
finalRenderOrder = bucket + automatic(rank)  // alpha or premultiplied auto-ranked draw
finalRenderOrder = bucket                    // additive, multiply, or non-participating v1 decal
```

`base`, `renderOrderOffset`, and `bucket` MUST be signed 32-bit integers. The module factory/compiler
rejects an invalid offset with `NACHI_RENDER_ORDER_OFFSET_INVALID`. Three materialization and its
persistent setter reject an invalid base or overflowing sum with
`NACHI_THREE_RENDER_ORDER_COMPOSITION_INVALID`. A system may own at most `1_048_575` automatic
transparent draw entries. A spawn that would exceed the limit fails before retaining the new
instance with `NACHI_TRANSPARENT_DRAW_ORDER_CAPACITY_EXCEEDED`.

The denominator is `2^20`. Within the signed-32-bit bucket range every rank fraction and composed
sum is exactly representable by an IEEE-754 double, and ranks cannot collide. Ranks increase from
far to near. Equal depth is ordered by ascending per-system numeric instance creation sequence,
then emitter element key, then compiled draw path/index. An unreleased draw consumes a rank even if
it is culled or materialized late; materialization timing therefore cannot reorder peers. Separate
`VFXSystem` objects still rank independently and MUST use different base/offset buckets when their
mutual order matters.

`ThreeSpriteMaterializationOptions`, `ThreeMeshMaterializationOptions`, and
`ThreeDecalMaterializationOptions` all expose `renderOrder?: number`, and that exact field supplies
the registration `base`. Sprite and mesh default it to `1000`. The existing decal field remains
source compatible and defaults to `10`. A v1 decal therefore still has final order exactly `10`
(or its explicit old value). A v2 decal receives a fraction strictly between its integer bucket and
the next integer. An external Three object at `bucket` is submitted before every Nachi automatic
draw in that bucket; one at `bucket + 1` is submitted after them. A host may use a value strictly
between those integers to interleave deliberately.

## 6. Registration ownership, mutation, pooling, and late materialization

Core owns the rank and module offset. Three owns the host base and the conversion to
`Object3D.renderOrder`. The runtime renderer protocol stores an assignment by
`(BuiltEmitterKernels, drawIndex)`, not one scalar for all registered objects. Each Three draw
registration stores its base, offset, draw index, and persistent user component, then recomputes
the formula in §5 whenever either component changes.

Sprite, mesh, and decal materialization results expose `setRenderOrderBase(base)` in addition to
the visibility control. Their `renderOrder` option supplies its initial value. Direct assignment to
`Object3D.renderOrder` is not a persistent override and may be replaced by the next runtime order
update, pool activation, or registration replay. Hosts that need persistent mutation MUST use the
setter.

An assignment made before materialization is retained on the kernels and applied when the draw is
registered. Retained/prepared draw activation applies the latest assignment, not the object's stale
field. `prepareKernelsForPooling()` and permanent release both clear every order assignment after
disposing registrations. A checked-out pooled kernel therefore starts with no previous-generation
base or rank and receives the new generation's registration base and next runtime rank. This closes
the `THREE_RENDER_ORDER` residual formerly assigned to plan 026; an actual release → pool checkout →
materialize-before-update regression is required.

## 7. Decal spawn orientation

For a v2 decal, the compiler inserts a compiler-owned Init default after generic attribute defaults
and before authored Init modules. The compiler virtual `Emitter.spawnInterpolatedRotation` shares
the exact spawn-index phase and interpolation-active branch with
`Emitter.spawnInterpolatedTransform`: active history uses shortest-path quaternion slerp, while an
inactive/stationary history returns the exact current `Emitter.rotation` node. For each successful
spawn the synthetic Init normalizes this virtual quaternion `q_spawn` and writes:

```text
Particles.rotation = normalize(q_spawn)
```

The decal projection box and inverse projection use this same stored quaternion. Authored Init
modules that write `Particles.rotation` execute later and therefore remain absolute world-space
overrides. Update modules such as `orientToVelocity()` may replace it later. Version-1 decals keep
the identity generic default.

This is a birth-pose capture, not emitter following. Later emitter movement does not rotate an
existing decal. Translation is not added by the decal renderer: `Particles.position` remains its
world-space center. Built-in position modules continue to transform their local center with the
same per-particle phase, so a translation-plus-rotation spawn keeps center and orientation at the
same interpolation phase. A custom position writer remains responsible for its world position and
does not disable the independent orientation default. Event/all-slot Init paths that have no spawn
phase use exact current rotation, just as their transform virtual uses exact current transform.

## 8. Camera diagnostics and quality tiers

Any active particle-sorted draw requires `VFXSystem.setCamera()`. Multiple auto-ranked transparent
draws also require it for meaningful coarse depth. If either condition is true without a configured
camera, the system records `NACHI_ALPHA_SORT_CAMERA_UNSET` once per affected instance and uses the
existing identity camera fallback for that update. Decals are included in both checks under v2.

The effective sort is `authoredSorted && quality.features.sorted`. Presets use:

| Tier | sorted gate |
| --- | --- |
| low | false |
| medium | false |
| high | true |
| epic | true |

Thus correctness is the normal high/epic path while low/medium retain an explicit budget escape.
Explicit authored `sorted: false` remains false at every tier. A live `setQualityTier()` call
updates runtime capacity/spawn controls immediately but does not replace an already compiled draw.
When the structural sorted gate changes, existing instances keep their compiled variant, record
`NACHI_QUALITY_RESTART_REQUIRED`, and only a subsequent spawn/checkout compiles or selects the new
pool key. No hidden in-place recompilation is promised.

## 9. Asset-format boundary and migration

Module version 2 alone is not a safe serialized boundary for these built-ins. The pre-H2-7 format
accepts any positive module version, and the old core compiler's direct billboard/mesh/decal paths
do not resolve a version registry. In particular, an old reader would silently ignore
`decal.config.sorted` and execute alive-index order even if the module said version 2. This violates
RFC 003 §4.

H2-7 therefore increments the `nachi-effect` envelope to version 2. The new serializer emits only
envelope v2. The default migration registry contains an explicit one-step envelope-only v1 → v2
migration: it changes only the top-level version, does not mutate the input, and preserves the
effect/module payload deeply and byte-for-byte under canonical JSON. Module versions are never
upgraded. The new loader accepts the migrated v1 document and native v2 documents.
`EffectAssetDocumentV1` and the v1 schema remain exported for inspection/migration; serializer
output and current schema use v2 types.

Because format v1 accepted arbitrary positive module versions without owning their semantics, an
actual emitter `render` slot, or an emitter-extension `overrides.render.modules` slot, containing
`core/billboard`, `core/mesh-renderer`, or `core/decal-renderer` at a version other than 1 is rejected
before migration with `NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED`. The bounded guard checks only
those format-owned render positions. A renderer-shaped object nested inside an opaque module config
is payload and remains untouched. This reserved-version guard is not a payload rewrite: it prevents
an old generic render config from being reinterpreted as an H2-7 renderer-v2 config. Other versioned
modules, including H2-6 kernel modules, retain their normal migration path.

Envelope-v2 validation is version aware. Billboard, mesh, and decal module-v2 configs strictly
validate known fields: blending/sorted literals, signed-32-bit finite `renderOrderOffset`, finite
three-component `sortCenter`, and their existing module-specific fields. Unknown fields are
rejected. Module-v1 configs retain their historical generic acceptance and v1 compiler meaning;
strict v2 validation MUST NOT retroactively invalidate or reinterpret an old payload. Tests cover
input non-mutation, payload preservation, module-version preservation, load → serialize stability,
and actual old-reader rejection of envelope v2.

An old reader rejects envelope v2 before compilation with `NACHI_ASSET_VERSION_UNSUPPORTED`; it can
never silently run the new decal config. New v2 helpers serialize module-v2 explicit defaults.
Readers never infer a renderer module upgrade from envelope migration.

## 10. Required verification and performance evidence

Acceptance requires all of the following:

- old module-v1 omitted/explicit semantics and fixed GPU/WGSL pins, plus safe old-reader rejection
  of envelope v2;
- GPU overlap/readback for alpha and premultiplied billboard, mesh, and decal defaults, and an
  explicit-false compact/recycle/spawn disturbance whose nondeterministic physical meaning is
  visible;
- transparent mesh color/depth readback that distinguishes `depthWrite: false` from the old reject;
- base + offset + rank, external-object boundaries, numeric ties, persistent setter, late
  materialization, retained preparation, and actual pool reuse;
- a translation-plus-rotation decal fixture with position/quaternion storage readback and an
  asymmetric projection result, including a fixture-only identity-rotation fault;
- camera warning and low/medium versus high/epic structural compilation boundaries;
- fixture-only faults for `default-unsorted`, `mesh-depth-write`, `rank-overwrite`,
  `decal-no-spawn-rotation`, and `pool-stale-order`. Production code MUST NOT contain test-only fault
  branches.

`/m10-sort/` is the permanent GPU surface. Its existing visible canvas should remain stable unless
an adjudicated behavior change affects it; new numeric assertions are published in the page result.
Golden and showcase changes are first compared as compiled draw structure (module version,
blending, indirection, material depth-write, and order components), then as screenshot regions.
Only differences attributable to this RFC may be re-recorded.

Performance uses the same `/m10-sort/` workload, adapter, warmup 4, and 16 complete perf-v2 GPU
samples per run. Old and new builds each run five times; the plan records every median/p95, the
median of medians, and median of p95. Any material median regression is investigated and either
fixed or explicitly adjudicated before acceptance; low/medium sorted-off results are also recorded
to prove the budget escape.

## 11. Release classification

Changing renderer defaults, mesh depth behavior, runtime renderer ordering, and decal orientation
is a semantic major change for `@nachi-vfx/core` and `@nachi-vfx/three`. Changing the current asset
envelope and serializer return type is a semantic major change for `@nachi-vfx/format`. All three
packages are still pre-1.0, so RFC 003 §2 requires `minor` changesets whose text prominently labels
the change as breaking and gives migration guidance. The core major component MUST NOT be
downgraded to a patch merely because v1 assets remain loadable.

## 12. Non-goals

This RFC does not add a globally merged cross-emitter particle sort, make WBOIT exact, remove its
depth limitations, add multiple render modules per emitter, coordinate independent VFX systems,
make direct `Object3D.renderOrder` mutation persistent, or make old decals follow an emitter after
birth.
