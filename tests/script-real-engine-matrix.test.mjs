import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateScriptRealEngineMatrix } from "../scripts/generate-script-real-engine-matrix.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  manifest: "bindings/probes/defold-script-real-engine-matrix.json",
  scalarRoutes: "bindings/generated/defold-script-scalar-dispatch.json",
  valueRoutes: "bindings/generated/defold-script-value-bindings.json",
  tupleRoutes: "bindings/generated/defold-script-fixed-tuples.json",
  urlRoutes: "bindings/generated/defold-script-url-address-classification.json",
  scalarProbes: "bindings/generated/defold-script-real-engine-probes.json",
  valueProbes: "bindings/generated/defold-script-value-real-engine-probes.json",
  tupleProbes: "bindings/generated/defold-script-fixed-tuple-probes.json"
};
const texts = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(new URL(path, root), "utf8")])));

function withManifest(mutator) {
  const manifest = JSON.parse(texts.manifest);
  // Synthetic evidence tests must not inherit checked-in observations whose
  // repository artifacts are outside their in-memory fixture loader.
  manifest.observations = [];
  mutator(manifest);
  return { ...texts, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

test("covers every generated executable route and keeps evidence SHA-bound", async () => {
  const report = await generateScriptRealEngineMatrix(texts);
  const scalarRoutes = JSON.parse(texts.scalarRoutes);
  const valueRoutes = JSON.parse(texts.valueRoutes);
  const tupleRoutes = JSON.parse(texts.tupleRoutes);
  const urlRoutes = JSON.parse(texts.urlRoutes);
  const importedProbes = [...JSON.parse(texts.scalarProbes).probes, ...JSON.parse(texts.valueProbes).probes];
  const instrumentedProbes = importedProbes.filter(({ state }) => state !== "planned");
  const expectedRouteCount = scalarRoutes.bindingCount + valueRoutes.bindingCount +
    tupleRoutes.bindingCount + urlRoutes.routeCount;
  const expectedInstrumentedRouteCount = new Set(instrumentedProbes.map(({ id }) => id)).size;
  const expectedRuntimeVerifiedRouteCount = new Set(JSON.parse(texts.manifest).observations
    .filter(({ stage, result }) => stage === "runtime" && result === "passed")
    .flatMap(({ routeIds }) => routeIds)).size;
  const importedRouteCount = new Set(importedProbes.map(({ id }) => id)).size;
  assert.equal(report.routeCount, expectedRouteCount);
  assert.equal(report.instrumentedRouteCount, expectedInstrumentedRouteCount);
  assert.equal(report.plannedOnlyRouteCount, expectedRouteCount - expectedInstrumentedRouteCount);
  assert.equal(report.instrumentedScenarioCount, instrumentedProbes.length);
  assert.equal(report.plannedScenarioCount,
    importedProbes.length - instrumentedProbes.length + expectedRouteCount - importedRouteCount);
  assert.equal(report.scenarioCount, importedProbes.length + expectedRouteCount - importedRouteCount);
  assert.equal(report.routes.every(({ scenarios }) => scenarios.length > 0), true);
  assert.deepEqual(report.stageSummary, {
    compile: { verifiedRouteCount: 0, unverifiedRouteCount: expectedRouteCount },
    link: { verifiedRouteCount: 0, unverifiedRouteCount: expectedRouteCount },
    runtime: {
      verifiedRouteCount: expectedRuntimeVerifiedRouteCount,
      unverifiedRouteCount: expectedRouteCount - expectedRuntimeVerifiedRouteCount
    }
  });
  const hash = report.routes.find(({ id }) => id === "script:hash");
  assert.equal(hash.scenarioState, "instrumented");
  assert.equal(hash.evidence.runtime.status, "verified");
  const unprobed = report.routes.find(({ id }) => id === "script:bit.bnot");
  assert.equal(unprobed.scenarioState, "planned");
  assert.match(report.evidencePolicy, /current probe-set fingerprint/i);
});

test("supports explicit engine context, project configuration, and typed script-property setup", async () => {
  const input = withManifest((manifest) => {
    manifest.setups.push({
      id: "player-instance",
      context: {
        kind: "script-instance",
        collection: "/main/main.collection",
        gameObject: "/player",
        component: "#controller"
      },
      projectConfig: { "deherm.test_mode": "1" },
      properties: [
        { name: "speed", type: "number", value: 12.5 },
        { name: "team", type: "hash", value: "red" },
        { name: "spawn", type: "vector3", value: [1, 2, 3] }
      ]
    });
    manifest.scenarioOverrides.push({
      key: "fixture.player-instance",
      routeId: "script:bit.bnot",
      setupId: "player-instance",
      reason: "Exercises context and properties until a context-sensitive route is executable."
    });
  });
  const report = await generateScriptRealEngineMatrix(input);
  assert.equal(report.setups.find(({ id }) => id === "player-instance").properties.length, 3);
  assert.equal(report.scenarios.find(({ key }) => key === "fixture.player-instance").setupId, "player-instance");
});

test("keeps compile, link, and runtime evidence independent and SHA-bound", async () => {
  const runtimeMarker = "INFO:DEFOLD_HERMES: script-api:bit.lshift.number:256";
  const probeSetMarker = JSON.parse(texts.scalarProbes).expectedInputMarker;
  const compileArtifact = Buffer.from("compile completed for script:bit.lshift\n");
  const runtimeArtifact = Buffer.from(`engine booted\n${probeSetMarker}\n${runtimeMarker}\n`);
  const input = withManifest((manifest) => {
    manifest.observations.push(
      {
        id: "compile-bit-lshift",
        stage: "compile",
        target: manifest.target,
        result: "passed",
        command: "fixture compile command",
        observedAt: "2026-09-17T00:00:00.000Z",
        routeIds: ["script:bit.lshift"],
        artifact: { path: "compile.log", sha256: createHash("sha256").update(compileArtifact).digest("hex") },
        requiredMarkers: ["compile completed"]
      },
      {
        id: "runtime-bit-lshift",
        stage: "runtime",
        target: manifest.target,
        result: "passed",
        command: "fixture runtime command",
        observedAt: "2026-09-17T00:01:00.000Z",
        routeIds: ["script:bit.lshift"],
        scenarioKeys: ["scalar:bit.lshift.number"],
        artifact: { path: "runtime.log", sha256: createHash("sha256").update(runtimeArtifact).digest("hex") },
        requiredMarkers: ["engine booted"]
      }
    );
  });
  const artifacts = new Map([["compile.log", compileArtifact], ["runtime.log", runtimeArtifact]]);
  const report = await generateScriptRealEngineMatrix(input, { loadEvidence: async (path) => artifacts.get(path) });
  const route = report.routes.find(({ id }) => id === "script:bit.lshift");
  assert.equal(route.evidence.compile.status, "verified");
  assert.equal(route.evidence.link.status, "unverified");
  assert.equal(route.evidence.runtime.status, "verified");
});

test("rejects stale artifacts, missing runtime markers, and planned-scenario promotion", async () => {
  const stale = withManifest((manifest) => manifest.observations.push({
    id: "stale",
    stage: "compile",
    target: manifest.target,
    result: "passed",
    command: "compile",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.bnot"],
    artifact: { path: "compile.log", sha256: "0".repeat(64) },
    requiredMarkers: []
  }));
  await assert.rejects(generateScriptRealEngineMatrix(stale, { loadEvidence: async () => "different" }), /SHA-256 mismatch/);

  const missingMarkerBytes = Buffer.from("engine booted without result\n");
  const missingMarker = withManifest((manifest) => manifest.observations.push({
    id: "missing-marker",
    stage: "runtime",
    target: manifest.target,
    result: "passed",
    command: "run",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.lshift"],
    scenarioKeys: ["scalar:bit.lshift.number"],
    artifact: { path: "runtime.log", sha256: createHash("sha256").update(missingMarkerBytes).digest("hex") },
    requiredMarkers: []
  }));
  await assert.rejects(generateScriptRealEngineMatrix(missingMarker, { loadEvidence: async () => missingMarkerBytes }), /missing .* scenario marker/);

  const plannedBytes = Buffer.from("planned:script:bit.bnot\n");
  const planned = withManifest((manifest) => manifest.observations.push({
    id: "planned-runtime",
    stage: "runtime",
    target: manifest.target,
    result: "passed",
    command: "run",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.bnot"],
    scenarioKeys: ["planned:script:bit.bnot"],
    artifact: { path: "runtime.log", sha256: createHash("sha256").update(plannedBytes).digest("hex") },
    requiredMarkers: []
  }));
  await assert.rejects(generateScriptRealEngineMatrix(planned, { loadEvidence: async () => plannedBytes }), /planned scenario cannot be promoted/);

  const overbroadBytes = Buffer.from(
    `${JSON.parse(texts.scalarProbes).expectedInputMarker}\n` +
    "INFO:DEFOLD_HERMES: script-api:bit.lshift.number:256\n"
  );
  const overbroad = withManifest((manifest) => manifest.observations.push({
    id: "overbroad-runtime",
    stage: "runtime",
    target: manifest.target,
    result: "passed",
    command: "run",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.lshift", "script:bit.bnot"],
    scenarioKeys: ["scalar:bit.lshift.number"],
    artifact: { path: "runtime.log", sha256: createHash("sha256").update(overbroadBytes).digest("hex") },
    requiredMarkers: []
  }));
  await assert.rejects(generateScriptRealEngineMatrix(overbroad, { loadEvidence: async () => overbroadBytes }), /runtime route lacks an observed scenario/);
});

test("runtime evidence is bound to the current probe set and repository-confined artifacts", async () => {
  const runtimeMarker = "INFO:DEFOLD_HERMES: script-api:bit.lshift.number:256";
  const oldTranscript = Buffer.from(`${runtimeMarker}\n`);
  const staleProbeSet = withManifest((manifest) => manifest.observations.push({
    id: "stale-probe-set",
    stage: "runtime",
    target: manifest.target,
    result: "passed",
    command: "run",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.lshift"],
    scenarioKeys: ["scalar:bit.lshift.number"],
    artifact: { path: "runtime.log", sha256: createHash("sha256").update(oldTranscript).digest("hex") },
    requiredMarkers: []
  }));
  await assert.rejects(
    generateScriptRealEngineMatrix(staleProbeSet, { loadEvidence: async () => oldTranscript }),
    /missing current probe-set marker/
  );

  const traversal = withManifest((manifest) => manifest.observations.push({
    id: "outside-repository",
    stage: "compile",
    target: manifest.target,
    result: "passed",
    command: "compile",
    observedAt: "2026-09-17T00:00:00.000Z",
    routeIds: ["script:bit.bnot"],
    artifact: { path: "../outside.log", sha256: "0".repeat(64) },
    requiredMarkers: ["compiled"]
  }));
  await assert.rejects(
    generateScriptRealEngineMatrix(traversal, { loadEvidence: async () => Buffer.alloc(0) }),
    /must stay within the repository/
  );
});

test("checked-in report is deterministic and current", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-real-engine-matrix.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const checked = JSON.parse(await readFile(new URL("bindings/generated/defold-script-real-engine-matrix.json", root), "utf8"));
  const regenerated = await generateScriptRealEngineMatrix(texts);
  assert.deepEqual(checked, regenerated);
  assert.deepEqual(checked.routes.map(({ id }) => id), [...checked.routes.map(({ id }) => id)].sort());
});
