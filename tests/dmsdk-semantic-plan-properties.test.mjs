import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDmSdkBorrowedHandlePlan,
  DMSDK_BORROWED_HANDLE_ELIGIBILITY,
  indexDmSdkBorrowedHandlePlan,
} from "../packages/compiler/src/dmsdk-borrowed-handle-plan.mjs";

const root = new URL("../", import.meta.url);
const sourcePaths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));

async function borrowedInputs() {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sourcePaths).map(async ([key, relative]) => [
        key,
        await readFile(new URL(relative, root), "utf8"),
      ]),
    ),
  );
  return {
    texts,
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    projection: JSON.parse(texts.projection),
    policy: JSON.parse(texts.policy),
  };
}

function refreshInputTexts(input) {
  input.texts.ir = `${JSON.stringify(input.ir)}\n`;
  input.texts.policy = `${JSON.stringify(input.policy)}\n`;
  input.texts.shapes = `${JSON.stringify(input.shapes)}\n`;
  input.texts.projection = `${JSON.stringify(input.projection)}\n`;
  const irHash = sha256(input.texts.ir);
  input.shapes.sourceHashes.ir = irHash;
  input.projection.sources.hashes.ir = irHash;
  input.texts.shapes = `${JSON.stringify(input.shapes)}\n`;
  input.texts.projection = `${JSON.stringify(input.projection)}\n`;
}

function planDecisionShape(decision) {
  return {
    declarationId: decision.declarationId,
    order: decision.order,
    patternId: decision.patternId,
    family: decision.family,
    emitter: decision.emitter,
    fallback: decision.fallback,
    rank: decision.rank,
    semanticTokens: decision.semanticTokens,
    semantics: decision.semantics,
    effect: decision.effect,
    blockers: decision.blockers,
  };
}

function withoutRevisionIdentity(plan) {
  return {
    providerAbiVersion: plan.providerAbiVersion,
    abi: plan.abi,
    eligibility: plan.eligibility,
    patternRegistry: plan.patternRegistry,
    coverage: plan.coverage,
    decisions: plan.decisions.map(planDecisionShape),
  };
}

function appendRetaggedRows(input, sourceId, replacementId) {
  for (const collection of [input.ir.declarations, input.shapes.rows, input.projection.rows]) {
    const source = collection.find(({ id }) => id === sourceId);
    assert.ok(source, `fixture row ${sourceId} exists`);
    const row = structuredClone(source);
    row.id = replacementId;
    if (row.provenance?.sourceId === sourceId) row.provenance.sourceId = replacementId;
    collection.push(row);
  }
}

function assertSelectedOrder(plan) {
  const selected = plan.decisions.filter(({ fallback }) => !fallback);
  assert.deepEqual(
    selected.map(({ order }) => order),
    Array.from({ length: selected.length }, (_, index) => index),
    `${plan.kind}: selected order is not dense and canonical`,
  );
  assert.equal(
    new Set(plan.decisions.map(({ declarationId }) => declarationId)).size,
    plan.decisions.length,
    `${plan.kind}: duplicate decision IDs`,
  );
  assert.equal(
    plan.coverage.selected + plan.coverage.universalFallback,
    plan.coverage.structurallyRelevant,
    `${plan.kind}: selected/fallback coverage is not total`,
  );
}

test("the current universal corpus emits every dispatchable dmSDK declaration exactly once", async () => {
  const [ir, universal] = await Promise.all([
    readJson("packages/bindings/generated/defold-sdk-ir.json"),
    readJson("packages/bindings/generated/defold-dmsdk-universal-bindings.json"),
  ]);
  const sourceIds = ir.declarations
    .filter(({ disposition }) => disposition === "generated-raw-call")
    .map(({ id }) => id)
    .sort();
  const metadataCount = ir.declarations.filter(({ disposition }) => disposition === "generated-type-metadata").length;
  const hiddenCount = ir.declarations.filter(
    ({ disposition }) => disposition === "intentionally-hidden-non-public",
  ).length;
  const universalIds = universal.recipes.map(({ declarationId }) => declarationId).sort();
  assert.equal(universal.coverage.declarations, sourceIds.length);
  assert.equal(universal.coverage.silentlyOmitted, 0);
  assert.equal(universal.coverage.declarations + metadataCount + hiddenCount, ir.declarations.length);
  assert.deepEqual(universalIds, sourceIds);
  assert.equal(new Set(universalIds).size, universalIds.length);
});

