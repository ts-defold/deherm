<p align="center">
  <img src="docs/assets/brand/deherm-wordmark-basalt-heart.png" alt="deherm" width="960">
</p>

# déherm

An experimental TypeScript runtime for Defold, backed by Hermes on native
targets and the browser's JavaScript engine on HTML5.

TypeScript 7 and `ttsc` own type-checking and the compiler-plugin pass;
`@ttsc/unplugin` feeds transformed sources into esbuild for the dynamic
Hermes/browser bundle. The product target is TypeScript-owned game logic with
full generated Defold compatibility. TS-to-Lua remains a migration and
fallback target, not a requirement for the new runtime.

This repository is an architecture spike. Start with the
[knowledge base](.agents/docs/index.md), especially the
[implementation plan](.agents/docs/plan.md) and
[runtime strategy](.agents/docs/decisions/runtime-strategy.md).

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
npm run bob:web:bundle
npm run test:native-defold:runtime
npm run test:native-defold:hot-reload
npm run test:static-hermes
npm run test:conformance
npm run cli -- doctor --project defold
npm run cli -- extensions --project defold
npm run cli -- generate --project defold
npm run cli -- verify-generated --project defold
```

## Project CLI

The npm package exposes a `deherm` binary. Its first vertical slice
discovers native extensions already present in a Defold project, including
Bob-resolved library ZIPs, and generates a stable inventory, declarations,
executable TypeScript SDK modules, a TypeScript 7 project, and non-destructive
VS Code setup from extension `.script_api` metadata:

```sh
npm install --save-dev @ts-defold/deherm
npx deherm doctor
npx deherm extensions
npx deherm generate
npx deherm verify-generated
```

The package has not been published yet; use `npm run cli -- ...` in this
checkout until the first release. Public C/C++ headers are included in the
inventory, but direct native bindings are intentionally marked as requiring a
versioned ABI and lifetime schema rather than being guessed from syntax alone.
The generator writes a normalized `bindings.ir.json`; both declarations and
executable SDK modules consume that IR, including collision-checked camelCase
names and per-target lowering status.
`verify-generated` is the explicit slow integrity path: it hashes copied IR,
validates the canonical plan, and checks package, manifest, and lock identities.
The generated ttsc transform entry is present but disabled until that transform
ships; ordinary TypeScript 7 checking works now.

`run:native` executes the bundle in embedded Hermes through JSI. `run:web`
executes that same bundle in the browser, without Hermes in Wasm. The sample
also exercises a typed `DefoldModules.getEnforcing()` lookup whose native
implementation is a zero-serialization JSI host function.

`bob:web:bundle` builds the actual Defold `wasm-web` game against local
Extender. It first emits an IIFE application bundle through ttsc and esbuild,
then stores it as the typed `/deherm/app.dehermc` resource in the game archive. Extender
automatically links the generated module adapter and hand-written host library under the extension's `lib/web`
directory as Emscripten JavaScript libraries. The HTML5 extension loads the
archived application and runs it in the browser VM; no Hermes library is added
to the default web build. See the [HTML5 bundle decision](.agents/docs/decisions/html5-bundle-and-static-wasm.md)
for the production loader, development reload, and optional Static Hermes AOT
profile.

`run:device-dev` uses the matching host `hermesc` to produce bytecode and loads
it in the same runtime binary. Published development tooling must keep the
compiler and runtime revisions paired because Hermes bytecode is versioned.

Normal development uses precompiled complete bindings: edits only run the
TypeScript transform/bundle/reload loop. Direct imports such as
`@deherm/sdk/ExampleMath` are tracked per function. `npm run
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
steps in [the binding compiler decision](.agents/docs/decisions/binding-compiler.md).

Coverage is tracked against two upstream truths. `npm run
generate:sdk-inventory` runs Clang across every public dmSDK header; `npm run
generate:script-api-inventory` imports Defold's pinned generated Lua
annotations. At the current pin this accounts for 121 headers / 2,140 native
declarations and 40 modules / 2,734 script declarations. These are inventory
numbers, not a claim that each declaration has a finished runtime lowering.
The status of every declaration is machine-readable under
`bindings/generated/` and drift-gated by `npm run check`.

The current generated execution floor is also machine-readable: all 926 script
functions and 2,140 dmSDK declarations compile as TypeScript types; 93 script
calls (90 generic scalar dispatchers plus 3 specialized timer calls) and 26
scalar dmSDK thunks have runtime adapters. Per-function target behavior remains
a separate conformance gate. The pinned arm64 macOS Defold engine currently
proves 14 generated calls across 12 unique script bindings and a transactional
dynamic-Hermes reject/retain/recover reload; it does not prove the remaining API
by association.

Exact upstream revisions live in `upstream.lock`; `npm run bootstrap`
materializes ignored working copies and downloads the checksum-pinned Bob JAR.
The current Defold package is an arm64 macOS proof, not yet a multi-platform
release. A real native-extension build uploads its build payload to the Defold
build service, so `npm run bob:build` and `npm run bob:bundle` require the
explicit `DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1` opt-in.
