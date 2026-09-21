import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditStaticScriptExactFamilies,
  materializeStaticScriptExactVectors,
} from "../packages/compiler/src/script-static-exact-verification.mjs";
import { renderStaticHermes } from "../scripts/generate-script-universal-value-bindings.mjs";
import { staticScriptExactVerificationGenerator } from "../scripts/lib/script-generator-pipeline.mjs";

const recording = JSON.parse(await readFile(new URL(
  "../packages/bindings/generated/defold-script-recording-engine.json", import.meta.url), "utf8"));
const accounting = JSON.parse(await readFile(new URL(
  "../packages/bindings/generated/defold-script-api-accounting.json", import.meta.url), "utf8"));
const special = JSON.parse(await readFile(new URL(
  "../packages/bindings/generated/defold-script-special-call-verification.json", import.meta.url), "utf8"));
const layouts = JSON.parse(await readFile(new URL(
  "../packages/bindings/generated/defold-value-layouts.json", import.meta.url), "utf8"));
const productionStaticTransport = await readFile(new URL(
  "../packages/static-hermes/src/generated/script-universal-value.ts", import.meta.url), "utf8");

function cloneRecording() {
  return structuredClone(recording);
}

function firstImplementedRoute(candidate, predicate = () => true) {
  const route = candidate.routes.find((row) => row.loweringFamily === "defold-value" && predicate(row));
  assert.ok(route, "test fixture has no matching Static Hermes defold-value route");
  return route;
}

function contractFor(candidate, route) {
  const contract = candidate.exactVectorCatalog.vectors.find(({ id }) => id === route.exactVector.contract);
  assert.ok(contract, `${route.id}: test fixture contract missing`);
  return contract;
}

test("the emitted three-target matrix excludes compiler-only routes and names the largest missing family", () => {
  assert.equal(accounting.functionCount, 926);
  assert.equal(recording.summary.routeCount + special.counts.total, 926);
  assert.equal(special.counts.componentPropertyCompiler, 8);
  assert.equal(special.counts.separateModule, 3);

  const before = {
    dynamicHermes: { emitted: 913 + 3, exact: 913 + 3, missing: 0 },
    staticHermes: { emitted: 325 + 3, exact: 3, missing: 325 },
    browserWasm: { emitted: 911 + 3, exact: 911 + 3, missing: 0 },
  };
  assert.deepEqual(before, {
    dynamicHermes: { emitted: 916, exact: 916, missing: 0 },
    staticHermes: { emitted: 328, exact: 3, missing: 325 },
    browserWasm: { emitted: 914, exact: 914, missing: 0 },
  });

  const families = auditStaticScriptExactFamilies(recording);
  assert.deepEqual(families.map(({ family, emittedRouteCount, exactVectorCount, missingVectorCount }) =>
    ({ family, emittedRouteCount, exactVectorCount, missingVectorCount })), [
    { family: "defold-value", emittedRouteCount: 127, exactVectorCount: 127, missingVectorCount: 0 },
    { family: "scalar", emittedRouteCount: 90, exactVectorCount: 0, missingVectorCount: 90 },
    { family: "lua-table", emittedRouteCount: 70, exactVectorCount: 0, missingVectorCount: 70 },
    { family: "dynamic-values", emittedRouteCount: 14, exactVectorCount: 0, missingVectorCount: 14 },
    { family: "multi-result", emittedRouteCount: 12, exactVectorCount: 0, missingVectorCount: 12 },
    { family: "overload-dispatch", emittedRouteCount: 12, exactVectorCount: 0, missingVectorCount: 12 },
  ]);
});

test("Static Hermes defold-value vectors are generator-owned and complete", () => {
  const { report, vectors } = materializeStaticScriptExactVectors(recording);
  assert.equal(report.transport, "static-hermes-typed-native");
  assert.equal(report.family, "defold-value");
  assert.equal(report.emittedRouteCount, 127);
  assert.equal(report.exactVectorCount, 127);
  assert.match(report.vectorSha256, /^[0-9a-f]{64}$/);
  assert.equal(vectors.length, 127);
  assert.equal(new Set(vectors.map(({ id }) => id)).size, 127);
  assert.ok(vectors.every(({ loweringFamily, argumentShapes, resultShapes, argumentValues, resultValues }) =>
    loweringFamily === "defold-value" &&
    argumentShapes.length === argumentValues.length &&
    resultShapes.length === resultValues.length));

  const after = {
    dynamicHermes: { emitted: 916, exact: 916, missing: 0 },
    staticHermes: { emitted: 328, exact: 130, missing: 198 },
    browserWasm: { emitted: 914, exact: 914, missing: 0 },
  };
  assert.equal(Object.values(after).reduce((sum, row) => sum + row.emitted, 0), 2158);
  assert.equal(Object.values(after).reduce((sum, row) => sum + row.exact, 0), 1960);
  assert.equal(Object.values(after).reduce((sum, row) => sum + row.missing, 0), 198);
});

