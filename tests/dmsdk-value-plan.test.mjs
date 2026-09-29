import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDmSdkValuePlan, indexDmSdkValuePlan } from "../packages/compiler/src/dmsdk-value-plan.mjs";

const root = new URL("../", import.meta.url);
const sourcePaths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  scalar: "packages/bindings/overrides/dmsdk-scalar-thunks.json",
  enumValue: "packages/bindings/overrides/dmsdk-enum-value-bindings.json",
  namedScalar: "packages/bindings/overrides/dmsdk-named-scalar-policies.json",
});
const reports = Object.freeze([
  ["value.direct-primitive-scalar", "packages/bindings/generated/defold-dmsdk-scalar-thunks.json"],
  ["value.enum-domain-direct", "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json"],
  ["value.named-scalar-direct", "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json"],
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function inputs() {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sourcePaths).map(async ([key, path]) => [key, await readFile(new URL(path, root), "utf8")]),
    ),
  );
  return {
    texts,
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    policies: {
      scalar: JSON.parse(texts.scalar),
      enumValue: JSON.parse(texts.enumValue),
      namedScalar: JSON.parse(texts.namedScalar),
    },
  };
}

test("one authenticated value plan owns scalar, enum, and named-scalar selection", async () => {
  const planText = await readFile(new URL("packages/bindings/generated/defold-dmsdk-value-plan.json", root), "utf8");
  const plan = JSON.parse(planText);
  const planHash = sha256(planText);
  const selected = new Set(
    plan.decisions.filter(({ fallback }) => !fallback).map(({ declarationId }) => declarationId),
  );
  const emitted = new Set();
  indexDmSdkValuePlan(plan, { revision: plan.defoldRevision });
  for (const [patternId, path] of reports) {
    const report = JSON.parse(await readFile(new URL(path, root), "utf8"));
    assert.equal(report.sourceHashes.valuePlan, planHash, path);
    for (const row of report.declarations) {
      assert.equal(row.patternDecision, patternId, row.id);
      assert.equal(emitted.has(row.id), false, `${row.id} is owned by more than one value emitter`);
      emitted.add(row.id);
    }
  }
  assert.deepEqual([...emitted].sort(), [...selected].sort());
});

test("value planning is canonical across input order and semantic loss falls back", async () => {
  const base = await inputs();
  const expected = buildDmSdkValuePlan(base);
  const shuffled = structuredClone(base);
  shuffled.ir.declarations.reverse();
  shuffled.shapes.rows.reverse();
  assert.deepEqual(buildDmSdkValuePlan(shuffled), expected);

  const withdrawn = structuredClone(base);
  const scalar = expected.decisions.find(({ patternId }) => patternId === "value.direct-primitive-scalar");
  const declaration = withdrawn.ir.declarations.find(({ id }) => id === scalar.declarationId);
  declaration.returns = "UnresolvedScalarForFixture";
  withdrawn.texts.ir = `${JSON.stringify(withdrawn.ir)}\n`;
  withdrawn.shapes.sourceHashes.ir = sha256(withdrawn.texts.ir);
  withdrawn.texts.shapes = `${JSON.stringify(withdrawn.shapes)}\n`;
  const fallback = buildDmSdkValuePlan(withdrawn).decisions.find(
    ({ declarationId }) => declarationId === scalar.declarationId,
  );
  assert.equal(fallback.patternId, "universal.default");
  assert.equal(fallback.semantics, null);
});

test("value emitters cannot select patterns or construct private registries", async () => {
  for (const path of [
    "scripts/generate-dmsdk-scalar-thunks.mjs",
    "scripts/generate-dmsdk-enum-value-bindings.mjs",
    "scripts/generate-dmsdk-named-scalar-bindings.mjs",
  ]) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(source, /selectDmSdkPattern|dmsdk-pattern-catalog|compactDmSdkPatternDecision/u, path);
    assert.match(source, /indexDmSdkValuePlan/u, path);
  }
});

test("value-plan verification rejects a forged decision owner", async () => {
  const plan = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-dmsdk-value-plan.json", root), "utf8"),
  );
  const forged = structuredClone(plan);
  forged.decisions[0].emitter = "scripts/forged-emitter.mjs";
  assert.throws(() => indexDmSdkValuePlan(forged), /owner differs/u);
});
