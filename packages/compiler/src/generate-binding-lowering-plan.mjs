import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");

export const inputPaths = Object.freeze({
  scriptProjection: "packages/bindings/generated/defold-script-projection-ir.json",
  scriptScalarDispatch: "packages/bindings/generated/defold-script-scalar-dispatch.json",
  scriptValueBindings: "packages/bindings/generated/defold-script-value-bindings.json",
  scriptFixedTuples: "packages/bindings/generated/defold-script-fixed-tuples.json",
  scriptDynamicValues: "packages/bindings/generated/defold-script-dynamic-value-bindings.json",
  scriptValueTail: "packages/bindings/generated/defold-script-value-tail-bindings.json",
  scriptOverloadDispatch: "packages/bindings/generated/defold-script-overload-dispatch.json",
  scriptTableRecords: "packages/bindings/generated/defold-script-table-record-bindings.json",
  scriptCallbackLifecycle: "packages/bindings/generated/defold-script-callback-lifecycle.json",
  scriptCopiedValueBlockers: "packages/bindings/generated/defold-script-copied-value-record-blockers.json",
  scriptOpaqueRecordBlockers: "packages/bindings/generated/defold-script-opaque-record-blockers.json",
  scriptUrlAddress: "packages/bindings/generated/defold-script-url-address-classification.json",
  scriptHandleLowering: "packages/bindings/generated/defold-script-handle-lowering.json",
  scriptUniversalValue: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  dmsdkProjection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  dmsdkScalarThunks: "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
  dmsdkEnumValues: "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json",
  dmsdkNamedScalars: "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json",
  dmsdkFixedDigests: "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json",
  dmsdkBase64Spans: "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json",
  dmsdkAstcProbes: "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json",
  dmsdkXteaSpans: "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json",
  dmsdkHashSpans: "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
  dmsdkArenaSpanBlockers: "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json",
  dmsdkCStringValue: "packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json",
  dmsdkBorrowedHandle: "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json",
  semanticPolicies: "packages/bindings/overrides/binding-semantic-policies.json",
  typescriptSdk: "packages/bindings/targets/typescript-sdk.json",
  dynamicHermesJsi: "packages/bindings/targets/dynamic-hermes-jsi.json",
  staticHermesCAbi: "packages/bindings/targets/static-hermes-cabi.json",
  luaStack: "packages/bindings/targets/lua-stack.json",
  browserWasmHost: "packages/bindings/targets/browser-wasm-host.json"
});

