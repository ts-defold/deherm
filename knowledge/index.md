---
okf_version: "0.2"
---

# Defold Hermes knowledge base

## Start here

* [Implementation plan](plan.md) - Phased proof-of-concept plan, acceptance criteria, and delivery boundaries.
* [Architecture](architecture.md) - Target architecture and the shared native/browser contract.
* [Tooling workflow](tooling.md) - Commands that work now, the Bob boundary, and the intended public CLI.
* [Runtime strategy](decisions/runtime-strategy.md) - Decision to use Hermes natively and the host browser VM on HTML5.
* [Native module strategy](decisions/native-modules.md) - TurboModule/Nitro compatibility direction and the module-registry proof.
* [Binding compiler](decisions/binding-compiler.md) - Direct C ABI, generated JSI/Static Hermes adapters, and fixed Emscripten memory layouts.
* [Full SDK compatibility](decisions/full-sdk-compatibility.md) - The two API surfaces, semantic overlay, ttsc role, and native extension contract.
* [API source resolution](decisions/api-source-resolution.md) - Exact engine-SHA selection, canonical Defold artifacts, extension merging, and cache integrity.
* [Semantic translation tokens](decisions/semantic-translation-tokens.md) - Provenance-preserving names, types, ABI projections, reproduced claims, and conformance states.
* [Lua compatibility backend](decisions/lua-compatibility-backend.md) - Cached stack thunks, scratch arenas, generational pools, and instance discipline for Lua-only APIs.
* [Memory and hot-path policy](decisions/memory-and-hot-path-policy.md) - Bounded lifetime tiers, allocation-free dispatch, arenas, pools, cache-local tables, and verification gates.
* [Static Hermes extension authoring](decisions/static-hermes-extension-authoring.md) - Proposed strict-TypeScript extension SDK with generated Defold lifecycle, ABI, metadata, and browser projection.
* [Hybrid TypeScript toolchain](decisions/hybrid-toolchain.md) - Lua scripts plus Hermes modules, coordinated by TypeScript 7 and ttsc.
* [Runtime profiles and reachability](decisions/runtime-profiles-and-reachability.md) - Precompiled development runtimes, release-only AOT, and cross-layer tree shaking.
* [Delivery model](decisions/delivery-model.md) - What ships as a Defold library/native extension and what would require a fork.
* [Project extension discovery](decisions/project-extension-discovery.md) - How the npm CLI discovers local and resolved extensions and decides which binding route is safe.
* [Development loop and debugging](decisions/development-loop-and-debugging.md) - ttsc-only transforms, generation-safe hot reload, Hermes CDP, VS Code, and profiling.
* [Math and shader language tools](decisions/math-and-shader-language-tools.md) - Directive-scoped operator syntax, math IR, backend selection, TypeGPU, and VS Code semantics.
* [Upstream contribution policy](upstream-contributions.md) - Evidence and quality gates for focused Static Hermes and Defold pull requests.

## Research

* [Upstream research](research/upstreams.md) - Verified repositories, revisions, capabilities, and source notes.
* [Spike results](research/spike-results.md) - Commands, observed results, and remaining verification boundary.
* [C# precedent](research/csharp-precedent.md) - How Defold implemented experimental C# extensions and what to copy.
* [dmSDK coverage](research/sdk-coverage.md) - Generated, declaration-level coverage of every public dmSDK header.
* [Script API coverage](research/script-api-coverage.md) - Generated inventory of the Lua-shaped API TypeScript game logic must replace.
* [TypeGPU shader lane](research/typegpu-shader-lane.md) - Build-time TypeGPU authoring, Defold shader adaptation, typed material bindings, and validation gates.
* [Binding compiler cookbook](examples/binding-cookbook.md) - Concrete source-to-IR-to-TypeScript examples for reviewing the public API.
* [Risks and unknowns](risks.md) - Technical risks that the spike must retire.

## History

* [Knowledge base log](log.md) - Newest-first record of material knowledge changes.
