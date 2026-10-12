---
type: Research Note
title: Static Hermes application typing and fair performance benchmark plan
description: Current strict-lowering boundary and an apples-to-apples benchmark contract for Lua, Dynamic Hermes, and typed Static Hermes.
tags: [research, static-hermes, performance, benchmarking, typescript]
status: blocked-on-whole-application-typing-and-common-runtime-harness
generated: { by: codex/gpt-5, at: 2026-10-12T00:00:00Z }
sources:
  - id: static-compiler
    resource: ../../../scripts/build-static-hermes.mjs
    title: Static Hermes C emission fixtures
    author: team:ts-defold
  - id: return-types-fixture
    resource: ../../../tests/fixtures/static-hermes-flow-compatible-function-return-types.ts
    title: Typed Flow-compatible return-annotation parser/runtime smoke
    author: team:ts-defold
  - id: transport-benchmark
    resource: ../../../native/transport_profile_benchmark.cpp
    title: Existing bridge transport benchmark
    author: team:ts-defold
  - id: static-build-gate
    resource: ../../../tests/war-battles-static-hermes-build-gate.test.mjs
    title: Static application build-mode assertions
    author: team:ts-defold
---

# Findings

The pinned `shermes` can compile and execute bounded sound-typed application
code. `scripts/build-static-hermes.mjs` emits the `typed-app.ts` lifecycle
fixture with `-fno-std-globals -typed -strict -O -emit-c`; the C is linked into
the Static Hermes test runner. A new regression also compiles function
expression, arrow, and class-method return annotations and runs them through
the Static runtime. This verifies a narrow typed-language path, not the full
déherm game graph.

A clean disposable bundle of the current game/dependency source closure does
not pass that same strict compiler command. It first fails in generated
`WebTransport.ts` anonymous-class members (`this.used`, `this.queue`,
`this.waiting`, `this.completion`, `this.queuedBytes`, `this.ended`, `this.locked`,
`this.budget`, and callback fields), which the type checker reports as
undefined. The same closure also reaches unsupported object-property shapes
and ambient globals such as `Promise`, `setTimeout`, `clearTimeout`,
`queueMicrotask`, and `URL`. The compiler stops after its diagnostic limit.
These are source typing and runtime-global coverage blockers before C
compilation or application linking; they are not evidence of a C backend or
Defold linker failure. Work to address generated WebTransport sources belongs
to its owning lane.

Release labels must describe the actual compiler mode. A Bob `release` variant
only selects the native release configuration; it does not imply
`shermes -typed -strict`. The current release projection described by the
Static build-gate test is untyped AOT over a fingerprinted JavaScript bundle
(`typed=false`, `strict=false`). Do not report that artifact as a sound-typed
Static application or use it as the typed-Static benchmark arm.

# Benchmark contract

The first fair workload should be one operation that has the same inputs,
observable output, and Defold boundary in all three paths: update a numeric
state from four scalar inputs, then invoke the same simulated
`render.set_viewport(x, y, width, height)` provider. Each iteration must
validate and accumulate the same checksum. The host simulation must be
explicitly named; do not mix host-only C callbacks with a claim about shipped
engine cost.

| Arm | Work to time | Required matching boundary |
| --- | --- | --- |
| Direct Lua | Lua function executes the state update and calls the provider | Same Lua state and C provider; raw direct call and protected call reported separately |
| Dynamic Hermes | Hermes JSI function executes the same workload | JSI host function calls that same simulated provider; warm the same realm before timing |
| Typed Static Hermes | `-typed -strict -O -emit-c` unit executes the same workload | Same provider ABI and argument values; compile and native link are separate phases |

Use a shared generated input vector/source of truth for the arithmetic and
parameters. Report compile/transform wall time, native compile/link wall time,
and runtime separately. Runtime results should include warm-up, repeated sample
distributions (median and tail percentiles), iteration count, compiler and
source revisions, target/optimization flags, and a checksum. Measure
allocations only in scoped allocator instrumentation with its overhead
disclosed; do not infer allocation counts from speed. Run the Dynamic Hermes
and typed Static arms against the same simulated provider before presenting
them as boundary-comparable. A shipped Defold device run remains a separate
validation stage.

# Evidence available now

The existing `native/transport_profile_benchmark.cpp` is useful as a bridge
microbenchmark, but is not the three-arm application harness above. It measures
raw/protected Lua versus generated `lua-stack`, and native C-ABI or
`typed-native` dispatcher calls over a stub provider. Its `jsi` profile enum is
an instrumentation category, not a direct timed Dynamic Hermes workload; it
does not execute a sound-typed Static application either. Its results cannot
be relabeled as Dynamic-versus-Static speedups.

Current bounded evidence is therefore:

* exact manifest-pinned `shermes` C emission: passed for the typed,
  Flow-compatible parser smoke (this does not invoke TypeScript-to-Flow
  conversion);
* CMake-native build/link and focused typed runtime: passed using the local
  source-built compiler from the same upstream revision (not the
  manifest-identical binary); the fixture's function-expression, arrow, and
  method annotations are accepted by the Flow-compatible grammar;
* full runner: fails a separate universal-marshaller assertion before its
  lifecycle calls;
* whole-game strict lowering: blocked in generated WebTransport typing and
  ambient declarations;
* apples-to-apples three-arm runtime, shipped-engine run, and matching
  allocation comparison: not yet implemented or measured.

The next measurable step is to extract the shared viewport workload into a
tiny fixture and add direct-Lua and JSI runner arms around one provider, then
compile that same typed source with the pinned `shermes` and call it through
the same provider ABI. Only after all three checksums match should runtime
distributions be collected and compared.
