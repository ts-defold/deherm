---
type: Implementation Plan
title: Callback fallback resilience without reviewed-route dependency
description: Restore universal callback execution for newly discovered Defold APIs while preserving bounded ownership, optimized routes, and revision-parametric generation.
status: active
generated: { by: codex/gpt-6, at: 2026-10-23T11:37:12Z }
sources:
  - resource: ../../../defold/defold_hermes/src/script_scalar_lua_adapter.cpp
    title: Universal Lua adapter and callback ownership
  - resource: ../../../scripts/generate-script-universal-value-bindings.mjs
    title: Universal callback transport selection
  - resource: ../../../scripts/generate-script-callback-lifecycle.mjs
    title: Reviewed lifecycle specialization generator
  - resource: ../../../packages/compiler/src/script-recording-engine.mjs
    title: Generated exact-call applicability model
  - resource: https://github.com/ts-defold/deherm/actions/runs/39811357036
    title: Failed alpha engine exact-call evidence
  - resource: https://github.com/defold/defold/blob/f2a96160d5d3b7755742945a1e0b8acacb0fb433/engine/record/src/record/record_script_extension.cpp
    title: Defold recorder callback ownership at the failing revision
---

# Scope and established evidence

The archived failed CI surface emits `script:recorder.start` (stable ID
3384075940, recording ordinal 875), selects its Lua adapter for execution, but
has no reviewed lifecycle row for it. Native `invokeUniversalValue` rejects
callback-bearing arguments before invoking Lua when that row is absent.
The generator separately blocks the browser callback transport for the same
missing review. This is a shared contract gap, not a recorder-specific ABI fix.
The archived mismatch was reproduced mechanically; the original hosted test
provides runtime evidence. Replaying that archive locally remains required.

Defold owns retention and destruction of its Lua callback. Our generic closure
owns a retained `ScriptCallback` through Lua userdata and `__gc`; existing
Hermes roots and browser tokens own their runtime-generation checks. Reviewed
one-shot/terminal/higher-order metadata must not be a precondition for that
generic ownership model. Do not invent one-shot semantics for unknown callbacks.

Out of scope: scheduler/cadence changes, a new C++ parser, public API renames,
Static Hermes callable-value support, unrelated emitters, and game changes.
Keep existing Static Hermes limitations and fast-path selections explicit.

# Three planning passes

1. Draft: record the archived failure, scope, task graph and acceptance tests.
2. Completeness/correctness audit: inspect native and browser selection,
   ownership after runtime/adapter teardown, returned closures, nested records,
   generation inputs and clean-room ownership; amend missing context before review.
3. Independent adversarial review: challenge the audited plan read-only;
   reconcile accepted/deferred/rejected findings here before implementation.

The shared engineering-style file referenced by the maintainability skill is
absent on this host. Repository AGENTS.md and the available review/test rubric
remain applicable; do not invent a replacement style standard.

# Task graph and ownership

```text
P0 archived reproduction + draft
             |
P1 self-audit of both transports and ownership
             |
P2 independent adversarial review -> reconcile/freeze
             |
      +------+------+
      |             |
A Sol/native     B Sol/generator + browser
      |             |
      +------+------+
             |
I root integration + diff audit + owning regeneration
             |
V Luna focused/native/browser/sanitizer/aggregate verification
             |
R root signed commits + push + hosted failed-revision replay
```

| Task | Deliverable | Completion evidence |
|---|---|---|
| P0 | Failed revision and route identified; archive retained outside checkout | Archived emitted callback lacks lifecycle membership |
| P1 | Audit plan and identify all consumers of reviewed callback membership | Explicit findings and non-goals below |
| P2 | Independent adversarial findings reconciled | No unresolved safety blocker before coding |
| A | Generic native callback input uses its real ownership mechanism, not route allowlist; preserve codec/arity/context/bounds checks | Fresh route without a reviewed entry executes through real Lua/Hermes; retain/release and teardown remain sound |
| B | Generator/browser availability distinguishes generic transport from reviewed optimization; deterministic unseen-route tests | Synthetic new registration projects and executes without a hand-authored route row; no fabricated lifetime facts |
| I | Non-overlapping changes integrated, generated files changed only through their owners | Diff/ownership review; policy-only and clean-room reconstruction remain valid |
| V | One authoritative test per invariant, then native/browser execution and broad gates | Passed/failed/blocked command ledger with logs; no metadata-to-runtime promotion |
| R | Clean signed history and CI replay of failing Defold SHA | Exact-revision consumer/engine results; publication is not blocked by an optimization opportunity |

