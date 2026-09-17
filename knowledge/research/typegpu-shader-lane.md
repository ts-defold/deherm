---
type: Research Note
title: TypeGPU shader authoring lane
description: A future build-time TypeGPU-to-Defold shader compiler, including adapter boundaries, reflection, diagnostics, packaging, and validation.
tags: [research, typegpu, shaders, glsl, defold, webgpu, tooling]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T12:15:03-04:00 }
sources:
  - id: typegpu-gl-docs
    resource: https://docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/
    title: TypeGPU GLSL and WebGL package
    author: team:software-mansion
  - id: typegpu-functions
    resource: https://docs.swmansion.com/TypeGPU/apis/functions/
    title: TypeGPU shader functions
    author: team:software-mansion
  - id: typegpu-unplugin
    resource: https://docs.swmansion.com/TypeGPU/tooling/unplugin-typegpu/
    title: TypeGPU build plugin
    author: team:software-mansion
  - id: typegpu-gl-source
    resource: https://github.com/software-mansion/TypeGPU/tree/10378ff72b357e8d273fc1ec941693517aaad881/packages/typegpu-gl
    title: TypeGPU GLSL generator source snapshot
    author: team:software-mansion
  - id: typegpu-unplugin-source
    resource: https://github.com/software-mansion/TypeGPU/tree/10378ff72b357e8d273fc1ec941693517aaad881/packages/unplugin-typegpu
    title: TypeGPU build-plugin source snapshot
    author: team:software-mansion
  - id: defold-shaders
    resource: https://defold.com/manuals/shader/
    title: Defold shader programs
    author: team:defold
  - id: defold-materials
    resource: https://defold.com/manuals/material/
    title: Defold materials
    author: team:defold
  - id: defold-editor-scripts
    resource: https://defold.com/manuals/editor-scripts/
    title: Defold editor scripts and build hooks
    author: team:defold
  - id: defold-shader-builder
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline/ShaderProgramBuilder.java
    title: Defold ShaderProgramBuilder at the pinned revision
    author: team:defold
  - id: defold-shader-pipeline
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline/shader/ShaderCompilePipeline.java
    title: Defold modern shader pipeline at the pinned revision
    author: team:defold
---

# Decision summary

Keep a TypeGPU lane open, but implement it as an **offline shader authoring
frontend**, not as a second graphics runtime:

```text
shader.ts
  -> unplugin-typegpu (TS/JS function -> tinyest metadata)
  -> isolated Node build worker
  -> TypeGPU GLSL generator
  -> Defold compatibility adapter
  -> generated .vp / .fp / .material + binding manifest
  -> Bob's existing glslang -> SPIR-V -> reflection -> target shaders
  -> Defold graphics runtime
```

This route is feasible for vertex and fragment shaders. It preserves Defold's
existing Vulkan, Metal, OpenGL, OpenGL ES, DirectX, and experimental WebGPU
pipeline instead of bypassing it. It also keeps TypeGPU, its compiler, and its
WebGL/WebGPU runtime APIs out of the shipped game.

It is **not a direct source-copy integration today**. The TypeGPU GLSL backend
is explicitly experimental, its public entry is named
`unstable_shaderGenerator`, and its generated GLSL ES conventions do not match
all of Defold's modern SPIR-V-compatible GLSL conventions. A small, tested
compiler adapter is required.[^typegpu-gl]

# Verified state

The research snapshot is TypeGPU commit
`10378ff72b357e8d273fc1ec941693517aaad881` from 2026-09-16. At that commit:

* `@typegpu/gl` declares version `0.12.4` on `main`; the most recently indexed
  npm publication during this research was `0.12.2`. Do not assume the `main`
  package version is already published.
* `glOptions()` makes `tgpu.resolve()` emit GLSL, while `dualGlOptions()` creates
  vertex and fragment options with shared cross-stage naming state.
* `GlslGenerator` identifies its language as `glsl` and describes itself as a
  GLSL ES 3.0 generator.
* The implemented runtime backend is WebGL 2 and supports a focused vertex and
  fragment subset. Compute pipelines, storage buffers, bind groups, comparison
  samplers, command encoders, and several other WebGPU features deliberately
  throw unsupported errors.
* TypeGPU's build plugin parses functions marked with `'use gpu'`, converts
  them to compact `tinyest` metadata, gathers external references, and injects
  the metadata into JavaScript. The plugin emits a high-resolution JavaScript
  source map for this transformation.
* TypeGPU resolution walks the referenced resource/function graph. Imported
  helper functions are included when reachable, and compile-time-known values
  can be folded. This is the correct basis for shader-level tree shaking.

