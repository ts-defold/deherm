---
type: Architecture Decision
title: Ship precompiled target libraries and host tools, and emit C into the extension for Bob
description: CI builds Hermes per target in containers and cross-compiles dehermc for every host from one job, the package vendors those plus per-host hermesc/shermes, and generated C is assembled into the extension so Bob and Extender compile it - locally or in the cloud.
tags: [decision, packaging, toolchain, bob, extender, static-hermes, ci]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-18T23:50:00-04:00 }
sources:
  - id: build-input
    resource: ../../../upstream/defold/share/extender/build_input.yml
    title: Extender platform definitions for the pinned engine
    author: team:defold
  - id: defold-sdk-versions
    resource: ../../../upstream/defold/build_tools/sdk.py
    title: Engine SDK, NDK and deployment-target pins
    author: team:defold
  - id: product-contract
    resource: ./generator-product-contract.md
    title: Ship a deterministic API compiler, not hand-authored bindings
    author: project:deherm
  - id: policy-cache
    resource: ./layered-api-policy-cache.md
    title: Layered API policy cache
    author: project:deherm
  - id: bob-variants
    resource: ../../../upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/Bob.java
    title: Bob bundle variants and build server selection
    author: team:defold
---

# The division of labour

Three parties compile something, and conflating them has already caused
confusion in review.

| Artifact | Built by | When | Varies with |
| --- | --- | --- | --- |
| `libhermes.a` | this project's CI | per release | Defold **target** platform |
| `hermesc`, `shermes` | this project's CI | per release | user's **host** platform |
| `dehermc` | this project's CI | per release | user's **host** platform |
| generated C from TypeScript | `shermes` on the user's host | per build | the user's project |
| extension objects and the engine | Bob → Extender, local or cloud | per build | target platform |

The user compiles nothing natively. `shermes` emits C as text; Extender turns
that text into objects and links it against the precompiled `libhermes.a`.

The third row is what makes that sentence true rather than aspirational.
déherm's TypeScript transforms are written against the typescript-go checker,
so they are Go, and ttsc built them **on the user's machine, at build time**.
Ttsc's own message warns that build "can take several minutes on a cold Go
cache"; a first run in `tests/package-smoke.test.mjs` was observed at 40 seconds.
See *The transform compiler* below.

# Target libraries

`libhermes.a` is the Hermes VM, JSI and `boost_context` merged into one archive,
with the unreferenced `zip.c.o` removed so Extender's force-load does not hit
duplicate symbols, built with `libtool -D` so it is byte-reproducible. It is
vendored under `defold/defold_hermes/lib/<target>/` and ships in the npm
package, because Bob uploads it to Extender for whichever platform is being
bundled.

It is therefore indexed by **Defold target**, never by the user's host. A user
on macOS bundling for Android needs the Android archive and none of their own.

CI builds each target in a container and publishes it as a **GitHub release
asset**; `scripts/manage-native-artifacts.mjs pull` vendors them and records each
digest. `toolchains/hermes/` already holds the Linux and Windows container
definitions. Release assets rather than workflow artifacts, because a workflow
artifact expires, is scoped to one run, and needs an authenticated API call to
fetch - none of which survives to a user six months after a release. The tag is
derived from the SHA-256 fingerprint of the inputs that determine the artifact,
so the artifacts are content-addressed: many déherm versions share one release,
and a rebuild whose inputs have not changed finds the release already present
and does nothing.

Each asset is one reproducible `.tar.gz` per matrix row, written by
`toolchains/hermes/package-archive.sh`. A target's archive carries its release
library **and** a debugger-enabled second compilation; a host's carries that
family's compilers. A release asset is a single file, so two libraries could
never have been two assets - and a flat asset also loses the executable bit,
which GitHub does not store, and encodes structure in a name the download side
then has to parse back out. `pull` extracts with `tar -xzf`, which is present on
macOS, on Linux, and on Windows 10 1803 and later as bsdtar, so the URL-only
vendoring path still needs no second CLI and no npm dependency.

