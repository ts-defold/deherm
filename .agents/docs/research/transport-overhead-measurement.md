---
type: Research Note
title: Measured binding-transport overhead
description: Compile-time-switched DEHERM_PROFILE telemetry, the generated per-route transport spans behind it, the measured cost of the Lua bridge against a raw-Lua baseline, and the contract-sized frame that took the typed-native transport from 733-773 ns to 43-68 ns.
tags: [telemetry, performance, bindings, transports, lua, profiling, measurement, frame-sizing, memory]
status: host-harness-measured-engine-unverified
generated: { by: claude/opus-5, at: 2026-09-18T20:45:00-04:00 }
sources:
  - id: dm-profile
    resource: ../../../upstream/defold/engine/dlib/src/dmsdk/dlib/profile.h
    title: Defold's DM_PROFILE compile switch at profile.h:112
    author: team:defold
  - id: lua-conf
    resource: ../../../upstream/defold/engine/lua/src/dmsdk/lua/luaconf.h
    title: Pinned Lua 5.1 LUAI_TRY configuration
    author: team:defold
  - id: benchmark
    resource: ../../../native/transport_profile_benchmark.cpp
    title: Transport benchmark harness
    author: team:ts-defold
  - id: telemetry-decision
    resource: ../decisions/telemetry-wire-format.md
    title: Allocation-light telemetry decision
    author: team:ts-defold
---

# The switch

`DEHERM_PROFILE` is a CMake option, OFF by default, that turns on generated
timing spans at every binding transport boundary. It is a build-time switch,
never a runtime flag.

It mirrors Defold's discipline in `profile.h:112`, where `DM_PROFILE` becomes an
empty macro under `NDEBUG`, with one deliberate difference: `DEHERM_PROFILE` is
independent of `NDEBUG`. Defold's profiler is unconditionally null in a release
build, so it cannot answer "what does this transport cost in the binary we
ship". `DEHERM_PROFILE=ON` with `CMAKE_BUILD_TYPE=Release` can.

When the switch is on, each span is also emitted into `DM_PROFILE_DYN`, so
Defold's own profiler and web profiler show deherm scopes for free. That
emission uses exactly Defold's own condition (`!NDEBUG && !DM_PROFILE_NULL`),
because outside it there is no profiler to emit into. The Extender compiles
packaged extensions with `-O2 -g` and no `NDEBUG`, so a shipped extension built
with `DEHERM_PROFILE` does get the dmProfile scopes; the deherm ring works
either way.

# Compile-out proof

`pnpm test:profile-compile-out` builds the same target twice from the same
sources and reads the two linked artifacts with `nm -C` and `strings`. It
asserts that eleven telemetry markers - the ring functions, the generated
identity resolvers of all three instrumented transports, and the three cold
scope-name prefixes - are **absent** from the OFF binary and **present** in the
ON binary. Checking the ON build matters: a proof that cannot fail proves
nothing, and without it a generator that silently stopped instrumenting would
pass vacuously.

Measured on the transport benchmark target: 522,696 bytes with the switch off,
624,296 bytes with it on. The only "profile" symbols surviving the OFF build are
the pre-existing, unrelated `RuntimeProfile` route-availability concept.

# Generated instrumentation

Nothing is instrumented by hand. Three generators emit a uniform span at their
transport boundary plus a per-route identity table, all inside
`#if DEHERM_PROFILE_ENABLED`:

| Generator | Boundary | Transport | Routes | Contract shapes |
| --- | --- | --- | ---: | ---: |
| `generate-script-handle-lowering.mjs` | `CapturedLuaRouter::dispatch` | `lua-stack` | 407 | 151 |
| `generate-dmsdk-borrowed-handle-bindings.mjs` | `deherm_dmsdk_borrowed_dispatch` | `c-abi-native` | 82 | 15 |
| `generate-script-universal-value-bindings.mjs` | `deherm_script_universal_dispatch` | `typed-native` | 915 | 45 |

Contract-shape ids are interned from the same generated codecs the dispatcher
uses, so the shape a span reports cannot drift from the call it describes. Cost
is therefore attributable per route, per contract shape, and per transport
without a hand-written call site anywhere.

The span deliberately excludes the null-frame check and the O(log n) stable-id
lookup that precede it, so inserting it changes no existing control flow.

# Producer ring

