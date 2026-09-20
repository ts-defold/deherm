import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializePolicySurface } from "../packages/compiler/src/policy-surface-materializer.mjs";
import { derivePolicy } from "../scripts/generate-api-policy.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const oldPipelineFixture = JSON.parse(await readFile(path.join(
  repositoryRoot, "tests", "fixtures", "policy-surface-old-pipeline", "manifest.json"
), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function currentResolvedPolicy() {
  const derived = await derivePolicy();
  const objects = new Map(Object.entries(derived.root.subtrees).map(([namespace, digest]) => [namespace, {
    digest,
    value: JSON.parse(derived.objects.get(digest))
  }]));
  return {
    revision: derived.defoldRevision,
    entry: { policyRoot: derived.rootHash },
    policy: derived.root,
    objects
  };
}

test("authenticated policy materializes the complete generated SDK without a Defold tree", async () => {
  const policy = await currentResolvedPolicy();
  const outputRoot = await mkdtemp(path.join(tmpdir(), "deherm-policy-surface-test-"));
  const first = await materializePolicySurface(policy, { outputRoot });
  assert.equal(first.descriptor.documents.length, 12);
  assert.equal(Object.keys(first.descriptor.sdk).length, 28);

  const compiler = policy.objects.get("@compiler");
  assert.ok(Buffer.byteLength(JSON.stringify(compiler.value)) < 5_000_000,
    "the compiler manifest must stay below the 5 MB transfer budget");

  const rendered = Object.entries(first.descriptor.sdk)
    .filter(([, record]) => record.mode === "render-and-verify").map(([name]) => name).sort();
  const snapshots = Object.entries(first.descriptor.sdk)
    .filter(([, record]) => record.mode === "authenticated-compatibility-source").map(([name]) => name).sort();
  assert.equal(rendered.length, 13);
  assert.deepEqual(snapshots, [
    "dmsdk/borrowed-handle.ts", "dmsdk/cstring-value.ts",
    "dmsdk/enum-value.ts", "dmsdk/named-scalar.ts",
    "dmsdk/scratch-scalar-out.ts",
    "script/callback-lifecycle.ts", "script/copied-value-record-blockers.ts",
    "script/dynamic-values.ts", "script/fixed-tuple-target-support.ts",
    "script/opaque-record-blockers.ts", "script/overload-dispatch-target-support.ts",
    "script/table-record-bindings.ts",
    "script/url-target-support.ts", "script/value-tail-target-support.ts",
    "script/value-target-support.ts"
  ]);
  const bytesByMode = { rendered: 0, snapshots: 0 };

  for (const relative of Object.keys(first.descriptor.sdk)) {
    const actual = await readFile(path.join(outputRoot, "sdk", "generated", relative));
    const expected = oldPipelineFixture.files[relative];
    assert.ok(expected, `${relative} is absent from the independent old-pipeline fixture`);
    assert.equal(actual.length, expected.bytes, `${relative} byte count drifted from the old pipeline`);
    assert.equal(sha256(actual), expected.sha256, `${relative} drifted from the old pipeline`);
    bytesByMode[first.descriptor.sdk[relative].mode === "render-and-verify" ? "rendered" : "snapshots"] += actual.length;
  }
  assert.deepEqual(bytesByMode, { rendered: 3_434_070, snapshots: 78_171 },
    "the local-emitter versus compatibility-snapshot migration debt changed");

  const scriptIr = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-script-api-ir.json"), "utf8"));
  assert.equal(scriptIr.defoldRevision, policy.revision);
  const second = await materializePolicySurface(policy, { outputRoot });
  assert.deepEqual(second.written, [], "materialization must be idempotent when policy and compiler are unchanged");
});
