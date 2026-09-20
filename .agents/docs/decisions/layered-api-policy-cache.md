---
type: Architecture Decision
title: Cache source-derived API policies in layers, keyed by content hash
description: Extract the registered Lua surface from C source once, ship and commit the result as a hash-keyed policy, and reparse only when no policy matches.
tags: [decision, generator, cache, extensions, script-api, reproducibility]
status: proposed
generated: { by: claude/opus-5, at: 2026-09-18T23:10:00-04:00 }
sources:
  - id: product-contract
    resource: ./generator-product-contract.md
    title: Ship a deterministic API compiler, not hand-authored bindings
    author: project:deherm
  - id: extension-discovery
    resource: ./project-extension-discovery.md
    title: Project extension discovery
    author: project:deherm
---

# Problem

Documentation is not authority; the Lua C registration and the C function body
are. But deriving that truth means parsing C, and doing it on every
`deherm generate` has two costs a shipped tool cannot pay:

* **Time.** Parsing every registration array and function body in the engine
  plus every resolved extension, on every generation, for every user.
* **Availability.** It forces extension *source* to be present. Bob resolves
  dependency archives that contain `src/`, but a user should not need C sources
  on disk to get correct types, and should not re-download them to regenerate.

# Decision

Separate *deriving* a policy from *using* one. A **policy** is the
source-derived record of a Lua-shaped surface: which functions are registered,
under which module, with which parameter types, arity, optionality, results and
constants, plus every construct the parser refused with its reason.

A policy is produced once from source and consumed many times without it.

# Layers

Resolution stops at the first layer whose content hash matches.

| Layer | Contents | Keyed by | Ships in |
| --- | --- | --- | --- |
| 0 | The pinned Defold engine surface | Defold revision | the content-addressed policy site; the package ships only a small locator/index seed |
| 1 | Curated policies for audited extensions | archive content hash | the policy site or another configured immutable policy source |
| 2 | Project-local policies for the user's own and unaudited extensions | archive or tree content hash | the user's project, committed |
| 3 | Parse from source | — | nothing; produces a layer-2 policy |

Layer 0 means the engine surface requires no engine checkout and does not force
an npm release for each Defold revision. Layer 1 means common extensions need no
source parse when an authenticated policy is available. Layer 2 means an
unknown extension is parsed once per project and then committed, so the next
generation — and every teammate and CI run — reuses it. Layer 3 runs only when
nothing matches.

# Binding a policy to its input

A policy is only valid for the exact bytes it was derived from.

* The key is the content hash of the extension archive or tree, not its version
  string, URL, or declared revision. Publishers retag.
* A policy also records the **generator revision** that produced it and a
  realizer compatibility contract. Improving source derivation produces a new
  root; adding a genuinely new realization construct raises the minimum package
  version and names its required capability. A Defold revision that only changes
  names or ordinary declarations does neither.
* A hash mismatch causes a reparse and a diagnostic naming both hashes. It never
  silently uses the nearest policy, and never silently accepts one whose key
  does not match.
* A policy that cannot be reparsed because source is absent, and whose hash does
  not match, is a hard failure. Stale source-derived truth is worse than none.

# Merkle over the native input set

A single hash per extension is not sufficient, because the *set* of inputs is
not fixed: a user adds, removes, upgrades or vendors an extension at any time,
and the engine revision moves independently. The cache key must be a tree, not a
flat digest.

Each native input is a leaf keyed by its own content: a dependency archive, a
local extension tree, a `.script_api` file, a public header, the pinned engine
revision. Leaves combine into per-extension nodes, those into a project node,
and the root is the key the generation as a whole is stamped with.

Structuring it this way buys three things a concatenated digest does not:

* **Localised invalidation.** Adding one extension changes only the leaves it
  owns and the path to the root. Every other extension's policy stays valid and
  is not reparsed.