## What a fingerprint may hash, and what it may not

See *Three families, three tags* below. The short version: a family hashes the
`upstream.lock` **keys** it consumes and the **fields** of a generated manifest
that decide its codegen, never a whole file. Hashing all of `upstream.lock` made
`libhermes.a` a function of `DEFOLD_REV`; hashing all of
`defold-bundle-targets.json` would put that coupling straight back, because that
file carries `defoldRevision` and `sourceSha256` beside the `sdk` pins that
actually matter.

Every Defold bundle target must appear in `packages/toolchains/native-artifacts.json`
with an explicit status. A target that is absent from the manifest is worse than
one marked `required-missing`, because the user gets silence instead of a
blocker naming the platform.

## The target list is derived, never hand-written

`scripts/generate-defold-bundle-targets.mjs` reads the pinned engine's own
`share/extender/build_input.yml` - the file Extender itself consults to decide
what it can build - and writes `packages/toolchains/defold-bundle-targets.json`.
The structural rule is Extender's: a `platforms` key without `-` is a shared
group context, a `<arch>-<group>` key is selectable, and a selectable key with an
empty body is one upstream retired but kept so old manifests still parse
(`x86-osx` today). The same pass derives the NDK revision, the Android API
levels and the iOS/macOS deployment minimums from `build_tools/sdk.py`, because a
cross build against a different level than the engine's own is an ABI mismatch
Extender would only find at link time.

`manage-native-artifacts.mjs verify` compares the manifest against that derived
list in both directions, so a Defold release that adds a bundle platform fails
here rather than leaving a user to discover it.

## Statuses

| Status | Meaning |
| --- | --- |
| `vendored` | present in this package and matching its pinned digest |
| `vendored-source` | the target links generated JavaScript, not a Hermes archive |
| `required-missing` | a container or CI build path exists; the artifact is not in this checkout |
| `blocked` | cannot be produced yet, and `blocker` says why in machine-readable form |
| `retired-upstream` | the pinned engine keeps the key only so old manifests parse |

`verify --complete` names every gap in one report instead of throwing on the
first, because filling the matrix one unnamed target at a time is a serial
guessing game.

# Host compilers

`hermesc` (TypeScript/JS → bytecode) and `shermes` (typed TypeScript → C) run on
the user's machine and must ship per host: macOS arm64 and x64, Linux x64 and
arm64, Windows x64. Both are pure compilers - text in, text out - so shipping
them imposes no native toolchain requirement on the user.

They ship as **optional per-host packages**
(`@ts-defold/deherm-compilers-<platform>-<arch>`, declaring `os` and `cpu`),
not vendored inside the main package. Vendoring all five would put several
hundred megabytes of LLVM-derived binaries into every install so that one of them
could be used. The main package does not hard-depend on them either, so a host
with no published build still installs cleanly and gets a diagnostic instead of a
failed install.

`packages/toolchains/host-compilers.json` is the pinned record for all three
host tools, managed by `scripts/manage-host-compilers.mjs` with the same
`fingerprint`/`tag`/`install`/`record`/`verify`/`stage`/`pull` verbs as the
target archives. `fingerprint`, `tag` and `expected-assets` take a family name,
because the three tools are published under two tags; `pull` fetches both unless `--family`
names one, and `--tag` requires `--family` since a tag addresses exactly one
release. Resolution (`packages/cli/src/host-compilers.mjs`) checks the installed
package first and the in-tree staging directory second, verifies the SHA-256 of
each binary against that record, and **fails closed**: a mismatch or a missing
package raises an error naming the host, the tool, and the exact package to
install. There is no fallback to whatever compiler happens to be on `PATH`,
because a build that silently proceeds without `hermesc` produces exactly the
stale-bundle failure the build seam exists to prevent, and one that proceeds
without `dehermc` emits a program whose `DefoldHash` literals were never
lowered and whose reachability manifest was never written - which fails later
and further from its cause.

The published Linux compilers are built on `ubuntu-22.04` runners, which sets
their glibc floor at 2.35.

# The transform compiler