One fixed-capacity, preallocated single-producer ring of 32-byte records, laid
out exactly as the telemetry wire-format decision specifies. Default capacity is
8,192 records (256 KiB of static storage), set by
`-DDEHERM_PROFILE_RING_CAPACITY`. A write to a full ring increments `dropped`
and is discarded; it never blocks, never grows, and never allocates. Verified in
the benchmark: the timing loops overran the ring and reported 10,191,817 drops
with no failure, while the bounded 1,600-record sampling pass reported zero.

Transport spans use a new record kind, `transport span` (5), documented in the
decision's kind table. `value_a` carries the elapsed nanoseconds directly rather
than pairing a begin and an end record: one record and one clock pair per
crossing instead of two of each.

# Measurement

Machine: Apple M4, 16 GiB, macOS 26.5.2, Apple clang 21.0.0, arm64.
Build: `CMAKE_BUILD_TYPE=Release` (`-O3 -DNDEBUG`).
Harness: `native/transport_profile_benchmark.cpp`, 20,000 warm-up calls then
9 repeats of 100,000 calls. Each cell below is the mean of three whole-binary
runs of the best-of-9 repeat mean; best-of is the most noise-robust statistic
available on a shared machine. The host was under load average ~10 on 10 cores
during these runs; spread across the three runs was under 2% on every figure
except the 2arg-0res raw-Lua cell, where one run measured 28.9 ns.

One route per distinct arity shape, restricted to shapes the raw-Lua baseline
can reproduce byte-for-byte: scalar arguments, at most one scalar result, and
no game-object instance context.

| Path | 1arg-0res | 1arg-1res | 2arg-0res | 2arg-1res | 3arg-0res | 4arg-0res |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw Lua | 14.6 | 19.5 | 16.9 | 20.9 | 17.9 | 21.0 |
| raw Lua under `lua_cpcall` | 228.5 | 231.5 | 228.9 | 232.6 | 230.5 | 233.1 |
| generated `lua-stack` transport | 303.5 | 311.3 | 306.0 | 310.0 | 302.2 | 309.6 |
| **bridge over raw Lua** | **288.9** | **291.9** | **285.2** | **289.1** | **284.3** | **288.6** |
| **bridge over protected Lua** | **75.0** | **79.8** | **77.1** | **77.4** | **71.7** | **76.5** |

All figures nanoseconds per call.

| Transport | ns/call | Note |
| --- | ---: | --- |
| `c-abi-native` (82 borrowed-handle bindings) | 4.0 | stub provider; framing and validation only |
| `typed-native` (universal extern_c C ABI) | 725 | stub backend; framing only. Superseded - see below |

## What the number means

**The generated Lua bridge costs 284-292 ns per call over calling the same Lua
function directly, on this machine, for these contract shapes.**

That total decomposes cleanly, and the decomposition is the useful part:

* **~212 ns is `lua_cpcall`, not deherm.** The same raw call wrapped in one
  `lua_cpcall` costs 228-233 ns against a 15-21 ns unprotected call. The pinned
  Lua 5.1 sources compile as C with `LUA_ANSI`, so `LUAI_TRY` resolves to
  `setjmp` (`luaconf.h:624`) rather than `_setjmp`; on macOS that saves the
  signal mask. The bridge pays this once per dispatch because a Lua error must
  not unwind through C++.
* **~72-80 ns is the bridge itself**: route validation, the runtime-profile
  availability gate, argument and result codecs, scratch marks, and stack
  restoration. That is the part deherm owns, and it is roughly four times the
  cost of the bare Lua call it wraps.

## Caveats that bound this number

* The Lua target is a C closure in a host fixture, not a real Defold engine
  function. This measures the crossing, not the work behind it.
* The pinned Lua 5.1 build here is not what Defold ships on desktop or mobile:
  the engine links `luajit-5.1`. The `lua_cpcall` component is therefore
  specific to this harness and must be re-measured against the packaged engine
  before anyone quotes it as a shipping figure.
* The JSI leg (`JS -> JSI -> C ABI`) is **not** included. These figures start at
  the C ABI. A JSI-inclusive number needs a Hermes runtime in the loop.
* Engine-attached measurement belongs in the headless in-process harness
  (`research/headless-engine-conformance.md`). The record format here is
  designed for that consumer; no engine-attached number has been taken yet.

## Instrumentation cost

Running the identical binary both ways measures what the telemetry itself costs:

| Transport | OFF | ON | Span cost |
| --- | ---: | ---: | ---: |
| `c-abi-native` | 4.0 | 30.4 | +26.4 |
| `lua-stack` (2arg-0res) | 306.0 | 337.3 | +31.3 |

