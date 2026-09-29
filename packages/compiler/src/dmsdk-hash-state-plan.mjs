import { createHash } from "node:crypto";

import { incrementalHashStatePattern } from "./dmsdk-pattern-catalog.mjs";
import { DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const operations = Object.freeze(["Init", "Clone", "UpdateBuffer", "Final", "Release"]);

export const DMSDK_HASH_STATE_PLAN_KIND = "deherm.dmsdk-hash-state-plan";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unsupported schema keys: ${actual.join(", ")}`,
  );
}

function patternFacts(row, semanticTokens = []) {
  return {
    id: row.id,
    kind: row.kind,
    result: row.result,
    parameters: row.parameters,
    families: row.families,
    semanticTokens,
  };
}

function stateType(parameter) {
  const match = parameter?.role?.match(/^pointer:record:(.+)$/u);
  return match ? match[1] : null;
}

function recordWidths(ir, supportedWidths) {
  const widths = new Map();
  for (const declaration of ir.declarations) {
    if (
      declaration.kind !== "record" ||
      declaration.access !== "public" ||
      declaration.completeDefinition !== true ||
      !Array.isArray(declaration.members) ||
      declaration.members.length !== 5
    )
      continue;
    const types = declaration.members.map(({ type }) => type);
    const width = supportedWidths.find(
      (candidate) =>
        types[0] === `uint${candidate}_t` &&
        types[1] === `uint${candidate}_t` &&
        types.slice(2).every((type) => type === "uint32_t"),
    );
    if (width) widths.set(declaration.name, width);
  }
  return widths;
}

export function validateDmSdkHashStatePolicy(policy) {
  exactKeys(policy, ["schemaVersion", "policyVersion", "family", "recipe", "registry"], "hash-state policy");
  exactKeys(policy.recipe, ["operations", "stateWidths", "input", "transport"], "hash-state recipe");
  exactKeys(
    policy.registry,
    [
      "capacityPerWidth",
      "generationBits",
      "consumeOperations",
      "reverseHashDefault",
      "threadSafety",
      "generationExhaustion",
    ],
    "hash-state registry",
  );
  assert(
    policy.schemaVersion === 1 &&
      policy.policyVersion === "hash-state-v3" &&
      policy.family === "generation-checked-hash-state" &&
      JSON.stringify(policy.recipe.operations) === JSON.stringify(operations) &&
      JSON.stringify(policy.recipe.stateWidths) === JSON.stringify([32, 64]) &&
      policy.recipe.input === "borrowed-counted-bytes" &&
      policy.recipe.transport === "opaque-generation-checked-u64" &&
      Number.isSafeInteger(policy.registry.capacityPerWidth) &&
      policy.registry.capacityPerWidth > 0 &&
      policy.registry.capacityPerWidth <= 0xffff &&
      policy.registry.generationBits === 31 &&
      JSON.stringify(policy.registry.consumeOperations) === JSON.stringify(["Final", "Release"]) &&
      policy.registry.reverseHashDefault === false &&
      policy.registry.threadSafety === "global-allocation-free-spin-lock" &&
      policy.registry.generationExhaustion === "retire-slot",
    "hash-state semantic policy is unsupported",
  );
}

export function inferHashStateSemantics(declaration, row, policy, stateWidths) {
  if (!declaration || declaration.kind !== "function" || row.parameters.length === 0) return null;
  const state = stateType(row.parameters[0]);
  const width = stateWidths.get(state);
  if (!state || !width) return null;
  let operation = null;
  if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 2 &&
    row.parameters[1].role === "scalar:bool" &&
    row.parameters[1].direction === "value"
  )
    operation = "Init";
  else if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 3 &&
    stateType(row.parameters[1]) === state &&
    row.parameters[1].direction === "in" &&
    row.parameters[2].role === "scalar:bool" &&
    row.parameters[2].direction === "value"
  )
    operation = "Clone";
  else if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 3 &&
    row.parameters[1].role === "opaque-pointer" &&
    row.parameters[1].direction === "in" &&
    row.parameters[2].role === "scalar:u32" &&
    row.parameters[2].direction === "value"
  )
    operation = "UpdateBuffer";
  else if (row.result.role === `scalar:u${width}` && row.parameters.length === 1) operation = "Final";
  else if (row.result.role === "scalar:void" && row.parameters.length === 1) operation = "Release";
  if (!operation || !policy.recipe.operations.includes(operation)) return null;
  return {
    operation,
    width,
    stateType: state,
    semanticTokens: [...incrementalHashStatePattern().when.requireSemanticTokens].sort(compareCodeUnits),
    evidence: {
      header: declaration.header,
      stateType: state,
      semanticSource: "complete-record-layout+closed-lifecycle-abi",
      declarationLine: declaration.line,
    },
  };
}

export function discoverHashStateSemantics(ir, shapes, policy) {
  const declarations = new Map(ir.declarations.map((entry) => [entry.id, entry]));
  const stateWidths = recordWidths(ir, policy.recipe.stateWidths);
  return shapes.rows
    .map((row) => {
      const declaration = declarations.get(row.id);
      const semantics = inferHashStateSemantics(declaration, row, policy, stateWidths);
      return semantics ? { row, declaration, semantics } : null;
    })
    .filter(Boolean)
    .sort((left, right) => compareCodeUnits(left.row.id, right.row.id));
}

function linkageHolds(symbols, row) {
  const evidence = symbols.declarations[row.id];
  return (
    evidence?.name === row.symbol &&
    evidence.kind === "function" &&
    evidence.header === row.header &&
    evidence.linkage === "external" &&
    evidence.availability === "all-targets-all-variants" &&
    symbols.variants.every((variant) => (evidence.linkedIn?.[variant] ?? []).length === symbols.targets.length)
  );
}

function validateInputs({ ir, shapes, symbols, policy, texts }) {
  assert(ir?.schemaVersion === 1 && Array.isArray(ir.declarations), "hash-state plan has invalid dmSDK IR");
  assert(shapes?.schemaVersion === 1 && Array.isArray(shapes.rows), "hash-state plan has invalid ABI shapes");
  assert(symbols?.schemaVersion === 2 && symbols.declarations, "hash-state plan has invalid symbol evidence");
  assert(
    ir.defoldRevision === shapes.defoldRevision && ir.defoldRevision === symbols.defoldRevision,
    "hash-state plan input revisions differ",
  );
  assert(shapes.sourceHashes?.ir === sha256(texts.ir), "hash-state plan ABI shapes do not authenticate the IR");
  validateDmSdkHashStatePolicy(policy);
}

export function buildDmSdkHashStatePlan({ ir, shapes, symbols, policy, texts }) {
  validateInputs({ ir, shapes, symbols, policy, texts });
  const pattern = incrementalHashStatePattern();
  const registry = [pattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const discovered = discoverHashStateSemantics(ir, shapes, policy);
  const lifecycle = new Map();
  for (const { row, semantics } of discovered) {
    const byOperation = lifecycle.get(semantics.stateType) ?? new Map();
    const matches = byOperation.get(semantics.operation) ?? [];
    matches.push(row.id);
    byOperation.set(semantics.operation, matches);
    lifecycle.set(semantics.stateType, byOperation);
  }
  const completeStates = new Set(
    [...lifecycle]
      .filter(([, byOperation]) => operations.every((operation) => byOperation.get(operation)?.length === 1))
      .map(([state]) => state),
  );
  const statesByWidth = new Map();
  for (const [state] of lifecycle) {
    const member = discovered.find(({ semantics }) => semantics.stateType === state);
    if (!member) continue;
    const states = statesByWidth.get(member.semantics.width) ?? [];
    states.push(state);
    statesByWidth.set(member.semantics.width, states);
  }
  const groupBlockers = new Map();
  for (const [state, byOperation] of lifecycle) {
    const members = discovered.filter(({ semantics }) => semantics.stateType === state);
    const width = members[0]?.semantics.width;
    let blocker = null;
    if (!operations.every((operation) => byOperation.get(operation)?.length === 1))
      blocker = "hash-state-lifecycle-incomplete";
    else if ((statesByWidth.get(width) ?? []).length !== 1) blocker = "duplicate-hash-state-width";
    else if (
      members.some(
        ({ row, semantics }) =>
          selectDmSdkPattern(patternFacts(row, semantics.semanticTokens), registry).patternId !== pattern.id,
      )
    )
      blocker = "hash-state-signature-unverified";
    else if (members.some(({ row }) => !linkageHolds(symbols, row))) blocker = "hash-state-linkage-unverified";
    groupBlockers.set(state, blocker);
  }
  const decisions = discovered.map(({ row, semantics }) => {
    const preferred = selectDmSdkPattern(patternFacts(row, semantics.semanticTokens), registry);
    const blocker = groupBlockers.get(semantics.stateType) ?? null;
    const selected = blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN : pattern;
    return {
      declarationId: row.id,
      patternId: selected.id,
      family: selected.family,
      emitter: selected.emitter,
      fallback: selected.fallback,
      priority: selected.priority,
      cost: selected.cost,
      candidatePatternId: pattern.id,
      semantics,
      blocker,
      lifecycleComplete: completeStates.has(semantics.stateType),
      trace: preferred.trace,
    };
  });
  return {
    schemaVersion: 1,
    kind: DMSDK_HASH_STATE_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      symbols: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
      policy: "packages/bindings/overrides/dmsdk-hash-state-bindings.json",
    },
    sourceHashes: Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, sha256(value)])),
    patternRegistry: registry,
    coverage: {
      discovered: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
      completeStateTypes: completeStates.size,
    },
    decisions,
  };
}

export function indexDmSdkHashStatePlan(plan, { revision, sourceHashes } = {}) {
  assert(plan?.schemaVersion === 1 && plan.kind === DMSDK_HASH_STATE_PLAN_KIND, "invalid hash-state plan");
  if (revision !== undefined) assert(plan.defoldRevision === revision, "hash-state plan revision differs");
  for (const [key, digest] of Object.entries(sourceHashes ?? {}))
    assert(plan.sourceHashes?.[key] === digest, `hash-state plan ${key} provenance differs`);
  assert(Array.isArray(plan.decisions) && Array.isArray(plan.patternRegistry), "hash-state plan rows are missing");
  const registry = new Map(plan.patternRegistry.map((pattern) => [pattern.id, pattern]));
  assert(registry.size === plan.patternRegistry.length, "hash-state plan registry has duplicate ids");
  assert(registry.has(DMSDK_UNIVERSAL_FALLBACK_PATTERN.id), "hash-state plan has no universal fallback");
  let previousId = "";
  for (const decision of plan.decisions) {
    assert(
      previousId === "" || compareCodeUnits(previousId, decision.declarationId) < 0,
      "hash-state plan decisions are not uniquely sorted",
    );
    previousId = decision.declarationId;
    const selected = registry.get(decision.patternId);
    assert(selected, `${decision.declarationId}: hash-state decision names an unknown pattern`);
    assert(
      decision.family === selected.family && decision.emitter === selected.emitter,
      `${decision.declarationId}: hash-state decision owner differs`,
    );
    assert(decision.fallback === selected.fallback, `${decision.declarationId}: hash-state decision fallback differs`);
    assert(
      decision.priority === selected.priority && decision.cost === selected.cost,
      `${decision.declarationId}: hash-state decision rank differs`,
    );
    assert(
      decision.candidatePatternId === "state.incremental-hash-lifecycle",
      `${decision.declarationId}: hash-state candidate differs`,
    );
    assert(
      decision.semantics && typeof decision.semantics === "object",
      `${decision.declarationId}: hash-state semantics are missing`,
    );
    assert(Array.isArray(decision.trace), `${decision.declarationId}: hash-state decision trace is missing`);
    if (decision.fallback)
      assert(typeof decision.blocker === "string", `${decision.declarationId}: hash-state fallback has no blocker`);
    else
      assert(
        decision.blocker === null && decision.lifecycleComplete === true,
        `${decision.declarationId}: selected hash-state route is not complete`,
      );
  }
  assert(plan.coverage?.discovered === plan.decisions.length, "hash-state plan coverage total differs");
  assert(
    plan.coverage.selected === plan.decisions.filter(({ fallback }) => !fallback).length,
    "hash-state plan selected count differs",
  );
  assert(
    plan.coverage.universalFallback === plan.decisions.filter(({ fallback }) => fallback).length,
    "hash-state plan fallback count differs",
  );
  return new Map(plan.decisions.map((decision) => [decision.declarationId, decision]));
}