# Acceptance and test portfolio

- New input callback routes and callbacks nested in supported records are not
  rejected solely for missing reviewed metadata. Names/registration order may
  change without adding an override. Exercise absent-review and withdrawn-review
  states; absence of optional optimization evidence must not disable fallback.
- Retain/release, Lua GC, error cleanup, repeated invocation and nested reentry
  are checked through the real bridge. Audit script-instance deletion, runtime
  teardown, HMR generation invalidation and later Lua collection. Do not claim
  these from a forward-only recorder fixture; reuse focused lifecycle tests.
- Malformed descriptors, stale tokens, exhausted bounded scratch/registries,
  unsupported returned functions and wrong target contexts still fail safely.
  No new per-call allocation or global scratch, and no silent leak to runtime end.
- Preserve existing optimized output and exact-call selections. If no generator
  production change is needed for a native invariant, add its authority test
  rather than inventing new recipes. Browser membership currently does need
  correction; keep higher-order Lua function results separately restricted.
- Verify dynamic Hermes, browser/Wasm callback inputs, and existing Static
  Hermes output/limitations separately. Do not claim a new static callback ABI.
- Do not hand-edit generated fixtures. Root alone runs shared regeneration and
  maintains docs/package scripts; implementation agents do not commit.
- Luna runs formatter/static checks, scoped callback tests, real native exact
  calls and Hermes/Lua lifecycle tests, browser exact calls if toolchain present,
  applicable ASan/UBSan lifecycle tests, then `pnpm check` and `check:knowledge`.
  Resource-heavy builds are serialized. Record unavailable toolchains as blocked,
  never success. Replay the failed alpha surface in an isolated checkout/cache;
  do not replace the contributor upstream.lock.

# Audit and review record

Pass 1 (draft) complete. Pass 2 (self-audit) complete with these corrections:

- Native rejection is a presence/eligibility check only; after that check the
  generic adapter does not consume the reviewed lifetime. Removing that gate
  must preserve the real descriptor/codec checks and callback-root ownership.
- Browser generation has an independent `unreviewed-callback-lifecycle` block
  and ledger-count partition assertion. A native-only fix is incomplete.
  The recording applicability model consumes `browserCallback.registryEligible`;
  its expectation source must reflect generic transport eligibility rather
  than equating all eligible routes with reviewed specializations.
- `LuaCallbackThunk` accesses an adapter pointer before invoking the callback.
  Establish actual adapter/Lua/runtime destruction order before claiming that
  existing runtime invalidation alone proves every teardown case. Add a minimal
  lifecycle correction only for a reachable ownership failure, not speculative
  lifetime machinery for fabricated caller states.
- Existing tests freeze the reviewed census at 25. Retain that baseline evidence
  but add a separate unseen-route contract, not a new permanent recorder row.
- Existing source registration, signature shapes, bounded value transport,
  callback pools and emitted fact schemas should be reused. A generalized
  source-effect inference subsystem is not required for this fallback repair.

Pass 3 complete: independent Sol high review accepted the following bounded
corrections. Root independently confirmed extension finalization precedes
Defold's `lua_close`, and inspected the signature/eligibility consumers.

1. **Accept, safety blocker:** inbound Lua closures retain a raw adapter pointer;
   Lua finalizers can invoke one after extension finalization destroys that
   adapter. Guard adapter lifetime before any dereference, using initialization-
   owned storage; test adapter destruction, reinitialization and later GC under
   ASan/UBSan. No per-invocation heap allocation.
2. **Accept, correctness blocker:** derive unsupported callable results from
   output shapes, not `registryEligible == false`. Test new callback input,
   callable output, both together, and nested callable output independently.
   Preserve unsupported browser/static returned-function handling.
3. **Accept, completion blocker:** generic metadata may honestly have null
   lifetime/owner/thread-affinity. Do not fabricate values for the browser exact
   fixture. Its callback-slot collection only covers top-level arguments today;
   add a dedicated bounded nested-record runtime probe or structural traversal
   with observed invocation/release counts, not generation-only assertions.
4. **Correct acceptance:** same-realm HMR preserves valid callback roots, as does
   a rejected reload. Actual runtime destruction/browser reset invalidates them.
   Do not introduce automatic callback invalidation on every HMR event.