* **Attributable drift.** A root mismatch resolves down the tree to the exact
  leaf that moved, so the diagnostic can name the file or archive rather than
  reporting that "something changed".
* **Independent verification.** One extension's policy can be checked against
  its own subtree without rehashing the project.

Leaf and node ordering is canonical and path-sorted, so the root is a function
of content and structure only - never of filesystem traversal order, resolution
order, or timestamps.

## Which hash, and where

Two different jobs, deliberately not conflated:

* **Cache keys use Murmur2-64A.** It is fast, and this repository already
  implements Defold's exact `dmHashBufferNoReverse64` in
  `packages/compiler/src/defold-hash.mjs`, verified against pinned native
  vectors. A cache key answers "did this input change", where speed matters and
  a non-cryptographic hash is appropriate.
* **Evidence and provenance keep SHA-256.** Vendored artifact digests, recorded
  runtime evidence, clean-room comparisons and the licence/provenance records
  are claims that must remain checkable by a third party. Those do not move.

The boundary is that a Murmur root decides whether to *do work*, while SHA-256
decides what we *assert*. A collision in the former costs a missed reparse; a
collision in the latter would corrupt evidence, which is why the two are not
interchangeable.

# One policy per revision, stored content-addressed

Defold ships releases and nightlies indefinitely, so "a policy per revision"
sounds like unbounded storage and "branch policies by hand" sounds like
unbounded bookkeeping. Neither is required, because **a policy is a function of
the engine's declaration inputs, not of the version string.**

If the Lua C registration arrays, the `.proto` files and the dmSDK headers did
not change between two revisions, the derived policy is byte-identical. Most
point releases change little or nothing in that surface.

So:

* Policies are keyed by **their own content hash**, never by the Defold sha.
* A small index maps **Defold sha -> policy root**. Many shas point at one
  policy, and the index is the only thing that grows per revision - a pair of
  hashes.
* The Defold-sha index entry is a replaceable pointer, not a content-addressed
  object. If a newer generator proves more of an unchanged engine revision, its
  newly derived root replaces that revision's pointer immediately. Old roots
  and subtrees remain immutable by hash; they simply stop being reachable from
  that revision.
* Supporting every version therefore costs nothing like storing every version.

## Branching falls out of the Merkle structure

The policy root is a hash over per-namespace subtrees, not over one blob. If
only `gui` changed between two revisions, `gui`'s subtree hash differs and every
other subtree is **shared**. Storage is additive by construction: a new revision
contributes only the subtrees that actually moved, with no delta format and no
merge logic to maintain.

This is why the subtree boundary has to be decided up front. A single-file
policy hashes as one unit and shares nothing between revisions, which would
force explicit deltas later to recover what structure gives for free.

For scale: the registration surface alone is roughly 5 MB and the script API IR
roughly 2 MB, so a full policy is single-digit megabytes. Whole copies at
nightly frequency would not hold; content-addressed subtrees across releases
will.

## Consequences

* **Future revisions need no prediction.** A revision never seen before is not
  an error state: the user derives a policy from source once, and the
  sha-to-root mapping that produces is exactly what would otherwise be
  published. Local derivation and CI derivation are the same operation.
* **Parser improvements are visible, not silent.** Improving the derivation
  changes the content hash, so the index records which generator revision
  produced each policy and a stale policy is detectably stale rather than
  quietly trusted.
* **Unchanged inputs publish nothing.** Re-deriving a revision whose inputs did
  not move yields the same hash and no new object.

# Toolchain pins are Defold's, and belong in the policy

Defold - not this project - defines every platform SDK and NDK version its
engine is built against. `build_tools/sdk.py` at a given revision is the
authoritative declaration, and it pins more than the target matrix currently
derives:

