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
  effectFacts: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
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
    effectFacts: JSON.parse(texts.effectFacts),
  };
}

function refreshTexts(inputs) {
  inputs.texts = {
    ir: `${JSON.stringify(inputs.ir)}\n`,
    shapes: `${JSON.stringify(inputs.shapes)}\n`,
    projection: `${JSON.stringify(inputs.projection)}\n`,
    policy: `${JSON.stringify(inputs.policy)}\n`,
    effectFacts: `${JSON.stringify(inputs.effectFacts)}\n`,
  };
  const digest = createHash("sha256").update(inputs.texts.ir).digest("hex");
  inputs.shapes.sourceHashes.ir = digest;
  inputs.projection.sources.hashes.ir = digest;
  inputs.effectFacts.inputs.ir = digest;
  inputs.effectFacts.inputs.shapes = createHash("sha256").update(inputs.texts.shapes).digest("hex");
  inputs.effectFacts.inputs.policy = createHash("sha256").update(inputs.texts.policy).digest("hex");
  inputs.texts.shapes = `${JSON.stringify(inputs.shapes)}\n`;
  inputs.texts.projection = `${JSON.stringify(inputs.projection)}\n`;
  inputs.effectFacts.inputs.shapes = createHash("sha256").update(inputs.texts.shapes).digest("hex");
  inputs.texts.effectFacts = `${JSON.stringify(inputs.effectFacts)}\n`;
  return inputs;
}

function decisionByLeaf(plan, leaf) {
  return plan.decisions.find(({ declarationId }) => declarationId.startsWith(`dmsdk:${leaf}@`));
}

test("global handle planning selects borrowed and lifecycle routes without losing universal coverage", async () => {
  const inputs = await loadInputs();
  const committed = JSON.parse(await readFile(planUrl, "utf8"));
  const index = indexDmSdkBorrowedHandlePlan(committed, inputs);
  assert.equal(index.size, committed.coverage.structurallyRelevant);
  assert.equal(committed.coverage.structurallyRelevant, 182);
  assert.equal(committed.coverage.selected, 182);
  assert.equal(committed.coverage.universalFallback, 0);
  assert.equal(committed.coverage.borrowedSelected, 148);
  assert.equal(committed.coverage.lifecycleSelected, 34);
  assert.equal(committed.coverage.sourceDerived, 74);
  assert.equal(committed.coverage.defoldContractTrusted, 74);
  assert.equal(committed.coverage.revisionDerivedLifecycle, 34);
  assert.equal(committed.providerAbiVersion, 3);
  assert.match(committed.abi.reason, /lifecycle effect vectors/u);
  assert.equal(decisionByLeaf(committed, "dmGraphics::GetWindowWidth").fallback, false);
  assert.equal(
    decisionByLeaf(committed, "dmGraphics::GetWindowWidth").effect.admission.kind,
    "defold-contract-trusted",
  );
  assert.equal(decisionByLeaf(committed, "dmImage::GetWidth").effect.admission.kind, "source-derived");
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
    assert.equal(decisionByLeaf(committed, leaf).fallback, false, leaf);
  assert.deepEqual(
    committed.decisions.filter(({ fallback }) => !fallback).map(({ order }) => order),
    Array.from({ length: committed.coverage.selected }, (_, index) => index),
  );
});

test("supported lifecycle semantics select the lifecycle family while escaping effects still fail closed", async () => {
  const base = await loadInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(base);
  const selected = baseline.decisions.find(
    ({ fallback, effect }) =>
      !fallback && effect.admission.kind === "source-derived" && effect.taxonomy.resourceArguments.length === 1,
  );
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
      expectedFamily: "borrowed-handle",
    },
    {
      label: "retained handle",
      name: "ObserveHandle",
      description: "Retains the shared reference.",
      effect: "borrowed-or-transferred-requires-token",
      expectedFamily: "handle-lifecycle",
    },
    {
      label: "transferred handle",
      name: "SubmitHandle",
      description: "Takes ownership of the handle.",
      effect: "borrowed-or-transferred-requires-token",
      fallback: true,
    },
    {
      label: "async handle",
      name: "ScheduleHandle",
      description: "The handle is stored for later asynchronous use.",
      effect: "borrowed-or-transferred-requires-token",
      fallback: true,
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
    assert.equal(decision.fallback, fixture.fallback ?? false, fixture.label);
    if (fixture.fallback) {
      assert.ok(decision.blockers.length > 0, fixture.label);
      assert.equal(decision.effect.admission.kind, "revision-contradiction", fixture.label);
    } else {
      assert.equal(decision.family, fixture.expectedFamily ?? "handle-lifecycle", fixture.label);
      assert.equal(decision.blockers.length, 0, fixture.label);
    }
    assert.ok(decision.effect.signals.length > 0, fixture.label);
  }
});