test("Static exact generation fails closed on applicability lane corruption", () => {
  const targetIndex = recording.applicabilityCatalog.targets.indexOf("static-hermes");

  const missing = cloneRecording();
  firstImplementedRoute(missing).applicability.length = targetIndex;
  assert.throws(() => auditStaticScriptExactFamilies(missing), /applicability lane is missing/);

  const wrongTarget = cloneRecording();
  const route = firstImplementedRoute(wrongTarget);
  const lane = wrongTarget.applicabilityCatalog.lanes.find(({ id }) => id === route.applicability[targetIndex]);
  lane.target = "browser-wasm";
  assert.throws(() => auditStaticScriptExactFamilies(wrongTarget), /references browser-wasm target lane/);

  const wrongLane = cloneRecording();
  const wrongLaneRoute = firstImplementedRoute(wrongLane);
  const selected = wrongLane.applicabilityCatalog.lanes.find(
    ({ id }) => id === wrongLaneRoute.applicability[targetIndex]);
  selected.lane = "browser-wasm-direct-memory";
  assert.throws(() => auditStaticScriptExactFamilies(wrongLane), /expected static-hermes-typed-native/);
});

test("Static exact generation rejects value, frame-bound, arena, and release drift", () => {
  const resultMutation = cloneRecording();
  const resultRoute = firstImplementedRoute(resultMutation, ({ resultShapes }) => resultShapes.length > 0);
  contractFor(resultMutation, resultRoute).resultValues[0] = "num:999";
  assert.throws(() => materializeStaticScriptExactVectors(resultMutation), /exact result value drifted/);

  const capacityMutation = cloneRecording();
  const capacityRoute = firstImplementedRoute(capacityMutation);
  contractFor(capacityMutation, capacityRoute).bounds.argumentCapacity += 1;
  assert.throws(() => materializeStaticScriptExactVectors(capacityMutation), /argument capacity drifted/);

  const arenaMutation = cloneRecording();
  const arenaRoute = firstImplementedRoute(arenaMutation, ({ argumentShapes, resultShapes }) =>
    [...argumentShapes, ...resultShapes].some((index) => arenaMutation.shapes[index].code === 13));
  contractFor(arenaMutation, arenaRoute).bounds.matrix4Arena = false;
  assert.throws(() => materializeStaticScriptExactVectors(arenaMutation), /Matrix4 arena flag drifted/);

  const releaseMutation = cloneRecording();
  const releaseRoute = firstImplementedRoute(releaseMutation);
  contractFor(releaseMutation, releaseRoute).releaseExpectation = "release-owned-result-once";
  assert.throws(() => materializeStaticScriptExactVectors(releaseMutation), /unsupported Static Hermes release expectation/);
});

test("verification accessors exist only in the build-flavored Static transport", () => {
  assert.equal(renderStaticHermes(layouts), productionStaticTransport);
  assert.doesNotMatch(productionStaticTransport, /exact(?:Tag|Number|String)\(/u);
  const verificationTransport = renderStaticHermes(layouts, { verification: true });
  assert.match(verificationTransport, /exactTag\(\):number/u);
  assert.match(verificationTransport, /exactNumber\(slot:number\):number/u);
  assert.match(verificationTransport, /exactString\(\):string/u);
});

test("build-only Static exact verification owns executable normal and sanitizer checks", () => {
  assert.deepEqual(staticScriptExactVerificationGenerator.execution, {
    cmakeTarget: "defold-hermes-static-script-exact-test",
    packageScript: "test:static-script-exact",
    sanitizerPackageScript: "test:static-script-exact-sanitize",
  });
  assert.ok(staticScriptExactVerificationGenerator.sources.includes(
    "packages/compiler/src/script-static-exact-verification.mjs"));
  assert.ok(staticScriptExactVerificationGenerator.sources.includes(
    "scripts/build-static-script-exact-verification.mjs"));
});
