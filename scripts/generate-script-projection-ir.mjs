import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { expectReviewedCount } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const outputUrl = new URL("packages/bindings/generated/defold-script-projection-ir.json", root);

export const inputPaths = Object.freeze({
  ir: "packages/bindings/generated/defold-script-api-ir.json",
  patterns: "packages/bindings/generated/defold-script-binding-patterns.json",
  accounting: "packages/bindings/generated/defold-script-api-accounting.json",
  values: "packages/bindings/generated/defold-script-value-bindings.json",
  callbacks: "packages/bindings/generated/defold-script-callback-lifecycle.json",
  handles: "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  urls: "packages/bindings/generated/defold-script-url-address-classification.json",
  tuples: "packages/bindings/generated/defold-script-fixed-tuples.json",
  dynamics: "packages/bindings/generated/defold-script-dynamic-value-bindings.json",
  tails: "packages/bindings/generated/defold-script-value-tail-bindings.json",
  overloads: "packages/bindings/generated/defold-script-overload-dispatch.json",
  tableSchemas: "packages/bindings/generated/defold-script-table-tuple-schemas.json",
  tableRecords: "packages/bindings/generated/defold-script-table-record-bindings.json",
  copiedRecords: "packages/bindings/generated/defold-script-copied-value-record-blockers.json",
  opaqueRecords: "packages/bindings/generated/defold-script-opaque-record-blockers.json",
  engineMatrix: "packages/bindings/generated/defold-script-real-engine-matrix.json",
  availabilityProfiles: "packages/bindings/generated/defold-script-route-availability-profiles.json",
  // The registered-vs-declared gate. Its findings are the subset of the Lua
  // registration verifier that carries positive evidence in C source and holds
  // in every mutually exclusive engine build variant, so they are acted on here
  // rather than only reported.
  registrationGate: "packages/bindings/generated/defold-lua-registration-gate.json"
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function indexRows(rows, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!row?.id) throw new Error(`${label} contains a row without an id`);
    if (result.has(row.id)) throw new Error(`${label} contains duplicate id ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

function reportRows(report) {
  return report?.rows ?? report?.routes ?? report?.bindings ?? report?.entries ?? [];
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
  let round = 0;
  let angle = 0;
  let brace = 0;
  let square = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "<") angle += 1;
    else if (character === ">") angle -= 1;
    else if (character === "{") brace += 1;
    else if (character === "}") brace -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === delimiter && round === 0 && angle === 0 && brace === 0 && square === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
    if (round < 0 || angle < 0 || brace < 0 || square < 0) {
      throw new Error(`unbalanced type expression: ${text}`);
    }
  }
  if (round !== 0 || angle !== 0 || brace !== 0 || square !== 0) {
    throw new Error(`unbalanced type expression: ${text}`);
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const scalarKinds = Object.freeze({
  boolean: "boolean",
  number: "number",
  integer: "integer",
  string: "string",
  nil: "nil"
});

const defoldValueNames = new Set([
  "hash", "url", "vector", "vector3", "vector4", "quaternion", "matrix4", "node",
  "buffer", "buffer_data", "buffer_stream", "constant_buffer", "render_predicate",
  "render_target", "resource_data", "texture", "timer_handle"
]);

function normalizeUnion(variants) {
  const flattened = variants.flatMap((variant) => variant.kind === "union" ? variant.variants : [variant]);
  const unique = [...new Map(flattened.map((variant) => [JSON.stringify(variant), variant])).values()];
  const nilIndex = unique.findIndex((variant) => variant.kind === "scalar" && variant.name === "nil");
  if (nilIndex !== -1 && unique.length === 2) {
    const [value] = unique.filter((_, index) => index !== nilIndex);
    return { kind: "optional", value };
  }
  return { kind: "union", variants: unique };
}

function parseRecord(text, codecHints) {
  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return { kind: "record", fields: [] };
  return {
    kind: "record",
    fields: splitTopLevel(inner, ",").map((field) => {
      const separator = field.indexOf(":");
      if (separator === -1) return { name: field, optional: false, value: { kind: "unknown", source: field } };
      const rawName = field.slice(0, separator).trim();
      return {
        name: rawName.replace(/\?$/, ""),
        optional: rawName.endsWith("?"),
        value: parseValueShape(field.slice(separator + 1).trim(), codecHints)
      };
    })
  };
}

function parseCallback(text) {
  const close = text.lastIndexOf(")");
  const parameterText = text.slice(4, close);
  const resultText = text.slice(close + 1).replace(/^\s*:\s*/, "").trim();
  const parameters = parameterText.length === 0 ? [] : splitTopLevel(parameterText, ",").map((parameter, index) => {
    const separator = parameter.indexOf(":");
    if (separator === -1) {
      return parameter === "..." || parameter.startsWith("...")
        ? { name: `rest${index}`, optional: false, variadic: true, value: { kind: "dynamic" } }
        : { name: `arg${index}`, optional: false, variadic: false, value: { kind: "unknown", source: parameter } };
    }
    const rawName = parameter.slice(0, separator).trim();
    const rawType = parameter.slice(separator + 1).trim();
    return {
      name: rawName.replace(/^\.\.\./, "").replace(/\?$/, ""),
      optional: rawName.endsWith("?"),
      variadic: rawName.startsWith("..."),
      value: parseValueShape(rawType, [])
    };
  });
  return {
    kind: "callback",
    parameters,
    returns: resultText.length === 0 ? [] : [parseValueShape(resultText, [])]
  };
}

export function parseValueShape(rawType, codecHints = []) {
  const text = String(rawType ?? "nil").trim();
  if (text === "...") return { kind: "variadic", value: { kind: "dynamic" } };
  if (text === "any" || text === "T") return { kind: "dynamic" };

  const unionParts = splitTopLevel(text, "|");
  if (unionParts.length > 1) return normalizeUnion(unionParts.map((part) => parseValueShape(part, codecHints)));
  if (text.startsWith("fun(")) return parseCallback(text);

  if (text.endsWith("[]")) {
    return { kind: "sequence", element: parseValueShape(text.slice(0, -2), codecHints) };
  }
  if (text.startsWith("(") && text.endsWith(")")) return parseValueShape(text.slice(1, -1), codecHints);
  if (text.startsWith("{") && text.endsWith("}")) return parseRecord(text, codecHints);
  if (text.startsWith("table<") && text.endsWith(">")) {
    const arguments_ = splitTopLevel(text.slice(6, -1), ",");
    if (arguments_.length !== 2) return { kind: "unknown", source: text };
    return {
      kind: "map",
      key: parseValueShape(arguments_[0], []),
      value: parseValueShape(arguments_[1], [])
    };
  }
  if (scalarKinds[text]) return { kind: "scalar", name: scalarKinds[text] };
  if (defoldValueNames.has(text) || codecHints.includes("value")) return { kind: "defold-value", name: text };
  if (codecHints.includes("handle")) return { kind: "handle", name: text };
  if (codecHints.includes("callback")) return { kind: "callback", signature: text };
  if (codecHints.includes("table")) return { kind: "record-ref", name: text };
  if (/\.[A-Z][A-Z0-9_]*$/.test(text)) return { kind: "enum", name: text };
  if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) return { kind: "enum", name: text };
  return { kind: "named", name: text };
}

function walkShape(shape, visitor, depth = 0) {
  visitor(shape, depth);
  if (shape.kind === "optional") walkShape(shape.value, visitor, depth + 1);
  else if (shape.kind === "union") shape.variants.forEach((value) => walkShape(value, visitor, depth + 1));
  else if (shape.kind === "sequence") walkShape(shape.element, visitor, depth + 1);
  else if (shape.kind === "map") {
    walkShape(shape.key, visitor, depth + 1);
    walkShape(shape.value, visitor, depth + 1);
  } else if (shape.kind === "record") shape.fields.forEach(({ value }) => walkShape(value, visitor, depth + 1));
  else if (shape.kind === "callback" && shape.parameters) {
    shape.parameters.forEach(({ value }) => walkShape(value, visitor, depth + 1));
    shape.returns.forEach((value) => walkShape(value, visitor, depth + 1));
  } else if (shape.kind === "variadic") walkShape(shape.value, visitor, depth + 1);
}

function shapeFacts(shapes) {
  const facts = { callback: false, handle: false, variadic: false, recursive: false, unknown: [] };
  for (const shape of shapes) walkShape(shape, (entry, depth) => {
    if (entry.kind === "callback") facts.callback = true;
    if (entry.kind === "handle") facts.handle = true;
    if (entry.kind === "variadic") facts.variadic = true;
    if (["map", "record", "sequence"].includes(entry.kind) && depth > 0) facts.recursive = true;
    if (entry.kind === "unknown") facts.unknown.push(entry.source);
  });
  facts.unknown = [...new Set(facts.unknown)].sort();
  return facts;
}

function normalizeContextToken(value) {
  const token = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return ({
    guiscriptinstance: "gui-script-instance",
    renderscriptinstance: "render-script-instance",
    scriptinstance: "script-instance"
  })[token] ?? token;
}

function moduleAvailability(modulePath) {
  const rootModule = modulePath[0] ?? "global";
  if (rootModule === "b2d") return { token: "module-derived-provisional", anyOf: ["box2d-v2", "box2d-v3"] };
  if (rootModule === "bullet3d") return { token: "module-derived-provisional", allOf: ["bullet3d"] };
  if (rootModule === "html5") return { token: "html5-host", allOf: ["html5"] };
  return { token: "core", allOf: ["defold-core"] };
}

function buildAvailabilityIndex(report, defoldRevision) {
  if (report.defoldRevision !== defoldRevision) {
    throw new Error("script availability catalog revision is stale against the script IR");
  }
  if (!/^[0-9a-f]{64}$/.test(report.catalogSha256 ?? "")) {
    throw new Error("script availability catalog has no valid catalog digest");
  }
  const result = new Map();
  const ensure = (route) => {
    const current = result.get(route.stableId) ?? {
      id: route.id,
      documentedFeatures: new Set(),
      runtimeFeatures: new Set(),
      documentedProfiles: new Set(),
      runtimeProfiles: new Set()
    };
    if (current.id !== route.id) throw new Error(`availability stable-ID collision at ${route.stableId}`);
    result.set(route.stableId, current);
    return current;
  };
  for (const [feature, entry] of Object.entries(report.features ?? {})) {
    for (const route of entry.documentedRoutes ?? []) ensure(route).documentedFeatures.add(feature);
    for (const route of entry.availableRoutes ?? []) ensure(route).runtimeFeatures.add(feature);
  }
  for (const [profile, entry] of Object.entries(report.profiles ?? {})) {
    for (const route of entry.documentedRoutes ?? []) ensure(route).documentedProfiles.add(profile);
    for (const route of entry.availableRoutes ?? []) ensure(route).runtimeProfiles.add(profile);
  }
  return { catalogSha256: report.catalogSha256, routes: result };
}

// Group the gate's findings by the documented route name they address. The
// verifier names a route exactly as the script IR does, so nothing is matched
// by shape or by prefix.
function buildRegistrationGate(gate, defoldRevision) {
  if (gate.defoldRevision !== defoldRevision) {
    throw new Error("Lua registration gate revision is stale against the script IR");
  }
  if (!/^[0-9a-f]{64}$/.test(gate.sourceReportSha256 ?? "")) {
    throw new Error("Lua registration gate has no valid source-report digest");
  }
  const byRoute = new Map();
  for (const finding of gate.findings ?? []) {
    if (!finding.route) throw new Error("Lua registration gate contains a finding without a route");
    byRoute.set(finding.route, [...(byRoute.get(finding.route) ?? []), finding]);
  }
  return { sourceReportSha256: gate.sourceReportSha256, byRoute };
}

// Apply source-derived corrections without suppressing the documented API.
// Verification never grants permission to emit: every documented route keeps
// its generated TypeScript signature and transport machinery. A name mismatch
// changes only the Lua lookup used at runtime; a positively absent source route
// is carried as availability evidence, not erased from the SDK.
function applyRegistrationGate(gate, fn, parameters) {
  const findings = gate.byRoute.get(fn.rawName) ?? [];
  if (!findings.length) {
    return {
      registration: { token: "registration-verified", sourceReportSha256: gate.sourceReportSha256, findings: [] },
      runtimeRawName: fn.rawName,
      holes: []
    };
  }
  const holes = [];
  const applied = [];
  let runtimeRawName = fn.rawName;
  for (const finding of findings) {
    if (finding.action === "use-registered-name") {
      if (typeof finding.callableAs !== "string" || !finding.callableAs.includes(".")) {
        throw new Error(`${fn.rawName}: registered-name correction has no qualified callableAs`);
      }
      runtimeRawName = finding.callableAs;
      applied.push({ kind: finding.kind, action: finding.action, parameter: null, callableAs: finding.callableAs, reason: finding.reason });
      continue;
    }
    if (finding.action === "mark-source-unavailable") {
      holes.push(`registration:${finding.kind}`);
      applied.push({ kind: finding.kind, action: finding.action, parameter: null, callableAs: null, reason: finding.reason });
      continue;
    }
    if (finding.action === "require-parameter") {
      const slot = parameters[finding.parameter.index - 1];
      if (!slot) throw new Error(`${fn.rawName}: gate corrects parameter ${finding.parameter.index}, which the script IR does not declare`);
      if (slot.name !== finding.parameter.name) {
        throw new Error(`${fn.rawName}: gate corrects parameter '${finding.parameter.name}' but the script IR declares '${slot.name}'`);
      }
      slot.optional = false;
      slot.optionalityCorrectedBy = "lua-registration-gate";
      applied.push({ kind: finding.kind, action: finding.action, parameter: finding.parameter, callableAs: null, reason: finding.reason });
      continue;
    }
    throw new Error(`${fn.rawName}: unknown Lua registration gate action '${finding.action}'`);
  }
  return {
    registration: {
      token: holes.length ? "registration-source-unavailable" : "registration-corrected",
      sourceReportSha256: gate.sourceReportSha256,
      findings: applied
    },
    runtimeRawName,
    holes
  };
}

function routeAvailability(fn, stableId, catalog) {
  const exact = catalog.routes.get(stableId);
  if (!exact) return moduleAvailability(fn.modulePath);
  if (exact.id !== fn.id) throw new Error(`${fn.id}: availability catalog identity drifted`);
  return {
    token: "source-derived-profile-catalog",
    catalogSha256: catalog.catalogSha256,
    documentedFeatures: [...exact.documentedFeatures].sort(),
    runtimeFeatures: [...exact.runtimeFeatures].sort(),
    documentedProfiles: [...exact.documentedProfiles].sort(),
    runtimeProfiles: [...exact.runtimeProfiles].sort(),
    runtimeAvailable: exact.runtimeProfiles.size > 0
  };
}

function rawTargetSupport(...rows) {
  return rows.flatMap((row) => row?.targetSupport ? [{ source: row.id, support: row.targetSupport }] : []);
}

function normalizedDisposition(category, target) {
  if (category === "component-property-compiler") return "compile-time-intrinsic";
  if (category === "separate-module") return "separate-module";
  if (category === "pending") return "projection-emitted-lowering-pending";
  if (target === "native-dynamic-hermes") return "backend-emitted";
  return "projection-emitted-backend-policy-required";
}

function selectContext({ handle, callback, tail, tuple, tableRecord, value }) {
  if (handle?.requiredContext) return { token: handle.requiredContext, source: "borrowed-handle-ledger" };
  if (callback?.invocationContext) return { token: callback.invocationContext, source: "callback-lifecycle-ledger" };
  if (tail?.requiredContext) return { token: tail.requiredContext, source: "value-tail-ledger" };
  if (tableRecord?.requiredContext) return { token: tableRecord.requiredContext, source: "table-record-ledger" };
  if (tuple?.context) return { token: normalizeContextToken(tuple.context), source: "fixed-tuple-ledger" };
  const valueContext = value?.operation?.parameters?.context;
  if (valueContext) return { token: valueContext, source: "value-binding-ledger" };
  return { token: "context-policy-unresolved", source: "projection-default" };
}

function evidenceFor(accounting, matrix) {
  const noStageEvidence = {
    compile: { status: "unverified", observationIds: [] },
    link: { status: "unverified", observationIds: [] },
    runtime: { status: "unverified", observationIds: [] }
  };
  return {
    accountingCategory: accounting.category,
    generator: accounting.evidence?.generator ?? null,
    generatedFamily: accounting.evidence?.generatedFamily ?? null,
    stages: matrix?.evidence ?? noStageEvidence
  };
}

function countBy(rows, selector) {
  const result = {};
  for (const row of rows) {
    const key = selector(row);
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export function generateScriptProjectionIr(textInputs) {
  const parsed = Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, parseJson(text, name)]));
  const { ir, patterns, accounting } = parsed;
  if (ir.counts?.functions !== 926 || ir.functions?.length !== 926) {
    expectReviewedCount({
      input: "scripts/generate-script-projection-ir.mjs", label: "script IR function census",
      expected: 926, observed: ir.functions?.length ?? -1
    });
  }
  if (patterns.classifiedFunctionCount !== patterns.bindings?.length || accounting.functionCount !== ir.functions.length) {
    throw new Error("script pattern/accounting census is stale against the script IR");
  }
  const availabilityCatalog = buildAvailabilityIndex(parsed.availabilityProfiles, ir.defoldRevision);
  const registrationGate = buildRegistrationGate(parsed.registrationGate, ir.defoldRevision);

  const indexes = {
    patterns: indexRows(patterns.bindings, "patterns"),
    accounting: indexRows(accounting.rows, "accounting"),
    values: indexRows(reportRows(parsed.values), "values"),
    callbacks: indexRows(reportRows(parsed.callbacks), "callbacks"),
    handles: indexRows(reportRows(parsed.handles), "handles"),
    urls: indexRows(reportRows(parsed.urls), "urls"),
    tuples: indexRows(reportRows(parsed.tuples), "tuples"),
    dynamics: indexRows(reportRows(parsed.dynamics), "dynamics"),
    tails: indexRows(reportRows(parsed.tails), "tails"),
    overloads: indexRows(reportRows(parsed.overloads), "overloads"),
    tableSchemas: indexRows(reportRows(parsed.tableSchemas), "tableSchemas"),
    tableRecords: indexRows(reportRows(parsed.tableRecords), "tableRecords"),
    tableRecordBlockers: indexRows(parsed.tableRecords.blockedRoutes, "tableRecordBlockers"),
    copiedRecords: indexRows(reportRows(parsed.copiedRecords), "copiedRecords"),
    opaqueRecords: indexRows(reportRows(parsed.opaqueRecords), "opaqueRecords"),
    engineMatrix: indexRows(reportRows(parsed.engineMatrix), "engineMatrix")
  };

  const ids = ir.functions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("script IR contains duplicate function ids");
  for (const id of ids) {
    if (!indexes.accounting.has(id)) throw new Error(`script accounting projection omits ${id}`);
    const account = indexes.accounting.get(id);
    if (!indexes.patterns.has(id) && account.category !== "separate-module") {
      throw new Error(`script pattern projection omits non-separate route ${id}`);
    }
  }
  for (const [name, index] of Object.entries(indexes)) {
    for (const id of index.keys()) {
      if (!ids.includes(id)) throw new Error(`${name} contains route absent from script IR: ${id}`);
    }
  }

  const rows = ir.functions.map((fn) => {
    const pattern = indexes.patterns.get(fn.id) ?? {
      loweringFamily: "separate-module",
      parameterCodecs: fn.parameters.map(() => ({ codecs: [] })),
      returnCodecs: fn.returns.map(() => ({ codecs: [] })),
      traits: []
    };
    const account = indexes.accounting.get(fn.id);
    const related = Object.fromEntries(Object.entries(indexes).map(([name, index]) => [name, index.get(fn.id)]));
    const stableId = stableBindingId(fn.id);
    const parameters = fn.parameters.map((parameter, index) => ({
      name: parameter.rawName,
      optional: parameter.optional,
      value: parseValueShape(parameter.rawType, pattern.parameterCodecs[index]?.codecs ?? []),
      sourceType: parameter.rawType
    }));
    // The C source outranks the declaration: a slot the body refuses to default
    // is corrected here, and a differently registered name becomes the runtime
    // lookup without suppressing the documented public route.
    const gated = applyRegistrationGate(registrationGate, fn, parameters);
    const runtimeSegments = gated.runtimeRawName.split(".");
    const runtimeMember = runtimeSegments.pop();
    const returns = fn.returns.map((rawType, index) => ({
      index,
      value: parseValueShape(rawType, pattern.returnCodecs[index]?.codecs ?? []),
      sourceType: rawType
    }));
    const facts = shapeFacts([...parameters.map(({ value }) => value), ...returns.map(({ value }) => value)]);
    const context = account.category === "component-property-compiler"
      ? { token: "component-property-compiler", source: "component-proxy-generator" }
      : selectContext({
          handle: related.handles,
          callback: related.callbacks,
          tail: related.tails,
          tuple: related.tuples,
          tableRecord: related.tableRecords,
          value: related.values
        });
    const invalidation = related.handles?.invalidatedIdentity
      ? { token: "invalidate-underlying-identity", identity: related.handles.invalidatedIdentity, hostHandle: related.handles.hostHandleEffect }
      : { token: "none" };
    const callback = related.callbacks ? {
      token: "retained-lua-closure",
      lifetime: related.callbacks.lifetime,
      owner: related.callbacks.owner,
      threadAffinity: related.callbacks.threadAffinity,
      registryEligible: related.callbacks.registryEligible
    } : facts.callback ? { token: "callback-policy-unresolved" } : { token: "none" };
    const semanticHoles = [];
    if (context.token === "context-policy-unresolved") semanticHoles.push("context-policy");
    if (callback.token === "callback-policy-unresolved") semanticHoles.push("callback-lifetime-policy");
    if (facts.handle && !related.handles) semanticHoles.push("handle-ownership-lifetime-policy");
    if (facts.unknown.length > 0) semanticHoles.push("value-shape-parser");
    semanticHoles.push(...gated.holes);
    if (account.category === "pending") semanticHoles.push(`lowering:${account.reason.loweringFamily}`);
    const explicitBlockers = [
      related.dynamics?.blocker,
      related.tails?.blocker,
      related.overloads?.blocker,
      related.tableRecordBlockers?.blocker,
      related.copiedRecords?.blocker,
      related.opaqueRecords?.blocker
    ].filter(Boolean);
    semanticHoles.push(...explicitBlockers.map((blocker) => `policy:${blocker}`));

    return {
      id: fn.id,
      stableId,
      rawName: fn.rawName,
      modulePath: fn.modulePath,
      member: fn.member,
      runtimeRawName: gated.runtimeRawName,
      runtimeModulePath: runtimeSegments,
      runtimeMember,
      source: { path: fn.source, line: fn.line },
      loweringFamily: pattern.loweringFamily,
      signature: {
        parameters,
        returns,
        overloadTokens: [...fn.overloads],
        genericTokens: [...fn.generics]
      },
      context,
      availability: routeAvailability(fn, stableId, availabilityCatalog),
      registration: gated.registration,
      effects: {
        ownership: related.handles ? {
          token: "generation-checked-host-handle",
          inputKinds: related.handles.inputHandleKinds,
          returnKinds: related.handles.returnHandleKinds,
          hostHandleEffect: related.handles.hostHandleEffect
        } : facts.handle ? {
          token: "handle-ownership-policy-unresolved"
        } : { token: "copied-or-call-local-value" },
        lifetime: related.callbacks
          ? { token: related.callbacks.lifetime, owner: related.callbacks.owner }
          : facts.handle ? { token: "handle-lifetime-policy-unresolved" } : { token: "call-local" },
        invalidation,
        callback,
        variadic: (facts.variadic || pattern.traits.includes("variable-arguments") || pattern.traits.includes("variable-results"))
          ? { token: "runtime-arity", traits: pattern.traits.filter((trait) => trait.startsWith("variable-")) }
          : { token: "fixed-arity" },
        recursive: facts.recursive || pattern.loweringFamily === "lua-table"
          ? { token: "recursive-value-graph", cyclePolicy: "policy-unresolved" }
          : { token: "acyclic-value-shape" }
      },
      targets: {
        nativeDynamicHermes: { disposition: normalizedDisposition(account.category, "native-dynamic-hermes") },
        nativeStaticHermes: { disposition: normalizedDisposition(account.category, "native-static-hermes") },
        html5BrowserHost: { disposition: normalizedDisposition(account.category, "html5-browser-host") },
        sourcePolicies: rawTargetSupport(related.values, related.urls, related.tuples, related.dynamics, related.overloads)
      },
      generation: {
        state: "projected",
        deterministic: true,
        semanticHoles
      },
      evidence: evidenceFor(account, related.engineMatrix)
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const projectedIds = rows.map(({ id }) => id);
  if (new Set(projectedIds).size !== ir.functions.length) throw new Error("projection does not cover every script route exactly once");
  const projectedStableIds = rows.map(({ stableId }) => stableId);
  if (new Set(projectedStableIds).size !== rows.length) throw new Error("script projection contains a stable-ID collision");
  const holeRows = rows.filter(({ generation }) => generation.semanticHoles.length > 0);
  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "Normalized value-shape/effect algebra for every imported Defold script function. Projection state is intentionally independent of compile/link/runtime evidence.",
    constructors: [
      "scalar", "dynamic", "named", "enum", "defold-value", "handle", "record-ref", "record",
      "sequence", "map", "union", "optional", "callback", "variadic", "unknown"
    ],
    inputHashes: Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, sha256(text)])),
    routeCount: rows.length,
    generationCounts: countBy(rows, ({ generation }) => generation.state),
    accountingCounts: countBy(rows, ({ evidence }) => evidence.accountingCategory),
    loweringFamilyCounts: countBy(rows, ({ loweringFamily }) => loweringFamily),
    contextCounts: countBy(rows, ({ context }) => context.token),
    availabilityCounts: countBy(rows, ({ availability }) => availability.token),
    registrationCounts: countBy(rows, ({ registration }) => registration.token),
    semanticHoleCounts: countBy(holeRows.flatMap((row) => row.generation.semanticHoles.map((hole) => ({ hole }))), ({ hole }) => hole),
    semanticHoles: holeRows.map(({ id, generation }) => ({ id, tokens: generation.semanticHoles })),
    rows
  };
}

export async function loadScriptProjectionInputs() {
  return Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([name, path]) => [
    name,
    await readFile(new URL(path, root), "utf8")
  ])));
}

async function main() {
  const generated = generateScriptProjectionIr(await loadScriptProjectionInputs());
  const serialized = `${JSON.stringify(generated, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const checked = await readFile(outputUrl, "utf8");
    if (checked !== serialized) throw new Error("defold-script-projection-ir.json is stale; regenerate it");
    return;
  }
  await writeFile(outputUrl, serialized);
  console.log(`generated ${generated.routeCount} script projection rows`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
