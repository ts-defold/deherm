import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CARRIED_REVIEW_LEDGER_ENV,
  DERIVED_REVISION_ENV,
  assertReviewedRevision,
  declaredDerivation,
  observeReviewedSource
} from "../scripts/lib/reviewed-revision.mjs";
import {
  HOLDS,
  MOVED,
  REVISION_AUDIT_ENV,
  VOID,
  classifyReviewedSource,
  readAudit,
  renderAuditSummary
} from "../scripts/lib/revision-audit.mjs";
import { auditReviewedEvidence, evidencePath, reviewedClaims } from "../scripts/lib/reviewed-evidence.mjs";
import { crossRevisionGenerationSteps } from "../scripts/check-cross-revision-derivation.mjs";
import { dmSdkGenerationSteps } from "../scripts/lib/dmsdk-generator-pipeline.mjs";
import { scriptGenerationSteps } from "../scripts/lib/script-generator-pipeline.mjs";
import {
  derivationSteps,
  derivedSurfaceRoots,
  enginePaths,
  fingerprintDifference,
  materializeWorkspace,
  ownedArtifactPaths,
  revisionSupportSteps,
  surfaceFingerprint
} from "../scripts/derive-revision.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pinned = "7f0f554f41f9dce1e0ddff99bf08200657d1ee05";
const other = "0123456789abcdef0123456789abcdef01234567";

// ── The reviewed-revision rule ──────────────────────────────────────────────

test("a review that names the revision being generated is accepted unchanged", () => {
  const result = assertReviewedRevision({ input: "reviewed.json", reviewed: pinned, derived: pinned, env: {} });
  assert.equal(result.carried, false);
});

test("a review that names another revision is refused, naming both revisions", () => {
  assert.throws(
    () => assertReviewedRevision({ input: "reviewed.json", reviewed: pinned, derived: other, env: {} }),
    (error) => error.message.includes(pinned) && error.message.includes(other)
  );
});

test("an unrelated environment cannot license a carry", () => {
  const env = { [DERIVED_REVISION_ENV]: other, [CARRIED_REVIEW_LEDGER_ENV]: "/dev/null" };
  // The declared derivation is of `other`; this generator is producing `pinned`.
  // A stale export must not silently license a different derivation.
  assert.throws(() => assertReviewedRevision({ input: "reviewed.json", reviewed: other, derived: pinned, env }));
});

test("a declared derivation may carry a review, and the carry is recorded", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-carry-"));
  const ledger = path.join(directory, "carried.jsonl");
  await writeFile(ledger, "");
  const env = { [DERIVED_REVISION_ENV]: other, [CARRIED_REVIEW_LEDGER_ENV]: ledger };
  const result = assertReviewedRevision({
    input: "reviewed.json", reviewed: pinned, derived: other, detail: "the reviewed census", env
  });
  assert.equal(result.carried, true);
  const recorded = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(recorded, [{ input: "reviewed.json", reviewed: pinned, derived: other, detail: "the reviewed census" }]);
});

test("a carry with nowhere to be recorded still happens - reporting is not a gate", () => {
  // This used to throw when the ledger environment was unset, which made the
  // REPORTING mechanism into another gate: a derivation that was otherwise fine
  // failed because of how it had been configured to describe itself. A carry
  // that cannot reach the ledger is a thinner report, not a failed derivation.
  const env = { [DERIVED_REVISION_ENV]: other };
  const result = assertReviewedRevision({ input: "reviewed.json", reviewed: pinned, derived: other, env });
  assert.equal(result.carried, true);
});

test("a malformed derivation declaration is an error, never a quiet 'not deriving'", () => {
  assert.equal(declaredDerivation({}), null);
  assert.equal(declaredDerivation({ [DERIVED_REVISION_ENV]: "" }), null);
  assert.throws(() => declaredDerivation({ [DERIVED_REVISION_ENV]: "1.13.1" }));
});

test("a non-revision on either side is refused before anything is compared", () => {
  assert.throws(() => assertReviewedRevision({ input: "reviewed.json", reviewed: pinned, derived: "unknown", env: {} }));
  assert.throws(() => assertReviewedRevision({ input: "reviewed.json", reviewed: null, derived: pinned, env: {} }));
});