Three transforms make a déherm build a déherm build, and none is optional:
`DefoldHash` literal lowering, resource-name diagnostics, and the symbol-level
Defold API reachability manifest that the release projection prunes against.
All three resolve symbols through the typescript-go checker, so all three are
Go, living in `packages/compiler/ttsc/hash-literal/`.

## ttsc cannot be handed a prebuilt binary

This was checked rather than assumed, and the answer is explicit upstream:

> ttsc accepts source only. It does not accept a prebuilt binary path: the
> package-local Go compiler builds this source into the ttsc plugin cache on
> demand.
> — `ITtscPlugin.source`, `node_modules/ttsc/lib/structures/ITtscPlugin.d.ts`

Seeding that cache from a release does not work either. `computeCacheKey` in
`buildSourcePlugin.js` hashes `computeGoCompilerIdentity`, which is the SHA-256
of the user's own `go` binary plus its `go version` output, alongside the
resolved `GOROOT` contents and every `CGO_*`/`GO*` build variable. A release
cannot know which Go a user will have, so it cannot compute the key its binary
would have to be filed under.

Ttsc does ship a Go toolchain of its own, in the `@ttsc/<platform>-<arch>`
optional dependency, so the toolchain is not strictly undeclared. But
`resolveGoCompiler` falls through to bare `go` on `PATH` when that optional
package is absent — an install with `--no-optional`, or a host ttsc publishes no
package for — and déherm pins and verifies neither path. Either way the
multi-second-to-minutes cold build is paid by the user, on their first build,
before any TypeScript of theirs compiles.

## So déherm ships its own compiler

`packages/compiler/ttsc/cmd/dehermc` is a `package main` that links ttsc's
linked-plugin host together with our transform package, whose `init()` registers
it through `driver.RegisterPlugin` exactly as it does when ttsc links it as a
contributor into its own host. It is the same program ttsc would have built,
built once, in CI, taking the arguments we define:

```
dehermc transform --tsconfig <path> --plugins-json <manifest>
dehermc check     --tsconfig <path> --plugins-json <manifest>
dehermc build     --tsconfig <path> --outdir <dir>
dehermc serve     --tsconfig <path>
dehermc version
```

The ttsc Go module, and the typescript-go checkout under its `shim/`, arrive
with the npm package and are pinned by `pnpm-lock.yaml`. They are deliberately
not vendored into this repository, so the compiler's provenance is stated in
exactly one place. `toolchains/go/build-dehermc.sh` reconstructs the
workspace ttsc itself uses — every `require` in its `go.mod` is `v0.0.0` behind
a local `replace` — rather than re-pinning typescript-go here.

## It is pure Go, and that decides the shape of the CI job

`CGO_ENABLED=0` links it on all five hosts, so `GOOS`/`GOARCH` is the whole of
cross-compilation and **one runner produces the entire matrix**. This was
verified, not assumed: all five cross-compile clean, and the Linux binaries are
statically linked with no libc floor at all.

| Host | Bytes | Kind |
| --- | --- | --- |
| `darwin-arm64` | 20 367 026 | Mach-O arm64 |
| `darwin-x64` | 21 127 088 | Mach-O x86_64 |
| `linux-x64` | 20 832 382 | ELF x86-64, statically linked, stripped |
| `linux-arm64` | 19 923 070 | ELF aarch64, statically linked, stripped |
| `win32-x64` | 21 287 936 | PE32+ console x86-64 |

That is the cheapest artifact in the set. `libhermes.a` needs a container or an
Apple SDK per target; `hermesc` and `shermes` need a runner per architecture
because they are LLVM and each imports the host compilers it is producing.

Reproducibility here is **observed**, not asserted, which distinguishes it from
the Linux and Windows Hermes recipes: `-trimpath -buildvcs=false`, `-ldflags
"-s -w -buildid="`, and `GOAMD64`/`GOARM64` pinned to the baseline so a runner
that exports a microarchitecture level cannot change the bytes. Two builds from
different scratch directories produced the identical SHA-256
`776a84344cc6a4d17952807deb4345df39fa49963abcd0f933b26db56fb272b1` for
`darwin-arm64`.

