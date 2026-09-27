import { createHash } from "node:crypto";

import {
  directPrimitiveScalarPattern,
  enumValuePattern,
  namedScalarPattern,
} from "./dmsdk-pattern-catalog.mjs";
import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  selectDmSdkPattern,
} from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const leaf = (value) => String(value).split("::").at(-1);

const DIRECT_PRIMITIVE_TYPES = new Set(["void", "bool", "uint16_t", "uint32_t", "uint64_t", "float"]);
const NAMED_SCALAR_TYPES = Object.freeze({
  void: "void",
  bool: "bool",
  int: "i32",
  int32_t: "i32",
  uint32_t: "u32",
  int64_t: "i64",
  uint64_t: "u64",
  uintptr_t: "usize",
  float: "f32",
  double: "f64",
});
const NAMED_SCALAR_ROLES = new Set(Object.values(NAMED_SCALAR_TYPES).map((lane) => `scalar:${lane}`));

export const DMSDK_VALUE_PLAN_KIND = "deherm.dmsdk-value-plan";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function typeAliasIndex(ir) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of ir.declarations) {
    if (declaration.kind !== "type-alias" || !declaration.name) continue;
    exact.set(declaration.name, declaration);
    const matches = leaves.get(leaf(declaration.name)) ?? [];
    matches.push(declaration);
    leaves.set(leaf(declaration.name), matches);
  }
  return { exact, leaves };
}

