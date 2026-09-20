import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FIXTURE_PROFILES,
  HEADLESS_RUNTIME_PROFILE,
  MAX_OPTIONAL_EXERCISES_PER_CONTRACT,
  SUPPLIED_CONTEXTS,
  UNSUPPLIED_CONTEXTS,
  buildHandleAlgebra,
  buildHeadlessConformancePlan,
  buildRouteAvailability,
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
    const requiredRouteIds = new Set(contract.exercises
      .filter((exercise) => exercise.arity === "required")
      .map((exercise) => exercise.routeId));
    const optionalExerciseCount = contract.exercises
      .filter((exercise) => exercise.arity !== "required" && requiredRouteIds.has(exercise.routeId))
      .length;
    assert.ok(optionalExerciseCount <= MAX_OPTIONAL_EXERCISES_PER_CONTRACT, contract.id);
    assert.ok(FIXTURE_PROFILES.some((profile) => profile.id === contract.profile), contract.id);
    // A destructive route is admitted only as a last resort, and then alone.
    if (contract.exercises.some((exercise) => exercise.destructive)) {
      assert.equal(contract.exercises.length, 1, contract.id);
      assert.equal(contract.executionPolicy, "destructive-last-resort", contract.id);
    }
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

test("string inhabitants are valid absolute Defold resource paths", () => {
  const resourceContract = plan.contracts.find((contract) =>
    contract.exercises?.some(({ routeId }) => routeId === "script:resource.load"));
  assert.ok(resourceContract);
  const exercise = resourceContract.exercises.find(({ routeId }) => routeId === "script:resource.load");
  assert.deepEqual(exercise.arguments, [{ kind: "literal", value: "/deherm_conformance" }]);
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
  const fixtures = plan.contracts.filter((contract) => contract.disposition === "fixture");
  const eligible = fixtures.flatMap((contract) => contract.exercises);
  assert.ok(eligible.length > 0);
  for (const exercise of eligible) {
    assert.ok(exercise.accessor.length >= 2, exercise.routeId);
    assert.ok(exercise.arguments.length >= exercise.minimumArgumentCount, exercise.routeId);
    assert.ok(exercise.maximumResultCount <= 1, exercise.routeId);
    // A synthesized argument is one of five shapes, and each is either data or
    // a construction the running engine performs: a literal inhabitant, an
    // explicit nil for an optional parameter a positional call has to pass
    // over, one of the profile's published component addresses, a handle from
    // a producer chain, a Defold value from the engine's own zero-argument
    // constructor, or a record of those.
    const assertArgument = (argument) => {
      assert.ok(["literal", "address", "handle", "value", "record"].includes(argument.kind), exercise.routeId);
      if (argument.kind === "literal") {
        assert.ok(argument.value === null || ["number", "boolean", "string"].includes(typeof argument.value),
          exercise.routeId);
      } else if (argument.kind === "value") {
        assert.ok(argument.accessor.length >= 2, exercise.routeId);
      } else if (argument.kind === "record") {
        assert.ok(typeof argument.recordType === "string" && argument.recordType.length > 0, exercise.routeId);
        for (const field of argument.fields) assertArgument(field.value);
      } else {
        assert.ok(Number.isInteger(argument.ordinal) && argument.ordinal >= 0, exercise.routeId);
      }
    };
    for (const argument of exercise.arguments) assertArgument(argument);
  }
  assert.deepEqual(plan.suppliedContexts, [...SUPPLIED_CONTEXTS]);
  assert.deepEqual(plan.unsuppliedContexts.map((entry) => entry.context), UNSUPPLIED_CONTEXTS.map((entry) => entry.context));
});

test("every handle argument names a provider the contract's profile can root", () => {
  const profileById = new Map(plan.fixtureProfiles.map((profile) => [profile.id, profile]));
  for (const contract of plan.contracts) {
    if (contract.disposition !== "fixture") continue;
    const rooted = new Set(profileById.get(contract.profile).handleProviders.map((provider) => provider.handleKind));
    const recorded = new Set(contract.handleProviders.map((provider) => provider.handleKind));
    for (const exercise of contract.exercises) {
      for (const argument of exercise.arguments) {
        if (argument.kind !== "handle") continue;
        assert.ok(rooted.has(argument.handleKind), `${contract.id}: ${argument.handleKind}`);
        assert.ok(recorded.has(argument.handleKind), `${contract.id}: ${argument.handleKind} is unrecorded`);
      }
    }
    // The recorded provenance is transitively closed.
    for (const provider of contract.handleProviders) {
      const chain = profileById.get(contract.profile).handleProviders
        .find((item) => item.handleKind === provider.handleKind);
      for (const argument of chain.arguments) {
        if (argument.kind === "handle") assert.ok(recorded.has(argument.handleKind), `${contract.id}: ${argument.handleKind}`);
      }
    }
  }
});

test("the plan never exercises a route the linked engine does not register", () => {
  const availability = buildRouteAvailability(documents.routeAvailability.value, HEADLESS_RUNTIME_PROFILE);
  assert.equal(plan.runtimeProfile, HEADLESS_RUNTIME_PROFILE);
  for (const contract of plan.contracts) {
    for (const exercise of contract.exercises ?? []) {
      if (!availability.catalog.has(exercise.routeId)) continue;
      assert.ok(availability.available.has(exercise.routeId), exercise.routeId);
    }
  }
});

test("a handle kind is rooted only by a profile whose physics backend owns it", () => {
  const algebra = buildHandleAlgebra(documents.borrowedHandles.value);
  const profileById = new Map(FIXTURE_PROFILES.map((profile) => [profile.id, profile]));
  for (const declared of plan.fixtureProfiles) {
    const profile = profileById.get(declared.id);
    for (const provider of declared.handleProviders) {
      const backend = algebra.backendByKind.get(provider.handleKind) ?? null;
      if (backend === null) continue;
      assert.equal(backend, profile.physicsBackendPath, `${declared.id}: ${provider.handleKind}`);
    }
  }
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

test("dedicated and compile-time bindings are not reported as missing adapters", () => {
  const irFunction = { modulePath: ["test"], jsName: "route", member: "route", parameters: [] };
  const conformanceCase = { execution: { policy: "safe" }, requiredContexts: ["engine"] };
  const baseUnit = {
    identity: { surface: "script", id: "script:test.route", stableId: 1 },
    abi: { state: "planned" },
    backends: { luaStack: { selection: "separate-module" } }
  };
  assert.equal(classifyRoute({
    unit: baseUnit,
    irFunction,
    universalBinding: null,
    scalarBinding: null,
    conformanceCase
  }).reason, "separate-module-adapter");
  assert.equal(classifyRoute({
    unit: { ...baseUnit, abi: { state: "compile-time-intrinsic" } },
    irFunction,
    universalBinding: null,
    scalarBinding: null,
    conformanceCase
  }).reason, "compile-time-intrinsic");
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
    if (result.outcome === "engine-fault" && "diagnostics" in result.engine) {
      assert.ok(Array.isArray(result.engine.diagnostics), result.id);
      assert.ok(result.engine.diagnostics.length <= 32, result.id);
      assert.equal(result.engine.diagnostics.some((line) => line.includes(root.pathname)), false, result.id);
    }
  }
});
