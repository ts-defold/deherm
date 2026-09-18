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
