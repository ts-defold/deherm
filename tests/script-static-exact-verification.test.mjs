import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditStaticScriptExactFamilies,
  materializeStaticScriptExactVectors,
  planStaticScriptExactValue,
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

function firstFamilyRoute(candidate, family, predicate = () => true) {
  const target = candidate.applicabilityCatalog.targets.indexOf("static-hermes");
  const lanes = new Map(candidate.applicabilityCatalog.lanes.map((lane) => [lane.id, lane]));
  const route = candidate.routes.find((row) => row.loweringFamily === family &&
    lanes.get(row.applicability[target])?.status === "exercise" && predicate(row));
  assert.ok(route, `test fixture has no matching Static Hermes ${family} route`);
  return route;
}

function contractFor(candidate, route) {
  const contract = candidate.exactVectorCatalog.vectors.find(({ id }) => id === route.exactVector.contract);
  assert.ok(contract, `${route.id}: test fixture contract missing`);
  return contract;
}

function emittedTargetCount(target) {
  return recording.applicabilityCatalog.lanes
    .filter((lane) => lane.target === target && lane.status === "exercise")
    .reduce((sum, lane) => sum + lane.routeCount, 0) + special.counts.separateModule;
}

function staticExerciseRoutes(candidate = recording) {
  const targetIndex = candidate.applicabilityCatalog.targets.indexOf("static-hermes");
  const lanes = new Map(candidate.applicabilityCatalog.lanes.map((lane) => [lane.id, lane]));
  return candidate.routes.filter((route) => lanes.get(route.applicability[targetIndex])?.status === "exercise");
}

function expectedStaticFamilySummary(candidate = recording) {
  const counts = new Map();
  for (const route of staticExerciseRoutes(candidate)) {
    counts.set(route.loweringFamily, (counts.get(route.loweringFamily) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, emittedRouteCount]) => ({ family, emittedRouteCount,
      exactVectorCount: emittedRouteCount, missingVectorCount: 0 }))
    .sort((left, right) => right.emittedRouteCount - left.emittedRouteCount ||
      left.family.localeCompare(right.family));
}

test("the emitted three-target matrix excludes compiler-only routes and closes every Static family", () => {
  assert.equal(accounting.functionCount, 926);
  assert.equal(recording.routes.filter(({ loweringFamily }) => loweringFamily !== "script-constant").length + special.counts.total, 926);
  assert.equal(recording.routes.filter(({ loweringFamily }) => loweringFamily === "script-constant").length, 141);
  assert.equal(special.counts.componentPropertyCompiler, 8);
  assert.equal(special.counts.separateModule, 3);

  const before = {
    dynamicHermes: { emitted: emittedTargetCount("dynamic-hermes"), exact: emittedTargetCount("dynamic-hermes"), missing: 0 },
    staticHermes: { emitted: emittedTargetCount("static-hermes"), exact: special.counts.separateModule,
      missing: emittedTargetCount("static-hermes") - special.counts.separateModule },
    browserWasm: { emitted: emittedTargetCount("browser-wasm"), exact: emittedTargetCount("browser-wasm"), missing: 0 },
  };
  assert.deepEqual(before, Object.fromEntries([
    ["dynamicHermes", { emitted: emittedTargetCount("dynamic-hermes"), exact: emittedTargetCount("dynamic-hermes"), missing: 0 }],
    ["staticHermes", { emitted: emittedTargetCount("static-hermes"), exact: special.counts.separateModule,
      missing: emittedTargetCount("static-hermes") - special.counts.separateModule }],
    ["browserWasm", { emitted: emittedTargetCount("browser-wasm"), exact: emittedTargetCount("browser-wasm"), missing: 0 }]
  ]));

  const families = auditStaticScriptExactFamilies(recording);
  assert.deepEqual(families.map(({ family, emittedRouteCount, exactVectorCount, missingVectorCount }) =>
    ({ family, emittedRouteCount, exactVectorCount, missingVectorCount })), expectedStaticFamilySummary());
});

