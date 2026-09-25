---
type: Architecture Decision
title: Use a Defold-owned typed JSI module registry
description: Borrow the useful authoring shapes of TurboModules and Nitro Modules without taking a React Native runtime dependency.
tags: [decision, jsi, turbo-modules, nitro-modules]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: react-native-turbo
    resource: https://reactnative.dev/docs/turbo-native-modules-introduction
    title: React Native Turbo Native Modules introduction
    author: team:react-native
  - id: nitro
    resource: https://github.com/mrousavy/nitro
    title: Nitro Modules
    author: human:mrousavy
---

# Status

Accepted. The handwritten proof has been replaced by generated JSI installers.

# Decision

Expose a Defold-owned, type-inferred `DefoldModules.get()` /
`getEnforcing()` API and generate module bindings from a runtime-neutral IR.

Native implementations install direct JSI host functions and objects. Browser
implementations install equivalent JavaScript objects that call the Defold
Emscripten bridge where engine access is needed.

The generated implementation waist is a C ABI. Dynamic Hermes wraps it with
JSI; Static Hermes uses `extern_c`; Lua uses ordinary native-extension bindings;
and HTML5 reaches it through Emscripten. This keeps target-specific VM objects
out of the durable engine interface.

# Compatibility stance

TurboModules provide useful typed-spec and enforcing-registry conventions, but
their registry, lifecycle, Codegen output, and platform integration belong to
React Native. Nitro Modules are closer to the desired static JSI binding and
instance-based object model, but their package, autolinking, and Swift/Kotlin
layers likewise assume React Native.

Therefore the first goal is source-pattern compatibility, not binary drop-in
compatibility. A later adapter may ingest a conservative subset of
TurboModule or `*.nitro.ts` specs, but generated C++ must target the
Defold-owned installer ABI.

# Implemented proof

The sample resolves a typed `ExampleMath` module and calls `add(20, 22)`.
Native execution reaches a Hermes JSI host function directly. Browser execution
uses the same TypeScript call against an ordinary browser object. Both emit
`module:42` in the parity transcript.

The host function delegates to an `extern "C"` function, and the Defold HTML5
adapter refers to the same symbol. `packages/bindings/modules.json` now generates the
TypeScript interface, fixed Wasm memory layouts, C declarations and layout
assertions, JSI installer, and Static Hermes `extern_c` projection. The Static
Hermes compiler accepts the generated typed declarations.

Singleton modules are eagerly-created ordinary JSI objects containing host
functions. This avoids a `HostObject.get()` trap and function allocation on
every property read. Stateful native instances will instead use JSI
`NativeState` plus generated shared prototypes, following Nitro's current
hybrid-object shape.

Project-extension providers now use one versioned, bounded, extension-neutral
registry. Core copies module and method descriptors into fixed storage and
creates JSI functions from their argument/result kinds. There is no extension
name or project symbol in the runtime. Extension-owned
`defold-hermes.bindings.json` documents provide the descriptors; package-owned
emitters create optional C registration metadata and low-level TypeScript.
Project discovery consumes the same metadata from local and resolved dependency
extensions and materializes project-keyed outputs. Adding another module does
not require a déherm package release.

Registration order is not a hidden lifecycle dependency. The installed module
object includes a generated lazy resolver. A provider registered after Hermes
host construction is found on the first TypeScript lookup, then cached in
`__defoldModulesV1`. Absence still fails closed. The standalone extension's
ordinary public C/Lua API remains independent of déherm; optional generated
integration glue alone includes the provider ABI.

Packet transport does not pass through Lua. `Uint8Array` inputs are validated
as real typed arrays, including `byteOffset` and `byteLength`; input views live
only for the synchronous callback. Mutable byte views are caller-owned output.
The WebTransport descriptor uses stream primitives: open bidirectional or
unidirectional stream, write with FIN, reset, stop-sending, datagram send, and
poll. It exposes opaque 32-bit stream handles rather than QUIC stream IDs.
Generated poll kinds cover ready, stream-opened, stream-data, datagram, reset,
stop-sending, and close; flags cover FIN, bidirectional, and incoming.

