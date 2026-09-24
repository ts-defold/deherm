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

## Bounded knowledge retrieval

Agents and contributors should query the OKF bundle instead of loading it as a
single prompt. `pnpm knowledge:search -- <terms>` returns at most twelve ranked
document locations by default; open only the matched documents and relevant
sections. `pnpm knowledge:outline -- <document>` returns only its headings and
line numbers; `pnpm knowledge:metadata -- <document>` returns bounded,
top-level single-line frontmatter fields plus the document's content digest
without its body. `pnpm knowledge:section -- <document> <heading terms>`
returns one matching section, bounded to 200 lines. The index is for navigation
work, not mandatory startup context.

For callers that compose one query string, `pnpm knowledge:search --query
"<terms>" --limit <n>` is equivalent to positional terms plus `--max <n>`.
Every subcommand accepts `--help` without refreshing the index.

`pnpm knowledge:links -- <document>` lists mechanically derived outgoing
references, while `pnpm knowledge:backlinks -- <document>` finds references to
the document or any of its headings. Both commands return at most twenty edges
by default and accept `--max` up to the global fifty-row ceiling.

Large generated policies, inventories, and evidence objects stay behind their
owner commands, which should report bounded summaries rather than print the
objects themselves.

These commands refresh a disposable SQLite graph below
`.deherm/cache/okf-index.sqlite`. Documents and headings are content-addressed;
local source references carry only their path and digest. Explicit Markdown,
frontmatter, ownership, generation, and verification references become graph
edges. `pnpm knowledge:sql -- <query>` exposes a bounded, physically read-only
SQL escape hatch for precise joins without injecting the corpus into context.
Concurrent commands share the disposable cache safely: a writer waits for up
to five seconds for an active refresh transaction before reporting contention.

# Commands that work now

| Intent | Command | Result |
| --- | --- | --- |
| Launch the project/scaffold TUI | `pnpm cli` | Discovers projects; starts dev, doctor, or scaffolding |
| Run the War Battles edit loop | `pnpm extender:start`, then `pnpm --filter @deherm/example-war-battles-online dev` | Rezi console using the pinned local Extender; press `p` to launch/stop the built engine |
| Capture a Hermes CPU profile | `deherm profile cpu --project <path> --duration 10000` | Writes a standard `.cpuprofile` from the running native dev session |
| Capture a Hermes heap snapshot | `deherm profile heap --project <path>` | Streams a standard `.heapsnapshot` without retaining it in the CLI heap |
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
| Gate symbol-level reachability | `pnpm test:reachability` | Fixture project; checker/module-graph cross-check; dead-symbol retention through the emitted C |
| Check Static Hermes declarations/export unit | `pnpm check:static-hermes` | Parses `extern_c` and proves a library-shaped exported unit without `main` |
| Generate the typed-native JS bridge | `pnpm generate:typed-native-bridge` | Sound-typed unit that replaces `__defoldScriptBridgeV1` with the AOT lane, claiming the plan's `staticHermesCAbi` routes |
| Assemble `shermes -emit-c` into a project | `pnpm exec deherm assemble-typed-native --project <dir> [--target <platform>] [--profile]` | Materialises `<dir>/defold_hermes_typed_native/` for Bob and Extender; refuses a non-Hermes target with `typed-native-requires-hermes-runtime` and exit 3 |
| Decide a target's typed-native upload | `pnpm exec deherm assemble-typed-native --project <dir> --target <platform> --reconcile` | No `shermes`; maintains the project's `.defignore` so Bob cannot upload a Hermes-runtime unit to a browser-runtime target |
| Exercise the cached Lua bridge | `pnpm test:lua-hermes` | Hermes -> JSI -> C ABI -> Lua -> callback |
| Stage the native extension | `pnpm package:defold` | Defold package directory/archive inputs |
| Prepare pinned local Extender | `pnpm extender:prepare` | Builds the pinned jars and maps the installed Xcode SDK |
| Start/inspect local Extender | `pnpm extender:start`; `pnpm extender:status`; `pnpm extender:logs` | Standalone macOS service on port 9010 |
| Compile the real Defold project | `pnpm bob:local:build` | Starts a temporary pinned Extender when needed, then builds with Bob |
| Produce a desktop app bundle | `pnpm bob:local:bundle` | Writes `build/bundle/Defold Hermes Spike.app` |
| Prove the bundled native runtime | `pnpm test:native-defold:runtime` | Rejects stale archives, launches the app, and checks real Hermes, Lua-API, and update-lifecycle markers |
| Run headless contract conformance | `pnpm test:headless-conformance:runtime` | Generates per-contract fixtures from their fixture profile, compiles content with Bob, links the in-process headless engine driver, asserts the engine's detected runtime profile matches the plan, and records contract -> observed/mismatched/blocked/unreachable |
| Build/bundle the HTML5 game | `pnpm bob:web:build`; `pnpm bob:web:bundle` | Uses pinned emsdk 4.0.6 through local Extender |
| Verify a running HTML5 bundle | `pnpm test:html5:runtime` | Reload-synchronized CDP lifecycle and binding proof |
| Prove the packaged HTML5 port executes | `pnpm test:html5:war-battles` | Serves the bundle on a scoped loopback port, drives headless Chrome, asserts the marker transcript |
| Prove the HTML5 edit loop | `pnpm test:html5:war-battles-hot-reload` | Runs `deherm dev --web`, edits a source, and requires the page to acknowledge that exact new fingerprint |
| Reuse a running local Extender | `pnpm bob:build`; `pnpm bob:bundle` | Local port 9010 is the default |
| Measure binding-transport cost | `pnpm bench:transports` | Raw Lua, lua-stack, c-abi-native, typed-native, all uninstrumented |
| Measure with telemetry on | `pnpm bench:transports:profiled` | Same binary with `DEHERM_PROFILE=ON`; also drains the telemetry ring |
| Prove the telemetry compiles out | `pnpm test:profile-compile-out` | Builds both ways and reads the artifacts with `nm` and `strings` |

