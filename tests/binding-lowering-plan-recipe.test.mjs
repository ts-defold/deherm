import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createBindingLoweringRecipeFacts,
  emitBindingLoweringPlan,
  emitBindingLoweringPlanSentinel
} from "../packages/compiler/src/binding-lowering-plan-recipe.mjs";
import { serializeObject } from "../packages/compiler/src/api-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [planSource, sentinelSource, emitterSource] = await Promise.all([
  readFile(path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.json"), "utf8"),
  readFile(path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.sentinel.json"), "utf8"),
  readFile(path.join(root, "packages/compiler/src/binding-lowering-plan-recipe.mjs"))
]);
const plan = JSON.parse(planSource);
const sentinel = JSON.parse(sentinelSource);

test("compact lowering recipe facts reproduce old-pipeline plan bytes", () => {
  const facts = createBindingLoweringRecipeFacts(plan, sentinel);
  const canonicalFacts = JSON.parse(serializeObject(facts));
  const emitted = emitBindingLoweringPlan(canonicalFacts);
  assert.equal(emitted.source, planSource);
  assert.deepEqual(emitted.plan, plan);

  const policyBytes = Buffer.byteLength(serializeObject({
    schemaVersion: 1,
    kind: "deherm.policy.compiler-document",
    namespace: "@compiler:document:defold-binding-lowering-recipe-facts.json",
    name: "defold-binding-lowering-recipe-facts.json",
    value: facts
  }));
  assert.ok(policyBytes < 3_000_000,
    `lowering recipe facts must remain compact; got ${policyBytes.toLocaleString()} policy bytes`);
  assert.ok(policyBytes * 3 < Buffer.byteLength(planSource),
    "lowering recipe facts must be at least three times smaller than the copied plan");
});

test("lowering recipe realization is content-keyed and idempotent", () => {
  const facts = createBindingLoweringRecipeFacts(plan, sentinel);
  const first = emitBindingLoweringPlan(facts);
  const second = emitBindingLoweringPlan(facts);
  const firstSentinel = emitBindingLoweringPlanSentinel(facts, first, emitterSource);
  const secondSentinel = emitBindingLoweringPlanSentinel(facts, second, emitterSource);
  assert.deepEqual(second, first);
  assert.deepEqual(secondSentinel, firstSentinel);

  const changedPlan = structuredClone(plan);
  changedPlan.inputHashes = { ...changedPlan.inputHashes, browserWasmHost: "0".repeat(64) };
  const { planSha256: _previous, ...changedBody } = changedPlan;
  changedPlan.planSha256 = createHash("sha256").update(JSON.stringify(changedBody)).digest("hex");
  const changedSentinelInput = {
    ...sentinel,
    inputHashes: changedPlan.inputHashes
  };
  const changedFacts = createBindingLoweringRecipeFacts(changedPlan, changedSentinelInput);
  const changed = emitBindingLoweringPlan(changedFacts);
  const changedSentinel = emitBindingLoweringPlanSentinel(changedFacts, changed, emitterSource);
  assert.notEqual(changedSentinel.cacheKey, firstSentinel.cacheKey,
    "a changed lowering input identity must select a different realization key");
});
