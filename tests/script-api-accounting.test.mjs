import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateScriptApiAccounting } from "../scripts/generate-script-api-accounting.mjs";
import { generateScriptUrlAddressClassification } from "../scripts/generate-script-url-address-classification.mjs";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function inputs() {
  const definitionPaths = [
    "packages/bindings/overrides/script-defold-value-bindings.json",
    "packages/bindings/overrides/script-defold-handle-bindings.json",
    "packages/bindings/overrides/script-go-current-instance-bindings.json",
    "packages/bindings/overrides/script-msg-structured-bindings.json",
    "packages/bindings/overrides/script-factory-structured-bindings.json",
    "packages/bindings/overrides/script-gui-structured-bindings.json",
  ];
  const valueDefinitions = await Promise.all(
    definitionPaths.map(async (path) => {
      const definitionText = await text(path);
      const definition = JSON.parse(definitionText);
      const additionalSources = await Promise.all(
        (definition.additionalSourceEvidence ?? []).map(async ({ source }) => ({
          source,
          sourceText: await text(`upstream/defold/${source}`),
        })),
      );
      return {
        path,
        definitionText,
        sourceText: await text(`upstream/defold/${definition.source}`),
        additionalSources,
      };
    }),
  );
  const urlOverrideText = await text("packages/bindings/overrides/script-url-address-classification.json");
  const urlOverride = JSON.parse(urlOverrideText);
  const urlSourceTexts = new Map(
    await Promise.all(
      urlOverride.sourceEvidence.map(async ({ source }) => [source, await text(`upstream/defold/${source}`)]),
    ),
  );
  return {
    inventoryText: await text("packages/bindings/generated/defold-script-api-inventory.json"),
    irText: await text("packages/bindings/generated/defold-script-api-ir.json"),
    patternsText: await text("packages/bindings/generated/defold-script-binding-patterns.json"),
    descriptorsText: await text("packages/bindings/generated/defold-script-binding-descriptors.json"),
    scalarText: await text("packages/bindings/generated/defold-script-scalar-dispatch.json"),
    valueText: await text("packages/bindings/generated/defold-script-value-bindings.json"),
    tupleText: await text("packages/bindings/generated/defold-script-fixed-tuples.json"),
    dynamicText: await text("packages/bindings/generated/defold-script-dynamic-value-bindings.json"),
    urlText: await text("packages/bindings/generated/defold-script-url-address-classification.json"),
    valueTailText: await text("packages/bindings/generated/defold-script-value-tail-bindings.json"),
    overloadText: await text("packages/bindings/generated/defold-script-overload-dispatch.json"),
    registrationSurfaceText: await text("packages/bindings/generated/defold-lua-registration-surface.json"),
    universalPolicyText: await text("packages/bindings/overrides/script-universal-value-bindings.json"),
    componentPolicyText: await text("packages/bindings/generated/defold-component-proxy-contract.json"),
    urlOverrideText,
    urlSourceTexts,
    valueDefinitions,
  };
}

const sourceInputs = await inputs();
const generated = generateScriptApiAccounting(sourceInputs);
const checked = JSON.parse(await text("packages/bindings/generated/defold-script-api-accounting.json"));

function replaceJson(input, mutate) {
  const value = JSON.parse(input);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("accounts for all 926 APIs in one and only one category", () => {
  assert.equal(generated.functionCount, 926);
  assert.deepEqual(generated.categoryCounts, {
    "executable-stable-id": 915,
    "component-property-compiler": 8,
    "separate-module": 3,
    pending: 0,
  });
  assert.deepEqual(generated.pendingByLoweringFamily, {});
  assert.equal(new Set(generated.rows.map(({ id }) => id)).size, 926);
  assert.equal(generated.rows.filter(({ category }) => category === "pending").length, 0);
  assert.ok(
    generated.rows
      .filter(({ category }) => category === "pending")
      .every(({ reason }) => reason.code && reason.loweringFamily),
  );
  assert.deepEqual(checked, generated);
});

test("keeps stable-ID and separate-module evidence explicit and bounded", () => {
  const executable = generated.rows.filter(({ category }) => category === "executable-stable-id");
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "scalar-lua-dispatch").length, 90);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "native-value-dispatch").length, 78);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "fixed-tuple-lua-dispatch").length, 24);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "url-lua-dispatch").length, 70);
  assert.equal(
    executable.filter(({ evidence }) => evidence.generator === "captured-lua-value-tail-dispatch").length,
    16,
  );
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "captured-lua-overload-dispatch").length, 8);
  assert.equal(executable.filter(({ evidence }) => evidence.generator === "universal-value-fallback").length, 629);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "gui-node-setters").length, 39);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "vmath-fixed-pod").length, 11);
  assert.equal(executable.filter(({ evidence }) => evidence.generatedFamily === "vmath-matrix4").length, 14);
  assert.equal(new Set(executable.map(({ evidence }) => evidence.stableId)).size, executable.length);
  // go.get_position implements its current-instance form and all three
  // addressed forms, so its declared and implemented shapes now agree.
  const currentPosition = executable.find(({ id }) => id === "script:go.get_position");
  assert.deepEqual(currentPosition.evidence.implementedCallShapes, [[], ["String"], ["Hash"], ["Url"]]);
  assert.deepEqual(currentPosition.evidence.callShapes, currentPosition.evidence.implementedCallShapes);
  // A route whose declared shapes still exceed its implemented ones stays visible.
  const deleteRoute = executable.find(({ id }) => id === "script:go.delete");
  assert.equal(deleteRoute.evidence.callShapes.length > deleteRoute.evidence.implementedCallShapes.length, true);
  assert.deepEqual(
    generated.rows.filter(({ category }) => category === "separate-module").map(({ id }) => id),
    ["script:timer.cancel", "script:timer.delay", "script:timer.trigger"],
  );
  assert.deepEqual(
    generated.rows.filter(({ category }) => category === "component-property-compiler").map(({ id }) => id),
    [
      "script:go.property",
      "script:resource.atlas",
      "script:resource.buffer",
      "script:resource.font",
      "script:resource.material",
      "script:resource.render_target",
      "script:resource.texture",
      "script:resource.tile_source",
    ],
  );
  assert.match(generated.coverageClaim, /neither category claims per-target or per-function engine conformance/);
});

