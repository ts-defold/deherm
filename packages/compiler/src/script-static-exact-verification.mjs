import { createHash } from "node:crypto";

import { renderShapeSpec, shapeCodes } from "./script-recording-engine.mjs";

const STATIC_TARGET = "static-hermes";
const STATIC_LANE = "static-hermes-typed-native";
const IMPLEMENTED_FAMILIES = Object.freeze([
  "script-constant",
  "defold-value",
  "scalar",
  "lua-table",
  "dynamic-values",
  "multi-result",
  "overload-dispatch",
  "callback-lifecycle",
  "borrowed-handle",
]);
const IMPLEMENTED_FAMILY_SET = new Set(IMPLEMENTED_FAMILIES);
const SUPPORTED_RELEASE_EXPECTATION = "no-retained-result-release";
const STATIC_TABLE_ENTRY_CAPACITY = 256;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactUnsigned64(seed) {
  return (BigInt((seed + 0x10000) >>> 0) << 32n) | BigInt(seed >>> 0);
}

function childSentinel(seed, index) {
  return ((seed * 17 + index + 1) % 10000) + 1;
}

export function planStaticScriptExactValue(recording, shapeIndex, seed, ancestors = new Set()) {
  const shape = recording.shapes[shapeIndex];
  assert(shape, `Static Hermes exact vector references missing shape ${shapeIndex}`);
  assert(!ancestors.has(shapeIndex), `Static Hermes exact shape ${shapeIndex} is cyclic`);
  const specification = () => renderShapeSpec(
    recording.shapes, shapeIndex, recording.semanticHandleKindNames, seed);
  switch (shape.code) {
    case shapeCodes.undefined: return { kind: "undefined", specification: specification() };
    case shapeCodes.null: return { kind: "null", specification: specification() };
    case shapeCodes.boolean: return { kind: "boolean", value: seed % 2 !== 0, specification: specification() };
    case shapeCodes.number: return { kind: "number", value: seed, specification: specification() };
    case shapeCodes.string: return { kind: "string", value: `d${seed}`, specification: specification() };
    case shapeCodes.hash: {
      const value = exactUnsigned64(seed);
      return {
        kind: "hash", low: Number(value & UINT32_MAX), high: Number(value >> 32n), specification: specification()
      };
    }
    case shapeCodes.guiNode:
      // The reviewed GUI structured family uses a bounded synthetic registry
      // token for exact-call verification.  Its slot is fixed and its ordinal
      // is derived from the generated seed ledger, so this vector cannot
      // accidentally claim arbitrary retained-handle ownership.
      return {
        kind: "gui-node",
        semantic: shape.aux,
        runtime: 1,
        low: 1,
        high: recording.handleSeeds.length + 1,
        specification: specification()
      };
    case shapeCodes.url: {
      const lanes = Array.from({ length: 4 }, (_, lane) => exactUnsigned64(seed + lane));
      return {
        kind: "url",
        halves: lanes.flatMap((value) => [Number(value & UINT32_MAX), Number(value >> 32n)]),
        specification: specification()
      };
    }
    case shapeCodes.vector3:
      return { kind: "vector3", lanes: [seed, seed + 1, seed + 2], specification: specification() };
    case shapeCodes.vector4:
      return { kind: "vector4", lanes: [seed, seed + 1, seed + 2, seed + 3], specification: specification() };
    case shapeCodes.quaternion:
      return { kind: "quaternion", lanes: [seed, seed + 1, seed + 2, seed + 3], specification: specification() };
    case shapeCodes.matrix4:
      return {
        kind: "matrix4", lanes: Array.from({ length: 16 }, (_, lane) => seed + lane), specification: specification()
      };
    case shapeCodes.sequence: {
      const nested = new Set(ancestors).add(shapeIndex);
      return {
        kind: "sequence",
        values: shape.children.map((child, index) =>
          planStaticScriptExactValue(recording, child, childSentinel(seed, index), nested)),
        specification: specification()
      };
    }
    case shapeCodes.record: {
      const nested = new Set(ancestors).add(shapeIndex);
      return {
        kind: "record",
        fields: shape.children.map((child, index) => ({
          key: recording.shapes[child].keyText,
          value: planStaticScriptExactValue(recording, child, childSentinel(seed, index), nested)
        })),
        specification: specification()
      };
    }
    case shapeCodes.map: {
      assert(shape.children.length === 2,
        `Static Hermes exact map shape ${shapeIndex} must have one key and one value shape`);
      const nested = new Set(ancestors).add(shapeIndex);
      return {
        kind: "map",
        key: planStaticScriptExactValue(recording, shape.children[0], childSentinel(seed, 0), nested),
        value: planStaticScriptExactValue(recording, shape.children[1], childSentinel(seed, 1), nested),
        specification: specification()
      };
    }
    default:
      throw new Error(`Static Hermes exact vector cannot plan shape code ${shape.code}`);
  }
}

