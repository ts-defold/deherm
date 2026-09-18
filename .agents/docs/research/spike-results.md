---
type: Verification Report
title: Initial spike results
description: Reproducible evidence from the native Hermes, browser, packaging, and Defold extension seams.
tags: [verification, hermes, browser, defold]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
---

# Verified locally

* Meta Hermes `static_h` at the pinned revision builds on arm64 macOS.
* TypeScript 7.0.2 checks through `ttsc` 0.30.4, and matching
  `@ttsc/unplugin` runs inside esbuild before the JavaScript bundle is produced.
* `npm run run:native` evaluates the TypeScript bundle in an embedded Hermes
  runtime through JSI and completes `init`, three updates, a message, and
  finalization.
* Native `ExampleMath.add` is a JSI host function and returns `42` without a
  JSON/message transport; it delegates to the versioned proof C ABI.
* `packages/bindings/modules.json` deterministically generates the TypeScript module
  interface and C ABI declaration; the standard check rejects stale output.
* The real browser harness executes the same bundle, same lifecycle, and same
  typed module lookup using the browser adapter, with no Hermes Wasm payload.
* `npm run package:defold` combines the required static archives and stages the
  public Hermes/JSI headers for the arm64 macOS native extension.
* The Defold extension translation unit passes syntax checks for macOS and
  HTML5 against the pinned Defold headers.
* The packaged public headers plus combined `libhermes.a` independently
  compile, link, and run the same native sample.
* Defold extension sources compile with the engine's actual no-exceptions
  default: native overrides it because JSI throws C++ exceptions, while HTML5
  does not compile exception handlers.
* The bundle emits a symbol manifest from esbuild's retained inputs. In the
  two-symbol proof, the sample retains `ExampleMath.add` and removes unused
  `ExampleMath.multiply` and `Vec3` from release C, JSI, Static Hermes,
  Emscripten, symbol-map, and layout projections.
* Importing the dynamic `DefoldModules` registry is detected from the emitted
  graph and conservatively retains the complete two-symbol surface.
* The same precompiled dynamic Hermes runner accepts both the JavaScript bundle
  and host-produced Hermes bytecode. `test:device-dev` compiles `.hbc` with the
  matching pinned `hermesc` and completes the identical lifecycle without
  rebuilding native code after the runner exists.
* The generated Lua compatibility backend caches registry references, restores
  the Lua stack and Defold instance on every path, and uses fixed-capacity SoA
  handles, an open-addressed timer index, and a no-fallback scratch arena.
* The `Timer.delay` proof completes Hermes → generated JSI → C ABI → Lua timer
  closure → Hermes callback re-entry. One-shot callbacks release after their
  first dispatch attempt; repeating callbacks release on cancel or shutdown.
* Against Defold's pinned Lua 5.1 sources, one million cached primitive calls
  measure roughly 0.18–0.21 microseconds/call and 100,000 callback dispatches
  roughly 0.39–0.43 microseconds/call on local arm64 macOS release builds, with
  zero Lua allocator calls after warm-up.
* AddressSanitizer and UndefinedBehaviorSanitizer pass both the standalone Lua
  bridge suite and the embedded-Hermes callback round trip.

# Deliberate boundary

No full application has yet been bundled by the Defold editor or cloud build
service. The current evidence validates the VM, shared TypeScript API, web
adapter, extension source seam, and packaged native archive independently. The
next milestone must run the minimal project through an actual Defold build and
then add the remaining platform libraries.

# Commands

```sh
npm install
npm run bootstrap
npm test
npm run build:release-plan
npm run test:native
npm run test:device-dev
npm run test:lua-bridge
npm run test:lua-hermes
npm run check:extension-syntax
npm run package:defold
npm run run:web
```
