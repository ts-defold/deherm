---
type: Research Note
title: Local Bob, standalone Extender, and Hermes runtime evidence
description: Reproducible evidence that pinned Bob and standalone Extender build and run the Defold Hermes extension and real generated Defold script calls on macOS arm64, plus the HTML5 Wasm host path.
tags: [research, evidence, defold, bob, extender, hermes, macos, arm64, html5, wasm, native-extension]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-17T20:45:00-04:00 }
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
  - id: war-battles-runtime-harness
    resource: ../../examples/war-battles-online/integration/check-packaged-runtime.mjs
    title: Fail-closed War Battles packaged runtime harness
    author: team:ts-defold
  - id: war-battles-runtime-evidence
    resource: ../../examples/war-battles-online/evidence/packaged-runtime-arm64-macos.json
    title: Artifact-bound War Battles packaged runtime observation
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
  - id: native-script-probes
    resource: ../../packages/bindings/generated/defold-script-real-engine-probes.json
    title: Descriptor-validated native script API probe report
    author: team:ts-defold
  - id: native-value-probes
    resource: ../../packages/bindings/generated/defold-script-value-real-engine-probes.json
    title: Generated native Defold value API probe report
    author: team:ts-defold
  - id: native-runtime-check
    resource: ../../scripts/check-native-defold-runtime.mjs
    title: Native Defold transcript verifier
    author: team:ts-defold
---

# Result and boundary

On 2026-09-17, the pinned Defold toolchain, a locally built standalone
Extender, the packaged dynamic Hermes library, the generated glue, and the
sample TypeScript application completed one end-to-end native path on an
Apple-silicon Mac:

```text
Bob 1.14.0 -> standalone Extender -> arm64 dmengine -> extension init
  -> app.js loaded by dmResource -> Hermes init -> generated stable-ID bridge
  -> captured Defold Lua instance -> 14 generated scalar calls across 12 APIs
  -> five generated POD vmath calls + exact 64-bit hash
  -> current-instance go.get_position/set_position/set_rotation -> TypeScript
```

The same pinned toolchain now also completes the HTML5 browser-host path:

```text
Bob 1.14.0 -> standalone Extender + Emscripten 4.0.6 -> wasm-web custom engine
  -> archived app.js -> browser VM -> generated dmSDK/script bridge calls
```

These are **macOS arm64 and `wasm-web` debug proofs only**. They prove that
these exact configurations build, link, start Defold, load the custom
JavaScript resource, initialize dynamic Hermes on native or the browser host
on HTML5, and traverse generated bridges. The native run proves 14
descriptor-validated calls across 12 generated scalar bindings in the live
Defold Lua API plus five generated fixed-layout `vmath` routes and the exact
64-bit `defold.hash` public route (raw Defold source module `builtins`). They do not
certify Static
Hermes AOT inside Defold, release builds, bytecode, iOS, Android, Windows,
Linux, every generated binding, long-running stability, leak freedom, hot
reload, or performance budgets.

The sample's `ExampleMath` module remains deherm-owned proof glue. In contrast,
the generated probe fixture now traverses the stable-ID JSI bridge for 14 calls
covering `bit`, `sys`, and `profiler`. It proves number, boolean, string,
integer-enum, nullable `nil -> null`, and no-result `void -> undefined`
decoding; optional-argument omission; zero-, one-, and two-argument calls; and
real project configuration/path queries. A second generated fixture asserts
`vmath.vector3`, `vmath.length`, `vmath.normalize`,
`vmath.quat_rotation_z`, and `vmath.quat` through the dynamic-Hermes JSI path.
The same fixture proves `defold.hash` as a branded JavaScript `bigint` with
all 64 bits preserved. A reentrant, generational active-instance context then
proves `go.get_position`, `go.set_position`, and `go.set_rotation`; Lua reads
back the actual position and rotation before emitting the setter markers. At
this evidence point exactly **21/926** unique script bindings have
macOS-arm64 real-engine behavioral evidence. The other 78 scalar descriptors
and all remaining non-scalar script families retain narrower
generated/mock/compile status. The dmSDK surface has no
equivalent per-function real-engine behavioral certification yet.