function resolveTypeAlias(type, symbol, index) {
  const clean = String(type)
    .replace(/\b(?:const|volatile|enum|struct|class)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (index.exact.has(clean)) return index.exact.get(clean);
  const namespace = String(symbol).split("::").slice(0, -1).join("::");
  if (namespace && index.exact.has(`${namespace}::${clean}`)) return index.exact.get(`${namespace}::${clean}`);
  const matches = index.leaves.get(leaf(clean)) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

export function inferScalarThunkSemantics(declaration, row) {
  if (!declaration || declaration.kind !== "function") return null;
  const nativeTypes = [declaration.returns ?? "void", ...(declaration.parameters ?? []).map(({ type }) => type)];
  if (!nativeTypes.every((type) => DIRECT_PRIMITIVE_TYPES.has(type))) return null;
  const roles = [row.result.role, ...row.parameters.map(({ role }) => role)];
  if (!roles.every((role) => role.startsWith("scalar:"))) return null;
  const leafName = leaf(declaration.name);
  const description = `${declaration.description ?? ""} ${declaration.returnDescription ?? ""}`.trim();
  const lifecycleOperation =
    declaration.parameters.length === 0 && declaration.returns === "void" && /(?:initialize|finalize)$/iu.test(leafName);
  const mayBlock = /(?:^|\b)(?:sleep|block(?:s|ing)?)(?:\b|$)/iu.test(`${leafName} ${description}`);
  return {
    semanticTokens: ["direct-native-primitive", "fixed-width-cell-codec", "synchronous-noescape"],
    capabilityBlocker: lifecycleOperation ? "lifecycle-capability-required" : null,
    lifecycleOperation,
    mayBlock,
    pureValueTransform:
      declaration.parameters.length > 0 && declaration.returns !== "void" && !lifecycleOperation && !mayBlock,
    evidence: {
      source: "revision-ir-abi+public-documentation",
      nativeTypes,
      description: declaration.description ?? null,
      returnDescription: declaration.returnDescription ?? null,
    },
  };
}

export function inferEnumValueSemantics(declaration, row) {
  if (!declaration || declaration.kind !== "function") return null;
  const roles = [row.result.role, ...row.parameters.map(({ role }) => role)];
  if (!roles.every((role) => role.startsWith("scalar:") || role.startsWith("enum:"))) return null;
  if (!roles.some((role) => role.startsWith("enum:"))) return null;
  const leafName = leaf(declaration.name);
  const description = `${declaration.description ?? ""} ${declaration.returnDescription ?? ""}`.toLowerCase();
  let capabilityBlocker = null;
  if (/unregister/iu.test(leafName)) capabilityBlocker = "extension-registry-capability-required";
  else if (/install/iu.test(leafName) && /before creating|initializ(?:e|es).*backend/iu.test(description))
    capabilityBlocker = "engine-lifecycle-capability-required";
  return {
    semanticTokens: ["declared-enum-domain", "fixed-width-cell-codec", "synchronous-noescape"],
    capabilityBlocker,
    evidence: {
      source: "revision-ir-abi+public-documentation",
      summary: declaration.description ?? null,
      result: declaration.returnDescription ?? null,
      enumRoles: roles.filter((role) => role.startsWith("enum:")).sort(compareCodeUnits),
    },
  };
}

export function inferNamedScalarSemantics(declaration, row, index) {
  if (!declaration || declaration.kind !== "function") return null;
  const roles = [row.result.role, ...row.parameters.map(({ role }) => role)];
  if (!roles.every((role) => NAMED_SCALAR_ROLES.has(role))) return null;
  const sourceTypes = [declaration.returns, ...declaration.parameters.map(({ type }) => type)];
  const aliases = sourceTypes.map((type) => resolveTypeAlias(type, declaration.name, index)).filter(Boolean);
  if (aliases.length === 0) return null;
  return {
    semanticTokens: ["fixed-width-cell-codec", "source-resolved-named-scalar", "synchronous-noescape"],
    aliases: [...new Set(aliases.map(({ id }) => id))].sort(compareCodeUnits),
  };
}

const VALUE_FAMILIES = Object.freeze([
  Object.freeze({
    family: "scalar-thunk",
    pattern: directPrimitiveScalarPattern(),
    analyze: ({ declaration, candidate }) => inferScalarThunkSemantics(declaration, candidate),
  }),
  Object.freeze({
    family: "enum-value",
    pattern: enumValuePattern(),
    analyze: ({ declaration, candidate }) => inferEnumValueSemantics(declaration, candidate),
  }),
  Object.freeze({
    family: "named-scalar",
    pattern: namedScalarPattern(),
    analyze: ({ declaration, candidate, aliasIndex }) => inferNamedScalarSemantics(declaration, candidate, aliasIndex),
  }),
]);

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

function structurallyEligible(candidate, pattern) {
  const decision = selectDmSdkPattern(patternFacts(candidate), [pattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN]);
  const trace = decision.trace.find(({ patternId }) => patternId === pattern.id);
  return trace !== undefined && trace.blockers.every((blocker) => blocker.startsWith("semantic-token-missing:"));
}

function validateInputs({ ir, shapes, policies, texts }) {
  assert(ir?.schemaVersion === 1 && Array.isArray(ir.declarations), "value plan has invalid dmSDK IR");
  assert(shapes?.schemaVersion === 1 && Array.isArray(shapes.rows), "value plan has invalid ABI shapes");
  assert(ir.defoldRevision === shapes.defoldRevision, "value plan IR and ABI-shape revisions differ");
  assert(shapes.sourceHashes?.ir === sha256(texts.ir), "value plan ABI shapes do not authenticate the IR");
  assert(new Set(ir.declarations.map(({ id }) => id)).size === ir.declarations.length, "value plan IR has duplicate ids");
  assert(new Set(shapes.rows.map(({ id }) => id)).size === shapes.rows.length, "value plan shapes have duplicate ids");
  assert(policies.scalar?.schemaVersion === 1 && policies.scalar.family === "scalar-thunk", "value plan scalar policy is invalid");
  assert(policies.enumValue?.schemaVersion === 2 && policies.enumValue.family === "enum-value", "value plan enum policy is invalid");
  assert(
    policies.namedScalar?.schemaVersion === 3 && policies.namedScalar.family === "named-scalar",
    "value plan named-scalar policy is invalid",
  );
  for (const [name, policy] of Object.entries(policies))
    assert(policy.recipe?.fallback === "universal-recipe", `value plan ${name} policy has no universal fallback`);
}

export function buildDmSdkValuePlan({ ir, shapes, policies, texts }) {
  validateInputs({ ir, shapes, policies, texts });
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const aliasIndex = typeAliasIndex(ir);
  const registry = [...VALUE_FAMILIES.map(({ pattern }) => pattern), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const decisions = [];
  for (const candidate of [...shapes.rows].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const eligible = VALUE_FAMILIES.filter(({ pattern }) => structurallyEligible(candidate, pattern));
    if (eligible.length === 0) continue;
    const declaration = declarations.get(candidate.id);
    assert(declaration, `value-plan structural candidate is absent from dmSDK IR: ${candidate.id}`);
    const analyses = eligible.map((family) => ({
      family: family.family,
      patternId: family.pattern.id,
      semantics: family.analyze({ declaration, candidate, aliasIndex }),
    }));
    const semanticTokens = [...new Set(analyses.flatMap(({ semantics }) => semantics?.semanticTokens ?? []))]
      .sort(compareCodeUnits);
    const decision = selectDmSdkPattern(patternFacts(candidate, semanticTokens), registry);
    const selected = analyses.find(({ patternId }) => patternId === decision.patternId) ?? null;
    decisions.push({
      declarationId: candidate.id,
      patternId: decision.patternId,
      family: decision.family,
      emitter: decision.emitter,
      fallback: decision.fallback,
      priority: decision.priority,
      cost: decision.cost,
      semanticTokens,
      semantics: selected?.semantics ?? null,
      missingFacts: selected ? [] : analyses.filter(({ semantics }) => !semantics).map(({ family }) => `${family}-semantic-facts`),
      structuralCandidates: analyses.map(({ patternId }) => patternId).sort(compareCodeUnits),
      trace: decision.trace,
    });
  }
  return {
    schemaVersion: 1,
    kind: DMSDK_VALUE_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      scalar: "packages/bindings/overrides/dmsdk-scalar-thunks.json",
      enumValue: "packages/bindings/overrides/dmsdk-enum-value-bindings.json",
      namedScalar: "packages/bindings/overrides/dmsdk-named-scalar-policies.json",
    },
    sourceHashes: Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, sha256(value)])),
    patternRegistry: registry,
    coverage: {
      structurallyRelevant: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
    },
    decisions,
  };
}

