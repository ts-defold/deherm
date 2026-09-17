# Defold Hermes knowledge log

## 2026-09-17

* **API examples**: Added a binding cookbook with a per-symbol state machine and worked scalar, current-instance, callback, URL/hash, engine-handle, and third-party-extension designs for API review.
* **Developer runtime**: Chose a Babel-free ttsc transform pipeline, transactional runtime-generation hot reload, and a shared VS Code/CDP debugger-profiler direction for native Hermes and HTML5.
* **Project IR**: Normalized extension `.script_api` declarations into stable symbol/type/lowering IR; both generated declarations and executable camelCase TypeScript SDK modules now consume it.
* **Editor setup**: Project generation now creates a TypeScript 7 configuration and non-destructive VS Code recommendations/settings, preserving any existing root project/editor files.
* **Project CLI**: Added an npm-installable `defold-hermes` binary with project discovery, extension inventory, project diagnostics, and deterministic TypeScript generation from extension `.script_api` metadata.
* **Extension inputs**: Discover local and Bob-resolved native extensions, public headers, `src`/`commonsrc` implementation files, and native-schema gaps; sanitize credentials and signed parameters from recorded dependency URLs.
* **Package verification**: Packed `@ts-defold/hermes`, installed it into a clean npm project, invoked its installed binary against the sample project, and upgraded the archive/YAML parsers to releases with zero reported advisories.
* **Bob integration**: Reached the public Extender service with a valid extension payload; the build stopped before our compiler invocation because the pinned Defold dev SDK's `r8Cmd` platform schema is newer than the deployed service. A matching local Extender or stable cloud-compatible SDK pin is required for that final boundary.
* **Bob tooling**: Pinned and checksum-verified Bob 1.14.0 at the exact Defold revision, added a local toolchain doctor, and added explicit build/bundle commands guarded by consent before uploading native-extension inputs to a build server.
* **Review hardening**: Corrected browser timer trigger/elapsed parity, bounded and generation-isolated the HTML5 callback pool, removed callback-dispatch handle allocations, made native/browser finalization release roots after exceptions, and generated rollback for partially acquired multi-callback bindings.
* **Developer workflow**: Documented the current source, bytecode, browser, release-planning, and extension-packaging commands; separated them from the future public CLI and identified pinned Bob build/launch as the next tooling boundary.
* **TypeGPU**: Designed a build-time-only TypeGPU shader lane that emits Defold-owned shader/material assets and typed bindings while retaining Bob, glslang, SPIR-V reflection, and target cross-compilation as the authority.
* **Lua callbacks**: Generated the complete `timer.delay` callback path across Hermes JSI, the C ABI, cached Lua thunks, and deterministic one-shot/repeating release, backed by fixed-capacity callback and timer pools.
* **Lua performance**: Measured one million cached primitive calls at roughly 0.18–0.21 microseconds/call and 100,000 callback dispatches at roughly 0.39–0.43 microseconds/call with zero steady-state Lua allocator calls on local arm64 macOS release builds.
* **Sanitizers**: Ran the Lua bridge unit/benchmark and Hermes-to-Lua callback executable under AddressSanitizer plus UndefinedBehaviorSanitizer with no findings.
* **Lua backend**: Added cached generated `timer.cancel`/`timer.trigger` stack thunks, a gameplay-free instance bootstrap, fixed-capacity SoA generational handles, a no-fallback scratch arena, deferred release queueing, stack/error checks, and a pinned Defold Lua benchmark harness.
* **Profiles**: Made `dev`, `device-dev`, and `release` explicit: source-evaluated dynamic Hermes, host-produced bytecode, and reachable-only Static Hermes AOT respectively; native compilation is outside the edit loop.
* **Bytecode**: Added a matched-host `hermesc` device-development path and a lifecycle test that runs `.hbc` in the same precompiled dynamic runtime.
* **Tree shaking**: Added per-function generated ESM inputs, per-entrypoint symbol manifests derived from actual esbuild retention, conservative dynamic-registry detection, and usage-filtered binding generation.
* **Upstreaming**: Established evidence, reduction, regression-test, scope, and verification gates for Static Hermes and Defold PRs; no compiler defect has been found in the scalar `extern_c` slice.
* **Toolchain**: Pinned TypeScript 7.0.2 and matching `ttsc`/`@ttsc/unplugin` 0.30.4; routed the esbuild bundle through the TypeScript-Go plugin pass.
* **Architecture**: Adopted a hybrid model: TS-to-Lua for Defold script components, Hermes/browser for JavaScript modules, and generated bindings between them.
* **FFI**: Moved the typed module proof behind an `extern "C"` function used by native JSI and referenced by the Defold HTML5 Emscripten library.
* **Codegen**: Added a checked module schema that generates matching TypeScript and C ABI declarations.
* **Shaders**: Added Defold's GLSL/SPIR-V asset pipeline as a separate GPU lane in the architecture diagram.
* **Delivery**: Chose a Defold library/native extension as the shippable form; reserved a fork for first-class editor/resource/debugger integration.
* **Research**: Documented Defold's C# NativeAOT precedent and Hermes/Static Hermes Emscripten options.
* **Verification**: Built and ran the shared TypeScript bundle in embedded Hermes and in a real browser; both completed the same lifecycle transcript.
* **Modules**: Added a TurboModule/Nitro-shaped typed registry proof with a direct Hermes JSI host function and browser counterpart.
* **Packaging**: Produced an arm64 macOS combined Hermes archive and staged the extension headers; syntax-checked the Defold extension for macOS and HTML5.
* **Tooling**: Added an OKF structural check to the standard type-check command.
* **Initialization**: Created the OKF v0.2 bundle.
* **Research**: Recorded that the proposed `tmikov/hermes-preview` repository is not yet public and selected Meta `static_h` as the baseline.
* **Decision**: Proposed Hermes for native targets and the existing browser JavaScript VM for HTML5.
* **Plan**: Defined a contract-first native/browser vertical slice and deferred first-class Defold script components.
