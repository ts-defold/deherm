---
type: Architecture Decision
title: Ship precompiled target libraries and host compilers, and emit C into the extension for Bob
description: CI builds Hermes per target in containers, the package vendors those plus per-host hermesc/shermes, and generated C is assembled into the extension so Bob and Extender compile it - locally or in the cloud.
tags: [decision, packaging, toolchain, bob, extender, static-hermes, ci]
status: proposed
generated: { by: claude/opus-5, at: 2026-09-18T23:50:00-04:00 }
sources:
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
| generated C from TypeScript | `shermes` on the user's host | per build | the user's project |
| extension objects and the engine | Bob → Extender, local or cloud | per build | target platform |

The user compiles nothing natively. `shermes` emits C as text; Extender turns
that text into objects and links it against the precompiled `libhermes.a`.

# Target libraries

`libhermes.a` is the Hermes VM, JSI and `boost_context` merged into one archive,
with the unreferenced `zip.c.o` removed so Extender's force-load does not hit
duplicate symbols, built with `libtool -D` so it is byte-reproducible. It is
vendored under `defold/defold_hermes/lib/<target>/` and ships in the npm
package, because Bob uploads it to Extender for whichever platform is being
bundled.

It is therefore indexed by **Defold target**, never by the user's host. A user
on macOS bundling for Android needs the Android archive and none of their own.

CI builds each target in a container and publishes it as a workflow artifact;
`scripts/manage-native-artifacts.mjs pull --run <id>` vendors them and records
each digest. `toolchains/hermes/` already holds the Linux and Windows
container definitions.

Every Defold bundle target must appear in `packages/toolchains/native-artifacts.json`
with an explicit status. A target that is absent from the manifest is worse than
one marked `required-missing`, because the user gets silence instead of a
blocker naming the platform.

# Host compilers

`hermesc` (TypeScript/JS → bytecode) and `shermes` (typed TypeScript → C) run on
the user's machine and must ship per host: macOS arm64 and x64, Linux x64 and
arm64, Windows x64. Both are pure compilers - text in, text out - so shipping
them imposes no native toolchain requirement on the user.

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
  the compiled program, and the runtime reports it on activation. Recomputing
  the expected fingerprint from current sources and comparing it to the bundle
  on disk turns "someone forgot to run déherm" from a black screen into a
  diagnostic naming both fingerprints.
* Either the bundle and materialised extension C are committed artifacts whose
  fingerprints must match the sources Bob sees, or déherm runs on the build
  machine and needs the host compilers there. Both are workable; an unchecked
  mismatch is not.

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