| Concern | Symbols in `build_tools/sdk.py` |
| --- | --- |
| Apple | `VERSION_XCODE`, `VERSION_XCODE_CLANG`, `VERSION_MACOSX`, `VERSION_IPHONEOS`, `VERSION_IPHONESIMULATOR`, `PACKAGES_*_SDK`, `PACKAGES_XCODE_TOOLCHAIN` |
| Deployment minimums | `VERSION_IPHONEOS_MIN`, `VERSION_MACOSX_MIN` |
| Android | `ANDROID_NDK_VERSION`, `ANDROID_NDK_API_VERSION`, `ANDROID_TARGET_API_LEVEL`, `ANDROID_BUILD_TOOLS_VERSION` |
| Linux | `VERSION_LINUX_CLANG` |
| Windows | `VERSION_WINDOWS_SDK`, `VERSION_WINDOWS_MSVC`, `VISUAL_STUDIO_VERSION` |
| Web | `EMSCRIPTEN_VERSION_STR` |

`share/extender/build_input.yml` is the companion authority for which platform
keys exist at all.

**Never restate one of these as our own constant.** A cross build against a
different SDK, NDK API level or deployment minimum than the engine's own is an
ABI mismatch that Extender finds at link time, or worse does not find. Two
instances already existed: `EMSCRIPTEN_VERSION=4.0.6` is written into
`upstream.lock` as our pin of their number, and the Android NDK digest was a
recalled constant until it was attested against Google's published SHA-1 and a
signed transparency log.

## They belong in the policy, not in a source read

`sdk.py` lives in the engine source tree, and the whole point of the policy
layers is that a user needs no engine checkout. So a revision's toolchain pins
are **derived once alongside its API surface and carried in the same policy**.

A policy that records what the engine's API surface is, but not which NDK and
Emscripten that revision requires, is incomplete: the native artifact matrix
depends on those pins exactly as much as the bindings depend on the surface.
Both move with the engine revision, and both must therefore be keyed by it.

The consequence for the artifact matrix is that a `libhermes.a` is valid for a
*range* of Defold revisions - those sharing its toolchain pins - rather than for
one. The policy is what lets that range be computed instead of assumed.

# Distribution: a content-addressed static site, plus one policy in the package

Policies and native artifacts want opposite distribution, and conflating them is
the mistake to avoid.

| | policies | native artifacts |
| --- | --- | --- |
| Size | single-digit MB | 10-20 MB each |
| Count | one per distinct engine surface, growing with Defold releases | four rows, rarely changing |
| Addressing | content hash | build fingerprint |
| Home | **static site** | **release assets** |

Release assets suit a handful of large files with semantic tags. They suit
thousands of small content-addressed blobs badly: a release carries UI and
release-note meaning that a blob store does not want, and the set grows with
every engine revision.

## The URL scheme is the key

A static site - GitHub Pages is sufficient - where the path *is* the hash. Every
object lives under a **single owned prefix**, never at the domain root:

```
<base>/v1/index/<defold-sha>.json  -> { "policyRoot": "<hash>", "generator": "<rev>", "artifacts": { … } }
<base>/v1/policy/<root-hash>.json  -> the policy root, naming its subtrees
<base>/v1/object/<subtree-hash>.json -> one namespace's derived surface
```

### The base is data, and the domain is shared

This repository is `ts-defold/deherm`, and the organisation already publishes a
site on a shared domain. A GitHub project page is served under its repository
name, so the natural default is `https://<domain>/deherm/…`, which is already
namespaced. That default must not be relied on:

* **Nothing is published at a root-level segment.** A top-level `/index/` or
  `/policy/` would collide with whatever the organisation site routes now or
  later. Everything sits beneath one segment this project owns.
* **The base URL is configuration carried in the shipped index, not a constant
  in code.** Publishing from an organisation-site repository removes the
  repository-name prefix; moving to a CDN or a different domain changes the host
  entirely. Neither may be a code change.
* **The schema version is in the path**, so a `v2` layout can be published
  alongside `v1` during a migration rather than replacing it in place.

