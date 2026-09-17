---
type: Implementation Plan
title: Defold Hermes implementation plan
description: Phased plan for a TypeScript-to-Hermes native runtime and browser-native HTML5 bridge.
tags: [defold, hermes, typescript, spike]
status: active
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-extensions
    resource: https://defold.com/manuals/extensions/
    title: Writing native extensions for Defold
    author: team:defold
  - id: hermes
    resource: https://github.com/facebook/hermes/tree/static_h
    title: Hermes static_h branch
    author: team:meta-hermes
---

# Outcome

Deliver a TypeScript game-logic runtime with generated, measurable compatibility
for the complete Defold script API and public dmSDK:

1. macOS native: TypeScript is bundled to JavaScript and executed by an
   embedded Hermes runtime.
2. HTML5: the same bundle executes in the browser and crosses an Emscripten
   bridge into Defold; Hermes is not compiled into Wasm.

The delivery remains a normal native extension as long as Defold's extension
resource/component registration seams are sufficient. The target is not merely
an extension API callable from Lua: TypeScript must own game lifecycle and game
logic. A fork is reserved for editor-native `.ts` assets or an engine seam that
cannot be supplied by a custom component/resource type.

Defold's C# code is build/link and FFI precedent only. Its configuration is
currently disabled and its runtime test registers C# functions into Lua; it
does not replace Defold script components.

# Definition of done for the spike

* `npm run check` type-checks the sample and bridge implementation.
* `npm run build` emits one deterministic JavaScript bundle from TypeScript.
* `npm run run:native` executes that bundle in an embedded Hermes runtime,
  calls `init`, several `update` ticks, and `final`, and proves a native host
  call reaches TypeScript and returns a typed value.
* `npm run run:web` serves a browser harness that executes the same bundle
  through the browser adapter without embedding Hermes in Wasm.
* The same typed module lookup invokes a JSI host function natively and a
  browser-backed implementation on HTML5.
* A Defold native-extension package skeleton demonstrates where the runtime,
  assets, generated declarations, and platform libraries belong.
* CI-friendly tests verify lifecycle ordering, error propagation, and adapter
  parity without requiring the Defold editor.
* Reproducible upstream pins and bootstrap commands are documented.
* Development profiles use precompiled complete bindings with no native work
  in the edit loop; a release profile emits and consumes an exact symbol-usage
  manifest.

# Definition of full SDK compatibility

* Every public `dmsdk/**/*.h(pp)` declaration is in a versioned Clang-derived
  inventory and has a generated lowering or an explicit blocking policy.
* Every function/type/constant in Defold's generated Lua annotations is in a
  second inventory and mapped through a reviewed semantic overlay.
* Type generation, native compilation, linking, and runtime conformance are
  reported separately; inventory coverage is never presented as runtime
  completion.
* Static Hermes, dynamic Hermes/JSI, and HTML5/browser adapters are generated
  from the same target-neutral IR.
* A native-extension module can contribute its own schema and generated thunks.
* After those gates pass, an official Defold example game is ported with no
  gameplay Lua as the application-level acceptance test.

# Phases

## Phase 0 - Evidence and reproducibility

1. Verify whether `tmikov/hermes-preview` exists.
2. Otherwise pin Meta's latest `static_h`; also record `main` and Tzvetan
   Mikov's current fork for comparison.
3. Pin Defold's latest `dev` revision.
4. Materialize ignored, shallow upstream checkouts from `upstream.lock`.
5. Record build prerequisites and upstream licenses.

Exit: another contributor can retrieve the exact sources without committing
multi-gigabyte upstream trees.

## Phase 1 - Contract-first TypeScript SDK

1. Define a small, versioned host contract: `log`, `now`, and one message
   round trip are enough for the vertical slice.
2. Define lifecycle hooks: `init`, `update(dt)`, `onMessage(message)`, and
   `final`.
3. Generate or share TypeScript types across both adapters.
4. Run TypeScript 7 through `ttsc`; feed its plugin pass into the bundler.
5. Bundle with source maps and preserve a stable virtual source URL for
   actionable stack traces.
6. Emit one versioned used-symbol manifest per entrypoint from retained
   generated ESM inputs; treat dynamic registry access conservatively.

Exit: the sample is runtime-agnostic and passes adapter contract tests.

## Phase 2 - Native Hermes host