About 26-31 ns per span, which is two `std::chrono::steady_clock::now()` reads
plus a 32-byte store and an index bump. The scope takes exactly two clock reads:
the microsecond timestamp is derived from the entry read rather than taken
separately.

`native/script_handle_router_test.cpp` and
`native/script_universal_value_capi_test.cpp` both report zero warm C++
allocations with the switch on as well as off, so turning telemetry on does not
put the producer path on the heap.

Clock resolution on this machine is ~41.7 ns (the mach timebase quantum), so a
single span value is quantised; the aggregates the ring reports over many spans
are the meaningful output. The ring's own per-shape means for `lua-stack` land
at 250-345 ns, below the wall-clock ON figure, because the span excludes the
route lookup and its own exit read.

# The typed-native finding, and the fix

The `typed-native` extern_c C ABI measured **725 ns per call with a stub backend
that does nothing** - 180x the `c-abi-native` transport and more than twice the
complete Lua bridge. The cause was not the codecs: the generated dispatcher
value-initialized one fixed per-call frame for every one of its 915 routes -
32 + 4 `ScriptValue` (48 bytes each), two 256-entry `ScriptTableEntry` arrays
(96 bytes each), a `ScriptMatrix4Arena` and a 32-slot `ScriptUrlArena`, which is
**53,472 bytes zeroed per dispatch** whether the route could address any of it or
not.

That frame was allocation-free by the memory policy's original definition - it
is stack-resident, bounded, and never reaches the heap - which is exactly why
the policy now covers per-call *initialization* as well as allocation. See
`decisions/memory-and-hot-path-policy.md`.

## Contract-sized frames

`scripts/generate-script-universal-value-bindings.mjs` now derives each route's
frame from the same projected signature its arity contract comes from. Both
halves of the signature are walked separately, including inside union variants,
and the walk answers three structural questions: can this route's parameters
carry a table, can its returns, and can either reach a `matrix4` or a `url`. A
constructor whose contents the pinned IR does not inline - `dynamic`, a
`record-ref` or `named` schema resolved elsewhere, a callback, or a constructor
a later Defold revision introduces - widens the frame to the family maximum
rather than narrowing it, so an unrecognized shape costs memory and never loses
a bound.

Nothing is hand-written per route. The generator interns the distinct frame
shapes - **89 profiles over 915 routes** - emits one `runContractFrame<...>`
stub per profile and a dense `uint8` route-to-profile table, and publishes the
same four capacities on the `Operation` descriptor the dispatcher already
validates against. A generator test parses both emitted files and asserts the
descriptor and the stack frame are still the same numbers, because a frame
narrower than its descriptor would refuse calls the descriptor accepts. The
per-route footprint is in
`packages/bindings/generated/defold-script-universal-value-bindings.json`, so a
dispatch's cost is auditable without a profiler.

There is one dispatcher body, shared by every profile; only the frame shape is
templated. The decoder's input-table bound now comes from the frame it was
given rather than from the family maximum macro, which is what makes a
zero-capacity table frame fail closed instead of writing into a smaller array.

Result across the family: **607 of 915 routes need no table scratch, no Matrix4
arena and no URL arena at all**, 708 need no table scratch, and the median
route's frame is **96 bytes**. The mean is 7,209 bytes against the previous flat
53,472.

## Measured before and after

Machine: Apple M4, 16 GiB, macOS 26.5.2, Apple clang 21.0.0, arm64, load
average 2.0-4.1 on 10 cores (a quieter host than the Lua-bridge table above,
which is why the "before" column reads 733-773 rather than 725; the before and
after binaries were run interleaved, three runs each, on the same host in the
same minute).
Build: `CMAKE_BUILD_TYPE=Release` (`-O3 -DNDEBUG`), `DEHERM_PROFILE=OFF`.
Harness: `native/transport_profile_benchmark.cpp`, 20,000 warm-up calls then 9
repeats of 100,000 calls; each cell is the mean of three whole-binary runs of
the best-of-9 repeat mean. The typed-native sweep now selects one route per
distinct `Narg-Mres` contract shape in stable-id order, so the same route is
measured on both sides.

