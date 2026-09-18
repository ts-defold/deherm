---
type: Research Note
title: Measured binding-transport overhead
description: Compile-time-switched DEHERM_PROFILE telemetry, the generated per-route transport spans behind it, and the first measured cost of the Lua bridge against a raw-Lua baseline.
tags: [telemetry, performance, bindings, transports, lua, profiling, measurement]
status: host-harness-measured-engine-unverified
generated: { by: claude/opus-5, at: 2026-09-18T19:10:00-04:00 }
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
| `typed-native` (universal extern_c C ABI) | 725 | stub backend; framing only |

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

# The typed-native finding

The `typed-native` extern_c C ABI measured **725 ns per call with a stub backend
that does nothing** - 180x the `c-abi-native` transport and more than twice the
complete Lua bridge. The generated dispatcher value-initialises its fixed
per-call frame scratch on every call: 32 + 4 `ScriptValue` (48 bytes each), two
256-entry `ScriptTableEntry` arrays (96 bytes each), a `ScriptMatrix4Arena`, and
a 32-slot `ScriptUrlArena`. That is **53,472 bytes zeroed per call**, which at
M4 store bandwidth accounts for essentially the whole figure.

This is an allocation-free path by the memory policy's definition - the storage
is stack-resident and bounded - but it is not a cheap one. The policy's rule
that hot paths must not touch the general heap says nothing about zeroing 52 KiB
of stack per dispatch. Sizing the frame to the route's actual contract, or
skipping the value-initialisation for the unused tail, is the obvious next
change; neither has been attempted or measured.

# Evidence boundary

These are host-harness figures from generated code compiled by the local
toolchain against the pinned Lua 5.1 sources and stub providers. They are not
packaged-engine evidence, not JSI evidence, and not conformance evidence. The
`c-abi-native` and `typed-native` numbers measure generated framing over stubs,
not any Defold call. No figure here has been observed inside a running Defold
engine.