## Accounting

`dehermc` is a third host-keyed tool and is tracked exactly like the other
two: pinned digest, fail-closed resolution, named diagnostic when absent. It
extends `packages/toolchains/host-compilers.json` and
`packages/cli/src/host-compilers.mjs` rather than introducing a second resolver.

Status moved from **per host** to **per tool** to accommodate it. The three
tools come from different builders on different schedules — `dehermc` reaches
all five hosts from one job, while `hermesc` and `shermes` each need a runner of
their own architecture — so a host-wide status would either hide a published
tool behind an unpublished one or claim a host is ready when only part of it is.
`requireHostTool(<tool>)` fails closed for one named tool, because a project
running only the transforms should not be told `hermesc` is missing.

## Boundary

The binary exists, cross-compiles, is reproducible, and runs all three
transforms. What is **not** yet done is the consumption seam: the build path
still reaches the transforms through `@ttsc/unplugin/esbuild`, which calls
`loadProjectPlugins` → `buildSourcePlugin` and therefore still builds Go on the
user's machine. Switching `packages/cli/src/dev/compiler.mjs` to spawn
`dehermc transform` and serve modules from its JSON envelope is what actually
removes the Go requirement from a user's first build; until that lands, this
artifact is shipped and verified but not yet on the path.

# The build seam

Two artifacts cross from déherm into Bob, with different lifecycles:

1. **The application bundle** at `/deherm/app.dehermc`, which Bob archives as a
   `custom_resources` entry. Per build, derived from the user's TypeScript.
2. **The extension** `defold_hermes/`, which Bob uploads to Extender. Per
   release for its fixed parts, **per build for its generated C**.

## The extension's `src/` is not static

For a release build, `shermes -typed -emit-c` produces C for the reachable
typed-native surface, and each extension needing an FFI bridge produces its own C
from type-annotated JavaScript. That C is assembled into the extension's sources
before Bob packages it, so Extender compiles it like any other extension source.

This is what makes the AOT lane work without a user toolchain, and it composes
with reachability: only routes the final build retains produce C, so an unused
surface costs nothing in the shipped binary.

It also means the extension Bob uploads is **project-specific**. The package
ships a skeleton; a build materialises it.

## Bob may be the only thing that runs

A user may build only with Bob, on a build server, against cloud Extender. The
seam must therefore be explicit about ordering and freshness rather than assuming
an interactive session:

* Bob archives whatever `/deherm/app.dehermc` is on disk. If déherm has not run
  since the last TypeScript edit, Bob packages a stale bundle and the game runs
  old code. This has already happened once in this project.
* Every bundle carries `__DEFOLD_HERMES_BUILD_FINGERPRINT__`, a content hash of
  the compiled program, and the runtime reports it on activation. Comparing that
  value, and the sources it was built from, against the working tree turns
  "someone forgot to run déherm" from a black screen into a diagnostic naming
  both fingerprints.
* Either the bundle and materialised extension C are committed artifacts whose
  fingerprints must match the sources Bob sees, or déherm runs on the build
  machine and needs the host compilers there. Both are workable; an unchecked
  mismatch is not.

## The binding that closes the seam

`deherm.lock` gains a `buildArtifacts` section. Each entry names a materialised
artifact, its content hash, its published fingerprint, the build settings that
produced it, and the SHA-256 of every file the bundler read. A bundle build
writes the entry; `deherm verify-bundle` and `deherm verify-generated` recompute
it from the working tree.

Recomputation is a hash comparison over the recorded inputs, never a compile,
which is what makes it affordable in a watch loop and as a pre-Bob step in
`scripts/bob.sh`. It needs no network. A source file that became reachable since
the build cannot hide from it, because reaching it required editing a file that
is already in the recorded set.

