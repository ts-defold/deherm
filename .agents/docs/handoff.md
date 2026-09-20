---
okf_version: "0.2"
title: "Active implementation handoff"
type: reference
status: "active"
tags: [handoff, verification, policy, compiler, ci, tooling, war-battles]
---

# Active implementation handoff

Continue déherm in `/Users/mini/Documents/defold-hermes-recovery` on `main`.
Read `AGENTS.md`, the knowledge-base index, the accepted generated-binding
verification decision, and the ordered execution goal before changing code.
Do not reset or discard the dirty tree. Generated artifacts change only through
their owning generators.

## Locked verification boundary

Déherm verifies the bridge it generates. Every concrete emitted Lua or dmSDK
call must have a verification twin derived from the same IR. It proves the
stable identity, exact runtime symbol or module/member, overload and signature,
ABI layout, argument/result order and values, bounds, stack discipline,
ownership, invalidation, and release behavior. Defold remains authoritative for
the implementation and game semantics behind that call.

An API is not withheld and is not called unverified merely because it lacks a
bespoke live-game fixture. Generated lanes that pass the exact bridge contract
are `verified`. Only positive source or runtime contradictions are `suspect` and
receive deterministic issue/docs links. Native headless and Playwright
HTML5/Wasm runs are integration sentinels, not one scenario per function.

The documented `sys.set_render_enable` identity must select the source-registered
`sys.set_render_enabled` runtime member. Source is authoritative when reference
documentation and registration code disagree.

## Current wave

The script surface has a total machinery partition: 915 generated universal
runtime calls, eight component-property compiler intrinsics, and three timer
bridges cover all 926 documented routes. The native universal dispatcher test
iterates every universal operation row, and the JavaScript census checks every
row's stable ID, module, member, and contract against generated policy. The
dmSDK surface carries a materializable recipe for all 1,361 runtime
declarations, with silent omission forbidden; exact-call twins for every
concrete usage are the next implementation frontier.

The route report now uses only `verified` and `suspect`. Its two current suspect
routes are the Box2D v3 user-data functions positively commented out in source;
ordinary fixture coverage is reported separately. The source-name correction
for `sys.set_render_enable` is verified rather than suspect.

The current worktree contains this verification wave and generated downstream
artifacts. `main` is also three commits ahead of `origin/main` with the
compiler-owned policy realization work. No subagent is active.

## Immediate resume order

1. Finish Wave 0 in `roadmap/next-execution-goal.md`.
2. Build the missing local `shermes` target, then rerun the focused Static
   Hermes universal-value test. The last failure was `ENOENT` for
   `build/native/bin/shermes`, not a test assertion.
3. Run the complete owned regeneration/check set, reseal policy only after the
   outputs are current, inspect the diff, commit atomically, push, and make CI
   green.
4. Reconcile the open GitHub issues against the ordered roadmap: assign each
   issue to a wave, close duplicates and issues whose acceptance criteria are
   already proven, and update the surviving issues with evidence.
5. Implement Wave 1: generated exact-call vectors for every emitted script
   transport row and every materialized dmSDK usage, including callback,
   handle, result, lifetime, and extension cases.
6. Continue the remaining waves in order. Later product work may run in
   parallel, but it cannot redefine or bypass the generator/compiler/package
   boundary.

## Canonical backlog

The complete ordered backlog and completion rule are in
[`roadmap/next-execution-goal.md`](roadmap/next-execution-goal.md). Do not replace
it with an older live-engine-per-function conformance plan.
