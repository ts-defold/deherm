import { createHash } from "node:crypto";

import { shapeCodes } from "./script-recording-engine.mjs";

const STATIC_TARGET = "static-hermes";
const STATIC_LANE = "static-hermes-typed-native";
const IMPLEMENTED_FAMILY = "defold-value";
const SUPPORTED_RELEASE_EXPECTATION = "no-retained-result-release";

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

export function canonicalStaticScriptExactValue(recording, shapeIndex, seed) {
  const shape = recording.shapes[shapeIndex];
  assert(shape, `Static Hermes exact vector references missing shape ${shapeIndex}`);
  switch (shape.code) {
    case shapeCodes.boolean: return `bool:${seed % 2}`;
    case shapeCodes.number: return `num:${seed}`;
    case shapeCodes.string: return `str:d${seed}`;
    case shapeCodes.hash: return `hash:${exactUnsigned64(seed)}`;
    case shapeCodes.url:
      return `url:${Array.from({ length: 4 }, (_, lane) => exactUnsigned64(seed + lane)).join(",")}`;
    case shapeCodes.vector3: return `dv:v3:${seed},${seed + 1},${seed + 2}`;
    case shapeCodes.vector4: return `dv:v4:${seed},${seed + 1},${seed + 2},${seed + 3}`;
    case shapeCodes.quaternion: return `dv:quat:${seed},${seed + 1},${seed + 2},${seed + 3}`;
    case shapeCodes.matrix4:
      return `dv:mat4:${Array.from({ length: 16 }, (_, lane) => seed + lane).join(",")}`;
    default:
      throw new Error(`Static Hermes ${IMPLEMENTED_FAMILY} exact vector cannot encode shape code ${shape.code}`);
  }
}

export function parseStaticScriptExactValue(recording, shapeIndex, specification) {
  const shape = recording.shapes[shapeIndex];
  assert(shape, `Static Hermes exact vector references missing shape ${shapeIndex}`);
  const numericList = (prefix, count) => {
    assert(specification.startsWith(prefix),
      `Static Hermes exact value ${JSON.stringify(specification)} does not match ${prefix}`);
    const values = specification.slice(prefix.length).split(",").map((value) => Number(value));
    assert(values.length === count && values.every(Number.isFinite),
      `Static Hermes exact value ${JSON.stringify(specification)} has an invalid numeric lane list`);
    return values;
  };
  switch (shape.code) {
    case shapeCodes.boolean:
      assert(specification === "bool:0" || specification === "bool:1",
        `Static Hermes boolean exact value is invalid: ${JSON.stringify(specification)}`);
      return { kind: "boolean", value: specification === "bool:1" };
    case shapeCodes.number: {
      assert(specification.startsWith("num:"),
        `Static Hermes number exact value is invalid: ${JSON.stringify(specification)}`);
      const value = Number(specification.slice(4));
      assert(Number.isFinite(value),
        `Static Hermes number exact value is not finite: ${JSON.stringify(specification)}`);
      return { kind: "number", value };
    }
    case shapeCodes.string:
      assert(specification.startsWith("str:"),
        `Static Hermes string exact value is invalid: ${JSON.stringify(specification)}`);
      return { kind: "string", value: specification.slice(4) };
    case shapeCodes.hash: {
      assert(/^hash:[0-9]+$/u.test(specification),
        `Static Hermes hash exact value is invalid: ${JSON.stringify(specification)}`);
      const value = BigInt(specification.slice(5));
      assert(value <= UINT64_MAX,
        `Static Hermes hash exact value exceeds uint64: ${JSON.stringify(specification)}`);
      return { kind: "hash", low: Number(value & UINT32_MAX), high: Number(value >> 32n) };
    }
    case shapeCodes.url: {
      assert(specification.startsWith("url:"),
        `Static Hermes URL exact value is invalid: ${JSON.stringify(specification)}`);
      const lanes = specification.slice(4).split(",").map((value) => BigInt(value));
      assert(lanes.length === 4 && lanes.every((value) => value >= 0n && value <= UINT64_MAX),
        `Static Hermes URL exact value has invalid uint64 lanes: ${JSON.stringify(specification)}`);
      return {
        kind: "url",
        halves: lanes.flatMap((value) => [Number(value & UINT32_MAX), Number(value >> 32n)])
      };
    }
    case shapeCodes.vector3: return { kind: "vector3", lanes: numericList("dv:v3:", 3) };
    case shapeCodes.vector4: return { kind: "vector4", lanes: numericList("dv:v4:", 4) };
    case shapeCodes.quaternion: return { kind: "quaternion", lanes: numericList("dv:quat:", 4) };
    case shapeCodes.matrix4: return { kind: "matrix4", lanes: numericList("dv:mat4:", 16) };
    default:
      throw new Error(`Static Hermes ${IMPLEMENTED_FAMILY} exact vector cannot parse shape code ${shape.code}`);
  }
}

