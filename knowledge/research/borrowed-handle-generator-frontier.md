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
3. Implement the 7 `checked-handle-invalidate` routes after return capture. A bridge slot is retired only after the underlying Defold operation succeeds. GUI deletion remains deferred, and physics/render validity remains owned by the engine.
4. Implement the 8 `declaration-token` routes in the component/property compiler. `resource_data` is declaration metadata accepted by `go.property`; it is not a runtime handle.

The exact module census is Box2D 206, Bullet3D 131, GUI 55, runtime buffer routes 8, render routes 7, and declaration-only routes 8.

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