The check distinguishes the states that need different answers: sources changed
after the build, the artifact is not the recorded one, the artifact disagrees
with its own fingerprint, nothing binds it, or it is absent. The first three are
errors everywhere; the last two are reports by default and errors before Bob,
where an artifact nobody can relate to a source tree is as unacceptable as one
that provably disagrees with it. `--recompute` bundles the current sources into
a scratch directory to name the exact fingerprint they produce, and clears the
failure when that is the artifact already on disk.

Both workflows keep working unchanged. A committed bundle is committed together
with its binding; a build machine that runs déherm rewrites the binding before
Bob reads it. The same record shape covers generated extension C - the
`generated-sources` kind - so the assembler that writes `shermes -emit-c` output
into the extension inherits the freshness relation rather than inventing one.

# Three families, three tags

Every published artifact is addressed by a SHA-256 fingerprint of the inputs
that determine its bytes, declared once in `scripts/lib/artifact-releases.mjs`.
There are three families, and they used to be two.

Each family declares its own `tagPrefix` and `assetPrefix` in that file; the
tag is `<tagPrefix>-<fp16>` and every asset is `<assetPrefix>-<row>.tar.gz`, so
neither spelling is restated here.

| Family | Asset per row | Consumes | Does **not** consume |
| --- | --- | --- | --- |
| Hermes host compilers | one archive per host: hermesc + shermes | `HERMES_URL`, `HERMES_REV`, `build-host-compilers.sh`, `package-archive.sh` | anything of Defold's, anything of Go's |
| The transform compiler | one archive per host: dehermc | `ttscVersion`, `packages/compiler/go.mod`, the ttsc Go sources, `build-dehermc.sh`, `package-archive.sh` | `upstream.lock` at all |
| Target archives | one archive per bundle target: the library + its `.debug` sibling | `HERMES_URL`, `HERMES_REV`, the per-target build recipe, `package-archive.sh`, and the `sdk` and `targets` fields of `defold-bundle-targets.json` | `DEFOLD_REV`, `sourceSha256` |

`package-archive.sh` is in all three input sets because it decides the published
**bytes** as directly as the compiler does: a changed `--mtime`, member order or
compression level produces a different file from the same build outputs. It was
the easy input to forget, being neither a compiler nor a pin.

## Why the tag carries only 16 hex digits

`<fp16>` is the first 16 hex digits of the fingerprint, not all 64.
`native-artifacts-<64 hex>` is 81 characters; it appeared in the release list,
in every download URL, in the workflow summary and in the policy index, at a
length no one can compare by eye or quote in a bug report. 64 bits leaves a
collision probability around 1 in 10^11 over a population measured in thousands
of releases, and a collision would need two **different** input sets to agree -
not an attack surface, because the tag is derived from this checkout's own files
rather than accepted from anyone. The full digest is not discarded: it is in the
release notes, beside the tag in the policy index, and is still what
`manage-*.mjs fingerprint` prints, so every provenance claim is made over all
256 bits. The release also gets a human **title** rather than a restatement of
its tag.

Tag derivation lives in exactly one place - `familyRelease` in
`scripts/lib/artifact-releases.mjs`, surfaced as `manage-*.mjs tag`. The
workflow used to assemble tags by concatenating a prefix onto `fingerprint`
output, which put the prefix in two places while the expected-asset listing was
derived from only one; truncating the digest would have made that divergence
silent instead of loud.

## Why the lock is hashed by key

Both managers used to hash `upstream.lock` in its entirety, which made every
artifact a function of every pin in it. That was measured, not theorised:
changing **only** `DEFOLD_REV` rotated the host-tool tag from `7a3536af` to
`35787eb7` and the target tag from `d37e4040` to `6fb21b2c`. `hermesc` and
`shermes` link, read and embed nothing of Defold's, so the nightly repin in
`.github/workflows/policy-revisions.yml` would have forced a rebuild and a
republish of all 25 artifacts for zero byte change - and churned digests users
had already pinned.

A key a family declares and the lock does not carry is a **hard error**, never a
silently skipped input: a stable tag computed over an incomplete input set is
the one failure content addressing exists to prevent. A key declared twice is
refused for the same reason - the whole-file hash could not tell two conflicting
pins apart.

