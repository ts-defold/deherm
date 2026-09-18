---
type: Verification Report
title: Unified script and dmSDK binding projection
description: Complete deterministic value/effect projections for the Defold script API and dmSDK, plus source-derived runtime profiles.
tags: [bindings, generator, ir, script-api, dmsdk, profiles, verification]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T13:00:00-04:00 }
sources:
  - id: defold-ref-doc
    resource: https://d.defold.com/archive/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/share/ref-doc.zip
    title: Pinned Defold generated API reference
    author: team:defold
  - id: defold-source
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05
    title: Pinned Defold source and dmSDK headers
    author: team:defold
---

# Outcome

The binding compiler now projects both complete imported surfaces into
deterministic, compositional value/effect IR before any backend emitter decides
whether a route is compiled, linked, or runtime-conformant:

* all 926 public script functions are projected exactly once;
* all 1,361 runtime dmSDK declarations are projected exactly once;
* every row has stable provenance and normalized value shapes;
* unresolved semantics are explicit tokens, never permissive fallbacks;
* generation state is independent from compile, link, and runtime evidence;
* clean-room regeneration recreates 67 script artifacts and 61 dmSDK artifacts
  byte-for-byte from pinned inputs.

This is a compiler-foundation result, not a claim that all calls execute. The
script accounting ledger remains 286 executable stable-ID routes, three
separate-module routes, and 637 pending. dmSDK has 45 generated adapters and
1,316 declarations without generated adapters.

# Script projection

`scripts/generate-script-projection-ir.mjs` consumes the canonical script IR
and every existing semantic ledger. It emits one row per route containing:

* structural parameter and return shapes;
* execution context;
* ownership, lifetime, and invalidation effects;
* callback, variadic, and recursive-value policies;
* target dispositions;
* separate compile/link/runtime evidence slots;
* exact semantic-hole tokens for every unresolved decision.

The 15 shape constructors are scalar, dynamic, named, enum, Defold value,
handle, record reference, record, sequence, map, union, optional, callback,
variadic, and unknown. The current corpus produces no unknown shape node. The
largest unresolved policy class is execution context: 389 routes still need an
evidence-backed context token. The one callback lifecycle hole and all 637
pending lowerings are likewise enumerated by stable route ID.

# Runtime profiles and a corrected claim

The profile generator parses pinned `luaL_reg` arrays, build scripts, and app
manifests. It preserves a critical distinction that the earlier module-level
count hid:

| Defold-derived profile | Documented registered-surface routes | Runtime-registered routes |
| --- | ---: | ---: |
| Default legacy Box2D + Bullet | 343 | 343 |
| Box2D v3 + Bullet | 419 | 417 |
| Legacy Box2D, no Bullet | 171 | 171 |
| Box2D v3, no Bullet | 247 | 245 |
| Bullet only, no Box2D | 198 | 198 |
| No physics | 26 | 26 |

`b2d.body.get_user_data` and `b2d.body.set_user_data` exist in the reference
surface but their Box2D v3 registration entries are commented out. They are
therefore documented-but-unavailable, not callable. Déherm does not introduce a
second Box2D setting: generation derives the choice from Defold's resolved app
manifest and linked/excluded libraries. The CLI reads
`native_extension.app_manifest` from `game.project`, resolves every declared
platform independently, and preserves Defold's legacy Box2D + Bullet default
when that setting is absent. The selected profile and app-manifest digest are
written into the project inventory, generated manifest, and lockfile. The
generated handshake contract binds
a profile ID, Defold revision, capability bits, route count, route-set digest,
and catalog digest. Runtime enforcement of that contract is a required backend
step and is not yet claimed.

The registration audit also found 14 native `b2d.shape.*` names in the v3
registration tables that do not exist under those names in the documentation
IR. These are recorded as registration-only namespace mismatches. They require
a source-derived alias policy before they can become public TypeScript routes;
the generator does not guess.

# dmSDK projection

`scripts/generate-dmsdk-projection-ir.mjs` structurally projects every runtime
declaration through 14 constructors observed in the current corpus and ten
effect dimensions: direction, ownership, lifetime, context, thread, callbacks,
records, templates, spans, and availability. External Vectormath/Objective-C
types are intentional opaque nodes and `va_list` is an explicit variadic node;
neither is mislabeled as parsed native data.

The projection mechanically covers all 1,361 declarations with zero projection
gaps. It separately reconciles adapter-generation state into 45 generated
adapters, 96 reviewed policy gates, and 1,220 pending lowerings. A generated
adapter is not thereby claimed linked or runtime-proven. A policy gate
never removes a declaration from generation; it records the semantic decision
an executable adapter still needs. Leading semantic
queues include pointer
bounds/nullability/lifetime (795), handle ownership/nullability/lifetime (621),
out-storage/failure behavior (534), record ABI/copy policy (476), enum
width/domain validation (301), callback registration (95), and callback
thread/reentrancy/lifetime (90). All 1,361 rows explicitly retain unresolved
call-thread and target-feature tokens until target evidence resolves them.
These counts are the data-driven work queue for generic emitters; they are not
per-symbol hand-written wrapper lists.

# Generator contract

The central script and dmSDK registries own the generators, pinned inputs,
outputs, and execution order. Focused tests reject omitted, duplicate, foreign,
stale, or silently unknown rows. Clean-room checks rebuild both projections and
the handle-profile catalog in isolated temporary trees, verify source hashes,
reject unowned generated files, and compare every committed artifact byte for
byte.

The next compiler wave operates on these algebras rather than adding another
route-family architecture: resolve policies as data, emit target code from the
same shapes/effects, and promote compile/link/runtime evidence independently.