const UINT32_MAX = 0xffffffffn;
const UINT64_MAX = 0xffffffffffffffffn;

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
      exactVectorCount: family === IMPLEMENTED_FAMILY ? routes.length : 0,
      missingVectorCount: family === IMPLEMENTED_FAMILY ? 0 : routes.length,
      routeIds: routes.map(({ id }) => id)
    }))
    .sort((left, right) =>
      right.emittedRouteCount - left.emittedRouteCount || left.family.localeCompare(right.family));
}

export function materializeStaticScriptExactVectors(recording) {
  const families = auditStaticScriptExactFamilies(recording);
  const selected = new Set(families
    .filter(({ family }) => family === IMPLEMENTED_FAMILY)
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
    route.argumentShapes.forEach((shape, slot) => {
      const specification = contract.argumentValues[slot];
      parseStaticScriptExactValue(recording, shape, specification);
      assert(specification === canonicalStaticScriptExactValue(recording, shape, slot + 1),
        `${route.id}: exact argument value drifted at slot ${slot}`);
    });
    route.resultShapes.forEach((shape, slot) => {
      const specification = contract.resultValues[slot];
      parseStaticScriptExactValue(recording, shape, specification);
      assert(specification === canonicalStaticScriptExactValue(recording, shape, 257 + slot),
        `${route.id}: exact result value drifted at slot ${slot}`);
    });
    assert(contract.bounds && typeof contract.bounds === "object",
      `${route.id}: exact frame bounds are missing`);
    assert(contract.bounds.argumentCapacity === route.argumentShapes.length,
      `${route.id}: exact argument capacity drifted`);
    assert(contract.bounds.resultCapacity === route.resultShapes.length,
      `${route.id}: exact result capacity drifted`);
    assert(contract.bounds.inputEntryCapacity === 0 && contract.bounds.outputEntryCapacity === 0,
      `${route.id}: ${IMPLEMENTED_FAMILY} exact vector unexpectedly requires table-entry scratch`);
    const shapes = [...route.argumentShapes, ...route.resultShapes].map((index) => recording.shapes[index]);
    assert(typeof contract.bounds.matrix4Arena === "boolean" &&
      (!shapes.some(({ code }) => code === shapeCodes.matrix4) || contract.bounds.matrix4Arena),
    `${route.id}: exact Matrix4 arena flag drifted`);
    assert(typeof contract.bounds.urlArena === "boolean" &&
      (!shapes.some(({ code }) => code === shapeCodes.url) || contract.bounds.urlArena),
    `${route.id}: exact URL arena flag drifted`);
    assert(contract.releaseExpectation === SUPPORTED_RELEASE_EXPECTATION,
      `${route.id}: unsupported Static Hermes release expectation ${contract.releaseExpectation}`);
    return [{
      routeIndex,
      id: route.id,
      stableId: route.stableId,
      loweringFamily: route.loweringFamily,
      argumentShapes: route.argumentShapes,
      resultShapes: route.resultShapes,
      argumentValues: contract.argumentValues,
      resultValues: contract.resultValues,
      bounds: contract.bounds,
      releaseExpectation: contract.releaseExpectation
    }];
  });
  const family = families.find(({ family }) => family === IMPLEMENTED_FAMILY);
  assert(vectors.length === family?.emittedRouteCount,
    `Static Hermes ${IMPLEMENTED_FAMILY} vector census drifted`);
  const report = {
    schemaVersion: 1,
    transport: "static-hermes-typed-native",
    family: IMPLEMENTED_FAMILY,
    emittedRouteCount: vectors.length,
    exactVectorCount: vectors.length,
    families,
    vectorSha256: sha256(canonicalJson(vectors)),
    evidenceBoundary: "The generated sound-typed Static Hermes runner replays only lowering-plan-emitted defold-value routes through the production bounded frame and the generated recording provider. Exact argument and result predicates are derived from the interned contract values; generation fails on applicability, frame-bound, arena-flag, or release-policy drift. It proves exact bridge lookup, ordered values, result decoding, and target applicability; it does not execute Defold implementation semantics or claim negative exhaustion coverage for each route."
  };
  return { report, vectors };
}