The engine coupling that is real survives: the `sdk` pins move the target
archives, because an archive built against a different NDK API level or
deployment minimum than the engine links against is an ABI mismatch Extender
only finds at link time. `tests/artifact-fingerprints.test.mjs` asserts both
directions on a temporary checkout - a Defold repin moves nothing, a Hermes
repin moves the two Hermes families and not `dehermc`, an `sdk` edit moves the
target archives and a `defoldRevision` edit does not.

## Why the host tools are two families and not one

`hermesc`/`shermes` and `dehermc` are both indexed by the user's host, and that
is the only thing they share. One `host-tools-<fp>` tag meant a Go transform
edit republished ten unchanged LLVM compilers and a Hermes repin republished
five unchanged Go binaries. Each now publishes one archive per host: one
carrying hermesc and shermes, one carrying dehermc.

## What is still deliberately over-hashed

Comments are hashed with everything else, so a prose-only edit to
`Dockerfile.android` rotates a tag and republishes identical bytes. That is
waste, and it is the **safe** direction: the opposite error serves different
bytes under a tag users have already pinned. Stripping comments would mean
parsing Dockerfile, shell, CMake, Go and JSON correctly enough to bet artifact
identity on it, and a parser bug there is silent.

# What builds what

`.github/workflows/native-artifacts.yml` carries all three matrices, kept apart
in one file because conflating them has already cost review time. A `sdk` job
reads the derived SDK pins once and feeds them to the cross builds. The `plan`
job computes all three tags and decides each family's skip independently, on the
assets that release actually holds rather than on the tag's existence.

The skip is **per asset**, not merely per complete release.
`scripts/plan-native-artifact-builds.mjs` maps every publishable asset to exactly
one executor row and subtracts the names already present under that family's
fingerprinted tag. A partial retry therefore schedules only the missing rows;
tests exercise empty, complete and one-row-missing releases and reject an asset
that appears in two lanes. The upload boundary repeats the existence check and
never uses `--clobber`, so a manual dispatch or an external publisher that wins
after planning cannot overwrite immutable bytes.

Workflow-level concurrency remains one queued `native-artifacts` group with
`cancel-in-progress: false`. This is intentionally broader than a branch: two
branches can compute the same content-addressed tag, so branch-scoped locks
would still race. Queueing lets the later run observe the first run's published
rows and collapse to a no-op instead of cancelling a long build halfway through
a release. Docker target lanes additionally use BuildKit's GitHub Actions cache
scoped by bundle target. The cache is only a compile accelerator: BuildKit
validates its content graph, and the release identity remains the declared
family fingerprint plus asset name.

| Lane | Runner | Produces |
| --- | --- | --- |
| `linux` | `ubuntu-24.04`, `ubuntu-24.04-arm` | `x86_64-linux`, `arm64-linux` via `Dockerfile.linux` |
| `windows` | `ubuntu-24.04` | `x86_64-win32` via `Dockerfile.win32`, merged to `hermes.lib` + `hermes.debug.lib` |
| `android` | `ubuntu-24.04` | `armv7`, `arm64`, `x86_64` via `Dockerfile.android` and the engine's NDK pin |
| `apple` | `macos-15` | `arm64-osx`, `x86_64-osx`, `arm64-ios`, `arm64_sim-ios` via `build-apple.sh` |
| `host-compilers` | per-host runners | `hermesc`/`shermes` for all five hosts, into the `hermes-host` family's release |
| `go-compiler` | one `ubuntu-24.04` | `dehermc` for all five hosts, `CGO_ENABLED=0`, into the `dehermc` family's release |

iOS and macOS x64 need the Apple SDKs, so they have no container path and run on
a macOS runner. Android needs the NDK, pinned by digest inside the container
rather than trusted from the network.

