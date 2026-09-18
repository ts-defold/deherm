---
type: Design and Verification Report
title: Canonical cross-target binding lowering plan
description: Data-oriented lowering and final-build reachability contracts for all script and dmSDK APIs across five backends.
tags: [bindings, compiler, ir, static-hermes, jsi, lua, wasm, tree-shaking]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T16:00:00-04:00 }
sources:
  - id: unified-projections
    resource: ./unified-binding-projection.md
    title: Unified script and dmSDK binding projection
    author: project:deherm
---

# Outcome

The binding compiler now has a canonical seam between complete source
projection and backend source emission. It contains all 2,287 API units—926
script routes and 1,361 dmSDK declarations—exactly once, with five explicit
backend decisions per unit:

* TypeScript SDK;
* dynamic Hermes JSI;
* Static Hermes sound C ABI;
* Lua stack;
* browser/Wasm host.

This is deliberately not a safe-subset catalog. Every dmSDK declaration has a
planned C ABI entry and a mechanically generated marshalling program. Pending
ownership, lifetime, thread, callback, template, layout, or availability work
is represented by semantic tokens and target blockers; it does not remove the
declaration from generation.

# Data-oriented representation

`scripts/generate-binding-lowering-plan.mjs` consumes both complete projection
IRs, five target capability descriptions, and an algebraic semantic-policy
catalog. The generated plan contains 11,435 backend dispositions. Repeated
marshalling programs, blocker sets, and token sets are interned into dense
tables; units store integer references. Public signatures and full effect
records remain in the source projections and are addressed by stable row plus
content hash instead of being copied into every backend record.

Semantic policies may select only surface, constructor, context, and token
properties. Identity selectors are rejected. Two rules cannot resolve the same
token for one unit, zero-match selectors fail, and a rule cannot resolve a
token the matched unit does not carry. This keeps exceptional semantics as
reviewable data without turning the compiler into a per-symbol wrapper list.

# Evidence boundary

An `emit` disposition means only that source emission is permitted. The plan
does not claim compilation, linkage, runtime execution, allocation behavior, or
conformance. Those stages must join independent evidence against the exact
plan and emitted-source hashes.

The initial plan is intentionally strict. TypeScript declarations emit for all
2,287 units, while runtime backends remain blocked wherever the current
projection still has unresolved semantic tokens. Existing generated adapters
are not automatically promoted merely because source files exist.

# Final-build reachability

Completeness does not force application bloat. API generation produces the
complete compatible catalog when Defold inputs or semantic policies change.
Normal game-code edits do not regenerate that catalog.

`scripts/generate-binding-emission-plan.mjs` is a separate final-build planner.
It joins the immutable plan with the Defold project profile and the bundler's
usage manifest, retains only explicitly reachable and compatible units, and
compacts shared marshalling tables to referenced entries. Dynamic access can
select the full pre-generated development profile. Release mode selects exact
IDs and fails closed if code references a blocked or profile-unavailable API.
Changing reachability changes only the emission-plan hash; the canonical API
plan hash remains unchanged.

The planner authenticates the canonical plan's internal digest, the exact
script-projection bytes and canonical content, and the Defold profile catalog
before selection. Semantically identical usage sets are sorted and hashed as a
normalized contract. Its output says `selectedForEmissionUnits`, not “emitted”:
generation, compilation, linkage, runtime behavior, allocation, and conformance
remain explicitly unclaimed. `build:release-plan` now runs this planner after
the bundle writes a Defold-API usage manifest; low-level dynamic stable-ID use
conservatively selects the complete currently compatible pre-generated target
surface.

# Keyed generation and explicit verification

Everyday generation is an idempotent ensure, not an unconditional rewrite.
`scripts/ensure-binding-lowering-plan.mjs` derives a content key from the exact
declared projection, target-capability, and semantic-policy inputs plus the
generator implementation. Its sentinel records that key, the canonical plan
identity, and the generated file size. When those agree, the fast path does not
read or hash the multi-megabyte generated output and writes nothing.

Deleting the sentinel, changing a declared input, changing the generator, or
passing `--force` rebuilds the disposable output atomically. Users are free to
edit generated files, but such edits are outside the fast-path contract: they
can force regeneration or request explicit verification.

Two deliberate slow paths provide that verification:

* `npm run verify:binding-lowering-plan` hashes and parses the repository plan,
  then checks its input hashes and internal identity;
* `deherm verify-generated --project <project>` hashes all six copied IR inputs
  in a generated Defold project, validates the lowering plan's internal digest
  and census, binds both to the installed package authorities, and compares
  `deherm.lock` with the generated manifest.

This keeps ordinary ensure operations proportional to declared inputs and a
single output stat while retaining an exact, user-invoked integrity audit. The
repository check runs the deep path read-only; it recomputes the internal plan
digest and the expected plan bytes, and never repairs evidence during an audit.

# Next generic runtime tranches

Two mechanical predicates dominate the next work:

1. The script handle algebra selects 407 runtime routes without route IDs: 367
   checked terminal calls, 33 producers, five self-invalidators, and two child
   invalidators. The immediate honest execution ceiling is 343 with current
   context attachments and pinned runtime symbols; generation still covers all
   407.
2. The dmSDK C-string/value algebra selects 20 global closed-shape declarations.
   Fourteen have defensible first-wave copy-in/copy-out policies; six remain
   generated with explicit domain, thread, registry-lifetime, or lifecycle
   tokens until those policies are resolved.

Both tranches use shared descriptors, semantic handle brands or bounded UTF-8
scratch, and generated target adapters. Neither is a permanent scope boundary.