`build:js` now also resolves **symbol-level Defold reachability**. It derives a
script route symbol index into `build/ttsc/script-route-symbol-index.json`,
runs the deherm ttsc plugin with `routeSymbols`/`apiUsage` pointed at
`build/ttsc/`, and joins the checker's whole-program manifest to each
entrypoint's retained inputs. The result lands in
`dist/<entry>.defold-api-usage.json` beside the existing module-level
`dist/<entry>.usage.json`, and the build prints one reachability line per
entrypoint. The bundle itself is read back as an independent derivation - the
generated SDK dispatches through `callScriptApi(<stableId>, args)` - and the
build fails if the two disagree.

A generated project gets the same thing without extra configuration:
`deherm generate` writes `.deherm/generated/script-route-symbol-index.json`
beside the resource symbol table and points the generated ttsc plugin entry at
it, so every `pnpm dev` rebuild republishes
`.deherm/generated/defold-api-usage.json` and the operator console shows what a
release build would retain. Nothing in that path prunes what is linked.

Plugin-entry configuration keys, all optional:

| Key | Meaning |
| --- | --- |
| `routeSymbols` | Path to the script route symbol index. Without it, no manifest is produced. |
| `apiUsage` | Where to write the usage manifest. Absent means the pass does not run. |
| `profile` | `development` (default) records dynamic access; `release` refuses it unless declared. |
| `dynamicApiAccess` | Declares that the project indexes the generated surface by computed name and accepts the complete surface. |

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

The same release root also carries `canonical/<target>/typed-native/`: the
tier-2 lane re-rendered over the reachable set, plus a manifest naming the C
symbols it retained and the ones it pruned. `scripts/build-static-hermes.mjs`
takes `--typed-native-source <path>` to compile that pruned lane instead of the
complete one, so `shermes -emit-c` emits no symbol for a route nothing calls.
Without the flag it compiles the complete lane, which is what development wants.

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