The pinned Defold revision is
`7f0f554f41f9dce1e0ddff99bf08200657d1ee05` (`VERSION` is `1.14.0`). Its modern
shader pipeline:

1. Selects modern mode when the GLSL source has a version declaration; Defold
   recommends at least `#version 140`.
2. Preprocesses shader includes.
3. Runs `glslang` with Vulkan/SPIR-V semantics, automatic bindings and
   locations, and optimization.
4. Reflects the optimized SPIR-V.
5. Reconciles vertex/fragment interfaces and resources.
6. Cross-compiles the same SPIR-V to the target set: GLSL, GLSL ES, HLSL, MSL,
   WGSL, or native SPIR-V.
7. Stores the target programs and reflection in the compiled `.spc` resource.

Materials refer to `.vp` and `.fp` inputs and separately carry render tags,
vertex-space policy, vertex attribute semantics, engine/user constant kinds,
sampler state, and default values. Shader code alone cannot recover all of
that information.[^defold-pipeline]

# Product boundary

The first package should be `@ts-defold/typegpu`, developed in this repository
until its contract settles. It should have no runtime dependency on Hermes and
should eventually be usable by Lua-only Defold projects as well.

Hermes game code consumes only generated, typed material bindings. The shader
definition modules belong to a separate build graph and must not be bundled
into dynamic Hermes bytecode or Static Hermes output.

```text
                         build time only
                  +--------------------------+
shader TypeScript | @ts-defold/typegpu       |
----------------->| TypeGPU + GLSL adapter   |---> Defold text assets
                  +--------------------------+           |
                                                         v
runtime TypeScript ---> generated material API ------> Defold runtime
```

# Authoring contract

Do not try to infer a complete Defold material from a shader function. Require
an explicit, typed descriptor because several Defold concepts have no TypeGPU
equivalent:

```ts
export default defineDefoldMaterial({
  name: "sprite_lit",
  tags: ["tile"],
  vertexSpace: "world",
  vertex,
  fragment,
  attributes: {
    position: { location: 0, semantic: "position" },
    texcoord0: { location: 1, semantic: "texcoord" },
  },
  constants: {
    viewProj: { shader: "view_proj", stage: "vertex", kind: "viewProj" },
    tint: {
      shader: "tint",
      stage: "fragment",
      kind: "user",
      default: [1, 1, 1, 1],
    },
  },
  samplers: {
    textureSampler: {
      shader: "texture_sampler",
      wrapU: "clampToEdge",
      wrapV: "clampToEdge",
      minFilter: "default",
      magFilter: "default",
    },
  },
});
```

The actual API may become more compact, but these facts must remain explicit:

* shader entry points and stages;
* stable external resource names;
* explicit vertex locations and Defold semantic types;
* material tags and vertex space;
* engine-provided versus user-provided constants;
* default values and sampler policy;
* minimum graphics feature/profile requirements.

Every externally addressed TypeGPU value must receive a deterministic name.
Automatically generated names are acceptable for private helper functions,
never for material constants, attributes, samplers, or generated TypeScript
properties.

# Compiler stages

## 1. Discover material roots

The project configuration names shader entry modules or a dedicated ttsc
transform discovers `defineDefoldMaterial()` calls. Discovery emits a stable
manifest containing module path, exported material name, and target variants.
Dynamic discovery is forbidden in release builds.

Only discovered material roots enter the shader build. This is the first
tree-shaking boundary.

## 2. Transform shader TypeScript

Run the official `unplugin-typegpu` transformation in an isolated build-only
bundle. Rollup is the safest initial host because the TypeGPU team documents
Vite/Rollup and Babel as its actively maintained paths.

The build worker may execute the transformed module to instantiate TypeGPU
descriptors. Treat shader modules as trusted build code, make execution
deterministic, deny network access, and expose only declared environment
inputs. Do not run them inside the game VM.

The normal game ttsc/Static Hermes compilation and shader compilation must be
separate graphs. Shared source modules are allowed, but imports from a
`*.shader.ts` module into runtime code should be rejected unless they reference
an explicitly generated runtime facade.

## 3. Resolve the reachable TypeGPU graph

Resolve one complete render-pipeline descriptor twice, once for vertex and
once for fragment, using paired GLSL options. Do not concatenate independently
resolved functions: cross-stage identifiers and varyings need shared state.

The initial spike must prove the documented `dualGlOptions()` path against a
real vertex/fragment pair. Current source creates separate generators with
shared resource-name state, while some varying bookkeeping is generator-local.
If standalone stage resolution does not preserve varyings, construct and
resolve a complete pipeline graph as TypeGPU's WebGL backend does, and report a
minimal upstream issue or PR rather than depending on private fields.

