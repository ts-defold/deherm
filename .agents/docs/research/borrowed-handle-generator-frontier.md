---
type: Research
title: Borrowed-handle generator frontier
description: Planning classification and implementation order for pending borrowed-handle routes.
tags: [research, bindings, lua, handles, codegen]
status: active
---

# Borrowed-handle generator frontier

Status: generated classification and implementation plan, not runtime conformance evidence.

The pinned Defold script API accounting contains 415 pending routes whose primary lowering family is `borrowed-handle`. The deterministic report at `bindings/generated/defold-script-borrowed-handle-classification.json` assigns every route to one mutually exclusive operation class with a stable binding ID, concrete handle kind, required engine context, ownership policy, terminal validity rule, and invalidation boundary. The generator rejects input, source, stable-ID, exception-set, or count drift.

## Exact partition and order

1. Implement the 367 `checked-handle-input-terminal` routes first. They consume an existing handle, run the original Defold Lua terminal validation, and neither capture a returned handle nor retire engine identity.
2. Implement the 33 `checked-handle-return-capture` routes next. Each return must be checked against its reviewed concrete kind before the exact Lua userdata is rooted. Numeric graphics handles remain branded scalar values rather than Lua registry entries.
3. Implement the two `checked-child-engine-object-invalidate` routes without
   retiring the parent body host handle. `b2d.body.destroy_fixture` and
   `b2d.body.destroy_shape` destroy a child selected by integer index; the body
   remains valid.
4. Implement the five `checked-self-engine-object-invalidate` routes while
   preserving their rooted host userdata. Defold mutates or invalidates the
   underlying identity, and follow-up `is_valid(handle)` calls must observe
   `false`; retiring the host slot would incorrectly prevent that API behavior.
5. Implement the 8 `declaration-token` routes in the component/property compiler. `resource_data` is declaration metadata accepted by `go.property`; it is not a runtime handle.

The exact module census is Box2D 206, Bullet3D 131, GUI 55, runtime buffer routes 8, render routes 7, and declaration-only routes 8.

The 206 Box2D rows are a documentation union, not one linkable runtime surface.
Pinned Defold build and Lua-registration sources show mutually exclusive
availability profiles. The generated adapter-executable counts are 253 for the
default legacy-Box2D-plus-Bullet profile, 318 for Box2D v3 plus Bullet, 122 for
legacy without Bullet, 187 for v3 without Bullet, 139 for Bullet only, and eight
for no physics. The broader source catalogs contain additional non-handle or
blocked routes and must not be confused with these adapter counts. The runtime
installs only descriptors enabled by the exact selected profile; it never binds
or claims the 343-route adapter union as one linkable engine surface.

## Representation boundary

Lua-rooted userdata is required for Box2D wrappers, Bullet wrappers, GUI nodes, buffers, buffer streams, and render constant buffers. Rooting preserves Defold's concrete userdata type, source validators, parent-buffer reference, and Lua finalizer behavior. The bridge registry's generation protects bridge slot reuse; it does not replace engine validity checks.

Render targets and textures are numeric `dmGraphics::HAssetHandle` values. They require validation against the active graphics context and expected asset type on every call. Putting the number in a generational registry would not extend the asset lifetime or prove native validity.

Resource declaration values are compiler tokens. They resolve into component property metadata and compiled resource hashes and never enter the runtime registry.

## Allocation claim

After fixed-capacity bridge registries and Lua stack/registry storage are prewarmed, handle-consuming lookup and dispatch glue can avoid C++ heap allocation. This claim is limited to the glue. Lua registry growth, userdata capture, GUI or physics object creation, Box2D/Bullet tracking-table growth, constant-buffer creation, resource work, render commands, and engine/user callbacks may allocate.

Regenerate with:

```sh
node scripts/generate-borrowed-handle-classification.mjs
```

Verify without writing with:

```sh
node scripts/generate-borrowed-handle-classification.mjs --check
node --test tests/borrowed-handle-classification.test.mjs
```

## Captured-Lua router boundary

The algebra-selected descriptor wave contains 407 runtime borrowed-handle
routes. The generic game/global router can cover 343 of them; 64 currently
require another capability rather than another signature-specific wrapper:

| Count | Generated blocker | Capability required to unlock the class |
| ---: | --- | --- |
| 55 | `gui-script-attachment-unavailable` | A `GuiScriptAttachment` provider that captures the active `lua_State` and GUI scene/instance from the generated `.gui_script` proxy, restores that instance for the call, and validates node handles against the active scene. |
| 7 | `render-script-attachment-unavailable` | A `RenderScriptAttachment` provider that captures the render-script instance and graphics context, plus semantic lifetime policies for constant buffers, render targets, and textures. |
| 2 | `profile-symbol-unavailable` | A profile-aware symbol provider for `b2d.body.get_user_data` and `b2d.body.set_user_data`. The pinned documentation describes them, but the pinned runtime registration catalog does not expose them. A target may enable them only when the selected Defold engine proves the symbol, or when a separately proven native substitute has equivalent semantics. |

The intended reusable shape is:

```text
projection IR
  -> exact argument/result codecs
  -> semantic handle-kind IDs
  -> attachment context + availability profile
  -> one captured-Lua router
```

Defold's own source validates this context distinction. GUI calls recover a
GUI-script instance through `dmScript::GetInstance`; render calls do the same
for a `RenderScriptInstance` and then use its render/graphics context. Déherm
must reproduce that attachment boundary instead of invoking these functions
with a generic game-object instance.

## Generated router status

The router generator now emits all 407 selected descriptor rows. Of these, 343
have a generic game-object/global adapter and the 64 rows above remain blocked.
Each route carries a stable six-profile bit mask. Initialization validates the
complete generated handshake—schema, profile ID, Defold revision, capability
bits, source route count, route-set hash, and catalog hash—before installing any
Lua symbol. Missing or stale handshake data fails closed; there is no implicit
default profile.

The native harness executes only the descriptors available in each of the six
profiles and injects failures at seven Lua stages. All module traversal,
metamethod access, current-instance capture/set/restore, argument push, target
call, result conversion/rooting, and public handle capture occur inside Lua 5.1
protected trampolines. Failure restores the original stack, instance, result,
and scratch frame before a reentrant recovery call.

Generated dynamic-Hermes host objects expose readonly runtime, slot,
generation, and semantic-kind fields plus idempotent disposal. A Hermes harness
has exercised those host-object mechanics, but the generated evidence remains
conservative: zero routes are promoted as Defold-engine verified, dynamic-Hermes
runtime verified, Static-Hermes executable, or browser executable. Adapter
harness execution is not engine semantic conformance.

The context-provider metadata is aligned with the authoring convention:

| Source | Proxy | Provider state |
| --- | --- | --- |
| ordinary `*.ts` | none | context-free/global only |
| `*.script.ts` | `.script` | generated game-object provider |
| `*.gui.ts` | `.gui_script` | `GuiScriptAttachment` still required |
| `*.render.ts` | `.render_script` | `RenderScriptAttachment` still required |

The sample project carries the exact generated profile handshake. The CLI still
needs to project those fields automatically into arbitrary generated Defold
projects; until then, the runtime correctly rejects a project whose handshake
was not installed.