Bob walks the Defold project root, so every scaffold and every generation pass
maintains a package-owned block in `.defignore`. The block hides dependency,
cache, editor, VCS, package-manager, déherm lock/config, and raw TypeScript
authoring inputs (`.ts`, `.tsx`, `.mts`, and `.cts`). Pinned Bob treats these
entries as absolute path prefixes rather than globs, so it names files
individually rather than excluding their containing directory, keeping generated
`.script`, `.gui_script`, and `.render_script` proxies visible. User-authored
ignore rules remain outside the block and are preserved. This gives Bob the
smallest safe project view while leaving Defold's resource graph authoritative
for actual game assets.

# Bundle freshness before Bob

Bob archives whatever `/deherm/app.dehermc` is on disk as a `custom_resources`
entry and relates it to nothing. A project whose bundler has not run since the
last TypeScript edit therefore packages old code silently - this has happened
once already, as a stale `game.arcd`.

Each successful bundle build records, in `deherm.lock` under `buildArtifacts`,
the artifact's published `__DEFOLD_HERMES_BUILD_FINGERPRINT__`, its content
hash, the build settings that produced it, and the SHA-256 of every file the
bundler read. `deherm verify-bundle` recomputes that binding from the working
tree:

```sh
pnpm exec deherm verify-bundle --project <project>   # exit 1 when stale
pnpm exec deherm verify-bundle --recompute           # also re-bundle and name the exact fingerprint
pnpm exec deherm verify-bundle --allow-unbound       # report, do not fail, an artifact with no binding
```

`--no-ttsc` is a diagnostic escape hatch, not a packaging mode. It deliberately
keeps source-level calls such as `hashLiteral("#fire")` in the JavaScript so a
browser or engine session can be inspected, but that bundle must never cross
the Bob seam. `verify-bundle` marks a recorded bundle built with transforms
disabled as an error even with `--allow-unbound`; `verify-generated` applies the
same gate, and `scripts/bob.sh` runs `verify-bundle` before Bob. The normal
development path is `deherm dev --once`, which rebuilds with transforms
enabled.

This guard was added after a real failure: a War Battles diagnostic bundle
retained the runtime `hashLiteral` call and reached the packaged Wasm output.
The retained runtime call, rather than the browser host, was the cause; a
diagnostic build is still useful for inspection, but it is not valid Bob input.

The default check is a hash comparison over the recorded inputs, not a
recompile, so it is cheap enough for a pre-Bob step and for every rebuild.
`scripts/bob.sh` runs it before invoking Bob; `DEFOLD_HERMES_SKIP_BUNDLE_CHECK=1`
skips it.

On a mismatch it names both fingerprints - the one `deherm.lock` records for
these sources and the one on disk - and lists the source files that changed.
Distinct states are reported distinctly: sources moved (`stale-sources`), the
artifact is not the recorded one (`artifact-replaced`), the artifact disagrees
with its own published fingerprint (`artifact-corrupt`), nothing binds it
(`unbound`), or it does not exist (`artifact-absent`). `--recompute` bundles the
current sources into a scratch directory and clears the failure when they
compile to the artifact already on disk, which a discarded edit does.

Both supported workflows pass through the same binding. If the bundle and the
materialised extension sources are committed artifacts, the binding is committed
with them and Bob's machine needs no compilers; if déherm runs on the build
machine, the rebuild rewrites the binding before Bob reads it. The check needs
no network and never rebuilds on its own.

The `generated-sources` artifact kind records the same relation for files
assembled into the extension before Bob uploads it - `shermes -emit-c` output
and per-extension FFI glue.

## Assembling the emitted C

`scripts/assemble-typed-native-extension.mjs` is the consumer of that kind. It
concatenates the universal-value lane with the generated typed-native bridge,
runs `shermes -typed -strict -O -emit-c` over the pair, and materialises the
result as a project-local extension, `<project>/defold_hermes_typed_native/`,
which Bob uploads and Extender compiles like any other extension source. The
user still compiles nothing natively.

### The unit belongs to one runtime

