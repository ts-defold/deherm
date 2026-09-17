---
type: Research Note
title: Local Bob, standalone Extender, and Hermes runtime evidence
description: Reproducible evidence that pinned Bob and standalone Extender build and run the Defold Hermes extension on macOS arm64 and HTML5 Wasm, including the failures resolved on the way.
tags: [research, evidence, defold, bob, extender, hermes, macos, arm64, html5, wasm, native-extension]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-17T18:26:03-04:00 }
sources:
  - id: revisions
    resource: ../../upstream.lock
    title: Pinned upstream revisions and Bob digest
    author: team:ts-defold
  - id: defold-source
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05
    title: Defold at the tested revision
    author: team:defold
  - id: extender-source
    resource: https://github.com/defold/extender/tree/2a17252f657056c7705c584617c601a97c3c6a20
    title: Extender at the tested revision
    author: team:defold
  - id: extender-runner
    resource: ../../scripts/extender-local.sh
    title: Standalone Extender lifecycle and Apple toolchain configuration
    author: team:ts-defold
  - id: bob-runner
    resource: ../../scripts/bob.sh
    title: Pinned Bob and local-build-server runner
    author: team:ts-defold
  - id: extension-manifest
    resource: ../../defold/defold_hermes/ext.manifest
    title: Defold Hermes extension manifest
    author: team:ts-defold
  - id: extension-registration
    resource: ../../defold/defold_hermes/src/extension.cpp
    title: Native extension registration and lifecycle
    author: team:ts-defold
  - id: project-config
    resource: ../../defold/game.project
    title: Defold proof-project configuration
    author: team:ts-defold
  - id: html5-check
    resource: ../../scripts/check-html5-runtime.mjs
    title: Chrome DevTools Protocol HTML5 runtime check
    author: team:ts-defold
---

# Result and boundary

On 2026-09-17, the pinned Defold toolchain, a locally built standalone
Extender, the packaged dynamic Hermes library, the generated glue, and the
sample TypeScript application completed one end-to-end native path on an
Apple-silicon Mac:

```text
Bob 1.14.0 -> standalone Extender -> arm64 dmengine -> extension init
  -> app.js loaded by dmResource -> Hermes init -> generated ExampleMath call
```

The same pinned toolchain now also completes the HTML5 browser-host path:

```text
Bob 1.14.0 -> standalone Extender + Emscripten 4.0.6 -> wasm-web custom engine
  -> archived app.js -> browser VM -> generated ExampleMath Wasm call
```

These are **macOS arm64 and `wasm-web` debug proofs only**. They prove that
these exact configurations build, link, start Defold, load the custom
JavaScript resource, initialize dynamic Hermes on native or the browser host
on HTML5, and invoke one generated module binding. They do not certify Static
Hermes AOT inside Defold, release builds, bytecode, iOS, Android, Windows,
Linux, every generated binding, long-running stability, leak freedom, hot
reload, or performance budgets.

The sample's `ExampleMath` module is deherm-owned proof glue. It makes **zero
public Defold game API calls**. Internal extension use of resource/config/script
services and a separate Hermes-to-mocked-Lua timer harness do not count as a
TypeScript-callable Defold binding. At this evidence point the running game's
ergonomic script surface is 0/926 and its dmSDK surface is 0/1361.

# Reproduction coordinates

| Component | Tested value |
| --- | --- |
| Host | macOS 26.5.2 build 25F84, arm64 |
| Xcode | Xcode 26.6 build 17F113 |
| Selected developer directory | `/Applications/Xcode.app/Contents/Developer` |
| Selected macOS SDK | 26.5 |
| JDK | Homebrew OpenJDK 25.0.4.1 at `/opt/homebrew/opt/openjdk@25` |
| Defold | `7f0f554f41f9dce1e0ddff99bf08200657d1ee05` |
| Bob | 1.14.0, Defold SHA `7f0f554f41f9dce1e0ddff99bf08200657d1ee05` |
| Bob SHA-256 | `8a8a8c4ebc725279d8ddae17c4eb3d72d6db90a498302960ca341e61fa489cb8` |
| Extender | `2a17252f657056c7705c584617c601a97c3c6a20` |
| Extender endpoint | standalone profile on `http://localhost:9010` |
| Bob platform/architecture | `arm64-macos` |
| Bob variant | `debug` |
| Emscripten | 4.0.6, emsdk revision `24fc909c0da13ef641d5ae75e89b5a97f25e37aa` |
| HTML5 platform/architecture | `wasm-web` |