1. Build a lean Hermes runtime for the local macOS architecture.
2. Embed Hermes through JSI in a small C++ host executable.
3. Install the versioned host object and load the emitted bundle.
4. Drive lifecycle hooks from native code and normalize JS exceptions into
   file/line/stack diagnostics.
5. Decide whether bytecode precompilation materially improves packaging and
   startup for the extension.

Exit: `npm run run:native` is a real embedded-Hermes execution, not Node or a
mock interpreter.

## Phase 3 - Defold extension seam

1. Wrap the proven host in Defold extension lifecycle callbacks.
2. Package JS/bytecode as an extension resource and register per-world or
   singleton runtime ownership explicitly.
3. Initially bridge values with a deliberately small typed surface; avoid
   exposing Lua implementation details as the public TypeScript API.
4. Add a sample Defold project whose Lua bootstrap only starts the TypeScript
   runtime. Expand toward direct engine APIs after the lifecycle is reliable.
5. Document the platform-library build matrix and build-server constraints.
6. Discover local and Bob-resolved third-party extensions from the npm CLI;
   generate project types from `.script_api` and inventory headers requiring a
   direct-native binding schema.

Exit: a Defold application can call the sample TypeScript lifecycle on macOS.

Current boundary: the extension sources compile against the pinned Defold SDK
headers and its packaged Hermes archive links independently. Bob submitted a
real payload to the public Extender service, which rejected the newer pinned
development SDK's `r8Cmd` platform property before our compiler ran. The next
engine boundary is a matching local Extender (or a cloud-compatible stable SDK
pin), followed by launching the resulting application.

## Phase 4 - HTML5/browser adapter

1. Load the same application bundle from the generated HTML shell.
2. Implement the contract using Emscripten exports/imports and Defold's web
   native-extension JavaScript support.
3. Establish readiness and shutdown handshakes so browser JS cannot race the
   Wasm engine.
4. Run the parity suite in a real browser.

Exit: native and HTML5 emit the same observable lifecycle transcript.

## Phase 5 - Full API compiler and Static Hermes

1. Import all public dmSDK headers with Clang and all public script annotations
   from Defold's pinned ref-doc archive.
2. Generate a canonical IR and fail CI on unaccounted additions or removals.
3. Add explicit lowering policies for handles, records, strings, spans,
   callbacks, ownership, threads, userdata, multiple returns, and platform
   gates.
4. Compile and link every generated platform surface, including Static Hermes
   `extern_c`, dynamic JSI, and raw Emscripten exports.
5. Generate release adapters from the manifest's complete dependency closure;
   split native code into dead-strippable sections and verify omitted symbols
   in final binaries.
6. Prototype generated native modules behind the module registry, borrowing
   TurboModule lookup semantics and Nitro's static JSI-binding approach without
   importing React Native lifecycle/autolinking dependencies.
7. Evaluate hot reload, debugging, multiple worlds, GC/thread affinity,
   promises, async Defold messages, and mobile/desktop cross-compilation.
8. Only then evaluate first-class `.ts` script resources/editor integration
   inside the Defold engine.

At every compiler and engine phase, reduce genuine upstream failures and apply
the [upstream contribution policy](upstream-contributions.md). Focused fixes
with regression tests should be proposed upstream instead of accumulating a
private patch stack.

## Phase 6 - Game-logic compatibility and conformance

1. Generate the entire ergonomic `defold.script.*` API and semantic overlay.
2. Drive init/update/final, messages, input, reload, GUI, render, and properties
   from TypeScript-owned component instances.
3. Keep TS-to-Lua available as a migration/fallback target, not as a requirement
   for new TypeScript game logic.
4. Use `ttsc` for target transforms, direct-intrinsic rewriting, used-symbol
   manifests, and Static Hermes subset diagnostics.
5. Run differential tests against Lua behavior.
6. Port an official Defold example game only after generated bindings compile
   and link with no unclassified public declarations.

# Non-goals of the first slice

* Replacing Lua across the engine.
* Claiming arbitrary TypeScript compiles directly with Static Hermes.
* Running Hermes inside the HTML5 Wasm module.
* Hiding the cost and maintenance implications of carrying a VM.

# Verification gates

Every phase must update [risks](risks.md) and the [knowledge log](log.md).
Claims based only on docs remain unverified; build/test results may receive a
`process:` verification entry once the corresponding command is reproducible.

[^defold-extensions]: Defold native-extension documentation.
[^hermes]: Meta Hermes `static_h` source and build definitions.
