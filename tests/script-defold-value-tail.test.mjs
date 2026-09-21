import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateScriptDefoldValueTail,
  loadScriptDefoldValueTailInputs
} from "../scripts/generate-script-defold-value-tail.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const digest = (text) => createHash("sha256").update(text).digest("hex");

test("value-tail generator covers the exact remaining Defold-value accounting tail", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-defold-value-tail.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const report = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-script-value-tail-bindings.json", root), "utf8"));
  assert.equal(report.routeCount, 26);
  assert.equal(report.candidateCount, 26);
  assert.equal(report.blockedCount, 0);
  assert.deepEqual(report.blockerCounts, {});
  assert.match(report.inputEvidence.valueBindingsSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.urlBindingsSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.targetSupport.nativeDynamicHermes, "generated-executable-shared-script-adapter");
  assert.equal(report.inputEvidence.defoldSources.length, 11);
  assert.deepEqual(report.bindings.map(({ stableId }) => stableId), report.bindings.map(({ stableId }) => stableId).toSorted((a, b) => a - b));
  assert.equal(report.bindings.every(({ id, stableId }) => stableId === stableBindingId(id)), true);
  assert.equal(report.bindings.filter(({ disposition }) => disposition === "candidate")
    .every(({ backend, callShapes, sourceAnchor, requiredContext }) => backend === "captured-lua-exact-call" && callShapes.length > 0 && sourceAnchor.length > 0 && ["script-instance", "gui-script-instance", "render-script-instance"].includes(requiredContext)), true);
  assert.equal(report.bindings.find(({ id }) => id === "script:gui.get_layout").disposition, "candidate");
  assert.equal(report.bindings.find(({ id }) => id === "script:render.set_view").disposition, "candidate");
  const imageEnum = report.bindings.find(({ id }) => id === "script:gui.set_texture_data");
  assert.equal(imageEnum.disposition, "candidate");
  assert.equal(imageEnum.family, "image-type-string-codec");
  assert.equal(imageEnum.callShapes.every((shape) => shape[3] === "String"), true,
    "image.TYPE must not silently widen the luaL_checkstring source contract to Number");
  assert.equal(imageEnum.callShapes.some((shape) => shape[3] === "Number"), false);
  assert.match(imageEnum.codecEvidence.sourceSignature, /luaL_checkstring\(L, 4\)/);
  assert.deepEqual(imageEnum.codecEvidence.domain, ["rgb", "rgba", "l", "astc"]);
  const namedEnum = report.bindings.find(({ id }) => id === "script:liveupdate.remove_mount");
  assert.equal(namedEnum.disposition, "candidate");
  assert.equal(namedEnum.family, "liveupdate-result-enum-codec");
  assert.equal(namedEnum.resultCodec, "Number");
  assert.match(namedEnum.codecEvidence.sourceSignature, /lua_pushinteger\(L, result\)/);
  assert.deepEqual(namedEnum.resultDomain, {
    names: ["RESULT_OK", "RESULT_INVALID_HEADER", "RESULT_MEM_ERROR", "RESULT_INVALID_RESOURCE",
      "RESULT_VERSION_MISMATCH", "RESULT_ENGINE_VERSION_MISMATCH", "RESULT_SIGNATURE_MISMATCH",
      "RESULT_SCHEME_MISMATCH", "RESULT_BUNDLED_RESOURCE_MISMATCH", "RESULT_FORMAT_ERROR",
      "RESULT_IO_ERROR", "RESULT_INVAL", "RESULT_NOT_INITIALIZED", "RESULT_UNKNOWN"],
    values: [0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -1000]
  });
  assert.equal(report.bindings.find(({ id }) => id === "script:hash_to_hex").sourceSymbol, "HashToHex");
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:camera.get_view").callShapes,
    [[], ["Url"], ["Number"], ["Nil"]]);
});

