// Contract-level headless conformance planning.
//
// The canonical lowering plan interns 926 script routes down to 82 distinct
// script contracts. Conformance is therefore planned per contract, never per
// route: a contract exercised against the real engine is the tractable unit,
// and route-level scenario authoring is not.
//
// Everything here is derived from the pinned generated IR. There is no route
// allowlist and no per-contract special case: a route becomes a fixture only
// when every predicate below holds structurally, and a contract with no
// eligible route is recorded as an explicit machine-readable blocker rather
// than being skipped.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildConformancePlan, loadConformanceInputs } from "../../packages/cli/src/conformance.mjs";
import { publicScriptRootName } from "../../packages/compiler/src/script-public-api-policy.mjs";

export const HEADLESS_CONFORMANCE_SCHEMA_VERSION = 1;

/** Contexts this harness can supply from a headless engine with a game-object script instance. */
export const SUPPLIED_CONTEXTS = Object.freeze(["engine", "game-object"]);

/** Deterministic inhabitants for the parameter types the harness can synthesize. */
const SCALAR_INHABITANTS = Object.freeze({
  number: 0,
  integer: 0,
  boolean: false,
  string: "deherm_conformance"
});

/** Most routes carrying one contract are redundant evidence; exercise a bounded sample. */
export const MAX_EXERCISES_PER_CONTRACT = 4;

/** Repetitions used by the bounded-scratch property. */
export const SCRATCH_REUSE_REPETITIONS = 64;

const SCRATCH_CONTRACT_TOKEN = "caller-owned-bounded-reentrant-scratch";
const ERROR_MODEL_CONTRACT_TOKEN = "status-return-and-target-exception";

// Structural effect guard beyond the shared conformance execution policy. A
// conformance fixture may not persist state outside the engine instance it
// runs in, because the driver reuses one process for every case.
const EXTERNAL_WRITE_LEAF = /^(write|dump)/;

