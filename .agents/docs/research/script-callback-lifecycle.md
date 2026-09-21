---
type: Research
title: Generated script callback lifecycle frontier
description: Source-pinned lifecycle metadata and fixed-capacity ownership rules for all callback-shaped Defold script APIs.
tags: [research, generated, script-api, callbacks, lifecycle, memory]
status: active
---

# Generated script callback lifecycle frontier

`scripts/generate-script-callback-lifecycle.mjs` accounts for all 25 routes
classified as `callback-lifecycle` at the pinned Defold revision. A reviewed
policy file records the callback parameter, owner, invocation context, thread
affinity, lifetime, payload blockers, and exact source anchors for every route.
The generator rejects classifier, signature, source-hash, source-anchor, route
census, and stable-ID drift.

The current lifetime partition is 14 one-shot callbacks, four terminal-event
callbacks, five persistent replaceable callbacks, and two higher-order
closures. The first 23 can use the fixed-capacity lifecycle registry. The two
higher-order closures use a separate generated output contract on Dynamic
Hermes; Static Hermes, the raw Lua-stack lane, and the browser transport still
fail closed because they do not yet expose a callable-result token.

The native registry is a structure-of-arrays generational pool layered over existing
rooted callback handles. Construction owns its fixed storage; retain, invoke,
cancel, owner cancellation, deferred reentrant release, and teardown have no
heap fallback. Leases bind runtime, slot, generation, owner, route, lifetime,
and owner-thread token. One-shot callbacks release after the first attempted
invocation, terminal callbacks release only on the terminal event, persistent
callbacks survive until replacement/cancellation, and teardown rejects new
retains.

Native lifecycle tests cover one-shot, terminal, replacement, reentrant cancellation,
wrong-thread rejection, stale leases, teardown, closure rejection, and zero
observed C++ allocations after construction. The generated C++ table and
TypeScript file remain metadata inputs to target integrations.

## Browser universal callback integration

The browser universal-value generator consumes this ledger rather than a route
allowlist. It projects the 23 `registryEligible` routes through one reusable
callback token: `{runtime, slot, generation, type}` is encoded in the existing
48-byte direct-Wasm value cell, decoded into a fixed-capacity native
`ScriptCallback` slot, retained by the existing Lua closure adapter, and
released back to the browser generational registry when Lua ownership ends.
Callback arguments and synchronous results reuse the bounded universal value
graph; no Embind, `ccall`, or `cwrap` path is involved.

The native callback trampoline has eight fixed reentrant scratch frames and a
4,096-slot descriptor pool. Matrix4 and URL callback arguments are encoded from
the caller's generation-checked handle arenas; callback results are decoded
into those same arenas and rewound to their entry marks after synchronous
consumption. This prevents a handle from being resolved against an unrelated
scratch arena. Its focused harness covers nested invocation, recursive records,
handle-backed arguments and results, synchronous results, error propagation,
retain/release, complete pool exhaustion/reuse, and warmed calls with zero
observed C++ allocations. The JavaScript harness covers function-token
encoding, direct-memory invocation, unsigned token normalization, borrowed
callback handles, stale-token rejection, result encoding, and rollback when
argument encoding fails before native ownership transfers.

The recording projection now emits exact vectors for all 23 registry-eligible
routes and a real browser/Wasm driver from the same IR. The driver compiles the
production direct-memory arena and callback registry with pinned Emscripten,
runs them in Chrome, and observes every stable ID and ordered input/result. It
also proves a retained callback remains callable after the forward call, that
native finalization releases and invalidates its token, that a nested reverse
callback can reenter a second route, and that capacity exhaustion and registry
reset fail closed. The provider copies the fixed `ScriptCallback` record by
value before retaining its context because the decoder arena that owned the
original record ends with the forward call; retaining an arena pointer would
be a use-after-lifetime bug.

Dynamic Hermes now owns a separate 4,096-entry callback-root lifetime table.
`Runtime::Impl` invalidates every root and destroys its `jsi::Function` while
the Hermes runtime is still alive. Lua closures may then reject invocation and
run `__gc` after Hermes destruction without dereferencing that runtime. Lua
userdata arguments are recorded in a fixed borrowed-handle ledger and released
on successful invocation, JavaScript failure, or argument-decoding failure;
the JSI/browser wrappers are non-owning so finalization cannot double-release
them. The ASan/UBSan Hermes/Lua harness exercises both success and failure
cleanup, post-runtime invocation, and later Lua collection. Callback-bearing
calls also consult the generated lifecycle ledger before Lua lookup. Ordinary
retained inputs require `registryEligible`; a higher-order route must instead
carry the generated `higher-order-closure` lifetime before it may reach Lua.

Dynamic Hermes now emits all 25 callback routes. A returned `LUA_TFUNCTION` is
captured in a generation-scoped registry reference and exposed as an owning JSI
host function. Closure creation owns one cold-path native root; invocation uses
the existing bounded reentrant scratch. The fixed 256-entry lifetime index
invalidates and unreferences every live closure while the Lua state remains
valid, after which a retained JSI function rejects without touching Lua.
`LUA_MULTRET` is bounded by the generated maximum, zero/one/many results map to
undefined/value/array, and the explicit `__dehermCallbackResultsV1` carrier
allows a JavaScript callback to return multiple Lua results without treating an
ordinary array as a Lua tuple. Wrapped Lua table errors carry an internal tagged
form across a nested JSI callback and are reconstructed before `socket.protect`
runs its `pcall` policy; direct JavaScript callers see only the original error.

The real Hermes/Lua harness executes `socket.newtry` and `socket.protect` with
varargs, multi-results, finalizer capture, direct errors, protected errors,
nested JavaScript callbacks, context restoration, and adapter teardown. It also
executes both the one-result success and two-result failure shapes of
`sys.load_resource`. Generated operation descriptors derive a minimum/maximum
result range from the trailing optional return suffix. Native and browser SDK
bridges preserve actual Lua arity internally but pad declared multi-result
tuples to their generated maximum, keeping the public TypeScript tuple stable.

The canonical plan therefore emits 913 Dynamic Hermes script routes. The Lua
stack and browser plans remain at 911, and Static Hermes remains structurally
filtered: their two precise blockers are
`higher-order-lua-closure-result-transport-unavailable`. Browser input callback
trampolines alone cannot carry a Lua-owned function back into JavaScript, while
the Static sound-type frame has no callable value class or C callback token.
The 23 emitted callback-input routes have exact standalone Emscripten/Chrome
bridge evidence. Packaged Defold HTML5 execution of those routes remains an
integration sentinel gap and is not inferred from the exact-call harness.

The callback generator, reviewed policy, and four generated artifacts are part
of the central script pipeline registry. Clean-room regeneration includes the
23 pinned Defold source files and reproduces the complete registered script
artifact set byte-for-byte.
