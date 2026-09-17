---
type: Architecture Decision
title: Define full compatibility as two generated API surfaces
description: Generate both the ergonomic Defold script API and the raw dmSDK, with explicit coverage and native-extension contribution contracts.
tags: [decision, compatibility, dmsdk, script-api, ttsc, extensions]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-sdk
    resource: https://defold.com/manuals/extensions-defold-sdk/
    title: The Defold SDK
    author: team:defold
  - id: defold-ref-doc
    resource: https://d.defold.com/archive/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/share/ref-doc.zip
    title: Pinned Defold generated API reference
    author: team:defold
  - id: xmath
    resource: https://github.com/thejustinwalsh/defold-xmath
    title: xMath native extension
    author: human:thejustinwalsh
---

# Decision

“100%” has two independently measured surfaces:

* `defold.script.*` reproduces the public Lua API's semantics and sugar for game
  code: overloads, optional arguments, multiple returns, hashes/URLs, vectors,
  callbacks, message tables, lifecycle state, and engine-owned userdata.
* `defold.sdk.*` projects the complete public dmSDK for systems and extension
  authors: handles, records, enums, callbacks, spans, ownership, thread rules,
  and platform gates.

The generated inventories are the compatibility ledger. Upstream additions
must appear in CI immediately. “Inventoried,” “typed,” “compiled,” “linked,” and
“conformance-tested” are separate states; a declaration cannot disappear
because an emitter does not support it yet.

# Where the sugar lives

The C/C++ declarations remain authoritative for native layout and linkage. The
generated Lua annotation/reference archive remains authoritative for public
script names and documented types. A reviewed semantic overlay is the explicit
line between them. Each script function maps to one of:

1. one direct C ABI thunk;
2. a generated composition of lower-level native calls;
3. a VM intrinsic for hashes, URLs, vectors, tables, callbacks, or lifecycle;
4. a temporary Lua compatibility call, clearly marked and benchmarked.

This overlay—not handwritten TypeScript declarations—is where overloads,
defaults, mutation, ownership, callback timing, and error behavior are defined.

# Role of ttsc

`ttsc` is not the header binding generator. Clang AST and Defold ref-doc data
produce the canonical language-neutral IR. `ttsc` operates above it:

* resolve overloads and rewrite friendly calls to generated intrinsics;
* reject TypeScript outside the supported Static Hermes profile;
* lower tuples/multiple returns, branded handles, callbacks, and script sugar;
* emit a used-symbol manifest so types can cover 100% while final binaries only
  retain reachable thunks;
* select Lua, Static Hermes, dynamic Hermes, or browser target lowering;
* temporarily transform syntax missing from Static Hermes while fixes are
  upstreamed.

The binding compiler IR remains independent of any one TypeScript frontend.
Static Hermes is a consumer of that IR through generated `extern_c`, not the IR
itself.

# Native extension modules

Extensions contribute a versioned module descriptor plus generated ABI thunks.
The Defold Hermes extension owns an order-independent registry. Static Hermes
links symbols directly; dynamic Hermes installs generated JSI functions; HTML5
retains the same exported symbols and accesses fixed Wasm memory layouts.

Compatibility tiers are explicit:

1. A legacy extension with only `.script_api` metadata is callable through a
   generated JS-to-Lua adapter. This maximizes compatibility but is not the hot
   path.
2. An extension with annotated headers/schema gets generated C ABI, Lua, JSI,
   Static Hermes, browser, and TypeScript adapters.
3. A native-first extension exposes a stable core C ABI and generates every VM
   adapter from it. This is the preferred design.

xMath currently registers `static int(lua_State*)` functions, so its
`.script_api` is enough to generate excellent types and the compatibility
adapter, but not a direct fast call. The fast xMath integration factors each
operation into a VM-neutral native core (preserving its output-argument,
allocation-free behavior), then generates both its existing Lua stack wrapper
and the Hermes/Static-Hermes wrapper.

# Lua-stack compatibility backend