// ── A moved Defold source is a new policy entry, never a failure ────────────
//
// The rule these pin is the one in `scripts/lib/revision-audit.mjs`: the source
// hash is a change detector whose output is a report, and the only observation
// that changes what we emit is a reviewed anchor that is gone.

const anchored = {
  source: "engine/a.cpp",
  sha256: createHash("sha256").update("int f() { return GUARD; }").digest("hex"),
  anchors: ["GUARD"]
};

test("an unchanged source holds", () => {
  const verdict = classifyReviewedSource("int f() { return GUARD; }", anchored);
  assert.equal(verdict.status, HOLDS);
  assert.deepEqual(verdict.anchorsLost, []);
});

test("a source Defold edited around the anchor MOVED, and still applies", () => {
  // The exact case that used to abort every derivation: Defold touched the
  // file, the reviewed evidence is untouched.
  const verdict = classifyReviewedSource("// a new comment\nint f() { return GUARD; }", anchored);
  assert.equal(verdict.status, MOVED);
  assert.equal(verdict.anchorsHeld, 1);
  assert.deepEqual(verdict.anchorsLost, []);
  assert.notEqual(verdict.observed, anchored.sha256);
});

test("a source that lost its anchor is VOID, and an absent source is too", () => {
  const lost = classifyReviewedSource("int f() { return 0; }", anchored);
  assert.equal(lost.status, VOID);
  assert.deepEqual(lost.anchorsLost, ["GUARD"]);

  const gone = classifyReviewedSource(null, anchored);
  assert.equal(gone.status, VOID);
  assert.equal(gone.reason, "absent");
  assert.equal(gone.observed, null);
});

test("observing a source records an audit line and never throws", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-audit-"));
  const audit = path.join(directory, "audit.ndjson");
  const env = { [REVISION_AUDIT_ENV]: audit };
  const verdict = observeReviewedSource({
    input: "overrides/x.json", id: "a", source: "int f() { return 0; }",
    evidence: anchored, reviewed: pinned, derived: other, env
  });
  assert.equal(verdict.status, VOID);
  const rows = readAudit(audit);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, VOID);
  assert.equal(rows[0].derived, other);
  assert.deepEqual(rows[0].anchorsLost, ["GUARD"]);
});

test("an audit with nowhere to be written loses the report, not the run", () => {
  // Same rule as the carry ledger above, and for the same reason.
  const env = { [REVISION_AUDIT_ENV]: "/dev/null/not-a-directory/audit.ndjson" };
  const verdict = observeReviewedSource({
    input: "overrides/x.json", id: "a", source: "int f() { return GUARD; }",
    evidence: anchored, reviewed: pinned, derived: pinned, env
  });
  assert.equal(verdict.status, HOLDS);
});

test("repeated observations of one claim count once in a summary", () => {
  // A derivation runs a chain of generators and several read the same reviewed
  // source; the summary reports claims, not reads.
  const rows = [
    { input: "overrides/x.json", id: "a", status: MOVED, source: "engine/a.cpp" },
    { input: "overrides/x.json", id: "a", status: MOVED, source: "engine/a.cpp" },
    { input: "overrides/x.json", id: "b", status: VOID, source: "engine/b.cpp", anchorsLost: ["GONE"] }
  ];
  const summary = renderAuditSummary(rows, { revision: other });
  assert.match(summary, /\| moved \| 2 \|/);
  assert.match(summary, /Withdrawn for this revision/);
  assert.match(summary, /GONE/);
});

// ── The reviewed-evidence census ────────────────────────────────────────────

test("a reviewed claim is any sha256 beside a path or a source, wherever it sits", () => {
  const claims = reviewedClaims("overrides/x.json", {
    sourceEvidence: [{ id: "a", source: "engine/a.cpp", sha256: "a".repeat(64), anchors: ["needle"] }],
    manifests: { profile: { path: "editor/b.appmanifest", sha256: "b".repeat(64) } },
    unrelated: { sha256: "c".repeat(64) }
  });
  assert.deepEqual(claims.map(({ file, id }) => [id, file]), [
    ["a", "upstream/defold/engine/a.cpp"],
    [null, "upstream/defold/editor/b.appmanifest"]
  ]);
});

test("an evidence path may not escape the checkout", () => {
  assert.equal(evidencePath("upstream/ref-doc.zip"), "upstream/ref-doc.zip");
  assert.throws(() => evidencePath("../../etc/passwd"));
  assert.throws(() => evidencePath("/etc/passwd"));
});