The proof has since moved from a raw `app.js` load to the typed
`/deherm/app.dehermc` resource. A separate real-engine verifier rejects a
generation-2 bundle that throws at the start of `init()`, observes generation 1
complete another update without finalization, then activates generation 3 with
the changed `add(40, 44)` expression and observes `module:84`. See
`hot-reload-and-dev-tui.md` for the exact boundary; it is not full API, leak,
native-side-effect rollback, or browser-HMR certification.

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
lookup. The foreground project flow deliberately selects the Homebrew JDK 25
binary (or an explicit `JAVA_HOME`). The persistent service wrapper still uses
the generated environment `PATH`, so its selected Java version is checked from
the service log. Running the pinned jar produced:

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
INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'
INFO:DEFOLD_HERMES: init:hermes
INFO:DEFOLD_HERMES: module:42
INFO:DEFOLD_HERMES: script-api:bit.tohex.explicit-width:0021
INFO:DEFOLD_HERMES: script-api:bit.tohex.default-width:00000021
INFO:DEFOLD_HERMES: script-api:bit.lshift.number:256
INFO:DEFOLD_HERMES: script-api:sys.get_config_string.present:Defold Hermes Spike
INFO:DEFOLD_HERMES: script-api:sys.get_config_string.nullable:null
INFO:DEFOLD_HERMES: script-api:sys.get_config_boolean:true
INFO:DEFOLD_HERMES: script-api:sys.get_config_int:37
INFO:DEFOLD_HERMES: script-api:sys.get_config_number:12.5
INFO:DEFOLD_HERMES: script-api:sys.get_connectivity.integer-enum:1
INFO:DEFOLD_HERMES: script-api:sys.get_application_path:<non-empty app bundle path>
INFO:DEFOLD_HERMES: script-api:sys.get_save_file:<path ending in deherm-proof.bin>
INFO:DEFOLD_HERMES: script-api:sys.exists.false:false
INFO:DEFOLD_HERMES: script-api:profiler.scope_begin.void:undefined
INFO:DEFOLD_HERMES: script-api:profiler.scope_end.void:undefined
INFO:DEFOLD_HERMES: script-value:builtins.hash.my_hash:ok
INFO:DEFOLD_HERMES: script-value:vmath.vector3.zero:ok
INFO:DEFOLD_HERMES: script-value:vmath.length.vector3:ok
INFO:DEFOLD_HERMES: script-value:vmath.normalize.vector3:ok
INFO:DEFOLD_HERMES: script-value:vmath.quat_rotation_z.pi:ok
INFO:DEFOLD_HERMES: script-value:vmath.quat.identity:ok
INFO:DEFOLD_HERMES: Extension update entered (application initialized: true)
INFO:DEFOLD_HERMES: lifecycle:update:1
```

Those lines establish that the running engine matches the
pinned Defold revision; `dmResource::GetRaw` found and loaded the JavaScript
payload; the Lua bootstrap attached the current Defold script instance and
started Hermes; and the TypeScript sample reached the generated `ExampleMath`
binding and obtained `20 + 22 = 42`. They also establish the 14 exact script
calls described above. The path and connectivity values are target-dependent;
the generated fixture checks bounded semantic predicates while the verifier
requires the corresponding marker prefix and captures the actual value.

The probe surface is not handwritten TypeScript glue. The checked-in probe
plan names canonical script IDs, literal arguments, and expectations.
`generate-script-real-engine-probes.mjs` resolves each ID against the generated
scalar descriptor table and script IR, rejects codec/arity/expectation
mismatches, and emits both the TypeScript fixture and the machine-readable
evidence manifest. The native verifier consumes that manifest, so adding a
probe changes one declarative input rather than three hand-maintained lists.
The report deliberately says that unselected bindings and other targets remain
unproven.

This expansion also reproduced a metadata defect: Defold's source makes the
second `bit.tohex` argument optional, the native scalar descriptor respected
that fact, but the SDK type still required two arguments. The source-validated
semantic override now lives in one data file and is applied to both SDK and
runtime descriptor generation. The one-argument call compiles and returns the
documented default-width result `00000021` in the live engine.

The value-probe plan is also declarative. Its generator resolves every probe
against the generated call-shape table and fails unless every generated value
binding has a packaged-engine probe. It emits assertion-bearing TypeScript plus
the verifier manifest. All six routes separately pass exact native POD tests
with zero C++ allocations across 500,000 six-call cycles and a standalone
Hermes JSI test. That allocation statement covers native staging and dispatch;
Hermes still allocates JavaScript result objects. Static Hermes and browser
value codecs remain unwired and unclaimed.

The first attempted rerun misleadingly reproduced only the older four-line
transcript. The cause was not a bridge failure: Bob's non-archive `build`
updated `build/bob/defold_hermes_app/app.js` while leaving an older
`build/bob/game.arcd`, and `dmengine` loaded that stale archive. The local
`build` wrapper now always passes `--archive`; `bundle` already did. File
timestamps are not a reliable freshness oracle because Bob may correctly reuse
an archive when the resource bytes are unchanged.

The build instead embeds a deterministic SHA-256 payload fingerprint in
`app.js`. The hash is computed over the generated bundle with a fixed-width
placeholder, avoiding a circular self-hash while leaving source-map offsets
unchanged. `npm run test:native-defold:runtime` reads that fingerprint from the
current source resource, launches the app bundle directly, and accepts the run
only when the engine prints the identical fingerprint plus the expected
engine/bridge/lifecycle markers. It then terminates only the process it created.
Its first successful run completed in under one second after process startup
and printed `native-defold-runtime:ok`.

The HTML5 proof used `npm run bob:web:bundle` and the following macOS commands.
The server root is the repository, which is why the URL contains the full
`build/bundle` path:

```sh
PORT=4174 node scripts/serve.mjs