test("value-tail candidate dispatch is generated as fail-closed metadata", async () => {
  const [header, source, target] = await Promise.all([
    readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_value_tail_bindings.hpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/src/generated_script_value_tail_bindings.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/value-tail-target-support.ts", root), "utf8")
  ]);
  assert.match(header, /kRouteCount = 26/);
  assert.match(header, /kCandidateCount = 26/);
  assert.match(header, /candidateRouteOffsets/);
  assert.match(source, /captured Lua backend is unavailable/);
  assert.match(source, /arguments do not match a reviewed exact codec shape/);
  assert.match(source, /Lua result does not match the reviewed codec/);
  assert.match(source, /kResultDomainValues/);
  assert.doesNotMatch(source, /image-type-union-codec|named-enum-domain-codec/);
  assert.match(source, /candidateIndex >= kCandidateCount/);
  assert.match(source, /candidate shape offsets drifted/);
  assert.match(source, /shape argument offsets drifted/);
  assert.doesNotMatch(source, /lua_newuserdata|luaL_ref|\bnew\b|malloc|std::vector/);
  assert.match(target, /script:gui\.set_texture_data/);
  assert.match(target, /"accountingDisposition": "universal-fallback-test-fixture-adapter-only"/);
  assert.match(target, /"requiredContext": "gui-script-instance"/);
  assert.match(target, /"requiredContext": "render-script-instance"/);
  assert.match(target, /not executable in the HTML5 browser host/);
});

test("value-tail generation reports stale source evidence and rejects incomplete policy or unsafe codec widening", async () => {
  const inputs = await loadScriptDefoldValueTailInputs();
  const staleSources = new Map(inputs.sourceTexts);
  const [path, text] = staleSources.entries().next().value;
  staleSources.set(path, `${text}\n`);
  assert.doesNotThrow(() => generateScriptDefoldValueTail({ ...inputs, sourceTexts: staleSources }));

  const incomplete = JSON.parse(inputs.policyText);
  incomplete.families[0].sourceRoutes[0].ids.pop();
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, policyText: JSON.stringify(incomplete) }), /reviewed route count drifted/);

  const unsupportedContext = JSON.parse(inputs.policyText);
  unsupportedContext.families[0].requiredContext = "unknown-script-instance";
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, policyText: JSON.stringify(unsupportedContext) }),
    /invalid or missing value-tail execution context/);
});

test("value-tail generation rejects every cross-input provenance drift", async () => {
  const inputs = await loadScriptDefoldValueTailInputs();
  const mutate = (field, update) => ({ ...inputs, [field]: update(inputs[field]) });

  assert.throws(() => generateScriptDefoldValueTail(mutate("irText", (text) => JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 }))), /script IR schema is unsupported/);
  assert.throws(() => generateScriptDefoldValueTail(mutate("patternsText", (text) => JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 }))), /script binding-pattern schema is unsupported/);
  assert.throws(() => generateScriptDefoldValueTail(mutate("valueText", (text) => JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 }))), /script value-binding schema is unsupported/);
  assert.throws(() => generateScriptDefoldValueTail(mutate("urlText", (text) => JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 }))), /script URL-binding schema is unsupported/);

  const revision = JSON.parse(inputs.patternsText); revision.defoldRevision = "different-revision";
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, patternsText: JSON.stringify(revision) }), /Defold revisions differ/);
  const valueRevision = JSON.parse(inputs.valueText); valueRevision.defoldRevision = "different-revision";
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, valueText: JSON.stringify(valueRevision) }), /Defold revisions differ/);

  const changedIr = `${inputs.irText}\n`;
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, irText: changedIr }), /binding patterns are stale against script IR/);

  const staleUrlPatterns = JSON.parse(inputs.urlText);
  staleUrlPatterns.inputEvidence.bindingPatternsSha256 = "0".repeat(64);
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, urlText: JSON.stringify(staleUrlPatterns) }), /URL bindings are stale against script binding patterns/);

  const duplicateValue = JSON.parse(inputs.valueText);
  duplicateValue.bindings.push({ ...duplicateValue.bindings[0] });
  duplicateValue.bindingCount += 1;
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, valueText: JSON.stringify(duplicateValue) }), /script value bindings duplicates identity/);

  const overlappingUrl = JSON.parse(inputs.urlText);
  overlappingUrl.rows.push({ ...JSON.parse(inputs.valueText).bindings[0] });
  overlappingUrl.routeCount += 1;
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, urlText: JSON.stringify(overlappingUrl) }), /overlaps value bindings/);

  const mismatchedPatterns = JSON.parse(inputs.patternsText);
  mismatchedPatterns.bindings[0] = { ...mismatchedPatterns.bindings[0], id: "script:provenance.synthetic" };
  const mismatchedPatternsText = JSON.stringify(mismatchedPatterns);
  const matchingUrlHash = JSON.parse(inputs.urlText);
  matchingUrlHash.inputEvidence.bindingPatternsSha256 = digest(mismatchedPatternsText);
  assert.throws(() => generateScriptDefoldValueTail({ ...inputs, patternsText: mismatchedPatternsText, urlText: JSON.stringify(matchingUrlHash) }),
    /script binding patterns identities do not exactly match runtime-pending script IR functions/);
});
