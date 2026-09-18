---
type: Research
title: Generated URL and address frontier
description: Exact pending route census and allocation-free composite Defold URL codec foundation.
tags: [research, generated, bindings, url, abi, memory]
status: active
---

# Generated URL/address frontier

Status: codec foundation and planned-route classification, not executable-route evidence.

The generator at `scripts/generate-script-url-address-classification.mjs` derives
the URL/address frontier from the pinned script IR, API accounting ledger, and
binding-pattern report. It does not carry a hand-authored route list. It rejects
revision, input hash, route count, module count, raw type, source hash, source
anchor, and disjoint-partition drift.

The binding-pattern classifier contains 127 `defold-value` routes. Seventeen
non-Matrix routes were already executable before this frontier census; removing
that source-pinned set reconstructs the 110-route baseline frontier. Its exact
partition is:

- 20 Matrix4 routes owned by the separate Matrix4 generator wave;
- 70 URL/address routes owned by this classifier;
- 2 binary-string routes (`gui.set_texture_data`, `resource.set_sound`);
- 18 routes expressible with the current scalar/hash/vector codecs.

The current accounting ledger has promoted 14 of the 20 Matrix4 routes, so the
current pending partition is exactly 96 routes: 6 Matrix4 + 70 URL/address + 2
binary-string + 18 current-codec routes. The generated report records both the
110-route baseline frontier and this current 96-route state without conflating
historical classification with executable coverage.

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
exhaustion is deterministic and there is no heap fallback.

## Required generated Lua route

The three accepted address forms must stay distinct until the Lua boundary:

1. A full `DefoldUrl` resolves from its sidecar and is copied into an exact
   `dmMessage::URL`; generated glue calls `dmScript::PushURL`.
2. A string remains a Lua string so `dmScript::ResolveURL` applies the captured
   script instance's socket/path/fragment defaults and path resolution.
3. A hash remains a Lua hash so Defold supplies the default socket, uses the
   hash as path, and clears the fragment.

If a route returns a URL, generated glue must copy all URL lanes into the
sidecar before restoring or popping the Lua stack. The native codec test proves
that copy-before-pop ownership behavior using the pinned `dmMessage::URL` type.

No target is marked executable by this wave. Dynamic Hermes, Static Hermes,
and the HTML5 browser host remain `planned-codec-foundation` until their
generated frame routing and real-engine probes exist.
