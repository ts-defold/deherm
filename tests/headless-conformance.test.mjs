import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_EXERCISES_PER_CONTRACT,
  SUPPLIED_CONTEXTS,
  buildHeadlessConformancePlan,
  classifyRoute,
  loadHeadlessConformanceInputs
} from "../scripts/lib/headless-conformance-plan.mjs";
import { harnessFiles } from "../scripts/generate-headless-conformance.mjs";

const root = new URL("../", import.meta.url);
const documents = await loadHeadlessConformanceInputs(root);
const plan = buildHeadlessConformancePlan(documents);

test("every script contract is accounted for exactly once", () => {
  const loweringPlan = documents.loweringPlan.value;
  const contractIndexes = new Set(loweringPlan.units
    .filter((unit) => unit.identity.surface === "script")
    .map((unit) => unit.contractDetails));
  assert.equal(plan.contractCount, contractIndexes.size);
  assert.equal(plan.contracts.length, plan.contractCount);
  assert.equal(new Set(plan.contracts.map(({ id }) => id)).size, plan.contractCount);
  for (const contract of plan.contracts) {
    assert.ok(contractIndexes.has(contract.contractIndex), contract.id);
  }
  const routeTotal = plan.contracts.reduce((total, contract) => total + contract.routeCount, 0);
  assert.equal(routeTotal, loweringPlan.units.filter((unit) => unit.identity.surface === "script").length);
});

test("a contract without a fixture fails closed with machine-readable blockers", () => {
  for (const contract of plan.contracts) {
    assert.ok(["fixture", "unreachable"].includes(contract.disposition), contract.id);
    if (contract.disposition === "unreachable") {
      assert.ok(contract.blockers.length > 0, `${contract.id} is unreachable with no blocker`);
      assert.equal(contract.exercises, undefined);
      const blocked = contract.blockers.reduce((total, blocker) => total + blocker.routeCount, 0);
      assert.equal(blocked, contract.routeCount, contract.id);
      for (const blocker of contract.blockers) {
        assert.match(blocker.reason, /^[a-z0-9-]+(:.+)?$/, `${contract.id}: ${blocker.reason}`);
        assert.ok(blocker.exampleRouteId.startsWith("script:"), contract.id);
      }
      continue;
    }
    assert.ok(contract.exercises.length > 0, contract.id);
    assert.ok(contract.exercises.length <= MAX_EXERCISES_PER_CONTRACT, contract.id);
    assert.equal(contract.collection, `/conformance/${contract.id}.collectionc`);
    assert.equal(
      contract.eligibleRouteCount + contract.blockers.reduce((total, item) => total + item.routeCount, 0),
      contract.routeCount,
      contract.id
    );
  }
  assert.equal(
    plan.reachableContractCount + plan.unreachableContractCount,
    plan.contractCount
  );
});

test("properties are selected by the contract record, never by route identity", () => {
  const contracts = documents.loweringPlan.value.tables.contracts;
  for (const contract of plan.contracts) {
    const record = contracts[contract.contractIndex];
    assert.ok(contract.properties.includes("result-arity"), contract.id);
    assert.equal(
      contract.properties.includes("scratch-reuse"),
      record.scratch?.token === "caller-owned-bounded-reentrant-scratch",
      contract.id
    );
    assert.equal(
      contract.properties.includes("error-model"),
      record.errorModel?.token === "status-return-and-target-exception",
      contract.id
    );
  }
});

test("a fixture only ever calls a route from a context the harness supplies", () => {
  const eligible = plan.contracts
    .filter((contract) => contract.disposition === "fixture")
    .flatMap((contract) => contract.exercises);
  assert.ok(eligible.length > 0);
  for (const exercise of eligible) {
    assert.ok(exercise.accessor.length >= 2, exercise.routeId);
    assert.ok(exercise.arguments.length >= exercise.minimumArgumentCount, exercise.routeId);
    assert.ok(exercise.maximumResultCount <= 1, exercise.routeId);
    for (const argument of exercise.arguments) {
      assert.ok(["number", "boolean", "string"].includes(typeof argument), exercise.routeId);
    }
  }
  assert.deepEqual(plan.suppliedContexts, [...SUPPLIED_CONTEXTS]);
});