Record `resolveWithContext().declarations`, generated names, and every declared
external resource before adapting the result.

## 4. Adapt GLSL to Defold's canonical input dialect

The adapter owns a narrow, structural transformation:

* emit a version accepted by Defold's modern `glslang -V` path;
* group non-opaque uniforms into stable per-stage uniform blocks;
* preserve opaque texture/sampler declarations in a form Defold can reflect;
* assign deterministic attribute and fragment-output locations;
* preserve matched vertex outputs and fragment inputs;
* remove TypeGPU WebGL-runtime-only uniforms such as texture Y-flip controls
  when Defold owns the texture convention;
* reject unsupported TypeGPU resources instead of silently changing behavior;
* retain a mapping for every inserted, removed, and moved generated line.

Do not use regular expressions as the long-term transformer. Either extend the
TypeGPU GLSL generator through its shader-generator interface or operate on a
small GLSL AST. The first spike may use tightly bounded text transforms only
when golden tests cover the exact emitted forms.

The correct canonical input version must be established by compilation tests,
not assumed. TypeGPU's WebGL backend prepends `#version 300 es`; Defold's modern
pipeline feeds input through Vulkan/SPIR-V semantics. The likely adapter output
is desktop modern GLSL with uniform blocks, but the proof must compile through
the pinned Bob/glslang toolchain and all selected cross-compile targets.

## 5. Emit Defold assets

For each reachable material, emit deterministic resources under one generated
root, for example:

```text
/generated/typegpu/sprite_lit.vp
/generated/typegpu/sprite_lit.fp
/generated/typegpu/sprite_lit.material
/generated/typegpu/sprite_lit.shader-map.json
/generated/typegpu/sprite_lit.bindings.ts
```

Use content hashes to avoid rewriting unchanged files. Stable paths matter for
Defold's resource graph and build cache. Generated files should contain a
tool/version header but no timestamp.

## 6. Let Bob compile and reflect

Bob remains the authority for shader validity and reflection. Do not ship a
parallel reflection format as truth. After Bob produces `.spc`, validate its
SPIR-V-derived reflection against the TypeGPU/Defold descriptor:

* stage inputs and outputs;
* locations and types;
* uniform blocks, members, offsets, and array counts;
* textures/samplers and binding relationships;
* storage buffers when that phase is eventually supported.

A mismatch is a build error. This catches optimizer removal, name remapping,
layout disagreement, and backend limitations before runtime.

## 7. Generate runtime TypeScript bindings

Generate a small ESM module per material. It should export literal property
names, value types, and thin helpers over the ordinary Defold APIs. It must not
carry TypeGPU's compiler or schema runtime.

The generator needs separate policies for:

* component material properties updated with `go.get`/`go.set`/`go.animate`;
* GUI material properties updated with `gui.get`/`gui.set`;
* render-script constant buffers and texture bindings;
* static material metadata used only at build time.

Do not promise arbitrary TypeGPU uniform structs through the first API. Defold
material constants have their own supported shapes and semantics. Initially
accept the proven intersection—especially `vec4`, `mat4`, arrays supported by
Defold, and reflected samplers—and reject everything else with a clear
diagnostic. Expand from test evidence.

# Reflection and memory layout

Three descriptions participate, but only one is authoritative at runtime:

| Layer | Purpose | Authority |
|---|---|---|
| TypeGPU schemas | Authoring types and function inference | Source intent |
| Defold material descriptor | Engine semantics and defaults | Asset contract |
| Bob SPIR-V reflection | Actual names, locations, types, offsets, bindings | Runtime truth |

The compiler compares all three. Never assume WebGPU/WGSL layout rules equal
GLSL uniform-block or Defold material rules. A structurally similar TypeGPU
schema can still have incompatible alignment, padding, or supported value
types.

For later buffer/storage support, reuse the repository's compile-time ABI
schema approach: generate an explicit offset/size/alignment table, validate it
against SPIR-V reflection, and expose typed array/DataView writers that can
write into caller-owned or pooled memory. No per-frame object graph walking or
generic reflection should enter a render loop.

# Diagnostics and source maps

There are two distinct mappings:

1. TypeScript to transformed JavaScript. The official TypeGPU unplugin already
   emits a high-resolution source map using `magic-string`.
2. TypeScript shader statements to generated GLSL. TypeGPU does **not**
   currently expose an equivalent fine-grained GLSL source map. Its compact
   `tinyest` nodes do not retain source spans, and `resolveWithContext()` returns
   code/declarations and resource context rather than source mappings.

The first implementation should therefore:

* record each named shader function's original file and span during the
  unplugin pass;
