---
'@nachi-vfx/core': minor
'@nachi-vfx/format': minor
'@nachi-vfx/three': minor
---

BREAKING: introduce renderer module v2 and the `nachi-effect` v2 envelope. Alpha and premultiplied
billboard, mesh, and decal helpers now default to particle sorting; transparent v2 mesh draws no
longer write depth; v2 decals capture emitter rotation at spawn; and automatic draw order composes
host base, `renderOrderOffset`, and a fractional coarse rank. Use `sorted: false` for the explicitly
unordered path, `setRenderOrderBase()` for persistent Three order changes, and renderer module v1
when loading preserved legacy semantics. Format migrates v1 envelopes without upgrading module
versions and strictly validates renderer-v2 configs.
