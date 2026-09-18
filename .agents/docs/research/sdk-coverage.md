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

The complete declaration surface is generated, but this source inventory does
not embed mutable runtime-implementation counts. The exact generated adapter
and blocker census lives in the SHA-bound family reports under
`bindings/generated/defold-dmsdk-*.json`; the ABI-shape queue is
`bindings/generated/defold-dmsdk-abi-shapes.json`. Host behavior, extension
retention, target compilation, and live-engine observation remain independent
evidence stages.

“Zero unresolved TypeScript tokens” means only that the generator classified
every source token. It does not imply ABI layout, ownership, lifetime, target
support, or runtime compatibility.
