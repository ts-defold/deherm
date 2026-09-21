---
type: Design and Verification Report
title: Static script tail exact verification
description: Generator-owned recursive exact vectors for every lowering-plan-emitted Static Hermes script route.
tags: [verification, static-hermes, bindings, codegen, tables]
status: implemented
generated: { by: openai/codex, at: 2026-09-21T00:00:00-04:00 }
sources:
  - id: exact-model
    resource: ../../../packages/compiler/src/script-static-exact-verification.mjs
    title: Static script exact verification model
    author: project:deherm
  - id: exact-builder
    resource: ../../../scripts/build-static-script-exact-verification.mjs
    title: Static script exact verification builder
    author: project:deherm
  - id: recording-report
    resource: ../../../packages/bindings/generated/defold-script-recording-engine.json
    title: Generated script recording engine report
    author: project:deherm
---

# Scope and census

The owning selection is mechanical: take each recording-engine route whose
`static-hermes` applicability entry resolves to `status: exercise` and lane
`static-hermes-typed-native`. The complete emitted census is 325 routes:
Defold-value 127, scalar 90, Lua-table 70, dynamic-values 14, multi-result 12,
and overload-dispatch 12. The final 108 rows are therefore a projection fact,
not a handwritten route allowlist.

Every name below is the suffix of its canonical `script:<name>` projection ID;
stable IDs remain generated alongside those canonical strings in the recording
report.

The Lua-table rows are `b2d.get_version`, `bullet3d.get_version`,
`camera.get_cameras`, `collectionfactory.create`,
`collectionproxy.get_resources`, `compute.get_constants`,
`compute.get_samplers`, `compute.get_textures`, `compute.set_constants`,
`compute.set_samplers`, `compute.set_textures`, `crash.get_backtrace`,
`crash.get_modules`, `factory.create`, `font.get_info`, `go.delete`,
`graphics.get_adapter_info`, `graphics.get_engine_adapters`,
`gui.get_layouts`, `image.get_astc_header`, `image.load`,
`image.load_buffer`, `label.get_layout_objects`, `liveupdate.get_mounts`,
`material.get_constants`, `material.get_samplers`, `material.get_textures`,
`material.get_vertex_attributes`, `material.set_constants`,
`material.set_samplers`, `material.set_textures`,
`material.set_vertex_attributes`, `model.get_aabb`,
`model.get_blend_weights`, `model.get_mesh_aabb`,
`model.set_blend_weights`, `msg.post`, `particlefx.stop`,
`physics.create_joint`, `physics.get_joint_properties`, `physics.get_shape`,
`physics.raycast`, `physics.raycast_async`,
`physics.set_joint_properties`, `physics.set_shape`,
`profiler.view_recorded_frame`, `render.clear`, `render.dispatch_compute`,
`render.draw_debug3d`, `render.set_camera`, `resource.create_atlas`,
`resource.create_buffer`, `resource.create_sound_data`, `resource.get_atlas`,
`resource.get_text_metrics`, `resource.set_atlas`, `sound.get_groups`,
`sound.stop`, `sys.deserialize`, `sys.get_application_info`,
`sys.get_engine_info`, `sys.get_ifaddrs`, `sys.get_sys_info`, `sys.load`,
`sys.open_url`, `sys.save`, `sys.serialize`, `tilemap.get_tile_info`,
`tilemap.get_tiles`, and `window.get_safe_area`.

The dynamic-value rows are `bit.band`, `bit.bor`, `bit.bxor`, `json.decode`,
`json.encode`, `pprint`, `socket.skip`, `types.is_hash`,
`types.is_matrix4`, `types.is_quat`, `types.is_url`, `types.is_vector`,
`types.is_vector3`, and `types.is_vector4`.

The multi-result rows are `collectionproxy.set_collection`, `gui.new_texture`,
`socket.dns.getaddrinfo`, `socket.dns.getnameinfo`,
`socket.dns.tohostname`, `socket.dns.toip`, `sound.get_peak`, `sound.get_rms`,
`sys.load_resource`, `tilemap.get_bounds`, `vmath.quat_to_euler`, and
`window.get_size`.

The overload-dispatch rows are `msg.url`, `vmath.clamp`, `vmath.dot`,
`vmath.lerp`, `vmath.matrix4`, `vmath.matrix4_scale`, `vmath.mul_per_elem`,
`vmath.normalize`, `vmath.quat`, `vmath.slerp`, `vmath.vector3`, and
`vmath.vector4`.

# One recursive value plan

All 108 rows use the existing production bounded Static frame. No family-only
runtime or second dispatch table is introduced. One generator plan walks the
recording report's interned shape tree and produces both a sound-typed value
constructor and an exact result predicate. Primitive and Defold-value leaves
reuse the earlier implementation. Sequence, record, and map nodes recurse over
the same child-sentinel rule that owns the recording provider's canonical
value text. Records preserve generated field names; maps preserve both key and
value shapes. Cyclic or unsupported shape graphs fail generation.

The actual tail shape union is bounded. Lua-table reaches records, sequences,
maps, strings, numbers, booleans, hashes, URLs, vectors, and quaternions, with
at most two input and six output entries in the exact vectors. Dynamic-value
adds no new wire code. Multi-result uses two, three, or four ordered result
slots and reuses recursive output predicates. Overload-dispatch uses only
numbers, URLs, vectors, quaternions, and Matrix4 values.

Verification-only accessors for container length, keys, and values are emitted
only into the build-directory Static unit. The committed production Static
class source remains byte-identical to the normal generator output.

# Capacity and arity

Driven exact arity is distinct from frame capacity. Dynamic bit operations and
`pprint` have a 32-argument capacity but their canonical vectors drive fewer
slots. Five overload constructors drive zero arguments while retaining one to
four argument slots. Generation therefore requires driven argument/result
counts to stay within the route minima and maxima, while capacities must equal
the route maxima. Table-entry capacities remain the reviewed zero-or-256
profiles and must cover the recursively computed exact entry demand.

All 108 result contracts say `no-retained-result-release`; adding a retained
handle result continues to fail closed until the runner owns its release rule.

# Evidence boundary

The resulting 325-route executable proves stable-ID lookup, ordered exact
arguments, generated-provider invocation (including zero-argument routes via a
non-empty recorded context), recursive result decoding, exact
result order and arity, applicability, normal linkage, and ASan/UBSan-clean
execution through the production Static frame. It is transport evidence
against the generated recording provider, not Defold implementation semantics.

One vector per route does not prove every dynamic union member, variadic count,
optional-result omission, or overload alternative. Current sequence/map
fixtures contain one element, most generic records are empty, strings/keys are
short ASCII, and sibling boolean sentinels can repeat; those vectors prove the
generated contract they carry but not every ordering, UTF-8, or sibling-swap
case. Cyclic shape graphs fail with the declared generator error before the
canonical renderer recurses. ASan/UBSan checks memory safety; it does not
instrument allocation counts. Warmed allocation claims belong only to
separately instrumented runtime benchmarks.
