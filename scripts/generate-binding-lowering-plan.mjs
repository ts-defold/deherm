import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export const inputPaths = Object.freeze({
  scriptProjection: "bindings/generated/defold-script-projection-ir.json",
  dmsdkProjection: "bindings/generated/defold-dmsdk-projection-ir.json",
  semanticPolicies: "bindings/overrides/binding-semantic-policies.json",
  typescriptSdk: "bindings/targets/typescript-sdk.json",
  dynamicHermesJsi: "bindings/targets/dynamic-hermes-jsi.json",
  staticHermesCAbi: "bindings/targets/static-hermes-cabi.json",
  luaStack: "bindings/targets/lua-stack.json",
  browserWasmHost: "bindings/targets/browser-wasm-host.json"
});

const targetOrder = Object.freeze([
  "typescriptSdk",
  "dynamicHermesJsi",
  "staticHermesCAbi",
  "luaStack",
  "browserWasmHost"
]);

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
    output: resolve(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.json"),
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
  return [...kinds].sort();
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
  const unresolvedTokens = [...new Set(row.generation.semanticHoles)].sort();
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
    unresolvedTokens: [...unresolvedTokens].sort(),
    sourceState: {
      loweringFamily: row.provenance.primaryFamily,
      loweringState: row.loweringState,
      loweringEvidence: row.lowering
    }
  };
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

function backendRecord(unit, target, resolutions) {
  const missingKinds = unit.shapeKinds.filter((kind) => target.unsupportedValueKinds.includes(kind));
  const resolved = resolutions.get(unit.identity.id) ?? new Map();
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
    blockers: [...new Set(blockers)].sort(),
    resolvedTokens: Object.fromEntries([...resolved].sort(([left], [right]) => left.localeCompare(right))),
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
    ownership: tokenOf(contract.ownership, "unspecified"),
    lifetime: tokenOf(contract.lifetime, "unspecified"),
    thread: tokenOf(contract.thread, "unspecified"),
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

function compactUnits(units) {
  const programs = createInterner();
  const blockerSets = createInterner();
  const resolvedTokenSets = createInterner();
  const unresolvedTokenSets = createInterner();
  programs.intern([]);
  blockerSets.intern([]);
  resolvedTokenSets.intern({});
  unresolvedTokenSets.intern([]);
  const compact = units.map((unit) => ({
    identity: unit.identity,
    sourceRef: unit.sourceRef,
    signatureSha256: sha256(JSON.stringify(unit.publicSignature)),
    contract: compactContract(unit.resolvedContract),
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
      marshallingPrograms: programs.values,
      blockerSets: blockerSets.values,
      resolvedTokenSets: resolvedTokenSets.values,
      unresolvedTokenSets: unresolvedTokenSets.values
    }
  };
}

function countSelections(units, target) {
  const counts = {};
  for (const unit of units) {
    const value = unit.backends[target].selection;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
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
  ].sort((left, right) => left.identity.surface.localeCompare(right.identity.surface) || left.identity.id.localeCompare(right.identity.id));
  if (units.length !== 2287 || new Set(units.map(({ identity }) => `${identity.surface}:${identity.id}`)).size !== 2287) {
    throw new Error("Unified lowering plan must contain 2,287 unique units");
  }
  const { resolutions, ruleMatches } = applySemanticPolicies(units, semanticPolicies);
  for (const unit of units) {
    unit.backends = Object.fromEntries(targets.map((target) => [target.target, backendRecord(unit, target, resolutions)]));
    if (Object.keys(unit.backends).join(",") !== targetOrder.join(",")) throw new Error(`${unit.identity.id}: incomplete backend matrix`);
  }
  const compact = compactUnits(units);
  const body = {
    schemaVersion: 1,
    defoldRevision: scriptProjection.defoldRevision,
    scope: "Canonical generation plan for every Defold script route and dmSDK runtime declaration. It describes emission decisions and marshalling only; it is not compile, link, runtime, allocation, or conformance evidence.",
    evidenceBoundary: {
      generation: "A backend selection of emit means the plan permits an emitter to produce source.",
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