* retain declaration-level boundaries from `resolveWithContext()`;
* compose a generated-line map through the Defold GLSL adapter;
* preserve generated `.vp`/`.fp` sources on failure;
* parse Bob/glslang diagnostics and report both the generated location and the
  closest TypeScript function span;
* optionally insert carefully tested `#line` directives between declarations,
  without claiming statement-level precision.

Fine-grained expression diagnostics should be proposed upstream as a focused
TypeGPU change: carry optional source spans in tinyest metadata and allow a
shader generator to return emitted ranges. That proposal needs independent
tests and should not be bundled with Defold-specific behavior.

# Tree shaking and variants

The lane should preserve the project's "pay only for what is used" rule at
four levels:

1. The material-root manifest excludes unused shader entry modules.
2. The JavaScript bundler removes unused TypeGPU modules and schemas.
3. `tgpu.resolve()` emits only functions/resources reachable from each entry
   graph, with specialization and compile-time folding where applicable.
4. Generated runtime binding modules are per material and per exported
   property, so the game bundle can remove helpers it never imports.

Do not generate one global shader registry. Do not allow string-based dynamic
material discovery in release mode. Explicit variant axes—skinning, lighting,
fog, atlas mode, quality tier—should create a finite variant manifest. Hash the
resolved descriptor plus compiler versions and target profile so equivalent
variants can share artifacts.

The release report should list each emitted material, shader functions and
resources retained, variant reason, and byte size. This makes accidental
variant explosions visible.

# Development and packaging

The package should provide one canonical CLI used by every environment:

```text
ts-defold typegpu build
ts-defold typegpu watch
ts-defold typegpu check
```

Integration layers call that CLI:

* `npm` scripts and CI call it before Bob.
* A Defold editor script may call it from `on_build_started` and
  `on_bundle_started`, or run the watcher as an explicit editor command.
* Bob command-line builds must invoke the CLI separately because Defold editor
  lifecycle hooks do not run under Bob.

Library-provided editor scripts cannot install the project's sole root
`hooks.editor_script`; expose composable hook functions and document the
one-line root hook. If zero-install tooling becomes important, the Defold
extension can distribute per-host executables through `plugins/bin`, which the
editor extracts under `build/plugins`. Start with Node because the TypeScript
toolchain already requires it; add standalone host binaries only after the API
stabilizes.

Pin exact compatible versions of `typegpu`, `@typegpu/gl`, and
`unplugin-typegpu`. The current GLSL generator uses an unstable interface, so a
dependency update requires golden regeneration and the full shader matrix.

# Platform and WebGPU caveats

TypeGPU must not create a WebGL or WebGPU device inside a Defold game. Defold
owns the graphics context, render passes, resource lifetime, and batching.
`@typegpu/gl` is used only for source generation.

On HTML5, the same adapted GLSL enters Bob:

* the ordinary web graphics path receives Defold's generated GLSL ES target;
* the WebGPU adapter receives WGSL generated from Defold's optimized SPIR-V;
* Defold's shader pipeline adds a separate flipped WebGPU vertex entry point
  for offscreen render-target conventions.

This is preferable to directly shipping TypeGPU-generated WGSL because it
keeps native and browser reflection/layout behavior on the same path. It also
means browser support is bounded by Defold's selected adapter, not by TypeGPU's
runtime fallback logic.

Test, do not assume, parity for:

* clip-space depth and Y orientation;
* backbuffer versus offscreen render targets;
* front-face winding and culling;
* texture coordinate orientation;
* precision qualifiers on mobile/web;
* combined versus split texture/sampler models;
* uniform-block layout and resource binding;
* WebGL 1/GLES 2 fallback.

TypeGPU's GLSL subset uses modern constructs and integer/vector behavior that
may not cross-compile to GLES SM100. The initial feature should require
`shader.exclude_gles_sm100 = 1` unless the material proves it can pass the
legacy target. Record this as a per-material minimum profile instead of
silently producing a broken fallback.

Compute shaders are deferred. TypeGPU's current GLSL/WebGL package does not
provide a compute pipeline, while Defold compute support is itself a technical
preview and is unavailable on some adapters. A later compute phase may extend
the TypeGPU GLSL generator upstream or use a separately validated
WGSL/SPIR-V-to-GLSL route; it must not be hidden inside the vertex/fragment
adapter.

# Test and quality gates

## Compiler unit tests

* Golden TypeGPU-to-GLSL output for literals, control flow, helpers, structs,
  arrays, matrices, builtins, varyings, textures, and samplers.
* Golden adapter output for version/header insertion, uniform blocks,
  locations, resource names, and line maps.
