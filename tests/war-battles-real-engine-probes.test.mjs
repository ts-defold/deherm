import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateWarBattlesRealEngineProbes } from "../scripts/generate-war-battles-real-engine-probes.mjs";
import { markersObserved, validateWarBattlesRuntimeReadiness } from "../scripts/check-war-battles-real-engine-runtime.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  manifest: "examples/war-battles-online/verification/probes/script-real-engine-probes.json",
  ir: "packages/bindings/generated/defold-script-api-ir.json",
  scalar: "packages/bindings/generated/defold-script-scalar-dispatch.json",
  value: "packages/bindings/generated/defold-script-value-bindings.json"
};
const texts = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(new URL(path, root), "utf8")])));

function mutate(name, mutateValue) {
  const value = JSON.parse(texts[name]);
  mutateValue(value);
  return { ...texts, [name]: `${JSON.stringify(value, null, 2)}\n` };
}

test("generates all five context-specific harness calls without promoting evidence", () => {
  const { report, typescript } = generateWarBattlesRealEngineProbes(texts);
  assert.equal(report.scenarioCount, 5);
  assert.equal(report.executableScenarioCount + report.awaitingRouteCount, 5);
  assert.equal(report.verifiedCompileCount, 0);
  assert.equal(report.verifiedLinkCount, 0);
  assert.equal(report.verifiedRuntimeCount, 0);
  assert.deepEqual(report.probes.map(({ routeId }) => routeId).sort(), [
    "script:factory.create",
    "script:go.delete",
    "script:gui.get_node",
    "script:gui.set_text",
    "script:msg.post"
  ]);
  assert.equal(report.probes.every(({ harnessState }) => harnessState === "generated-not-run"), true);
  assert.equal(report.probes.every(({ assertionHarnessState }) => assertionHarnessState === "planned"), true);
  assert.equal(report.probes.reduce((count, { assertions }) => count + assertions.length, 0), 16);
  assert.equal(new Set(report.probes.flatMap(({ expectedMarkers }) => expectedMarkers)).size, 16);
  assert.equal(report.probes.find(({ routeId }) => routeId === "script:msg.post").assertions.includes("receiver-observes-full-sender-url"), true);
  assert.equal(report.probes.find(({ routeId }) => routeId === "script:msg.post").assertions.includes("serialized-payload-above-2048-bytes-is-rejected"), true);
  assert.equal(report.probes.find(({ routeId }) => routeId === "script:factory.create").assertions.includes("parent-game-object-context-restored-after-child-init"), true);
  assert.equal(report.probes.find(({ routeId }) => routeId === "script:go.delete").assertions.includes("created-object-is-deleted-after-end-of-frame"), true);
  assert.equal(report.probes.find(({ routeId }) => routeId === "script:gui.set_text").assertions.includes("numeric-text-uses-defold-number-formatting"), true);
  assert.equal(report.probes.every(({ evidence }) => Object.values(evidence).every(({ status }) => status === "unverified")), true);
  assert.match(typescript, /msg\.post\("\.\", "deherm_probe_message"\)/);
  assert.match(typescript, /const createdId = factory\.create\("#probe_factory"\)/);
  assert.match(typescript, /go\.delete\(createdId\)/);
  assert.match(typescript, /const statusNode = gui\.getNode\("status"\)/);
  assert.match(typescript, /gui\.setText\(statusNode, "DEHERM_PROBE_TEXT"\)/);
  assert.match(typescript, /active game-object context/);
  assert.match(typescript, /active GUI-scene context/);
});

test("route generation changes readiness but never evidence", () => {
  const value = JSON.parse(texts.value);
  const baseline = generateWarBattlesRealEngineProbes(texts).report;
  const ids = ["script:msg.post", "script:factory.create", "script:go.delete", "script:gui.get_node", "script:gui.set_text"];
  const shapes = new Map([
    ["script:msg.post", [["String", "String"]]],
    ["script:factory.create", [["String"]]],
    ["script:go.delete", [["Hash"]]],
    ["script:gui.get_node", [["String"]]],
    ["script:gui.set_text", [["Node", "String"]]]
  ]);
  const operationParameters = new Map(baseline.probes.map(({ routeId, expectedOperationParameters }) => [routeId, expectedOperationParameters]));
  ids.forEach((id, index) => {
    const existing = value.bindings.find((binding) => binding.id === id);
    if (existing) existing.implementedCallShapes = shapes.get(id);
    else value.bindings.push({ id, stableId: 0xf0000000 + index, implementedCallShapes: shapes.get(id), operation: { parameters: operationParameters.get(id) } });
  });
  const { report } = generateWarBattlesRealEngineProbes({ ...texts, value: `${JSON.stringify(value)}\n` });
  assert.equal(report.executableScenarioCount, 5);
  assert.equal(report.awaitingRouteCount, 0);
  assert.equal(report.verifiedRuntimeCount, 0);
  assert.equal(report.probes.every(({ routeStatus }) => routeStatus === "generated-executable-route"), true);
  assert.equal(report.probes.every(({ evidence }) => evidence.runtime.status === "unverified"), true);
  for (const probe of report.probes) probe.assertionHarnessState = "implemented-not-run";
  const markers = validateWarBattlesRuntimeReadiness(report);
  assert.equal(markers.length, 16);
  assert.equal(markersObserved(markers.join("\n"), markers), true);
  assert.equal(markersObserved(markers.slice(1).join("\n"), markers), false);
});

test("runtime verifier refuses to launch while any route remains planned", () => {
  const value = JSON.parse(texts.value);
  value.bindings = value.bindings.filter(({ id }) => id !== "script:gui.set_text");
  const { report } = generateWarBattlesRealEngineProbes({ ...texts, value: `${JSON.stringify(value)}\n` });
  assert.throws(() => validateWarBattlesRuntimeReadiness(report), /blocked on generated routes/);
});

test("runtime verifier refuses generated calls whose semantic assertion harness is still planned", () => {
  const { report } = generateWarBattlesRealEngineProbes(texts);
  if (report.awaitingRouteCount === 0) {
    assert.throws(() => validateWarBattlesRuntimeReadiness(report), /blocked on assertion harnesses/);
  }
});

test("fails closed on Defold signature drift, missing routes, invalid captures, or observations", () => {
  const signatureDrift = mutate("ir", (ir) => {
    ir.functions.find(({ id }) => id === "script:msg.post").parameters[0].rawType = "url";
  });
  assert.throws(() => generateWarBattlesRealEngineProbes(signatureDrift), /Defold parameter signature changed/);

  const missingScenario = mutate("manifest", (manifest) => manifest.scenarios.pop());
  assert.throws(() => generateWarBattlesRealEngineProbes(missingScenario), /All five War Battles routes/);

  const badCapture = mutate("manifest", (manifest) => {
    manifest.scenarios.find(({ routeId }) => routeId === "script:go.delete").invocation.arguments[0].name = "missingId";
  });
  assert.throws(() => generateWarBattlesRealEngineProbes(badCapture), /capture is used before declaration/);

  const observation = mutate("manifest", (manifest) => manifest.observations.push({ result: "passed" }));
  assert.throws(() => generateWarBattlesRealEngineProbes(observation), /never promotes observations/);

  const missingAssertion = mutate("manifest", (manifest) => {
    manifest.scenarios.find(({ routeId }) => routeId === "script:gui.get_node").assertions.pop();
  });
  assert.throws(() => generateWarBattlesRealEngineProbes(missingAssertion), /required engine assertions are incomplete/);

  const operationDrift = mutate("value", (value) => {
    value.bindings.find(({ id }) => id === "script:gui.set_text").operation.parameters.numberFormat = "host-default";
  });
  assert.throws(() => generateWarBattlesRealEngineProbes(operationDrift), /generated operation parameter numberFormat changed/);
});

test("checked-in report and TypeScript harness are current and compile", () => {
  execFileSync(process.execPath, ["scripts/generate-war-battles-real-engine-probes.mjs", "--check"], { cwd: root, stdio: "pipe" });
  execFileSync("node_modules/.bin/tsc", ["--noEmit"], { cwd: root, stdio: "pipe" });
});