The low-level handle/poll projection is internal. The standalone extension lane
generates the public WebTransport-shaped facade from the same authority. Native
facades register a hidden `registerNativeModulePump` callback. Defold's
extension-frame hook invokes `Runtime::pumpNativeModules` exactly once per
engine frame, including component-only bundles that have no bootstrap-script
`update`; bootstrap application updates do not pump a second time. Thus no
user-visible `pump()` exists and JSI is never called from a transport worker.
HTML5 delegates to browser WebTransport and registers no native pump. The
bounded 32-slot pump table and its tick function live together in the
versioned `globalThis.__dehermNativeModulePumpStateV1` record. Dynamic and
Static module-runtime projections adopt that same record without replacing an
existing tick, so same-realm component/HMR bundle copies reuse slots instead
of orphaning callbacks in module-local tables.

The extension descriptor may intentionally select no ergonomic public C
headers when its `nativeModules[].cProvider` recipe is the integration
authority. The public `client.h` remains inventoried as extension metadata, but
is not misreported as a blocked generic C-header projection. Project generation
emits a private `deherm_project_native_modules` Defold extension only when a
provider recipe exists. That bridge includes the extension's public low-level
header, expands UTF-8 and byte spans according to `pointer-length-v1`, calls the
named symbol prefix, and registers with déherm during application initialize.
The standalone extension neither includes nor links déherm. The generated
bridge is treated as compiler infrastructure on the next inventory pass and is
ignored by source control templates. Generation writes its managed sentinel in
the same pass as the bridge, so a clean checkout reaches a stable inventory and
cache key after one generation rather than requiring generate/inventory/generate.

Dynamic JSI modules publish their descriptor ABI version as runtime metadata.
Generated TypeScript requires the exact `nativeModules[].abiVersion`; lazy
resolution also takes that version and rejects mismatches. Provider ABI zero,
the reserved resolver name, and collisions with already installed built-in
modules fail closed rather than overwriting the engine module table.

WebTransport `open` carries both browser-standard anticipated incoming stream
hints through the same descriptor: unidirectional then bidirectional. The
current game requests `64` and `8`; dynamic JSI and direct Static Hermes exact
tests assert those values reach the C provider in that order. The poll output is
a caller-owned mutable buffer whose first 32 bytes are eight little-endian
32-bit fields: kind, flags, code, request id, opaque stream handle, payload
length, reserved, and header version. `BUFFER_TOO_SMALL` writes the complete
32-byte header, leaves the event queued, and permits a bounded retry up to the
descriptor's 1 MiB payload maximum.
Mutable-byte copy-back is an argument recipe, not a WebTransport branch in the
generic emitter. A mutable argument with no recipe copies its complete
caller-owned output. WebTransport poll declares a `framedPayload` recipe with
the 32-byte header and payload-length offset; successful polls copy only the
header plus declared payload, while every non-OK status copies only the header.
This preserves `BUFFER_TOO_SMALL` retry data without copying uninitialized or
irrelevant tail storage.

# Static Hermes evidence boundary

The generated low-level Static Hermes twin is implemented and tested for all 12
provider methods. It uses direct `$SHBuiltin.extern_c` calls and never routes
through JSI or Lua. UTF-8 and byte arguments use one thread-local frame with a
depth-one reentrancy gate. Its exact static footprint is 1,048,608 bytes per
thread (the 1 MiB maximum payload plus the 32-byte poll header); a reentrant
call fails closed rather than allocating a second arena. Frame release clears
used argument bytes and mutable output storage. The normal exact-call binary
and its ASan/UBSan build prove the generated direct-C frame against a
registered provider. The descriptor-generated provider adapter and the
extension's `public_api.cpp` are compiled and tested in separate targets today;
there is not yet a joined target that links the real implementation through
that adapter into the Static frame. That unverified join is a release-evidence
gap, not an API claim.

The compiler-private high-level `static/WebTransport.ts` projection has an
executable Shermes AOT/JSI-provider compatibility gate. The generated test
constructs a session, observes `ready` and `closed`, performs datagram
read/write, creates a
bidirectional stream, and writes it against an injected WebTransport-shaped
JSI provider object. It does not prove project assembly or direct linkage to
the generated Static C++ twin. The normal and ASan/UBSan binaries pass.
`Runtime::pumpNativeModules` performs
the host microtask checkpoint immediately after the provider tick, because
Hermes does not drain Promise jobs automatically after a JSI host call.

