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
| 0 | The pinned Defold engine surface | Defold revision | the déherm package |
| 1 | Curated policies for audited extensions | archive content hash | the déherm package |
| 2 | Project-local policies for the user's own and unaudited extensions | archive or tree content hash | the user's project, committed |
| 3 | Parse from source | — | nothing; produces a layer-2 policy |

Layer 0 means the engine surface costs nothing to consume and requires no engine
checkout. Layer 1 means common extensions cost nothing either. Layer 2 means an
unknown extension is parsed once per project and then committed, so the next
generation — and every teammate and CI run — reuses it. Layer 3 runs only when
nothing matches.

# Binding a policy to its input

A policy is only valid for the exact bytes it was derived from.

* The key is the content hash of the extension archive or tree, not its version
  string, URL, or declared revision. Publishers retag.
* A policy also records the **generator revision** that produced it. Improving
  the parser invalidates every policy derived by an older one, because the newer
  parser may resolve a construct the older one blocked.
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
* A policy is reviewable. A diff showing a parameter changing from required to
  optional is a visible event rather than a silent regeneration.

# Boundary

A policy is source-derived evidence about a *declared surface*. It is not
runtime evidence. It does not establish that a registered function behaves as
its C body suggests, only that the registration and stack usage say what they
say. Runtime conformance remains the headless engine harness's job.

# Layer 0 in the CLI

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

Producing a surface for a new revision reads that revision's
`engine/share/ref-doc.zip` and engine source tree, so it needs network access
and is a separate explicit step - never something `deherm generate` does on its
own. A revision already in a cache regenerates entirely offline.

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
