import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateScriptApiAccounting } from "../scripts/generate-script-api-accounting.mjs";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function inputs() {
  const definitionPaths = [
    "bindings/overrides/script-defold-value-bindings.json",
    "bindings/overrides/script-defold-handle-bindings.json",
    "bindings/overrides/script-go-current-instance-bindings.json",
    "bindings/overrides/script-msg-structured-bindings.json",
    "bindings/overrides/script-factory-structured-bindings.json",
    "bindings/overrides/script-gui-structured-bindings.json"
  ];
  const valueDefinitions = await Promise.all(definitionPaths.map(async (path) => {
    const definitionText = await text(path);
    const definition = JSON.parse(definitionText);
    const additionalSources = await Promise.all((definition.additionalSourceEvidence ?? []).map(async ({ source }) => ({
      source,
      sourceText: await text(`upstream/defold/${source}`)
    })));
    return {
      path,
      definitionText,
      sourceText: await text(`upstream/defold/${definition.source}`),
      additionalSources
    };
  }));
  const urlOverrideText = await text("bindings/overrides/script-url-address-classification.json");
  const urlOverride = JSON.parse(urlOverrideText);
  const urlSourceTexts = new Map(await Promise.all(urlOverride.sourceEvidence.map(async ({ source }) => [
    source,
    await text(`upstream/defold/${source}`)
  ])));
  return {
    inventoryText: await text("bindings/generated/defold-script-api-inventory.json"),
    irText: await text("bindings/generated/defold-script-api-ir.json"),
    patternsText: await text("bindings/generated/defold-script-binding-patterns.json"),
    descriptorsText: await text("bindings/generated/defold-script-binding-descriptors.json"),
    scalarText: await text("bindings/generated/defold-script-scalar-dispatch.json"),
    valueText: await text("bindings/generated/defold-script-value-bindings.json"),
    tupleText: await text("bindings/generated/defold-script-fixed-tuples.json"),
    urlText: await text("bindings/generated/defold-script-url-address-classification.json"),
    urlOverrideText,
    urlSourceTexts,
    valueDefinitions
  };
}

const sourceInputs = await inputs();
const generated = generateScriptApiAccounting(sourceInputs);
const checked = JSON.parse(await text("bindings/generated/defold-script-api-accounting.json"));

function replaceJson(input, mutate) {
  const value = JSON.parse(input);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("accounts for all 926 APIs in one and only one category", () => {
  assert.equal(generated.functionCount, 926);
  assert.deepEqual(generated.categoryCounts, {
    "executable-stable-id": 262,
    "separate-module": 3,
    pending: 661
  });
  assert.deepEqual(generated.pendingByLoweringFamily, {
    "borrowed-handle": 415,
    "callback-lifecycle": 25,
    "defold-value": 26,
    "dynamic-values": 14,
    "lua-table": 148,
    "multi-result": 13,
    "overload-dispatch": 20
  });
  assert.equal(new Set(generated.rows.map(({ id }) => id)).size, 926);
  assert.equal(generated.rows.filter(({ category }) => category === "pending").length, 661);
  assert.ok(generated.rows.filter(({ category }) => category === "pending")
    .every(({ reason }) => reason.code && reason.loweringFamily));
  assert.deepEqual(checked, generated);
});

test("keeps stable-ID and separate-module evidence explicit and bounded", () => {
  const executable = generated.rows.filter(({ category }) => category === "executable-stable-id");
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "scalar-lua-dispatch").length, 90);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "native-value-dispatch").length, 78);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "fixed-tuple-lua-dispatch").length, 24);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "url-lua-dispatch").length, 70);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "gui-node-setters").length, 39);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "vmath-fixed-pod").length, 11);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "vmath-matrix4").length, 14);
  assert.equal(new Set(executable.map(({ evidence }) => evidence.stableId)).size, executable.length);
  const currentPosition = executable.find(({ id }) => id === "script:go.get_position");
  assert.deepEqual(currentPosition.evidence.implementedCallShapes, [[]]);
  assert.equal(currentPosition.evidence.callShapes.length > currentPosition.evidence.implementedCallShapes.length, true);
  assert.deepEqual(
    generated.rows.filter(({ category }) => category === "separate-module").map(({ id }) => id),
    ["script:timer.cancel", "script:timer.delay", "script:timer.trigger"]
  );
  assert.match(generated.coverageClaim, /does not claim per-target or per-function engine conformance/);
});