export function canonicalStaticScriptExactValue(recording, shapeIndex, seed) {
  return planStaticScriptExactValue(recording, shapeIndex, seed).specification;
}

const UINT32_MAX = 0xffffffffn;

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tableEntryCount(plan) {
  if (plan.kind === "sequence") {
    return plan.values.length + plan.values.reduce((sum, value) => sum + tableEntryCount(value), 0);
  }
  if (plan.kind === "record") {
    return plan.fields.length + plan.fields.reduce((sum, field) => sum + tableEntryCount(field.value), 0);
  }
  if (plan.kind === "map") return 1 + tableEntryCount(plan.key) + tableEntryCount(plan.value);
  return 0;
}

function shapeContains(recording, shapeIndex, code, ancestors = new Set()) {
  if (ancestors.has(shapeIndex)) return false;
  const shape = recording.shapes[shapeIndex];
  assert(shape, `Static Hermes exact vector references missing shape ${shapeIndex}`);
  if (shape.code === code) return true;
  const nested = new Set(ancestors).add(shapeIndex);
  return shape.children.some((child) => shapeContains(recording, child, code, nested));
}

// A callback-bearing Static route is emitted only when every callback is an
// optional input.  Its exact Static vector therefore calls the same route at
// its declared minimum arity, omitting all optional tail arguments.  Keep the
// decision structural: a callback that appears in a required prefix is a
// generator defect, not a reason to manufacture a callable frame value.
export function staticExactArgumentShapes(recording, route) {
  const callbackSlots = route.argumentShapes.flatMap((shape, slot) =>
    shapeContains(recording, shape, shapeCodes.callback) ? [slot] : []);
  if (callbackSlots.length === 0) return route.argumentShapes;
  const minimum = route.arity?.minimum;
  assert(Number.isInteger(minimum) && minimum >= 0 && minimum <= route.argumentShapes.length,
    `${route.id}: optional callback route has invalid minimum arity`);
  assert(callbackSlots.every((slot) => slot >= minimum),
    `${route.id}: Static Hermes callback appears in required argument prefix`);
  return route.argumentShapes.slice(0, minimum);
}

function validateStaticLane(recording, lanes, targetIndex, route) {
  assert(Array.isArray(route.applicability) && targetIndex < route.applicability.length,
    `${route.id}: Static Hermes applicability lane is missing`);
  const laneId = route.applicability[targetIndex];
  const lane = lanes.get(laneId);
  assert(lane, `${route.id}: Static Hermes applicability references missing lane ${laneId}`);
  assert(lane.target === STATIC_TARGET,
    `${route.id}: Static Hermes applicability references ${lane.target ?? "an unowned"} target lane`);
  assert(["exercise", "blocked", "omit"].includes(lane.status),
    `${route.id}: Static Hermes applicability has unsupported status ${lane.status}`);
  if (lane.status === "exercise") {
    assert(lane.lane === STATIC_LANE,
      `${route.id}: Static Hermes exercise lane is ${lane.lane}, expected ${STATIC_LANE}`);
  } else {
    assert(lane.lane === "not-emitted",
      `${route.id}: non-emitted Static Hermes route unexpectedly names lane ${lane.lane}`);
  }
  return lane;
}

