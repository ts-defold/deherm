<p align="center">
  <img src="docs/assets/brand/deherm-wordmark-basalt-heart.png" alt="deherm" width="960">
</p>

# déherm

> [!CAUTION]
> **Early alpha. Not ready for use.**
>
> This repository is public so its CI can publish build artifacts and its
> generated API policies can be served from GitHub Pages. That is the only
> reason it is public. It is not an announcement, a release, or an invitation
> to depend on it.
>
> Nothing here is stable: package names, the generated API surface, the policy
> URL scheme, the native artifact layout and the extension ABI all change
> without notice or migration notes. Published artifacts may be deleted or
> rebuilt with different bytes under the same tag.

> [!WARNING]
> Issues and pull requests are welcome as discussion, but there is no support,
> no release cadence, and no compatibility commitment yet. If you build
> something on this, expect to rebuild it.

An experimental TypeScript runtime for Defold, backed by Hermes on native
targets and the browser's JavaScript engine on HTML5.

TypeScript 7 owns ordinary project type-checking. The precompiled `dehermc`
host tool runs the checker-aware déherm transforms and feeds their transformed
sources into esbuild for the dynamic Hermes/browser bundle, so an installed
project does not cold-build Go tooling. The product target is TypeScript-owned
game logic with full generated Defold compatibility. TS-to-Lua remains a
migration and fallback target, not a requirement for the new runtime.

This repository is an architecture spike. Start with the
[knowledge base](.agents/docs/index.md), especially the
[implementation plan](.agents/docs/plan.md) and
[runtime strategy](.agents/docs/decisions/runtime-strategy.md).

Repository boundaries are intentional: `packages/*` contains internal product
modules that compose the single published `@ts-defold/deherm` package, while
`examples/*` contains private runnable consumers and integration fixtures.
Every first-level example is a pnpm workspace package with its own dependencies
and commands; examples are never included in the public npm artifact.

Private workspace modules use the non-published `@deherm/*` scope and resolve
directly to their canonical raw sources through the root TypeScript path map.
The npm-facing scope remains `@ts-defold/deherm`; the two namespaces are
deliberately independent. `@deherm/project` is reserved for each generated,
context-filtered Defold project SDK rather than a repository package.

The working developer experience is:

```sh
pnpm install
pnpm bootstrap
pnpm doctor
pnpm check
pnpm build
pnpm verify
pnpm build:release-plan
pnpm check:static-hermes
pnpm bench:bindings
pnpm run:native
pnpm run:device-dev
pnpm run:web
pnpm package:defold
pnpm bob:version
pnpm bob:web:bundle
pnpm test:native-defold:runtime
pnpm test:native-defold:hot-reload
pnpm test:static-hermes
pnpm test:conformance
pnpm cli
pnpm cli -- doctor --project defold
pnpm cli -- extensions --project defold
pnpm cli -- generate --project defold
pnpm cli -- verify-generated --project defold
pnpm cli -- materialize-dmsdk --usage defold/deherm.dmsdk.json --output defold/generated/dmsdk-provider.cpp
```

## Project CLI

The npm package exposes a `deherm` binary. Its first vertical slice
discovers native extensions already present in a Defold project, including
Bob-resolved library ZIPs, and generates a stable inventory, declarations,
executable TypeScript SDK modules, a TypeScript 7 project, and non-destructive
VS Code setup from extension `.script_api` metadata:

```sh
pnpm add -D @ts-defold/deherm
pnpm exec deherm
pnpm exec deherm doctor
pnpm exec deherm extensions
pnpm exec deherm generate
pnpm exec deherm assemble-typed-native --target arm64-macos
pnpm exec deherm verify-generated
```

The npm package does not bundle platform-specific Hermes libraries or their
generated target config. Native builds select one Defold bundle target from the
generated project lock, fetch that target's GitHub Release archive on first
use, and reuse it from the platform-native per-user déherm cache. The archive
keeps the release library, debugger library, and `libhermesvm-config.h` from the
same build together. HTML5 uses the packaged browser-host source adapter and
does not download Hermes Wasm. Host executables (`hermesc`, `shermes`, and
`dehermc`) follow the same rule: fetch the current host's release archives on
first use and reuse the verified user cache.

Running `deherm` without arguments launches the project/scaffold TUI. The
package has not been published yet; use `pnpm cli -- ...` in this checkout
until the first release. Public C/C++ headers are included in the
inventory, but direct native bindings are intentionally marked as requiring a
versioned ABI and lifetime schema rather than being guessed from syntax alone.
The generator writes a normalized `bindings.ir.json`; both declarations and
executable SDK modules consume that IR, including collision-checked camelCase
names and per-target lowering status.
`verify-generated` is the explicit slow integrity path: it hashes copied IR,
validates the canonical plan, and checks package, manifest, and lock identities.
The generated checker transform is active for release reachability and the
development bundle. Both paths resolve the authenticated, precompiled
`dehermc` for the user's host; ordinary TypeScript 7 checking still runs first
for the generated script-context projects.

