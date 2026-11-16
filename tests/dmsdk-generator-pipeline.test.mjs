import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dmSdkGenerationSteps,
  dmSdkGeneratorSources,
  dmSdkPinnedInputs,
  generatedDmSdkArtifacts,
  generatedDmSdkArtifactsFor,
} from "../scripts/lib/dmsdk-generator-pipeline.mjs";
import {
  assertDeclaredYamlDependency,
  assertGeneratedDmSdkArtifactInventory,
} from "../scripts/check-dmsdk-clean-room-regeneration.mjs";
import { runDmSdkGeneration } from "../scripts/generate-dmsdk-runtime.mjs";
import { pruneEnumValueSources } from "../scripts/generate-dmsdk-enum-value-bindings.mjs";
import { isOwnedArtifact } from "../scripts/derive-revision.mjs";
import {
  generateRevisionOutput,
  revisionOutputContract,
  DMSDK_ENUM_VALUE_RECIPE,
} from "../packages/compiler/src/revision-output-emitter.mjs";
import {
  DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME,
  renderDmSdkEnumValueOutputs,
} from "../packages/compiler/src/dmsdk-enum-value-output-emitter.mjs";

test("new enum source groups flow through ownership, clean-room inventory and local policy rendering", async () => {
  const facts = JSON.parse(
    await readFile(new URL(`../packages/bindings/generated/${DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME}`, import.meta.url)),
  );
  for (const name of ["profile", "unseen_future_module"]) {
    const entry = structuredClone(facts.entries[0]);
    entry.id = facts.entries.length;
    entry.group = { name, include: `dmsdk/dlib/${name}.h` };
    entry.wrapper = `deherm_test_${name}`;
    facts.entries.push(entry);
    const relative = `defold/defold_hermes/src/generated_dmsdk_enum_value_${name}.cpp`;
    const expected = renderDmSdkEnumValueOutputs(facts).sources[name];
    assert.match(expected, new RegExp(`#include <dmsdk/dlib/${name}\\.h>`));
    assert.ok(isOwnedArtifact(relative), "a new Defold group must not require an ownership-list edit");
    assert.deepEqual(revisionOutputContract(relative), {
      recipe: DMSDK_ENUM_VALUE_RECIPE,
      inputs: [DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME],
    });
    assert.equal(
      generateRevisionOutput(relative, DMSDK_ENUM_VALUE_RECIPE, { [DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME]: facts }),
      expected,
    );
    const inventory = generatedDmSdkArtifactsFor(facts);
    assert.ok(inventory.includes(relative));
    assert.throws(
      () =>
        assertGeneratedDmSdkArtifactInventory(
          inventory.filter((file) => file !== relative),
          inventory,
        ),
      /Missing:/u,
    );
    assert.throws(
      () => assertGeneratedDmSdkArtifactInventory([...inventory, `${relative}.unexpected`], inventory),
      /Unexpected/u,
    );
  }
  assert.equal(isOwnedArtifact("defold/defold_hermes/src/hand_authored.cpp"), false);
  assert.equal(isOwnedArtifact("defold/defold_hermes/src/generated_dmsdk_enum_value_../outside.cpp"), false);
});

test("removed enum groups are pruned without deleting current outputs or unrelated source", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-enum-prune-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const relativeRoot = "defold/defold_hermes/src";
  const sourceRoot = path.join(root, relativeRoot);
  await mkdir(sourceRoot, { recursive: true });
  const kept = ["generated_dmsdk_enum_value_runtime.cpp", "generated_dmsdk_enum_value_new_group.cpp"];
  const obsolete = "generated_dmsdk_enum_value_old_group.cpp";
  for (const file of [...kept, obsolete, "unrelated.cpp"]) await writeFile(path.join(sourceRoot, file), file);
  const artifacts = new Map(kept.map((file) => [`${relativeRoot}/${file}`, file]));
  await assert.rejects(pruneEnumValueSources(root, artifacts, true), /obsolete for the selected revision/u);
  assert.equal(await readFile(path.join(sourceRoot, obsolete), "utf8"), obsolete);
  await pruneEnumValueSources(root, artifacts);
  assert.deepEqual((await readdir(sourceRoot)).sort(), [...kept, "unrelated.cpp"].sort());
  await pruneEnumValueSources(root, artifacts, true);
});

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
    "scripts/generate-dmsdk-target-conditionals.mjs",
    "scripts/classify-dmsdk-bindings.mjs",
    "scripts/generate-dmsdk-abi-shapes.mjs",
    "scripts/generate-dmsdk-source-semantic-facts.mjs",
    "scripts/generate-dmsdk-cpp-ownership-effect-facts.mjs",
    "scripts/generate-dmsdk-bounded-span-plan.mjs",
    "scripts/generate-dmsdk-value-plan.mjs",
    "scripts/generate-dmsdk-hash-state-plan.mjs",
    "scripts/generate-dmsdk-scalar-thunks.mjs",
    "scripts/generate-dmsdk-named-scalar-bindings.mjs",
    "scripts/generate-dmsdk-enum-value-bindings.mjs",
    "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
    "scripts/generate-dmsdk-base64-span-bindings.mjs",
    "scripts/generate-dmsdk-astc-probe-bindings.mjs",
    "scripts/generate-dmsdk-xtea-span-bindings.mjs",
    "scripts/generate-dmsdk-hash-span-bindings.mjs",
    "scripts/generate-dmsdk-hash-state-bindings.mjs",
    "scripts/generate-dmsdk-arena-span-blockers.mjs",
    "scripts/generate-dmsdk-projection-ir.mjs",
    "scripts/generate-dmsdk-cstring-value-plan.mjs",
    "scripts/generate-dmsdk-borrowed-handle-plan.mjs",
    "scripts/generate-dmsdk-scratch-scalar-out-plan.mjs",
    "scripts/generate-dmsdk-borrowed-handle-bindings.mjs",
    "scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs",
    "scripts/generate-dmsdk-cstring-value-bindings.mjs",
    "scripts/generate-dmsdk-universal-bindings.mjs",
    "scripts/generate-dmsdk-generated-adapter-exact.mjs",
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

test("the dmSDK clean room accepts only the exact lockfile-declared YAML parser", () => {
  const valid = {
    rootPackage: { dependencies: { yaml: "2.8.3" } },
    lockfile: "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n\n  yaml@2.8.3:\n",
    installedPackage: { name: "yaml", version: "2.8.3" },
  };
  assert.equal(assertDeclaredYamlDependency(valid), "2.8.3");
  assert.throws(
    () =>
      assertDeclaredYamlDependency({
        ...valid,
        installedPackage: { name: "yaml", version: "2.8.2" },
      }),
    /does not match package\.json/u,
  );
  assert.throws(
    () =>
      assertDeclaredYamlDependency({
        ...valid,
        lockfile: "lockfileVersion: '9.0'\n",
      }),
    /does not pin yaml@2\.8\.3/u,
  );
});

test("dmSDK runtime orchestrator consumes the registry in check mode", async () => {
  const results = await runDmSdkGeneration({ check: true });
  assert.deepEqual(
    results.map(({ script }) => script),
    dmSdkGenerationSteps.map(({ script }) => script),
  );
  assert.ok(results.every(({ stdout }) => stdout.startsWith("Verified")));
});