A `shermes -emit-c` unit is a transport of the **`hermes` runtime**, not a
platform-neutral optimisation: its emitted C calls `_sh_*` entry points that
only `libhermes.a` defines, and the canonical plan gives `staticHermesCAbi` the
runtime id `hermes`. The `browser` runtime embeds no Hermes, so such a unit is
meaningless for `wasm-web` and uploading one fails the link on undefined
symbols rather than changing a transport.

Bob discovers extensions by walking the project for `ext.manifest`, and an
`ext.manifest` cannot exclude a platform - Extender compiles every `src/` file
it is handed. The gate therefore lives at the two seams that decide what Bob
sees, in `packages/cli/src/typed-native.mjs`:

* `typedNativeDisposition(platform)` answers from pinned data alone - the
  bundle-target table generated from Extender's `build_input.yml` and the
  native-artifact manifest's declared builder, which must agree. The assembler
  refuses a non-Hermes target with the code `typed-native-requires-hermes-runtime`
  and exit 3, and an unknown platform fails closed rather than being guessed.
* `reconcileTypedNativeUpload({ projectRoot, platform })` makes the answer true
  on disk by maintaining one `.defignore` entry before Bob walks the project.
  `scripts/bob.sh` and the dev session's builder both call it, in both
  directions, so a unit a native build paid for is hidden from a web build and
  revealed again by the next Hermes build. The files are never deleted.

Each generated source additionally carries `#if defined(__EMSCRIPTEN__) ...
#error "deherm typed-native-requires-hermes-runtime: ..."`, so anything that
bypasses the gate gets one named compile error instead of a pile of undefined
`_sh_*` symbols at link time.

It is a sibling extension rather than files inside `defold_hermes/` because the
shared extension is per-release while the emitted unit is per-project. Nothing
in `defold_hermes/` changes per project: the assembled extension declares its
own Defold extension symbol and hands its unit to the runtime through
`defold_hermes/static_unit_registry.h` from `AppInitialize`, and `runtime.cpp`
evaluates whatever the registry holds into the Hermes runtime before the
bytecode bundle is loaded. With nothing registered the behaviour is exactly the
bytecode-over-JSI behaviour that preceded the seam.

Three things are adapted, because Extender merges every `ext.manifest` context
into one per-build setting and drives all sources through `clang++`, so the C++
standard `defold_hermes` asks for lands on the emitted unit too:

* a tentative array definition (`static T name[];`) has no C++ spelling, so the
  real definition is hoisted over the forward declaration;
* `void*` converts implicitly only in C, so a generated prelude gives each
  `extern_c` callee a `void*` overload that casts back, derived from the same
  pinned declarations `extern_c` pointed at;
* `calloc`/`malloc` results are cast explicitly.

Each transform asserts it applied, so an upstream emitter change fails in the
assembler rather than inside Extender. The unit also compiles with `NDEBUG`
matching the packaged `libhermes.a`, which the assembler reads out of the
archive's own symbol table - Hermes enforces the agreement with a link-time
model symbol.

`--profile` additionally materialises
`defold_hermes/include/defold_hermes/generated_build_config.h` with
`DEHERM_PROFILE`, because Extender has no configure step. The shipped skeleton
defines nothing, and this checkout's CMake build is unaffected either way: it
always defines `DEHERM_PROFILE_BUILD_SYSTEM`, which the generated header defers
to.

# Published npm CLI

The npm package now exposes project inspection and generation:

```sh
pnpm exec deherm
pnpm exec deherm create my-game --name "My Game"
pnpm exec deherm doctor
pnpm exec deherm extensions
pnpm exec deherm generate
pnpm exec deherm assemble-typed-native --target arm64-macos
pnpm exec deherm materialize-dmsdk --usage deherm.dmsdk.json --output generated/dmsdk-provider.cpp
pnpm exec deherm typecheck
pnpm exec deherm verify-generated
pnpm exec deherm verify-bundle
pnpm exec deherm language-server --stdio
pnpm exec deherm debug
```

