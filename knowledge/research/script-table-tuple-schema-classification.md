---
type: Research
title: Generated script table and tuple schema classification
description: Deterministic schema ledger for Lua-table and fixed multi-result routes.
tags: [research, generated, bindings, lua, abi, typescript]
status: active
generated: { by: scripts/generate-script-table-tuple-schemas.mjs, at: 2026-09-18T00:00:00-04:00 }
---

# Script table and tuple schema classification

This generated ledger classifies all **185** table/tuple routes exactly once, including executable fixed tuples:
**148** Lua-table routes and **37** fixed multi-result routes.
It is a planning/schema compiler artifact. It does **not** claim compile, link, packaged-engine, or runtime evidence.

| Bucket | Family | Routes | Classification | Order | Meaning |
| --- | --- | ---: | --- | ---: | --- |
| `flat-record` | lua-table | 57 | mechanical-ir | 1 | Fixed-field records whose fields are scalar, enum, hash, URL, or copied Defold values. |
| `fixed-scalar-tuple` | multi-result | 17 | mechanical-ir | 2 | Fixed-arity tuples containing only scalar, enum, and nullable scalar slots. |
| `fixed-value-tuple` | multi-result | 7 | mechanical-ir | 2 | Fixed-arity tuples containing copied Defold values such as vectors and quaternions. |
| `typed-sequence` | lua-table | 60 | mechanical-shape-explicit-policy | 3 | Arrays or records containing arrays with mechanically known element codecs but no IR size bound. |
| `typed-map` | lua-table | 15 | mechanical-shape-explicit-policy | 4 | Maps with mechanically known key/value codecs but no IR entry bound or coercion policy. |
| `table-tuple-schema` | multi-result | 7 | mechanical-shape-explicit-policy | 5 | Fixed tuples with at least one table input or result that requires a bounded table schema. |
| `tagged-table-union` | lua-table | 3 | mechanical-shape-explicit-policy | 5 | A table participates in a non-null union and requires an explicit branch discriminator. |
| `opaque-record` | lua-table | 2 | mechanical-shape-explicit-policy | 5 | A record contains an opaque or unresolved nested value such as a render constant buffer. |
| `semantic-flat-record` | lua-table | 6 | reviewed-override | 5 | A structurally flat record whose discriminator, binary data, or ownership semantics are not in the IR shape. |
| `owned-handle-tuple` | multi-result | 5 | reviewed-override | 5 | A fixed tuple returning owned Lua userdata whose close and registry lifetime must be explicit. |
| `binary-string-tuple` | multi-result | 1 | reviewed-override | 5 | A fixed tuple containing a Lua byte string that cannot use a generic UTF-16 JavaScript string codec. |
| `dynamic-recursive` | lua-table | 5 | mechanical-shape-explicit-policy | 6 | Recursive or any-valued tables requiring cycle, depth, size, and supported-value policies. |

## Implementation order

1. Generate fixed-field SoA descriptors for `flat-record` routes.
2. Generate exact positional result descriptors for scalar and copied-value tuples.
3. Add typed sequences with an explicit per-schema maximum length.
4. Add typed maps with own-key, key-coercion, collision, and maximum-entry policies.
5. Implement table tuples, tagged unions, opaque contexts, and reviewed ownership/discriminator exceptions behind explicit schemas.
6. Implement dynamic recursive tables last, with cycle rejection and hard depth/entry/value limits.

All targets fail closed when a bucket has no target-specific implementation. Browser-host support is not inferred from native captured-Lua support.
Output strings and Defold values must be copied before the Lua stack is restored; userdata must cross as generation-checked registry handles.

## Reviewed semantic exceptions

| Route | Bucket | Reason |
| --- | --- | --- |
| `script:physics.get_shape` | `semantic-flat-record` | `type-discriminated-record` |
| `script:physics.set_shape` | `semantic-flat-record` | `type-discriminated-record` |
| `script:resource.create_buffer` | `semantic-flat-record` | `ownership-transfer` |
| `script:resource.create_sound_data` | `semantic-flat-record` | `binary-string` |
| `script:resource.get_texture_info` | `semantic-flat-record` | `borrowed-numeric-handle` |
| `script:resource.set_buffer` | `semantic-flat-record` | `ownership-transfer` |
| `script:socket.connect` | `owned-handle-tuple` | `owned-lua-userdata` |
| `script:socket.tcp` | `owned-handle-tuple` | `owned-lua-userdata` |
| `script:socket.tcp6` | `owned-handle-tuple` | `owned-lua-userdata` |
| `script:socket.udp` | `owned-handle-tuple` | `owned-lua-userdata` |
| `script:socket.udp6` | `owned-handle-tuple` | `owned-lua-userdata` |
| `script:sys.load_resource` | `binary-string-tuple` | `binary-string` |