Content-addressed objects are immutable and self-verifying, so they can be
served from any host that has the bytes. Keeping the base in data is what makes
relocation a configuration edit instead of a release.

Every object under `/policy` and `/subtree` is **immutable and infinitely
cacheable**, because a change produces a different path rather than a new
version of one. Unchanged subtrees across engine revisions are the same URL and
therefore already in the caller's cache and the CDN's.

## What needs trust, and what does not

Content-addressed objects are **self-verifying**: fetch `/policy/<hash>.json`,
hash the bytes, compare to the path. A hostile or corrupted mirror cannot
substitute content without changing the hash, so the transport needs no trust
beyond availability.

The index is **not one mutable file**, and it is not shipped as an authority.
It is one small immutable document per Defold revision:

```
<base>/v1/index/<defold-sha>.json -> { "policyRoot": "<hash>", "generator": "<rev>", "artifacts": { … } }
```

Keyed by a sha Defold has already published, each entry's `policyRoot` is
written once and never rewritten, because a given revision's declaration inputs
are fixed forever. (`artifacts` is the exception; see below.) The caller resolves the sha it needs from
`d.defold.com/<channel>/info.json` and fetches exactly that one document.

This is the point on which an earlier draft of this decision was wrong. It said
the index ships inside the package and is the released authority, with fetched
entries permitted only to extend it. That cannot hold: Defold publishes
nightlies daily, this project does not control their cadence, and a shipped
authoritative index would require a package release per engine revision - dozens
a day - purely to stay current with something upstream. An index that must be
re-released to stay true is not an index, it is a pin.

So the index is fetched, and its trust comes from the same place the objects'
does. An entry names a `policyRoot`, and the policy it names is content-addressed
and therefore self-verifying: a substituted policy fails its own hash check. What
an index entry can still do is point at the *wrong* valid policy for a revision,
which is why the sha-to-root half of an entry is immutable and the nightly job
never rewrites one.

## The entry also answers "what do I download?"

The policy store and the artifact releases were two content-addressed systems
that never met. Nothing in the store named a release tag, and nothing in a
release named a Defold revision, so a user who had just resolved "I am on Defold
X" still had to be told out of band which `libhermes.a` and which `hermesc` go
with it - by a constant in some client's code, which is exactly what keeping the
base URL in data was supposed to prevent.

The index entry is the per-revision resolution point a client already fetches,
so it carries the answer:

```
"artifacts": {
  "native-artifacts": { "tag": "native-artifacts-<fp>", "indexedBy": "bundleTarget",
                        "assets": { "arm64-osx": "hermes-arm64-osx-libhermes.a", … } },
  "hermes-host":      { "tag": "hermes-host-<fp>",      "indexedBy": "host",
                        "assets": { "linux-x64": { "hermesc": …, "shermes": … }, … } },
  "dehermc":          { "tag": "dehermc-<fp>",          "indexedBy": "host", "assets": { … } }
}
```

and the served index gains one more template beside the three path templates:

```
"releaseAsset": "https://github.com/<repo>/releases/download/{tag}/{asset}"
```

That template is absolute where the other three are relative, because release
storage is not the policy site. It is built from the same expression
`packages/cli/src/release-assets.mjs` resolves its own downloads from, so a user
who follows the index and a user who runs `pull` cannot reach two different
URLs; `scripts/check-policy-site-resolution.mjs` asserts they agree, and that a
target nobody built refuses rather than producing a plausible 404.

`indexedBy` is in the data because it is the distinction the whole toolchain
rests on and the one a consumer gets wrong first: target archives are keyed by
the Defold **bundle target** being built and host tools by the user's **host**,
and neither implies the other.

**The honest caveat.** The artifact block is the one part of an entry that is
not a function of the engine revision - it names what the build recipe publishes
*now*. If the Hermes pin or a build recipe moves, the entry for the pinned
revision is regenerated with new tags, while entries already published keep
theirs and stay correct, because the release they name still holds those assets.
So "written once, never rewritten" is a claim about the **sha-to-root half** of
an entry, which is what the trust argument above actually rests on. The host
families are carried even though neither is a function of Defold at all: a user
resolving a revision wants a working host, and one fetch that answers for both
is worth more than the purity of omitting two tags that happen not to move.

