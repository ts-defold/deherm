import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDmSdkCStringValuePlan,
  indexDmSdkCStringValuePlan,
} from "../packages/compiler/src/dmsdk-cstring-value-plan.mjs";

const root = new URL("../", import.meta.url);
const sources = Object.freeze({
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  sdkIr: "packages/bindings/generated/defold-sdk-ir.json",
  policy: "packages/bindings/overrides/dmsdk-cstring-value-bindings.json",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function inputs() {
  const texts = Object.fromEntries(await Promise.all(
    Object.entries(sources).map(async ([key, source]) => [key, await readFile(new URL(source, root), "utf8")]),
  ));
  return {
    texts,
    projection: JSON.parse(texts.projection),
    sdkIr: JSON.parse(texts.sdkIr),
    policy: JSON.parse(texts.policy),
  };
}

function refreshText(input, key) {
  input.texts[key] = `${JSON.stringify(input[key])}\n`;
}

test("one authenticated C-string plan owns every emitted or fallback candidate", async () => {
  const [planText, reportText] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-dmsdk-cstring-value-plan.json", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json", root), "utf8"),
  ]);
  const plan = JSON.parse(planText);
  const report = JSON.parse(reportText);
  indexDmSdkCStringValuePlan(plan, { revision: report.defoldRevision });
  assert.equal(report.sources.hashes.plan, sha256(planText));
  assert.deepEqual(report.declarations.map(({ id }) => id), plan.decisions.map(({ declarationId }) => declarationId));
  assert.deepEqual(
    report.declarations.map(({ id, disposition, blocker }) => ({ id, disposition, blocker })),
    plan.decisions.map(({ declarationId, fallback, blocker }) => ({
      id: declarationId,
      disposition: fallback ? "blocked" : "generated",
      blocker,
    })),
  );
});

test("C-string planning preserves canonical projection order and fixed source-hash key order", async () => {
  const base = await inputs();
  const expected = buildDmSdkCStringValuePlan(base);
  const reversedTextKeys = {
    ...base,
    texts: { policy: base.texts.policy, sdkIr: base.texts.sdkIr, projection: base.texts.projection },
  };
  assert.deepEqual(buildDmSdkCStringValuePlan(reversedTextKeys), expected);
  const decisionIds = new Set(expected.decisions.map(({ declarationId }) => declarationId));
  assert.deepEqual(
    expected.decisions.map(({ declarationId }) => declarationId),
    base.projection.rows.filter(({ id }) => decisionIds.has(id)).map(({ id }) => id),
  );
});

test("withdrawing public string evidence preserves the universal fallback", async () => {
  const input = await inputs();
  const baseline = buildDmSdkCStringValuePlan(input);
  const selected = new Set(baseline.decisions.filter(({ fallback }) => !fallback).map(({ declarationId }) => declarationId));
  for (const declaration of input.sdkIr.declarations.filter(({ id }) => selected.has(id))) {
    declaration.description = "No public string contract is documented.";
    declaration.returnDescription = "";
    for (const parameter of declaration.parameters) parameter.description = "";
  }
  refreshText(input, "sdkIr");
  input.projection.sources.hashes.ir = sha256(input.texts.sdkIr);
  refreshText(input, "projection");
  const withdrawn = buildDmSdkCStringValuePlan(input);
  assert.equal(withdrawn.coverage.selected, 0);
  assert.equal(withdrawn.coverage.universalFallback, withdrawn.coverage.candidates);
  assert.ok(withdrawn.decisions.every(({ blocker }) => blocker !== null));
});

test("explicit negative documentation dominates generic positive substrings", async () => {
  const input = await inputs();
  const baseline = buildDmSdkCStringValuePlan(input);
  const enumResult = baseline.decisions.find(({ contract }) => contract?.id === "enum-literal-result-utf8");
  const inputTransform = baseline.decisions.find(({ contract }) => contract?.id === "input-js-utf8");
  const nullableResult = baseline.decisions.find(({ contract }) => contract?.id === "nullable-input-slice-utf8");
  assert.ok(enumResult && inputTransform && nullableResult);
  const byId = new Map(input.sdkIr.declarations.map((declaration) => [declaration.id, declaration]));
  byId.get(enumResult.declarationId).description = "String representation; may return NULL for an unknown value.";
  const inputDeclaration = byId.get(inputTransform.declarationId);
  const stringIndex = input.projection.rows.find(({ id }) => id === inputTransform.declarationId)
    .signature.parameters.findIndex(({ type }) => type.kind === "cstring");
  inputDeclaration.parameters[stringIndex].description = "Path bytes may be NULL, use arbitrary encoding, and are retained asynchronously.";
  byId.get(nullableResult.declarationId).returnDescription = "Borrowed arbitrary bytes, not NUL terminated; 0 otherwise.";
  refreshText(input, "sdkIr");
  input.projection.sources.hashes.ir = sha256(input.texts.sdkIr);
  refreshText(input, "projection");
  const changed = buildDmSdkCStringValuePlan(input);
  const decisions = new Map(changed.decisions.map((decision) => [decision.declarationId, decision]));
  assert.equal(decisions.get(enumResult.declarationId).blocker, "cstring-result-nullability-contradiction");
  assert.equal(decisions.get(inputTransform.declarationId).blocker, "cstring-input-nullability-contradiction");
  assert.equal(decisions.get(nullableResult.declarationId).blocker, "cstring-result-codec-contradiction");
  assert.ok([enumResult, inputTransform, nullableResult].every(({ declarationId }) => decisions.get(declarationId).fallback));
});