test("borrowed planning remains compatible with its package recipe and current policy", async () => {
  const inputs = await borrowedInputs();
  const plan = await readJson("packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json");
  const index = indexDmSdkBorrowedHandlePlan(plan, inputs);
  assert.equal(index.size, plan.coverage.structurallyRelevant);
  assert.deepEqual(plan.eligibility, DMSDK_BORROWED_HANDLE_ELIGIBILITY);
  assert.equal(plan.sources.policy, sourcePaths.policy);
  assert.doesNotMatch(JSON.stringify(DMSDK_BORROWED_HANDLE_ELIGIBILITY), /dmsdk:|@upstream|dm[A-Z][\w:]+::/u);
  assertSelectedOrder(plan);
});

test("borrowed decisions are invariant across the available revision envelopes", async () => {
  const base = await borrowedInputs();
  const current = buildDmSdkBorrowedHandlePlan(base);
  const matrix = await readJson("packages/bindings/probes/defold-revision-matrix.json");
  for (const lane of matrix.lanes) {
    const input = structuredClone(base);
    input.ir.defoldRevision = lane.revision;
    input.shapes.defoldRevision = lane.revision;
    input.projection.defoldRevision = lane.revision;
    refreshInputTexts(input);
    const derived = buildDmSdkBorrowedHandlePlan(input);
    indexDmSdkBorrowedHandlePlan(derived, input);
    assert.deepEqual(
      withoutRevisionIdentity(derived),
      withoutRevisionIdentity(current),
      `${lane.id}: revision envelope changed semantic plan selection`,
    );
    assert.equal(derived.defoldRevision, lane.revision);
  }
});

test("renaming a safe route does not alter its semantic decision", async () => {
  const base = await borrowedInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(base);
  const selected = baseline.decisions.find(({ fallback, effect }) => !fallback && effect.signals.length === 0);
  assert.ok(selected, "fixture contains a contradiction-free selected route");
  const input = structuredClone(base);
  const declaration = input.ir.declarations.find(({ id }) => id === selected.declarationId);
  declaration.name = "RenamedOpaqueMember";
  refreshInputTexts(input);
  const renamed = buildDmSdkBorrowedHandlePlan(input).decisions.find(
    ({ declarationId }) => declarationId === selected.declarationId,
  );
  assert.deepEqual(planDecisionShape(renamed), planDecisionShape(selected));
});

test("adding a structurally valid route changes totals, not the existing decisions", async () => {
  const base = await borrowedInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(base);
  const selected = baseline.decisions.find(({ fallback }) => !fallback);
  const replacementId = "dmsdk:synthetic::Opaque@synthetic.h:999999";
  const input = structuredClone(base);
  appendRetaggedRows(input, selected.declarationId, replacementId);
  input.ir.declarations.find(({ id }) => id === replacementId).name = "SyntheticOpaque";
  refreshInputTexts(input);
  const expanded = buildDmSdkBorrowedHandlePlan(input);
  assert.equal(expanded.coverage.structurallyRelevant, baseline.coverage.structurallyRelevant + 1);
  assert.equal(expanded.coverage.selected, baseline.coverage.selected + 1);
  assert.equal(expanded.coverage.universalFallback, baseline.coverage.universalFallback);
  const expandedExisting = expanded.decisions
    .filter(({ declarationId }) => declarationId !== replacementId)
    .map(planDecisionShape);
  assert.deepEqual(expandedExisting, baseline.decisions.map(planDecisionShape));
});

test("an unresolved lifetime fact is retained as a universal fallback", async () => {
  const base = await borrowedInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(base);
  const selected = baseline.decisions.find(({ fallback }) => !fallback);
  const input = structuredClone(base);
  const projected = input.projection.rows.find(({ id }) => id === selected.declarationId);
  projected.effects.callbacks = { present: true };
  refreshInputTexts(input);
  const derived = buildDmSdkBorrowedHandlePlan(input);
  const decision = derived.decisions.find(({ declarationId }) => declarationId === selected.declarationId);
  assert.equal(decision.fallback, true);
  assert.equal(decision.patternId, "universal.default");
  assert.ok(decision.blockers.includes("borrowed-handle-effect:asynchronous"));
  assert.equal(derived.coverage.selected, baseline.coverage.selected - 1);
  assert.equal(derived.coverage.universalFallback, baseline.coverage.universalFallback + 1);
});
