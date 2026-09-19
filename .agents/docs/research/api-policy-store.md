---
type: Research
title: The API policy artifact and its content-addressed static site
description: The per-namespace policy subtrees derived for the pinned Defold revision, the emitted v1 site, the CI that publishes it, and the determinism boundaries that remain.
tags: [policy, cache, distribution, ci, reproducibility, toolchain]
status: verified
generated: { by: claude/opus-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: layered-policy
    resource: ../decisions/layered-api-policy-cache.md
    title: Cache source-derived API policies in layers, keyed by content hash
    author: project:deherm
  - id: api-source-resolution
    resource: ../decisions/api-source-resolution.md
    title: Resolve API ground truth from the exact Defold engine SHA
    author: project:deherm
  - id: defold-sdk-py
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/build_tools/sdk.py
    title: Defold toolchain pins
    author: team:defold
---

# What exists now

The policy the layered-cache decision describes is a real artifact. It is
derived by `scripts/generate-api-policy.mjs` from state that was already
generated - the script API IR, the dmSDK IR, the route availability profiles,
the source-derived Lua registration surface and the resource declaration schema
- plus one thing nothing previously read into a shippable form: the engine's own
toolchain pins from `build_tools/sdk.py`.

For the pinned revision `7f0f554f41f9dce1e0ddff99bf08200657d1ee05` the policy is
**55 subtrees - 52 namespaces plus `@shared`, `@profiles` and `@toolchain` - in
6.19 MB**, under policy root
`27f0c00d84e57224a03e1f55d0477d1d412e3de68e746b50f09fd091377242c7`.

# The structure is the decision

The root hashes subtrees; it is not a blob with a hash on it. That is what makes
storage additive across engine revisions, and it had to be decided before the
first policy was written rather than recovered afterwards with a delta format.

| Subtree kind | Key | Contents |
| --- | --- | --- |
| namespace | `gui`, `go`, `dlib`, … | that namespace's declared script routes and types, its source-derived registration record for every engine target, its dmSDK declarations, and its route availability under each build profile |
| shared | `@shared` | what no single namespace owns: global types (`hash`, `url`, `vector3`), lifecycle callback shapes, dmSDK opaque and unresolved types, the resource declaration schema, and every parser refusal, which is attributed to a C file rather than to a namespace |
| profiles | `@profiles` | the cross-namespace profile and feature definitions, the handshake contract, and the recipe for rebuilding the revision-keyed catalog digest |
| toolchain | `@toolchain` | Defold's own pins, under Defold's own symbol names |

Namespace attribution is structural, never a name list: a script route takes the
first segment of its Lua module path, a declared type is attributed to a module
only when that module exists in the surface (so `hash` and `on_input.action` go
to `@shared` rather than inventing a namespace), and a dmSDK declaration takes
the directory under `dmsdk/` that its public header lives in. A declaration with
no `dmsdk/<namespace>/` header is a hard failure, not a guess.

`<globals>` is deliberately **not** a subtree key. It is the registration
parser's marker for a Lua name registered outside any module - not a namespace,
and not even a legal Lua identifier. `_G` is kept, because the global table is a
real scope the base library registers into.

# Two rules that keep the sharing property true

**No policy object may carry the Defold revision.** If it did, every revision
would produce a distinct root and "many shas point at one policy" would quietly
stop holding. `assertNoRevisionLeak` refuses a derivation whose root or any
object contains the revision string, and it found a real leak the first time it
ran: the route profiles' `runtimeHandshake` carries `defoldRevision` and
`catalogSha256`, both keyed to the revision.

Those two fields are therefore stripped and reconstituted at resolution time.
Nothing is lost, and this is checked rather than claimed:
`scripts/check-policy-site-resolution.mjs` rebuilds the handshake for
`default-legacy-bullet` from the policy plus the revision the consumer already
resolved, and compares every field against the generated profile.

**Only engine targets belong in a Defold revision's policy.** The registration
surface also carries `extension-defold-xmath` and `extension-defold-astar`;
folding them in would make the engine policy a function of which extensions this
checkout happened to have. Those are layer-1/layer-2 policies keyed by their own
content hash.

# Defold's pins, read and never restated

`@toolchain` carries 28 symbols under the engine's own names - `VERSION_XCODE`,
`VERSION_IPHONEOS_MIN`, `VERSION_MACOSX_MIN`, `ANDROID_NDK_VERSION`,
`ANDROID_NDK_API_VERSION`, `ANDROID_TARGET_API_LEVEL`,
`ANDROID_BUILD_TOOLS_VERSION`, `VERSION_LINUX_CLANG`, `VERSION_WINDOWS_SDK`,
`VERSION_WINDOWS_MSVC`, `VISUAL_STUDIO_VERSION`, `EMSCRIPTEN_VERSION_STR` and
the `PACKAGES_*` compositions the engine derives from them - alongside the
platform keys `share/extender/build_input.yml` declares. Keeping Defold's
spelling is the point: renaming a pin into our vocabulary is the first step
towards owning it.

A symbol that moves out of `sdk.py`, or whose right-hand side is a shape the
reader does not understand, is a hard failure rather than a silently missing
pin.

**The reconciliation, recorded as the task asked.** `upstream.lock` does not
carry a symbol named `EMSCRIPTEN_VERSION`; it carries **`EMSDK_VERSION=4.0.6`**,
which is the same restatement under a different name. The generator compares
both spellings against `EMSCRIPTEN_VERSION_STR` and refuses to derive a policy
when they disagree, because an HTML5 build against a different Emscripten than
the engine's own is an ABI mismatch nobody discovers until the link. At this
revision they agree - `4.0.6` - and the agreement is recorded in
`packages/bindings/generated/defold-api-policy.json` rather than assumed.

# The emitted site

```
<base>/v1/index/<defold-sha>.json    -> { policyRoot, generator }
<base>/v1/policy/<root-hash>.json    -> names its subtrees
<base>/v1/object/<subtree-hash>.json -> one namespace's surface
```

* **Nothing at a root-level segment.** `readSiteConfig` refuses a base whose URL
  has no path segment unless `pathPrefix` supplies one, so `/v1/index/…` can
  never land at the root of a shared organisation domain.
* **The base is data.** `packages/bindings/policy-site.json` is configuration,
  not generated state, and the base it declares is written into the index the
  site serves. The end-to-end check deliberately publishes under a *different*
  base than the configured one and resolves against it, which is the claim that
  relocation is an edit rather than a release.
* **The schema version is in the path**, so a `v2` layout can be published
  alongside `v1` during a migration.

The store is committed under `packages/bindings/generated/policy/`, so the site
builds from a clean checkout with no Defold source, no clang and no network -
and the npm package ships exactly one policy, the revision it was built against,
together with the index.

# What was proven rather than asserted

| Property | How |
| --- | --- |
| Deriving the same revision twice produces identical hashes | `tests/api-policy.test.mjs`; and a clean-store regeneration produced a byte-identical tree (`diff -r` clean, 57 files written on the first run, 0 on the second) |
| Two inputs differing in one namespace share every other subtree | a fixture whose `gui` routes change moves `gui` and the root, leaves every other subtree hash equal, and contributes exactly one new object |
| A generator revision change moves the root but no subtree | so a stale parser is detectable without invalidating shared objects |
| A consumer resolves sha -> index -> policy -> objects and verifies each object against its path | `scripts/check-policy-site-resolution.mjs` over HTTP against a served copy, using only the base and path templates carried in the index |
| Self-verification actually verifies | the same check serves a tampered object at a valid path and requires the resolution to fail |
| The site builds from a clean checkout | the emitter reads only committed bytes; `--check` first refuses a store with a dangling reference or an unreferenced object |

# CI

`.github/workflows/policy.yml` owns discovery, derivation, cross-host parity,
real-engine evidence, and publication in one visible graph. It reads
`https://d.defold.com/<channel>/info.json` for the tracked channels each day. A
channel whose sha is already indexed derives and publishes **nothing**. A new
sha is pinned in a scratch workspace with the digests the immutable archive
actually served, derived, verified as far as the available harness permits, and
published directly to `deherm-policy-site`. Generator changes are reviewed in
pull requests; an authoritative Defold revision does not wait in a review queue.

# Open boundaries

* **The dmSDK IR is host-clang dependent.** `scripts/import-defold-sdk.py`
  parses public headers with whatever `clang++` is on the host and labels its
  output `arm64-macos` unconditionally. Two hosts can therefore derive two
  different policies for one revision. The scheduled job runs on an arm64 macOS
  runner to match the label, and its pull request says to compare the policy root
  against a local derivation - but the real fix is for that generator to record
  and pin its own toolchain, which is the same class of problem this policy
  solves for Defold's pins.
* **The dmSDK IR leaks the absolute checkout path** into anonymous-record names
  (six occurrences). The policy normalizes them out, but the underlying artifact
  is still a function of where the repository was cloned.
* **Layers 1 and 2 are not built.** This is layer 0 only: one engine revision's
  surface. Extension policies keyed by archive content hash, and the Murmur2-64A
  cache keys that decide whether to reparse, remain future work.
* **A policy is source-derived evidence about a declared surface.** It does not
  establish that a registered function behaves as its C body suggests. Runtime
  conformance remains the headless engine harness's job.