5. **Preserve:** ordinary same-revision provenance, policy validity, mixed-input
   rejection and reviewed census checks. Exercise new/withdrawn source evidence
   through declared derivation; runtime fallback never consults a revision switch.

No broader parser/effect-inference work, ownership framework rewrite, or
recorder-specific override is approved by this plan. Existing fast-path
selection, fixed pools, arena bounds and protected Lua invocation remain.
The shared style file is unavailable as noted above; no work is blocked by it.

Implementation ownership is frozen: Sol A owns `script_scalar_lua_adapter.cpp`,
its header if needed, `native/script_api_hermes_e2e.cpp`, and the authored
`tests/fixtures/script-api-e2e.ts`. Sol B owns universal-value/recording/lowering
generator logic and focused generator/browser tests. Root owns docs, package
scripts, central test registration, generated outputs, integration and commits.
Luna owns execution of validation commands and the external verification log.
Neither implementer runs shared regeneration or broad CMake builds. Coordinate
any file outside these slices with root first.

# Verification ledger

- Planning baseline: lifecycle 6/6, browser unit 4/4, generator suites 12/12
  passed on the unchanged pinned surface. These did not catch an unseen route.
- Native A: Luna rebuilt the authored fixture, observed the pre-fix executable
  fail at the reviewed-ledger gate, rebuilt the focused real Lua/Hermes target
  with parallelism 2, and observed `script-api-hermes-e2e:ok`.
- Native A sanitizer: the same target passed ASan/UBSan in the existing isolated
  sanitizer tree. A fresh tree's redundant Hermes build was stopped at 93/498
  steps and is not counted as a failed code check. Adapter/runtime/test code is
  instrumented; upstream prebuilt Hermes objects are not.
- Logs are retained under `/private/tmp/deherm-callback-wave-native-*.log`.
- Generator B and root integration: callback input eligibility no longer needs
  a reviewed lifetime; callable output blocking is derived from output shape.
  Generic metadata remains null rather than inventing terminal/one-shot facts.
  Recording fixtures traverse bounded nested records and use an isolated
  synthetic surface for actual browser verification. Pure mutation tests are
  registered in the normal aggregate; the opt-in browser execution and native
  ownership fixture are wired into the existing policy engine job.
- Root independently compared committed pre-change lowering output with the
  regenerated baseline: all 12,140 backend selections and 2,428 implementation
  lane sets are unchanged. This is generation/selection evidence, not a new
  end-to-end performance measurement.
- Owning regeneration refreshed the canonical sentinel before recipe extraction;
  the additive local fixture store was pruned only through its generator.
  The regenerated policy closure passes its generator check. No published
  historical policy or contributor upstream pin was changed.
- Browser execution passed outside the macOS sandbox: existing real Wasm probe
  exercised 1,052 routes, including 23 callback routes; the unseen nested-input
  probe observed two callbacks, four invocations, two releases and four bridge
  reentries. Both initial sandbox launches aborted Chrome before its debugging
  endpoint opened; the unchanged probes passed with the bounded escalation.
- Native regular and ASan/UBSan targets passed again after shared regeneration.
- Integration reconciled downstream hashes through the declared source pipeline:
  accounting descriptions feed table schemas/records, the canonical plan feeds
  typed-native reports, and recording must run after plan refresh. The independent
  source-pipeline SDK golden was refreshed with its capture command. No generated
  bytes were edited manually. Both clean rooms and the final aggregate pass.
- Focused materializer/generator tests passed 37/37, with the opt-in browser test
  skipped in that unit invocation and executed separately as recorded above.
- Exact-alpha hosted replay remains pending until the signed integration push.
- Aggregate verification passed both clean rooms (113 script and 135 dmSDK
  artifacts), then rejected the stale War Battles Static Hermes projection.
  Its owning regeneration changes only the plan, typed-bridge and record hashes;
  reachable routes, generated source and selection are unchanged. Its focused
  retest passed 13/13, and the complete aggregate subsequently passed.
- Final local gate: `pnpm check` exited 0, including script/dmSDK clean rooms,
  generated-state, type, package/materializer, Static Hermes bridge, game-session,
  documentation and knowledge checks. Log:
  `/private/tmp/deherm-callback-wave-integration-pnpm-check-final3.log`.
- Final real-browser rerun passed against the final recording report. The normal
  aggregate intentionally skips the opt-in browser execution; that execution was
  run separately, not inferred from the unit suite. No packaged Defold gameplay,
  new Static Hermes callback ABI, or cross-platform hosted result is claimed by
  these local tests.
