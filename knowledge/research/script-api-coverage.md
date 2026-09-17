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

Every one of the **926 functions** starts as
`needs-native-mapping`. A mapping can resolve to a direct generated C ABI call,
a generated composition of lower-level calls, or a temporary Lua compatibility
bridge. CI must not call the script surface complete while any public function
is unaccounted for.

The machine-readable inventory is
`bindings/generated/defold-script-api-inventory.json`.