test("all Static Hermes vectors are generator-owned and complete", () => {
  const { report, vectors } = materializeStaticScriptExactVectors(recording);
  assert.equal(report.transport, "static-hermes-typed-native");
  const expectedFamilies = expectedStaticFamilySummary();
  assert.deepEqual([...report.implementedFamilies].sort(), expectedFamilies.map(({ family }) => family).sort());
  assert.equal(report.emittedRouteCount, staticExerciseRoutes().length);
  assert.equal(report.exactVectorCount, staticExerciseRoutes().length);
  assert.match(report.vectorSha256, /^[0-9a-f]{64}$/);
  assert.equal(vectors.length, staticExerciseRoutes().length);
  assert.equal(new Set(vectors.map(({ id }) => id)).size, staticExerciseRoutes().length);
  assert.ok(vectors.every(({ loweringFamily, argumentShapes, resultShapes, argumentValues, resultValues }) =>
    report.implementedFamilies.includes(loweringFamily) &&
    argumentShapes.length === argumentValues.length &&
    resultShapes.length === resultValues.length));
  assert.deepEqual(Object.fromEntries(report.implementedFamilies.map((family) => [
    family, vectors.filter(({ loweringFamily }) => loweringFamily === family).length
  ])), Object.fromEntries(expectedFamilies.map(({ family, emittedRouteCount }) => [family, emittedRouteCount])));
  const scalar = vectors.filter(({ loweringFamily }) => loweringFamily === "scalar");
  assert.ok(scalar.every(({ bounds }) =>
    bounds.inputEntryCapacity === 0 && bounds.outputEntryCapacity === 0 &&
    !bounds.matrix4Arena && !bounds.urlArena));
  assert.match(report.evidenceBoundary, /does not .*instrument allocator calls/u);

  const after = {
    dynamicHermes: { emitted: emittedTargetCount("dynamic-hermes"), exact: emittedTargetCount("dynamic-hermes"), missing: 0 },
    staticHermes: { emitted: emittedTargetCount("static-hermes"), exact: report.exactVectorCount + special.counts.separateModule, missing: 0 },
    browserWasm: { emitted: emittedTargetCount("browser-wasm"), exact: emittedTargetCount("browser-wasm"), missing: 0 },
  };
  const totalEmitted = Object.values(after).reduce((sum, row) => sum + row.emitted, 0);
  const totalExact = Object.values(after).reduce((sum, row) => sum + row.exact, 0);
  assert.equal(totalEmitted, totalExact);
  assert.equal(Object.values(after).reduce((sum, row) => sum + row.missing, 0), 0);
});

test("recursive exact plans preserve container kind, keys, and canonical child sentinels", () => {
  const route = firstFamilyRoute(recording, "lua-table", ({ resultShapes }) =>
    resultShapes.some((index) => recording.shapes[index].code === 15 &&
      recording.shapes[index].children.length > 0));
  const plan = planStaticScriptExactValue(recording, route.resultShapes[0], 257);
  assert.equal(plan.kind, "record");
  assert.ok(plan.fields.length > 0);
  assert.deepEqual(plan.fields.map(({ key }) => key),
    recording.shapes[route.resultShapes[0]].children.map((index) => recording.shapes[index].keyText));
  assert.equal(plan.specification, contractFor(recording, route).resultValues[0]);
});

test("recursive exact plans reject a cyclic shape with the declared fail-closed error", () => {
  const mutation = cloneRecording();
  const route = firstFamilyRoute(mutation, "lua-table", ({ resultShapes }) =>
    resultShapes.some((index) => [14, 15, 16].includes(mutation.shapes[index].code)));
  const shapeIndex = route.resultShapes.find((index) => [14, 15, 16].includes(mutation.shapes[index].code));
  mutation.shapes[shapeIndex].children = [shapeIndex];
  assert.throws(() => planStaticScriptExactValue(mutation, shapeIndex, 257),
    new RegExp(`Static Hermes exact shape ${shapeIndex} is cyclic`));
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

  const wrongCensus = cloneRecording();
  const exerciseLane = wrongCensus.applicabilityCatalog.lanes.find(({ target, status }) =>
    target === "static-hermes" && status === "exercise");
  exerciseLane.routeCount -= 1;
  assert.throws(() => auditStaticScriptExactFamilies(wrongCensus), /differs from applicability lanes/);
});

test("Static exact generation rejects an exercised lowering family without an emitter", () => {
  const mutation = cloneRecording();
  const route = firstFamilyRoute(mutation, "multi-result");
  route.loweringFamily = "future-family";
  assert.throws(() => materializeStaticScriptExactVectors(mutation),
    /no emitter for exercised families: future-family\(1\)/);
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

  const tableCapacityMutation = cloneRecording();
  const tableCapacityRoute = firstFamilyRoute(tableCapacityMutation, "lua-table", ({ argumentShapes }) =>
    argumentShapes.some((index) => [14, 15, 16].includes(tableCapacityMutation.shapes[index].code)));
  contractFor(tableCapacityMutation, tableCapacityRoute).bounds.inputEntryCapacity = 255;
  assert.throws(() => materializeStaticScriptExactVectors(tableCapacityMutation),
    /table-entry capacity drifted/);

  const recursiveMutation = cloneRecording();
  const recursiveRoute = firstFamilyRoute(recursiveMutation, "lua-table", ({ resultShapes }) =>
    resultShapes.some((index) => [14, 15, 16].includes(recursiveMutation.shapes[index].code)));
  contractFor(recursiveMutation, recursiveRoute).resultValues[0] = "rec(corrupt=num:1)";
  assert.throws(() => materializeStaticScriptExactVectors(recursiveMutation), /exact result value drifted/);

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
  assert.doesNotMatch(productionStaticTransport,
    /exact(?:Tag|Number|String|Length|KeyString|Key|Value)\(/u);
  const verificationTransport = renderStaticHermes(layouts, { verification: true });
  assert.match(verificationTransport, /exactTag\(\):number/u);
  assert.match(verificationTransport, /exactNumber\(slot:number\):number/u);
  assert.match(verificationTransport, /exactString\(\):string/u);
  assert.match(verificationTransport, /exactLength\(\):number/u);
  assert.match(verificationTransport, /exactKeyString\(slot:number\):string/u);
  assert.match(verificationTransport, /exactKey\(slot:number\):DehermStaticValue/u);
  assert.match(verificationTransport, /exactValue\(slot:number\):DehermStaticValue/u);
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
