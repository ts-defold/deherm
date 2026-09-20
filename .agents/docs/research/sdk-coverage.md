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
Parsed as: `wasm32-unknown-unknown` against the pinned sysroot
`wasi-sysroot-25.0/include/wasm32-wasip1`
(`sha256:d09c62c18efcddffe4b2fdd8c5830109cc8e36130cdbc9acdc0bd1b204c942bb`), an assignment that
defines none of `ANDROID`, `_MSC_VER`, `_WIN32`, `__ANDROID__`, `__APPLE_CC__`, `__APPLE__`, `__EMSCRIPTEN__`, `__linux__`
and therefore takes no platform branch. This is not a bundle target and says
nothing about which targets get which declaration; that is
`packages/bindings/generated/defold-dmsdk-target-conditionals.json`.

Clang parsed **121 of 121** public
`dmsdk/**/*.h(pp)` headers and accounted for **2141**
declarations. A declaration is accounted for when it is either a type-only
dependency, a direct scalar ABI candidate, or explicitly blocked on a lowering
policy. Nothing is silently discarded.

The derivation parse resolves those source headers against the checksum-pinned
Defold SDK for the same revision. It retains only the **91**
transitively referenced enum, record, alias, and template facts needed to
interpret public signatures. The SDK archive is derivation input, not a
consumer dependency or a published source snapshot.

## Lowering state

| State | Declarations |
| --- | ---: |
| `direct-candidate` | 23 |
| `needs-policy` | 1354 |
| `type-only` | 764 |

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
| `type-alias` | 306 |
| `variable` | 52 |

## Parse failures

None.

## Partial-AST diagnostics

32 headers emitted Clang diagnostics. Most are the pinned WASI libc guard observing that the deliberately platform-neutral parse triple does not identify itself as a WASI bundle target; a small remainder are header-local dependency or declaration-order diagnostics. Clang still produced each target-header AST, and the exact Defold SDK support headers resolved generated DDF and third-party signature types before policy emission.

The machine-readable inventory is
`packages/bindings/generated/defold-sdk-inventory.json`. CI regenerates and compares it
so new or removed upstream API cannot drift unnoticed.
The enriched per-symbol ledger is `packages/bindings/generated/defold-sdk-ir.json`.

## Executable coverage audit

The complete declaration surface is generated, but this source inventory does
not embed mutable runtime-implementation counts. The exact generated adapter
and blocker census lives in the SHA-bound family reports under
`packages/bindings/generated/defold-dmsdk-*.json`; the ABI-shape queue is
`packages/bindings/generated/defold-dmsdk-abi-shapes.json`. Host behavior, extension
retention, target compilation, and live-engine observation remain independent
evidence stages.

“Zero unresolved TypeScript tokens” means only that the generator classified
every source token. It does not imply ABI layout, ownership, lifetime, target
support, or runtime compatibility.