'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/deherm-html5-chrome \
  'http://127.0.0.1:4174/build/bundle/Defold%20Hermes%20Spike/index.html'

npm run test:html5:runtime
```

The checked-in CDP verifier reloads that exact page, waits for the new execution
context and load event, discards inspector events replayed from the prior page,
and then observed:

```json
{
  "engineStarted": true,
  "appRegistered": true,
  "hostRuntime": "browser",
  "modules": ["DmSdkScalar", "ExampleMath", "Timer"],
  "scriptBridgeInstalled": true
}
```

It also captured the application transcript `init:browser`, `module:42`, all
14 scalar script-probe markers (including
`script-api:bit.lshift.number:256`), `clock-ready:true`, and at least one
`update` callback, with no JavaScript exception or non-favicon browser error.
The browser sample additionally called the route now exposed as
`defold.hash("my_hash")`, crossed the
real Emscripten flat C ABI into generated native code, reconstructed the exact
64-bit `bigint`, and emitted `script-value:builtins.hash.my_hash:ok`. This
proves calls through the installed raw Wasm script bridge as well as a
generated module call into extension code. Fixed-layout `vmath` probes are
deliberately skipped because the browser value codec is not yet implemented.
Inspection of the emitted
`DefoldHermesSpike_wasm.js` also found the generated lifecycle imports and
the exported scalar binding symbols.

## Fresh HTML5 rerun on 2026-09-18

A fresh bundle was served from the repository root on an otherwise unused
loopback port and loaded by a dedicated headless Chrome profile:

```sh
PORT=4187 node scripts/serve.mjs

'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --remote-debugging-port=9237 \
  --user-data-dir=/tmp/deherm-html5-chrome.tXdGRO \
  --no-first-run \
  --no-default-browser-check \
  'http://127.0.0.1:4187/build/bundle/Defold%20Hermes%20Spike/index.html'

