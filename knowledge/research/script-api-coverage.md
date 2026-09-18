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
and 1398 class fields. This inventory intentionally does not embed mutable
runtime counts. `bindings/generated/defold-script-api-accounting.json` is the
SHA-bound, exact partition of generated stable-ID routes, separate-module
routes, and pending lowerings. `bindings/generated/defold-script-real-engine-matrix.json`
independently records compile, link, and observed packaged-engine evidence.

A generated signature, a generated transport route, and an engine-observed
semantic call are three different states. Consumers must not infer the latter
from this declaration inventory.
