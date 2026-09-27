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
const sources = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
});
const planUrl = new URL("packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json", root);

async function loadInputs() {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([key, source]) => [key, await readFile(new URL(source, root), "utf8")]),
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

function refreshTexts(inputs) {
  inputs.texts = {
    ir: `${JSON.stringify(inputs.ir)}\n`,
    shapes: `${JSON.stringify(inputs.shapes)}\n`,
    projection: `${JSON.stringify(inputs.projection)}\n`,
    policy: `${JSON.stringify(inputs.policy)}\n`,
  };
  const digest = createHash("sha256").update(inputs.texts.ir).digest("hex");
  inputs.shapes.sourceHashes.ir = digest;
  inputs.projection.sources.hashes.ir = digest;
  inputs.texts.shapes = `${JSON.stringify(inputs.shapes)}\n`;
  inputs.texts.projection = `${JSON.stringify(inputs.projection)}\n`;
  return inputs;
}

function decisionByLeaf(plan, leaf) {
  return plan.decisions.find(({ declarationId }) => declarationId.startsWith(`dmsdk:${leaf}@`));
}

test("global borrowed-handle planning selects only synchronous borrowed consumers", async () => {
  const inputs = await loadInputs();
  const committed = JSON.parse(await readFile(planUrl, "utf8"));
  const index = indexDmSdkBorrowedHandlePlan(committed, inputs);
  assert.equal(index.size, committed.coverage.structurallyRelevant);
  assert.equal(committed.coverage.structurallyRelevant, 182);
  assert.equal(committed.coverage.selected, 147);
  assert.equal(committed.coverage.universalFallback, 35);
  assert.equal(committed.providerAbiVersion, 2);
  assert.equal(committed.abi.reason, "withdrawal renumbers private pre-release version-one IDs atomically");
  assert.equal(decisionByLeaf(committed, "dmGraphics::GetWindowWidth").fallback, false);
  assert.equal(decisionByLeaf(committed, "dmGraphics::GetWindowWidth").effect.admission.kind, "trusted-defold-default");
  for (const leaf of [
    "dmBuffer::Destroy",
    "dmGameObject::AcquireInstanceIndex",
    "dmGameObject::PropertyContainerDestroy",
    "JobSystemDestroy",
    "FontDestroy",
    "FontCollectionDestroy",
    "dmConnectionPool::Return",
    "dmResource::IncRef",
    "ResourceDescriptorIncRef",
    "TextLayoutAcquire",
    "TextLayoutRelease",
    "WindowClose",
    "WindowDelete",
  ])
    assert.equal(decisionByLeaf(committed, leaf).fallback, true, leaf);
  assert.deepEqual(
    committed.decisions.filter(({ fallback }) => !fallback).map(({ order }) => order),
    Array.from({ length: committed.coverage.selected }, (_, index) => index),
  );
});

test("effect semantics dominate the borrowed default", async () => {
  const base = await loadInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(base);
  const selected = baseline.decisions.find(({ fallback }) => !fallback);
  const cases = [
    {
      label: "finalizer",
      name: "DestroyResource",
      description: "Destroys the resource.",
      effect: "consumed-candidate-requires-token",
    },
    {
      label: "producer lease",
      name: "AcquireLease",
      description: "Acquire a lease.",
      effect: "borrowed-or-transferred-requires-token",
    },
    {
      label: "retained handle",
      name: "ObserveHandle",
      description: "Retains the shared reference.",
      effect: "borrowed-or-transferred-requires-token",
    },
    {
      label: "transferred handle",
      name: "SubmitHandle",
      description: "Takes ownership of the handle.",
      effect: "borrowed-or-transferred-requires-token",
    },
    {
      label: "async handle",
      name: "ScheduleHandle",
      description: "The handle is stored for later asynchronous use.",
      effect: "borrowed-or-transferred-requires-token",
    },
  ];
  for (const fixture of cases) {
    const inputs = structuredClone(base);
    const declaration = inputs.ir.declarations.find(({ id }) => id === selected.declarationId);
    const projection = inputs.projection.rows.find(({ id }) => id === selected.declarationId);
    declaration.name = fixture.name;
    declaration.description = fixture.description;
    projection.effects.ownership.parameters = projection.effects.ownership.parameters.map(() => fixture.effect);
    refreshTexts(inputs);
    const decision = buildDmSdkBorrowedHandlePlan(inputs).decisions.find(
      ({ declarationId }) => declarationId === selected.declarationId,
    );
    assert.equal(decision.fallback, true, fixture.label);
    assert.ok(decision.blockers.length > 0, fixture.label);
    assert.equal(decision.effect.admission.kind, "revision-contradiction", fixture.label);
    assert.ok(decision.effect.signals.length > 0, fixture.label);
  }
});

test("borrowed-handle decisions are canonical across reordered source arrays", async () => {
  const base = await loadInputs();
  const expected = buildDmSdkBorrowedHandlePlan(base);
  const reordered = structuredClone(base);
  reordered.ir.declarations.reverse();
  reordered.shapes.rows.reverse();
  reordered.projection.rows.reverse();
  refreshTexts(reordered);
  const actual = buildDmSdkBorrowedHandlePlan(reordered);
  assert.deepEqual(actual.decisions, expected.decisions);
  assert.deepEqual(actual.coverage, expected.coverage);
  assert.notEqual(actual.sourceHashes.ir, expected.sourceHashes.ir);
});

test("borrowed-handle plan validation rejects forged ownership and source identity", async () => {
  const inputs = await loadInputs();
  const plan = buildDmSdkBorrowedHandlePlan(inputs);
  const forged = structuredClone(plan);
  forged.decisions.find(({ fallback }) => !fallback).emitter = "scripts/forged-emitter.mjs";
  assert.throws(() => indexDmSdkBorrowedHandlePlan(forged), /owner differs/u);
  const reordered = structuredClone(plan);
  [reordered.decisions[0], reordered.decisions[1]] = [reordered.decisions[1], reordered.decisions[0]];
  assert.throws(() => indexDmSdkBorrowedHandlePlan(reordered), /not canonically ordered/u);
  const stale = structuredClone(plan);
  stale.sourceHashes.ir = "0".repeat(64);
  assert.throws(() => indexDmSdkBorrowedHandlePlan(stale, inputs), /strict source re-derivation/u);
});

test("the package eligibility recipe contains semantics, not Defold identities", () => {
  const recipe = JSON.stringify(DMSDK_BORROWED_HANDLE_ELIGIBILITY);
  assert.doesNotMatch(recipe, /@upstream|dmsdk:|dm[A-Z][A-Za-z]+::/u);
});