export function indexDmSdkValuePlan(plan, { revision, sourceHashes } = {}) {
  assert(plan?.schemaVersion === 1 && plan.kind === DMSDK_VALUE_PLAN_KIND, "invalid value plan");
  if (revision !== undefined) assert(plan.defoldRevision === revision, "value plan revision differs");
  for (const [key, digest] of Object.entries(sourceHashes ?? {}))
    assert(plan.sourceHashes?.[key] === digest, `value plan ${key} provenance differs`);
  assert(Array.isArray(plan.decisions) && Array.isArray(plan.patternRegistry), "value plan rows are missing");
  const registry = new Map(plan.patternRegistry.map((pattern) => [pattern.id, pattern]));
  assert(registry.size === plan.patternRegistry.length, "value plan registry has duplicate ids");
  assert(registry.has(DMSDK_UNIVERSAL_FALLBACK_PATTERN.id), "value plan has no universal fallback");
  let previousId = "";
  for (const decision of plan.decisions) {
    assert(previousId === "" || compareCodeUnits(previousId, decision.declarationId) < 0, "value plan decisions are not uniquely sorted");
    previousId = decision.declarationId;
    const pattern = registry.get(decision.patternId);
    assert(pattern, `${decision.declarationId}: value decision names an unknown pattern`);
    assert(decision.family === pattern.family && decision.emitter === pattern.emitter, `${decision.declarationId}: value decision owner differs`);
    assert(decision.fallback === pattern.fallback, `${decision.declarationId}: value decision fallback differs`);
    assert(decision.priority === pattern.priority && decision.cost === pattern.cost, `${decision.declarationId}: value decision rank differs`);
    assert(
      JSON.stringify(decision.structuralCandidates) === JSON.stringify([...new Set(decision.structuralCandidates)].sort(compareCodeUnits)),
      `${decision.declarationId}: value structural candidates are not unique and sorted`,
    );
    assert(Array.isArray(decision.trace), `${decision.declarationId}: value decision trace is missing`);
    if (decision.fallback) assert(decision.semantics === null, `${decision.declarationId}: value fallback carries semantics`);
    else {
      assert(decision.structuralCandidates.includes(decision.patternId), `${decision.declarationId}: selected value pattern is not structural`);
      assert(decision.semantics && typeof decision.semantics === "object", `${decision.declarationId}: selected value semantics are missing`);
    }
  }
  assert(plan.coverage?.structurallyRelevant === plan.decisions.length, "value plan coverage total differs");
  assert(plan.coverage.selected === plan.decisions.filter(({ fallback }) => !fallback).length, "value plan selected count differs");
  assert(plan.coverage.universalFallback === plan.decisions.filter(({ fallback }) => fallback).length, "value plan fallback count differs");
  return new Map(plan.decisions.map((decision) => [decision.declarationId, decision]));
}
