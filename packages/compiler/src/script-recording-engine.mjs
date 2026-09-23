// Deterministic model for the generated Defold script recording engine.
//
// The recording engine is a null/observer Defold: a generated native provider
// that asserts every incoming script call against the contract the canonical
// lowering plan already interned, records it into a deterministic trace, and
// returns a synthetic result of the declared shape. A generated driver replays
// every route through the real binding stack over each drivable transport.
//
// Evidence boundary: this model proves only that the generated binding stack
// matches *this repository's* declared contract. It is not, and must never be
// reported as, Defold engine conformance. The trace is keyed by interned
// contract index so a later real-engine differential can diff against it per
// contract.

import { createHash } from "node:crypto";

import { hashDefoldString64 } from "./defold-hash.mjs";

const SHAPE = Object.freeze({
  undefined: 0,
  null: 1,
  boolean: 2,
  number: 3,
  string: 4,
  hash: 5,
  url: 6,
  handle: 7,
  guiNode: 8,
  userdata: 9,
  vector3: 10,
  vector4: 11,
  quaternion: 12,
  matrix4: 13,
  sequence: 14,
  record: 15,
  map: 16,
  callback: 17,
  unsupported: 18
});

export const shapeCodes = SHAPE;

export const transportOrder = Object.freeze(["jsi", "direct-memory", "typed-native"]);

export const targetOrder = Object.freeze([
  "dynamic-hermes",
  "static-hermes",
  "browser-wasm",
  "lua-stack"
]);

export const luaAdapterProfile = "generated-runtime-profile-union";

/** Transports the canonical plan models but this harness cannot drive itself. */
export const undrivableTransports = Object.freeze([
  Object.freeze({
    transport: "lua-stack",
    runtime: "hermes",
    reason: "lua-stack-driven-by-exact-script-adapter-companion-outside-recorded-trace"
  })
]);

function seedStableId(revision, name, used) {
  const digest = createHash("sha256")
    .update(`${revision}\0deherm-recording-handle-seed\0${name}`)
    .digest();
  let candidate = digest.readUInt32LE(0);
  while (used.has(candidate)) candidate = (candidate + 1) >>> 0;
  used.add(candidate);
  return candidate;
}

/**
 * Structural alias policy from projected `defold-value` names onto the generated
 * handle-kind ledger. These are value-shape rules, not route allowlists: an
 * unknown name produces a machine-readable blocker instead of a silent guess.
 */
const defoldValueHandleAliases = Object.freeze({
  node: "gui-node",
  buffer_data: "buffer-data",
  buffer_stream: "buffer-stream",
  texture: "graphics-texture",
  render_target: "graphics-render-target",
  constant_buffer: "render-constant-buffer"
});

/** Projected `defold-value` names that are plain numeric engine constants. */
const defoldValueNumericNames = Object.freeze([
  "go.EASING",
  "gui.EASING",
  "gui.PROP",
  "timer_handle"
]);