test("same-revision projection and SDK mixtures fail source authentication", async () => {
  const input = await inputs();
  input.sdkIr.declarations[0].description = "same revision, different source";
  refreshText(input, "sdkIr");
  assert.throws(() => buildDmSdkCStringValuePlan(input), /does not authenticate the SDK IR/u);
});

test("plan verification rejects forged ownership and unsupported policy behavior", async () => {
  const input = await inputs();
  const plan = buildDmSdkCStringValuePlan(input);
  const forgedContract = structuredClone(plan);
  const contractDecision = forgedContract.decisions.find(({ fallback }) => !fallback);
  contractDecision.contract = { id: "bogus", result: { nullability: "nullable", encoding: "arbitrary" } };
  assert.throws(
    () => indexDmSdkCStringValuePlan(forgedContract, { inputs: input }),
    /differs from its authenticated compiler derivation/u,
  );
  const selected = plan.decisions.find(({ fallback }) => !fallback);
  selected.emitter = "scripts/forged-emitter.mjs";
  assert.throws(() => indexDmSdkCStringValuePlan(plan), /owner differs/u);
  input.policy.recipe.scratchCapacity = 0x1_0000_0000;
  refreshText(input, "policy");
  assert.throws(() => buildDmSdkCStringValuePlan(input), /scratch capacity is unsupported/u);
});

test("irrelevant family classification cannot remove an ABI-identical candidate", async () => {
  const input = await inputs();
  const baseline = buildDmSdkCStringValuePlan(input);
  const selected = baseline.decisions.find(({ fallback }) => !fallback);
  const row = input.projection.rows.find(({ id }) => id === selected.declarationId);
  row.provenance.primaryFamily = "synthetic-unrelated-family";
  row.provenance.families = ["synthetic-unrelated-family"];
  refreshText(input, "projection");
  const changed = buildDmSdkCStringValuePlan(input);
  assert.equal(changed.coverage.candidates, baseline.coverage.candidates);
  assert.equal(changed.decisions.find(({ declarationId }) => declarationId === selected.declarationId).fallback, false);
});

test("compiler-owned TypeScript names resolve normalized symbol collisions deterministically", async () => {
  const input = await inputs();
  const baseline = buildDmSdkCStringValuePlan(input);
  const selected = baseline.decisions.filter(({ fallback }) => !fallback).slice(0, 2);
  input.projection.rows.find(({ id }) => id === selected[0].declarationId).symbol = "dmFoo::BarBaz";
  input.projection.rows.find(({ id }) => id === selected[1].declarationId).symbol = "dmFooBar::Baz";
  refreshText(input, "projection");
  const changed = buildDmSdkCStringValuePlan(input);
  const names = changed.decisions.filter(({ declarationId }) => selected.some((entry) => entry.declarationId === declarationId))
    .map(({ typescriptName }) => typescriptName);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => /^dmFooBarBaz_[0-9a-f]{8}$/u.test(name)));
});

test("every C-string candidate retains its universal recipe regardless of specialization", async () => {
  const [input, universal] = await Promise.all([
    inputs(),
    readFile(new URL("packages/bindings/generated/defold-dmsdk-universal-bindings.json", root), "utf8").then(JSON.parse),
  ]);
  const plan = buildDmSdkCStringValuePlan(input);
  const universalIds = new Set(universal.recipes.map(({ declarationId }) => declarationId));
  assert.ok(plan.decisions.every(({ declarationId }) => universalIds.has(declarationId)));
});

test("the C-string emitter consumes the plan and cannot select patterns", async () => {
  const source = await readFile(new URL("scripts/generate-dmsdk-cstring-value-bindings.mjs", root), "utf8");
  assert.doesNotMatch(source, /selectDmSdkPattern|dmsdk-pattern-catalog|cstringValuePatterns|resolveCStringContracts/u);
  assert.match(source, /indexDmSdkCStringValuePlan/u);
});