## What ships in the package

Three things, none of which grow with the number of engine releases:

* **The base URL**, as data. Relocating to a different host or CDN is a
  configuration edit, never a code change or a release.
* **Exactly one policy** - the revision the package was tested against. This is
  an offline fast path, not an authority: it covers a current déherm against a
  current Defold at zero network cost, and is simply the first layer to match.
* **Nothing keyed per revision.** No accumulating index, no policy set that
  grows with engine history.

Everything else resolves through the layers already defined: packaged, then user
cache, then project cache, then the static site, then local derivation.

## The nightly job

Watch `https://d.defold.com/<channel>/info.json` for each tracked channel. When
a channel's `sha1` moves, derive that revision's policy and publish the objects
and the index entry.

This is direct publication, not preparation for a review pull request. The
single `policy` workflow derives all missing channel revisions into one
accumulated store, runs cross-host reproduction and real-engine evidence lanes,
reports or opens issues for anything unproven, and pushes the usable result to
`deherm-policy-site`. Review is for changes to the generator; a mechanically
derived Defold revision does not wait for a person to authorize its existence.

Because objects are content-addressed, a revision whose declaration inputs did
not change publishes **nothing** - the subtree hashes already exist and the
index simply gains one more pointer at them. The job's steady-state cost is one
index line per release, and a full policy only when the engine's declared
surface actually moves.

The same job is the natural home for re-running the registration verifier
against each new revision, since a disagreement between the documented surface
and the C that registers it is exactly what a new engine release can introduce.

## Where the objects are stored, and what is never committed

Publication has two artifacts with different lifetimes, and committing them to
the same place is the mistake to avoid.

`main` carries **exactly one** policy - the revision the package was built
against - and its single index line. That moves only when the Defold pin moves,
which is already a human-authored change. **The nightly job commits nothing to
`main`.** The index is the trust anchor: it is the one mutable mapping, it ships
in the package, and it is what asserts which policy belongs to a revision. An
automated commit to `main` would hand whatever can run CI a silent authority
over exactly that, for no benefit - nothing reads the published objects from the
working tree.

The objects and the per-revision index entries live on an **orphan branch**,
`deherm-policy-site`, and **GitHub Pages serves that branch directly**. Pages is
configured as *Deploy from a branch*, root folder - not as *GitHub Actions*.

The forcing reason is that `actions/deploy-pages` **replaces the entire site on
every deploy**: the uploaded artifact *is* the site, and nothing merges. For a
store that only ever appends, that inverts the cost. Every nightly run would
have to upload every object ever published in order to keep them reachable, so
the transport cost grows with the store's whole history rather than with the
night's additions - and the run would eventually be dominated by re-publishing
bytes that have not changed since the first release. Serving the branch makes
publication exactly what the data model already is: add the new objects, push,
done.

So the nightly job checks the orphan branch out beside the work tree, derives,
writes only objects whose hashes are absent, and pushes. The push *is* the
deploy; there is no second mechanism. Because every object is re-derivable, the
branch stays disposable: if the derivation changes, it can be reset and rebuilt
rather than migrated.

Two constraints come with branch-served Pages and are requirements, not notes:

* **`.nojekyll` at the branch root, from its first commit.** Branch deploys run
  Jekyll by default, which would exclude files by name and process thousands of
  objects for nothing.
* **Roughly ten branch builds per hour, and a 1 GB soft site limit.** Nightly
  publication is far inside the build rate. The size limit is the number to
  watch as revisions accumulate, and is why subtree sharing - not whole policy
  copies per revision - is load-bearing rather than an optimisation.

