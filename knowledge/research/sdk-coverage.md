---
type: Research
title: Generated dmSDK coverage inventory
description: Clang-derived coverage accounting for every public dmSDK header and declaration at the pinned Defold revision.
tags: [research, generated, dmsdk, bindings, coverage]
status: active
generated: { by: scripts/import-defold-sdk.py, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine
    title: Pinned Defold engine source
    author: team:defold
---

# dmSDK coverage inventory

Pinned revision: `7f0f554f41f9dce1e0ddff99bf08200657d1ee05`
Inventory platform: `arm64-macos`

Clang parsed **121 of 121** public
`dmsdk/**/*.h(pp)` headers and accounted for **2140**
declarations. A declaration is accounted for when it is either a type-only
dependency, a direct scalar ABI candidate, or explicitly blocked on a lowering
policy. Nothing is silently discarded.

## Lowering state

| State | Declarations |
| --- | ---: |
| `direct-candidate` | 23 |
| `needs-policy` | 1354 |
| `type-only` | 763 |

`needs-policy` is the generator queue: pointers, ownership, callbacks,
lifetimes, templates, arrays/spans, named handles, and wide integers must gain
an explicit ABI rule. It is not counted as implemented runtime compatibility.
`scripts/generate-dmsdk-sdk.mjs` expands these reason classes into explicit
per-symbol ABI strategies, hides non-public members, and emits the raw
TypeScript surface. Runtime implementation and conformance remain independent
coverage gates.

## Declaration kinds

| Kind | Count |
| --- | ---: |
| `class-template` | 6 |
| `constructor` | 61 |
| `destructor` | 8 |
| `enum` | 111 |
| `function` | 1175 |
| `function-template` | 20 |
| `method` | 113 |
| `record` | 289 |
| `type-alias` | 305 |
| `variable` | 52 |

## Parse failures

None.

## Partial-AST diagnostics

35 headers emitted Clang diagnostics, mostly because generated DDF headers are build artifacts not present in a source checkout. Clang still produced a target-header AST for the inventory. These headers must be re-imported against the packaged Defold SDK before code emission.

The machine-readable inventory is
`bindings/generated/defold-sdk-inventory.json`. CI regenerates and compares it
so new or removed upstream API cannot drift unnoticed.
The enriched per-symbol ledger is `bindings/generated/defold-sdk-ir.json`.

## Executable coverage audit

The complete declaration surface is generated, but the runtime bridge is still
early. Against this same pinned revision:

| Stage | Callable declarations |
| --- | ---: |
| Raw TypeScript signatures generated | 1361 |
| C ABI scalar thunks generated and packaged-SDK compiled | 26 |
| Host source-linked and behavior-tested | 25 |
| Retained in the final Defold engine | 0 |
| Callable from TypeScript/Hermes | 0 |
| Remaining callable lowerings | 1335 |

The successful custom-engine build proves all 26 thunk translation units
compile against the packaged Defold SDK and exist in the extension archive.
Because no JSI installer references them yet, the linker correctly dead-strips
them from `dmengine`. The 25 host behavior tests are representative local
tests, not full cross-target conformance.

The remaining primary lowering families are 436 pointer, 380 enum/handle, 103
out-parameter, 93 callback, 70 template/opaque, 56 method, 54 constructor, 44
pointer/span, 42 platform-gated, 37 record/reference, eight destructor, seven
variadic, and five blocked scalar declarations. “Zero unresolved TypeScript
tokens” therefore means the generator classified every token; it does not mean
ABI layout, ownership, lifetime, or runtime compatibility is complete.
