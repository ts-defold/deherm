import assert from "node:assert/strict";
import test from "node:test";

import {
  dmSdkGenerationSteps,
  dmSdkGeneratorSources,
  dmSdkPinnedInputs,
  generatedDmSdkArtifacts
} from "../scripts/lib/dmsdk-generator-pipeline.mjs";
import { runDmSdkGeneration } from "../scripts/generate-dmsdk-runtime.mjs";

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

function assertConfined(values, label) {
  for (const value of values) {
    assert.equal(typeof value, "string", `${label} contains a non-string path`);
    assert.ok(value.length > 0, `${label} contains an empty path`);
    assert.equal(value.startsWith("/"), false, `${label} contains an absolute path: ${value}`);
    assert.equal(value.split("/").includes(".."), false, `${label} escapes the repository: ${value}`);
  }
}

test("dmSDK generator pipeline has one deterministic ownership registry", () => {
  const stepScripts = dmSdkGenerationSteps.map(({ script }) => script);
  for (const [values, label] of [
    [dmSdkGeneratorSources, "generator sources"],
    [dmSdkPinnedInputs, "pinned inputs"],
    [generatedDmSdkArtifacts, "generated artifacts"],
    [stepScripts, "generation steps"],
  ]) {
    assertUnique(values, label);
    assertConfined(values, label);
  }
  assert.deepEqual(stepScripts, [
    "scripts/classify-dmsdk-bindings.mjs",
    "scripts/generate-dmsdk-scalar-thunks.mjs",
    "scripts/generate-dmsdk-abi-shapes.mjs",
    "scripts/generate-dmsdk-named-scalar-bindings.mjs",
    "scripts/generate-dmsdk-enum-value-bindings.mjs",
    "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
    "scripts/generate-dmsdk-base64-span-bindings.mjs",
    "scripts/generate-dmsdk-astc-probe-bindings.mjs",
    "scripts/generate-dmsdk-xtea-span-bindings.mjs",
    "scripts/generate-dmsdk-hash-span-bindings.mjs",
    "scripts/generate-dmsdk-arena-span-blockers.mjs",
  ]);
  for (const step of dmSdkGenerationSteps) {
    assert.equal(step.runtime, "node");
    assert.ok(dmSdkGeneratorSources.includes(step.script), `unowned generation step: ${step.script}`);
  }
  for (const artifact of generatedDmSdkArtifacts) {
    assert.equal(dmSdkGeneratorSources.includes(artifact), false, `artifact is also a generator source: ${artifact}`);
    assert.equal(dmSdkPinnedInputs.includes(artifact), false, `artifact is also a pinned input: ${artifact}`);
  }
});

test("dmSDK runtime orchestrator consumes the registry in check mode", async () => {
  const results = await runDmSdkGeneration({ check: true });
  assert.deepEqual(results.map(({ script }) => script), dmSdkGenerationSteps.map(({ script }) => script));
  assert.ok(results.every(({ stdout }) => stdout.startsWith("Verified")));
});
