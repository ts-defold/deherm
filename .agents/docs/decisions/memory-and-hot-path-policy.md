---
type: Architecture Decision
title: Budget allocations and keep generated hot paths allocation-free
description: Separate bootstrap, durable, frame-scratch, and stack storage so mobile and web memory costs are bounded, observable, and cache-conscious.
tags: [decision, memory, performance, bindings, arenas, cache-locality, mobile, web, frame-sizing]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T17:12:56-04:00 }
---

# Decision

Deherm does not ban allocation. It assigns every allocation to a lifetime and
a budget. Generated binding hot paths must not invoke the general heap after
runtime warm-up. Durable state may allocate when a runtime is created or a
project is loaded, but its capacity, ownership, teardown, high-water mark, and
failure behavior must be explicit.

Allocation is not the only per-call cost this policy governs. Storage that is
never allocated is still *touched*: a fixed frame is paid for once per dispatch
in stores, cache lines and page residency, whether or not a malloc happened.
The rule below therefore has two halves, and a path satisfies the policy only
when it satisfies both.

| Lifetime | Storage | Allocation point | Hot-path rule |
| --- | --- | --- | --- |
| process/runtime | Hermes VM, registries, reachable descriptor tables | runtime creation | bounded by configuration; fully released at shutdown |
| rooted object | callbacks, Lua objects, native handles | pool creation, then O(1) slot acquire/release | fixed or explicitly capped generational pools |
| one dispatch | strings, spans, out-parameters, temporary ABI records | runtime-owned bump arena | mark, bump, call, rewind; never fall back to heap |
| primitive call | scalar arguments and results | C++/Wasm stack | stack locals only |
| generated constants | IDs, codecs, offsets, function descriptors | compile/link time | dense immutable tables; cold names stored separately |

The current `BindingArena` is a fixed-inline primitive for generated thunks. It
uses contiguous trivial records, explicit power-of-two alignment, nested RAII
frames, deterministic exhaustion, debug poison, a tail canary, and high-water
statistics. It cannot grow or fall back to the heap. The existing Lua
`ScratchArena` performs one bounded allocation when the bridge is created and
then reuses that memory for calls; it likewise has no gameplay-time fallback.
These are two deployment choices for the same lifetime policy, not a claim that
all useful storage must be embedded inline.

# Per-call initialization is a hot-path cost

Frame-lifetime storage must be **sized to the contract of the call being
dispatched**, not to the maximum any call in the family could need, and the
bytes a call initializes must be bounded by what that call's contract can
address. "Allocation-free" is necessary, not sufficient: a stack-resident,
bounded, never-heap frame that value-initializes tens of kilobytes on every
dispatch is a hot-path defect of exactly the kind this policy exists to catch.

Concretely, for any generated dispatcher:

* Per-call scratch capacity is **derived from the route's own value shapes** -
  its argument and result counts, and whether its parameters and returns can
  reach a table, a sidecar arena, or another bounded region at all. Capacities
  are generated, never hand-written per route, and never smaller than the
  contract the same dispatcher validates against, so a narrowed frame cannot
  refuse a call the descriptor accepts.
* A value-shape constructor whose contents the pinned IR does not inline -
  an opaque or externally-named schema, a dynamic value, or a constructor a
  later engine revision introduces - **widens** the frame to the family
  maximum. Unrecognized shapes cost memory; they never silently lose a bound.
* Initialization that a bounds check, a validity check, a generation counter, or
  a fail-closed release path depends on is **not** removable as dead work.
  Scratch a backend fills is zeroed so a partially written result graph decodes
  as absent rather than as garbage; scratch the generated decoder fills is
  provably written before read, and skipping it is legitimate only where the
  language guarantees the object's lifetime has begun without it.
* Whether a region can be reached must be a **structural** property of the
  route's shapes, not a route allowlist, and the derivation must be visible in
  the generated report so a dispatch's cost is auditable without a profiler.

The cost of getting this wrong is measurable and close to linear in bytes: see
`research/transport-overhead-measurement.md`, where the typed-native transport's
fixed 53,472-byte frame accounted for essentially all of its 733-773 ns per
call, and contract sizing took the same routes to 43-68 ns while leaving every
bound, arena generation counter, and stale-handle rejection unchanged.

# Data-oriented dispatch

Bindings use stable dense numeric IDs. Hot metadata is stored in compact arrays
of codec, arity, flags, and entrypoint data. Human-readable names, source paths,
and documentation are cold metadata used by diagnostics and tooling. Temporary
arguments/results are laid out contiguously in call order. Long-lived objects
use structure-of-arrays pools where lookup and release touch only the fields
required by that operation.

No pointer, span, string view, or record view into a dispatch arena may survive
its frame. Values that cross a frame boundary must be copied or promoted into a
typed durable owner. Promotion is an explicit operation with observable cost;
generated code must not infer it from escape behavior.

# Budgets and failure

Defaults are target profiles, not universal constants. A project may choose
different mobile, desktop, and HTML5 budgets. Exhaustion returns a typed error
containing the binding ID, requested bytes/slots, configured capacity, and
high-water mark. Development builds may add canaries, poison, ownership checks,
and allocation traps. Release builds retain bounds checks and counters while
removing diagnostic fills.

The runtime reports at least:

* arena capacity, current use, high-water, call allocations, and exhaustion;
* pool capacity, live count, high-water, acquisition failures, and stale-handle
  rejections;
* durable bytes by owner/lifetime and complete shutdown release counts;
* unexpected general-heap allocations observed inside instrumented hot calls.

# Verification gates

“Allocation-free” always names a measured scope. The initial arena evidence is
a standalone repeated-operation test that overrides ordinary and aligned C++
allocation, observes zero heap calls, compiles with strict C++17 diagnostics,
and passes AddressSanitizer plus UndefinedBehaviorSanitizer. It does not prove
that Hermes, Lua, Defold, or the complete game frame never allocates.

A generated binding family advances only when it has:

1. a warm repeated-call fixture with allocation counters;
2. deterministic exhaustion and stack/arena rewind tests;
3. normal, error, callback, and teardown lifetime tests;
4. ASan/UBSan coverage on the native harness and target-appropriate Wasm bounds
   checks;
5. a device benchmark reporting distribution, high-water, and capacity rather
   than only an average call time;
6. a per-call frame footprint reported per route by the family's generated
   report, and a measured cost for at least one route of the smallest and one
   of the largest frame the family emits. A single family-wide call time hides
   exactly the defect the sizing rule above exists to prevent.

“Memory-leak free” similarly means that all owned objects in the tested path
are released under normal, error, cancellation, and shutdown cases with clean
sanitizer evidence. It remains a per-family/per-target conformance state until
the complete runtime matrix has passed.

The structured script bridge has a reproducible macOS gate:

```sh
npm run test:script-value-sanitize
```

It instruments the pinned Lua runtime, generated dispatch, value registry, and
flat C ABI with AddressSanitizer and UndefinedBehaviorSanitizer. macOS ASan does
not implement LeakSanitizer, so this command proves memory-access/UB cleanliness
for its exercised paths, not whole-runtime leak freedom. Leak closure additionally
requires balanced registry/runtime ownership counters and a target where LSAN is
available.
