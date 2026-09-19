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

/** Transports the canonical plan models but this harness cannot drive itself. */
export const undrivableTransports = Object.freeze([
  Object.freeze({
    transport: "lua-stack",
    runtime: "hermes",
    reason: "lua-stack-requires-a-real-lua-engine-below-the-recorded-seam"
  })
]);

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
export function renderShapeSpec(shapes, index, semanticNames) {
  const shape = shapes[index];
  switch (shape.code) {
    case SHAPE.undefined: return "undef";
    case SHAPE.null: return "null";
    case SHAPE.boolean: return "bool";
    case SHAPE.number: return "num";
    case SHAPE.string: return "str:6";
    case SHAPE.hash: return "hash";
    case SHAPE.url: return "url";
    case SHAPE.handle: return `h:${semanticNames[shape.aux] ?? "unknown"}`;
    case SHAPE.guiNode: return "h:gui-node";
    case SHAPE.userdata: return "h:lua-userdata";
    case SHAPE.vector3: return "dv:v3";
    case SHAPE.vector4: return "dv:v4";
    case SHAPE.quaternion: return "dv:quat";
    case SHAPE.matrix4: return "dv:mat4";
    case SHAPE.sequence:
      return `seq(${shape.children.map((child) => renderShapeSpec(shapes, child, semanticNames)).join(",")})`;
    case SHAPE.record:
      return `rec(${shape.children.map((child) => {
        const field = shapes[child];
        return `${field.keyText}=${renderShapeSpec(shapes, child, semanticNames)}`;
      }).join(",")})`;
    case SHAPE.map:
      return `map(${renderShapeSpec(shapes, shape.children[0], semanticNames)}=>${renderShapeSpec(shapes, shape.children[1], semanticNames)})`;
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
  const { projection, universal, handleLowering, loweringPlan, inputHashes } = inputs;

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
  const fallbackContracts = [...new Set(universal.bindings.map((binding) => {
    const row = projectionRows.get(binding.id);
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

  const routes = [];
  for (const binding of [...universal.bindings].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const row = projectionRows.get(binding.id);
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
    const argumentShapes = parameters.slice(0, argumentCount)
      .map((parameter) => lower(binding.id, parameter.value, parameter.name));
    const resultCount = Math.min(returns.length, binding.maximumResultCount);
    const resultShapes = returns.slice(0, resultCount).map((result) => lower(binding.id, result.value));

    const route = {
      id: binding.id,
      stableId: binding.stableId,
      canonical: binding.id.slice("script:".length),
      loweringFamily: binding.loweringFamily,
      contract: unit.contractDetails,
      contractTokens: unit.contract,
      marshallingPrograms: Object.fromEntries(Object.entries(unit.backends)
        .map(([backend, disposition]) => [backend, disposition.marshallingProgram])),
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
      transports: {}
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
    } else if (resultsHave(route, (shape) => shape.code === SHAPE.callback)) {
      universalSkip = "result-callback-is-not-synthesizable";
    } else if (argumentsHave(route, (shape) => shape.code === SHAPE.callback)) {
      universalSkip = "callback-argument-lifetime-is-not-modelled-by-the-recorder";
    }
    route.universalSkip = universalSkip;
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

  for (const route of routes) {
    const missing = [...needs.get(route.id)].filter((kind) => !pool.has(kind)).sort((a, b) => a - b);
    for (const transport of transportOrder) {
      let status = "exercise";
      let reason = "";
      if (route.universalSkip) {
        status = "skip";
        reason = route.universalSkip;
      } else if (transport === "jsi" && missing.length) {
        status = "skip";
        reason = `no-recorded-handle-source:${missing.map(handleName).join("+")}`;
      } else if (transport === "typed-native" && argumentsHave(route,
        (shape) => shape.code === SHAPE.url || shape.code === SHAPE.matrix4)) {
        status = "skip";
        reason = "static-frame-has-no-url-or-matrix4-argument-push";
      }
      route.transports[transport] = { status, reason };
    }
  }

  const summary = {
    routeCount: routes.length,
    shapeCount: shapeList.length,
    contractCount: new Set(routes.map((route) => route.contract)).size,
    marshallingProgramCount: new Set(routes.map((route) => route.marshallingPrograms.dynamicHermesJsi)).size,
    handleKindsMintedByRecordedResults: [...pool].sort((a, b) => a - b).map(handleName),
    byTransport: Object.fromEntries(transportOrder.map((transport) => [transport, {
      exercised: routes.filter((route) => route.transports[transport].status === "exercise").length,
      skipped: routes.filter((route) => route.transports[transport].status === "skip").length
    }])),
    blockerCount: blockers.length
  };

  return {
    schemaVersion: 1,
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
    semanticHandleKindNames: semanticNames,
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
      const args = route.argumentShapes.map((index) => renderShapeSpec(model.shapes, index, names));
      const results = route.resultShapes.map((index) => renderShapeSpec(model.shapes, index, names));
      lines.push(`call ${head} arity=${route.arity.driven} args=[${args.join(" ")}] ctx=${route.context}`);
      lines.push(`recv ${head} results=${route.results.driven} [${results.join(" ")}]`);
      lines.push(`end ${head} status=ok`);
    }
  }
  return `${lines.join("\n")}\n`;
}
