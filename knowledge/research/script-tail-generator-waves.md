---
type: Research
title: Script value-tail and overload generator waves
description: Exact candidate and blocker partitions for the remaining Defold-value and overload-dispatch routes.
tags: [research, generated, script-api, bindings, overloads, values]
status: active
---

# Script value-tail and overload generator waves

Two downstream generators now turn the remaining ambiguous value-shaped routes
into finite, source-pinned work queues. They emit descriptor dispatchers that
validate arguments and results around an injected Lua backend, but they do not
claim that backend is installed or that any route has executed in Defold.

## Defold-value tail

After the 78 existing generated value routes, 26 `defold-value` routes remain.
`scripts/generate-script-defold-value-tail.mjs` derives that exact remainder
from the IR, classifier, and accounting report, then verifies all cross-input
revisions, hashes, counts, and identities.

- 24 routes have finite reviewed codecs and are captured-Lua candidates.
- `gui.set_texture_data` is blocked on the mixed `string | image.TYPE` codec.
- `liveupdate.remove_mount` is blocked until the named enum domain is generated
  and validated; arbitrary numbers are not accepted as an “exact” enum codec.

The generated static tables enforce `uint8_t`/`uint16_t` bounds, use a dense
candidate index, validate every argument tag, clear failed results, and validate
the returned tag. With no injected backend they fail closed.

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
fallback. It remains a candidate layer until routed through the shared
ScriptAdapter and then observed in packaged Defold.

Both generators are owned by the central script pipeline. Current clean-room
regeneration reconstructs 57 artifacts byte-for-byte for all 926 routes with
input fingerprint `298347d697b611a120285314a84dd51b37f4bf679bdc2d88c3ae52deea9cdc2e`.