export function auditStaticScriptExactFamilies(recording) {
  assert(recording?.applicabilityCatalog?.schema === "deherm-script-target-applicability/v1",
    "script recording applicability catalog is missing");
  const targetIndex = recording.applicabilityCatalog.targets.indexOf(STATIC_TARGET);
  assert(targetIndex >= 0, "script recording applicability has no Static Hermes target");
  assert(recording.applicabilityCatalog.targets.indexOf(STATIC_TARGET, targetIndex + 1) < 0,
    "script recording applicability has duplicate Static Hermes targets");
  assert(recording.applicabilityCatalog.routeCount === recording.routes.length,
    "script recording applicability route census drifted");
  const lanes = new Map(recording.applicabilityCatalog.lanes.map((lane) => [lane.id, lane]));
  assert(lanes.size === recording.applicabilityCatalog.lanes.length,
    "script recording applicability has duplicate lane IDs");
  const emitted = recording.routes.filter((route) =>
    validateStaticLane(recording, lanes, targetIndex, route).status === "exercise");
  const declaredEmitted = recording.applicabilityCatalog.lanes
    .filter(({ target, status }) => target === STATIC_TARGET && status === "exercise")
    .reduce((sum, { routeCount }) => sum + routeCount, 0);
  assert(emitted.length === declaredEmitted,
    `Static Hermes emitted route census ${emitted.length} differs from applicability lanes ${declaredEmitted}`);
  const families = new Map();
  for (const route of emitted) {
    const rows = families.get(route.loweringFamily) ?? [];
    rows.push(route);
    families.set(route.loweringFamily, rows);
  }
  return [...families.entries()]
    .map(([family, routes]) => ({
      family,
      emittedRouteCount: routes.length,
      exactVectorCount: IMPLEMENTED_FAMILY_SET.has(family) ? routes.length : 0,
      missingVectorCount: IMPLEMENTED_FAMILY_SET.has(family) ? 0 : routes.length,
      routeIds: routes.map(({ id }) => id)
    }))
    .sort((left, right) =>
      right.emittedRouteCount - left.emittedRouteCount || compareCodePoints(left.family, right.family));
}

