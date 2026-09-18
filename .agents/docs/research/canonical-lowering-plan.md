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
tables; units store integer references. Full ownership, lifetime, thread,
callback, invalidation, error, and scratch contracts are likewise interned so
dmSDK's composite effect records are not collapsed by the hot summary. Public
signatures remain in the source projections and are addressed by stable row
plus content hash instead of being copied into every backend record.

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

## Implementation overlays are not evidence

The plan joins generated implementation lanes back onto their canonical API
units by exact stable identity. These overlays answer a different question
from backend selection: *what generated glue currently exists for this unit?*
They never change an `emit`, `blocked-semantic`, `blocked-capability`,
`omit-profile`, or `separate-module` decision, and they never erase unresolved
semantic tokens.

Every current generated implementation family is now a declared plan input.
The script side includes scalar, structured-value, fixed-tuple, dynamic-value,
value-tail, overload, fixed-record, callback-lifecycle, handle-router, and
explicit record-blocker lanes, plus the URL/address dispatch family. The dmSDK side includes scalar, enum, named
scalar, digest, bounded span/probe, C-string, and explicit arena/span-blocker
lanes. This is a registry of generated work, not a claim that every row in a
report is executable.

Every API unit has exactly one owner lane. Units without a specialized adapter
are assigned to an explicit `script-projection-only` or
`dmsdk-projection-only` lane. Those owners mean “mechanically projected and
awaiting a reusable adapter or blocker policy,” never “implemented.” A second
lane claiming the same API identity is rejected rather than being merged by
order.

For example, `script-handle-lowering` describes the captured-Lua handle
router, its generated native descriptors, runtime-profile constraints, and
the still-unverified JSI and packaged-engine stages. `dmsdk-cstring-value`
describes private C-string staging for the TypeScript, Dynamic Hermes, Static
Hermes C ABI, and browser targets while retaining its unregistered, unlinked,
or explicitly blocked status. Candidate-only and blocker-only reports retain
those exact report states instead of being rewritten as completed work.

Each unit stores a compact `implementationSet` reference into an interned
table. The join validates the exact report schema, required Defold revision,
independent census field, stable route or projection ID, and rejects missing
identities, duplicates, overlaps, unknown IDs, and unsupported evidence-stage
tokens. Descriptive evidence paths and prose are not copied into the hot plan;
their source report is authenticated by the plan input hash. Report drift
therefore fails generation instead of silently attaching implementation
metadata—or a forged runtime claim—to the wrong API.

| Dimension | Meaning | May promote another dimension? |
|---|---|---|
| Projection | The API exists in the pinned Defold inputs | No |
| Backend selection | Semantic and capability rules permit emission | No |
| Implementation overlay | Generated glue exists for the exact API identity | No |
| Compilation | Emitted target source compiled | No |
| Linkage | Generated symbols linked and survived retention | No |
| Runtime | A real call crossed the intended runtime boundary | No |
| Conformance | Results and failures match the source contract | No |

Only an explicit verifier may record a later stage, and it must bind that
evidence to the exact plan and emitted-source hashes.

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
schema-v2 plan sentinel and generator, the exact script-projection bytes and
canonical content, and the Defold profile catalog
before selection. Semantically identical usage sets are sorted and hashed as a
normalized contract. Its output says `selectedForEmissionUnits`, not “emitted”:
generation, compilation, linkage, runtime behavior, allocation, and conformance
remain explicitly unclaimed. `build:release-plan` now runs this planner after
the bundle writes a Defold-API usage manifest; low-level dynamic stable-ID use
conservatively selects the complete currently compatible pre-generated target
surface.

`scripts/generate-release-build.mjs` is the keyed consumer for the part of the
pipeline that has an emitter today. It joins the bundler's generated-module and
Defold-API usage manifests, writes reachability-filtered JSI/native, Static
Hermes C-ABI, and browser-Wasm host sources into an atomically replaced release
directory, and emits a target-specific source inventory. A sentinel keys the
authoritative inputs and checks only declared output existence/size on the
ordinary no-write path. Explicit `--check` is read-only and hashes every
declared release output against the sentinel, so same-size edits fail without
making routine game-code builds pay that verification cost.
When passed `--project <root>`, it first verifies that project's generated
manifest/lock and derives the default API profile from the app-manifest choice;
`--platform wasm-web` also selects the browser host target unless explicitly
overridden. Explicit `--profile` and `--target` remain reproducible overrides.

The release consumer now mechanically groups selected canonical script units
by their lowering-family token, emits one stable-ID table per reachable family,
and writes a compact registry plus `sources.cmake`. Native Dynamic Hermes can
pass that generated directory to CMake through
`DEHERM_CANONICAL_RELEASE_DIR`; the JSI bridge then rejects stable IDs absent
from the release registry before entering the existing rich ScriptCallFrame
dispatch. The complete generated TypeScript SDK is unchanged—this is final
build projection, not API regeneration. The release sentinel includes every
canonical artifact's path, size, and digest and keys the canonical emitter
source, so an unchanged `--check` performs no writes.

Truth boundary: this proves deterministic pruning of registration/dispatch
glue, compilation/linking of the emitted registry in its focused harness, and
a concrete optional CMake consumer. Existing generated Lua-family
implementations are still compiled as coarse runtime objects, so this does not
yet prove implementation-object or final-binary dead stripping. Nor does it
prove a final Defold application link, runtime behavior, or per-route
conformance. The registry's flat C entrypoint forwards to the existing
single-result C ABI; Dynamic Hermes uses only its membership gate and retains
the richer JSI dispatch path for multi-result routes.

The current canonical plan authorizes a bounded Dynamic-Hermes script subset
and zero Static-Hermes or browser/Wasm routes; each generated
`requirements.json` records the exact live counts. The emitter does not
reinterpret that absence. Those targets receive compile-valid reject-all
registries and a machine-readable requirements report with exact selection and
blocker counts. They remain `blocked-by-canonical-plan` until target-specific
implementation evidence changes their backend disposition to `emit`;
generated adapter syntax and an empty registry are not claims of working
Static-Hermes or browser bindings.

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
* `deherm verify-generated --project <project>` hashes the copied IR inputs,
  including the lowering-plan sentinel,
  in a generated Defold project, validates the lowering plan's internal digest
  and census, binds both to the installed package authorities, and compares
  `deherm.lock` with the generated manifest.

This keeps ordinary ensure operations proportional to declared inputs and a
single output stat while retaining an exact, user-invoked integrity audit. The
repository check runs the deep path read-only; it recomputes the internal plan
digest and the expected plan bytes, and never repairs evidence during an audit.
Canonical ordering uses Unicode code-unit comparison instead of the process
locale; regeneration tests compare byte output under `C` and Czech locales.

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