test("is invariant to harmless generated-family row ordering", () => {
  const reordered = structuredClone(sourceInputs);
  reordered.urlText = replaceJson(reordered.urlText, (value) => value.rows.reverse());
  reordered.valueTailText = replaceJson(reordered.valueTailText, (value) => {
    value.inputEvidence.urlBindingsSha256 = createHash("sha256").update(reordered.urlText).digest("hex");
  });
  const result = generateScriptApiAccounting(reordered);
  assert.deepEqual(result.rows, generated.rows);
  assert.deepEqual(result.categoryCounts, generated.categoryCounts);
});

test("consumes structural registrations and retains universal fallback when optimization proof is withdrawn", () => {
  for (const [inputName, collection, field] of [
    ["valueText", "bindings", "structuralCapabilities"],
    ["tupleText", "bindings", "sourceCapabilities"],
    ["overloadText", "bindings", "sourceCapabilities"],
  ]) {
    const missing = structuredClone(sourceInputs);
    missing[inputName] = replaceJson(missing[inputName], (report) => {
      const row = report[collection].find(
        (candidate) =>
          (inputName !== "valueText" || candidate.id !== "script:hash") &&
          (inputName !== "overloadText" || candidate.generatedFamilyExecutableCandidate),
      );
      delete row[field];
    });
    if (inputName === "valueText") {
      const valueHash = createHash("sha256").update(missing.valueText).digest("hex");
      const tail = JSON.parse(missing.valueTailText);
      tail.inputEvidence.valueBindingsSha256 = valueHash;
      missing.valueTailText = `${JSON.stringify(tail, null, 2)}\n`;
      const overload = JSON.parse(missing.overloadText);
      overload.inputEvidence.alreadyOwnedReportSha256 = valueHash;
      missing.overloadText = `${JSON.stringify(overload, null, 2)}\n`;
    }
    assert.throws(() => generateScriptApiAccounting(missing), /lacks structural registration evidence/, inputName);
  }

  const urlFallback = structuredClone(sourceInputs);
  const urlOverride = JSON.parse(urlFallback.urlOverrideText);
  const withdrawnSource = urlOverride.optimizationEvidence.requiredSourceEvidence[0];
  const withdrawnPath = urlOverride.sourceEvidence.find(({ id }) => id === withdrawnSource).source;
  urlFallback.urlWithdrawnSources = new Set([withdrawnPath]);
  urlFallback.urlText = `${JSON.stringify(
    generateScriptUrlAddressClassification({
      irText: urlFallback.irText,
      patternsText: urlFallback.patternsText,
      overrideText: urlFallback.urlOverrideText,
      sourceTexts: urlFallback.urlSourceTexts,
      withdrawnSources: urlFallback.urlWithdrawnSources,
    }),
    null,
    2,
  )}\n`;
  urlFallback.valueTailText = replaceJson(urlFallback.valueTailText, (report) => {
    report.inputEvidence.urlBindingsSha256 = createHash("sha256").update(urlFallback.urlText).digest("hex");
  });
  const urlResult = generateScriptApiAccounting(urlFallback);
  assert.equal(JSON.parse(urlFallback.urlText).optimizedRouteCount, 0);
  assert.equal(
    urlResult.rows.find(({ id }) => id === "script:camera.get_aspect_ratio").evidence.generator,
    "universal-value-fallback",
  );

  const dynamicFallback = structuredClone(sourceInputs);
  dynamicFallback.dynamicText = replaceJson(dynamicFallback.dynamicText, (report) => {
    const row = report.bindings.find(({ id }) => id === "script:bit.band");
    row.optimizationProven = false;
    row.optimizationBlockers = ["registered-global-callable-evidence-missing"];
    row.replayEvidence.registrations.pop();
    row.targetSupport.nativeDynamicHermes = "universal-fallback-missing-proof";
    row.targetSupport.nativeStaticHermes = "universal-fallback-missing-proof";
    report.optimizedReplayCount -= 1;
    report.universalFallbackCount += 1;
  });
  const dynamicResult = generateScriptApiAccounting(dynamicFallback);
  assert.equal(
    dynamicResult.rows.find(({ id }) => id === "script:bit.band").evidence.generator,
    "universal-value-fallback",
  );
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
  assert.throws(
    () => generateScriptApiAccounting(omitted),
    /value-tail bindings are stale|generated route count differs from reviewed family metadata|does not match reviewed value definitions/,
  );

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
  assert.throws(
    () => generateScriptApiAccounting(malformedUrl),
    /value-tail bindings are stale|URL binding report semantics are stale against pinned inputs/,
  );
});

test("rejects stale reviewed Defold source evidence", () => {
  const stale = structuredClone(sourceInputs);
  stale.valueDefinitions[0].sourceText += "\n// changed\n";
  assert.throws(() => generateScriptApiAccounting(stale), /is stale against|value report source evidence is stale/);
});

test("check command proves the checked-in report is current", () => {
  execFileSync(process.execPath, ["scripts/generate-script-api-accounting.mjs", "--check"], {
    cwd: root,
    stdio: "pipe",
  });
});
