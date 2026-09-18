---
type: Research
title: Script value-tail and overload generator waves
description: Exact candidate and blocker partitions for the remaining Defold-value and overload-dispatch routes.
tags: [research, generated, script-api, bindings, overloads, values]
status: active
---

# Script value-tail and overload generator waves

Two downstream generators turn the remaining ambiguous value-shaped routes
into finite, source-pinned work queues. Their candidate descriptors are now
installed in the shared captured-Lua `ScriptAdapter`, while blocked rows remain
fail-closed.

## Defold-value tail

After the 78 existing generated value routes, 26 `defold-value` routes remain.
`scripts/generate-script-defold-value-tail.mjs` derives that exact remainder
from the IR, classifier, and accounting report, then verifies all cross-input
revisions, hashes, counts, and identities.

- 16 routes have finite reviewed codecs, require a game-object script instance,
  and are captured-Lua candidates.
- Four `gui.*` routes are blocked until a `.gui_script` attachment can capture
  and restore an actual GUI-script instance.
- Four `render.*` routes are blocked until a `.render_script` attachment can
  capture and restore an actual render-script instance.
- `gui.set_texture_data` is blocked on the mixed `string | image.TYPE` codec.
- `liveupdate.remove_mount` is blocked until the named enum domain is generated
  and validated; arbitrary numbers are not accepted as an “exact” enum codec.

The generated static tables enforce `uint8_t`/`uint16_t` bounds, use a dense
candidate index, validate every argument tag, clear failed results, and validate
the returned tag. The generator derives this tail from the script IR,
classifier, and already-owned value/URL reports, so it executes before API
accounting without a dependency cycle.

## Overload dispatch

The classifier contains 23 overload routes. Three (`vmath.normalize`,
`vmath.quat`, and `vmath.vector3`) already belong to the generated native value
family, leaving an exact disjoint tail of 20.

- Eight finite `vmath` routes have generated call-shape descriptors: `clamp`,
  `dot`, `lerp`, `matrix4`, `matrix4_scale`, `mul_per_elem`, `slerp`, and
  `vector4`.
- Twelve Box2D, message, and render routes remain blocked on handle, structured
  input/result, multi-result, URL-construction-context, or resource-lifetime
  codecs.

The dispatcher chooses a shape from runtime tags, requires caller-owned result
storage, validates the exact result kind, and contains no heap container or
fallback.

The shared adapter caches Lua function references, restores captured instance
scope across nested calls, and copies Matrix4 results into a bounded frame
arena. A pinned Defold Lua 5.1 harness reaches all 16 executable value-tail and all eight
overload descriptors, exercises reentrancy, stale Matrix4 tokens, and arena
exhaustion, and observes zero warmed C++ `operator new` calls. Dynamic Hermes
JSI executes `vmath.dot` and `sound.getGroupGain` through the same path.

The eight GUI/render routes are a regression boundary, not merely prose: the
generated table records their required instance kind, dispatch rejects them
before invoking the backend, and native tests assert that the backend call
count does not change. Shape compatibility alone is not sufficient evidence
for route promotion.

A post-regeneration local Bob/Extender build linked the generated units into a
15,911,096-byte arm64 macOS engine bundle (local Extender job
`job15700443534259312669`). This proves extension compilation
and linkage. The real-engine matrix still marks the newly promoted routes as
planned rather than claiming that every route's semantic behavior was observed
inside a running packaged game.

Both generators are owned by the central script pipeline. Current clean-room
regeneration reconstructs 65 artifacts byte-for-byte for all 926 routes with
input fingerprint `8c275a22c73a5d1db9ecd4f93957d6d7a673c710b8bd747d8459c5a5e7b33f3f`.
Accounting now records 286 generated executable stable-ID routes, three
separate timer-module routes, and 637 pending routes.
