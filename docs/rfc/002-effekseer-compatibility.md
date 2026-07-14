# RFC 002: Effekseer `.efkefc` import compatibility study

> Language: English (this page) / [日本語](./002-effekseer-compatibility.ja.md)

- Status: Research complete; implementation deferred
- Date: 2026-07-12
- Recommendation: reconsider after nachi 1.0

## 1. Question and conclusion

This study asks whether nachi should directly import editable Effekseer `.efkefc` effects. The
formats share enough concepts to make a useful lossy converter possible, but they do not share a
runtime or material model. Direct compatibility is therefore a conversion product, not a parser
feature.

**Recommendation:** record M12 research as complete and defer implementation until after 1.0. A
post-1.0 proposal should begin with a fixture-based, version-gated converter for sprites and basic
motion. It must not advertise general `.efkefc` compatibility until ribbon/ring/track rendering,
F-curves, resource conversion, coordinate/color rules, and unsupported-feature diagnostics have
golden parity fixtures.

## 2. Sources and stability boundary

The primary sources reviewed were:

- [Effekseer Tool Reference](https://effekseer.github.io/Helps/17x/Tool/en/ToolReference/index.html),
  which defines `.efkefc` as the editable and runtime-playable effect file, describes the
  parent/child node model, and lists sprite, ribbon, ring, model, track, F-curve, material, sound,
  LOD, dynamic-parameter, and procedural-model surfaces.
- [Effekseer export reference](https://effekseer.github.io/Help_Tool/en/ToolReference/fileExport.html),
  which distinguishes the play-only `.efk` binary and the `.efkpkg` resource package from editable
  `.efkefc`.
- [Effekseer runtime source](https://github.com/effekseer/Effekseer/tree/master/Dev/Cpp/Effekseer/Effekseer),
  whose separate Sprite/Ribbon/Ring/Track effect-node loaders and F-curve runtime classes show that
  these are distinct binary/runtime contracts rather than one generic billboard shape.
- [Effekseer editor binary exporter source](https://github.com/effekseer/Effekseer/tree/master/Dev/Editor/EffekseerCore/Binary),
  which owns common, generation, transform, render, sound, and renderer-specific binary emission.

Effekseer does not publish `.efkefc` as a stable third-party interchange specification. Its source
is the effective specification. A nachi reader would consequently need an explicit supported
Effekseer-version matrix and captured fixtures; reading “whatever the current editor writes” is
not a safe compatibility contract.

## 3. Format structure

At a useful architectural level, `.efkefc` is a versioned binary container rather than the old
text-oriented `.efkproj` document. It retains editor data and a runtime-consumable compiled effect.
The runtime payload contains:

1. a header/version and container chunks;
2. resource tables/paths for color, normal and distortion textures, materials, models, curves, and
   sounds;
3. global effect settings such as scale, culling, LOD and dynamic inputs;
4. a recursive parent/child node tree;
5. for every node, common lifetime/generation/binding data, spawn shape, position/rotation/scale,
   forces, depth/render-common state, one renderer-specific block, optional sound, and F-curves;
6. renderer-specific payloads for Sprite, Ribbon, Ring, Model, Track, or no rendering.

The exact byte layout and chunk revisions are upstream implementation details. A future importer
should either reuse an upstream-supported exporter/library to obtain a normalized intermediate
form, or port only the required loader structs behind `EffekseerVersion -> decoder` dispatch.
Guessing offsets from sample files is rejected.

`.efkpkg` is a separate package concern: it may contain one or more `.efkefc` files plus referenced
resources. Package extraction, path normalization, archive limits, and untrusted-input budgets
would be required before effect conversion.

## 4. Model mapping

| Effekseer concept                  | Candidate nachi representation                                                         | Fidelity                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Effect node / generated particle   | one `EmitterDefinition`; node tree lowered to elements plus `emitTo()`/timeline starts | Partial: Effekseer parent binding and child generation timing are richer than death/collision events                                       |
| Sprite                             | `billboard()` + flipbook/cutout/blending/depth options                                 | High for basic unlit sprites; UV modes, distortion/material details vary                                                                   |
| Ribbon                             | `@nachi-vfx/trails` `ribbon()`                                                             | Medium: connected ordering maps, but facing, smoothing, width/color stations and binding rules differ                                      |
| Ring                               | `@nachi-vfx/mesh-fx` ring/procedural mesh plus material                                    | Medium-low: Effekseer ring is a per-particle renderer with viewing angle, shape/color/UV animation; nachi's current ring is an effect mesh |
| Track                              | ribbon/trail with widened section profile                                              | Low-medium: Effekseer track has front/middle/back widths and six color stations not represented by the current fixed-width ribbon contract |
| Model                              | `meshRenderer()` + `GeometryRef`/VAT where applicable                                  | Partial: model animation, procedural model and material conversion require separate assets                                                 |
| Generation count/interval/lifetime | `burst()`/`rate()`, lifecycle, `lifetime()`                                            | Medium: frame-based random ranges and parent-trigger semantics require lowering                                                            |
| Position/rotation/scale and easing | Init/Update modules plus `curve()`/over-life modules                                   | Medium for linear/easing subsets                                                                                                           |
| F-curve                            | LUT-backed `curve()` or generated registered module                                    | Low-medium: Effekseer per-axis keys, tangents/interpolation, offsets, sampling and timeline units exceed nachi's current linear helper     |
| Parent-child binding               | effect transforms, `attachTo()`, inherited event payloads                              | Low: bind-at-creation/always/follow-parent semantics need a dedicated conversion/runtime policy                                            |
| Dynamic parameters/equations       | declared `User.*` plus registered TSL                                                  | Low: expressions cannot be translated safely without an interpreter/compiler                                                               |

## 5. Convertible first subset

A credible first importer could accept a deliberately narrow profile:

- one root with sprite-renderer children;
- fixed/burst generation, finite lifetime, basic point/sphere/circle spawn shapes;
- fixed/random/easing position, rotation, and scale where the semantics have direct modules;
- gravity and a documented subset of local forces;
- unlit color textures, basic flipbooks, alpha/additive/multiply blending, depth test/write;
- linear color/scale-over-life curves, after converting Effekseer frame time to seconds;
- external PNG references rewritten to `AssetRef<'texture'>`;
- explicit coordinate-system, unit-scale, color-space, and random-seed conversion metadata.

Every unsupported node or field must produce a path-specific diagnostic. A “best effort” mode may
drop nodes only when the caller explicitly requests it and receives a machine-readable loss report.
The default must be fail-closed.

## 6. Unsupported or high-risk areas

- `.efkmat` material graphs, compiled material caches, custom data and distortion semantics;
- sound playback and synchronization;
- dynamic equations, dynamic inputs, triggers and external model slots;
- exact parent binding/inheritance and child generation at arbitrary parent-particle ages;
- advanced ribbon/track geometry, smoothing, spline division, viewpoint-dependent ring geometry;
- model animation, `.efkmodel`, `.efkcurve`, procedural models and GPU-particle-specific features;
- F-curve Bezier/tangent behavior, random offsets, edge/extrapolation modes and exact 60-frame
  sampling rules;
- Effekseer-specific turbulence/force fields, kill rules and collision/trigger behavior;
- gamma-default authoring versus nachi linear working color, handedness/axis and unit conversion;
- renderer sort/depth priority, soft-particle and alpha-cutoff details, LOD/culling equivalence;
- forward compatibility with new container or node binary versions.

These cannot be silently approximated because visual mismatch is the primary failure mode of an
effect importer.

## 7. Cost estimate

| Work                                                                           |           Estimate |
| ------------------------------------------------------------------------------ | -----------------: |
| Version/container probe, legal/license review, malformed-input harness         | 1–2 engineer weeks |
| Versioned decoder or upstream bridge, resources, normalized intermediate model |          2–4 weeks |
| Sprite/basic transform/generation converter and diagnostics                    |          3–5 weeks |
| F-curve/easing conversion and deterministic timing fixtures                    |          2–4 weeks |
| Ribbon/ring/track conversion and renderer gap work                             |          4–7 weeks |
| Materials/models/dynamic parameters (partial only)                             |         6–10 weeks |
| Cross-version corpus, golden screenshots, documentation and fuzz/security work |          3–5 weeks |

A useful strict sprite subset is roughly **8–12 engineer weeks**. Broad practical compatibility is
**20–30+ engineer weeks** and still requires a published unsupported-feature matrix. Maintenance
then tracks upstream format changes.

## 8. Decision gate after 1.0

Reconsider only if all of the following are true:

1. users provide a representative, redistributable `.efkefc` corpus and rank import demand;
2. an upstream-supported normalization route or maintainable versioned decoder is selected;
3. nachi has dedicated ring/track and non-linear curve contracts or accepts clearly bounded loss;
4. security budgets exist for file size, recursion, allocation, archive extraction, and resource
   paths;
5. acceptance compares deterministic values and screenshots against Effekseer for every supported
   version/profile.

Until then, teams can export sprite sheets for appearance-only reuse or manually author equivalent
nachi effects. M12 records the investigation as complete; no importer code is included.