test("is invariant to harmless generated-family row ordering", () => {
  const reordered = structuredClone(sourceInputs);
  reordered.urlText = replaceJson(reordered.urlText, (value) => value.rows.reverse());
  const result = generateScriptApiAccounting(reordered);
  assert.deepEqual(result.rows, generated.rows);
  assert.deepEqual(result.categoryCounts, generated.categoryCounts);
});

test("rejects duplicate, omitted, overlapping, and stale route evidence", () => {
  const duplicate = structuredClone(sourceInputs);
  duplicate.scalarText = replaceJson(duplicate.scalarText, (value) => value.bindings.push(value.bindings[0]));
  assert.throws(() => generateScriptApiAccounting(duplicate), /bindingCount is stale|duplicate id/);

  const omitted = structuredClone(sourceInputs);
  omitted.valueText = replaceJson(omitted.valueText, (value) => {
    value.bindings.pop();
    value.bindingCount -= 1;
  });
  assert.throws(() => generateScriptApiAccounting(omitted),
    /generated route count differs from reviewed family metadata|does not match reviewed value definitions/);

  const overlapping = structuredClone(sourceInputs);
  const valueRow = JSON.parse(overlapping.valueText).bindings[0];
  overlapping.scalarText = replaceJson(overlapping.scalarText, (value) => {
    value.bindings.push(valueRow);
    value.bindingCount += 1;
  });
  assert.throws(() => generateScriptApiAccounting(overlapping), /stale against scalar-classified bindings/);

  const stalePatterns = structuredClone(sourceInputs);
  stalePatterns.patternsText = replaceJson(stalePatterns.patternsText, (value) => {
    value.sourceSha256 = "0".repeat(64);
  });
  assert.throws(() => generateScriptApiAccounting(stalePatterns), /patterns are stale against script IR/);

  const staleDescriptors = structuredClone(sourceInputs);
  staleDescriptors.descriptorsText = replaceJson(staleDescriptors.descriptorsText, (value) => {
    value.hot.stableId[0] ^= 1;
  });
  assert.throws(() => generateScriptApiAccounting(staleDescriptors), /descriptors are stale/);

  const staleInventory = structuredClone(sourceInputs);
  staleInventory.inventoryText = replaceJson(staleInventory.inventoryText, (value) => {
    value.declarations.find(({ kind }) => kind === "function").line += 1;
  });
  assert.throws(() => generateScriptApiAccounting(staleInventory), /source line differs from inventory/);

  const malformedUrl = structuredClone(sourceInputs);
  malformedUrl.urlText = replaceJson(malformedUrl.urlText, (report) => {
    report.rows[0].requiredArgumentCount = 0;
    report.rows[0].maximumArgumentCount = 255;
    report.rows[0].argumentCodecs = [["Nil"]];
    report.rows[0].resultCodec = "Quaternion";
  });
  assert.throws(() => generateScriptApiAccounting(malformedUrl),
    /URL binding report semantics are stale against pinned inputs/);
});

test("rejects stale reviewed Defold source evidence", () => {
  const stale = structuredClone(sourceInputs);
  stale.valueDefinitions[0].sourceText += "\n// changed\n";
  assert.throws(() => generateScriptApiAccounting(stale), /is stale against/);
});

test("check command proves the checked-in report is current", () => {
  execFileSync(process.execPath, ["scripts/generate-script-api-accounting.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
});
