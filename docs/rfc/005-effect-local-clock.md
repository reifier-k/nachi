# RFC 005: Shareable effect-local clock sources

> Language: English (this page) / [日本語](./005-effect-local-clock.ja.md)

- **Status:** Proposed
- **Scope:** `@nachi/core` instance clocks and dependent spawning; interaction with
  `@nachi/timeline`, simulation caches, and scalability
- **Normative references:** [RFC 001](./001-api.md) §§10.2-10.4, 10.5
- **Proposal date:** 2026-07-14
- **Implementation:** None in this RFC; H1-8 implements only the smaller
  `TimelineEffectInstance.bindCompanion()` forwarding contract

## 1. Problem

An effect-local clock currently exists only as private instance state. `timeScale`, hit stop, and
scalability suspension affect that instance, but an independently spawned companion effect cannot
consume the same authoritative time. `bindCompanion()` forwards current controls and solves the
common short-term case, but it still requires two systems to receive the same world-step sequence
and does not represent loop phase, seek/replay ownership, or a general parent-child clock graph.

The intended larger API must not be inferred from the forwarding hook. Clock dependency changes
simulation semantics and overlaps prewarm, looping, cache replay, and culling, so it requires an
explicit decision before implementation.

## 2. Proposed API shape

Each live effect instance would expose one stable, read-only clock object:

```ts
interface EffectClockSource {
  /** Effect-local seconds committed by the most recently completed update segment. */
  readonly localTime: number;
  /** Effective local-seconds/world-second rate at that same commit point. */
  readonly rate: number;
}

interface EffectInstance {
  readonly clock: EffectClockSource;
}

interface EffectSpawnOptions<Definition> {
  readonly clock?: EffectClockSource;
}

const parent = system.spawn(parentEffect);
const child = companionSystem.spawn(trailEffect, { clock: parent.clock });
```

`instance.clock` would retain object identity for the instance lifetime. Its fields would update
only at documented scheduler commit points, never midway through a public read. `rate` would be the
effective instantaneous rate after instance time scale, hit stop, and scheduler-owned suspension;
it may be zero. It is not a command surface: consumers cannot assign, pause, or seek it.

Supplying `spawn(..., { clock })` would make the child dependent on the source. The child would use
source-local progression rather than independently multiplying host delta. Its own authored
`timeScale` remains an open design choice: either it is forbidden with an external clock, or it is
a documented multiplier over source delta. Silent precedence is not acceptable.

Clock-source lifetime also needs a terminal rule. Candidate behavior is to latch the final
`localTime`, set `rate` to zero, and leave children paused until explicitly rebound or released.
Automatically reverting to world time would create a discontinuity and is not proposed.

## 3. Update and frame semantics

The source must publish a value after every exact world segment, including a zero-local-delta hit
stop segment. A dependent child must consume the same committed source delta exactly once. Reading
only `{ localTime, rate }` is insufficient if multiple source segments occur within one host update,
so implementation likely needs an internal monotonic revision plus previous-local-time record even
if the public v1 shape remains the two requested fields.

The following must be decided before implementation:

1. Whether source and child may belong to different `VFXSystem` instances and, if so, which system
   owns dependency ordering.
2. Whether updating a child before its source uses the previous revision, queues work, or throws a
   deterministic ordering diagnostic.
3. How a source with several fixed substeps prevents a child from consuming only the final
   aggregate and losing per-step spawn/collision behavior.
4. How dependency cycles are rejected and reported.

No implementation may claim exact same-frame behavior while sampling only the final public rate.

### 3.1 `bindCompanion()` phase limit and socket driving

H1-8 `bindCompanion()` forwards clock controls; it does not share a sub-frame phase or split a
separately owned companion system at the timeline action boundary. Exact local-time equality is
therefore conditional: the hit-stop action must coincide with a companion update boundary. With a
non-aligned action, advancing the companion first avoids a full-frame-late stop, but the companion
may already have consumed the remainder of its host step while the timeline splits at the action.
The offset is bounded by one companion update interval. Solving that general ordering problem is
part of this proposed clock-source RFC, not the H1-8 forwarding hook.

Page-driven socket trails need an additional consumed-pose latch. H1-7 intentionally discards
per-distance transform movement seen while effective local delta is zero. Recomputing a socket at
the timeline's newly reached hit-stop time and feeding that transform to an already stopped
companion therefore discards the displacement and leaves a trail gap. The integration SHOULD:

1. record the socket-local time/pose used by every completed companion update;
2. when the hit-stop action fires, latch that last consumed pose rather than the action-time pose;
3. keep the socket at the latched pose while parent local time remains at the stop boundary; and
4. release the latch only after parent local time advances beyond the boundary.

