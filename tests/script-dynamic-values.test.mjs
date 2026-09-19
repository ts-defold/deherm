import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-dynamic-values.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("dynamic-value generator classifies the complete family from pinned source", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-dynamic-values.mjs", "--check"], { cwd: root });
  const report = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root), "utf8"));
  assert.equal(report.routeCount, 14);
  assert.equal(report.generatedFamilyCandidateCount, 11);
  assert.equal(report.blockedCount, 3);
  assert.equal(report.maximumArgumentCount, 32);
  assert.match(report.inputEvidence.scriptIrSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.bindingPatternsSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.reviewedOverridesSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.blockerCounts, {
    "recursive-json-value-policy": 2,
    "recursive-log-side-effect-policy": 1
  });
  assert.equal(new Set(report.bindings.map(({ id }) => id)).size, 14);
  assert.equal(new Set(report.bindings.map(({ stableId }) => stableId)).size, 14);
  assert.equal(report.bindings.every(({ id, stableId }) => Number.parseInt(stableId) === stableBindingId(id)), true);
  assert.deepEqual(report.bindings.map(({ stableId }) => Number.parseInt(stableId)),
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)).toSorted((a, b) => a - b));
  assert.equal(report.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
    .every(({ targetSupport }) => targetSupport.nativeDynamicHermes === "candidate-awaits-shared-router-integration"), true);
  assert.equal(report.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
    .every(({ targetSupport }) => targetSupport.html5BrowserHost === "not-executable-no-generated-provider"), true);
  assert.equal(report.bindings.filter(({ id }) => id.startsWith("script:types."))
    .every(({ focusedNativeEvidence }) => focusedNativeEvidence === "observed-transport-with-local-type-identity-stand-ins"), true);
});

test("generated dynamic-value glue is bounded and fail-closed", async () => {
  const [source, header, target, report] = await Promise.all([
    readFile(new URL("defold/defold_hermes/src/generated_script_dynamic_values.cpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/dynamic-values.ts", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root), "utf8").then(JSON.parse)
  ]);
  assert.match(header, /kMaximumArgumentCount = 32/);
  assert.match(source, /Dynamic-value argument count is outside the generated fixed capacity/);
  assert.match(source, /Dynamic-value Lua result does not match the generated result mode/);
  assert.match(source, /frame->resultCount=0/);
  assert.doesNotMatch(source, /\bnew\b|malloc|realloc|std::vector|unordered_map/);
  for (const binding of report.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)) {
    assert.match(target, new RegExp(binding.id.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(target, /json\.decode|json\.encode|pprint/);
});

test("dynamic-value generation reports stale upstream evidence and rejects missing decisions", async () => {
  const inputs = await loadInputs();
  const stale = inputs.sources.map((source, index) => index === 0 ? { ...source, text: `${source.text}\n` } : source);
  assert.doesNotThrow(() => generate(inputs.patternsText, inputs.irText, inputs.overridesText, stale));
  const overrides = JSON.parse(inputs.overridesText);
  delete overrides.routes["script:bit.band"];
  assert.throws(() => generate(inputs.patternsText, inputs.irText, JSON.stringify(overrides), inputs.sources), /override coverage drifted|missing reviewed/);
});

test("dynamic-value generation rejects stale cross-input provenance and duplicate identities", async () => {
  const inputs = await loadInputs();
  const staleRevision = JSON.parse(inputs.patternsText);
  staleRevision.defoldRevision = "0".repeat(40);
  assert.throws(() => generate(JSON.stringify(staleRevision), inputs.irText, inputs.overridesText, inputs.sources),
    /different Defold revisions/);

  const staleHash = JSON.parse(inputs.patternsText);
  staleHash.sourceSha256 = "0".repeat(64);
  assert.throws(() => generate(JSON.stringify(staleHash), inputs.irText, inputs.overridesText, inputs.sources),
    /stale against script IR/);

  const duplicate = JSON.parse(inputs.patternsText);
  duplicate.bindings[1] = structuredClone(duplicate.bindings[0]);
  assert.throws(() => generate(JSON.stringify(duplicate), inputs.irText, inputs.overridesText, inputs.sources),
    /duplicate binding-pattern id/);

  const staleCount = JSON.parse(inputs.patternsText);
  staleCount.classifiedFunctionCount -= 1;
  assert.throws(() => generate(JSON.stringify(staleCount), inputs.irText, inputs.overridesText, inputs.sources),
    /classified binding count is stale/);

  const sourceMetadata = structuredClone(inputs.sources);
  sourceMetadata[0].sha256 = "0".repeat(64);
  assert.throws(() => generate(inputs.patternsText, inputs.irText, inputs.overridesText, sourceMetadata),
    /pinned source metadata drifted/);

  assert.throws(() => generate(
    inputs.patternsText, inputs.irText, inputs.overridesText, inputs.sources.slice(1)),
  /pinned source count drifted/);
});
