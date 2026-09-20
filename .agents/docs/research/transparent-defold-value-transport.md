---
type: Design and Verification Report
title: Transparent Defold value records on the typed-native transport
description: Pinned dmSDK layout derivation, the Matrix4/URL typed frame lanes, and the structural rule that grew typed-native emission from 138 to 325 routes.
tags: [bindings, static-hermes, defold-values, abi, layout, transports]
status: active
generated: { by: claude/opus-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: vmath
    resource: upstream/defold/engine/dlib/src/dmsdk/dlib/vmath.h
    title: Pinned dmVMath typedefs and layout notes
    author: team:defold
  - id: message
    resource: upstream/defold/engine/dlib/src/dmsdk/dlib/message.h
    title: Pinned dmMessage::URL declaration
    author: team:defold
  - id: hash
    resource: upstream/defold/engine/dlib/src/dmsdk/dlib/hash.h
    title: Pinned dmhash_t definition
    author: team:defold
  - id: plan
    resource: ./canonical-lowering-plan.md
    title: Canonical cross-target binding lowering plan
    author: project:deherm
---

# Outcome

The `hermes` runtime carries three transports: JSI, Lua stack, and typed-native
(`$SHBuiltin.extern_c`). Typed-native is a soundness and performance tier, not a
coverage requirement: a route it cannot carry is still reachable over JSI in the
same process. Its previous gate rejected every route whose signature mentioned a
`defold-value`, so the tier emitted 138 of the 913 routes the runtime can reach
and could not express `hash`, any `vmath` constructor, or `go.get_position`.

The gate is now structural. A route reaches the typed-native transport when it
crosses no Lua closure and no retained Lua/engine handle, and when *every*
Defold value type in its signature — including types reachable only inside union
variants — has a transparent fixed layout derived from the pinned dmSDK headers.
That promotes the tier to 325 routes.

Five of those routes (`bit.band`, `bit.bor`, `bit.bxor`, `pprint`, and
`socket.skip`) have runtime arity, but they are not unbounded. The universal
policy caps them at 32 arguments, the generated operation descriptors enforce
that cap, and the sound-typed bridge mechanically walks the runtime argument
array into the same fixed-capacity frame. The bridge therefore realizes the
canonical plan's full 325-route script selection; it does not maintain a
second route-selection exception list.

| Transport | Backend | Emitted routes |
| --- | --- | --- |
| jsi | dynamicHermesJsi | 913 |
| lua-stack | luaStack | 911 |
| typed-native | staticHermesCAbi | 325 |

# Layout is derived, never declared

`scripts/generate-defold-value-layouts.mjs` reads the pinned headers and emits
`packages/bindings/generated/defold-value-layouts.json` plus
`generated_defold_value_layout.h`. The override
`packages/bindings/overrides/defold-value-layouts.json` names only *which*
pinned declaration owns each script value type and which transport it uses; the
sizes, element types, ordering, and typedef chains come from the source text.

| Script type | Pinned declaration | Derived layout | Transport |
| --- | --- | --- | --- |
| `vector3` | `dmVMath::Vector3` | 3 semantic lanes in 4 float32, 16-byte aligned | float lanes |
| `vector4` | `dmVMath::Vector4` | 4 float32 | float lanes |
| `quaternion` | `dmVMath::Quat` | 4 float32 | float lanes |
| `matrix4` | `dmVMath::Matrix4` | 4 x `Vector4`, column major, 16 float32 | float arena |
| `hash` | `dmhash_t` | `uint64_t` | exact u64 |
| `url` | `dmMessage::URL` | 4 x `uint64_t` (socket, reserved, path, fragment) | u64 lane quad |

The generator walks the complete script projection for every `defold-value`
constructor name. A reviewed transparent entry still requires source-derived
layout evidence, and reviewed opaque entries retain their semantic reason. A
name introduced by another Defold revision no longer aborts the entire policy
derivation: it is emitted as a machine-readable
`source-derived-conservative-fallback`, remains callable through the generated
universal value transport, and is excluded only from the transparent
typed-native tier. The report emits a warning for every such name. An explicit
policy entry for an API absent from the selected revision is recorded as
dormant rather than treated as an error; availability is a normal per-revision
policy difference.

This fallback is a coverage contract, not a performance claim. It records
`specialized-layout-unproven` until the source-derived fixed layout, retained
handle kind, or enum domain is promoted into a reviewed specialization. The
thirteen reviewed opaque names — `node`, `buffer_data`,
`buffer_stream`, `resource_data`, `constant_buffer`, `render_target`, `texture`,
`render_predicate`, `timer_handle`, `vector`, and the three enum-token domains —
carry an explicit machine-readable reason. Follow-up specialization work is
tracked in the linked repository issue in the Open boundaries section below.

The Vector3 row is why layout may not be guessed: its storage is four float32
even though only three lanes carry meaning. The 4-tuple doc arity and the
`Always size of 4 float32` note are both read from the pinned header.

# Typed frame changes

The generated fixed-capacity Static Hermes frame previously passed null input
float and URL arenas and exposed no reader for either output arena, so Matrix4
and URL values had no route through it. The frame now owns both input arenas and
the generator emits, with counts taken from the layout report:

* `deherm_script_static_push_matrix4` — copies the 16 column-major elements into
  the caller-owned float arena and tags the value for the wire codec;
* `deherm_script_static_push_url` — copies the four 64-bit lanes as `uint32`
  halves into the caller-owned URL arena;
* `deherm_script_static_value_element`, `deherm_script_static_value_url_low`,
  and `deherm_script_static_value_url_high` — bounds-checked output readers.

The sound-typed side gains `DehermStaticMatrix4` and `DehermStaticUrl`. Hash
values already crossed as exact `uint32` halves of a `dmhash_t` through the
existing handle lanes. The wire `DehermScriptUniversalUrl` field list and the
frame's `static_assert`s are now generated from the same layout report, so a
Defold layout change fails generation instead of silently reshaping the ABI.

# Evidence boundary

* **Generation** — the plan emits 325 typed-native routes; every blocked route
  carries `shape-kind:` or `value-type:` blockers naming the exact obstruction.
* **Compilation and linkage** — `defold-hermes-static-runner` builds the typed
  units through `shermes -typed -strict -O -emit-c` and links them.
* **Runtime** — the runner round-trips a column-major Matrix4, a four-lane URL,
  an exact `dmhash_t`, and a float32 Vector3 through the typed frame and checks
  exact checksums. This is harness evidence for the transport, not packaged
  Defold engine evidence for the 325 routes.
* **Allocation, conformance, packaged engine** — unchanged and still unclaimed.

# Next

`node` is the single largest remaining blocker at 103 routes, followed by the
physics and socket `handle` kinds. Both need the retained-handle transport: the
C ABI already models handles as opaque tokens with generation checks, which is a
sound typing, but the typed frame does not yet own the retained registry lease.

# Open boundaries

Revision-specific conservative value entries are deliberately usable before
their optimized typed-native representation is proven. The generator and
policy report name every entry, its universal fallback, and the missing proof.
The tracking issue URL is added here when the repository issue is created; CI
must not fail solely because this optimization queue is non-empty.