test("every reviewed claim in this checkout holds against the revision it pins", async () => {
  const audit = await auditReviewedEvidence(repositoryRoot);
  assert.ok(audit.claimCount > 0, "no reviewed claims were discovered at all");
  assert.deepEqual(audit.drifted, [], "a reviewed input no longer describes the pinned Defold sources");
});

test("a moved source is reported with the anchors that survived it", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-evidence-"));
  await mkdir(path.join(workspace, "packages/bindings/overrides"), { recursive: true });
  await mkdir(path.join(workspace, "upstream/defold/engine"), { recursive: true });
  await writeFile(path.join(workspace, "upstream/defold/engine/a.cpp"), "kept anchor, moved surroundings\n");
  await writeFile(path.join(workspace, "packages/bindings/overrides/reviewed.json"), JSON.stringify({
    sourceEvidence: [
      { id: "held", source: "engine/a.cpp", sha256: "0".repeat(64), anchors: ["kept anchor", "gone"] },
      { id: "missing", source: "engine/absent.cpp", sha256: "1".repeat(64), anchors: [] }
    ]
  }));
  const audit = await auditReviewedEvidence(workspace);
  assert.equal(audit.drifted.length, 2);
  const [content, absent] = audit.drifted;
  assert.equal(content.reason, "content");
  assert.equal(content.anchorsHeld, 1);
  assert.deepEqual(content.anchorsLost, ["gone"]);
  assert.equal(absent.reason, "absent");
});

// ── The derivation's own invariants ─────────────────────────────────────────

test("the derivation chain is declared once, and every step is a repository script", () => {
  assert.ok(derivationSteps.length > 0);
  for (const step of derivationSteps) {
    assert.match(step.script, /^scripts\/[\w.-]+\.(mjs|py)$/);
    assert.ok(["node", "python3"].includes(step.runtime));
  }
  const last = derivationSteps.at(-1);
  assert.deepEqual([last.script, last.args], ["scripts/generate-api-policy.mjs", ["--check"]]);
  assert.ok(derivationSteps.some(({ script }) => script === "scripts/generate-dmsdk-runtime.mjs"),
    "revision derivation must regenerate the complete dmSDK binding family");
  const sdk = derivationSteps.findIndex(({ script }) => script === "scripts/generate-dmsdk-sdk.mjs");
  const targets = derivationSteps.findIndex(({ script }) => script === "scripts/generate-defold-bundle-targets.mjs");
  const symbols = derivationSteps.findIndex(({ script }) => script === "scripts/generate-dmsdk-symbol-evidence.mjs");
  const dmsdkRuntime = derivationSteps.findIndex(({ script }) => script === "scripts/generate-dmsdk-runtime.mjs");
  assert.ok(targets >= 0 && sdk >= 0 && symbols > targets && symbols > sdk && dmsdkRuntime > symbols,
    "revision-derived dmSDK consumers must run after symbol evidence is measured from that revision's SDK archive");
  const plan = derivationSteps.findIndex(({ script }) => script === "scripts/ensure-binding-lowering-plan.mjs");
  const typed = derivationSteps.findIndex(({ script }) => script === "scripts/generate-typed-native-bridge.mjs");
  const recording = derivationSteps.findIndex(({ script }) => script === "scripts/generate-script-recording-engine.mjs");
  assert.ok(plan >= 0 && typed > plan && recording > plan,
    "revision-derived consumers must run after the canonical lowering plan is rebuilt");
});

test("the historical cross-revision ratchet covers both complete binding pipelines", () => {
  const expected = [
    ...scriptGenerationSteps.map(({ script }) => `script:${script}`),
    ...dmSdkGenerationSteps.map(({ script }) => `dmsdk:${script}`)
  ];
  const observed = crossRevisionGenerationSteps.map(({ surface, script }) => `${surface}:${script}`);
  assert.deepEqual(observed, expected);
  assert.equal(new Set(observed).size, observed.length,
    "a generator may not be counted twice by the cross-revision ratchet");
});