`lua_State*` is an opaque VM handle, not a stable memory layout contract. We
must not manufacture Lua stack slots or depend on Lua/LuaJIT internal structs.
When a dependency exposes only a Lua module, a generated fallback may use the
public Lua 5.1/Defold C APIs to push typed arguments, invoke the registered
function with `dmScript::PCall`, read results, restore the stack, and translate
the error into the JavaScript runtime.

That backend can provide broad compatibility without emitting Lua source, and
`ttsc` can lower typed calls to its generated call descriptors. It remains a
fallback because it pays JS-to-native-to-Lua dispatch and requires explicit
handling for the current script instance, registry-rooted userdata identity,
callbacks, coroutines, GC lifetimes, and engine-thread affinity. Static Hermes
calls a generated native C ABI directly whenever the operation has one.

The lowering policy is therefore per symbol, not per application:

* use a direct native thunk when public dmSDK exposes the required operation
  and context;
* use the registered Lua function when the public script API or a third-party
  extension has no equivalent supported native entry point;
* replace a Lua fallback later without changing its TypeScript signature.

APIs such as `go`, factories, and GUI frequently have lower-level native
operations but their script wrappers also resolve URLs, defaults, current
instances, callbacks, and userdata. A “similar” dmSDK function is not enough;
the generated conformance test decides whether direct lowering is equivalent.

Instance-dependent Lua fallbacks need a real Defold script instance. The
plugin-compatible first implementation may pair a TypeScript component with a
generated, gameplay-free Lua companion whose only job is to provide that
instance context and forward lifecycle events to Hermes. This keeps authored
game logic in TypeScript while preserving exact Defold script semantics. A
later custom component may remove the companion once it can reproduce the same
context natively.

Confirmed examples at the pinned Defold revision include the `timer` module:
its public Lua functions are implemented over `script_timer_private.h`, not a
public `dmsdk` timer header. `sprite.play_flipbook` is likewise a script binding
that resolves the current instance and URL, stores a callback reference, and
posts an engine message; the public sprite dmSDK header exposes resource data,
not an equivalent component call. Similar script wrappers exist for component
sound, particle effects, and collection-proxy callbacks. Their behavior can be
reimplemented from lower-level messages and internal concepts, but there is no
one-for-one supported public dmSDK call. These are good initial Lua-backend
candidates, followed by direct replacements only where conformance and
performance justify the work.

# Cross-VM lifetime model

Lua-backed JavaScript objects use compact generational handles, not native
pointers: `{ runtime, lua_state, slot, generation, type }`. Native slot pools
retain Lua values with `dmScript::Ref` and release them with
`dmScript::Unref` on the engine thread. Generation checks make stale wrappers
fail deterministically after a slot is reused.

Owned wrappers provide an explicit `dispose()` path and unregister their
finalizer token. `FinalizationRegistry`, where supported, only enqueues the
handle for later release; its cleanup callback never mutates a Lua stack or
calls Defold directly. The queue drains at a safe frame boundary. Runtime and
world teardown sweep every remaining slot because JavaScript finalizers are
not guaranteed to run before shutdown.

Borrowed values are scoped to a call/frame unless promoted to a rooted handle.
Generated stack guards restore the original Lua top on every success and error
path. Primitive and fixed-layout values use specialized push/read code; known
tables use generated field codecs; arbitrary tables, functions, userdata, and
cyclic graphs remain rooted proxies rather than being recursively copied.

The pinned Hermes branch contains `FinalizationRegistry` support, but the
Static Hermes type/frontend path remains a compile-tested capability rather
than an assumption. Browsers use the same optional safety net. Correctness
always rests on explicit disposal, owner teardown, and the native sweep.

# Acceptance order

1. Inventory 100% of both sources.
2. Generate all types and compile every generated target surface.
3. Compile and link all native thunks for the platform matrix.
4. Reach zero unmapped public script functions and zero unclassified dmSDK
   declarations.
5. Run generated ABI and semantic conformance suites.
6. Only then port an official Defold game as the first application-level test.
