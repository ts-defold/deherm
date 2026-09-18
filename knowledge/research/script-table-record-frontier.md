---
type: Research
title: Script Lua-table record frontier
description: Deterministic candidate and blocker partition for all 148 pending Lua-table script routes.
tags: [research, generated, script-api, lua, tables, bindings, provenance]
status: active
---

# Script Lua-table record frontier

The Lua-table frontier is generated as data, not selected by an agent at bind
authoring time. `scripts/generate-script-table-record-bindings.mjs` consumes the
pinned script IR, classifier, API accounting, and table-schema census, then
partitions all 148 pending `lua-table` routes under a versioned source policy.

Three routes are exact flat-record candidates:

- `image.get_astc_header` returns six required integers;
- `b2d.get_version` returns its fixed version record; and
- `bullet3d.get_version` returns the matching fixed version record.

The generated C++ layer has fixed descriptor/field arrays, caller-owned result
and table scratch storage, exact scalar and field-set validation, bounded
string copying, no heap ownership primitive, and an installed shared
captured-Lua backend. A pinned Lua 5.1 harness crosses all three routes, rejects
missing/extra/wrong-type fields and scratch exhaustion, and observes zero C++
`operator new` calls across 1,024 warmed calls. JSI result decoding compiles,
but dynamic-Hermes E2E, central executable accounting, and packaged-engine
observation remain separate unfinished evidence gates.

The other 145 routes have a complete generated blocker ledger:

- 60 unbounded sequences;
- 39 handle or callback lifetimes;
- 15 maps;
- 9 copied Defold-value records;
- 6 reviewed semantic conversions;
- 6 target-context/platform-state dependencies;
- 5 dynamic recursive values;
- 3 tagged unions; and
- 2 opaque or nested userdata records.

Separate source-pinned generators expand the nine copied-value and two
opaque/nested buckets. All eleven remain blocked: they require component,
resource, physics-world, render-command, URL/hash, sparse-variant, or userdata
ownership contracts that `ScriptCallFrame` does not yet represent. These
generators emit TypeScript blocker metadata and fail if source hashes, anchors,
or complete bucket coverage drift.

The central script clean-room registry owns every generator, policy, and output
in this frontier. This makes the next implementation wave a choice among
explicit codec/ownership families rather than another manual API search.