The next non-stopped companion update then consumes the complete catch-up transform, so H1-7
per-distance interpolation emits along it instead of discarding it during the freeze.

```ts
let consumedSocketLocal = parent.localTime;
let freeze: { boundary: number; socketLocal: number } | undefined;

parent.onAction(({ action, localTime }) => {
  if (action.kind === 'hit-stop') {
    freeze = { boundary: localTime, socketLocal: consumedSocketLocal };
  }
});

async function update(delta: number) {
  const socketLocal = freeze?.socketLocal ?? parent.localTime;
  driveSocket(socketLocal);
  await companionSystem.update(delta);
  consumedSocketLocal = socketLocal;

  await timelineSystem.update(delta);
  if (freeze && parent.localTime > freeze.boundary) freeze = undefined;
}
```

This pattern coordinates an external transform with the small forwarding API. It does not provide
the dependency ordering, revision stream, or sub-frame clock propagation proposed by this RFC.

## 4. Loop interaction

Emitter `loopCount` and M9 timeline loops currently reset different lifecycle scopes. A clock
source should expose monotonically committed local time unless the public contract also exposes a
cycle/epoch. If `localTime` jumps backward at a parent loop, a dependent emitter could duplicate
rate windows, invalidate per-distance history, or produce a negative delta.

The preferred direction is an internal monotonic clock plus a separate parent phase/epoch for
composition. Whether that epoch becomes public is unresolved. Child lifecycle looping must remain
owned by the child definition; clock dependency alone must not silently restart it at every parent
timeline cycle.

## 5. Prewarm interaction

Prewarm currently advances a new instance through deterministic fixed local steps before its first
external positive update. A dependent spawn raises two incompatible expectations:

- prewarm consumes historical parent time, which is unavailable from a live two-field source; or
- prewarm runs relative to the child's birth and temporarily diverges from the parent.

The initial proposal is to reject non-zero prewarm on externally clocked spawns until a history
contract exists. An alternative is an explicit `prewarm: 'relative'` mode. It must never silently
advance the shared source or mutate siblings.

## 6. Bake and replay interaction

`bakeSimulation()` owns a constant frame step and deterministic metadata. A bake cannot depend on
an arbitrary live clock object without recording its complete revision/delta stream. Candidate
rules are:

- reject external clocks during bake;
- accept only a serializable baked clock track with matching step metadata; or
- bake the parent and every dependent instance as one composition graph.

`replaySimulation()` restores recorded frames and does not schedule live simulation kernels. Replay
therefore must not both advance from a source and apply cached frames. A replay instance should
either publish the cache's recorded local clock for visual dependents or refuse to serve as a clock
source in v1. Cache seek, interpolation, and loop endpoints need explicit clock revisions so a child
does not interpret a seek as live elapsed time.

## 7. Scalability suspension

RFC 001 fully culled effects pause local time. If the source is culled but a visible dependent is
not, inheriting source rate zero freezes the dependent. That is coherent for a true companion but
could be surprising when systems make significance decisions independently. Conversely, allowing
the child to override the zero rate breaks the meaning of dependency.

The proposal is that source-clock suspension wins, while each child may still add its own
scalability suspension. Budgeting should evaluate a dependency graph as one significance unit when
possible. The fallback behavior for independently budgeted systems, and diagnostics explaining
`rate === 0`, remain open requirements.

## 8. Relationship to M9 composition

M9 `defineEffect()`/timeline composition owns semantic lifecycle: element keys, `play`/`stop`, loop
restart, mesh-fx life, parameters, transforms, and deterministic action ordering. A shared clock
owns only time progression for an already separate instance. It must not become a second element
graph, forward parameters/transforms, or imply release ownership.

Use M9 composition when elements form one authored effect and share lifecycle. Use an external
clock for engine-owned companions that must remain separate systems or instances, such as a
socket-following trail. `bindCompanion()` remains the low-cost control-forwarding option; a future
clock source would supersede manual step-order assumptions but not M9 composition.

## 9. Required validation before acceptance

An implementing RFC revision must include:

- exact boundary tests across variable and fixed step partitions;
- loop/epoch and late-spawn tests;
- explicit prewarm rejection or semantics;
- bake/replay determinism and seek behavior;
- source/child scalability combinations;
- source release, error, and dependency-cycle handling;
- cross-system ordering diagnostics and leak-free dependency teardown.

Until those decisions are accepted, `clock` and `spawn(..., { clock })` are reserved design shapes,
not public API.