test("the final script SDK pass follows revision-local profiles before downstream consumers", () => {
  const index = (script) => scriptGenerationSteps.findIndex((step) => step.script === script);
  const profiles = index("scripts/generate-script-route-availability-profiles.mjs");
  const sdk = index("scripts/generate-script-sdk.mjs");
  const projection = index("scripts/generate-script-projection-ir.mjs");
  const typedNative = index("scripts/generate-typed-native-bridge.mjs");
  assert.ok(profiles >= 0 && sdk > profiles && projection > sdk && typedNative > projection,
    "revision-local profile data must replace the semantic bootstrap before projection and typed-native emission");
});

test("the engine slice carries the vectormath package the dmSDK importer needs", () => {
  // Without it the importer parses every `dmsdk/**` header that includes
  // `vectormath/cpp/...` against a missing include and emits a quietly degraded
  // inventory, so a CI derivation and a local derivation of the SAME revision
  // produce different policy roots.
  assert.ok(enginePaths.includes("packages"));
  assert.ok(enginePaths.includes("share/extender/variants"));
});

test("every derived revision hydrates its own digest-pinned Defold SDK before parsing", () => {
  assert.deepEqual(revisionSupportSteps, [
    { runtime: "bash", script: "scripts/bootstrap-upstreams.sh", args: ["defold-sdk"] }
  ]);
});

test("package-owned dmSDK scalar emission resolves SDK evidence from the derived revision", async () => {
  const source = await readFile(path.join(repositoryRoot, "scripts/generate-dmsdk-scalar-thunks.mjs"), "utf8");
  assert.match(source, /sdk\/\$\{defoldRevision\}\/defoldsdk/);
  assert.doesNotMatch(source, /sdk\/[0-9a-f]{40}\/defoldsdk/);
});

test("every declared surface root is a repository-relative path", () => {
  for (const entry of derivedSurfaceRoots) {
    assert.ok(!path.isAbsolute(entry) && !entry.split("/").includes(".."), entry);
  }
});

test("workspace materialization respects tracked working-tree deletions", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "deherm-materialize-source-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-materialize-target-"));
  await writeFile(path.join(source, "kept.txt"), "kept");
  await writeFile(path.join(source, "deleted.txt"), "deleted");
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["add", "kept.txt", "deleted.txt"], { cwd: source });
  await rm(path.join(source, "deleted.txt"));
  await materializeWorkspace({ sourceRoot: source, workspace });
  assert.equal(await readFile(path.join(workspace, "kept.txt"), "utf8"), "kept");
  await assert.rejects(readFile(path.join(workspace, "deleted.txt")), /ENOENT/);
});

test("the adoptable set covers the artifacts every ownership registry declares", () => {
  const owned = ownedArtifactPaths();
  assert.ok(owned.has("packages/toolchains/defold-bundle-targets.json"));
  assert.ok(owned.has("packages/toolchains/defold-platform-pairs.json"));
  assert.ok(owned.has("packages/bindings/generated/defold-dmsdk-target-conditionals.json"));
  assert.ok(owned.has("upstream.lock"));
  assert.ok(owned.has("packages/bindings/generated/defold-api-policy.json"));
  assert.ok(owned.has("packages/bindings/generated/defold-lua-registration-gate.json"));
  assert.ok(owned.has("packages/bindings/generated/defold-script-resource-namespaces.json"));
  assert.ok(owned.has(".agents/docs/research/sdk-coverage.md"));
});

test("the surface fingerprint changes when a derivable file changes, and is otherwise stable", async () => {
  const first = await surfaceFingerprint(repositoryRoot);
  const second = await surfaceFingerprint(repositoryRoot);
  assert.equal(first.root, second.root);
  assert.ok(first.files.size > 0);

  const mutated = { files: new Map(first.files), root: first.root };
  const [sample] = [...mutated.files.keys()];
  mutated.files.set(sample, "0".repeat(64));
  mutated.files.set("packages/bindings/generated/invented.json", "1".repeat(64));
  assert.deepEqual(fingerprintDifference(first, mutated), [
    { file: "packages/bindings/generated/invented.json", disposition: "added" },
    { file: sample, disposition: "changed" }
  ].sort((left, right) => left.file < right.file ? -1 : 1));
  assert.deepEqual(fingerprintDifference(mutated, first).filter(({ disposition }) => disposition === "removed"), [
    { file: "packages/bindings/generated/invented.json", disposition: "removed" }
  ]);
});