export function materializeStaticScriptExactVectors(recording) {
  const families = auditStaticScriptExactFamilies(recording);
  const unsupportedFamilies = families.filter(({ family }) => !IMPLEMENTED_FAMILY_SET.has(family));
  assert(unsupportedFamilies.length === 0,
    `Static Hermes exact verification has no emitter for exercised families: ${unsupportedFamilies
      .map(({ family, emittedRouteCount }) => `${family}(${emittedRouteCount})`).join(", ")}`);
  const selected = new Set(families
    .filter(({ family }) => IMPLEMENTED_FAMILY_SET.has(family))
    .flatMap(({ routeIds }) => routeIds));
  const contracts = new Map(recording.exactVectorCatalog.vectors.map((vector) => [vector.id, vector]));
  const vectors = recording.routes.flatMap((route, routeIndex) => {
    if (!selected.has(route.id)) return [];
    const contract = contracts.get(route.exactVector.contract);
    assert(contract, `${route.id}: exact vector contract is missing`);
    assert(route.argumentShapes.length === contract.argumentValues.length,
      `${route.id}: exact argument shape/value arity drifted`);
    assert(route.resultShapes.length === contract.resultValues.length,
      `${route.id}: exact result shape/value arity drifted`);
    const argumentShapes = staticExactArgumentShapes(recording, route);
    const argumentPlans = argumentShapes.map((shape, slot) => {
      const specification = contract.argumentValues[slot];
      const plan = planStaticScriptExactValue(recording, shape, slot + 1);
      assert(specification === plan.specification,
        `${route.id}: exact argument value drifted at slot ${slot}`);
      return plan;
    });
    const resultPlans = route.resultShapes.map((shape, slot) => {
      const specification = contract.resultValues[slot];
      const plan = planStaticScriptExactValue(recording, shape, 257 + slot);
      assert(specification === plan.specification,
        `${route.id}: exact result value drifted at slot ${slot}`);
      return plan;
    });
    assert(contract.bounds && typeof contract.bounds === "object",
      `${route.id}: exact frame bounds are missing`);
    assert(route.arity?.driven === route.argumentShapes.length &&
      route.argumentShapes.length >= route.arity.minimum &&
      route.argumentShapes.length <= route.arity.maximum,
    `${route.id}: exact driven argument arity drifted`);
    assert(route.results?.driven === route.resultShapes.length &&
      route.resultShapes.length >= route.results.minimum &&
      route.resultShapes.length <= route.results.maximum,
    `${route.id}: exact driven result arity drifted`);
    assert(contract.bounds.argumentCapacity === route.arity.maximum,
      `${route.id}: exact argument capacity drifted`);
    assert(contract.bounds.resultCapacity === route.results.maximum,
      `${route.id}: exact result capacity drifted`);
    assert([0, STATIC_TABLE_ENTRY_CAPACITY].includes(contract.bounds.inputEntryCapacity) &&
      [0, STATIC_TABLE_ENTRY_CAPACITY].includes(contract.bounds.outputEntryCapacity),
    `${route.id}: exact table-entry capacity drifted`);
    assert(argumentPlans.reduce((sum, plan) => sum + tableEntryCount(plan), 0) <=
      contract.bounds.inputEntryCapacity,
    `${route.id}: exact input table-entry capacity is insufficient`);
    assert(resultPlans.reduce((sum, plan) => sum + tableEntryCount(plan), 0) <=
      contract.bounds.outputEntryCapacity,
    `${route.id}: exact output table-entry capacity is insufficient`);
    const shapes = [...argumentShapes, ...route.resultShapes];
    assert(typeof contract.bounds.matrix4Arena === "boolean" &&
      (!shapes.some((index) => shapeContains(recording, index, shapeCodes.matrix4)) ||
        contract.bounds.matrix4Arena),
    `${route.id}: exact Matrix4 arena flag drifted`);
    assert(typeof contract.bounds.urlArena === "boolean" &&
      (!shapes.some((index) => shapeContains(recording, index, shapeCodes.url)) ||
        contract.bounds.urlArena),
    `${route.id}: exact URL arena flag drifted`);
    assert(contract.releaseExpectation === SUPPORTED_RELEASE_EXPECTATION ||
      contract.releaseExpectation === "generated-owned-handle-release",
      `${route.id}: unsupported Static Hermes release expectation ${contract.releaseExpectation}`);
    if (contract.releaseExpectation === "generated-owned-handle-release") {
      assert(resultPlans.length > 0 && resultPlans.every(({ kind }) => kind === "gui-node"),
        `${route.id}: generated-owned release lacks a bounded GUI-node exact result`);
    }
    return [{
      routeIndex,
      id: route.id,
      stableId: route.stableId,
      loweringFamily: route.loweringFamily,
      argumentShapes,
      resultShapes: route.resultShapes,
      argumentValues: contract.argumentValues.slice(0, argumentShapes.length),
      resultValues: contract.resultValues,
      bounds: contract.bounds,
      releaseExpectation: contract.releaseExpectation
    }];
  });
  for (const implementedFamily of IMPLEMENTED_FAMILIES) {
    const family = families.find(({ family: candidate }) => candidate === implementedFamily);
    assert(family && vectors.filter(({ loweringFamily }) => loweringFamily === implementedFamily).length ===
      family.emittedRouteCount, `Static Hermes ${implementedFamily} vector census drifted`);
  }
  const report = {
    schemaVersion: 3,
    transport: "static-hermes-typed-native",
    implementedFamilies: IMPLEMENTED_FAMILIES,
    emittedRouteCount: vectors.length,
    exactVectorCount: vectors.length,
    families,
    vectorSha256: sha256(canonicalJson(vectors)),
    evidenceBoundary: "The generated sound-typed Static Hermes runner replays every lowering-plan-emitted route through the production bounded frame and the generated recording provider. Exact argument and result predicates are derived from the interned contract values; optional callback-input routes are replayed at declared minimum arity with the callback omitted, while present callbacks are declined by the typed adapter before frame acquisition and remain on the captured JSI lifecycle. Generation fails on applicability, driven arity, argument/result/table capacity, arena-flag, recursive-shape, or release-policy drift. It proves exact bridge lookup, ordered values, result decoding, and target applicability. It does not execute Defold implementation semantics, prove every dynamic or overload alternative, claim optional-result omission behavior, instrument allocator calls, or claim negative exhaustion coverage for each route; allocation evidence belongs to separate instrumented runtime benchmarks, not ASan/UBSan execution."
  };
  return { report, vectors };
}
