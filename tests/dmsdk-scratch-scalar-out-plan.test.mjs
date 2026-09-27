import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildDmSdkScratchScalarOutPlan,
  indexDmSdkScratchScalarOutPlan,
} from "../packages/compiler/src/dmsdk-scratch-scalar-out-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json",
  effectFacts: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
});

async function inputs() {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sourcePaths).map(async ([key, relative]) => [
        key,
        await readFile(path.join(root, relative), "utf8"),
      ]),
    ),
  );
  return {
    texts,
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    projection: JSON.parse(texts.projection),
    policy: JSON.parse(texts.policy),
    effectFacts: JSON.parse(texts.effectFacts),
  };
}

test("scratch plan covers every structural match and preserves universal fallback for unknown facts", async () => {
  const value = await inputs();
  const plan = buildDmSdkScratchScalarOutPlan(value);
  indexDmSdkScratchScalarOutPlan(plan, value);
  assert.equal(plan.coverage.structurallyRelevant, 30);
  assert.equal(plan.coverage.selected, 11);
  assert.equal(plan.coverage.sourceDerived, 6);
  assert.equal(plan.coverage.compatibilityPreserved, 5);
  assert.equal(plan.coverage.universalFallback, 19);
  assert.equal(plan.decisions.length, 30);
  assert.ok(plan.decisions.every((decision) => decision.universalFallback.preserved));
  assert.ok(plan.decisions.filter((decision) => decision.fallback).every((decision) => decision.blockers.length > 0));
  assert.ok(
    plan.decisions
      .filter((decision) => decision.admission === "source-derived")
      .every(
        (decision) =>
          decision.blockers.length === 0 &&
          decision.facts.source === "cpp-ownership-effect-facts" &&
          Object.entries(decision.facts).every(([key, fact]) => key === "source" || fact !== "unknown"),
      ),
  );
  assert.ok(
    plan.decisions
      .filter((decision) => decision.admission === "compatibility-preserved")
      .every(
        (decision) =>
          decision.blockers.length === 0 &&
          decision.evidenceGaps.length > 0 &&
          value.shapes.rows.find(({ id }) => id === decision.declarationId)?.tranche === value.policy.family,
      ),
  );
});

test("scratch decisions are metamorphic under input row order", async () => {
  const value = await inputs();
  const baseline = buildDmSdkScratchScalarOutPlan(value);
  const changed = structuredClone(value);
  changed.shapes.rows.reverse();
  changed.projection.rows.reverse();
  changed.texts = {
    ...changed.texts,
    shapes: JSON.stringify(changed.shapes),
    projection: JSON.stringify(changed.projection),
  };
  const reordered = buildDmSdkScratchScalarOutPlan(changed);
  assert.deepEqual(
    reordered.decisions.map(({ declarationId, patternId, blockers }) => ({ declarationId, patternId, blockers })),
    baseline.decisions.map(({ declarationId, patternId, blockers }) => ({ declarationId, patternId, blockers })),
  );
});

test("authenticated plan rejects stale or forged decisions", async () => {
  const value = await inputs();
  const plan = buildDmSdkScratchScalarOutPlan(value);
  const forged = structuredClone(plan);
  forged.decisions[0].blockers = [];
  forged.decisions[0].fallback = false;
  forged.decisions[0].order = 0;
  assert.throws(
    () => indexDmSdkScratchScalarOutPlan(forged),
    /blockers differ from admission|fallback differs from blockers|pattern differs from fallback|selected coverage differs|strict source re-derivation/,
  );
});

test("withdrawing source proof demotes a newly inferred route to universal fallback", async () => {
  const value = await inputs();
  const baseline = buildDmSdkScratchScalarOutPlan(value);
  const sourceDecision = baseline.decisions.find(
    ({ admission, declarationId }) =>
      admission === "source-derived" &&
      value.shapes.rows.find(({ id }) => id === declarationId)?.tranche !== value.policy.family,
  );
  assert.ok(sourceDecision, "expected a source-derived route outside the compatibility tranche");
  const changed = structuredClone(value);
  const fact = changed.effectFacts.functions.find(
    ({ declarationId }) => declarationId === sourceDecision.declarationId,
  )?.fact;
  assert.ok(fact);
  fact.diagnostics.push("test-withdrawn-source-proof");
  changed.texts = { ...changed.texts, effectFacts: JSON.stringify(changed.effectFacts) };
  const changedPlan = buildDmSdkScratchScalarOutPlan(changed);
  const decision = changedPlan.decisions.find(({ declarationId }) => declarationId === sourceDecision.declarationId);
  assert.equal(decision?.admission, "universal-fallback");
  assert.equal(decision?.fallback, true);
  assert.deepEqual(decision?.blockers, decision?.evidenceGaps);
});

test("scratch selections cannot steal routes owned by a specialized family", async () => {
  const value = await inputs();
  const plan = buildDmSdkScratchScalarOutPlan(value);
  const selectedScratch = new Set(
    plan.decisions.filter(({ fallback }) => !fallback).map(({ declarationId }) => declarationId),
  );
  const specializedReports = [
    "packages/bindings/generated/defold-dmsdk-bounded-span-plan.json",
    "packages/bindings/generated/defold-dmsdk-value-plan.json",
    "packages/bindings/generated/defold-dmsdk-hash-state-plan.json",
    "packages/bindings/generated/defold-dmsdk-cstring-value-plan.json",
    "packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json",
    "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json",
    "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json",
    "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json",
    "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json",
    "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json",
    "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json",
    "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
  ];
  const specialized = new Set();
  for (const relative of specializedReports) {
    const report = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    if (Array.isArray(report.decisions)) {
      for (const decision of report.decisions) if (decision.fallback === false) specialized.add(decision.declarationId);
    }
    if (Array.isArray(report.declarations)) {
      for (const declaration of report.declarations) {
        if (declaration.emitted || String(declaration.disposition ?? "").startsWith("generated"))
          specialized.add(declaration.id);
      }
    }
  }
  const overlap = [...selectedScratch].filter((id) => specialized.has(id));
  assert.deepEqual(overlap, [], "scratch plan selected a route already owned by a specialized family");
});
