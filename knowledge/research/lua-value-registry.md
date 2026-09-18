---
type: Verification Report
title: Universal Lua value registry core
description: A bounded generational root registry for identity-bearing Defold Lua values, with allocation and teardown evidence.
tags: [lua, bindings, handles, memory, verification]
status: spike-validated
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-lua
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/lua
    title: Pinned Defold Lua source
    author: team:defold
  - id: defold-script
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/script/src/dmsdk/script/script.h
    title: Defold dmScript reference API
    author: team:defold
---

# Universal Lua value registry core

The registry is the bounded compatibility lane for long-lived values whose
identity has to survive a call boundary: userdata, tables, callbacks/functions,
identity-bearing Defold userdata, and captured current script instances. It is
not a general representation for every Lua value. Its behavior is driven by a
`LuaValueDescriptor { kind, policy }`; there is no module- or API-specific code
in the registry.

## Hard performance boundary

Never put vector, quaternion, matrix, hash, URL, color, or other hot math/value
temporaries in this registry merely because Lua represents some of them as
userdata. Generated codecs carry those values through fixed-layout by-value
cells, caller-provided scratch, or the xMath codec. Closures are created once,
rooted once, and cached. Tables/userdata enter this registry only when identity
or cross-call lifetime is semantically required.

`luaL_ref` can grow Lua's registry table, object construction can allocate, and
`lua_checkstack` can grow the Lua stack. Acquire/root is therefore a cold path.
Capacity and stack space must be prewarmed and measured for each runtime
profile. Exhaustion has no heap fallback: capture returns an invalid handle and
increments `capacityFailures`.

After construction, the native registry owns one dense fixed-capacity slot
array and one bounded handle ring. Lookup, explicit release, deferred enqueue,
drain, stale rejection, and shutdown do not allocate C++ memory. The executable
harness prewarms Lua, then proves zero C++ allocation calls and zero nonzero Lua
allocator calls over 100,000 push/pop lookups followed by deferred and explicit
release. This is a reproduced result for pinned Defold Lua on macOS arm64, not a
claim that arbitrary Defold functions invoked after lookup cannot allocate.

## Handle and lifetime contract

The public handle reuses the existing four-word universal shape:

```cpp
Handle { runtime, slot, generation, type }
```

`runtime` prevents a handle from crossing Hermes/Defold runtime instances;
`slot + generation` rejects use-after-release even after the slot is reused;
and `type` must equal the stored `LuaValueKind`. Every read or release can also
require an expected kind and ownership policy. Failures are classified as
runtime, kind, policy, Lua-type, stale-generation, double-release, capacity, or
queue-overflow counters rather than collapsed into one error.

Both policies create a Lua registry root. `borrowed` means the bridge borrows
the underlying native/engine object's ownership; `ownedRoot` means the wrapper
owns the bridge root/lifetime contract. Neither policy authorizes freeing an
engine object directly. Release only calls the configured Lua unref operation.
In a Defold extension that operation must be injected as `dmScript::Ref` and
`dmScript::Unref`, which have the same signatures and maintain Defold's global
reference balance. The standalone conformance fixture uses raw `luaL_ref` and
`luaL_unref` so it can link only pinned Lua.

`queueRelease` changes a live slot to queued and writes its handle to a bounded
ring without touching Lua. The runtime later calls `drainDeferred` on the Lua
thread. Queue overflow leaves the handle live so a caller can retry or release
it explicitly. The current implementation is runtime-thread-affine; a finalizer
running on another thread must schedule the enqueue onto the runtime thread.

## ScriptValue integration seam

The current tagged call ABI already reserves `kHandle`, `kCallback`, `kTable`,
and `kDefoldValue`. Integration can encode a registry handle without changing
the ABI:

```text
ScriptValue.tag     = kind-specific handle tag
ScriptValue.length  = Handle.runtime
ScriptValue.payload = (uint64(generation) << 32) | slot
ScriptValue.flags   = ownership policy plus the kHandle subtype when needed
```

`kCallback`, `kTable`, and `kDefoldValue` imply their registry kind. Generic
userdata and current-instance handles use `kHandle` plus a stable subtype in
`flags`. The decoder must reconstruct all four handle fields and call registry
validation before touching Lua. This note defines that seam but the registry
wave deliberately does not edit the active scalar adapter or tagged ABI files.

## Verified behavior

The strict C++ harness compiles the registry against Defold's pinned, renamed
Lua 5.1 sources at revision
`7f0f554f41f9dce1e0ddff99bf08200657d1ee05`. It proves:

- table, C closure, userdata, Defold-value userdata, and instance-table identity
  survive stack removal and a full Lua collection;
- exact stack preservation for capture, lookup failure, release, drain, and
  shutdown, while successful lookup pushes exactly one value;
- runtime, kind, policy, slot, and generation checks reject forged or stale
  handles;
- slot reuse changes the generation and a second explicit release is counted;
- a full pool and a full deferred ring fail deterministically without fallback;
- bounded partial drain, explicit shutdown, and destructor cleanup cover both
  live and queued roots; and
- the warmed lookup/release path has no observed C++ or Lua allocations.

The same harness passes AddressSanitizer and UndefinedBehaviorSanitizer teardown
on macOS arm64. Apple ASan reports that leak detection is unsupported on this
platform, so the result is an ASan/UBSan memory-safety pass, not an LSan claim.

Run the ordinary test with:

```sh
node --test tests/lua-value-registry.test.mjs
```

Run the sanitizer target with:

```sh
cmake -S tests/native/lua_value_registry \
  -B build/lua-value-registry-sanitize -DDEHERM_SANITIZE=ON
cmake --build build/lua-value-registry-sanitize --target lua-value-registry-test
ASAN_OPTIONS=halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
  ./build/lua-value-registry-sanitize/lua-value-registry-test
```

## Next integration step

Generate `LuaValueDescriptor` rows from the binding IR's semantic tokens. Route
only identity-bearing rows through this registry, inject the dmScript reference
API in the extension, and encode/decode the four-word handle through
`ScriptValue`. The integration tests must then exercise real Defold instance
swap/restore and JS finalizer scheduling without weakening the by-value math
lane.