The npm package contains no platform `.a`/`.lib` archive and no generated
`libhermesvm-config.h`. A generated project locks the Defold-owned target matrix
and the published release mapping. The first native build downloads only the
selected target archive into the normal per-user déherm cache
(`DEHERM_CACHE_HOME`, XDG, macOS Library/Caches, or
`%LOCALAPPDATA%/deherm/cache` on Windows),
installs its release library, debugger library, and matching generated config
into the project extension, and records every member hash. Later projects reuse
the cached archive.

The host executables are not npm packages either. `hermesc`/`shermes` and
`dehermc` are separate content-addressed release families, fetched for the
current host into `<user-cache>/toolchains/<tag>/<host>/`. Set
`DEHERM_TOOL_CACHE` only when CI or an offline environment needs an explicit
cache root.

`materialize-dmsdk` writes a deterministic production/verification set. Each
member is replaced atomically and the binding manifest is published last, so a
reader can reject an interrupted or mixed set from its content hashes. For an
`--output generated/dmsdk-provider.cpp` invocation the files are:

```text
generated/dmsdk-provider.cpp              production usage-pruned provider
generated/dmsdk-provider.cpp.json         keyed production manifest
generated/dmsdk-provider.verify.cpp       exact-call provider and fake-callee ABI
generated/dmsdk-provider.verify.json      content-addressed verification vectors
```

The verification C++ deliberately leaves each uniquely named fake callee for a
test harness to define. Its signature is generated from the same resolved
receiver, substitutions, native parameter types, and result type as the
production call. The manifests bind the members of the set, and `--check`
verifies all four files together; deleting or editing any one requires
rematerialization.

These are the installed-package commands verified from a local tarball. The
package name is not published yet; in this checkout use `pnpm cli --` before
the command and options. No arguments launches the TUI; `create` works before
any `game.project` exists.

`generate` and `dev` resolve the project's Defold engine revision before they
read anything version-specific, and refuse rather than assume one - see
[API source resolution](decisions/api-source-resolution.md). `--defold-sdk <sha>`
states it outright and always wins; `--bob <path>` (or `DEHERM_BOB`) points at a
Bob jar to be asked for its own engine sha1. A project that names no revision is
a blocker listing every source that was checked, and a revision this package has
no generated surface for is a blocker rather than another revision's types.

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
deherm.lock                   project-side copy of the generation contract and the
                              bundle-to-source freshness binding