The bare `java` command was not available through the shell's default runtime
lookup. The project scripts therefore deliberately select the Homebrew JDK 25
binary (or an explicit `JAVA_HOME`) instead of depending on `PATH`. Running the
pinned jar produced:

```text
bob.jar version: 1.14.0  sha1: 7f0f554f41f9dce1e0ddff99bf08200657d1ee05  built: 2026-09-17 13:05:06
100% Working
```

The local flow is:

```sh
npm run extender:start
npm run bob:build
```

`extender:start` verifies the Extender checkout, detects the installed Apple
SDK/toolchain, builds the Extender and manifest-merger jars, generates a local
environment override, starts the `standalone-dev` profile, and waits for its
health endpoint. `bob:build` packages the Defold extension, refuses an
unapproved non-local build server, and asks the local Extender to build the
custom engine.

The generated local environment used `MACOS_VERSION_MIN=11.5`, macOS SDK
26.5, clang resource version 21, and Swift ABI 6.2. The environment file is a
machine-local generated input under the Extender checkout; it is not an
upstream Extender modification.

# Exact success evidence

The engine emitted these lines during the successful launch:

```text
INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)
INFO:DEFOLD_HERMES: Loaded TypeScript application '/defold_hermes_app/app.js'; waiting for script instance attachment
INFO:DEFOLD_HERMES: init:hermes
INFO:DEFOLD_HERMES: module:42
```

Those lines establish four distinct facts: the running engine matches the
pinned Defold revision; `dmResource::GetRaw` found and loaded the JavaScript
payload; the Lua bootstrap attached the current Defold script instance and
started Hermes; and the TypeScript sample reached the generated `ExampleMath`
binding and obtained `20 + 22 = 42`.

The HTML5 proof used `npm run bob:web:bundle`, served the generated bundle from
`build/bundle/Defold Hermes Spike`, and connected the checked-in CDP verifier to
a clean headless Chrome process with software WebGL. The verifier observed:

```json
{
  "engineStarted": true,
  "appRegistered": true,
  "hostRuntime": "browser",
  "modules": ["ExampleMath", "Timer"]
}
```

It also captured the application transcript `init:browser`, `module:42`,
`clock-ready:true`, and at least one `update` callback, with no JavaScript
exception or non-favicon browser error. This proves an actual Defold engine
call: `ExampleMath.add(20, 22)` traveled through generated browser glue into
the linked Wasm export and returned `42`. Inspection of the emitted
`DefoldHermesSpike_wasm.js` also found the generated lifecycle imports and
the exported scalar binding symbols.

The Emscripten variables were initially absent from the standalone macOS
Extender profile, producing a Mustache failure while resolving
`env.EMSCRIPTEN_*`. The project now pins and bootstraps emsdk 4.0.6—the version
used by the matching Defold/Extender configuration—and generates the local
Extender environment automatically. The first browser check then found that
the development server did not URL-decode the space in the bundle directory;
fixing the server exposed the actual game. Headless Chrome additionally needs
software WebGL enabled; without a WebGL context Emscripten starts but Defold
does not reach the extension lifecycle.

The retained native outputs were also inspected after the successful build:

- `defold/build/arm64-osx/dmengine` is a thin arm64 Mach-O executable. Its
  `LC_BUILD_VERSION` declares macOS minimum 11.5 and SDK 26.5. It is ad-hoc,
  linker-signed, as expected for this local debug artifact.
- `defold/build/arm64-osx/libdefold_hermes_16.a` is the extension archive.
  `nm` reports the required registration export exactly as
  `000000000000007c T _defold_hermes`.
- `defold/build/arm64-osx/log.txt` records compilation of all 16 extension
  translation units, creation of `libdefold_hermes_16.a`, and the final link
  of `dmengine` with both `-ldefold_hermes_16` and `-lhermes`.
