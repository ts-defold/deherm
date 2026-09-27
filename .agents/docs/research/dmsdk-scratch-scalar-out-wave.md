---
type: Design and Verification Report
title: dmSDK caller-owned scalar out-parameter bridge wave
description: Compiler-owned structural planning and provider-gated projections for dmSDK caller-owned scalar outputs.
tags: [research, bindings, dmsdk, out-parameters, codegen, jsi, static-hermes, wasm]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T23:00:00-04:00 }
---

# Outcome

The compiler-owned planner derives 30 caller-owned scalar-output candidates
from the pinned 1,361-row dmSDK projection IR. Candidate membership comes from
result roles, parameter roles and directions, and platform-family markers. The
emitter consumes that authenticated plan exactly; it no longer repeats
selection logic and neither layer contains a function-name allowlist.

| Disposition | Count | Structural rule |
| --- | ---: | --- |
| source-derived provider route | 6 | The structural shape plus diagnostic-free ownership, exact-one memory, success-path write, and synchronous/no-escape facts. |
| compatibility-preserved provider route | 5 | A route from the prior revision-derived `scratch-out-parameters` tranche that still matches the same structural pattern; missing source-effect facts remain visible as evidence gaps. |
| universal fallback | 19 | Structurally compatible, but neither source-proven nor covered by the compatibility admission. |

The generated report is
`packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json`. It preserves
every stable declaration/projection identity and the exact blockers for every
rejected row. The promoted symbols are:

1. `dmBuffer::GetCount`
2. `dmBuffer::GetStreamType`
3. `dmBuffer::GetContentVersion`
4. `TextLayoutGetBounds`
5. `dmGameObject::GetComponentId`
6. `dmGameObject::GetPropertyOptionsIndex`
7. `dmGameObject::GetPropertyOptionsKey`
8. `dmGameObject::GetPropertyAsHash`
9. `dmGameObject::GetPropertyAsFloat`
10. `dmGameObject::GetPropertyAsBool`
11. `dmHID::GetGamepadUserId`

The 19 fallback rows retain all missing-fact tokens. Compatibility-preserved
rows also retain their evidence gaps even though they remain selected, so a
consumer can distinguish preservation of an already tested route from new
source-derived proof.

# ABI and lifetime contract

The bridge uses one caller-owned `uint64_t` cell per native parameter plus a
separate result cell. Every `out` cell is zeroed before provider entry. An
`inout` value is checked before the provider call and checked again afterward.
Any provider error or invalid output clears every writable cell and the result,
so partially written output cannot escape.

Each pointer in this family denotes exactly one scalar. It is not a span and
cannot alias durable runtime storage. Borrowed handle lanes carry identity only;
the bridge neither retains nor releases them. A provider must prove the current
engine thread and validate handle provenance/liveness before invoking a native
symbol. Provider installation copies one fixed record before concurrent use;
concurrent replacement is outside the contract. A thread-local guard rejects a
same-thread nested dispatch before provider entry, so reentrancy fails
deterministically without corrupting caller storage.

Generated projections cover the C ABI, Dynamic Hermes JSI, Static Hermes
direct-memory declarations, browser/Wasm direct-memory descriptors, and typed
TypeScript result records. Dynamic Hermes uses `BigInt` for 64-bit and handle
lanes. ABI v2 adds a fail-closed `void` result kind, allowing `void` native
functions with typed scalar outputs to return an idiomatic TypeScript output
record without a synthetic `result` property. All eleven signatures compile
against the complete pinned SDK headers.

# Verification and evidence boundary

Run the focused and clean-room proof with:

```sh
node scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs --check
node --test \
  tests/dmsdk-scratch-scalar-out-bindings.test.mjs \
  tests/dmsdk-generator-pipeline.test.mjs \
  tests/dmsdk-clean-room-regeneration.test.mjs
node scripts/check-dmsdk-clean-room-regeneration.mjs
```

The focused suite independently rederives the 30/11/19 census, rejects stale
authenticated plans, compiles all eleven signatures, compiles/parses every
target projection, and executes every route through a fake provider. The native
harness covers success, invalid input/output, failure clearing, wrong-thread
rejection, and nested-dispatch rejection under AddressSanitizer and
UndefinedBehaviorSanitizer. Its 100,000-call warmed loop observes zero C++
allocations in generated glue. Clean-room regeneration reproduces all 88 owned
dmSDK artifacts byte-for-byte from registered pinned inputs.

This is not real dmSDK linkage or packaged-engine evidence. The generated
runtime deliberately embeds no native dmSDK call. A production provider still
needs exact target symbols, engine-thread attachment, enum-to-native success
semantics, and live handle validation. Browser descriptors likewise do not
prove that those symbols are exported into a Defold Wasm build. Consequently
the report records eleven fake-provider runtime routes and zero packaged-engine
runtime verifications. The staged TypeScript surface is not exported from the
public SDK barrel until those provider gates exist.

## Source ownership/effect facts

The package-owned frontend also inventories this envelope from pinned Defold
implementations and inline headers. Its neutral artifact is the shared
`defold-dmsdk-cpp-ownership-effect-facts.json` report, whose current pinned
source profile observes all 30 scratch structural rows. These body facts can
admit target-independent provider-boundary code generation because the Defold
source owns those semantics. They do not prove that a symbol exists, links, or
behaves under every target feature matrix; those remain separate provider and
packaged-engine gates. The artifact makes that partition executable:
`semanticAdmission` is `defold-revision-source` with the pinned implementation
as authority, while `targetAvailability` is explicitly
`not-established-by-source-analysis`. The scratch planner validates the whole
artifact contract before consuming a fact, so the generator cannot silently
reinterpret target availability as source-semantic evidence or vice versa.

## Compiler-owned authenticated plan

`@deherm/compiler` now owns
`defold-dmsdk-scratch-scalar-out-plan.json`. The plan selects the complete
structural envelope directly from result roles, parameter directions/roles,
and rejected-family facts; it does not use the historical
`scratch-out-parameters` tranche as a candidate list. Each candidate also
requires authenticated ownership, exact-one memory, success-path write, and
synchronous/no-escape facts from the C++ effect artifact. Missing or unsafe
facts produce explicit machine-readable blockers and retain the universal
fallback. An otherwise positive observation carrying any compiler diagnostic
is treated as unknown, so filtered AST recovery cannot silently weaken the
fail-closed boundary.

The current effect artifact observes all 30 structural candidates. Six
mechanically prove all four requirements in the plan:
`dmBuffer::GetCount`, `dmBuffer::GetStreamType`,
`dmBuffer::GetContentVersion`, `TextLayoutGetBounds`,
`dmGameObject::GetPropertyOptionsIndex`, and
`dmGameObject::GetPropertyOptionsKey`. Five additional routes preserve the
prior generated provider boundary through a narrow structural compatibility
admission. The single authenticated plan therefore owns 30 structural
candidates, 11 selected routes, and 19 universal fallbacks. The production
emitter realizes exactly that plan and has no private selector. This preserves
all seven prior optimizations and adds four source-derived routes without
claiming that compatibility is source proof. No plan or emitted lane installs
a production Defold provider; `packagedEngineRuntimeVerified` remains zero. A
relational test rejects overlap with higher-priority specialized families, and
withdrawing source proof demotes a newly inferred route to universal fallback.