DEFOLD_HERMES_HTML5_URL='http://127.0.0.1:4187/build/bundle/Defold%20Hermes%20Spike/index.html' \
DEFOLD_HERMES_CDP_URL='http://127.0.0.1:9237/json/list' \
npm run test:html5:runtime
```

The checked-in verifier exited zero and reported this exact state:

```json
{
  "documentReady": "complete",
  "engineStarted": true,
  "appRegistered": true,
  "hostRuntime": "browser",
  "modules": ["DmSdkScalar", "ExampleMath", "Timer"],
  "scriptBridgeInstalled": true,
  "canvas": { "width": 640, "height": 427 }
}
```

The runtime emitted bundle fingerprint
`ccb2463eefcfe05fc8ebb083e57b37e4af1e60662a77d538deadd980c0aaf715`,
which matched both the source `defold/deherm/app.dehermc` and Bob-staged
`defold/build/bob/deherm/app.dehermc` used by this bundle. The probe-set
fingerprint was
`30e0fc542abf0832c1c44defec7483412b4ff8076177de1a981ec1347dbc0c11`.
The same run observed `init:browser`, `module:42`,
`script-api:bit.lshift.number:256`,
`script-value:builtins.hash.my_hash:ok`, `clock-ready:true`, and the update
lifecycle assertion. There was no JavaScript exception or non-favicon page
error; the verifier intentionally ignored the lone `favicon.ico` 404. Chrome's
macOS `CVDisplayLink`, GCM, and software-WebGL diagnostics were process stderr,
not page failures.

This rerun promotes only the browser-executable scalar module routes and the
generated 64-bit hash route that the verifier actually called. It does not
promote fixed-layout `vmath`, address unions, generic/DDF message tables,
factory property containers, GUI node handles, or any other structured codec.
Those routes remain guarded as unsupported until their browser codecs are
generated, linked, and observed by assertion-bearing target probes.

The first checker invocation inside the restricted filesystem/network sandbox
failed before reaching Chrome with `connect EPERM 127.0.0.1:9237`. Repeating
the identical checker with approved loopback access passed, so the EPERM is an
execution-environment permission boundary rather than evidence of a bundle or
runtime failure. After the check, only the two process sessions created for
this proof were interrupted, both ports were verified to have no listener, and
the dedicated `/tmp/deherm-html5-chrome.tXdGRO` profile was removed. No shared
browser or server process was terminated.

## Post-generator native and HTML5 rerun

After the declarative GUI-setter family expanded the value table to 53 routes,
both custom engines were rebuilt through the same pinned local Extender. The
native `arm64-osx` bundle linked the expanded generated source, launched dynamic
Hermes, emitted the current scalar and value probe fingerprints, reached
`lifecycle:update:1` and `final:ok`, and exited with code zero. The value ledger
contained 53 unique route dispositions: nine instrumented routes, five explicit
planned scenarios, and 39 generated planned-only GUI setter scenarios. The
runtime verifier requires markers only for the nine emitted instrumented probes;
it validates that every non-emitted route is still represented exactly once.

The corresponding fresh `wasm-web` bundle was served on `127.0.0.1:4188` and
verified through a dedicated Chrome CDP endpoint on `127.0.0.1:9238`. It
reported the same complete engine/browser state above and emitted bundle
fingerprint
`f7000de0a6cdc4ce92c425d49ceca1954abd79ac906963b81b3de21b33deaf35`,
`module:42`, scalar probe fingerprint
`30e0fc542abf0832c1c44defec7483412b4ff8076177de1a981ec1347dbc0c11`,
`script-value:builtins.hash.my_hash:ok`, `clock-ready:true`, and an update. The
only page-level error was the ignored favicon 404. The scoped server, Chrome,
ports, and temporary profile were cleaned up.

This rebuild proves that the expanded generated table compiles and links for
both targets. It does not prove the 39 GUI setters in a browser or real GUI
scene: those routes remain guarded on HTML5 and planned-only on native until a
scene fixture supplies valid generational node handles and per-setter semantic
assertions.

## Fixed-POD vmath packaged-engine observation

After the source-pinned fixed-POD `vmath` family expanded the value table from
53 to 64 routes, the arm64 macOS extension and custom engine were rebuilt with
the pinned local Extender and Defold 1.14.0 revision. The packaged application
then executed all 11 generated family probes through dynamic Hermes and exited
zero after `lifecycle:update:1` and `final:ok`. The observed routes were
`conj`, `cross`, `euler_to_quat`, `length_sqr`, `project`, `quat_axis_angle`,
`quat_basis`, `quat_from_to`, `quat_rotation_x`, `quat_rotation_y`, and
`rotate`.

The successful transcript is retained at
`.agents/docs/data/native-defold-runtime.log`, SHA-256
`f52a4571d78860c5d86e64e018e703e4e6c8b797ffc36fc969e3146a1835261b`.
The real-engine matrix validates that artifact against both current scalar and
value probe-set fingerprints and exact scenario markers. It promotes exactly
32 routes with observed scenarios to runtime-verified; compile and link stages
remain separately unverified in the matrix because the Bob/Extender transcript
has not yet been retained as a SHA-bound artifact. This observation does not
promote HTML5 value codecs, GUI scene routes, or any planned-only route.

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

# Scoped War Battles GUI component observation

The War Battles example now has a separate, fail-closed arm64-macOS observation
that does not promote the global component capability manifest. Bob and the
local Extender built the current example custom engine; the harness launched it
from the archive directory and required exact markers for Defold 1.14.0, the
`default-legacy-bullet` 253-symbol profile, bundle generation 1, the first
TypeScript GUI render, the first TypeScript update/render, and the first
extension update. The game-owned markers are emitted only after its generated
GUI proxy has attached the TypeScript
component, resolved the fixed node pools, completed all first-render
`gui`/`vmath` calls, posted input focus, and completed the next update/render.

After the update marker, the process remained free of error/fatal/script/traceback,
bundle-rejection, missing-provider, and component-runtime diagnostics for a
1.5-second settling window, then reported an actual `SIGTERM` process exit. The
checked JSON records the complete packaged extension and authored project tree,
source locks/plans, engine, archive data/index, compiled project, manifest, and
bundled JavaScript hashes, plus a canonical 20-line transcript digest and
deterministic aggregate keys; it intentionally contains no timestamp. The scope
excludes Static Hermes, HTML5, other component contexts and lifecycle
combinations, whole-API conformance, allocation/leak evidence, and multiplayer
transport.

This run does not measure thread-local storage. The repository's separate
367,872-byte Static Hermes universal-frame TLS figure is an exact observation
for its tested native host configuration and is platform/toolchain/ABI scoped;
it is neither a cross-target constant nor evidence from this Dynamic Hermes
War Battles run.

The harness is available as `pnpm runtime:packaged`, with explicit record and
stale-artifact check variants in the War Battles workspace package.

## War Battles in a browser on 2026-09-18

The War Battles port is a component-only bundle: its behaviour lives entirely in
generated Lua component proxies that attach TypeScript components. Before this
change the HTML5 extension installed a fail-closed component API, so every one
of its scripts errored at `init` and the bundle never loaded. Three independent
gates were stale against the universal browser lane:

1. the HTML5 branch of `InitializeExtension` registered the unavailable
   component API instead of a provider;
2. the browser bootstrap rejected any bundle without `__defoldAppV1`;
3. the SDK's per-family browser gates threw for 77 value routes and 24
   fixed-tuple routes that the canonical plan already marks `emit` for
   `browserWasmHost`.

All three were fixed at their source. A fresh `wasm-web` bundle was then built
through the pinned local Extender and driven by
`examples/war-battles-online/integration/check-browser-runtime.mjs`, which
serves the bundle on a scoped loopback port, launches a dedicated headless
Chrome profile, reloads once, asserts the marker set, and tears down the server,
browser, and profile it created:

```sh
/opt/homebrew/opt/openjdk@25/bin/java -jar build/tooling/bob.jar \
  --root examples/war-battles-online/defold \
  --output build/bob --bundle-output build/bundle \
  --platform wasm-web --architectures wasm-web --variant debug --archive \
  --build-server http://localhost:9010 \
  resolve build bundle

