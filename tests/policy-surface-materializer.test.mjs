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
  assert.equal(first.descriptor.documents.length, 22);
  assert.equal(first.descriptor.schemaVersion, 2);
  assert.match(first.descriptor.policyRoot, /^[0-9a-f]{64}$/u);
  assert.match(first.descriptor.compilerObjectSha256, /^[0-9a-f]{64}$/u);
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
  assert.ok(first.descriptor.documents.includes(BINDING_LOWERING_RECIPE_NAME),
    "materialized surfaces must retain authenticated lowering recipe facts for cache verification");
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
  assert.deepEqual(outputBytesByMode, { rendered: 5_372, snapshots: 1_720_303 },
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

  await materializePolicySurface(policy, { outputRoot });
  const profilesPath = path.join(outputRoot, "ir", "defold-script-route-availability-profiles.json");
  const profiles = JSON.parse(await readFile(profilesPath, "utf8"));
  delete profiles.engineProfileSelection;
  await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
  const refusedTamperedIr = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedTamperedIr.blocker, "a modified policy-derived IR document must be refused");
  assert.match(refusedTamperedIr.searched[0].reason, /IR digest mismatch/u);

  await materializePolicySurface(policy, { outputRoot });
  const selfConsistentProfiles = JSON.parse(await readFile(profilesPath, "utf8"));
  selfConsistentProfiles.engineProfileSelection.defaultProfileId = "no-physics";
  const selfConsistentBytes = `${JSON.stringify(selfConsistentProfiles, null, 2)}\n`;
  await writeFile(profilesPath, selfConsistentBytes);
  const selfConsistentDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  selfConsistentDescriptor.ir["defold-script-route-availability-profiles.json"].sha256 = sha256(selfConsistentBytes);
  await writeFile(descriptorPath, `${JSON.stringify(selfConsistentDescriptor, null, 2)}\n`);
  const refusedSelfConsistentTamper = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedSelfConsistentTamper.blocker, "descriptor hashes cannot bless modified policy-derived IR");
  assert.match(refusedSelfConsistentTamper.searched[0].reason, /not authenticated by policy/u);

  await materializePolicySurface(policy, { outputRoot });
  const unsafeDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  unsafeDescriptor.ir["../outside.json"] = { sha256: "0".repeat(64) };
  await writeFile(descriptorPath, `${JSON.stringify(unsafeDescriptor, null, 2)}\n`);
  const refusedUnsafePath = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedUnsafePath.blocker, "descriptor paths may not escape the materialized surface");
  assert.match(refusedUnsafePath.searched[0].reason, /unsafe path/u);

  await materializePolicySurface(policy, { outputRoot });
  const sdkRelative = "script/runtime.ts";
  const sdkPath = path.join(outputRoot, "sdk", "generated", sdkRelative);
  const forgedSdk = `${await readFile(sdkPath, "utf8")}\n// forged cache source\n`;
  await writeFile(sdkPath, forgedSdk);
  const forgedSdkDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  forgedSdkDescriptor.sdk[sdkRelative].sha256 = sha256(forgedSdk);
  forgedSdkDescriptor.sdkTreeSha256 = "1".repeat(64);
  await writeFile(descriptorPath, `${JSON.stringify(forgedSdkDescriptor, null, 2)}\n`);
  const refusedSdkTamper = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedSdkTamper.blocker, "a descriptor must not bless modified SDK source");
  assert.match(refusedSdkTamper.searched[0].reason, /SDK descriptor contradicts|SDK content is not authenticated/u);

  await materializePolicySurface(policy, { outputRoot });
  const outputRelative = "packages/static-hermes/src/generated/script-vmath.ts";
  const outputPath = path.join(outputRoot, "repository", outputRelative);
  const forgedOutput = `${await readFile(outputPath, "utf8")}\n// forged cache output\n`;
  await writeFile(outputPath, forgedOutput);
  const forgedOutputDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  forgedOutputDescriptor.outputs[outputRelative].sha256 = sha256(forgedOutput);
  forgedOutputDescriptor.outputTreeSha256 = "2".repeat(64);
  await writeFile(descriptorPath, `${JSON.stringify(forgedOutputDescriptor, null, 2)}\n`);
  const refusedOutputTamper = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedOutputTamper.blocker, "a descriptor must not bless modified repository output");
  assert.match(refusedOutputTamper.searched[0].reason, /repository output descriptor contradicts|repository output content is not authenticated/u);

  await materializePolicySurface(policy, { outputRoot });
  const toolchainPath = path.join(outputRoot, "ir", "defold-toolchain.json");
  const forgedToolchain = JSON.parse(await readFile(toolchainPath, "utf8"));
  forgedToolchain.pins.EMSCRIPTEN_VERSION_STR = "forged";
  const forgedToolchainSource = `${JSON.stringify(forgedToolchain, null, 2)}\n`;
  await writeFile(toolchainPath, forgedToolchainSource);
  const forgedToolchainDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  forgedToolchainDescriptor.toolchainSha256 = sha256(forgedToolchainSource);
  await writeFile(descriptorPath, `${JSON.stringify(forgedToolchainDescriptor, null, 2)}\n`);
  const refusedToolchainTamper = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedToolchainTamper.blocker, "a descriptor must not bless modified toolchain facts");
  assert.match(refusedToolchainTamper.searched[0].reason, /toolchain is not authenticated by policy/u);

  await materializePolicySurface(policy, { outputRoot });
  const planPath = path.join(outputRoot, "ir", "defold-binding-lowering-plan.json");
  const forgedPlan = JSON.parse(await readFile(planPath, "utf8"));
  forgedPlan.forged = true;
  const { planSha256: _oldPlanSha256, ...forgedPlanBody } = forgedPlan;
  forgedPlan.planSha256 = sha256(JSON.stringify(forgedPlanBody));
  const forgedPlanSource = `${JSON.stringify(forgedPlan, null, 2)}\n`;
  await writeFile(planPath, forgedPlanSource);
  const forgedSentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
  forgedSentinel.outputBytes = Buffer.byteLength(forgedPlanSource);
  forgedSentinel.outputSha256 = sha256(forgedPlanSource);
  forgedSentinel.planSha256 = forgedPlan.planSha256;
  const forgedSentinelSource = `${JSON.stringify(forgedSentinel, null, 2)}\n`;
  await writeFile(sentinelPath, forgedSentinelSource);
  const forgedPlanDescriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  forgedPlanDescriptor.ir["defold-binding-lowering-plan.json"].sha256 = sha256(forgedPlanSource);
  forgedPlanDescriptor.ir["defold-binding-lowering-plan.sentinel.json"].sha256 = sha256(forgedSentinelSource);
  await writeFile(descriptorPath, `${JSON.stringify(forgedPlanDescriptor, null, 2)}\n`);
  const refusedPlanTamper = await resolveDefoldSurface(policy.revision, {
    env: { DEHERM_CACHE_HOME: cacheRoot }
  });
  assert.ok(refusedPlanTamper.blocker, "self-consistent lowering output must remain bound to authenticated recipe facts");
  assert.match(refusedPlanTamper.searched[0].reason, /not derived from its authenticated recipe/u);
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
