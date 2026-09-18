---
type: Tooling Guide
title: Build, run, and packaging workflow
description: Current spike commands and the intended one-command Defold Hermes developer experience.
tags: [defold, hermes, typescript, tooling, dx]
status: active
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
---

# Toolchain

The repository currently expects Node.js, CMake, Ninja, a C/C++ compiler, and
JDK 25. Defold's current source-build instructions specify JDK 25. On this
machine Homebrew OpenJDK 25 is installed at:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
```

Hermes and Defold source revisions are pinned in `upstream.lock`. The first
checkout setup is:

```sh
pnpm install
pnpm bootstrap
pnpm doctor
pnpm check
```

`bootstrap` is a toolchain/materialization operation. It is not part of the
ordinary edit loop.

# Commands that work now

| Intent | Command | Result |
| --- | --- | --- |
| Launch the project/scaffold TUI | `pnpm cli` | Discovers projects; starts dev, doctor, or scaffolding |
| Run the War Battles edit loop | `pnpm --filter @deherm/example-war-battles-online dev` | Rezi console; press `p` to launch/stop the built engine |
| Validate generated sources, inventories, types, and OKF | `pnpm check` | No native rebuild |
| Inspect a Defold project | `pnpm cli -- doctor --project <path>` | Finds local and resolved extensions |
| List extension binding inputs | `pnpm cli -- extensions --project <path>` | Reports script API, headers, and schema gaps |
| Generate a native C extension API | `pnpm cli -- generate-extension-api --header <header> --module <prefix> --output <dir>` | Writes Clang-derived IR, TypeScript, and universal-cell C++ glue; exits 2 when explicit layout blockers remain |
| Generate a project SDK | `pnpm cli -- generate --project <path>` | Writes types, executable TS modules, tsconfig, and VS Code setup |
| Bundle TypeScript | `pnpm build:js` | `dist/sample.js` plus its symbol-usage manifest |
| Build the standalone embedded-Hermes runner | `pnpm build:native` | Native test runner, not a Defold game |
| Compile and run JS source in Hermes | `pnpm run:native` | Fast source-interpreter development proof |
| Compile and run matched Hermes bytecode | `pnpm run:device-dev` | `hermesc` produces `dist/sample.hbc` |
| Run the browser-host contract | `pnpm run:web` | Local URL using the browser VM, not Hermes Wasm |
| Generate reachable-only release bindings | `pnpm build:release-plan` | Filtered artifacts under `build/profiles/release` |
| Check Static Hermes declarations/export unit | `pnpm check:static-hermes` | Parses `extern_c` and proves a library-shaped exported unit without `main` |
| Exercise the cached Lua bridge | `pnpm test:lua-hermes` | Hermes -> JSI -> C ABI -> Lua -> callback |
| Stage the native extension | `pnpm package:defold` | Defold package directory/archive inputs |
| Prepare pinned local Extender | `pnpm extender:prepare` | Builds the pinned jars and maps the installed Xcode SDK |
| Start/inspect local Extender | `pnpm extender:start`; `pnpm extender:status`; `pnpm extender:logs` | Standalone macOS service on port 9010 |
| Compile the real Defold project | `pnpm bob:local:build` | Starts a temporary pinned Extender when needed, then builds with Bob |
| Produce a desktop app bundle | `pnpm bob:local:bundle` | Writes `build/bundle/Defold Hermes Spike.app` |
| Prove the bundled native runtime | `pnpm test:native-defold:runtime` | Rejects stale archives, launches the app, and checks real Hermes, Lua-API, and update-lifecycle markers |
| Run headless contract conformance | `pnpm test:headless-conformance:runtime` | Generates per-contract fixtures, compiles content with Bob, links the in-process headless engine driver, and records contract -> observed/mismatched/unreachable |
| Build/bundle the HTML5 game | `pnpm bob:web:build`; `pnpm bob:web:bundle` | Uses pinned emsdk 4.0.6 through local Extender |
| Verify a running HTML5 bundle | `pnpm test:html5:runtime` | Reload-synchronized CDP lifecycle and binding proof |
| Reuse a running local Extender | `pnpm bob:build`; `pnpm bob:bundle` | Local port 9010 is the default |
| Measure binding-transport cost | `pnpm bench:transports` | Raw Lua, lua-stack, c-abi-native, typed-native, all uninstrumented |
| Measure with telemetry on | `pnpm bench:transports:profiled` | Same binary with `DEHERM_PROFILE=ON`; also drains the telemetry ring |
| Prove the telemetry compiles out | `pnpm test:profile-compile-out` | Builds both ways and reads the artifacts with `nm` and `strings` |

`build:release-plan` emits canonical route glue under
`build/profiles/release/canonical/<target>/`. For a native Dynamic-Hermes
consumer, configure CMake with
`-DDEHERM_CANONICAL_RELEASE_DIR=<absolute release root>/canonical/dynamicHermesJsi`.
The generated `sources.cmake` is then linked into `defold-hermes-runtime`, and
the JSI bridge rejects routes absent from the release registry. Static-Hermes
and browser/Wasm currently produce reject-all registries plus
`requirements.json`; those files are blocker evidence, not executable binding
claims. Existing Lua-family implementation objects remain coarse-grained and
are not yet proven dead-stripped.

`DEHERM_PROFILE` is a build-time CMake option, OFF by default, that turns on
generated timing spans at every binding transport boundary and a bounded
allocation-free producer ring for the samples. It is independent of `NDEBUG`, so
a Release build can be benchmarked; Defold's own `DM_PROFILE` is unconditionally
null under `NDEBUG` and cannot be. Measured figures and their evidence boundary
are in `.agents/docs/research/transport-overhead-measurement.md`.

The strongest local verification is one command:

```sh
pnpm verify
```

`pnpm test` remains the faster generator/type/browser loop. `verify` additionally
builds and runs native Hermes source and bytecode, the Lua bridge, Static Hermes
parsing, extension syntax checks, and Defold extension packaging.

# Local Bob and Extender

Pinned Bob is downloaded and checksum-verified by `pnpm bootstrap:bob`.
Pinned Extender is checked out from `upstream.lock`. On macOS, the one-command
paths prepare its jars, detect the installed Xcode SDK/clang/Swift ABI, create
repo-local SDK links, start Extender for the duration of the build, and stop it:

```sh
pnpm bob:local:build
pnpm bob:local:bundle
```

For a persistent edit loop, run `pnpm extender:start` once and then use
`pnpm bob:build` or `pnpm bob:bundle`. `pnpm extender:foreground` is
the inspectable foreground form. The current proofs cover arm64 macOS and
`wasm-web`; other native target toolchains still need their Extender builders.

Because this project includes a native extension, a non-local build server
receives extension sources and packaged libraries. Localhost is the default and
does not require an upload opt-in. A remote server is deliberately explicit:

```sh
DEFOLD_HERMES_BUILD_SERVER=https://build.defold.com \
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 pnpm bob:build
```

Google Cloud CLI is only needed if a developer chooses Defold's Docker setup
and must authenticate to its Google Artifact Registry. It is not part of
deherm, Bob, Hermes, or the standalone macOS path.

The validated macOS path now:

1. verify JDK 25 and all native toolchain prerequisites;
2. includes generated JavaScript with Defold `custom_resources`;
3. report extension build logs without hiding the failing compiler command;
4. links a custom engine exporting `_defold_hermes`;
5. bundles and launches the app through embedded Hermes.

The runtime smoke emitted `init:hermes` and `module:42`. Full platform support,
automated launch/termination, and the complete generated API remain separate
work; a successful custom-engine link does not imply complete API coverage.

# Published npm CLI

The npm package now exposes project inspection and generation:

```sh
pnpm exec deherm
pnpm exec deherm create my-game --name "My Game"
pnpm exec deherm doctor
pnpm exec deherm extensions
pnpm exec deherm generate
pnpm exec deherm materialize-dmsdk --usage deherm.dmsdk.json --output generated/dmsdk-provider.cpp
pnpm exec deherm typecheck
pnpm exec deherm verify-generated
```

These are the installed-package commands verified from a local tarball. The
package name is not published yet; in this checkout use `pnpm cli --` before
the command and options. No arguments launches the TUI; `create` works before
any `game.project` exists.

`generate` reads local extensions and Bob-resolved ZIPs, then writes:

```text
.deherm/extensions.json       sanitized deterministic inventory
.deherm/bindings.ir.json      normalized symbol/type/lowering IR
.deherm/extensions.d.ts       extension interfaces
.deherm/ir/**                 pinned complete API inputs, universal catalogs, and lowering plan
.deherm/ir/binding-lowering-plan.sentinel.json  plan/generator authority
.deherm/sdk/**                executable TypeScript compatibility SDK
.deherm/sdk/contexts/**       context-filtered SDK entrypoints
.deherm/script-contexts.json  generated 926-route context projection
.deherm/manifest.json         package/input/profile identities
deherm.lock                   project-side copy of the generation contract
tsconfig.deherm.base.json     shared TS 7 + future ttsc configuration
tsconfig.deherm.shared.json   ordinary context-free `*.ts`
tsconfig.deherm.game-object.json  game-object `*.script.ts`
tsconfig.deherm.gui.json      GUI `*.gui.ts`
tsconfig.deherm.render.json   render `*.render.ts`
tsconfig.deherm.bundle.json   unfiltered runtime SDK used only to compose mixed-context bundles
tsconfig.deherm.json          solution referencing all four contexts
tsconfig.json                        created only when the project has none
.vscode/extensions.json              created only when absent
.vscode/settings.json                created only when absent
```

Existing root `tsconfig.json` and VS Code files are never overwritten. Run
`npx deherm typecheck` regardless of an existing root configuration: it invokes
the generated solution with the package's local TypeScript compiler and checks
all four source contexts. `gui.*` is absent outside `*.gui.ts`; `render.*` is
absent outside `*.render.ts`; known game-object-only members are removed from
the other entrypoints. The 347 routes whose canonical context contract remains
unresolved are explicitly recorded as provisional and remain visible pending
semantic resolution. The generated ttsc plugin entry remains disabled until
the déherm transform package is implemented.

Generation is a keyed ensure: unchanged project inventory, Defold/profile
authority, package SDK source tree, generator implementation, and output
location return without rewriting generated files. It does not hash every
output on this fast path.
Use `npx deherm generate --force` to replace disposable generated output, and
`npx deherm verify-generated --project <project>` for the exact integrity audit.
`typecheck` runs that audit first, so stale schema-v2 plan, generator sentinel,
manifest/lock, generated SDK tree, context entrypoint, or generated config state
fails before `tsc`. The installed native-extension runtime has its own complete
tree digest and is copied through a staged replacement, so a source change
cannot be mislabeled as “Current” merely because `ext.manifest` stayed the same.

The generated manifest reports three different facts separately: complete
TypeScript declaration coverage, universal recipe coverage, and the per-target
canonical lowering matrix. Script recipes cover all 915 stable-ID calls, while
the remaining eight functions are compiler intrinsics and three timer routes
use their dedicated module. dmSDK carries 1,361 universal recipes, but a recipe
is not reported as a project-linked implementation until reachability and any
required native type/layout/lifetime inputs have been materialized. The copied
`script-universal-value-bindings.json` and `dmsdk-universal-bindings.json`
catalogs are the project-local authorities for that next build step.

`materialize-dmsdk` is that deterministic next step for native extension code.
It accepts a versioned JSON document with a `usages` array, resolves every
`declarationId` against the shipped universal recipe catalog, and emits a
single usage-pruned C++ provider plus a hash-bound JSON report. Concrete
functions need only their declaration identity; templates, records, receivers,
and ambiguous native types supply the explicit materializer fields recorded by
their recipe. `--check` verifies both outputs byte-for-byte without writing.
The generated report names the provider install function that the consuming
Defold extension calls during initialization. This keeps native reachability
and all non-inferable ABI choices in checked configuration instead of edits to
generated code.

The four generated projects use project-wide suffix discovery (`**/*.ts`) with
dependency, build, and distribution caches excluded. This covers components
outside `src/`. The boundary check rejects package-root SDK imports, generated
SDK deep imports, normalized path aliases, cross-context files, and the same
bypasses hidden behind a shared re-export.

`deherm dev` typechecks authored files through those strict context projects,
but bundles the generated all-component registry through
`tsconfig.deherm.bundle.json`. That runtime-only project maps
`@deherm/project` to the unfiltered SDK so one bundle can contain game-object,
GUI, and render components without weakening editor/typecheck boundaries. In
the interactive console, `p` launches or stops the current platform's compiled
engine under `build/<platform>/dmengine`; its stdout and stderr are captured in
the Live Logs panel rather than written over the terminal UI. A missing Bob
build fails inside that panel with the expected artifact path. `--no-launch`
suppresses only the automatic startup launch: the local reload target remains
configured, `p` still performs a build and launch, and later project/extension
changes restart an engine that the operator launched manually. The watcher
excludes `.internal`, `.deherm`, build outputs, and generated proxies so editor
cache churn and self-authored outputs do not form rebuild loops.

The console itself is declarative. `packages/cli/src/dev/tui/` is authored in
TSX against `@rezi-ui/jsx`; `packages/cli/src/dev/tsx-loader.mjs` registers a
synchronous esbuild module hook before those views are imported, so no build
step or new toolchain enters the published package. Every panel wraps one
focusable Rezi widget, which is what gives the console its focus ring,
Tab/Shift-Tab traversal, click-to-focus, wheel scrolling, table row selection,
and the draggable edit-loop/targets divider without hand-written input code.

`packages/cli/src/dev/tui/keymap.mjs` is the single source of truth for the
input surface: the footer strip, the `?` help overlay, the `:` command palette,
and the bindings registered with Rezi are all projections of that one table, so
an advertised key cannot drift away from a key that works. Rezi's chord trie
holds one binding per sequence, so a sequence a panel owns (`up`, `pageup`,
`home`) is registered once with a focus-scope guard; when the guard rejects, the
event is left unconsumed and reaches the focused widget's own router instead.

`o`/`t`/`g`/`i` select the Overview, Targets, Generations, and Instances views;
`Escape` unwinds one overlay at a time; `y` copies the focused panel's selection
over OSC 52 (so copy works across SSH) with a local `pbcopy`/`clip`/`wl-copy`/
`xclip` fallback; `/` filters the log stream and accepts a paste. Dragging in
the log viewport selects text: the log console keeps tailing and wheel handling,
and an active selection swaps in a virtual list whose rows carry the highlight.
The Instances view renders an explicit "requires runtime instance channel" empty
state because `DEHERM_EVENT telemetry` reports counts, never identities.

The next commands will orchestrate the internal build graph:

```sh
npx deherm dev
npx deherm build --profile=device-dev
npx deherm build --profile=release
npx deherm run --target=macos
npx deherm run --target=html5
npx deherm bob build
```

`dev` uses precompiled complete bindings and a precompiled dynamic Hermes
runtime. A normal TypeScript edit only transforms, bundles, refreshes the
Defold resource, and reloads. It must not rebuild Hermes, the extension, or the
custom engine.

`device-dev` adds matched Hermes bytecode generation. `release` runs the usage
analysis, reachable-only binding generation, Static Hermes compilation, and
the final Defold bundle. The default HTML5 profile executes in the browser VM
and uses the generated Emscripten ABI adapter. An opt-in Static Hermes fused-Wasm
profile remains an experiment blocked on Defold's exception/link compatibility
and benchmark gates.

# Source layout for game authors

The proposed convention keeps the two compilation semantics explicit:

```text
src/**/*.script.ts  Authored TypeScript game-object components; proxies generated beside them
src/**/*.gui.ts     Authored GUI components; `.gui_script` proxies generated beside them
src/**/*.render.ts  Authored render components; `.render_script` proxies generated beside them
src/**/*.ts         Context-free shared modules; no instance-exclusive APIs
src/hermes/         TypeScript modules bundled for Hermes or the browser VM
src/lua/            Optional TS-to-Lua migration/fallback sources
src/shared/         Pure shared TypeScript with target-safe dependencies
```

Application code imports the context-filtered SDK as `@deherm/project`.
Low-level, complete
dmSDK access is available from a separate raw namespace so pointer ownership,
thread restrictions, and lifetime contracts remain visible rather than being
made deceptively ergonomic.

## Package identities

The repository is a pnpm monorepo with private packages named `@deherm/*`.
Those identities are development-only module boundaries and map directly to
raw source in the root `tsconfig.json`; they are not npm publication names.
The unified public artifact is `@ts-defold/deherm` and contains those package
directories. `@deherm/project` is intentionally not a workspace package: the
CLI generates that alias inside a consumer project and points it at the
context-specific SDK for `.script.ts`, `.gui.ts`, `.render.ts`, or shared
TypeScript.
