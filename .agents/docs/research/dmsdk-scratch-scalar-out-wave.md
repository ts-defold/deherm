---
type: Design and Verification Report
title: dmSDK caller-owned scalar out-parameter bridge wave
description: Complete structural partition and provider-gated projections for the dmSDK scratch-out-parameters tranche.
tags: [research, bindings, dmsdk, out-parameters, codegen, jsi, static-hermes, wasm]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T23:00:00-04:00 }
---

# Outcome

The pinned 1,361-row dmSDK projection IR contains 79 declarations in the
`scratch-out-parameters` ABI tranche. The generator partitions all 79 from
result roles, parameter roles and directions, and platform-family markers. It
does not contain a function-name allowlist or per-symbol exception table.

| Disposition | Count | Structural rule |
| --- | ---: | --- |
| provider-gated scalar out ABI | 7 | Scalar or enum result; value parameters are bounded scalars, enums, or borrowed handles; pointer parameters are scalar/enum `out` or `inout`; at least one pointer is writable; not platform-gated. |
| blocked with row-local tokens | 72 | The complete complement: records, templates, strings, opaque/unknown pointers, unsupported results or directions, no writable scalar pointer, or platform-specific ABI. |

The generated report is
`packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json`. It preserves
every stable declaration/projection identity and the exact blockers for every
rejected row. The promoted symbols are:

1. `dmGameObject::GetComponentId`
2. `dmGameObject::GetPropertyAsBool`
3. `dmGameObject::GetPropertyAsFloat`
4. `dmGameObject::GetPropertyAsHash`
5. `dmGameObject::GetPropertyOptionsIndex`
6. `dmGameObject::GetPropertyOptionsKey`
7. `dmHID::GetGamepadUserId`

The 72 blocked rows are not reduced to one exclusive reason because many need
several capabilities. The dominant overlapping machine blocker counts are:

| Blocker | Rows |
| --- | ---: |
| call-thread affinity, native linkage, pointer lifetime/bounds, target symbol matrix | 72 each |
| output initialization/failure policy | 70 |
| lacks a writable scalar pointer | 58 |
| handle ownership/nullability/lifetime | 46 |
| enum width/domain validation | 42 |
| record layout/alignment/copy semantics | 25 |
| C-string input position | 15 |
| opaque type ABI contract | 10 |
| template specialization set | 10 |
| opaque output pointer | 9 |
| receiver provenance/lifetime | 7 |
| platform-gated family | 1 |

The report retains the more precise position, direction, and type token for
each occurrence; these aggregate counts are only a review aid.

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
lanes. The seven real signatures compile against the complete pinned SDK
headers.

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

The focused suite independently rederives the 79/7/72 census, rejects policy or
source drift, compiles all seven signatures, compiles/parses every target
projection, and executes every route through a fake provider. The native
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
the report records seven fake-provider runtime routes and zero packaged-engine
runtime verifications. The staged TypeScript surface is not exported from the
public SDK barrel until those provider gates exist.
