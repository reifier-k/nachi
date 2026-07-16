---
'@nachi-vfx/core': minor
'@nachi-vfx/format': minor
'@nachi-vfx/timeline': minor
'@nachi-vfx/trails': minor
'@nachi-vfx/post': minor
'@nachi-vfx/mesh-fx': minor
---

Reject malformed runtime JavaScript inputs consistently across module ValueInputs, transforms,
timeline actions and clocks, direct post pipelines, trails IDs/UV bounds, and VAT clocks/booleans.
ValueInput validation covers nested and required fields, string parameter paths, materialized
built-in parameter types, collision modes and actual normalized-age write ownership. Core and
timeline reject invalid live or attachment transforms atomically, trails keep alternating counts
representable as u32, and timeline also synchronizes attachments before initial time-zero play
actions. Core and timeline use attachment operation revisions so direct or scheduled getters discard
stale outer samples after nested replacement, same-source reentry, detach, release, or a caught
invalid attachment attempt. Transform properties and components are read once into owned frozen
snapshots, with attachment revisions checked both before and after snapshotting, so mutable accessors
cannot change validated values or reentrantly restore a stale pose during commit.
Spawn clock options are also single-read snapshots: core snapshots `timeScale` and `priority`, while
timeline builds a frozen own-data record from all constructor-consumed options before ID allocation
and preserves direct-constructor validation.

Harden hostile simulation-cache and debug membership metadata, including non-array birth-order
state, fractional physical slots, and duplicate-slot diagnostic paths. Timeline visibility mutation
now reports the terminal error/released state after mesh cleanup instead of misclassifying the key.
