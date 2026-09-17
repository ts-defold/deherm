# Defold Hermes

An experimental TypeScript runtime for Defold, backed by Hermes on native
targets and the browser's JavaScript engine on HTML5.

TypeScript 7 and `ttsc` own type-checking and the compiler-plugin pass;
`@ttsc/unplugin` feeds transformed sources into esbuild for the dynamic
Hermes/browser bundle. The product target is TypeScript-owned game logic with
full generated Defold compatibility. TS-to-Lua remains a migration and
fallback target, not a requirement for the new runtime.

This repository is an architecture spike. Start with the
[knowledge base](knowledge/index.md), especially the
[implementation plan](knowledge/plan.md) and
[runtime strategy](knowledge/decisions/runtime-strategy.md).

The working developer experience is:

```sh
npm install
npm run bootstrap
npm run doctor
npm run check
npm run build
npm run verify
npm run build:release-plan
npm run check:static-hermes
npm run bench:bindings
npm run run:native
npm run run:device-dev
npm run run:web
npm run package:defold
npm run bob:version
```

`run:native` executes the bundle in embedded Hermes through JSI. `run:web`
executes that same bundle in the browser, without Hermes in Wasm. The sample
also exercises a typed `DefoldModules.getEnforcing()` lookup whose native
implementation is a zero-serialization JSI host function.

`run:device-dev` uses the matching host `hermesc` to produce bytecode and loads
it in the same runtime binary. Published development tooling must keep the
compiler and runtime revisions paired because Hermes bytecode is versioned.

Normal development uses precompiled complete bindings: edits only run the
TypeScript transform/bundle/reload loop. Direct imports such as
`@defold-hermes/sdk/ExampleMath` are tracked per function. `npm run
build:release-plan` emits `dist/sample.usage.json` from the actual tree-shaken
bundle, then creates reachable-only binding projections under
`build/profiles/release`. Importing the dynamic `DefoldModules` registry is an
explicit escape hatch that conservatively retains every binding.

## Binding compiler

`bindings/modules.json` is a validated prototype IR rather than a runtime
schema. One fast code-generation pass emits:

* TypeScript interfaces and type-inferred module lookups;
* fixed-width C ABI declarations plus `sizeof`/`offsetof` assertions;
* eager JSI module objects with direct generated host functions;
* typed Static Hermes `extern_c` imports;
* fixed Emscripten/Wasm memory layouts and typed-array codecs.

There is no Embind, JSON marshalling, reflection, or generic native dispatcher
on the scalar call path. Read the binding rationale and next type-lowering
steps in [the binding compiler decision](knowledge/decisions/binding-compiler.md).

Coverage is tracked against two upstream truths. `npm run
generate:sdk-inventory` runs Clang across every public dmSDK header; `npm run
generate:script-api-inventory` imports Defold's pinned generated Lua
annotations. At the current pin this accounts for 121 headers / 2,140 native
declarations and 40 modules / 2,734 script declarations. These are inventory
numbers, not a claim that each declaration has a finished runtime lowering.
The status of every declaration is machine-readable under
`bindings/generated/` and drift-gated by `npm run check`.

Exact upstream revisions live in `upstream.lock`; `npm run bootstrap`
materializes ignored working copies and downloads the checksum-pinned Bob JAR.
The current Defold package is an arm64 macOS proof, not yet a multi-platform
release. A real native-extension build uploads its build payload to the Defold
build service, so `npm run bob:build` and `npm run bob:bundle` require the
explicit `DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1` opt-in.