This is not yet promoted to complete *strict typed* Static Hermes support.
Authored and project-facing types
remain the single standard WebTransport-shaped `Uint8Array`, `ArrayBuffer`, and
options contract. The generated Static source repeats that exact public
contract and isolates its current `number[]` transport representation behind
private runtime aliases; it does not publish the lowered representation as a
second user API. A future ttsc AST transform must lower that contract to Static
Hermes' strict byte-array IR, Promise/stream machinery, and supported class/type
syntax with explicit diagnostics. A regex or `any` erasure is not an accepted
compiler seam. The executable high-level gate therefore uses Shermes' untyped
AOT compatibility frontend, while the low-level direct-C provider lane remains
the strict-typed exact-call evidence. Compiling the entire Promise-based facade
with the pinned strict frontend currently fails inside Hermes' ESTree clone
(`argumentsDecl not cloned`), and TypedLib does not declare Promise; that is an
explicit compiler blocker, not evidence against the provider ABI. The
extension-frame pump drives AOT
units through the same `Runtime::pumpNativeModules` hook by installing
`__dehermNativeModulesTickV1` from the shared versioned pump state; no authored
`pump()` is exposed.

Stream-half termination is transactional at the facade boundary. Local reader
cancel checks `stopSending`, and local writer abort checks `resetStream`, before
clearing queues, settling `closed`, or retiring the half. Provider rejection or
`WOULD_BLOCK` rejects that operation while leaving the bounded JavaScript half
intact for retry; only an accepted status commits terminal state. Remote reset
and stop-sending events remain authoritative terminal notifications and do not
echo another control operation back to native.

Released reader and writer locks reject every later lock-owned operation,
including reader cancellation and writer `ready`, write, close, and abort.
Close reasons use loss-tolerant UTF-8 decoding without consuming the valid byte
following a malformed prefix. The generated public C header defines the shared
certificate-array bound as eight hashes; native and HTML5 entry points reject
larger arrays instead of truncating them differently.

The generated WebTransport facade follows browser ordering at the native
boundary: stream creation and datagram writes submitted before `ready` remain
bounded and wait for the ready event. A rejected reliable write or FIN errors
that writable half, issues one reset, and rejects later queued writes for that
stream; datagram failures remain per-write. Abort discards its queued writes.
Late RESET/STOP events for a still-known stream are consumed after the matching
local half is terminal. Releasing a reader lock rejects its pending reads and
unlocks the stream. Cancelling an incoming-stream collection retires queued
children and immediately rejects later peer streams rather than leaking them.

The HTML5 adapter projects an incoming unidirectional value as the receive
stream itself, uses `WebTransportError.streamErrorCode` when the browser
provides it, emits one STOP_SENDING event for a terminal writer/FIN failure,
and pauses browser reads between bounded high- and low-water marks. Close
reasons are normalized to at most 1024 UTF-8 bytes on a code-point boundary on
both facade and HTML5 paths. The Static projection accepts the documented
byte-addressable certificate-hash shape while preserving the authored standard
buffer-source contract.

`native/native_webtransport_jsi_e2e.cpp` is the exact-call twin. Against a real
Hermes runtime it proves absence before registration, registration after host
construction, lazy first-call resolution, every descriptor method, sliced
typed-array offsets and lengths, booleans, caller-owned poll storage, and
teardown. It also proves ABI mismatch and built-in collision rejection.
`tests/native-module-providers.test.mjs` proves generator ownership, the no-Lua
boundary, shared HMR pump state, framed versus full mutable copy-back, and a
second synthetic module with no WebTransport assumptions. These facts do not
prove QUIC interoperability or a packaged game.

Fresh War Battles project generation with the extension installed reports zero
generic native-extension C routes and zero blockers, then passes the complete
authored-context typecheck. Extension-owned dynamic and compiler-private Static
facade sources are generator inputs, not game-authored shared-context files, so
the project checker excludes their source locations and checks only their
materialized project SDK projection.

# Follow-up

Add pointer/out-parameter lowering for general modules, callbacks, promises,
and hybrid-object lifetime. Complete the ttsc AST lowering and combined
high-level Static Hermes gate described above. Run the packaged native game
against the authoritative server. The generated provider bridge is complete at
its named boundary; transport-library interoperability and packaged-engine
runtime evidence remain separate.
