import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-fixed-tuples.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("fixed tuple generator selects the exact mechanical family", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-fixed-tuples.mjs", "--check"], { cwd: root });
  const report = JSON.parse(await readFile(new URL("bindings/generated/defold-script-fixed-tuples.json", root)));
  assert.equal(report.bindingCount, 24);
  assert.deepEqual(report.bucketCounts, { "fixed-scalar-tuple": 17, "fixed-value-tuple": 7 });
  assert.deepEqual(report.tupleArityCounts, { 2: 17, 3: 4, 4: 3 });
  assert.equal(report.publicTypeScriptReachableCount, 8);
  assert.equal(report.blockedHandleProducerCount, 16);
  assert.deepEqual(report.codecVocabulary, [
    "Boolean", "GuiNode", "Hash", "Integer", "LuaUserdata", "Nil", "Number",
    "Quaternion", "String", "Url", "Vector3"
  ]);
  assert.equal(new Set(report.bindings.map(({ id }) => id)).size, 24);
  assert.equal(new Set(report.bindings.map(({ stableId }) => stableId)).size, 24);
  assert.equal(report.bindings.every(({ id, stableId }) => Number.parseInt(stableId) === stableBindingId(id)), true);
  assert.deepEqual(report.bindings.map(({ stableId }) => Number.parseInt(stableId)),
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)).toSorted((a, b) => a - b));
  assert.equal(report.bindings.filter(({ targetSupport }) =>
    targetSupport.publicTypeScriptFixture === "blocked-missing-handle-producer").every(({ id }) =>
    id.startsWith("script:bullet3d.")), true);
  assert.equal(report.bindings.flatMap(({ arguments: args }) => args)
    .filter(({ codecs }) => codecs.includes("Url"))
    .every(({ implementedCodecs }) => !implementedCodecs.includes("Url")), true);
});

test("fixed tuple positional codecs and planned probes fail closed", async () => {
  const [report, probes, source, target] = await Promise.all([
    readFile(new URL("bindings/generated/defold-script-fixed-tuples.json", root), "utf8").then(JSON.parse),
    readFile(new URL("bindings/generated/defold-script-fixed-tuple-probes.json", root), "utf8").then(JSON.parse),
    readFile(new URL("defold/defold_hermes/src/generated_script_fixed_tuples.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/fixed-tuple-target-support.ts", root), "utf8")
  ]);
  assert.equal(probes.routeCount, 24);
  assert.equal(probes.scenarios.every(({ evidence }) =>
    Object.values(evidence).every((status) => status === "planned")), true);
  assert.equal(probes.scenarios.some(({ preserveInteriorNil }) => preserveInteriorNil), true);
  assert.match(source, /Fixed tuple Lua result count does not match exact descriptor|result storage is exhausted/);
  assert.match(source, /std::isfinite\(value\.number\).*std::trunc\(value\.number\)/);
  assert.doesNotMatch(source, /new\s|malloc|unordered_map|std::vector/);
  for (const binding of report.bindings) assert.match(target, new RegExp(binding.id.replaceAll(".", "\\.")));
});

test("fixed tuple generation rejects stale sources and unknown codecs", async () => {
  const inputs = await loadInputs();
  const staleSources = inputs.sources.map((source, index) => index ? source : { ...source, text: `${source.text}\n` });
  assert.throws(() => generate(inputs.irText, inputs.patternsText, inputs.schemaOverridesText,
    inputs.registrationsText, staleSources), /pinned source hash drifted/);
  const ir = JSON.parse(inputs.irText);
  ir.functions.find(({ id }) => id === "script:window.get_size").returns[0] = "mystery_owned_value";
  assert.throws(() => generate(JSON.stringify(ir), inputs.patternsText, inputs.schemaOverridesText,
    inputs.registrationsText, inputs.sources), /no reviewed fixed tuple codec/);
});
