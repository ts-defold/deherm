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
| Bundle TypeScript | `npm run build:js` | `dist/sample.js` plus its symbol-usage manifest |
| Build the standalone embedded-Hermes runner | `npm run build:native` | Native test runner, not a Defold game |
| Compile and run JS source in Hermes | `npm run run:native` | Fast source-interpreter development proof |
| Compile and run matched Hermes bytecode | `npm run run:device-dev` | `hermesc` produces `dist/sample.hbc` |
| Run the browser-host contract | `npm run run:web` | Local URL using the browser VM, not Hermes Wasm |
| Generate reachable-only release bindings | `npm run build:release-plan` | Filtered artifacts under `build/profiles/release` |
| Check Static Hermes declarations | `npm run check:static-hermes` | Parses the generated `extern_c` surface |
| Exercise the cached Lua bridge | `npm run test:lua-hermes` | Hermes -> JSI -> C ABI -> Lua -> callback |
| Stage the native extension | `npm run package:defold` | Defold package directory/archive inputs |
| Compile the real Defold project | `npm run bob:build` | Uses pinned Bob and the native-extension build service |
| Produce a desktop app bundle | `npm run bob:bundle` | Writes the application under `build/bundle` |

The strongest local verification is one command:

```sh
npm run verify
```

`npm test` remains the faster generator/type/browser loop. `verify` additionally
builds and runs native Hermes source and bytecode, the Lua bridge, Static Hermes
parsing, extension syntax checks, and Defold extension packaging.

# Missing Bob boundary

Pinned Bob is downloaded and checksum-verified by `npm run bootstrap:bob`.
Because this project includes a native extension, Bob sends the extension
sources and packaged libraries to the configured Defold build server. That
external upload is deliberately opt-in:

```sh
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 npm run bob:build
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 npm run bob:bundle
```

The default server is `https://build.defold.com`; override it with
`DEFOLD_HERMES_BUILD_SERVER`. The remaining milestone is to complete a real
build, launch the resulting application, and make that result a CI gate. It
must:

1. verify JDK 25 and all native toolchain prerequisites;
2. copy the bundle or bytecode into the project as a Defold resource;
3. report extension build logs without hiding the failing compiler command;
4. launch desktop outputs and provide a stable path for device outputs.

# Intended public CLI

The package should expose one command rather than require knowledge of its
internal npm/CMake graph:

```sh
npx defold-hermes doctor
npx defold-hermes generate
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
