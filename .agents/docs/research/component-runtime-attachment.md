---
type: Runtime Integration Evidence
title: Component runtime attachment
description: Generated TypeScript component proxies, Lua attachment lifecycle, Dynamic Hermes execution, and remaining target gates.
tags: [research, components, runtime, hermes, lua, generation]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T15:00:00-04:00 }
---

# Component runtime attachment evidence

Status: native provider capability present; native Lua and dynamic Hermes harnesses pass; packaged Defold, Static Hermes, and browser-host execution remain unverified.

## Generated contract

The component generator projects authored source conventions into Defold-owned proxy files without route-specific hand-written wrappers:

| TypeScript source | Defold proxy | Runtime context |
| --- | --- | --- |
| `*.script.ts` | `*.script` | game-object instance |
| `*.gui.ts` | `*.gui_script` | GUI scene |
| `*.render.ts` | `*.render_script` | render instance plus graphics context |
| plain `*.ts` | none | context-free module |

Every proxy carries a stable component ID, schema fingerprint, context token, and generated property-specialization table. The Lua ABI has six generic operations: attach, lifecycle dispatch, message dispatch, input dispatch, reload dispatch, and detach. There are no per-component native wrappers.

## Implemented native path

`component_proxy_lua_gate.hpp` provides a fixed-capacity, generational Lua attachment pool. It preallocates one two-value Lua root table per slot, roots the exact Lua `self`, scopes and restores `dmScript`'s current instance (including nil), uses cached protected Lua trampolines, rejects stale handles, and makes detach idempotent. Its pinned Lua 5.1 harness records zero allocator calls across both 1,024 warmed dispatches and 1,024 warmed attach/detach cycles.

`component_hermes_backend.cpp` maps the generated ABI onto `Runtime`'s 256-slot component pool. `Runtime` resolves `globalThis.__defoldComponentsV1[componentId]`, validates schema and context, owns a Hermes definition plus self object, projects editor properties, calls lifecycle hooks, requires an exact boolean from `onInput`, preserves the Hermes self on same-runtime reload, and releases roots on detach/finalization.

Runtime identity is carried separately from component slot generations. If hot reload swaps the Hermes Runtime without reloading the generated Lua proxy resource, the first subsequent component dispatch now detects the revision change, reattaches the retained Lua `self` and property-specialization table, invokes the new generation's `onReload`, commits the replacement handle only after that succeeds, and then continues the originally requested lifecycle/message/input call. A failed attach leaves the retained slot available for retry; a failed `onReload` detaches the candidate handle and likewise leaves the slot retryable. Explicit Lua `dispatchReload` remains valid and uses the same transactional path. Native Lua tests inject both failure modes and prove retry while retaining zero warmed-dispatch Lua allocations. The dynamic-Hermes harness separately replaces the Runtime and executes the rebound component.

The dynamic-Hermes harness executes all three context kinds through Lua into Hermes and covers property materialization, lifecycle, message, input, reload, final, and idempotent detach. This is adapter evidence, not packaged-engine evidence.

Hermes HostObject finalizers never call the Lua-owned adapter directly. `script_bridge_capi.cpp` enqueues releases into a bounded fixed-capacity thread-safe queue; the runtime thread drains it before script dispatch or bridge uninstall. A concurrent native test covers four producer threads and verifies no direct GC-thread callback.

## Packaged-engine defects found by the first real game-object component

The War Battles tutorial port was the first packaged Defold project to attach a
`*.script.ts` component with a declared editor property. It exposed two defects
that no harness could have caught, because both harnesses hand the provider a
plain Lua table as `self` and neither exercises the generated current-instance
thunks.

1. **Editor properties were read raw.** `component_hermes_backend.cpp` read each
   specialized property with `lua_rawget` on the component `self`. Defold hands a
   script or GUI component *userdata* whose metatable resolves declared
   properties from the script data table, so the raw read both missed every
   property and is undefined for a non-table value; LuaJIT crashed inside
   `AttachProtected`. The provider now uses `lua_gettable`, which goes through
   `ScriptInstance_index` and cannot itself raise.
2. **Component dispatch published no game-object context.** The generated
   current-instance thunks for `go.get_position`, `go.set_position`, and
   `go.set_rotation` resolve through `game_object::resolveCurrent`, whose context
   stack was only ever pushed by the legacy singleton bootstrap attachment. Every
   such call from a component therefore failed closed with
   `No active game-object context`. `active_game_object_context.hpp` now carries
   an installable `CurrentInstanceApi` over an opaque Lua state, `extension.cpp`
   installs a resolver that borrows the instance Defold is currently dispatching
   (still revalidated by `resolveCurrent` against generation, collection, and
   identifier before any engine pointer is read), and the component backend
   enters that scope for the whole of a `game-object` dispatch.

Both fixes are provider-wide, not per-route or per-game.

## Remaining capability gates

1. Bundle registry and component-only bootstrap: the dynamic-Hermes harness supplies `__defoldComponentsV1`, but the compiler does not emit that registry yet. Native bundle activation and generated script-bridge initialization also still begin at the singleton bootstrap attachment. A project containing only generated component proxies cannot yet initialize the runtime honestly.
2. Full script-API component context: the component provider scopes `dmScript` correctly, but all ScriptAdapter lowering families (especially the captured-handle router) still select one singleton rooted instance. A bounded allocation-free context stack must select the active component root for the complete script API.
3. Recursive message/action values: the backend supports scalar Defold values and a bounded top-level string-key record. Nested records need the shared bounded recursive value arena with depth, entry-count, string-byte, cycle, ownership, and unsupported-value policy.
4. Target providers: Static Hermes needs a component C ABI; HTML5 needs a browser-host component provider. Both remain fail-closed.

The machine-readable authority is `packages/bindings/generated/defold-component-proxy-runtime-capability.json`. It intentionally separates provider capability, native harness evidence, and packaged Defold evidence.
