import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializePolicySurface } from "../packages/compiler/src/policy-surface-materializer.mjs";
import { resolveDefoldSurface } from "../packages/cli/src/defold-surface.mjs";
import {
  BINDING_LOWERING_RECIPE_CAPABILITY,
  BINDING_LOWERING_RECIPE_EMITTER,
  BINDING_LOWERING_RECIPE_NAME
} from "../packages/compiler/src/binding-lowering-plan-recipe.mjs";
import { LOCALLY_RENDERED_OUTPUT_RECIPES } from "../packages/compiler/src/revision-output-emitter.mjs";
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
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "deherm-policy-surface-test-"));
  const outputRoot = path.join(cacheRoot, "surfaces", policy.revision);
  const first = await materializePolicySurface(policy, { outputRoot });
  assert.equal(first.descriptor.documents.length, 20);
  for (const name of [
    "defold-script-binding-patterns.json",
    "defold-dmsdk-binding-patterns.json",
    "defold-script-real-engine-probes.json"
  ]) {
    assert.ok(first.descriptor.documents.includes(name), `materialized conformance input is missing ${name}`);
  }
  assert.equal(Object.keys(first.descriptor.sdk).length, 28);
  const compiler = policy.objects.get("@compiler");
  assert.deepEqual(
    compiler.value.sdk.entries["script/types.ts"].inputs,
    ["defold-script-api-ir.json", "defold-script-sdk-documentation.json", "defold-script-handle-lowering.json"]
  );
  assert.deepEqual(
    compiler.value.sdk.entries["script/modules.ts"].inputs,
    ["defold-script-api-ir.json", "defold-script-constant-lowering.json"]
  );
  assert.deepEqual(
    compiler.value.sdk.entries["dmsdk/types.ts"].inputs,
    ["defold-sdk-ir.json", "defold-dmsdk-sdk-documentation.json"]
  );

  assert.ok(policy.policy.realizer.requiredCapabilities.includes(BINDING_LOWERING_RECIPE_CAPABILITY),
    "policy root must advertise the package lowering-recipe interpreter it requires");
  assert.ok(Buffer.byteLength(JSON.stringify(compiler.value)) < 5_000_000,
    "the compiler manifest must stay below the 5 MB transfer budget");
  const documentEntries = compiler.value.documents.entries;
  assert.ok(documentEntries[BINDING_LOWERING_RECIPE_NAME],
    "policy must carry compact lowering recipe facts");
  assert.equal(documentEntries["defold-binding-lowering-plan.json"], undefined,
    "policy must not copy the derived lowering plan");
  assert.equal(documentEntries["defold-binding-lowering-plan.sentinel.json"], undefined,
    "policy must not copy checkout cache metadata");
  const recipeObject = policy.objects.get(documentEntries[BINDING_LOWERING_RECIPE_NAME].object);
  assert.ok(Buffer.byteLength(JSON.stringify(recipeObject.value)) < 3_000_000,
    "authenticated lowering recipe facts must stay below 3 MB");

  const rendered = Object.entries(first.descriptor.sdk)
    .filter(([, record]) => record.mode === "render-and-verify").map(([name]) => name).sort();
  const snapshots = Object.entries(first.descriptor.sdk)
    .filter(([, record]) => record.mode === "authenticated-compatibility-source").map(([name]) => name).sort();
  assert.equal(rendered.length, 16);
  assert.deepEqual(snapshots, [
    "dmsdk/borrowed-handle.ts", "dmsdk/cstring-value.ts",
    "dmsdk/enum-value.ts",
    "dmsdk/scratch-scalar-out.ts",
    "script/callback-lifecycle.ts", "script/copied-value-record-blockers.ts",
    "script/dynamic-values.ts", "script/fixed-tuple-target-support.ts",
    "script/opaque-record-blockers.ts", "script/overload-dispatch-target-support.ts",
    "script/table-record-bindings.ts", "script/value-tail-target-support.ts"
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
  assert.deepEqual(bytesByMode, { rendered: 3_908_177, snapshots: 105_573 },
    "the local-emitter versus compatibility-snapshot migration debt changed");

  const expectedOutputs = await discoverCompilerSurfaceOutputs();
  assert.deepEqual(Object.keys(first.descriptor.outputs).sort(), expectedOutputs,
    "policy output manifest must own every revision-generated ABI, Static Hermes, native, and browser file");
  const renderedOutputs = Object.entries(first.descriptor.outputs)
    .filter(([, record]) => record.mode === "render-and-verify").map(([name]) => name).sort();
  assert.deepEqual(renderedOutputs, Object.keys(LOCALLY_RENDERED_OUTPUT_RECIPES).sort(),
    "package-owned revision-output emitters changed without updating their explicit inventory");
  const outputBytesByMode = { rendered: 0, snapshots: 0 };
  for (const relative of expectedOutputs) {
    const actual = await readFile(path.join(outputRoot, "repository", relative));
    const expected = await readFile(path.join(repositoryRoot, relative));
    assert.equal(sha256(actual), sha256(expected), `${relative} drifted from the source pipeline`);
    outputBytesByMode[first.descriptor.outputs[relative].mode === "render-and-verify" ? "rendered" : "snapshots"] += actual.length;
  }
  assert.deepEqual(outputBytesByMode, { rendered: 5_372, snapshots: 1_718_286 },
    "package-emitter versus revision-output snapshot debt changed");

  const scriptIr = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-script-api-ir.json"), "utf8"));
  assert.equal(scriptIr.defoldRevision, policy.revision);
  const toolchain = JSON.parse(await readFile(path.join(outputRoot, "ir", "defold-toolchain.json"), "utf8"));
  assert.equal(toolchain.kind, "deherm.policy.toolchain");
  assert.equal(toolchain.bob.urlTemplate, "https://d.defold.com/archive/{defoldRevision}/bob/bob.jar");
  assert.match(toolchain.bob.sha256, /^[0-9a-f]{64}$/u);
  assert.match(first.descriptor.toolchainSha256, /^[0-9a-f]{64}$/u);
  const resolved = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.equal(resolved.layer, "user-cache");
  assert.deepEqual(resolved.toolchain, toolchain,
    "a descriptor-backed cache must return the authenticated target matrix, not only its API files");
  const planBytes = await readFile(path.join(outputRoot, "ir", "defold-binding-lowering-plan.json"));
  const expectedPlan = oldPipelineFixture.documents["defold-binding-lowering-plan.json"];
  assert.equal(planBytes.byteLength, expectedPlan.bytes,
    "policy-only realization changed old-pipeline lowering-plan byte count");
  assert.equal(sha256(planBytes), expectedPlan.sha256,
    "policy-only realization changed old-pipeline lowering-plan bytes");
  const sentinelPath = path.join(outputRoot, "ir", "defold-binding-lowering-plan.sentinel.json");
  const sentinelBytes = await readFile(sentinelPath);
  const sentinel = JSON.parse(sentinelBytes);
  assert.equal(sentinel.generator, BINDING_LOWERING_RECIPE_EMITTER);
  assert.match(sentinel.cacheKey, /^[0-9a-f]{64}$/u);
  const second = await materializePolicySurface(policy, { outputRoot });
  assert.deepEqual(second.written, [], "materialization must be idempotent when policy and compiler are unchanged");
  assert.deepEqual(await readFile(sentinelPath), sentinelBytes,
    "keyed lowering-plan realization must preserve its sentinel bytes");

  const descriptorPath = path.join(outputRoot, "surface.json");
  const unauthenticatedDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  delete unauthenticatedDescriptor.toolchainSha256;
  await writeFile(descriptorPath, `${JSON.stringify(unauthenticatedDescriptor, null, 2)}\n`);
  const refused = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refused.blocker, "a descriptor-backed surface without an authenticated toolchain digest must be refused");
  assert.match(refused.searched[0].reason, /no authenticated toolchain digest/u);
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

test("package-owned SDK and revision-output recipes fail closed on manifest drift", async () => {
  const policy = await currentResolvedPolicy();
  const compiler = policy.objects.get("@compiler");

  const missingConstantDocument = structuredClone(compiler.value);
  delete missingConstantDocument.documents.entries["defold-script-constant-lowering.json"];
  delete missingConstantDocument.realizationRecipes.documents["defold-script-constant-lowering.json"];
  missingConstantDocument.sdk.entries["script/modules.ts"].inputs = ["defold-script-api-ir.json"];
  await assert.rejects(
    materializePolicySurface({
      ...policy,
      objects: new Map(policy.objects).set("@compiler", { ...compiler, value: missingConstantDocument })
    }, {
      outputRoot: await mkdtemp(path.join(tmpdir(), "deherm-policy-constant-document-missing-test-"))
    }),
    /missing defold-script-constant-lowering\.json/u
  );

  const scriptDocumentationKey = compiler.value.documents.entries["defold-script-sdk-documentation.json"].object;
  const scriptDocumentationObject = policy.objects.get(scriptDocumentationKey);
  const badDocumentationValue = structuredClone(scriptDocumentationObject.value);
  badDocumentationValue.value.functions[0].parameters = [];
  const badDocumentation = {
    ...policy,
    objects: new Map(policy.objects).set(scriptDocumentationKey, {
      ...scriptDocumentationObject,
      value: badDocumentationValue
    })
  };
  await assert.rejects(
    materializePolicySurface(badDocumentation, {
      outputRoot: await mkdtemp(path.join(tmpdir(), "deherm-policy-sdk-documentation-drift-test-"))
    }),
    /invalid SDK documentation fields/u
  );

  const badSdkValue = structuredClone(compiler.value);
  badSdkValue.sdk.entries["dmsdk/named-scalar.ts"].recipeInput.emittedCount = 1;
  const badSdk = {
    ...policy,
    objects: new Map(policy.objects).set("@compiler", { ...compiler, value: badSdkValue })
  };
  await assert.rejects(
    materializePolicySurface(badSdk, {
      outputRoot: await mkdtemp(path.join(tmpdir(), "deherm-policy-sdk-recipe-drift-test-"))
    }),
    /named-scalar SDK recipe requires a JavaScript-callable emitter/
  );

  const badOutputValue = structuredClone(compiler.value);
  const outputName = "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_jsi.hpp";
  badOutputValue.outputs.entries[outputName].sourceObject = "@compiler:output:unexpected";
  const badOutput = {
    ...policy,
    objects: new Map(policy.objects).set("@compiler", { ...compiler, value: badOutputValue })
  };
  await assert.rejects(
    materializePolicySurface(badOutput, {
      outputRoot: await mkdtemp(path.join(tmpdir(), "deherm-policy-output-recipe-drift-test-"))
    }),
    /unsupported compiler-output realization recipe/
  );
});

test("project surface materialization refuses symlink traversal outside its boundary", async () => {
  const policy = await currentResolvedPolicy();
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-policy-symlink-boundary-"));
  const external = await mkdtemp(path.join(tmpdir(), "deherm-policy-symlink-external-"));
  await writeFile(path.join(external, "sentinel.txt"), "unchanged\n");
  await mkdir(path.join(boundary, ".deherm", "cache"), { recursive: true });
  await symlink(external, path.join(boundary, ".deherm", "cache", "surfaces"), "dir");
  await assert.rejects(
    materializePolicySurface(policy, {
      outputBoundary: boundary,
      outputRoot: path.join(boundary, ".deherm", "cache", "surfaces", policy.revision)
    }),
    /refuses symbolic link/u
  );
  assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "unchanged\n");
});
