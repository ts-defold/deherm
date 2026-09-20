import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializePolicySurface } from "../packages/generator/src/policy/surface-materializer.mjs";
import { derivePolicy } from "../scripts/generate-api-policy.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

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

  for (const relative of Object.keys(first.descriptor.sdk)) {
    const [actual, expected] = await Promise.all([
      readFile(path.join(outputRoot, "sdk", "generated", relative)),
      readFile(path.join(repositoryRoot, "packages", "sdk", "src", "generated", relative))
    ]);
    assert.deepEqual(actual, expected, `${relative} did not materialize byte-for-byte`);
  }

  const scriptIr = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-script-api-ir.json"), "utf8"));
  assert.equal(scriptIr.defoldRevision, policy.revision);
  const second = await materializePolicySurface(policy, { outputRoot });
  assert.deepEqual(second.written, [], "materialization must be idempotent when policy and compiler are unchanged");
});
