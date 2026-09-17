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
npm install
npm run bootstrap
npm run doctor
npm run check
```

`bootstrap` is a toolchain/materialization operation. It is not part of the
ordinary edit loop.

# Commands that work now

| Intent | Command | Result |
| --- | --- | --- |
| Validate generated sources, inventories, types, and OKF | `npm run check` | No native rebuild |
| Inspect a Defold project | `npm run cli -- doctor --project <path>` | Finds local and resolved extensions |
| List extension binding inputs | `npm run cli -- extensions --project <path>` | Reports script API, headers, and schema gaps |
| Generate a project SDK | `npm run cli -- generate --project <path>` | Writes types, executable TS modules, tsconfig, and VS Code setup |
| Bundle TypeScript | `npm run build:js` | `dist/sample.js` plus its symbol-usage manifest |
| Build the standalone embedded-Hermes runner | `npm run build:native` | Native test runner, not a Defold game |
| Compile and run JS source in Hermes | `npm run run:native` | Fast source-interpreter development proof |
| Compile and run matched Hermes bytecode | `npm run run:device-dev` | `hermesc` produces `dist/sample.hbc` |
| Run the browser-host contract | `npm run run:web` | Local URL using the browser VM, not Hermes Wasm |
| Generate reachable-only release bindings | `npm run build:release-plan` | Filtered artifacts under `build/profiles/release` |
| Check Static Hermes declarations | `npm run check:static-hermes` | Parses the generated `extern_c` surface |
| Exercise the cached Lua bridge | `npm run test:lua-hermes` | Hermes -> JSI -> C ABI -> Lua -> callback |
| Stage the native extension | `npm run package:defold` | Defold package directory/archive inputs |
| Prepare pinned local Extender | `npm run extender:prepare` | Builds the pinned jars and maps the installed Xcode SDK |
| Start/inspect local Extender | `npm run extender:start`; `npm run extender:status`; `npm run extender:logs` | Standalone macOS service on port 9010 |
| Compile the real Defold project | `npm run bob:local:build` | Starts a temporary pinned Extender when needed, then builds with Bob |
| Produce a desktop app bundle | `npm run bob:local:bundle` | Writes `build/bundle/Defold Hermes Spike.app` |
| Reuse a running local Extender | `npm run bob:build`; `npm run bob:bundle` | Local port 9010 is the default |

The strongest local verification is one command:

```sh
npm run verify
```

`npm test` remains the faster generator/type/browser loop. `verify` additionally
builds and runs native Hermes source and bytecode, the Lua bridge, Static Hermes
parsing, extension syntax checks, and Defold extension packaging.

# Local Bob and Extender

Pinned Bob is downloaded and checksum-verified by `npm run bootstrap:bob`.
Pinned Extender is checked out from `upstream.lock`. On macOS, the one-command
paths prepare its jars, detect the installed Xcode SDK/clang/Swift ABI, create
repo-local SDK links, start Extender for the duration of the build, and stop it:

```sh
npm run bob:local:build
npm run bob:local:bundle
```

For a persistent edit loop, run `npm run extender:start` once and then use
`npm run bob:build` or `npm run bob:bundle`. `npm run extender:foreground` is
the inspectable foreground form. The current proof is arm64 macOS; other target
toolchains still need their Extender builders.

Because this project includes a native extension, a non-local build server
receives extension sources and packaged libraries. Localhost is the default and
does not require an upload opt-in. A remote server is deliberately explicit:

```sh
DEFOLD_HERMES_BUILD_SERVER=https://build.defold.com \
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 npm run bob:build
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

# npm CLI

The npm package now exposes project inspection and generation:

```sh
npx defold-hermes doctor
npx defold-hermes extensions
npx defold-hermes generate
```

These are the installed-package commands verified from a local tarball. The
package name is not published yet; in this checkout use `npm run cli --` before
the command and options.

`generate` reads local extensions and Bob-resolved ZIPs, then writes:

```text
.defold-hermes/extensions.json       sanitized deterministic inventory
.defold-hermes/bindings.ir.json      normalized symbol/type/lowering IR
.defold-hermes/extensions.d.ts       extension interfaces
.defold-hermes/sdk/**                executable TypeScript compatibility SDK
tsconfig.defold-hermes.json          TS 7 + future ttsc transform configuration
tsconfig.json                        created only when the project has none
.vscode/extensions.json              created only when absent
.vscode/settings.json                created only when absent
```

Existing root `tsconfig.json` and VS Code files are never overwritten. The
generated ttsc plugin entry is disabled until the Defold transform package is
implemented; this keeps the scaffold type-checkable today while fixing the
future configuration contract.

The next commands will orchestrate the internal build graph:

```sh
npx defold-hermes dev
npx defold-hermes build --profile=device-dev
npx defold-hermes build --profile=release
npx defold-hermes run --target=macos
npx defold-hermes run --target=html5
npx defold-hermes bob build
```

`dev` uses precompiled complete bindings and a precompiled dynamic Hermes
runtime. A normal TypeScript edit only transforms, bundles, refreshes the
Defold resource, and reloads. It must not rebuild Hermes, the extension, or the
custom engine.

`device-dev` adds matched Hermes bytecode generation. `release` runs the usage
analysis, reachable-only binding generation, Static Hermes compilation, and
the final Defold bundle. HTML5 always executes in the browser VM and uses the
generated Emscripten ABI adapter.

# Source layout for game authors

The proposed convention keeps the two compilation semantics explicit:

```text
src/hermes/   TypeScript bundled for Hermes or the browser VM
src/lua/      TypeScript transposed to Defold Lua script resources
src/shared/   Pure shared TypeScript with target-safe dependencies
```

Application code imports the idiomatic generated SDK. Low-level, complete
dmSDK access is available from a separate raw namespace so pointer ownership,
thread restrictions, and lifetime contracts remain visible rather than being
made deceptively ergonomic.