The push is guarded on the canonical repository so a fork or a pull-request run
cannot publish, and `contents: write` is scoped to that job alone rather than at
workflow top level.

# What a policy records

Not only what was resolved, but what was refused. Each entry carries its
disposition: registered and agreeing with the declaration; registered and
disagreeing, with the exact divergence; declared but unregistered; registered
but undeclared; or unparseable, with a site and a reason.

Refusals are the load-bearing part. They are what stops a later generation from
guessing, and they are the queue of real parser work.

# Consequences

* Users do not re-download or reparse source to regenerate.
* Extension source becomes optional at generation time and required only to
  *derive* a policy, which the publisher, this project, or the user does once.
* Committed layer-2 policies make a project's typed surface reproducible across
  machines and CI without network access.
* A policy is inspectable and reproducible. Changes and verification status are
  visible in the workflow evidence and content-addressed objects without making
  a human review the publication gate.

# Boundary

A policy is source-derived evidence about a *declared surface*. It is not
runtime evidence. It does not establish that a registered function behaves as
its C body suggests, only that the registration and stack usage say what they
say. Runtime conformance remains the headless engine harness's job.

# Layer 0 in the CLI

`deherm policy` is the explicit network boundary. It resolves the project's
exact Defold SHA (or `--defold-sdk <sha>`), fetches that SHA's entry using the
base and templates in the shipped index, authenticates the policy root and
every namespace object against the digest in its path, and writes only those
verified bytes beneath `~/.cache/deherm/policies/v1` (or
`DEHERM_CACHE_HOME`/`XDG_CACHE_HOME`). A second resolution performs no cache
writes. The shipped index is a trust anchor for revisions it already names,
but not a frozen catalogue: a newer npm package can resolve a Defold revision
published after it by fetching `v1/index/<sha>.json` directly.

The policy cache and the generated-surface cache are intentionally distinct.
The policy is source-derived API evidence; the surface additionally contains
the revision-specific TypeScript SDK and executable lowering products consumed
by `deherm generate`. `deherm policy` now authenticates the policy and invokes
the compiler-owned deterministic materializer into the user surface cache. A
remote machine therefore needs the npm realizer plus the policy, not a Defold
checkout, `ref-doc.zip`, or a previously generated SDK tree.

`packages/cli/src/defold-surface.mjs` resolves layer 0 by Defold revision
alone, across three roots, stopping at the first that holds a complete surface
for that exact revision:

1. **packaged** - `packages/bindings/generated` plus `packages/sdk/src`, the one
   revision the installed déherm package was built against;
2. **user cache** - `$DEHERM_CACHE_HOME`/`$XDG_CACHE_HOME`/`~/.cache/deherm`
   under `surfaces/<revision>/`, shared across that user's projects;
3. **project cache** - `<project>/.deherm/cache/surfaces/<revision>/`, so a
   checkout can be self-contained for CI.

A layer is used only when its own `defold-script-api-ir.json` declares the
requested revision and every file the generator reads is present. A revision
with no surface is a `defold-surface-not-cached` blocker naming each root and
why it did not answer. It never falls through to a different revision's
surface, because that is exactly the defect: signatures that compile and are
wrong.

Producing the **policy** for a new revision still reads that revision's source
and reference documentation in the derivation workflow. Producing a local
**surface from a published policy** does not: `deherm policy` fetches the
content-addressed closure and realizes it locally. A cached revision regenerates
entirely offline.

## The two roots, kept apart

`buildGenerationMerkle` produces three keys, and the split is the point:

* `engineRoot` covers everything the Defold revision decides - the resolved
  revision, which layer served its surface, that surface's input digests, and
  the engine profile selection;
* `nativeRoot` covers everything the project's native input set decides - one
  child per extension, keyed by its manifest path, carrying a leaf per
  `.script_api`, public header and native source;
* `root` combines them with the generator identity.

