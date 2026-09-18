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
availability profiles: the default no-app-manifest engine exposes legacy
Box2D v2 plus Bullet 3D (253 total handle routes including eight global
buffer/resource/sys routes), while `physics.2d=:v3` plus Bullet exposes 320.
Legacy without Bullet exposes 122, v3 without Bullet 189, and a no-physics
profile only the eight globals. The executable handle generator must derive
its route set from the selected app-manifest profile and registration arrays;
it must never bind or claim the 345-route Box2D/Bullet union.

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