pnpm test:html5:war-battles
```

The gate exited zero and recorded
`examples/war-battles-online/evidence/browser-runtime-wasm-web.json`. The
browser reported `engineStarted`, `hostRuntime: "browser"`, script bridge target
`html5-browser-host`, five registered components, and bundle fingerprint
`384587f0da2ed4a92cd76fb48b3c648061f7d63917c177d3335e407c4d8bae66`, identical to
the source `deherm/app.dehermc`. The run emitted, in the engine's own log,
every required game-owned marker: `camera-init` and `camera-bounds`, `ui-init`,
`player-init:560.0:360.0`, `player-fire:560.0:360.0:1.00:0.00`,
`rocket-init:1.00:0.00`, `rocket-hit`, `score:100`,
`rocket-explosion-done`, `player-moved:1592.0:1072.0`, and eleven `camera:`
samples covering the `none`, `x`, and `xy` clamp states. There was no JavaScript
exception and no page error other than the ignored `favicon.ico` 404.

This is the tutorial's whole demonstration chain executing in a browser:
component attachment in three contexts, editor property specialization, a
factory spawn whose spawned object attaches its own component, a Box2D
collision message, a sprite animation completion callback returning through the
browser callback trampoline, GUI node mutation, and a camera following the
player across a scrolling world into both clamps.

It is not a visual claim. Nothing in this repository inspects the canvas. The
evidence is the marker transcript, the CDP-observed page state, and the absence
of page errors. It also does not promote Static Hermes, the production external
bundle loader, input handling from a real device, audio, or whole-API browser
conformance.

## Fresh WebGL and keyboard observation on 2026-09-22

A fresh `wasm-web` debug bundle was built from the current War Battles tree
through `scripts/bob-local.sh bundle` and the pinned local Extender. The first
link exposed a real Emscripten 4.0.6 incompatibility: the debug component bridge
stored browser native functions and `BigInt` values directly in an Emscripten
library object, whose linker serializer cannot encode `BigInt`. The source
template now keeps serialization-safe null slots and captures the pristine
browser intrinsics at runtime immediately before evaluating application code.
The release-variant generator continues to strip this debug inspection path.

The rebuilt bundle completed at fingerprint
`2f8c022bee455ca3794ffa3e3f0a632f136c6a1b58484e029d0d1981096badb9`.
The packaged runtime gate then observed Defold 1.14.0, the
`default-legacy-bullet` profile with 315 generated Lua symbols, bundle
generation 1, all tutorial/gameplay markers, and the eight-player offline arena
without a page failure. The gate now treats the generated-symbol count as a
positive runtime measurement rather than a pinned API identity, and it clears
its transcript before asking Chrome to reload so a late
`executionContextsCleared` event cannot erase startup evidence from the new
document.

A separate Chrome DevTools Protocol observation exercised the rendered game,
not only its log. Chrome ran the bundle with WebGL enabled through ANGLE and
SwiftShader and reported WebGL 2.0 / OpenGL ES 3.0, GLSL ES 3.00, a 756 by 425
canvas, depth and stencil buffers, and a live context. A screenshot before
input was 58,751 bytes with SHA-256
`411129321c3168e23f55ac09870c75f0e9a240998add849cafbfbe834813e9e0`;
after a real CDP `D` key-down/key-up sequence it was 82,690 bytes with SHA-256
`3c48f346a5e2c0f2bb92c90768da0e95579235fbf2061b5ff7c9c90782935a26`.
The framebuffer changed, the game emitted
`war-battles:arena-engaged:players=8:skill=2:seed=1463898690:mode=offline`,
and the camera target moved right from approximately -39.8 to -22.0. The two
temporary screenshots were inspected locally: the first shows the tutorial
tank, textured grass, score, controls and wall edge; the second shows the full
arena with tanks, pickups, walls, HUD and frag list. They are observations, not
repository fixtures.

The debug control plane simultaneously reported generation 1, component
revision 1, 49 live component instances within the fixed 1,024-slot capacity,
and a complete component snapshot with no omitted instances. Hermes heap data
was correctly unavailable because the browser-host target uses the browser's
JavaScript engine rather than embedding Hermes. This evidence proves the fresh
HTML5 artifact starts, renders through WebGL 2, accepts keyboard input, changes
game state and exposes live telemetry on this local software-rendered Chrome
configuration. It does not measure hardware-GPU performance, audio,
internet-hosted multiplayer, native Hermes execution, leaks or sanitizers.

# Open evidence gaps

The next promotion gate should rebuild this proof from a clean checkout in
automation, retain the Extender and engine stdout as artifacts, execute a
bounded shutdown path, run leak/undefined-behavior instrumentation where the
platform permits it, and repeat the conformance fixture per supported target.
Until those gates pass, this note remains an exact local proof rather than a
portable or memory-safety certification.