tsconfig.deherm.base.json     shared TS 7 + future ttsc configuration
tsconfig.deherm.shared.json   ordinary context-free `*.ts`
tsconfig.deherm.game-object.json  game-object `*.script.ts`
tsconfig.deherm.gui.json      GUI `*.gui.ts`
tsconfig.deherm.render.json   render `*.render.ts`
tsconfig.deherm.bundle.json   unfiltered runtime SDK used only to compose mixed-context bundles
tsconfig.deherm.json          solution referencing all four contexts
tsconfig.json                        created only when the project has none
.vscode/extensions.json              preserves user entries and adds the ttsc + déherm recommendations
.vscode/settings.json                created only when absent
.vscode/launch.json                  created only when absent; attaches through the déherm DAP
```

Existing root `tsconfig.json`, VS Code settings, and VS Code launch files are
never overwritten. The extension recommendation file is merged by adding only
missing déherm-owned recommendations and preserving every user entry. Run
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
`verify-generated` also reports the bundle freshness binding described below;
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
`declarationId` against the revision-matched policy catalog already materialized
at `.deherm/ir/dmsdk-universal-bindings.json`, and emits a
single usage-pruned C++ provider plus a hash-bound JSON report. Concrete
functions need only their declaration identity; templates, records, receivers,
and ambiguous native types supply the explicit materializer fields recorded by
their recipe. Outside a generated project, pass
`--catalog <defold-dmsdk-universal-bindings.json>` explicitly. `--check`
verifies both outputs byte-for-byte without writing.
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
changes restart an engine that the operator launched manually. Authored
`.input_binding` changes take the same restart lane because Defold's active
collection retains the input action table created with its input stack even
after the compiled resource reload succeeds. The TUI logs the exact
restart-required sources instead of presenting the resource acknowledgement as
an HMR activation, and input-binding-only batches bypass the TypeScript
compiler so an unchanged bundle is not signalled as a new generation. The
watcher excludes `.internal`, `.deherm`, build outputs, and generated proxies so
editor cache churn and self-authored outputs do not form rebuild loops.

`deherm language-server --stdio --project <game.project>` is the installed,
editor-neutral Defold semantic server. It consumes
`.deherm/generated/resource-symbols.json` and contributes project resource
paths, collection/component addresses, declaration hovers, and definitions.
It reloads that generated index when the watcher reports a change and keeps
missing or malformed generated state as an actionable request error rather
than crashing the process. It intentionally does not duplicate normal
TypeScript diagnostics, completion, TSDoc hover, navigation, or refactors;
those remain owned by VS Code's TypeScript service.

The thin `editors/vscode` extension is a separate VSIX artifact. It discovers
each `game.project`, resolves only the workspace-local
`@ts-defold/deherm/bin/deherm.mjs`, starts one scoped LSP client per project,
and contributes the `deherm` debug type. It does not embed the compiler or
runtime; its bundled client is the only executable content in the VSIX. A
missing local package produces an install instruction rather than silently
using a global or mismatched compiler. Protocol processes use the Node.js
22.13+ executable resolved from `PATH`; `deherm.nodePath` is the resource-scoped
override when the editor's GUI environment does not inherit that path.

While that dev session is running, `deherm debug --project <game.project>`
starts the editor-neutral Debug Adapter Protocol server on stdin/stdout. It
reads the private `.deherm/dev/inspector.json` descriptor, authenticates the
exact loopback CDP target, and projects authored `.ts` source maps onto Hermes
breakpoints, stack frames, scopes, variables, watches, stepping, exception
policy, and HMR breakpoint reapplication. A native session owns one debugger
frontend; `--replace-debugger` is an explicit opt-in when another frontend is
already attached. The command is intended for a VS Code debug-adapter client,
not an interactive terminal; the generated launch configuration and thin
extension now provide that client.

The dev bundle does not feed printer-only transformed TypeScript into esbuild.
That text has already lost authored whitespace and comments, so a structurally
valid map would bind later lines to the wrong instructions. The CLI runs the
same shipped `dehermc` transforms through TypeScript-Go's mapped JavaScript
emitter, inlines each compiler map at the original module path, and lets esbuild
compose the final bundle map before `hermesc` consumes it. The regression suite
asserts that an authored War Battles statement maps to the exact emitted
statement, not merely to some valid generated location.

With a War Battles `pnpm dev` session running, the live native proof is:

```sh
pnpm --filter @deherm/example-war-battles-online runtime:debug
```

It launches the public stdin/stdout DAP command, installs a breakpoint on the
permanent arena component, requires a real `stopped` event, checks that the top
frame maps back to the authored `*.script.ts` line, evaluates the live `dt`
local, resumes, and disconnects. It then repeats the whole flow in a second
process, proving that frontend detach resets the private engine transport and
Hermes CDP agent before reattachment. This is native packaged-engine debugger
evidence; it is not a VS Code/LSP claim.

The browser twin uses the same authored map and public DAP command against the
CDP endpoint already owned by the packaged HTML5 target:

```sh
pnpm --filter @deherm/example-war-battles-online runtime:debug:browser
```

For a manual client, select the browser session explicitly:

```sh
deherm debug --project <project> \
  --inspector-session .deherm/dev/browser-inspector.json
