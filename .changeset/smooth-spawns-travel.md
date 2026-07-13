---
'@nachi/core': minor
'@nachi/three': minor
---

Interpolate emitter transforms within rate, burst, and per-distance spawn batches. Moving emitters
now place new particles along the traveled segment using deterministic spawn-order phases, while
stationary emitters retain the existing transform path bit-for-bit and pooled emitter reuse resets
transform history before respawn.

Extend the public kernel-adapter contract with matrix construction and implement the new required
`KernelTslAdapter.mat4` capability in the Three.js adapter for interpolated transform codegen.
