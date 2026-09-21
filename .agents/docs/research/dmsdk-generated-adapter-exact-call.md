---
type: Design and Verification Report
title: dmSDK callable generated-adapter exact-call corpus
description: Same-recipe C ABI and JSI verification twins for the 59 callable generated-adapter routes, plus the 21-row named-scalar sibling ABI, without changing the 1,361-recipe universal catalog.
tags: [dmsdk, generated-adapter, named-scalar, exact-call, jsi, c-abi, verification]
status: active
generated: { by: codex, at: 2026-09-20T00:00:00-04:00 }
---

# Outcome

The 59 callable `generated-adapter` dmSDK rows now have a deterministic exact
corpus derived from the same 1,361 production recipes and the eight owning
family reports. The derivative joins every recipe to its family-local adapter
ID and production C ABI dispatcher, records ordered native arguments and the
result ABI, and hashes each vector independently. It does not mutate or reseal
the policy-owned universal catalog.

The direct-adapter partition is total: 26 scalar, seven enum-value, fourteen C-string/value,
four fixed-digest, two hash-span, two base64-span, two XTEA-span, and two ASTC
probe vectors. No recipe is removed: the source catalog remains 1,361 recipes,
with 59 callable generated adapters, 566 universal-ready rows, and 736 rows
that still fail closed pending specialization.

The separate named-scalar family now derives 21 typed C wrappers, raw-cell
dispatcher cases, descriptors, and exact-call fake callees from one structural
recipe per declaration. Its earlier 21 policy blockers were semantic prose
over fully known scalar ABIs. The generator instead resolves `dmhash_t` and
`ProfileIdx` to `uint64_t`, `Thread` and `TlsKey` to `uintptr_t`, and admits the
built-in signed, unsigned, boolean, float, double, and void lanes. An absent or
unresolved source alias remains the only admission blocker. This sibling family
deliberately leaves all 21 universal recipes on their universal fallback and
therefore does not alter the 59-row generated-adapter corpus above.

# Production boundaries

All 59 vectors bind the production family C ABI dispatcher and its exact
family-local ID. The generated native executable links all eight production
dispatcher implementations to generated recording/fake callees. It invokes
every dispatcher, compares position-distinct native argument sentinels, checks
the returned or copied-out result, and also rejects descriptor count, order,
ID, or source-ID drift.

The two installed families that emit a production JSI host module—scalar and
enum-value—also own 33 generated JSI vectors. A real Hermes runtime loads the
production host functions and drives every vector into an ABI-compatible
recording C callee. The verifier uses position-distinct type-valid values,
compares every decoded raw lane, and checks the returned JSI type and value.
The staged-private C-string JSI source is deliberately excluded because it is
not installed or compiled by the production package. The remaining 26
C-string/span/digest/probe vectors make no production JSI claim.

# Fail-closed generation

`scripts/generate-dmsdk-generated-adapter-exact.mjs` performs the family join
from generated reports. Duplicate family ownership, absent local IDs, family
disagreement, missing descriptor contracts, catalog/index digest drift, and
stale committed outputs are errors. Tests generate only into a temporary root
and byte-compare all three committed artifacts, so a test run cannot self-heal
the checkout. The exact derivative records both the
unchanged production catalog hash and its own enriched exact-catalog hash.

# Evidence

`tests/dmsdk-universal-bindings.test.mjs` verifies the 59-vector census,
per-family partition, unique vector hashes, all 1,361 source recipes, zero
silent omissions, byte-identical temporary-root regeneration, linked execution
of all 59 production C ABI dispatcher routes, and execution of all 33 installed
JSI vectors through real Hermes and the production host modules.

`tests/dmsdk-named-scalar-bindings.test.mjs` separately regenerates all seven
named-scalar artifacts into a temporary root, compiles the production wrapper
and dispatcher against the pinned packaged SDK, links all 21 generated fake
callees, checks argument order and result bits for every lane, validates
descriptor identity, and observes zero C++ allocations across 100,000 warmed
dispatches. It makes no JavaScript, engine-semantic, or packaged-engine claim.

The focused dmSDK runtime suite compiles and executes the production families,
including the separately generated borrowed-handle provider boundary, and
passes 97 of 97 tests. Clean-room, exact-call, release-reachability, and JSI
checks remain separate so their evidence boundaries are not conflated.

# Evidence boundary

These tests prove generated bridge identity, family selection, native argument
ordering, result transfer, descriptor agreement, and JSI-to-C decoding. They do
not claim Defold implementation semantics, packaged-engine behavior, or a JSI
transport for the twelve families that do not emit one.
