---
type: Research
title: Fixed multi-result tuple lowering
description: Generated positional Lua tuple ABI, reachability boundary, and evidence state.
tags: [research, bindings, lua, hermes, abi, generated]
status: active
---

# Fixed multi-result tuple lowering

The first multi-result executable family contains 24 routes selected mechanically from the pinned script IR and binding-pattern ledger: 17 scalar/enum/nullable tuples and seven copied vector/quaternion tuples. A reviewed registration manifest pins the exact Defold source file, SHA-256, Lua member registration, and required execution context for every route.

The native path uses fixed-capacity caller-owned `ScriptCallFrame` storage. Generated SoA descriptors specify each argument codec and every result position. Lua is invoked with `LUA_MULTRET`; a stack delta must equal the descriptor arity exactly. Each result is validated and copied before the Lua stack and captured instance are restored. Nil occupies its declared tuple position. No recursive or generic table marshaler participates.

## Honest reachability boundary

- All 24 routes have generated native lowering and compile into the captured-Lua adapter.
- Eight routes are constructible from the current public TypeScript fixture.
- Sixteen Bullet3D routes require borrowed userdata produced by other Bullet3D calls. Their lowering is compiled and covered by a native fake-Lua handle, but they remain machine-marked `blocked-missing-handle-producer` for public TypeScript use.
- Declared URL union branches are recorded from the IR but excluded from the implemented positional mask until the exact 32-byte Defold URL value ABI is added. String and hash alternatives remain available for these routes.
- HTML5 browser-host calls fail closed for all 24 routes until equivalent browser codecs exist.

## Evidence

Host tests exercise the real pinned Lua 5.1 stack, exact two/three/four-result arities, boolean/integer/number/nil/vector/quaternion outputs, borrowed userdata, captured script and GUI contexts, result-capacity failure, wrong tag, wrong arity, and copied values after stack restoration. This is native adapter evidence, not packaged-engine conformance.

All 24 real-engine scenarios remain `planned` with compile/link/runtime evidence `unverified`. Generation never promotes an observation.

## Next order

1. Generate Bullet3D borrowed-handle producer routes so the 16 blocked routes become publicly constructible.
2. Add the exact Defold URL POD codec to `ScriptValue` and JSI.
3. Run packaged-engine scenarios and record SHA-bound markers before promoting compile, link, or runtime status.
4. Proceed to bounded flat records; keep owned sockets, binary strings, and table tuples in their reviewed later buckets.