test("route classification rejects an unsupplied context and an unsynthesizable parameter", () => {
  const unit = {
    identity: { surface: "script", id: "script:test.route", stableId: 1 },
    backends: { luaStack: { selection: "emit" } }
  };
  const universalBinding = {
    minimumArgumentCount: 1,
    maximumArgumentCount: 1,
    minimumResultCount: 0,
    maximumResultCount: 1,
    variadic: false,
    loweringFamily: "scalar"
  };
  const renderOnly = classifyRoute({
    unit,
    irFunction: { modulePath: ["test"], jsName: "route", member: "route", parameters: [{ rawType: "number" }] },
    universalBinding,
    scalarBinding: null,
    conformanceCase: { execution: { policy: "safe" }, requiredContexts: ["render-script"] }
  });
  assert.equal(renderOnly.eligible, false);
  assert.equal(renderOnly.reason, "context-fixture-missing:render-script");

  const opaqueParameter = classifyRoute({
    unit,
    irFunction: { modulePath: ["test"], jsName: "route", member: "route", parameters: [{ rawType: "b2Body" }] },
    universalBinding,
    scalarBinding: null,
    conformanceCase: { execution: { policy: "safe" }, requiredContexts: ["engine"] }
  });
  assert.equal(opaqueParameter.eligible, false);
  assert.equal(opaqueParameter.reason, "unsynthesizable-parameter-type:b2Body");

  const destructive = classifyRoute({
    unit,
    irFunction: { modulePath: ["test"], jsName: "route", member: "route", parameters: [] },
    universalBinding: { ...universalBinding, minimumArgumentCount: 0 },
    scalarBinding: null,
    conformanceCase: { execution: { policy: "destructive" }, requiredContexts: ["engine"] }
  });
  assert.equal(destructive.eligible, false);
  assert.equal(destructive.reason, "execution-policy-destructive");
});

test("the generated harness emits one collection, game object and script per reachable contract", () => {
  const { typescript, content, fixtures } = harnessFiles(plan);
  assert.equal(fixtures.length, plan.reachableContractCount);
  for (const fixture of fixtures) {
    for (const extension of ["collection", "go", "script", "collectionproxy"]) {
      assert.ok(content.has(`conformance/${fixture.id}.${extension}`), `${fixture.id}.${extension}`);
    }
    assert.ok(typescript.has(`contracts/${fixture.id}.ts`), fixture.id);
    const module = typescript.get(`contracts/${fixture.id}.ts`);
    for (const exercise of fixture.exercises) {
      assert.ok(module.includes(JSON.stringify(exercise.routeId)), `${fixture.id}: ${exercise.routeId}`);
      assert.ok(module.includes(`call: ${exercise.accessor.join(".")} as unknown`), exercise.routeId);
    }
  }
  // The index collection proxies every fixture so Bob compiles each one
  // without instantiating any of them.
  const index = content.get("conformance/index.go");
  for (const fixture of fixtures) {
    assert.ok(index.includes(`/conformance/${fixture.id}.collectionproxy`), fixture.id);
  }
  assert.ok(content.get("game.project").includes("main_collection = /conformance/index.collectionc"));
});

test("the committed plan matches the generator", async () => {
  const committed = await readFile(
    new URL("packages/bindings/generated/defold-headless-conformance-plan.json", root),
    "utf8"
  );
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  assert.equal(
    digest(committed),
    digest(`${JSON.stringify(plan, null, 2)}\n`),
    "packages/bindings/generated/defold-headless-conformance-plan.json is stale; run pnpm generate:headless-conformance"
  );
});

test("a recorded runtime report never claims more than the plan permits", async () => {
  let report;
  try {
    report = JSON.parse(await readFile(
      new URL("packages/bindings/generated/defold-headless-conformance-report.json", root),
      "utf8"
    ));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.equal(report.evidenceStage, "runtime");
  assert.equal(report.contractCount, plan.contractCount);
  const planById = new Map(plan.contracts.map((contract) => [contract.id, contract]));
  for (const result of report.contracts) {
    const planned = planById.get(result.id);
    assert.ok(planned, result.id);
    assert.ok(
      ["observed", "mismatched", "engine-fault", "blocked", "unreachable"].includes(result.outcome),
      `${result.id}: ${result.outcome}`
    );
    if (planned.disposition === "unreachable") {
      assert.equal(result.outcome, "unreachable", `${result.id} claims runtime evidence without a fixture`);
      continue;
    }
    assert.notEqual(result.outcome, "unreachable", result.id);
    if (result.outcome === "observed") {
      assert.equal(result.engine.disposition, "exited", result.id);
      assert.equal(result.engine.exitCode, 0, result.id);
      assert.equal(result.mismatchedPropertyCount, 0, result.id);
      assert.ok(result.observedPropertyCount > 0, result.id);
    }
  }
});