`run:native` executes the bundle in embedded Hermes through JSI. `run:web`
executes that same bundle in the browser, without Hermes in Wasm. The sample
also exercises a typed `DefoldModules.getEnforcing()` lookup whose native
implementation is a zero-serialization JSI host function.

`bob:web:bundle` builds the actual Defold `wasm-web` game against local
Extender. It first emits an IIFE application bundle through `dehermc` and esbuild,
then stores it as the typed `/deherm/app.dehermc` resource in the game archive. Extender
automatically links the generated module adapter and hand-written host library under the extension's `lib/web`
directory as Emscripten JavaScript libraries. The HTML5 extension loads the
archived application and runs it in the browser VM; no Hermes library is added
to the default web build. See the [HTML5 bundle decision](.agents/docs/decisions/html5-bundle-and-static-wasm.md)
for the production loader, development reload, and optional Static Hermes AOT
profile.

Bob archives whatever `/deherm/app.dehermc` is on disk and relates it to
nothing, so `deherm verify-bundle` compares that artifact against the sources
`deherm.lock` records it was built from and names both fingerprints when they
disagree. It is a hash comparison rather than a rebuild, runs before Bob in
`scripts/bob.sh`, and needs no network - a build server that only ever runs Bob
against committed artifacts is checked the same way as a machine that runs
déherm itself.

`run:device-dev` uses the matching host `hermesc` to produce bytecode and loads
it in the same runtime binary. Published development tooling must keep the
compiler and runtime revisions paired because Hermes bytecode is versioned.

Normal development uses precompiled complete bindings: edits only run the
TypeScript transform/bundle/reload loop. Direct imports such as
`@deherm/sdk/ExampleMath` are tracked per function. `pnpm
build:release-plan` emits `dist/sample.usage.json` from the actual tree-shaken
bundle, then creates reachable-only binding projections under
`build/profiles/release`. Importing the dynamic `DefoldModules` registry is an
explicit escape hatch that conservatively retains every binding.

## Binding compiler

`packages/bindings/modules.json` is a validated prototype IR rather than a runtime
schema. One fast code-generation pass emits:

* TypeScript interfaces and type-inferred module lookups;
* fixed-width C ABI declarations plus `sizeof`/`offsetof` assertions;
* eager JSI module objects with direct generated host functions;
* typed Static Hermes `extern_c` imports;
* fixed Emscripten/Wasm memory layouts and typed-array codecs.

There is no Embind, JSON marshalling, reflection, or generic native dispatcher
on the scalar call path. Read the binding rationale and next type-lowering
steps in [the binding compiler decision](.agents/docs/decisions/binding-compiler.md).

Coverage is tracked against two upstream truths. `pnpm
generate:sdk-inventory` runs Clang across every public dmSDK header; `pnpm
generate:script-api-inventory` imports Defold's pinned generated Lua
annotations. At the current pin this accounts for 121 headers / 2,141 native
declarations and 40 modules / 2,734 script declarations. These are inventory
numbers, not a claim that each declaration has a finished runtime lowering.
The status of every declaration is machine-readable under
`packages/bindings/generated/` and drift-gated by `pnpm check`.

The current generated execution floor is also machine-readable: all 926 script
functions and 2,141 dmSDK declarations compile as TypeScript types. One bounded
universal value-graph ABI covers all 915 stable-ID script routes and composes
with the specialized scalar, value, tuple, URL, handle, overload, and callback
families. The canonical plan currently emits 911 profile-available routes for
Dynamic Hermes, the Lua compatibility bridge, and the browser host; the
Static Hermes typed-native transport emits the 325 routes that cross no Lua
closure, no retained engine handle, and only Defold value records whose fixed
layout is derived from the pinned dmSDK headers.
The two `luasocket` routes that manufacture captured Lua closures fail closed.

Every one of the 1,361 runtime dmSDK declarations has a deterministic universal
recipe and stable ID. Release checking resolves every authored call to its
exact recipe. `deherm materialize-dmsdk` currently turns the 486
declaration-only universal-ready shapes into tree-shakeable C++ thunks; the
other 875 remain visible and receive source-located specialization diagnostics
instead of being silently omitted. It reads the revision-matched catalog materialized at
`.deherm/ir/dmsdk-universal-bindings.json`; `--catalog` can name that policy
document explicitly. The package ships the catalog-free algorithm, not a
Defold-version catalog. This is a complete generation path, not a claim that all
native engine implementations have already been linked and behavior-tested.
The native exact-call census compiles, links, and executes all 486 ready wrappers
against generated recording callees, including target-dependent pointer/integer
handles; that verifies the bridge contract, not Defold implementation semantics.
The pinned arm64 macOS Defold engine currently proves selected generated calls,
a packaged TypeScript GUI component, and a transactional Dynamic-Hermes
reject/retain/recover reload; unobserved plan rows remain unproven.

Exact upstream revisions live in `upstream.lock`; `pnpm bootstrap`
materializes ignored working copies and downloads the checksum-pinned Bob JAR.
The current Defold package is an arm64 macOS proof, not yet a multi-platform
release. A real native-extension build uploads its build payload to the Defold
build service, so `pnpm bob:build` and `pnpm bob:bundle` require the
explicit `DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1` opt-in.