/** Projected `defold-value` names carried as unbranded retained Lua userdata. */
const defoldValueUserdataNames = Object.freeze([
  "render_predicate",
  "resource_data",
  "vector"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

class TextTable {
  constructor() {
    this.entries = [];
    this.index = new Map();
  }

  intern(text) {
    assert(typeof text === "string", "recording-engine text must be a string");
    const existing = this.index.get(text);
    if (existing !== undefined) return existing;
    const id = this.entries.length;
    this.entries.push(text);
    this.index.set(text, id);
    return id;
  }
}

class ShapeTable {
  constructor(text) {
    this.text = text;
    this.entries = [];
    this.index = new Map();
  }

  intern(node) {
    const record = {
      code: node.code,
      aux: node.aux ?? 0,
      key: node.key ?? -1,
      children: node.children ?? []
    };
    const identity = canonicalJson(record);
    const existing = this.index.get(identity);
    if (existing !== undefined) return existing;
    const id = this.entries.length;
    this.entries.push(record);
    this.index.set(identity, id);
    return id;
  }
}

function handleKindLedger(handleLowering) {
  const byRawType = new Map();
  const byId = new Map();
  for (const kind of handleLowering.handleKinds ?? []) {
    assert(typeof kind.id === "string" && Number.isInteger(kind.numericId),
      "handle-kind ledger rows need an id and numericId");
    byId.set(kind.id, kind.numericId);
    for (const rawType of kind.rawTypes ?? []) byRawType.set(rawType, kind.numericId);
  }
  return { byRawType, byId };
}

/**
 * Canonical trace rendering of one wire value shape. The generated provider,
 * the generated driver, the generated JavaScript driver, and this expectation
 * renderer must all produce byte-identical text for the same observed value.
 */
function childSentinel(seed, index) {
  return ((seed * 17 + index + 1) % 10000) + 1;
}

function u64Sentinel(seed) {
  return (BigInt(seed + 0x10000) << 32n) | BigInt(seed);
}

/**
 * Exact native-POD vectors are owned by the same value-binding row that owns
 * the production implementation. Older structural templates predate explicit
 * probes, so fill those six templates by operation shape rather than route ID.
 */
function nativePodVerificationVector(binding) {
  if (binding.generatedProbe) return {
    source: "generated-value-binding-probe",
    key: binding.generatedProbe.key,
    arguments: binding.generatedProbe.arguments,
    expectation: binding.generatedProbe.expectation
  };
  const template = binding.operation?.template;
  const parameters = binding.operation?.parameters ?? {};
  if (template === "quaternion-axis-rotation") {
    const axis = parameters.axis;
    assert(["x", "y", "z"].includes(axis), `${binding.id}: unsupported quaternion axis '${axis}'`);
    return {
      source: "operation-template-default",
      key: `quaternion-axis-rotation.${axis}`,
      arguments: [Math.PI],
      expectation: {
        kind: "components",
        values: axis === "x" ? [1, 0, 0, 0] : axis === "y" ? [0, 1, 0, 0] : [0, 0, 1, 0],
        tolerance: 0.000001
      }
    };
  }
  if (template === "value-unary" && parameters.operator === "length") return {
    source: "operation-template-default",
    key: "value-unary.length",
    arguments: [{ codec: "Vector3", components: [3, 4, 0] }],
    expectation: { kind: "number", value: 5, tolerance: 0 }
  };
  if (template === "value-unary" && parameters.operator === "normalize") return {
    source: "operation-template-default",
    key: "value-unary.normalize",
    arguments: [{ codec: "Vector3", components: [3, 4, 0] }],
    expectation: { kind: "components", values: [0.6, 0.8, 0], tolerance: 0.000001 }
  };
  if (template === "value-constructor") {
    if (parameters.kind === "Quaternion") return {
      source: "operation-template-default",
      key: "value-constructor.quaternion-identity",
      arguments: [],
      expectation: { kind: "components", values: [0, 0, 0, 1], tolerance: 0 }
    };
    if (parameters.kind === "Vector3") return {
      source: "operation-template-default",
      key: "value-constructor.vector3-zero",
      arguments: [],
      expectation: { kind: "components", values: [0, 0, 0], tolerance: 0 }
    };
  }
  if (template === "hash-string") {
    const input = "deherm_native_pod_exact";
    return {
      source: "operation-template-default",
      key: "hash-string.utf8",
      arguments: [input],
      expectation: { kind: "hash", value: hashDefoldString64(input).toString(), tolerance: 0 }
    };
  }
  throw new Error(`${binding.id}: generated native-POD route has no exact verification vector`);
}

export function renderShapeSpec(shapes, index, semanticNames, seed = 1) {
  const shape = shapes[index];
  switch (shape.code) {
    case SHAPE.undefined: return "undef";
    case SHAPE.null: return "null";
    case SHAPE.boolean: return `bool:${seed % 2}`;
    case SHAPE.number: return `num:${seed}`;
    case SHAPE.string: return `str:d${seed}`;
    case SHAPE.hash: return `hash:${u64Sentinel(seed)}`;
    case SHAPE.url: return `url:${Array.from({ length: 4 }, (_, lane) =>
      u64Sentinel(seed + lane)).join(",")}`;
    case SHAPE.handle: return `h:${semanticNames[shape.aux] ?? "unknown"}`;
    case SHAPE.guiNode: return "h:gui-node";
    case SHAPE.userdata: return "h:lua-userdata";
    case SHAPE.vector3: return `dv:v3:${seed},${seed + 1},${seed + 2}`;
    case SHAPE.vector4: return `dv:v4:${seed},${seed + 1},${seed + 2},${seed + 3}`;
    case SHAPE.quaternion: return `dv:quat:${seed},${seed + 1},${seed + 2},${seed + 3}`;
    case SHAPE.matrix4: return `dv:mat4:${Array.from({ length: 16 }, (_, lane) => seed + lane).join(",")}`;
    case SHAPE.sequence:
      return `seq(${shape.children.map((child, childIndex) =>
        renderShapeSpec(shapes, child, semanticNames, childSentinel(seed, childIndex))).join(",")})`;
    case SHAPE.record:
      return `rec(${shape.children.map((child, childIndex) => {
        const field = shapes[child];
        return `${field.keyText}=${renderShapeSpec(
          shapes, child, semanticNames, childSentinel(seed, childIndex),
        )}`;
      }).join(",")})`;
    case SHAPE.map:
      return `map(${renderShapeSpec(
        shapes, shape.children[0], semanticNames, childSentinel(seed, 0),
      )}=>${renderShapeSpec(
        shapes, shape.children[1], semanticNames, childSentinel(seed, 1),
      )})`;
    case SHAPE.callback: return "cb";
    default: return "unsupported";
  }
}

function shapeContains(shapes, index, predicate, seen = new Set()) {
  if (seen.has(index)) return false;
  seen.add(index);
  const shape = shapes[index];
  if (predicate(shape)) return true;
  return shape.children.some((child) => shapeContains(shapes, child, predicate, seen));
}

function collectHandleNeeds(shapes, index, into, seen = new Set()) {
  if (seen.has(index)) return;
  seen.add(index);
  const shape = shapes[index];
  if (shape.code === SHAPE.handle) into.add(shape.aux);
  else if (shape.code === SHAPE.guiNode) into.add(-1);
  else if (shape.code === SHAPE.userdata) into.add(-2);
  for (const child of shape.children) collectHandleNeeds(shapes, child, into, seen);
}

export function buildRecordingEngineModel(inputs) {
  const { projection, universal, handleLowering, tableRecords, valueBindings, overloadDispatch, loweringPlan, inputHashes } = inputs;

  assert(loweringPlan.schemaVersion === 2, "recording engine requires canonical lowering plan schema v2");
  assert(projection.defoldRevision === universal.defoldRevision,
    "script projection and universal value bindings pin different Defold revisions");
  const canonicalPlanMatchesRevision = projection.defoldRevision === loweringPlan.defoldRevision;

  // The plan is joined by exact route identity, so a byte-level drift in any
  // declared plan input is recorded rather than silently ignored. Contract
  // indices in the trace are only meaningful against the exact plan they came
  // from, so the drift ledger travels with the generated report.
  const planInputDrift = Object.entries({
    projection: "scriptProjection",
    universal: "scriptUniversalValue",
    handleLowering: "scriptHandleLowering"
  })
    .filter(([local, planKey]) => inputHashes[local] !== loweringPlan.inputHashes[planKey])
    .map(([local, planKey]) => ({
      input: local,
      planInput: planKey,
      planSha256: loweringPlan.inputHashes[planKey],
      observedSha256: inputHashes[local]
    }));

  const semanticNames = ["", ...(handleLowering.handleKinds ?? []).map((kind) => kind.id)];
  const ledger = handleKindLedger(handleLowering);
  const text = new TextTable();
  const shapes = new ShapeTable(text);

  const projectionRows = new Map(projection.rows.map((row) => [row.id, row]));
  const universalRows = new Map((universal.bindings ?? []).map((row) => [row.id, row]));
  const handleRows = new Map((handleLowering.routes ?? []).map((row) => [row.id, row]));
  const tableRecordRows = new Map((tableRecords?.bindings ?? []).map((row) => [row.id, row]));
  const valueBindingRows = new Map((valueBindings?.bindings ?? []).map((row) => [row.id, row]));
  const overloadRows = new Map((overloadDispatch?.bindings ?? []).map((row) => [row.id, row]));
  const planUnits = new Map((canonicalPlanMatchesRevision ? loweringPlan.units : [])
    .filter((unit) => unit.identity.surface === "script")
    .map((unit) => [unit.identity.id, unit]));

  const projectionContract = (row) => ({
    context: row.context?.token ?? "unspecified",
    ownership: row.effects?.ownership?.token ?? "unverified",
    lifetime: row.effects?.lifetime?.token ?? "unverified",
    thread: "defold-script-thread-from-context",
    callback: row.effects?.callback?.token ?? "unverified",
    invalidation: row.effects?.invalidation?.token ?? "unverified",
    errorModel: "status-return-and-target-exception",
    scratch: "caller-owned-bounded-reentrant-scratch"
  });
  // Constant universal operations are generated from the revision-derived
  // registration surface rather than the callable projection IR. They still
  // have an exact zero-argument/one-result transport contract, so give the
  // recording model that mechanical contract instead of pretending a
  // function projection row exists.
  const rowForBinding = (binding) => projectionRows.get(binding.id) ??
    (binding.loweringFamily === "script-constant" ? {
      context: { token: "unspecified" },
      effects: {},
      runtimeModulePath: binding.modulePath,
      runtimeMember: binding.member,
      signature: {
        parameters: [],
        returns: [{ value: { kind: "dynamic" } }]
      }
    } : null);
  const fallbackContracts = [...new Set(universal.bindings.map((binding) => {
    const row = rowForBinding(binding);
    assert(row, `universal binding ${binding.id} has no projection row`);
    return canonicalJson(projectionContract(row));
  }))].sort(compareCodeUnits);
  const fallbackContractIndex = new Map(fallbackContracts.map((contract, index) => [contract, index]));
  const fallbackMarshallingPrograms = Object.freeze({
    typescriptSdk: 0,
    dynamicHermesJsi: 0,
    staticHermesCAbi: 0,
    luaStack: 0,
    browserWasmHost: 0
  });

  const blockers = [];
  const recordBlocker = (routeId, code, detail) => {
    blockers.push({ route: routeId, code, detail });
  };

  /** Lowers one projected value shape onto the recorded wire shape table. */
  function lower(routeId, value, keyText) {
    const key = keyText === undefined ? -1 : text.intern(keyText);
    const node = (code, aux = 0, children = []) => shapes.intern({ code, aux, key, children });
    if (!value || typeof value.kind !== "string") {
      recordBlocker(routeId, "unsupported-value-node", "projected value has no kind");
      return node(SHAPE.unsupported);
    }
    switch (value.kind) {
      case "scalar":
        if (value.name === "boolean") return node(SHAPE.boolean);
        if (value.name === "string") return node(SHAPE.string);
        if (value.name === "number" || value.name === "integer") return node(SHAPE.number);
        if (value.name === "nil") return node(SHAPE.null);
        recordBlocker(routeId, "unsupported-scalar", value.name);
        return node(SHAPE.unsupported);
      case "enum":
        return node(SHAPE.number);
      case "dynamic":
        return node(SHAPE.number);
      case "callback":
        return node(SHAPE.callback);
      case "handle": {
        const numeric = ledger.byRawType.get(value.name);
        if (numeric === undefined) return node(SHAPE.userdata);
        return node(SHAPE.handle, numeric);
      }
      case "defold-value": {
        if (value.name === "vector3") return node(SHAPE.vector3);
        if (value.name === "vector4") return node(SHAPE.vector4);
        if (value.name === "quaternion") return node(SHAPE.quaternion);
        if (value.name === "matrix4") return node(SHAPE.matrix4);
        if (value.name === "hash") return node(SHAPE.hash);
        if (value.name === "url") return node(SHAPE.url);
        if (defoldValueNumericNames.includes(value.name)) return node(SHAPE.number);
        if (defoldValueUserdataNames.includes(value.name)) return node(SHAPE.userdata);
        const alias = defoldValueHandleAliases[value.name];
        if (alias) {
          const numeric = ledger.byId.get(alias);
          if (numeric === undefined) {
            recordBlocker(routeId, "unknown-handle-alias", `${value.name} -> ${alias}`);
            return node(SHAPE.unsupported);
          }
          return numeric === ledger.byId.get("gui-node")
            ? node(SHAPE.guiNode, numeric)
            : node(SHAPE.handle, numeric);
        }
        recordBlocker(routeId, "unsupported-defold-value", value.name);
        return node(SHAPE.unsupported);
      }
      case "record-ref":
        if (tableRecordRows.has(routeId)) {
          const fields = tableRecordRows.get(routeId).fields.map((field) => lower(routeId, {
            kind: "scalar",
            name: field.codec === "Boolean" ? "boolean" : field.codec === "String" ? "string" :
              field.codec === "Integer" || field.codec === "Number" ? "number" : "unsupported"
          }, field.name));
          return node(SHAPE.record, 0, fields);
        }
        return node(SHAPE.record, 0, []);
      case "record": {
        const fields = (value.fields ?? []).map((field) => lower(routeId, field.value, field.name));
        return node(SHAPE.record, 0, fields);
      }
      case "sequence":
        return node(SHAPE.sequence, 0, [lower(routeId, value.element)]);
      case "map":
        return node(SHAPE.map, 0, [lower(routeId, value.key), lower(routeId, value.value)]);
      case "optional":
        return lowerAliased(routeId, value.value, key);
      case "union": {
        const variants = value.variants ?? [];
        if (!variants.length) {
          recordBlocker(routeId, "empty-union", "");
          return node(SHAPE.unsupported);
        }
        return lowerAliased(routeId, variants[0], key);
      }
      case "variadic":
        return lowerAliased(routeId, value.value ?? value.element, key);
      case "named":
        return node(SHAPE.record, 0, []);
      default:
        recordBlocker(routeId, "unsupported-value-kind", value.kind);
        return node(SHAPE.unsupported);
    }
  }

  /** Re-interns an inner shape under an outer field key, preserving the key. */
  function lowerAliased(routeId, value, key) {
    const inner = lower(routeId, value);
    const entry = shapes.entries[inner];
    if (entry.key === key) return inner;
    return shapes.intern({ code: entry.code, aux: entry.aux, key, children: entry.children });
  }

  function lowerExactCodec(routeId, codec, keyText) {
    const values = {
      Number: { kind: "scalar", name: "number" },
      Vector3: { kind: "defold-value", name: "vector3" },
      Vector4: { kind: "defold-value", name: "vector4" },
      Quaternion: { kind: "defold-value", name: "quaternion" },
      Matrix4: { kind: "defold-value", name: "matrix4" }
    };
    assert(values[codec], `${routeId}: unsupported exact overload codec ${codec}`);
    return lower(routeId, values[codec], keyText);
  }

  const routes = [];
  for (const binding of [...universal.bindings].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const row = rowForBinding(binding);
    assert(row, `universal binding ${binding.id} has no projection row`);
    const canonicalUnit = planUnits.get(binding.id);
    const fallbackContract = projectionContract(row);
    const fallbackIdentity = canonicalJson(fallbackContract);
    const unit = canonicalUnit ?? {
      contract: fallbackContract,
      contractDetails: fallbackContractIndex.get(fallbackIdentity),
      backends: Object.fromEntries(Object.entries(fallbackMarshallingPrograms)
        .map(([backend, marshallingProgram]) => [backend, { marshallingProgram }]))
    };

    const parameters = row.signature.parameters ?? [];
    const returns = row.signature.returns ?? [];
    const argumentCount = Math.min(parameters.length, binding.maximumArgumentCount);
    let argumentShapes = parameters.slice(0, argumentCount)
      .map((parameter) => lower(binding.id, parameter.value, parameter.name));
    const resultCount = Math.min(returns.length, binding.maximumResultCount);
    let resultShapes = returns.slice(0, resultCount).map((result) => lower(binding.id, result.value));
    const overloadShape = overloadRows.get(binding.id)?.callShapes?.[0];
    if (overloadShape) {
      argumentShapes = overloadShape.arguments.map((codec, index) =>
        lowerExactCodec(binding.id, codec, parameters[index]?.name));
      resultShapes = [lowerExactCodec(binding.id, overloadShape.resultCodec)];
    }

    const route = {
      id: binding.id,
      stableId: binding.stableId,
      canonical: binding.id.slice("script:".length),
      runtimeModulePath: row.runtimeModulePath,
      runtimeMember: row.runtimeMember,
      loweringFamily: binding.loweringFamily,
      contract: unit.contractDetails,
      contractTokens: unit.contract,
      marshallingPrograms: Object.fromEntries(Object.entries(unit.backends)
        .map(([backend, disposition]) => [backend, disposition.marshallingProgram])),
      backendSelections: Object.fromEntries(Object.entries(unit.backends)
        .map(([backend, disposition]) => [backend, {
          selection: disposition.selection ?? "emit",
          blockerSet: disposition.blockerSet ?? 0
        }])),
      dynamicHermesSelection: unit.backends.dynamicHermesJsi?.selection ?? "emit",
      loweringPlanEvidence: canonicalUnit ? "canonical-plan" : "projection-derived-unverified-fallback",
      context: row.context?.token ?? "unspecified",
      arity: { minimum: binding.minimumArgumentCount, maximum: binding.maximumArgumentCount, driven: argumentCount },
      results: {
        minimum: binding.minimumResultCount,
        maximum: binding.maximumResultCount,
        declared: binding.resultCount,
        driven: resultCount
      },
      argumentShapes,
      resultShapes,
      transports: {},
      luaAdapter: { status: "exercise", reason: "", argumentCount: binding.minimumArgumentCount }
    };

    if (argumentCount < binding.minimumArgumentCount) {
      recordBlocker(binding.id, "projected-arity-below-generated-minimum",
        `${argumentCount} < ${binding.minimumArgumentCount}`);
    }
    if (resultCount !== binding.resultCount) {
      recordBlocker(binding.id, "projected-result-count-differs-from-generated",
        `${resultCount} != ${binding.resultCount}`);
    }
    routes.push(route);
  }

  const shapeList = shapes.entries.map((entry) => ({
    ...entry,
    keyText: entry.key >= 0 ? text.entries[entry.key] : ""
  }));

  const has = (route, predicate) => [...route.argumentShapes, ...route.resultShapes]
    .some((index) => shapeContains(shapeList, index, predicate));
  const argumentsHave = (route, predicate) => route.argumentShapes
    .some((index) => shapeContains(shapeList, index, predicate));
  const resultsHave = (route, predicate) => route.resultShapes
    .some((index) => shapeContains(shapeList, index, predicate));

  // Universal skips first: these make a route undrivable on every transport.
  for (const route of routes) {
    let universalSkip = null;
    if (has(route, (shape) => shape.code === SHAPE.unsupported)) {
      universalSkip = "unsupported-value-shape";
    } else if (route.arity.driven < route.arity.minimum) {
      universalSkip = "projected-arity-below-generated-minimum";
    } else if (route.results.driven !== route.results.declared) {
      universalSkip = "projected-result-count-differs-from-generated";
    }
    route.universalSkip = universalSkip;
    const valueBindingRow = valueBindingRows.get(route.id);
    const handleRow = handleRows.get(route.id);
    const universalRow = universalRows.get(route.id);
    route.luaAdapter.handleCodec = route.loweringFamily === "multi-result" &&
        argumentsHave(route, (shape) => shape.code === SHAPE.handle)
      ? "lua-userdata"
      : (route.loweringFamily === "multi-result" ||
          valueBindingRow?.targetSupport?.arm64DynamicHermes?.backend === "generated-captured-lua") &&
          argumentsHave(route, (shape) => shape.code === SHAPE.guiNode)
      ? "gui-node"
      : "semantic";
    const topLevelResultShapes = route.resultShapes.map((index) => shapeList[index]);
    const topLevelGuiNode = topLevelResultShapes.some((shape) => shape.code === SHAPE.guiNode);
    const resultHasHandle = resultsHave(route,
      (shape) => shape.code === SHAPE.handle || shape.code === SHAPE.guiNode);
    route.luaAdapter.resultHandleCodec = !resultHasHandle
      ? "none"
      : topLevelGuiNode &&
            valueBindingRow?.targetSupport?.arm64DynamicHermes?.backend === "generated-captured-lua"
        ? "gui-node"
        : handleRow || universalRow?.resultSemanticKindId > 0
        ? "semantic"
        : "lua-userdata";
    if (universalSkip) {
      route.luaAdapter = { ...route.luaAdapter, status: "skip", reason: universalSkip };
    } else if (route.dynamicHermesSelection === "omit" || handleRow?.profiles?.runtimeAvailable === false) {
      route.luaAdapter = {
        status: "skip",
        reason: "canonical-dynamic-hermes-route-omitted",
        argumentCount: route.arity.minimum
      };
    } else if (valueBindingRow?.targetSupport?.arm64DynamicHermes?.backend === "generated-native-pod") {
      route.luaAdapter = {
        status: "skip",
        reason: "route-uses-native-pod-not-lua-stack",
        argumentCount: route.arity.minimum
      };
    } else if (valueBindingRow?.targetSupport?.arm64DynamicHermes?.backend ===
        "generated-native-pod-with-addressed-captured-lua") {
      route.luaAdapter.argumentCount = route.arity.maximum;
    }
  }

  // The JSI transport can only present a retained engine handle that a previous
  // recorded call minted, so the drivable order is a fixpoint over the pool.
  const needs = new Map();
  for (const route of routes) {
    const set = new Set();
    for (const index of route.argumentShapes) collectHandleNeeds(shapeList, index, set);
    needs.set(route.id, set);
  }
  const produces = new Map();
  for (const route of routes) {
    const set = new Set();
    for (const index of route.resultShapes) collectHandleNeeds(shapeList, index, set);
    produces.set(route.id, set);
  }

  const pool = new Set();
  const ordered = [];
  const placed = new Set();
  for (;;) {
    let progressed = false;
    for (const route of routes) {
      if (placed.has(route.id)) continue;
      if (route.universalSkip) continue;
      if (![...needs.get(route.id)].every((kind) => pool.has(kind))) continue;
      placed.add(route.id);
      ordered.push(route);
      for (const kind of produces.get(route.id)) {
        if (!pool.has(kind)) {
          pool.add(kind);
          progressed = true;
        }
      }
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const route of routes) {
    if (!placed.has(route.id)) ordered.push(route);
  }

  const handleName = (kind) => kind === -1 ? "gui-node" : kind === -2 ? "lua-userdata" : (semanticNames[kind] ?? "unknown");

  // A few public APIs consume retained engine handles for which the documented
  // Lua surface exposes no constructor or return path. A real JSI call still
  // needs a genuine HostObject, not a hand-shaped JavaScript object. Generate
  // deterministic test-only provider routes that mint exactly those missing
  // handle kinds through the same bridge decoder before the route census runs.
  const missingHandleKinds = [...new Set(routes.flatMap((route) =>
    [...needs.get(route.id)].filter((kind) => !pool.has(kind))))].sort((left, right) => left - right);
  const usedStableIds = new Set(routes.map(({ stableId }) => stableId));
  const handleSeeds = missingHandleKinds.map((kind) => ({
    name: handleName(kind),
    stableId: seedStableId(projection.defoldRevision, handleName(kind), usedStableIds),
    shapeCode: kind === -1 ? SHAPE.guiNode : kind === -2 ? SHAPE.userdata : SHAPE.handle,
    semantic: kind > 0 ? kind : 0
  }));
  const seededKinds = new Set(missingHandleKinds);

  for (const route of routes) {
    const missing = [...needs.get(route.id)]
      .filter((kind) => !pool.has(kind) && !seededKinds.has(kind))
      .sort((a, b) => a - b);
    for (const transport of transportOrder) {
      let status = "exercise";
      let reason = "";
      if (route.universalSkip) {
        status = "skip";
        reason = route.universalSkip;
      } else if (transport === "jsi" && missing.length) {
        status = "skip";
        reason = `no-recorded-handle-source:${missing.map(handleName).join("+")}`;
      } else if (transport !== "jsi" && resultsHave(route,
        (shape) => shape.code === SHAPE.callback)) {
        status = "skip";
        reason = "callback-result-is-emitted-only-by-the-jsi-transport";
      } else if (transport === "direct-memory" && argumentsHave(route,
        (shape) => shape.code === SHAPE.callback)) {
        status = "skip";
        reason = "callback-input-requires-the-html5-browser-registry";
      } else if (transport === "typed-native" && argumentsHave(route,
        (shape) => shape.code === SHAPE.callback)) {
        status = "skip";
        reason = "callback-input-falls-back-to-jsi-and-is-not-emitted-in-the-static-frame";
      }
      route.transports[transport] = { status, reason };
    }
  }

  const canonicalApplicability = (selection, emittedLane) => {
    if (selection === "emit") return { status: "exercise", lane: emittedLane, reason: "" };
    if (selection === "omit-profile") {
      return { status: "omit", lane: "not-emitted", reason: "canonical-lowering-plan-omit-profile" };
    }
    return {
      status: "blocked",
      lane: "not-emitted",
      reason: `canonical-lowering-plan-${selection}`
    };
  };

  // Normalize target applicability separately from what the generic recording
  // harness happens to be able to call. This prevents a structurally encodable
  // route from being counted as emitted by a target whose lowering plan blocks
  // it (the old typed-native 890/25 split had this exact ambiguity).
  for (const route of routes) {
    const universalRow = universalRows.get(route.id);
    const valueBindingRow = valueBindingRows.get(route.id);
    const dynamicSelection = route.backendSelections.dynamicHermesJsi.selection;
    const staticSelection = route.backendSelections.staticHermesCAbi.selection;
    const browserSelection = route.backendSelections.browserWasmHost.selection;
    const luaSelection = route.backendSelections.luaStack.selection;
    const nativePod = valueBindingRow?.targetSupport?.arm64DynamicHermes?.backend === "generated-native-pod";
    const browserCallback = universalRow?.browserCallback?.registryEligible === true;
    route.targetApplicability = {
      "dynamic-hermes": canonicalApplicability(
        dynamicSelection,
        nativePod ? "dynamic-hermes-native-pod" : "dynamic-hermes-jsi-lua-stack"
      ),
      "static-hermes": canonicalApplicability(staticSelection, "static-hermes-typed-native"),
      "browser-wasm": canonicalApplicability(
        browserSelection,
        browserCallback ? "browser-wasm-callback-registry" : "browser-wasm-direct-memory"
      ),
      "lua-stack": canonicalApplicability(luaSelection, "lua-stack")
    };
    route.exactVector = {
      argumentValues: route.argumentShapes.map((index, slot) =>
        renderShapeSpec(shapeList, index, semanticNames, slot + 1)),
      resultValues: route.resultShapes.map((index, slot) =>
        renderShapeSpec(shapeList, index, semanticNames, 257 + slot)),
      bounds: universalRow?.frameContract ?? null,
      releaseExpectation: resultsHave(route,
        (shape) => shape.code === SHAPE.handle || shape.code === SHAPE.guiNode || shape.code === SHAPE.userdata)
        ? "generated-owned-handle-release"
        : "no-retained-result-release"
    };
    if (nativePod && dynamicSelection === "emit") {
      route.exactVector.laneOverride = {
        lane: "dynamic-hermes-native-pod",
        ...nativePodVerificationVector(valueBindingRow)
      };
    } else if (browserCallback && browserSelection === "emit") {
      const callbackArgument = 1024 + (route.stableId % 8192);
      const callbackResult = 16384 + (route.stableId % 8192);
      route.exactVector.laneOverride = {
        lane: "browser-wasm-callback-registry",
        stableId: route.stableId,
        callbackSlots: route.argumentShapes.flatMap((shapeIndex, index) =>
          shapeList[shapeIndex].code === SHAPE.callback ? [index] : []),
        callbackInvocation: {
          argumentValues: [`num:${callbackArgument}`, `str:browser-callback-${route.stableId}`],
          resultValues: [`num:${callbackResult}`, `str:browser-result-${route.stableId}`]
        },
        lifecycle: {
          lifetime: universalRow.browserCallback.lifetime,
          owner: universalRow.browserCallback.owner,
          threadAffinity: universalRow.browserCallback.threadAffinity
        }
      };
    }
  }

  const targetApplicability = Object.fromEntries(targetOrder.map((target) => {
    const rows = routes.map((route) => route.targetApplicability[target]);
    const lanes = {};
    const status = { exercise: 0, blocked: 0, omit: 0 };
    for (const row of rows) {
      status[row.status] += 1;
      lanes[row.lane] = (lanes[row.lane] ?? 0) + 1;
    }
    return [target, { status, lanes }];
  }));

  const nativePodCount = routes.filter((route) =>
    route.targetApplicability["dynamic-hermes"].lane === "dynamic-hermes-native-pod").length;
  const declaredNativePodCount = [...valueBindingRows.values()].filter((binding) =>
    binding.targetSupport?.arm64DynamicHermes?.backend === "generated-native-pod").length;
  assert(nativePodCount === declaredNativePodCount,
    `dynamic native-POD applicability drifted: ${nativePodCount} != ${declaredNativePodCount}`);
  const browserCallbackCount = routes.filter((route) =>
    route.targetApplicability["browser-wasm"].lane === "browser-wasm-callback-registry").length;
  const declaredBrowserCallbackCount = [...universalRows.values()].filter((binding) =>
    binding.browserCallback?.registryEligible === true).length;
  assert(browserCallbackCount === declaredBrowserCallbackCount,
    `browser callback-registry applicability drifted: ${browserCallbackCount} != ${declaredBrowserCallbackCount}`);

  // Normalize repeated target dispositions into one lane dictionary and four
  // dense lane IDs per route. The report stays compact while still making the
  // total target partition mechanically enumerable.
  const applicabilityLanes = [];
  const applicabilityLaneIds = new Map();
  for (const route of routes) {
    route.applicability = targetOrder.map((target) => {
      const disposition = route.targetApplicability[target];
      const identity = canonicalJson({ target, ...disposition });
      let laneId = applicabilityLaneIds.get(identity);
      if (laneId === undefined) {
        laneId = applicabilityLanes.length;
        applicabilityLaneIds.set(identity, laneId);
        applicabilityLanes.push({ id: laneId, target, ...disposition, routeCount: 0 });
      }
      applicabilityLanes[laneId].routeCount += 1;
      return laneId;
    });
    delete route.targetApplicability;
    delete route.backendSelections;
  }

  const exactVectors = [];
  const exactVectorIds = new Map();
  for (const route of routes) {
    const { laneOverride, ...contract } = route.exactVector;
    const identity = canonicalJson(contract);
    let contractId = exactVectorIds.get(identity);
    if (contractId === undefined) {
      contractId = exactVectors.length;
      exactVectorIds.set(identity, contractId);
      exactVectors.push({ id: contractId, ...contract });
    }
    route.exactVector = laneOverride === undefined
      ? { contract: contractId }
      : { contract: contractId, laneOverride };
  }

  const summary = {
    routeCount: routes.length,
    shapeCount: shapeList.length,
    contractCount: new Set(routes.map((route) => route.contract)).size,
    marshallingProgramCount: new Set(routes.map((route) => route.marshallingPrograms.dynamicHermesJsi)).size,
    handleKindsMintedByRecordedResults: [...pool].sort((a, b) => a - b).map(handleName),
    handleKindsMintedByGeneratedFixtures: handleSeeds.map(({ name }) => name),
    harnessByTransport: Object.fromEntries(transportOrder.map((transport) => [transport, {
      exercised: routes.filter((route) => route.transports[transport].status === "exercise").length,
      skipped: routes.filter((route) => route.transports[transport].status === "skip").length
    }])),
    targetApplicability,
    luaAdapter: {
      profile: luaAdapterProfile,
      installed: routes.length,
      exercised: routes.filter((route) => route.luaAdapter.status === "exercise").length,
      skipped: routes.filter((route) => route.luaAdapter.status === "skip").length,
      failureSchema: "deherm-script-lua-exact-failure/v1"
    },
    browserCallbackExact: {
      routeCount: routes.filter((route) =>
        route.exactVector.laneOverride?.lane === "browser-wasm-callback-registry").length,
      callbackCount: routes.reduce((count, route) =>
        count + (route.exactVector.laneOverride?.lane === "browser-wasm-callback-registry"
          ? route.exactVector.laneOverride.callbackSlots.length : 0), 0),
      resultSchema: "deherm-script-browser-callback-exact-result/v1",
      lifecycleCoverage: "generic-token-round-trip"
    },
    browserExact: {
      routeCount: targetApplicability["browser-wasm"].status.exercise,
      callbackRouteCount: routes.filter((route) =>
        route.exactVector.laneOverride?.lane === "browser-wasm-callback-registry").length,
      callbackCount: routes.reduce((count, route) =>
        count + (route.exactVector.laneOverride?.lane === "browser-wasm-callback-registry"
          ? route.exactVector.laneOverride.callbackSlots.length : 0), 0),
      resultSchema: "deherm-script-browser-exact-result/v1",
      lifecycleCoverage: "generic-token-round-trip"
    },
    blockerCount: blockers.length
  };

  return {
    schemaVersion: 2,
    defoldRevision: projection.defoldRevision,
    scope: "generated-script-recording-engine",
    evidenceBoundary: [
      "This harness proves only that the generated binding stack matches this",
      "repository's declared contract for each route. It is a null/observer",
      "engine: it is not Defold, and nothing here is engine conformance",
      "evidence. Trace records are keyed by the canonical lowering plan's",
      "interned contract index so a later real-engine differential can diff",
      "against them per contract."
    ].join(" "),
    planSha256: canonicalPlanMatchesRevision ? loweringPlan.planSha256 : sha256(canonicalJson({
      kind: "projection-derived-recording-fallback",
      revision: projection.defoldRevision,
      projection: inputHashes.projection,
      universal: inputHashes.universal,
      handleLowering: inputHashes.handleLowering,
      contracts: fallbackContracts
    })),
    planFallback: canonicalPlanMatchesRevision ? null : {
      code: "canonical-lowering-plan-revision-unavailable",
      severity: "warning",
      requestedRevision: projection.defoldRevision,
      availableRevision: loweringPlan.defoldRevision,
      fallback: "projection-derived-contract-and-universal-marshalling",
      routeCount: routes.length,
      proof: "generated-and-recording-harness-unverified-for-this-revision"
    },
    inputHashes,
    planInputDrift,
    transports: {
      drivable: transportOrder,
      undrivable: undrivableTransports
    },
    applicabilityCatalog: {
      schema: "deherm-script-target-applicability/v1",
      targets: targetOrder,
      routeCount: routes.length,
      rule: "canonical-lowering-selection-plus-generated-adapter-specialization",
      lanes: applicabilityLanes
    },
    exactVectorCatalog: {
      schema: "deherm-script-exact-vector/v1",
      vectors: exactVectors
    },
    semanticHandleKindNames: semanticNames,
    handleSeeds,
    text: text.entries,
    shapes: shapeList,
    order: ordered.map((route) => route.id),
    routes,
    blockers: blockers.sort((left, right) =>
      compareCodeUnits(left.route, right.route) || compareCodeUnits(left.code, right.code)),
    summary
  };
}

/** Deterministic expected trace derived from the contract, not from execution. */
export function renderExpectedTrace(model) {
  const names = model.semanticHandleKindNames;
  const byId = new Map(model.routes.map((route) => [route.id, route]));
  const lines = [];
  lines.push(`# generated-script-recording-engine v${model.schemaVersion}`);
  lines.push(`# defold-revision ${model.defoldRevision}`);
  lines.push(`# lowering-plan ${model.planSha256}`);
  lines.push("# expectation derived from the declared contract; not engine conformance");
  for (const transport of model.transports.drivable) {
    for (const id of model.order) {
      const route = byId.get(id);
      const disposition = route.transports[transport];
      const head = `${route.canonical} ${transport} c${route.contract}`;
      if (disposition.status === "skip") {
        lines.push(`skip ${head} ${disposition.reason}`);
        continue;
      }
      const args = route.argumentShapes.map((index, slot) =>
        renderShapeSpec(model.shapes, index, names, slot + 1));
      const results = route.resultShapes.map((index, slot) =>
        renderShapeSpec(model.shapes, index, names, 257 + slot));
      lines.push(`call ${head} arity=${route.arity.driven} args=[${args.join(" ")}] ctx=${route.context}`);
      lines.push(`recv ${head} results=${route.results.driven} [${results.join(" ")}]`);
      lines.push(`end ${head} status=ok`);
    }
  }
  return `${lines.join("\n")}\n`;
}
