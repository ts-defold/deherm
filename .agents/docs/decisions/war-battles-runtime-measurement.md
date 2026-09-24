---
type: Architecture Decision
title: Measure War Battles runtime cost without promoting deterministic work units
description: Keep source-bound deterministic operability evidence separate from owner-observed wall-clock and memory measurements across Node, Deno, and browser hosts.
tags: [decision, war-battles, performance, memory, measurement, browser, deno, node]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-23T00:00:00-04:00 }
---

# Decision

War Battles has two performance evidence lanes. The existing
`performance-operability.json` remains a deterministic source-bound record of
work units, fixed-pool high-water, snapshot bytes, and reconciliation. It does
not become a timing benchmark. The runtime measurement owner
`examples/war-battles-online/integration/check-runtime-measurement.mjs` uses a
monotonic `performance.now()` clock around the real authoritative
`MatchServer.step` call and records wall-clock distributions separately.

The same measurement harness runs under Node and Deno. Each runtime reports its
own host identity and memory source (`process.memoryUsage` or
`Deno.memoryUsage`); samples are not merged or treated as cross-runtime
comparisons. The Deno command is
`integration/runtime-measurement-deno.ts`.

# Browser boundary

The optional `--browser` owner run measures packaged wasm-web navigation timing
and, when Chromium exposes it, `performance.memory` under explicit `jsHeap*`
fields. A browser page does not embed Hermes, so Hermes heap, Lua handles,
native/Wasm allocator counts, and Defold engine frame timing remain null or are
reported with an unavailability reason. Missing browser APIs are evidence of
an unobservable metric, not zero.

# Allocation boundary

Resident/heap snapshots are not allocation counters. The runtime artifact
always records `allocations.measured: false`, `perTick: null`, and
`zeroClaim: false`; no constant-size buffer or fixed pool is used to infer
zero allocations. Allocation claims require an allocator instrumented by the
owner for the exact runtime and scope.

# Owner commands

```sh
pnpm --dir examples/war-battles-online runtime:measurement:record
pnpm --dir examples/war-battles-online runtime:measurement:browser:record
pnpm --dir examples/war-battles-online runtime:measurement:deno
pnpm --dir examples/war-battles-online runtime:measurement:check
```

The browser command requires a packaged wasm-web bundle and a browser target;
without those inputs the artifact keeps browser timing and memory null with a
reason. Recorded values are machine-dependent observations and must not be
used as deterministic regression fixtures.