const targetOrder = Object.freeze([
  "typescriptSdk",
  "dynamicHermesJsi",
  "staticHermesCAbi",
  "luaStack",
  "browserWasmHost"
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const opcodeByKind = Object.freeze({
  scalar: "validate-scalar",
  dynamic: "pass-dynamic",
  named: "validate-named",
  enum: "validate-enum",
  "defold-value": "decode-defold-value",
  handle: "resolve-handle",
  "record-ref": "decode-record-ref",
  record: "decode-record",
  sequence: "decode-sequence",
  map: "decode-map",
  union: "select-union",
  optional: "check-optional",
  callback: "register-callback",
  variadic: "decode-variadic",
  unknown: "reject-unknown",
  void: "no-value",
  cstring: "copy-utf8",
  array: "borrow-fixed-array",
  pointer: "borrow-pointer",
  reference: "borrow-reference",
  "template-record": "decode-template-record",
  template: "instantiate-template",
  "type-parameter": "resolve-type-parameter",
  opaque: "resolve-opaque"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    output: resolve(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"),
    check: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function loadBindingLoweringInputs(root = repositoryRoot) {
  return Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([name, relative]) => [
    name,
    await readFile(resolve(root, relative), "utf8")
  ])));
}

function walkShape(shape, visit, path = "value") {
  if (!shape || typeof shape !== "object") return;
  if (typeof shape.kind === "string") visit(shape, path);
  if (shape.value) walkShape(shape.value, visit, `${path}.value`);
  if (shape.element) walkShape(shape.element, visit, `${path}.element`);
  if (shape.key) walkShape(shape.key, visit, `${path}.key`);
  if (Array.isArray(shape.values)) shape.values.forEach((value, index) => walkShape(value, visit, `${path}.values[${index}]`));
  if (Array.isArray(shape.types)) shape.types.forEach((value, index) => walkShape(value, visit, `${path}.types[${index}]`));
  if (Array.isArray(shape.fields)) shape.fields.forEach((field, index) => walkShape(field.value ?? field.type, visit, `${path}.fields[${index}]`));
  if (Array.isArray(shape.parameters)) shape.parameters.forEach((parameter, index) => walkShape(parameter.value ?? parameter.type, visit, `${path}.parameters[${index}]`));
  if (Array.isArray(shape.returns)) shape.returns.forEach((value, index) => walkShape(value.value ?? value.type ?? value, visit, `${path}.returns[${index}]`));
  if (shape.pointee) walkShape(shape.pointee, visit, `${path}.pointee`);
  if (shape.target) walkShape(shape.target, visit, `${path}.target`);
  if (shape.result) walkShape(shape.result, visit, `${path}.result`);
}

function shapeKinds(signature) {
  const kinds = new Set();
  walkShape(signature, ({ kind }) => kinds.add(kind), "signature");
  return [...kinds].sort(compareCodeUnits);
}

function marshallingProgram(signature, invoker) {
  const operations = [];
  const parameters = signature.parameters ?? [];
  for (let index = 0; index < parameters.length; index += 1) {
    const shape = parameters[index].value ?? parameters[index].type;
    walkShape(shape, ({ kind, name }, shapePath) => operations.push({
      op: opcodeByKind[kind] ?? "reject-unrecognized-constructor",
      phase: "input",
      path: shapePath,
      kind,
      ...(name ? { type: name } : {})
    }), `parameters[${index}]`);
  }
  operations.push({ op: invoker === "cached-lua-route" ? "call-cached-lua" : "call-native-symbol", phase: "invoke" });
  const returns = signature.returns ?? (signature.result ? [signature.result] : []);
  for (let index = 0; index < returns.length; index += 1) {
    const shape = returns[index].value ?? returns[index].type ?? returns[index];
    walkShape(shape, ({ kind, name }, shapePath) => operations.push({
      op: `encode-${opcodeByKind[kind] ?? "unrecognized-constructor"}`,
      phase: "output",
      path: shapePath,
      kind,
      ...(name ? { type: name } : {})
    }), `returns[${index}]`);
  }
  operations.push({ op: "restore-scratch", phase: "cleanup" });
  return operations;
}

function scriptUnit(row, rowIndex) {
  const unresolvedTokens = [...new Set(row.generation.semanticHoles)].sort(compareCodeUnits);
  return {
    identity: { surface: "script", id: row.id, stableId: row.stableId },
    sourceRef: { input: "scriptProjection", row: rowIndex },
    publicSignature: row.signature,
    availability: row.availability,
    resolvedContract: {
      context: row.context,
      ownership: row.effects.ownership,
      lifetime: row.effects.lifetime,
      thread: { token: "defold-script-thread-from-context" },
      callback: row.effects.callback,
      invalidation: row.effects.invalidation,
      errorModel: { token: "status-return-and-target-exception" },
      scratch: { token: "caller-owned-bounded-reentrant-scratch" }
    },
    abi: {
      state: row.evidence.accountingCategory === "executable-stable-id" ? "existing-generated-entry" : "planned",
      symbol: `deherm_script_route_${row.stableId.toString(16).padStart(8, "0")}`,
      version: 1,
      callingConvention: "extern-c",
      statusReturn: "i32",
      invoker: { kind: "cached-lua-route", stableId: row.stableId }
    },
    shapeKinds: shapeKinds(row.signature),
    unresolvedTokens,
    sourceState: {
      loweringFamily: row.loweringFamily,
      accountingCategory: row.evidence.accountingCategory,
      currentTargets: row.targets
    }
  };
}

function dmsdkUnit(row, rowIndex) {
  const unresolvedTokens = new Set(row.semanticTokensNeeded);
  if (row.loweringState === "lowering-pending") unresolvedTokens.add("lowering:pending");
  if (row.loweringState === "policy-blocked") unresolvedTokens.add("lowering:policy-gated");
  return {
    identity: { surface: "dmsdk", id: row.id, projectionId: row.projectionId },
    sourceRef: { input: "dmsdkProjection", row: rowIndex },
    publicSignature: row.signature,
    availability: row.effects.availability,
    resolvedContract: {
      context: row.effects.context,
      ownership: row.effects.ownership,
      lifetime: row.effects.lifetime,
      thread: row.effects.thread,
      callback: row.effects.callbacks,
      invalidation: { token: "native-resource-effect-unresolved" },
      errorModel: { token: "status-return-and-target-exception" },
      scratch: { token: "caller-owned-bounded-reentrant-scratch" }
    },
    abi: {
      state: row.loweringState === "generated-adapter" ? "existing-generated-entry" : "planned",
      symbol: row.lowering.wrapper,
      plannedSymbol: `deherm_dmsdk_${row.projectionId.slice("dmsdk-projection:".length)}`,
      version: 1,
      callingConvention: "extern-c",
      statusReturn: "i32",
      invoker: { kind: "native-symbol", symbol: row.symbol }
    },
    shapeKinds: shapeKinds(row.signature),
    unresolvedTokens: [...unresolvedTokens].sort(compareCodeUnits),
    sourceState: {
      loweringFamily: row.provenance.primaryFamily,
      loweringState: row.loweringState,
      loweringEvidence: row.lowering
    }
  };
}

const genericImplementationLaneDefinitions = Object.freeze([
  Object.freeze({ input: "scriptScalarDispatch", lane: "script-scalar-dispatch", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["bindingCount"], requireStableId: true, scope: "Generated scalar Lua descriptors and stable dispatch identities." }),
  Object.freeze({ input: "scriptValueBindings", lane: "script-value-bindings", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["bindingCount"], requireStableId: true, scope: "Generated structured Defold-value operation descriptors and native adapters." }),
  Object.freeze({ input: "scriptFixedTuples", lane: "script-fixed-tuples", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["bindingCount"], requireStableId: true, scope: "Generated fixed-tuple codecs and target dispositions." }),
  Object.freeze({ input: "scriptDynamicValues", lane: "script-dynamic-values", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["routeCount"], requireStableId: true, scope: "Generated dynamic-value candidate descriptors and focused native evidence." }),
  Object.freeze({ input: "scriptValueTail", lane: "script-value-tail", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["routeCount"], requireStableId: true, scope: "Generated remaining Defold-value family descriptors and blockers." }),
  Object.freeze({ input: "scriptOverloadDispatch", lane: "script-overload-dispatch", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["routeCount"], requireStableId: true, scope: "Generated overload classifiers and target dispositions." }),
  Object.freeze({ input: "scriptTableRecords", lane: "script-table-records", surface: "script", schemaVersion: 1, collection: "bindings", countPath: ["candidateCount"], requireStableId: true, scope: "Generated fixed-record codecs and required-context claims." }),
  Object.freeze({ input: "scriptCallbackLifecycle", lane: "script-callback-lifecycle", surface: "script", schemaVersion: 1, collection: "routes", countPath: ["routeCount"], requireStableId: true, scope: "Generated callback lifecycle contracts and registry eligibility." }),
  Object.freeze({ input: "scriptCopiedValueBlockers", lane: "script-copied-value-blockers", surface: "script", schemaVersion: 1, collection: "routes", countPath: ["routeCount"], requireStableId: true, scope: "Source-pinned copied-value blockers." }),
  Object.freeze({ input: "scriptOpaqueRecordBlockers", lane: "script-opaque-record-blockers", surface: "script", schemaVersion: 1, collection: "routes", countPath: ["routeCount"], requireStableId: true, scope: "Source-pinned opaque-record blockers." }),
  Object.freeze({ input: "scriptUrlAddress", lane: "script-url-dispatch", surface: "script", schemaVersion: 1, collection: "rows", countPath: ["routeCount"], requireStableId: true, scope: "Generated URL/address codecs and captured-instance dispatch identities." }),
  Object.freeze({ input: "dmsdkScalarThunks", lane: "dmsdk-scalar-thunks", surface: "dmsdk", schemaVersion: 2, collection: "declarations", countPath: ["coverage", "reviewed"], scope: "Generated scalar C ABI, target adapters, and staged verification claims." }),
  Object.freeze({ input: "dmsdkEnumValues", lane: "dmsdk-enum-values", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated enum-domain value bindings and staged verification claims." }),
  Object.freeze({ input: "dmsdkNamedScalars", lane: "dmsdk-named-scalars", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "reviewed"], scope: "Generated or policy-blocked named-scalar bindings." }),
  Object.freeze({ input: "dmsdkFixedDigests", lane: "dmsdk-fixed-digests", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated fixed-output digest span bindings." }),
  Object.freeze({ input: "dmsdkBase64Spans", lane: "dmsdk-base64-spans", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated bounded Base64 span bindings." }),
  Object.freeze({ input: "dmsdkAstcProbes", lane: "dmsdk-astc-probes", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated bounded ASTC inspection bindings." }),
  Object.freeze({ input: "dmsdkXteaSpans", lane: "dmsdk-xtea-spans", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated bounded XTEA span bindings." }),
  Object.freeze({ input: "dmsdkHashSpans", lane: "dmsdk-hash-spans", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "discovered"], scope: "Generated bounded hash span bindings." }),
  Object.freeze({ input: "dmsdkArenaSpanBlockers", lane: "dmsdk-arena-span-blockers", surface: "dmsdk", schemaVersion: 1, collection: "declarations", countPath: ["coverage", "blocked"], scope: "Generated explicit blockers for unresolved arena/span declarations." })
]);

const allowedEvidenceStatuses = new Set([
  "observed-exact-upstream-bitop-implementation",
  "observed-transport-with-local-type-identity-stand-ins",
  "observed-transport-with-source-equivalent-test-function",
  "not-applicable-blocked",
  "complete",
  "blocked-by-policy",
  "blocked-by-versioned-policy",
  "covered-by-reproducible-test",
  "covered-by-host-source-link-test",
  "covered-by-host-behavior-test",
  "covered-by-host-and-arm64-extension-nm-tests",
  "generated-native-js-adapter",
  "blocked-on-generation",
  "header-compiled-policy-blocked",
  "packaged-sdk-object-test",
  "packaged-sdk-host-link-test",
  "packaged-sdk-host-runtime-test",
  "packaged-sdk-host-behavior-test",
  "pinned-source-object-test",
  "pinned-source-host-link-test",
  "pinned-source-host-behavior-test",
  "extension-link-pending",
  "engine-context-pending",
  "signature-compiled-not-linked",
  "not-claimed-policy-blocked",
  "not-applicable",
  "not-claimed",
  "100000-warmed-dispatch-zero-cpp-allocations",
  "100000-warmed-canonical-dispatch-zero-cpp-operator-new",
  "100000-warmed-dispatch-zero-cpp-operator-new",
  "100000-warmed-dispatch-zero-cpp-operator-new-with-reverse-hashing-default-disabled"
]);

const allowedTargetClaimStatuses = new Set([
  "generated-executable",
  "not-executable",
  "blocked-missing-handle-producer",
  "reachable",
  "candidate-awaits-shared-router-integration",
  "planned-generated-adapter",
  "not-executable-no-generated-provider",
  "blocked-recursive-json-value-policy",
  "blocked-recursive-log-side-effect-policy",
  "blocked-box2d-world-handle-and-multi-result-codecs",
  "blocked-box2d-world-handle-and-structured-result-codecs",
  "blocked-captured-instance-url-construction-context",
  "blocked-box2d-joint-handle-codec",
  "generated-executable-shared-script-adapter",
  "not-integrated-fail-closed",
  "blocked-render-target-table-and-resource-lifetime-codecs",
  "blocked-box2d-handle-and-structured-fixture-codecs",
  "fail-closed-unverified"
]);

function valueAtPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function normalizedEvidenceClaims(value, context) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!allowedEvidenceStatuses.has(value)) throw new Error(`${context}: unsupported evidence status '${value}'`);
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}: malformed evidence claims`);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right)).map(([stage, claim]) => {
    const status = typeof claim === "string" ? claim : claim?.status;
    if (typeof status !== "string" || !allowedEvidenceStatuses.has(status)) {
      throw new Error(`${context}/${stage}: unsupported evidence status '${String(status)}'`);
    }
    return [stage, status];
  }));
}

function normalizedTargetClaims(value, context) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}: malformed target claims`);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right)).map(([target, claim]) => {
    const status = typeof claim === "string" ? claim : claim?.status;
    if (typeof status !== "string" || !allowedTargetClaimStatuses.has(status)) {
      throw new Error(`${context}/${target}: unsupported target status '${String(status)}'`);
    }
    return [target, status];
  }));
}

function selectDefined(source, names) {
  const selected = {};
  for (const name of names) {
    if (source[name] !== undefined) selected[name] = source[name];
  }
  return selected;
}

function normalizedStableId(value, context) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  if (typeof value === "string" && /^0x[0-9a-f]{8}$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  throw new Error(`${context}: stable identity is not a u32 number or eight-digit hexadecimal token`);
}

function genericImplementationRecord(definition, entry, reportRow) {
  const reportState = selectDefined(entry, [
    "disposition", "emitted", "executableStatus", "generatedFamilyExecutableCandidate",
    "registryEligible", "blocker", "blockers", "tranche", "family", "backend"
  ]);
  const generationIdentity = selectDefined(entry, [
    "stableId", "bindingId", "wrapper", "enumName", "operation", "strategy",
    "resultCodec", "requiredContext", "context"
  ]);
  const targetClaims = normalizedTargetClaims(entry.targetSupport ?? entry.targets, `${definition.lane}/${entry.id}`);
  const evidenceClaims = normalizedEvidenceClaims(
    entry.stages ?? entry.evidence?.stages ?? entry.focusedNativeEvidence,
    `${definition.lane}/${entry.id}`
  );
  return {
    lane: definition.lane,
    reportRow,
    reportState,
    generationIdentity,
    ...(targetClaims !== undefined ? { targetClaims } : {}),
    ...(evidenceClaims !== undefined ? { evidenceClaims } : {})
  };
}

function implementationLaneIndex(units, inputs, defoldRevision) {
  const { scriptHandleLowering, scriptUniversalValue, dmsdkCStringValue, dmsdkBorrowedHandle } = inputs;
  const unitsById = new Map(units.map((unit) => [unit.identity.id, unit]));
  const lanes = new Map(units.map((unit) => [unit.identity.id, []]));
  const laneIds = new Set();

  function add(unitId, implementation) {
    const unit = unitsById.get(unitId);
    if (!unit) throw new Error(`${implementation.lane}: implementation references unknown unit ${unitId}`);
    const key = `${implementation.lane}:${unitId}`;
    if (laneIds.has(key)) throw new Error(`${implementation.lane}: duplicate implementation for ${unitId}`);
    if (lanes.get(unitId).length > 0) {
      throw new Error(`${unitId}: implementation lane overlap between ${lanes.get(unitId)[0].lane} and ${implementation.lane}`);
    }
    laneIds.add(key);
    lanes.get(unitId).push(implementation);
    return unit;
  }

  if (scriptUniversalValue.schemaVersion !== 1 ||
      scriptUniversalValue.defoldRevision !== defoldRevision ||
      scriptUniversalValue.bindings.length !== scriptUniversalValue.candidateCount) {
    throw new Error("Script universal-value implementation lane schema, revision, or census drifted");
  }
  for (let reportRow = 0; reportRow < scriptUniversalValue.bindings.length; ++reportRow) {
    const binding = scriptUniversalValue.bindings[reportRow];
    const unit = add(binding.id, {
      lane: "script-universal-value",
      reportRow,
      disposition: "generated-bounded-recursive-native-dynamic",
      semanticState: "generated-runtime-codec-with-explicit-static-browser-and-packaged-engine-gates",
      generationIdentity: {
        stableId: binding.stableId,
        minimumArgumentCount: binding.minimumArgumentCount,
        maximumArgumentCount: binding.maximumArgumentCount,
        resultCount: binding.resultCount
      },
      bounds: scriptUniversalValue.bounds,
      tablePolicy: scriptUniversalValue.tablePolicy,
      targetClaims: scriptUniversalValue.targetSupport,
      evidenceBoundary: scriptUniversalValue.evidenceBoundary,
      supersededLanes: []
    });
    if (unit.identity.surface !== "script" || unit.identity.stableId !== binding.stableId) {
      throw new Error(`script-universal-value: identity drift for ${binding.id}`);
    }
  }

  for (const definition of genericImplementationLaneDefinitions) {
    const report = inputs[definition.input];
    if (!report || report.schemaVersion !== definition.schemaVersion) {
      throw new Error(`${definition.lane}: implementation report schema version drifted`);
    }
    if (report.defoldRevision !== defoldRevision) {
      throw new Error(`${definition.lane}: Defold revision drifted`);
    }
    const entries = report[definition.collection];
    if (!Array.isArray(entries)) {
      throw new Error(`${definition.lane}: report collection ${definition.collection} is missing`);
    }
    if (valueAtPath(report, definition.countPath) !== entries.length) {
      throw new Error(`${definition.lane}: report census drifted`);
    }
    for (let reportRow = 0; reportRow < entries.length; reportRow += 1) {
      const entry = entries[reportRow];
      if (!entry || typeof entry.id !== "string") {
        throw new Error(`${definition.lane}: row ${reportRow} has no API identity`);
      }
      const existing = lanes.get(entry.id);
      if (existing.length > 0 && existing[0].lane === "script-universal-value" &&
          (definition.lane === "script-copied-value-blockers" ||
           definition.lane === "script-opaque-record-blockers")) {
        existing[0].supersededLanes.push(definition.lane);
        continue;
      }
      const unit = add(entry.id, genericImplementationRecord(definition, entry, reportRow));
      if (unit.identity.surface !== definition.surface) {
        throw new Error(`${definition.lane}: surface drift for ${entry.id}`);
      }
      if (definition.requireStableId || entry.stableId !== undefined) {
        if (unit.identity.stableId !== normalizedStableId(entry.stableId, `${definition.lane}/${entry.id}`)) {
          throw new Error(`${definition.lane}: stable identity drift for ${entry.id}`);
        }
      }
    }
  }

  if (scriptHandleLowering.schemaVersion !== 2 || scriptHandleLowering.defoldRevision !== defoldRevision) {
    throw new Error("Script handle implementation lane schema or Defold revision drifted");
  }
  if (scriptHandleLowering.routes.length !== scriptHandleLowering.coverage.selectedRoutes) {
    throw new Error("Script handle implementation lane route census drifted");
  }
  for (const route of scriptHandleLowering.routes) {
    const unit = add(route.id, {
      lane: "script-handle-lowering",
      disposition: route.generation.router === "emitted" ? "generated-private-runtime" : "blocked",
      semanticState: route.generation.router === "emitted"
        ? "generated-contract-retains-declared-policy-holes"
        : "blocked-by-declared-target-or-context-policy",
      contract: {
        context: route.context,
        ownership: route.ownership,
        lifetime: route.lifetime,
        invalidation: route.invalidation,
        callback: route.callback,
        variadic: route.variadic,
        recursive: route.recursive,
        profiles: route.profiles
      },
      targets: route.targets,
      generation: route.generation,
      evidence: route.evidence
    });
    if (unit.identity.surface !== "script" || unit.identity.stableId !== route.stableId) {
      throw new Error(`script-handle-lowering: identity drift for ${route.id}`);
    }
  }

  if (dmsdkCStringValue.schemaVersion !== 1 || dmsdkCStringValue.defoldRevision !== defoldRevision) {
    throw new Error("dmSDK C-string implementation lane schema or Defold revision drifted");
  }

  if (dmsdkBorrowedHandle.schemaVersion !== 1 ||
      dmsdkBorrowedHandle.defoldRevision !== defoldRevision ||
      dmsdkBorrowedHandle.declarations.length !== dmsdkBorrowedHandle.coverage.candidates ||
      dmsdkBorrowedHandle.coverage.generated + dmsdkBorrowedHandle.coverage.blocked !==
        dmsdkBorrowedHandle.coverage.candidates) {
    throw new Error("dmSDK borrowed-handle implementation lane schema, revision, or census drifted");
  }
  for (let reportRow = 0; reportRow < dmsdkBorrowedHandle.declarations.length; ++reportRow) {
    const declaration = dmsdkBorrowedHandle.declarations[reportRow];
    const generated = declaration.disposition === "generated-provider-boundary";
    if (!generated && declaration.disposition !== "blocked") {
      throw new Error(`dmsdk-borrowed-handle: unknown disposition for ${declaration.id}`);
    }
    const unit = add(declaration.id, {
      lane: "dmsdk-borrowed-handle",
      reportRow,
      disposition: declaration.disposition,
      semanticState: generated
        ? "generated-provider-boundary-engine-semantics-remain-gated"
        : "blocked-by-structural-or-semantic-policy",
      generationIdentity: selectDefined(declaration, ["projectionId", "bindingId", "symbol", "shape"]),
      blockers: declaration.blockers ?? declaration.engineProviderBlockers,
      ...(declaration.resolvedPolicies !== undefined
        ? { resolvedPolicies: declaration.resolvedPolicies }
        : {}),
      ...(declaration.stages !== undefined
        ? { evidenceClaims: declaration.stages }
        : {})
    });
    if (unit.identity.surface !== "dmsdk" ||
        unit.identity.projectionId !== declaration.projectionId) {
      throw new Error(`dmsdk-borrowed-handle: identity drift for ${declaration.id}`);
    }
  }
  if (dmsdkCStringValue.declarations.length !== dmsdkCStringValue.coverage.candidates) {
    throw new Error("dmSDK C-string implementation lane declaration census drifted");
  }
  for (const declaration of dmsdkCStringValue.declarations) {
    const unit = add(declaration.id, {
      lane: "dmsdk-cstring-value",
      disposition: declaration.disposition === "generated" ? "generated-private-staging" : "blocked",
      semanticState: declaration.disposition === "generated"
        ? "explicit-string-contract-private-unlinked"
        : "blocked-by-declared-string-policy",
      contract: declaration.stringContract,
      targets: declaration.targetDisposition,
      generation: {
        stableId: declaration.stableId,
        denseId: declaration.denseId
      },
      evidence: {
        generation: declaration.disposition === "generated" ? "source-emitted" : "not-emitted",
        compilation: "report-level-only",
        linkage: "unclaimed-by-canonical-plan",
        runtime: "unclaimed-by-canonical-plan",
        conformance: "unclaimed-by-canonical-plan"
      },
      ...(declaration.blocker ? { blocker: declaration.blocker } : {})
    });
    if (unit.identity.surface !== "dmsdk" || unit.identity.projectionId !== declaration.projectionId) {
      throw new Error(`dmsdk-cstring-value: identity drift for ${declaration.id}`);
    }
  }

  for (const unit of units) {
    if (lanes.get(unit.identity.id).length > 0) continue;
    add(unit.identity.id, unit.identity.surface === "script" ? {
      lane: "script-projection-only",
      disposition: "projection-only",
      semanticState: "awaits-generated-adapter-or-explicit-blocker-policy",
      loweringFamily: unit.sourceState.loweringFamily,
      accountingCategory: unit.sourceState.accountingCategory,
      unresolvedTokens: unit.unresolvedTokens
    } : {
      lane: "dmsdk-projection-only",
      disposition: "projection-only",
      semanticState: "awaits-generated-adapter-or-explicit-blocker-policy",
      loweringFamily: unit.sourceState.loweringFamily,
      loweringState: unit.sourceState.loweringState,
      unresolvedTokens: unit.unresolvedTokens
    });
  }

  for (const implementations of lanes.values()) {
    implementations.sort((left, right) => compareCodeUnits(left.lane, right.lane));
  }
  for (const unit of units) {
    if (unit.abi.state === "existing-generated-entry" && lanes.get(unit.identity.id).length === 0) {
      throw new Error(`${unit.identity.id}: generated ABI entry has no implementation lane`);
    }
  }
  return lanes;
}

function selectorMatches(unit, selector) {
  const supported = new Set(["surface", "valueKindsAll", "valueKindsAny", "contexts", "semanticTokensAll", "semanticTokensAny"]);
  for (const key of Object.keys(selector)) {
    if (!supported.has(key)) throw new Error(`Semantic policy uses unsupported or identity selector '${key}'`);
  }
  if (selector.surface && selector.surface !== unit.identity.surface) return false;
  const kinds = new Set(unit.shapeKinds);
  if (selector.valueKindsAll && !selector.valueKindsAll.every((kind) => kinds.has(kind))) return false;
  if (selector.valueKindsAny && !selector.valueKindsAny.some((kind) => kinds.has(kind))) return false;
  const context = unit.resolvedContract.context?.token ?? unit.resolvedContract.context?.kind;
  if (selector.contexts && !selector.contexts.includes(context)) return false;
  const tokens = new Set(unit.unresolvedTokens);
  if (selector.semanticTokensAll && !selector.semanticTokensAll.every((token) => tokens.has(token))) return false;
  if (selector.semanticTokensAny && !selector.semanticTokensAny.some((token) => tokens.has(token))) return false;
  return true;
}

function applySemanticPolicies(units, policies) {
  if (policies.schemaVersion !== 1 || !Array.isArray(policies.rules)) throw new Error("Invalid semantic policy catalog");
  const resolutions = new Map();
  const ruleMatches = {};
  for (const rule of policies.rules) {
    if (!rule.id || !rule.selector || !rule.resolves || Object.keys(rule.resolves).length === 0) {
      throw new Error("Every semantic policy rule needs an id, selector, and resolutions");
    }
    let matches = 0;
    for (const unit of units) {
      if (!selectorMatches(unit, rule.selector)) continue;
      matches += 1;
      const unitResolutions = resolutions.get(unit.identity.id) ?? new Map();
      for (const [token, decision] of Object.entries(rule.resolves)) {
        if (!unit.unresolvedTokens.includes(token)) throw new Error(`${rule.id} resolves absent token '${token}' on ${unit.identity.id}`);
        if (unitResolutions.has(token)) throw new Error(`${unit.identity.id}: semantic policies overlap for '${token}'`);
        unitResolutions.set(token, { rule: rule.id, decision });
      }
      resolutions.set(unit.identity.id, unitResolutions);
    }
    if (matches === 0) throw new Error(`${rule.id}: semantic policy selector matches zero units`);
    ruleMatches[rule.id] = matches;
  }
  return { resolutions, ruleMatches };
}

function backendRecord(unit, target, resolutions, implementationLanes) {
  const missingKinds = unit.shapeKinds.filter((kind) => target.unsupportedValueKinds.includes(kind));
  const resolved = new Map(resolutions.get(unit.identity.id) ?? []);
  const implementation = implementationLanes.get(unit.identity.id)?.[0];
  const universalDynamic = implementation?.lane === "script-universal-value" &&
      (target.target === "dynamicHermesJsi" || target.target === "luaStack");
  if (universalDynamic) {
    for (const token of unit.unresolvedTokens) {
      resolved.set(token, {
        rule: "generated:script-universal-value",
        decision: "bounded-recursive-captured-lua-adapter"
      });
    }
  }
  const unresolved = unit.unresolvedTokens.filter((token) => !resolved.has(token));
  const blockers = [];
  let selection;
  if (target.target === "typescriptSdk") {
    selection = "emit";
  } else if (!target.surfaces.includes(unit.identity.surface)) {
    selection = "blocked-capability";
    blockers.push(`surface:${unit.identity.surface}`);
  } else if (unit.identity.surface === "script" && unit.availability.runtimeAvailable === false) {
    selection = "omit-profile";
    blockers.push("unavailable-in-all-pinned-runtime-profiles");
  } else if (unit.sourceState.accountingCategory === "separate-module") {
    selection = "separate-module";
    blockers.push("separate-module-owned-lifecycle");
  } else if (missingKinds.length > 0) {
    selection = "blocked-capability";
    blockers.push(...missingKinds.map((kind) => `value-kind:${kind}`));
  } else if (unresolved.length > 0) {
    selection = "blocked-semantic";
    blockers.push(...unresolved);
  } else if (universalDynamic) {
    selection = "emit";
  } else if (unit.identity.surface === "script") {
    const current = target.target === "dynamicHermesJsi" || target.target === "luaStack"
      ? unit.sourceState.currentTargets.nativeDynamicHermes.disposition
      : target.target === "staticHermesCAbi"
        ? unit.sourceState.currentTargets.nativeStaticHermes.disposition
        : unit.sourceState.currentTargets.html5BrowserHost.disposition;
    if (current === "backend-emitted") selection = "emit";
    else {
      selection = "blocked-capability";
      blockers.push(`current-backend:${current}`);
    }
  } else if (unit.sourceState.loweringState === "generated-adapter") {
    selection = "emit";
  } else {
    selection = "blocked-semantic";
    blockers.push(`lowering:${unit.sourceState.loweringState}`);
  }
  if (target.runtime && selection === "emit" && unresolved.length > 0) {
    throw new Error(`${unit.identity.id}/${target.target}: runtime emission escaped unresolved semantics`);
  }
  const program = target.runtime ? marshallingProgram(unit.publicSignature, unit.abi.invoker.kind) : [];
  return {
    selection,
    marshallingProgram: program,
    blockers: [...new Set(blockers)].sort(compareCodeUnits),
    resolvedTokens: Object.fromEntries([...resolved].sort(([left], [right]) => compareCodeUnits(left, right))),
    unresolvedTokens: unresolved
  };
}

function tokenOf(value, fallback) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return fallback;
  return value.token ?? value.kind ?? fallback;
}

function compactContract(contract) {
  return {
    context: tokenOf(contract.context, "unspecified"),
    ownership: tokenOf(contract.ownership, contract.ownership?.result ?? "unspecified"),
    lifetime: tokenOf(contract.lifetime, contract.lifetime?.result ?? "unspecified"),
    thread: tokenOf(contract.thread, contract.thread?.call ?? "unspecified"),
    callback: tokenOf(contract.callback, contract.callback?.present ? "present" : "none"),
    invalidation: tokenOf(contract.invalidation, "unspecified"),
    errorModel: tokenOf(contract.errorModel, "unspecified"),
    scratch: tokenOf(contract.scratch, "unspecified")
  };
}

function createInterner() {
  const values = [];
  const indices = new Map();
  return {
    intern(value) {
      const key = JSON.stringify(value);
      const prior = indices.get(key);
      if (prior !== undefined) return prior;
      const index = values.length;
      indices.set(key, index);
      values.push(value);
      return index;
    },
    values
  };
}

function compactUnits(units, implementationLanes) {
  const contracts = createInterner();
  const programs = createInterner();
  const blockerSets = createInterner();
  const resolvedTokenSets = createInterner();
  const unresolvedTokenSets = createInterner();
  const implementationSets = createInterner();
  programs.intern([]);
  blockerSets.intern([]);
  resolvedTokenSets.intern({});
  unresolvedTokenSets.intern([]);
  implementationSets.intern([]);
  const compact = units.map((unit) => ({
    identity: unit.identity,
    sourceRef: unit.sourceRef,
    signatureSha256: sha256(JSON.stringify(unit.publicSignature)),
    contract: compactContract(unit.resolvedContract),
    contractDetails: contracts.intern(unit.resolvedContract),
    abi: unit.abi,
    shapeKinds: unit.shapeKinds,
    unresolvedTokenSet: unresolvedTokenSets.intern(unit.unresolvedTokens),
    sourceState: unit.identity.surface === "script"
      ? {
          loweringFamily: unit.sourceState.loweringFamily,
          accountingCategory: unit.sourceState.accountingCategory
        }
      : {
          loweringFamily: unit.sourceState.loweringFamily,
          loweringState: unit.sourceState.loweringState
        },
    implementationSet: implementationSets.intern(implementationLanes.get(unit.identity.id) ?? []),
    backends: Object.fromEntries(targetOrder.map((target) => {
      const backend = unit.backends[target];
      return [target, {
        selection: backend.selection,
        marshallingProgram: programs.intern(backend.marshallingProgram),
        blockerSet: blockerSets.intern(backend.blockers),
        resolvedTokenSet: resolvedTokenSets.intern(backend.resolvedTokens),
        unresolvedTokenSet: unresolvedTokenSets.intern(backend.unresolvedTokens)
      }];
    }))
  }));
  return {
    units: compact,
    tables: {
      contracts: contracts.values,
      marshallingPrograms: programs.values,
      blockerSets: blockerSets.values,
      resolvedTokenSets: resolvedTokenSets.values,
      unresolvedTokenSets: unresolvedTokenSets.values,
      implementationSets: implementationSets.values
    }
  };
}

function countSelections(units, target) {
  const counts = {};
  for (const unit of units) {
    const value = unit.backends[target].selection;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareCodeUnits(left, right)));
}

export function generateBindingLoweringPlan(inputs) {
  const parsed = Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, JSON.parse(content)]));
  const { scriptProjection, dmsdkProjection, semanticPolicies } = parsed;
  if (scriptProjection.defoldRevision !== dmsdkProjection.defoldRevision) throw new Error("Projection Defold revisions differ");
  if (scriptProjection.routeCount !== 926 || scriptProjection.rows.length !== 926) throw new Error("Script projection census drifted");
  if (dmsdkProjection.coverage.projectedDeclarations !== 1361 || dmsdkProjection.rows.length !== 1361) throw new Error("dmSDK projection census drifted");
  const targets = targetOrder.map((name) => parsed[name]);
  if (new Set(targets.map(({ target }) => target)).size !== targetOrder.length) throw new Error("Target capability names are duplicated");
  for (let index = 0; index < targets.length; index += 1) {
    if (targets[index].target !== targetOrder[index]) throw new Error(`Target capability order/name mismatch for ${targetOrder[index]}`);
    if (!Array.isArray(targets[index].surfaces) || !Array.isArray(targets[index].unsupportedValueKinds)) throw new Error(`${targetOrder[index]} target capability is malformed`);
  }
  const units = [
    ...scriptProjection.rows.map(scriptUnit),
    ...dmsdkProjection.rows.map(dmsdkUnit)
  ].sort((left, right) => compareCodeUnits(left.identity.surface, right.identity.surface) || compareCodeUnits(left.identity.id, right.identity.id));
  if (units.length !== 2287 || new Set(units.map(({ identity }) => `${identity.surface}:${identity.id}`)).size !== 2287) {
    throw new Error("Unified lowering plan must contain 2,287 unique units");
  }
  const { resolutions, ruleMatches } = applySemanticPolicies(units, semanticPolicies);
  const implementationLanes = implementationLaneIndex(
    units, parsed, scriptProjection.defoldRevision);
  for (const unit of units) {
    unit.backends = Object.fromEntries(targets.map((target) => [target.target, backendRecord(
      unit, target, resolutions, implementationLanes)]));
    if (Object.keys(unit.backends).join(",") !== targetOrder.join(",")) throw new Error(`${unit.identity.id}: incomplete backend matrix`);
  }
  const compact = compactUnits(units, implementationLanes);
  const body = {
    schemaVersion: 2,
    defoldRevision: scriptProjection.defoldRevision,
    scope: "Canonical generation plan for every Defold script route and dmSDK runtime declaration. It describes emission decisions and marshalling only; it is not compile, link, runtime, allocation, or conformance evidence.",
    evidenceBoundary: {
      generation: "A backend selection of emit means the plan permits an emitter to produce source.",
      implementationLanes: "Generated implementation records are descriptive overlays. They never promote a backend selection or erase unresolved semantic tokens.",
      compilation: "not-claimed",
      linkage: "not-claimed",
      runtime: "not-claimed",
      allocation: "not-claimed",
      conformance: "not-claimed"
    },
    inputHashes: Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, sha256(content)])),
    inputCanonicalHashes: Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, sha256(JSON.stringify(JSON.parse(content)))])),
    targetOrder,
    targetCapabilities: Object.fromEntries(targets.map((target) => [target.target, target])),
    semanticPolicyMatches: ruleMatches,
    coverage: {
      units: units.length,
      scriptUnits: units.filter(({ identity }) => identity.surface === "script").length,
      dmsdkUnits: units.filter(({ identity }) => identity.surface === "dmsdk").length,
      backendRecords: units.length * targetOrder.length,
      identitySelectedPolicyRules: 0
    },
    implementationLanes: {
      ...Object.fromEntries(genericImplementationLaneDefinitions.map((definition) => [definition.lane, {
        source: inputPaths[definition.input],
        scope: definition.scope
      }])),
      "script-handle-lowering": {
        source: inputPaths.scriptHandleLowering,
        scope: "Generated captured-Lua handle descriptors/router and target-specific evidence dispositions."
      },
      "script-universal-value": {
        source: inputPaths.scriptUniversalValue,
        scope: "Generated bounded recursive Lua/JS value-graph descriptors and native Dynamic Hermes adapter."
      },
      "dmsdk-cstring-value": {
        source: inputPaths.dmsdkCStringValue,
        scope: "Generated private C-string ABI staging and target-specific registration/linkage dispositions."
      },
      "dmsdk-borrowed-handle": {
        source: inputPaths.dmsdkBorrowedHandle,
        scope: "Generated borrowed-handle consumer provider boundary and explicit structural/semantic blockers."
      },
      "script-projection-only": {
        source: inputPaths.scriptProjection,
        scope: "Canonical ownership for script routes that have projection IR but no specialized generated adapter lane yet."
      },
      "dmsdk-projection-only": {
        source: inputPaths.dmsdkProjection,
        scope: "Canonical ownership for dmSDK declarations that have projection IR but no specialized generated adapter lane yet."
      }
    },
    selectionSummary: Object.fromEntries(targetOrder.map((target) => [target, countSelections(units, target)])),
    tables: compact.tables,
    units: compact.units
  };
  return { ...body, planSha256: sha256(JSON.stringify(body)) };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = generateBindingLoweringPlan(await loadBindingLoweringInputs());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (await readFile(options.output, "utf8") !== serialized) throw new Error(`${options.output} is stale; regenerate binding lowering plan`);
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, serialized);
  }
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.units} units × ${report.targetOrder.length} backends (${report.coverage.backendRecords} explicit dispositions).\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
