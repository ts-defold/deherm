---
type: Research
title: Generated URL and address frontier
description: Generated native-dynamic routing for 70 Defold URL/address APIs with exact four-lane storage.
tags: [research, generated, bindings, url, abi, memory]
status: active
---

# Generated URL/address frontier

Status: generated and native-harness executable on dynamic Hermes; packaged-engine probes remain unverified.

The generator at `scripts/generate-script-url-address-classification.mjs` derives
the URL/address frontier from the pinned script IR, binding-pattern report, and
reviewed override. It deliberately runs before API accounting so accounting can
consume its output without a two-pass cycle. It rejects revision, input hash,
route count, module count, raw type, source hash, source anchor, codec, and
disjoint-partition drift.

The binding-pattern classifier contains 127 `defold-value` routes. Its
accounting-independent partition is:

- 20 Matrix4 routes owned by the Matrix4 generator;
- 73 URL-bearing candidates;
- 3 URL-bearing transform routes owned by direct native bindings
  (`go.get_position`, `go.set_position`, `go.set_rotation`), which keep their
  current-instance form on the direct native path and lower their addressed
  forms through the shared captured-Lua invoker (see below);
- 70 URL/address routes owned by this generator;
- 2 binary-string routes (`gui.set_texture_data`, `resource.set_sound`);
- 32 other non-Matrix, non-URL routes.

The 70 URL routes span camera 19, collectionfactory 3, factory 3, go 15,
label 2, model 5, particlefx 2, physics 11, sound 3, sprite 3, and tilemap 4.
They contain 73 URL-bearing parameters: 54 `string|hash|url` parameters and 19
`url|number|nil` camera selectors.

## Why one `u64` is not a URL

The pinned `dmMessage::URL` contains four 64-bit lanes: socket, reserved, path,
and fragment. The public semantics use the socket, path, and fragment hashes;
the reserved lane is retained by exact engine copies. Native compile-time tests
assert the pinned 32-byte size, field widths, and offsets against the actual
Defold header. A JavaScript `number` cannot losslessly carry even one arbitrary
64-bit hash, and the current `ScriptHandleKind::kUrl` payload alone cannot carry
three of them. A `kUrl` with no valid sidecar slot therefore fails closed.

`ScriptUrlArena` is fixed-capacity inline storage. Its token checks the runtime,
index, generation, and exact slot pointer. Nested frames rewind safely; rewound,
cross-arena, cross-runtime, and pre-runtime-reset tokens are rejected. Capacity
exhaustion is deterministic and there is no heap fallback. The JSI object is
explicitly branded with `__dehermUrlV1: true`; arbitrary objects with
similarly named bigint properties are not accepted. Encode and decode preserve
the nonzero reserved lane as well as socket, path, and fragment.

## Required generated Lua route

The three accepted address forms must stay distinct until the Lua boundary:

1. A full `DefoldUrl` resolves from its sidecar and is copied into an exact
   `dmMessage::URL`; generated glue calls `dmScript::PushURL`.
2. A string remains a Lua string so `dmScript::ResolveURL` applies the captured
   script instance's socket/path/fragment defaults and path resolution.
3. A hash remains a Lua hash so Defold supplies the default socket, uses the
   hash as path, and clears the fragment.

The generator emits one sorted stable-ID descriptor table, positional codec
masks, and one reusable captured-Lua invoker. No route has a hand-written C++
body. The native harness calls all 70 generated descriptors through real Lua
5.1 stack operations, validates exact four-lane URL bits, separately exercises
string and hash shorthand, rejects stale/cross-arena/collapsed URL tokens, and
observes zero C++ `new` calls across 1,024 warmed calls. It also proves a
nonzero reserved lane survives copy-before-pop and copy-for-push.

Dynamic Hermes is `generated-executable`, but the 70 packaged-Defold scenarios
are still unverified. Static Hermes, the flat Wasm C ABI, and the HTML5 browser
host remain `fail-closed-unverified` for structured URLs because their current
ABI has only one `u64` payload lane. String/hash shorthand may traverse that
ABI, but the target is not marked executable until all four lanes are carried
without JavaScript `number` coercion.

## Addressed game-object transforms

`go.get_position`, `go.set_position` and `go.set_rotation` each declare a
current-instance form plus `string`, `hash` and `url` addressed forms. They are
one route with two lowerings, selected by argument count inside the generated
value-binding dispatcher:

* no address - the direct native path through `game_object::resolveCurrent`,
  which validates the borrowed instance's generation, collection and identifier
  before any engine pointer read;
* an address - the generated captured-Lua invoker, which keeps a string a Lua
  string, a hash a Lua hash and a url a pushed `dmMessage::URL`, so Defold's own
  `ResolveInstance` performs socket checking, relative-path resolution and the
  missing-instance refusal.

Restating that resolution natively would duplicate semantics that depend on the
*calling* instance's collection and socket. The generator therefore pins the
pieces of `ResolveInstance` it relies on - the `lua_gettop(L) == instance_arg`
gate, `dmScript::ResolveURL(L, instance_arg, &receiver, 0x0)`, the
same-collection socket check, `GetInstanceFromIdentifier`, and the
`Instance %s not found` refusal - as source anchors, so a change to any of them
fails generation rather than silently changing behaviour.

The NaN guard on the setters runs before the address branch, so both forms
refuse the same inputs at the same boundary.

Observed on a packaged arm64 macOS engine at Defold `7f0f554`
(`.agents/docs/data/native-defold-runtime.log`): all nine addressed shapes
execute against a second game object in the calling collection, and
`go.get_position("/deherm_no_such_instance")` fails closed into TypeScript
instead of returning a default transform. `msg.url(string)` is exercised as the
url-address producer in the same run.