Every target lane builds its library **twice**. The second compilation sets
`-DHERMES_ENABLE_DEBUGGER=ON`, which chains on `HERMES_MEMORY_INSTRUMENTATION`
at the pinned tree's `CMakeLists.txt:245`, and lands in the same archive as
`libhermes.debug.a` (`hermes.debug.lib` on Windows). It is a second compilation
rather than a link-time switch because the debugger changes what the VM is built
to do, and the two are not interchangeable: a JS debugger needs interpreter
frames to stop in, and a release build lowers reachable routes to typed-native
AOT C where those frames do not exist. So the debugger belongs to development
builds, and shipping both in one asset is what lets one download serve both.

Every **cross** build first builds host `hermesc`/`shermes` and passes them
through `-DIMPORT_HOST_COMPILERS`, because Hermes compiles its own internal
JavaScript to bytecode during the build and cannot execute the binaries it is
producing. The two **native** lanes - `Dockerfile.linux` and the
`windows-native` fallback - set `-DHERMES_ENABLE_TOOLS=ON` instead: host and
target are the same machine, so CMake builds and runs hermesc itself, and a
second host tree would only duplicate it. With `TOOLS=OFF` those lanes had no
rule producing `bin/hermesc` at all and died at ninja graph load on
`API/hermes/extensions/ExtensionsBytecode.hbc`. `TOOLS` was off to avoid a
`$<TARGET_FILE:hermes>` generator expression that appears only under
`external/node-api-tests` and `external/node-api-cts`; `HERMES_ENABLE_NAPI=OFF`
already removes both, so the reason was gone and only the workaround remained.

## The Android lane uses pinned static ICU

The earlier Java-unicode route was not viable for Defold: the pinned NDK carries
no fbjni and exposes shared ICU only at API 31+, while Defold targets API 19/21.
`Dockerfile.android` now builds digest-pinned ICU 73.2 and a pinned, trimmed
fbjni archive per ABI, selects Hermes' ICU backend, and merges both dependencies
into each release/debug `libhermes.a`. The complete rationale, data filter,
source pins and symbol assertions live in
[Android ICU and fbjni](android-icu-and-fbjni.md).

The first CI attempt still failed in all three Android rows and GitHub exposed
only the failing Docker step without an authenticated log download. A local
arm64 reproduction is therefore the current diagnostic authority. Until that
build completes, Extender links the result, and an APK survives host-object GC,
Android remains **emitted but runtime-unverified**. In particular, source-level
configuration of the empty Hermes finalizer runner closes the known fbjni
`JavaVM` abort but is not device execution evidence.

`wasm_pthread-web` is the one `blocked` target. The web lane runs scripts on the
browser's own engine through the Emscripten glue, and every recorded observation
is of the single-threaded `wasm-web` bundle; the pthread bundle would run the
engine on a worker with shared memory, which no evidence here covers.

# Reporting it to the user

`deherm doctor` answers the only question that matters at the seam: can this
host build a bundle for the targets I intend to ship? It prints the host
compilers (this host first), then every bundle target with its status, blocker
and - inside a project - whether the installed extension actually carries the
archive its digest claims. `--target <list>` turns the targets the user names
into failures rather than information, and rejects a name the pinned engine does
not declare. `--json` emits the same report as data.

# Consequences

* A user needs no C toolchain, for development or release.
* Cloud Extender, local Extender and a headless build server are the same path.
* The host matrix (5 compiler builds) and the target matrix (one archive per
  Defold platform, including mobile) are sized independently and neither implies
  the other.
* A Defold repin rebuilds nothing. A Hermes repin rebuilds the Hermes families
  and leaves `dehermc` alone. Each published asset is skipped independently
  inside its family's release, so a partial retry rebuilds only failed rows.
* A user who resolved a Defold revision through the policy index is told which
  tags and which asset names go with it - see *The entry also answers "what do I
  download?"* in the layered API policy cache decision.
* Generated C is a build input to Bob, so it is subject to the same content
  addressing as everything else: it is derived from the policy Merkle root and
  the reachable surface, and changes only when those change.

# Boundary

None of this establishes runtime behaviour. It describes what is compiled,
where, and by whom. Whether the resulting binary is correct remains the headless
conformance harness's and the packaged-engine evidence's job.