const INPUT_PATHS = Object.freeze({
  loweringPlan: "packages/bindings/generated/defold-binding-lowering-plan.json",
  scriptIr: "packages/bindings/generated/defold-script-api-ir.json",
  universalValueBindings: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  scalarDispatch: "packages/bindings/generated/defold-script-scalar-dispatch.json"
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function synthesizeArgument(rawType) {
  if (typeof rawType !== "string" || rawType.length === 0) return { ok: false, reason: "untyped-parameter" };
  if (Object.hasOwn(SCALAR_INHABITANTS, rawType)) return { ok: true, value: SCALAR_INHABITANTS[rawType] };
  // A union whose inhabitants include a synthesizable scalar is satisfied by
  // that inhabitant. This is a shape rule, not a symbol allowlist.
  const members = rawType.split("|").map((member) => member.trim());
  if (members.length > 1) {
    for (const key of Object.keys(SCALAR_INHABITANTS)) {
      if (members.includes(key)) return { ok: true, value: SCALAR_INHABITANTS[key] };
    }
  }
  return { ok: false, reason: `unsynthesizable-parameter-type:${rawType}` };
}

function accessorPath(irFunction) {
  const [root, ...nested] = irFunction.modulePath;
  return [publicScriptRootName(root), ...nested, irFunction.jsName];
}

function contractSlug(index) {
  return `contract_${String(index).padStart(4, "0")}`;
}

/**
 * Decide whether one route can act as a real-engine fixture for its contract.
 * Returns either `{ eligible: true, exercise }` or `{ eligible: false, reason }`
 * where `reason` is a stable machine-readable token.
 */
export function classifyRoute({ unit, irFunction, universalBinding, scalarBinding, conformanceCase }) {
  if (!irFunction) return { eligible: false, reason: "absent-from-script-projection" };
  if (!universalBinding) return { eligible: false, reason: "no-generated-universal-adapter" };
  if (unit.backends.luaStack.selection !== "emit") {
    return { eligible: false, reason: `lua-stack-${unit.backends.luaStack.selection}` };
  }
  if (!conformanceCase) return { eligible: false, reason: "absent-from-conformance-plan" };
  if (conformanceCase.execution.policy !== "safe") {
    return { eligible: false, reason: `execution-policy-${conformanceCase.execution.policy}` };
  }
  const contexts = conformanceCase.requiredContexts ?? [];
  if (!contexts.some((context) => SUPPLIED_CONTEXTS.includes(context))) {
    return { eligible: false, reason: `context-fixture-missing:${contexts.join("|") || "unknown"}` };
  }
  const leaf = String(irFunction.member ?? "");
  if (EXTERNAL_WRITE_LEAF.test(leaf)) {
    return { eligible: false, reason: `harness-effect-guard:${leaf}` };
  }
  if (universalBinding.variadic) {
    return { eligible: false, reason: "variadic-argument-shape-unmodelled" };
  }
  if (universalBinding.maximumResultCount > 1) {
    return { eligible: false, reason: "multi-result-shape-unmodelled" };
  }
  const args = [];
  for (const parameter of irFunction.parameters ?? []) {
    if (parameter.optional) continue;
    const synthesized = synthesizeArgument(parameter.rawType);
    if (!synthesized.ok) return { eligible: false, reason: synthesized.reason };
    args.push(synthesized.value);
  }
  if (args.length < universalBinding.minimumArgumentCount) {
    return { eligible: false, reason: "argument-arity-disagrees-with-projection" };
  }
  return {
    eligible: true,
    exercise: {
      routeId: unit.identity.id,
      stableId: unit.identity.stableId,
      accessor: accessorPath(irFunction),
      arguments: args,
      minimumArgumentCount: universalBinding.minimumArgumentCount,
      maximumArgumentCount: universalBinding.maximumArgumentCount,
      minimumResultCount: universalBinding.minimumResultCount,
      maximumResultCount: universalBinding.maximumResultCount,
      loweringFamily: universalBinding.loweringFamily,
      resultCodec: scalarBinding ? scalarBinding.result.codec : null,
      resultNullable: scalarBinding ? Boolean(scalarBinding.result.nullable) : null
    }
  };
}

function propertiesForContract(contractRecord) {
  const properties = ["result-arity"];
  if (contractRecord.scratch?.token === SCRATCH_CONTRACT_TOKEN) properties.push("scratch-reuse");
  if (contractRecord.errorModel?.token === ERROR_MODEL_CONTRACT_TOKEN) properties.push("error-model");
  return properties;
}

export async function loadHeadlessConformanceInputs(root) {
  const entries = await Promise.all(Object.entries(INPUT_PATHS).map(async ([name, relative]) => {
    const text = await readFile(new URL(relative, root), "utf8");
    return [name, { text, value: JSON.parse(text), path: relative, sha256: sha256(text) }];
  }));
  const documents = Object.fromEntries(entries);
  documents.conformance = await loadConformanceInputs();
  return documents;
}

export function buildHeadlessConformancePlan(documents, { target = "arm64-macos" } = {}) {
  const loweringPlan = documents.loweringPlan.value;
  if (loweringPlan.schemaVersion !== 2) {
    throw new Error(`Headless conformance requires canonical lowering-plan schema v2, got ${loweringPlan.schemaVersion}`);
  }
  const conformancePlan = buildConformancePlan(documents.conformance, { target, contexts: ["*"], shard: "0/1" });
  const conformanceById = new Map(conformancePlan.cases.map((item) => [item.id, item]));
  const irById = new Map(documents.scriptIr.value.functions.map((item) => [item.id, item]));
  const universalById = new Map(documents.universalValueBindings.value.bindings.map((item) => [item.id, item]));
  const scalarById = new Map(documents.scalarDispatch.value.bindings.map((item) => [item.id, item]));

  const byContract = new Map();
  for (const unit of loweringPlan.units) {
    if (unit.identity.surface !== "script") continue;
    const index = unit.contractDetails;
    if (!byContract.has(index)) byContract.set(index, []);
    byContract.get(index).push(unit);
  }

  const contracts = [];
  for (const index of [...byContract.keys()].sort((left, right) => left - right)) {
    const units = byContract.get(index).slice().sort((left, right) =>
      left.identity.id < right.identity.id ? -1 : left.identity.id > right.identity.id ? 1 : 0);
    const contractRecord = loweringPlan.tables.contracts[index];
    const eligible = [];
    const blockerCounts = new Map();
    const blockerExamples = new Map();
    for (const unit of units) {
      const decision = classifyRoute({
        unit,
        irFunction: irById.get(unit.identity.id),
        universalBinding: universalById.get(unit.identity.id),
        scalarBinding: scalarById.get(unit.identity.id),
        conformanceCase: conformanceById.get(unit.identity.id)
      });
      if (decision.eligible) {
        eligible.push(decision.exercise);
        continue;
      }
      blockerCounts.set(decision.reason, (blockerCounts.get(decision.reason) ?? 0) + 1);
      if (!blockerExamples.has(decision.reason)) blockerExamples.set(decision.reason, unit.identity.id);
    }

    const blockers = [...blockerCounts.entries()]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .map(([reason, routeCount]) => ({ reason, routeCount, exampleRouteId: blockerExamples.get(reason) }));

    const properties = propertiesForContract(contractRecord);
    const slug = contractSlug(index);
    const record = {
      contractIndex: index,
      id: slug,
      routeCount: units.length,
      eligibleRouteCount: eligible.length,
      contract: {
        context: contractRecord.context?.kind ?? null,
        ownershipResult: contractRecord.ownership?.result ?? null,
        lifetime: contractRecord.lifetime?.result ?? null,
        thread: contractRecord.thread?.call ?? null,
        callbackPresent: Boolean(contractRecord.callback?.present),
        invalidation: contractRecord.invalidation?.token ?? null,
        errorModel: contractRecord.errorModel?.token ?? null,
        scratch: contractRecord.scratch?.token ?? null
      },
      properties,
      disposition: eligible.length > 0 ? "fixture" : "unreachable",
      blockers
    };
    if (eligible.length > 0) {
      record.collection = `/conformance/${slug}.collectionc`;
      record.exercises = eligible.slice(0, MAX_EXERCISES_PER_CONTRACT);
    }
    contracts.push(record);
  }

  const reachable = contracts.filter((item) => item.disposition === "fixture");
  return {
    schemaVersion: HEADLESS_CONFORMANCE_SCHEMA_VERSION,
    defoldRevision: loweringPlan.defoldRevision,
    target,
    variant: "headless",
    evidenceBoundary:
      "Runtime evidence only. A fixture disposition states that the harness can reach the contract " +
      "from a headless engine instance; it never promotes generation, compilation or linkage evidence, " +
      "and it makes no claim for a contract this plan records as unreachable.",
    suppliedContexts: [...SUPPLIED_CONTEXTS],
    scratchReuseRepetitions: SCRATCH_REUSE_REPETITIONS,
    maxExercisesPerContract: MAX_EXERCISES_PER_CONTRACT,
    inputs: Object.fromEntries(Object.entries(INPUT_PATHS).map(([name, relative]) => [
      relative,
      documents[name].sha256
    ])),
    contractCount: contracts.length,
    reachableContractCount: reachable.length,
    unreachableContractCount: contracts.length - reachable.length,
    exercisedRouteCount: reachable.reduce((total, item) => total + item.exercises.length, 0),
    eligibleRouteCount: contracts.reduce((total, item) => total + item.eligibleRouteCount, 0),
    blockerSummary: summarizeBlockers(contracts),
    contracts
  };
}

function summarizeBlockers(contracts) {
  const counts = new Map();
  for (const contract of contracts) {
    if (contract.disposition !== "unreachable") continue;
    for (const blocker of contract.blockers) {
      const family = blocker.reason.split(":")[0];
      if (!counts.has(family)) counts.set(family, { contractCount: 0, routeCount: 0 });
      counts.get(family).routeCount += blocker.routeCount;
    }
    const families = new Set(contract.blockers.map((blocker) => blocker.reason.split(":")[0]));
    for (const family of families) counts.get(family).contractCount += 1;
  }
  return [...counts.entries()]
    .sort((left, right) => right[1].contractCount - left[1].contractCount || (left[0] < right[0] ? -1 : 1))
    .map(([family, value]) => ({ family, ...value }));
}
