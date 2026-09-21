---
type: Design and Verification Report
title: dmSDK callable generated-adapter exact-call corpus
description: Same-recipe C ABI and JSI verification twins for the 59 callable generated-adapter routes without changing the 1,361-recipe policy catalog.
tags: [dmsdk, generated-adapter, exact-call, jsi, c-abi, verification]
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

The partition is total: 26 scalar, seven enum-value, fourteen C-string/value,
four fixed-digest, two hash-span, two base64-span, two XTEA-span, and two ASTC
probe vectors. No recipe is removed: the source catalog remains 1,361 recipes,
with 59 callable generated adapters, 486 universal-ready rows, and 816 rows
that still fail closed pending specialization.

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

The focused dmSDK runtime suite also compiles and executes the eight production
families and passes 86 of 86 tests. The earlier `enum-handle` 862/867 failure
was a stale test literal: both the checked-in baseline classification artifact
and deterministic regeneration report 867; the expectation is now aligned.
The focused exact/release/JSI and clean-room suites pass 44 of 44.

# Evidence boundary

These tests prove generated bridge identity, family selection, native argument
ordering, result transfer, descriptor agreement, and JSI-to-C decoding. They do
not claim Defold implementation semantics, packaged-engine behavior, or a JSI
transport for the twelve families that do not emit one.
