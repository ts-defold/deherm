---
type: Architecture Decision
title: Budget allocations and keep generated hot paths allocation-free
description: Separate bootstrap, durable, frame-scratch, and stack storage so mobile and web memory costs are bounded, observable, and cache-conscious.
tags: [decision, memory, performance, bindings, arenas, cache-locality, mobile, web]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T17:12:56-04:00 }
---

# Decision

Deherm does not ban allocation. It assigns every allocation to a lifetime and
a budget. Generated binding hot paths must not invoke the general heap after
runtime warm-up. Durable state may allocate when a runtime is created or a
project is loaded, but its capacity, ownership, teardown, high-water mark, and
failure behavior must be explicit.

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
   than only an average call time.

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