An engine upgrade moves `engineRoot` and leaves every extension's subtree
valid; vendoring an extension moves one child and `nativeRoot` and leaves the
engine surface valid. Children and leaves are path-sorted, so the root is a
function of content and structure only. `deherm verify-generated` recomputes all
three and refuses a generated tree whose recorded root no longer follows from
the inputs.

The generation Merkle uses SHA-256 rather than the Murmur2-64A named above, and
deliberately: this root is written into `deherm.lock` and the generated
manifest, and `verify-generated` refuses a tree whose recorded root does not
follow from its inputs. That makes it an assertion a third party checks, not
just a private "did this change" decision, so it sits on the SHA-256 side of the
boundary. Murmur stays right for the per-extension policy keys of layers 1-3,
which decide only whether to reparse.

The current leaves digest each `.script_api`'s parsed declarations and name
headers and sources by path. Content-hashing every header and source file is
the next step and is what a layer-1 or layer-2 policy key will need; the shape
of the tree does not change when it lands.

# What exists today

Layer 0's policy artifact and its distribution are implemented. See
[the API policy store](../research/api-policy-store.md) for the derived shape,
the emitted tree and the evidence.

| Piece | Where |
| --- | --- |
| The derivation and the store's `--check` closure | `scripts/generate-api-policy.mjs` |
| Subtree attribution, canonical sealing, the revision-leak guard | `packages/compiler/src/api-policy.mjs` |
| Defold's toolchain pins, read under Defold's own symbol names | `packages/compiler/src/defold-toolchain-pins.mjs` |
| The published base, as configuration rather than a constant | `packages/bindings/policy-site.json` |
| The emitted `v1` tree | `scripts/build-policy-site.mjs` |
| The end-to-end consumer proof, including a tampered-object control | `scripts/check-policy-site-resolution.mjs` |
| The shipped CLI resolver and immutable local policy cache | `packages/cli/src/policy-client.mjs`, `deherm policy` |
| Channel tracking and revision repinning | `scripts/track-defold-channels.mjs` |
| Discover, derive, verify, and publish | `.github/workflows/policy.yml` |

Three details the implementation had to settle that this document left open:

* **Nothing in a policy object may carry the revision** - not even transitively,
  through a digest computed over bytes that themselves carry it. The route
  profiles' runtime handshake carried both, so its `defoldRevision` and
  `catalogSha256` are stripped and reconstituted at resolution time from the
  revision the consumer already resolved. Without that rule every revision would
  produce a distinct root and the storage argument would stop holding silently.
* **`<globals>` is not a namespace.** It is the registration parser's marker for
  a Lua name registered outside any module, and is not a legal Lua identifier.
  Its rows go to the shared subtree; `_G` stays a namespace, because the global
  table is a real scope.
* **Reserved subtrees use an `@` prefix**, which no Lua module name can contain,
  so cross-cutting content (`@shared`, `@profiles`, `@toolchain`) cannot collide
  with a namespace.

# Open items

This decision remains **proposed** because the implemented layer 0 does not yet
complete the layered cache:

* Layers 1–3 (curated extension policies, project-local policies, and
  source-to-layer-2 derivation) are not implemented.
* Public headers and native sources are currently named in the project Merkle
  tree but not content-digested. Same-path byte edits must move `nativeRoot`
  before extension caching is sound.
* The compiler manifest names the document/source objects a materializer needs,
  but the client still eagerly downloads the entire policy closure. A future
  layout may fetch the manifest first and then only its required subtrees.
* The 10.21 MB canonical lowering plan and 17 TypeScript compatibility sources
  remain referenced derived objects. Compiler-owned recipe emitters must replace
  them before the policy is a compact result rather than a correctness-first
  transition artifact.
* A project-cache population command is still needed; today `deherm policy`
  writes the shared user cache and project cache is read-only.

Layer 0's content-addressed publication and materialization are implemented and
tested, but accepting the whole layered-cache decision waits on those items.