- Every retained extension compile command includes `-arch arm64`,
  `-target arm64-apple-darwin19`, `-mmacosx-version-min=11.5`,
  `-std=c++17`, and `-fexceptions`.

Artifact digests are intentionally not promoted to durable release
identities: these are ignored local debug outputs and their hashes change on
rebuild. The durable identities are the pinned source revisions and Bob
digest above.

# Reproduced failures and fixes

## C++ language mode

The first extension manifest supplied exceptions but did not declare its C++
language level. The native extension and the Hermes/JSI headers require the
C++17 contract used by the project's standalone CMake builds. The fix was to
make that contract explicit in `ext.manifest`:

```yaml
flags: ["-std=c++17", "-fexceptions"]
```

The earlier compiler transcript was not retained, so no exact diagnostic is
quoted. The fix is nevertheless verified at the output boundary: the final
Extender log contains `-std=c++17` for every extension translation unit and
all of them compile into the archive. This is a toolchain-contract fix, not a
claim that every compiler's unspecified default mode would fail identically.

## macOS deployment target

The local Extender initially did not have a project-specific deployment
target aligned with the packaged Hermes objects. The runner now generates an
override with `MACOS_VERSION_MIN=11.5`; both a packaged Hermes object and the
final engine were independently inspected and report `minos 11.5` and SDK
26.5. The final compile and link commands also carry
`-mmacosx-version-min=11.5`.

The exact earlier linker diagnostic was not retained. Therefore the causal
statement is deliberately narrow: aligning the standalone Extender input,
the packaged archive, and the output removed the observed deployment-target
failure in this session. It is not evidence for other Apple platforms or
deployment minima.

## extension registration symbol

The next link reached the extension archive but failed with:

```text
undefined symbol: _defold_hermes
```

Defold's generated extension entry point is derived from the extension folder
name, `defold_hermes`. The previous `DM_DECLARE_EXTENSION` identifier produced
a different symbol. The declaration now uses `defold_hermes`; it is placed in
a C++ namespace only to avoid a source-level collision with the public
`defold_hermes` namespace. The macro's C linkage still exports the required
global symbol. The archive inspection above proves the corrected spelling,
and the final engine link proves it is consumable.

## JavaScript payload packaging

With the engine linked, the first launch reproduced this runtime failure:

```text
ERROR:DEFOLD_HERMES: Unable to load TypeScript bundle '/defold_hermes_app/app.js' (resource error -3)
```

Extension initialization then failed, and the Lua bootstrap observed a nil
`defold_hermes` global because registration never completed.

The project had listed the payload under `project.bundle_resources`. That
setting copies bundle-side files; it does not make the file addressable through
the engine resource archive used by `dmResource::GetRaw`. The project now uses:

```ini
[project]
custom_resources = /defold_hermes_app
```

The subsequent exact success line reporting that same virtual path as loaded,
followed by `init:hermes` and `module:42`, is the end-to-end verification of
this fix.

# Resolved archive collision

The first successful link reported duplicate `zip_*` symbols supplied by an
unused `zip.c.o` in Hermes's VM archive and Defold's `libzip.a`. Inspection
showed that no other object in `libhermesvm_a.a` had an undefined `zip_*`
reference: the object belongs to compiler-side ZIP input support, not the
embedded VM path. The deterministic packager now refuses to strip it if such a
reference ever appears, otherwise removes precisely `zip.c.o` before merging
the Defold-facing Hermes archive.

A fresh local Extender build then linked without any duplicate-symbol warning;
archive inspection found no `zip.c.o`, `_defold_hermes` remained exported, and
the rebuilt bundle repeated `init:hermes` and `module:42` at runtime.

# Open evidence gaps

The next promotion gate should rebuild this proof from a clean checkout in
automation, retain the Extender and engine stdout as artifacts, execute a
bounded shutdown path, run leak/undefined-behavior instrumentation where the
platform permits it, and repeat the conformance fixture per supported target.
Until those gates pass, this note remains an exact local proof rather than a
portable or memory-safety certification.
