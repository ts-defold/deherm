---
okf_version: "0.2"
---

# Defold Hermes knowledge base

## Start here

* [Implementation plan](plan.md) - Phased proof-of-concept plan, acceptance criteria, and delivery boundaries.
* [Architecture](architecture.md) - Target architecture and the shared native/browser contract.
* [Tooling workflow](tooling.md) - Commands that work now, the Bob boundary, and the intended public CLI.
* [Runtime strategy](decisions/runtime-strategy.md) - Decision to use Hermes natively and the host browser VM on HTML5.
* [Static Hermes language and polyfills](decisions/static-hermes-language-and-polyfills.md) - Sound typed release units, explicit compatibility islands, and reachable-only host polyfills.
* [HTML5 bundle and Static Wasm profiles](decisions/html5-bundle-and-static-wasm.md) - Browser-host packaging, generated Emscripten glue, and a benchmark-gated Static Hermes AOT lane.
* [Native module strategy](decisions/native-modules.md) - TurboModule/Nitro compatibility direction and the module-registry proof.
* [Binding compiler](decisions/binding-compiler.md) - Direct C ABI, generated JSI/Static Hermes adapters, and fixed Emscripten memory layouts.
* [Generator product contract](decisions/generator-product-contract.md) - One-command, deterministic, no-LLM API compilation with a zero-per-symbol-edit gate.
* [Full SDK compatibility](decisions/full-sdk-compatibility.md) - The two API surfaces, semantic overlay, ttsc role, and native extension contract.
* [API source resolution](decisions/api-source-resolution.md) - Exact engine-SHA selection, canonical Defold artifacts, extension merging, and cache integrity.
* [Semantic translation tokens](decisions/semantic-translation-tokens.md) - Provenance-preserving names, types, ABI projections, reproduced claims, and conformance states.
* [Lua compatibility backend](decisions/lua-compatibility-backend.md) - Cached stack thunks, scratch arenas, generational pools, and instance discipline for Lua-only APIs.
* [Memory and hot-path policy](decisions/memory-and-hot-path-policy.md) - Bounded lifetime tiers, allocation-free dispatch, arenas, pools, cache-local tables, and verification gates.
* [Telemetry wire format](decisions/telemetry-wire-format.md) - Fixed allocation-free producer records batched into generated protobuf/DDF for native, browser, capture, JSON, and TUI consumers.
* [Static Hermes extension authoring](decisions/static-hermes-extension-authoring.md) - Proposed strict-TypeScript extension SDK with generated Defold lifecycle, ABI, metadata, and browser projection.
* [Hybrid TypeScript toolchain](decisions/hybrid-toolchain.md) - Lua scripts plus Hermes modules, coordinated by TypeScript 7 and ttsc.
* [Runtime profiles and reachability](decisions/runtime-profiles-and-reachability.md) - Precompiled development runtimes, release-only AOT, and cross-layer tree shaking.
* [Delivery model](decisions/delivery-model.md) - What ships as a Defold library/native extension and what would require a fork.
* [Project extension discovery](decisions/project-extension-discovery.md) - How the npm CLI discovers local and resolved extensions and decides which binding route is safe.
* [TypeScript game-object components](decisions/typescript-components.md) - Generated `.script` proxies now, with a compatible native component backend later.
* [Development loop and debugging](decisions/development-loop-and-debugging.md) - ttsc-only transforms, generation-safe hot reload, Hermes CDP, VS Code, and profiling.
* [Math and shader language tools](decisions/math-and-shader-language-tools.md) - Directive-scoped operator syntax, math IR, backend selection, TypeGPU, and VS Code semantics.
* [Upstream contribution policy](upstream-contributions.md) - Evidence and quality gates for focused Static Hermes and Defold pull requests.
* [War Battles TypeScript showcase](roadmap/war-battles-showcase.md) - Post-binding-gate port and 32-player multiplayer expansion plan.

## Research

* [Upstream research](research/upstreams.md) - Verified repositories, revisions, capabilities, and source notes.
* [Spike results](research/spike-results.md) - Commands, observed results, and remaining verification boundary.
* [C# precedent](research/csharp-precedent.md) - How Defold implemented experimental C# extensions and what to copy.
* [dmSDK coverage](research/sdk-coverage.md) - Generated, declaration-level coverage of every public dmSDK header.
* [dmSDK ABI generator wave](research/dmsdk-abi-generator-wave.md) - Exact ABI-shape census, scalar and enum-value adapters, and isolated clean-room regeneration.
* [Fixed multi-result tuple lowering](research/fixed-tuple-lowering.md) - Exact positional Lua tuple ABI, public reachability limits, and unpromoted engine evidence.
* [Script API coverage](research/script-api-coverage.md) - Generated inventory of the Lua-shaped API TypeScript game logic must replace.
* [TypeGPU shader lane](research/typegpu-shader-lane.md) - Build-time TypeGPU authoring, Defold shader adaptation, typed material bindings, and validation gates.
* [React and hooks over Defold GUI](research/react-defold-gui.md) - Recommended custom React renderer, dense commit bridge, Yoga/Clay tradeoff, and Static Hermes conformance gates.
* [War Battles source audit and port map](research/war-battles-port-map.md) - Pinned tutorial and TSDefold baselines, exact API/message/property demand, proxy requirements, licensing, and runtime acceptance trace.
* [Static Hermes TS2Flow upstream fix](research/static-hermes-ts2flow-upstream.md) - Reproduction, official-test evidence, draft PR, and temporary patch policy for typed function return annotations.
* [Local Extender runtime evidence](research/local-extender-runtime-evidence.md) - Pinned macOS arm64 Bob/Extender build, bundle, runtime transcript, reproduced failures, and proof boundaries.
* [Fixed multi-result tuple lowering](research/fixed-tuple-lowering.md) - Generated exact-arity Lua tuple descriptors, copied result semantics, reachability, and proof boundary.
* [Generated URL and address frontier](research/script-url-address-generator-frontier.md) - Exact 70-route census and composite four-lane Defold URL arena foundation.
* [Generated callback lifecycle frontier](research/script-callback-lifecycle.md) - Source-pinned callback lifetime metadata and fixed-capacity ownership semantics for all 25 callback routes.
* [Script value-tail and overload waves](research/script-tail-generator-waves.md) - Exact candidate/blocker partitions and fail-closed dispatch tables for the remaining value and overload routes.
* [Hot reload and development control plane](research/hot-reload-and-dev-tui.md) - Verified Defold resource reload semantics, remote-target flow, generation-safe Hermes swapping, and the staged Rezi operator console.
* [Binding compiler cookbook](examples/binding-cookbook.md) - Concrete source-to-IR-to-TypeScript examples for reviewing the public API.
* [Risks and unknowns](risks.md) - Technical risks that the spike must retire.

## History

* [Knowledge base log](log.md) - Newest-first record of material knowledge changes.