* Reject fixtures for compute, storage resources, comparison samplers,
  unsupported builtins, ambiguous names, dynamic entry discovery, and layout
  mismatch.
* Determinism test: two clean builds produce byte-identical generated assets
  and manifests.
* Tree-shaking test: an unused helper/resource/material does not appear in any
  generated shader, runtime module, or release manifest.

## Defold compiler matrix

For every supported construct, build through pinned Bob while forcing the
relevant outputs:

* SPIR-V;
* desktop GLSL;
* GLSL ES 300;
* GLES SM100 only for explicitly compatible materials;
* HLSL;
* MSL;
* WGSL.

Snapshot the compiled `.spc` reflection and compare it to the descriptor. A
successful standalone GLSL compile is insufficient evidence because Defold's
cross-stage reconciliation and target cross-compilers are part of the
contract.

## Runtime render tests

Render deterministic reference scenes and compare images within a documented
tolerance:

* colored triangle and transformed mesh;
* textured sprite and atlas page;
* user/engine constants and matrices;
* instanced attributes;
* multiple textures;
* backbuffer and offscreen render target;
* alpha blending and discard;
* native OpenGL/Vulkan/Metal plus HTML5 WebGL and WebGPU where available.

## DX and performance gates

* Cold and incremental shader build latency.
* Cache-hit build makes no output writes.
* Diagnostic points to the TypeScript function and includes the generated
  source location.
* Watch mode invalidates transitive helper dependencies exactly once.
* Release runtime bundle contains no `typegpu`, `@typegpu/gl`, unplugin,
  parser, or shader-definition code.
* Generated runtime setters allocate no temporary objects on a steady-state
  update when caller-owned vectors/matrices or typed views are supplied.

# Phased implementation

## Phase 0: contract probe

Pin a published TypeGPU trio and build one complete paired shader graph. Verify
the current varying path, resource naming, generated declaration structure,
and a successful Defold `glslang -V` compile after the smallest possible
adapter. Deliverable: a written compatibility matrix and golden fixtures.

## Phase 1: one real material

Port Defold's built-in-style sprite material: position, UV, view-projection,
tint, and one texture. Generate `.vp`, `.fp`, and `.material`; build with Bob;
run on native and HTML5; validate offscreen Y behavior. No generated runtime
bindings yet.

## Phase 2: reflection and typed bindings

Add the explicit material descriptor, SPIR-V reflection validation, per-material
TypeScript facade, and actionable diagnostics. Prove `go`, GUI, and render
constant use separately.

## Phase 3: incremental developer workflow

Add content hashing, dependency tracking, watch mode, composable editor hook,
Bob/CI command, generated-source navigation, and release reports. The no-change
incremental path should be effectively free.

## Phase 4: coverage and profiles

Add matrices, arrays, instancing, multiple textures, atlas cases, precision
profiles, and the full target compile/render matrix. Make the GLES SM100 policy
explicit and enforce it per material.

## Phase 5: upstream hardening

Propose small TypeGPU changes only where the spike has evidence:

* a stable offline paired-stage GLSL resolve API;
* structured emitted-symbol/resource metadata;
* source-span propagation and generator range maps;
* Defold-needed GLSL dialect hooks, if they are generally useful rather than
  engine-specific.

Each contribution should be independently reviewable, reproduce one problem,
include focused tests, preserve TypeGPU's existing WebGL behavior, and avoid
mixing the Defold package into upstream.

## Phase 6: compute evaluation

Re-evaluate only after vertex/fragment support is stable and both upstreams'
compute contracts mature. Produce a separate decision record before
implementing storage buffers or compute dispatch.

# Go/no-go criteria

Proceed from the contract probe only if all of these are true:

* a paired TypeGPU shader compiles through pinned Bob without patching Defold;
* stable external names and explicit locations survive SPIR-V optimization and
  target cross-compilation;
* uniform-block adaptation has a mechanical, reflected mapping;
* TypeGPU compiler code is absent from runtime artifacts;
* a TypeGPU/Defold version change fails clearly instead of silently changing
  bindings;
* native and browser reference images agree on coordinate conventions.

If the GLSL generator requires broad or fragile rewriting, pause and pursue a
small upstream dialect/output API rather than maintaining a fork. If only
Defold-specific material metadata is missing, keep that in
`@ts-defold/typegpu`; it does not belong upstream.

[^typegpu-gl]: TypeGPU's official `@typegpu/gl` documentation and the pinned `packages/typegpu-gl` source snapshot.
[^defold-pipeline]: Defold's shader and material manuals plus `ShaderProgramBuilder` and `ShaderCompilePipeline` at the repository's pinned Defold revision.
