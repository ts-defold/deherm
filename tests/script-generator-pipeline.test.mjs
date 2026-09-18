import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedScriptArtifacts,
  scriptGenerationSteps,
  scriptGeneratorSources,
  scriptPinnedInputs
} from "../scripts/lib/script-generator-pipeline.mjs";

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

test("script generator pipeline has one deterministic ownership registry", () => {
  const stepScripts = scriptGenerationSteps.map(({ script }) => script);
  assertUnique(scriptGeneratorSources, "generator sources");
  assertUnique(scriptPinnedInputs, "pinned inputs");
  assertUnique(generatedScriptArtifacts, "generated artifacts");
  assertUnique(stepScripts, "generation steps");
  assertConfined(scriptGeneratorSources, "generator sources");
  assertConfined(scriptPinnedInputs, "pinned inputs");
  assertConfined(generatedScriptArtifacts, "generated artifacts");
  assertConfined(stepScripts, "generation steps");

  for (const step of scriptGenerationSteps) {
    assert.ok(["node", "python3"].includes(step.runtime), `unsupported generator runtime: ${step.runtime}`);
    assert.ok(scriptGeneratorSources.includes(step.script), `unowned generation step: ${step.script}`);
  }
  for (const artifact of generatedScriptArtifacts) {
    assert.equal(scriptGeneratorSources.includes(artifact), false, `artifact is also a generator source: ${artifact}`);
    assert.equal(scriptPinnedInputs.includes(artifact), false, `artifact is also a pinned input: ${artifact}`);
  }
});