```

The gate requires a packaged `wasm-web` bundle, waits for the Defold browser
host, activates the current development bundle, then verifies an authored
`arena.script.ts` breakpoint, mapped stack frame, live `dt` evaluation,
continue, and detach. Browser inspector discovery authenticates Chrome's exact
dynamic target WebSocket. Breakpoints use the stable
`defold-hermes://app(?:.<generation>).js` URL family, so they are reapplied to
numbered HMR generations. This is real Chrome/Defold Wasm/DAP evidence; it does
not claim VS Code UI or language-server behavior.

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
The Instances view consumes the private `deherm-dev-v1` component snapshot.
For each connected native or browser target it shows the runtime-local
`slot:generation` identity, the generated TypeScript source when the component
id and schema fingerprint match, a visible stale/unknown schema state, and the
bounded own-data property projection. Before a genuine snapshot arrives it
shows an explicit waiting state and keeps the older aggregate component/root/
Lua-handle counters separate; it never fabricates per-instance rows from those
counts.

Native debugger builds sample at most every 250 ms while the loopback inspector
is connected. Release builds expose no sampler. Browser snapshots use the same
schema through `globalThis.__defoldHermesDevV1.componentSnapshot()` in debug
artifacts. The CLI package owns immutable marker-bearing web templates; the
checked-in/npm extension is generated release output, and `deherm` materializes
the exact requested debug or release variant into the project before Bob reads
it. Browser dev always requests a fresh debug `wasm-web` bundle before first
launch, even when a previous bundle exists. Both paths
retain at most 32 declared properties per component, bound strings to 256 UTF-8
bytes, omit only whole instances when the 512 KiB frame limit is reached, and
inspect own data descriptors without invoking getters or walking prototypes.
Structured values are observed only while their engine-crossing identity is
unchanged. Replacing or deleting one with a scalar, function, accessor, or
different object releases its trusted root. Browser output construction uses
captured intrinsics, literal bigint bounds, and own data properties so Proxy
traps, poisoned reflection, replaced `BigInt`, and prototype setters cannot be
triggered by passive telemetry.

The private `.deherm/dev/inspector.json` descriptor also carries `stateUrl` and
`authToken`. An editor may poll that loopback URL with `Authorization: Bearer
<authToken>` and `If-None-Match`; the response is `no-store`, has no CORS
permission, and projects all current native/browser targets without returning
the credential. The response budgets complete schema-enriched instance rows
fairly across targets below the editor's two-MiB intake ceiling and reports exact
omission totals; the TUI's in-process model is not truncated by this editor-only
projection. Normal session logs record only snapshot counts and sequence;
full property values appear only in the explicit JSON event stream and the
authenticated state response.

The VS Code client polls that state once per second with ETag revalidation, a
one-second timeout, redirects disabled, and a two-MiB response cap. It places a
restrained CodeLens at the top of an owning `.script.ts`, `.gui.ts`, or
`.render.ts` file: at most six exact-schema instances and three bounded values
per instance. Source ownership is accepted only from the server-enriched
`target.instances` projection. Raw runtime rows are never joined locally, and
disconnected, replaced-session, failed, or older-than-five-second state clears
instead of presenting stale values.

A fresh local-Extender arm64-macOS War Battles build exercised this path through
the installed-style public dev command. Its packaged Defold engine connected as
the native Hermes target, emitted monotonically advancing snapshots, and the
authenticated endpoint joined current schemas for arena, camera, UI, player,
tank, pickup, and rocket instances with zero omissions. This records the live
engine-to-control-plane seam; the final VS Code acceptance still requires a
visual editor observation rather than inferring UI rendering from client tests.

`deherm dev` also classifies every line it emits and accumulates defects into
`<project>/.deherm/dev/bug-pool.json`, deduplicated by a normalized signature so
one defect collapses to one entry across runs. `deherm bugs` harvests the session
log and any packaged-run transcripts into that pool and prints it:

```sh
npx deherm bugs                        # harvest and print
npx deherm bugs --json                 # machine-readable pool
npx deherm bugs --no-harvest           # print what is already stored
npx deherm bugs --transcript run.log   # fold in a packaged-run transcript
```

The pool records how deherm itself behaved during runs. It is a reporting
surface, never a gate - it always exits 0 - and a pool entry must never be
promoted into a completion-matrix row. See
[Runtime bug pool](research/runtime-bug-pool.md).

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
