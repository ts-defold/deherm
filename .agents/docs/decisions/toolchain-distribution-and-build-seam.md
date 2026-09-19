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
the SHA-256 fingerprint of the inputs that determine the artifact, so the
artifacts are content-addressed: many déherm versions share one release, and a
rebuild whose inputs have not changed finds the release already present and does
nothing.

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
`fingerprint`/`install`/`record`/`verify`/`stage`/`pull` verbs as the target
archives. Resolution (`packages/cli/src/host-compilers.mjs`) checks the installed
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

# What builds what

`.github/workflows/native-artifacts.yml` carries both matrices, kept apart in
one file because conflating them has already cost review time. A `sdk` job reads
the derived SDK pins once and feeds them to the cross builds.

| Lane | Runner | Produces |
| --- | --- | --- |
| `linux` | `ubuntu-24.04`, `ubuntu-24.04-arm` | `x86_64-linux`, `arm64-linux` via `Dockerfile.linux` |
| `windows` | `ubuntu-24.04` | `x86_64-win32` via `Dockerfile.win32`, merged to one `hermes.lib` |
| `android` | `ubuntu-24.04` | `armv7`, `arm64`, `x86_64` via `Dockerfile.android` and the engine's NDK pin |
| `apple` | `macos-15` | `arm64-osx`, `x86_64-osx`, `arm64-ios`, `arm64_sim-ios` via `build-apple.sh` |
| `host-compilers` | per-host runners | `hermesc`/`shermes` for all five hosts |
| `go-compiler` | one `ubuntu-24.04` | `dehermc` for all five hosts, `CGO_ENABLED=0` |

iOS and macOS x64 need the Apple SDKs, so they have no container path and run on
a macOS runner. Android needs the NDK, pinned by digest inside the container
rather than trusted from the network.

Every cross build first builds host `hermesc`/`shermes` and passes them through
`-DIMPORT_HOST_COMPILERS`, because Hermes compiles its own internal JavaScript to
bytecode during the build and cannot execute the binaries it is producing.

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
* Generated C is a build input to Bob, so it is subject to the same content
  addressing as everything else: it is derived from the policy Merkle root and
  the reachable surface, and changes only when those change.

# Boundary

None of this establishes runtime behaviour. It describes what is compiled,
where, and by whom. Whether the resulting binary is correct remains the headless
conformance harness's and the packaged-engine evidence's job.
