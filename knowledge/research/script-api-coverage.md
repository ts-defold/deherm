---
type: Research
title: Generated Defold script API coverage inventory
description: Declaration-level inventory of the public Lua-shaped engine API that TypeScript game code must replace.
tags: [research, generated, script-api, lua, typescript, coverage]
status: active
generated: { by: scripts/import-defold-script-api.py, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-ref-doc
    resource: https://d.defold.com/archive/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/share/ref-doc.zip
    title: Pinned Defold generated API reference
    author: team:defold
---

# Defold script API coverage inventory

The pinned reference archive contains **40** generated Lua
annotation modules and **2734** declarations. This is the
source for the ergonomic `defold.script.*` TypeScript surface; dmSDK headers
remain the source for the lower-level `defold.sdk.*` surface.

| Kind | Count |
| --- | ---: |
| `function` | 926 |
| `class` | 246 |
| `field` | 1398 |
| `enum` | 66 |
| `alias` | 98 |

The discovery inventory deliberately records each of the
**926 functions** as `needs-native-mapping`.
`scripts/generate-script-sdk.mjs` enriches that source ledger into the binding
IR, emits the complete TypeScript/TSDoc surface, and records runtime
implementation separately. A generated declaration is not automatically a
linked or conformance-tested binding.

The machine-readable inventory is
`bindings/generated/defold-script-api-inventory.json`.
The enriched per-symbol ledger is
`bindings/generated/defold-script-api-ir.json`.

## Executable coverage audit

Generation covers all 926 functions and all 410 named types, including TSDoc
and 1398 class fields. Runtime execution is a different ledger:

| Stage | Functions |
| --- | ---: |
| TypeScript signatures and ergonomic wrappers generated | 926 |
| Executable through the separate Timer native-module proof | 3 |
| Executable through the generated Lua-shaped SDK façade | 0 |
| Pending runtime lowerings | 923 |

The three proven operations are `timer.delay`, `timer.cancel`, and
`timer.trigger`; they run native Hermes -> JSI -> C ABI -> Lua and have browser
counterparts. The lower-case generated SDK still terminates at an uninstalled
`DefoldScriptBridge`, so it must not claim those three calls until the bridge
installer connects them.

The 923 pending descriptors comprise 456 borrowed-handle, 151 Lua-table, 127
Defold-value, 90 scalar, 37 multi-result, 25 callback-lifecycle, 23 overload,
and 14 dynamic-value primary families. The scalar dispatcher is an
allocation-free codec prototype over 90 descriptors; eight representative
descriptors execute against mocks, but none is installed in an engine context
or exposed through JSI yet. This distinction keeps declaration coverage from
being mistaken for executable SDK compatibility.
