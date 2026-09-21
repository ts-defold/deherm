import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializePolicySurface } from "../packages/compiler/src/policy-surface-materializer.mjs";
import { derivePolicy, discoverCompilerSurfaceOutputs } from "../scripts/generate-api-policy.mjs";

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
  assert.equal(first.descriptor.documents.length, 17);
  for (const name of [
    "defold-script-binding-patterns.json",
    "defold-dmsdk-binding-patterns.json",
    "defold-script-real-engine-probes.json"
  ]) {
    assert.ok(first.descriptor.documents.includes(name), `materialized conformance input is missing ${name}`);
  }
  assert.equal(Object.keys(first.descriptor.sdk).length, 28);
  assert.equal(Object.keys(first.descriptor.outputs).length, 114);

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
    assert.ok(expected, `${relative} is absent from the frozen source-pipeline golden`);
    assert.equal(actual.length, expected.bytes, `${relative} byte count drifted from the old pipeline`);
    assert.equal(sha256(actual), expected.sha256, `${relative} drifted from the old pipeline`);
    bytesByMode[first.descriptor.sdk[relative].mode === "render-and-verify" ? "rendered" : "snapshots"] += actual.length;
  }
  assert.deepEqual(bytesByMode, { rendered: 3_790_371, snapshots: 79_846 },
    "the local-emitter versus compatibility-snapshot migration debt changed");

  const expectedOutputs = await discoverCompilerSurfaceOutputs();
  assert.deepEqual(Object.keys(first.descriptor.outputs).sort(), expectedOutputs,
    "policy output manifest must own every revision-generated ABI, Static Hermes, native, and browser file");
  let outputBytes = 0;
  for (const relative of expectedOutputs) {
    const actual = await readFile(path.join(outputRoot, "repository", relative));
    const expected = await readFile(path.join(repositoryRoot, relative));
    assert.equal(sha256(actual), sha256(expected), `${relative} drifted from the source pipeline`);
    outputBytes += actual.length;
  }
  assert.equal(outputBytes, 1_535_653, "revision-generated policy-output bytes changed");

  const scriptIr = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-script-api-ir.json"), "utf8"));
  assert.equal(scriptIr.defoldRevision, policy.revision);
  const toolchain = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-toolchain.json"), "utf8"));
  assert.equal(toolchain.kind, "deherm.policy.toolchain");
  assert.equal(toolchain.bob.urlTemplate, "https://d.defold.com/archive/{defoldRevision}/bob/bob.jar");
  assert.match(toolchain.bob.sha256, /^[0-9a-f]{64}$/u);
  assert.match(first.descriptor.toolchainSha256, /^[0-9a-f]{64}$/u);
  const second = await materializePolicySurface(policy, { outputRoot });
  assert.deepEqual(second.written, [], "materialization must be idempotent when policy and compiler are unchanged");
});

test("policy materialization fails closed when the dmSDK catalog exceeds the package frame", async () => {
  const policy = await currentResolvedPolicy();
  const compiler = policy.objects.get("@compiler");
  const catalogKey = compiler.value.documents.entries["defold-dmsdk-universal-bindings.json"].object;
  const catalogObject = policy.objects.get(catalogKey);
  const value = structuredClone(catalogObject.value);
  const catalog = value.value;
  catalog.abi.maxArguments = 33;
  catalog.recipes[0].abi.argumentCount = 33;
  const oversized = {
    ...policy,
    objects: new Map(policy.objects).set(catalogKey, { ...catalogObject, value })
  };
  const outputRoot = await mkdtemp(path.join(tmpdir(), "deherm-policy-capacity-test-"));
  await assert.rejects(
    materializePolicySurface(oversized, { outputRoot }),
    /requires 33 arguments.*supports 32.*upgrade @ts-defold\/deherm/u
  );
});
