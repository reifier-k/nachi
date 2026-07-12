---
'@nachi/core': minor
'@nachi/format': minor
'@nachi/mesh-fx': minor
'@nachi/post': minor
'@nachi/react': minor
'@nachi/three': minor
'@nachi/timeline': minor
'@nachi/trails': minor
'@nachi/tsl-kit': minor
---

Prepare the complete independently versioned nachi package set for the 1.0 release gate. This
initial public surface includes the staged GPU particle runtime, strict versioned assets,
simulation caches and data interfaces, timeline and trail composition, TSL/mesh/post rendering
tools, the public Three.js runtime/materialization adapter, and the React Three Fiber lifecycle
binding. It also establishes explicit diagnostics,
backend residuals, package ESM/dry-run gates, and FA compatibility/reporting contracts. The
changeset intentionally records user-facing minor releases without applying the final 1.0 version
bump; release ownership remains with the FA coordinator.