| Shape | Route | Frame bytes | Before | After |
| --- | --- | ---: | ---: | ---: |
| 0arg-0res | `profiler.dump_frame` | 0 | 733.3 | **43.0** |
| 0arg-1res | `render.get_height` | 48 | 736.1 | **51.0** |
| 1arg-0res | `physics.wakeup` | 1,344 | 742.1 | **64.5** |
| 1arg-1res | `b2d.joint.get_body_b` | 96 | 746.4 | **54.5** |
| 2arg-0res | `physics.destroy_joint` | 1,392 | 749.7 | **68.4** |
| 2arg-1res | `resource.create_sound_data` | 27,312 | 739.1 | **413.8** |
| 3arg-0res | `bullet3d.rigid_body.apply_impulse` | 144 | 736.2 | **55.1** |
| 4arg-0res | `gui.set` | 27,360 | 745.3 | **421.6** |
| 4arg-1res | `physics.raycast` | 51,984 | 760.6 | 742.3 |
| 3arg-3res | `socket.select` | 52,032 | 773.4 | 754.1 |

All figures nanoseconds per call. Every frame before this change was 53,472
bytes. Run-to-run spread was under 2% on every cell except the before column's
0arg-0res route (713-762).

Controls in the same runs: `c-abi-native` 4.3 -> 4.1 and 4.1 -> 4.0 ns, and the
`lua-stack` transport 305-317 -> 302-310 ns for five of its six shapes, with one
noisy 2arg-0res cell at 375. Neither transport's code changed.

## What the numbers say

The ten points fit a straight line in frame bytes with R^2 = 0.9998:

```
ns/call = 49.4 + 0.01344 x frame bytes
```

That is **~49 ns of actual dispatch** - the stable-id lookup, the two bound
checks, the decode loop, the backend call, the encode loop - plus **13.4 ps per
byte of frame scratch value-initialized**, or about 74 GB/s of L1-resident zero
stores, which is a plausible M4 store rate. Extrapolating the fit to the old
fixed frame predicts 768 ns; the measured before column is 733-773. The
diagnosis and the fix are the same model.

The three routes that barely moved are the honest cases: `physics.raycast`,
`socket.select` and `b2d.world.overlap_aabb` take a table in *and* return one,
so they still carry both 24,576-byte entry arrays and both arenas. `gui.set` and
`resource.create_sound_data` take a record parameter and return a scalar, so
they keep one array and pay half.

## Is the remaining zeroing needed?

Measured rather than assumed, and the answer splits:

* **Scratch the generated decoder fills** - the argument array and the input
  table entries - is provably written before read: `DecodeContext::decode`
  assigns `*output = {}` before it writes any field, and nothing reads above the
  counters the decoder itself advances. Its zeroing is dead work. It is *not*
  removable in C++ as the types stand: `ScriptValue` and `ScriptTableEntry`
  carry default member initializers, so every declaration form that begins their
  lifetime also zeroes them, and the alternatives (a byte buffer reinterpreted
  as entries, or an uninitialized union member) are exactly the constructs the
  family's ASan/UBSan gate exists to reject. Dropping the initializers from
  those two hand-written ABI structs would make every other `ScriptValue x;` in
  the tree silently uninitialized, which is a worse trade than the 3,771 bytes
  per call it would recover.
* **Scratch a backend fills** - the result array and the output table entries -
  is load-bearing and stays. Zeroing is what makes a partially written result
  graph decode as `undefined` rather than as garbage, and `releaseGraph` walks
  those slots on the error path.

So the remaining lever is not a zeroing trick; it is retaining fewer bytes. Two
are already visible and both are blocked on hand-written ABI, not on this
generator: `ScriptCallFrame::urlArena` is typed `ScriptUrlArena<32>*` and
`ScriptMatrix4Arena::kCapacity` is fixed at 16, so a route that can reach one
URL still gets storage for 32 (1,296 bytes, ~17 ns); and the 256-entry table
bound is a policy number because the IR states no per-route element count, which
is what the 24,576-byte arrays cost. Resolving `record-ref` schemas to their
field counts would size most of the remaining table routes precisely.

Behavior is unchanged: the recording engine still drives 915 routes over three
transports with 0 violations, 0 expectation divergences and 0 transport
divergences; the reentrancy, cycle, exhaustion, stale-handle and warm
zero-allocation gates in `native/script_universal_value_capi_test.cpp` pass in
Release and under ASan/UBSan; and `pnpm test:profile-compile-out` still proves
the telemetry compiles out.

# Evidence boundary

These are host-harness figures from generated code compiled by the local
toolchain against the pinned Lua 5.1 sources and stub providers. They are not
packaged-engine evidence, not JSI evidence, and not conformance evidence. The
`c-abi-native` and `typed-native` numbers measure generated framing over stubs,
not any Defold call. No figure here has been observed inside a running Defold
engine.