test("lifecycle inference targets exact resource positions instead of every handle in the signature", async () => {
  const plan = buildDmSdkBorrowedHandlePlan(await loadInputs());
  const effects = (leaf) => decisionByLeaf(plan, leaf).effect.taxonomy;
  const expected = new Map([
    ["dmBuffer::Destroy", [[[0, "finalize"]], []]],
    ["dmConditionVariable::Delete", [[[0, "finalize"]], []]],
    ["dmConnectionPool::Return", [[[0, "borrow"], [1, "release"]], []]],
    ["dmConnectionPool::Close", [[[0, "borrow"], [1, "release"]], ["connection-closed", "pool-slot-invalidated"]]],
    ["dmImage::DeleteImage", [[[0, "finalize"]], []]],
    ["JobSystemDestroy", [[[0, "finalize"]], []]],
    ["dmMutex::Delete", [[[0, "finalize"]], []]],
    ["FontDestroy", [[[0, "finalize"]], []]],
    ["FontCollectionDestroy", [[[0, "finalize"]], []]],
    ["TextLayoutAcquire", [[[0, "retain"]], []]],
    ["TextLayoutRelease", [[[0, "release"]], []]],
    ["dmGameObject::Delete", [[[0, "borrow"], [1, "finalize"]], []]],
    ["dmGameObject::DeleteBones", [[[0, "borrow"]], ["descendant-finalize"]]],
    ["dmGameObject::PropertyContainerDestroy", [[[0, "finalize"]], []]],
    ["dmGameSystem::DestroyRenderConstants", [[[0, "finalize"]], []]],
    ["dmGraphics::DeleteVertexStreamDeclaration", [[[0, "finalize"]], []]],
    ["dmGraphics::DeleteVertexDeclaration", [[[0, "finalize"]], []]],
    ["dmGraphics::DeleteVertexBuffer", [[[0, "finalize"]], []]],
    ["dmGraphics::DeleteIndexBuffer", [[[0, "finalize"]], []]],
    ["dmGraphics::DeleteTexture", [[[0, "borrow"], [1, "finalize"]], []]],
    ["dmGraphics::DeleteRenderTarget", [[[0, "borrow"], [1, "finalize"]], []]],
    ["dmGraphics::DeleteContext", [[[0, "finalize"]], ["owned-descendants-finalized"]]],
    ["dmGraphics::CloseWindow", [[[0, "borrow"]], ["associated-window-closed"]]],
    ["dmGraphics::DeleteProgram", [[[0, "borrow"], [1, "finalize"]], ["owned-descendants-finalized"]]],
    ["dmGui::DeleteNode", [[[0, "borrow"], [1, "finalize"]], []]],
    ["WindowDelete", [[[0, "finalize"]], []]],
    ["WindowClose", [[[0, "borrow"]], ["associated-window-closed"]]],
    ["dmRender::DeleteConstant", [[[0, "finalize"]], []]],
    ["dmRender::DeleteNamedConstantBuffer", [[[0, "finalize"]], []]],
    ["dmRender::DeleteMaterial", [[[0, "borrow"], [1, "finalize"]], []]],
    ["ResourceDescriptorIncRef", [[[0, "borrow"], [1, "retain"]], []]],
    ["dmResource::IncRef", [[[0, "borrow"], [1, "retain"]], []]],
    ["dmResource::FreeResourceType", [[[0, "borrow"], [1, "finalize"]], []]],
    ["dmRig::DeleteContext", [[[0, "finalize"]], []]],
  ]);
  const actualLeaves = plan.decisions
    .filter(({ family }) => family === "handle-lifecycle")
    .map(({ declarationId }) => declarationId.slice("dmsdk:".length).split("@")[0]);
  assert.deepEqual(actualLeaves.sort(), [...expected.keys()].sort());
  for (const [leaf, [resourceArguments, nonLocalEffects]] of expected) {
    assert.deepEqual(
      effects(leaf),
      {
        resourceArguments: resourceArguments.map(([position, effect]) => ({ position, effect })),
        result: "none",
        completion: "synchronous-noescape",
        nonLocalEffects,
      },
      leaf,
    );
  }
  assert.deepEqual(effects("dmGameObject::AcquireInstanceIndex"), {
    resourceArguments: [{ position: 0, effect: "borrow" }],
    result: "none",
    completion: "synchronous-noescape",
    nonLocalEffects: [],
  });
});

test("withdrawing source proof preserves the Defold-contract route without inventing source proof", async () => {
  const inputs = await loadInputs();
  const baseline = buildDmSdkBorrowedHandlePlan(inputs);
  const selected = baseline.decisions.find(
    ({ fallback, effect }) => !fallback && effect.admission.kind === "source-derived",
  );
  assert.ok(selected, "fixture contains a source-derived borrowed route");
  const effect = inputs.effectFacts.functions.find(({ declarationId }) => declarationId === selected.declarationId);
  assert.equal(effect.state, "observed");
  effect.state = "unknown";
  effect.fact = null;
  effect.diagnostics = ["fixture-source-proof-withdrawn"];
  inputs.effectFacts.coverage.observed -= 1;
  inputs.effectFacts.coverage.unknown += 1;
  inputs.effectFacts.coverage.envelopes["borrowed-handle"].observed -= 1;
  inputs.effectFacts.coverage.envelopes["borrowed-handle"].unknown += 1;
  refreshTexts(inputs);
  const decision = buildDmSdkBorrowedHandlePlan(inputs).decisions.find(
    ({ declarationId }) => declarationId === selected.declarationId,
  );
  assert.equal(decision.fallback, false);
  assert.equal(decision.effect.admission.kind, "defold-contract-trusted");
  assert.deepEqual(decision.effect.sourceProof.evidenceGaps, ["cpp-effect:fixture-source-proof-withdrawn"]);
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
  assert.throws(
    () => indexDmSdkBorrowedHandlePlan(reordered),
    /not canonically ordered|selected order is not dense/u,
  );
  const stale = structuredClone(plan);
  stale.sourceHashes.ir = "0".repeat(64);
  assert.throws(() => indexDmSdkBorrowedHandlePlan(stale, inputs), /strict source re-derivation/u);
});

test("the package eligibility recipe contains semantics, not Defold identities", () => {
  const recipe = JSON.stringify(DMSDK_BORROWED_HANDLE_ELIGIBILITY);
  assert.doesNotMatch(recipe, /@upstream|dmsdk:|dm[A-Z][A-Za-z]+::/u);
  assert.equal(
    DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.contradictionPolicy,
    "positive-defold-revision-contradiction-dominates",
  );
});
