import { createHash } from "node:crypto";

import { selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function patternRows(patterns) {
  return new Map(patterns.filter(({ fallback }) => !fallback).map((pattern) => [pattern.id, pattern]));
}

function candidateRows(decision, registry) {
  return decision.trace
    .map((trace) => {
      const pattern = registry.get(trace.patternId);
      const missingSemanticTokens = trace.blockers
        .filter((blocker) => blocker.startsWith("semantic-token-missing:"))
        .map((blocker) => blocker.slice("semantic-token-missing:".length));
      const structuralBlockers = trace.blockers.filter((blocker) => !blocker.startsWith("semantic-token-missing:"));
      return {
        patternId: pattern.id,
        family: pattern.family,
        emitter: pattern.emitter,
        priority: pattern.priority,
        cost: pattern.cost,
        structuralBlockers,
        missingSemanticTokens,
      };
    })
    .sort(
      (left, right) =>
        left.structuralBlockers.length - right.structuralBlockers.length ||
        right.priority - left.priority ||
        left.cost - right.cost ||
        compareCodeUnits(left.patternId, right.patternId),
    );
}

function optimizationRecommendation(candidates, attempts, shape) {
  const available = attempts.filter(({ state }) => state === "available");
  if (available.length > 0) {
    return {
      action: "retain-universal-preferred",
      requiredForAvailability: false,
      reason: "a generated auxiliary/provider specialization exists, while the complete universal route is intentionally preferred",
      availablePatterns: available.map(({ family, patternId, emitter }) => ({ family, patternId, emitter })),
    };
  }
  const semanticCandidates = candidates.filter(({ structuralBlockers }) => structuralBlockers.length === 0);
  if (semanticCandidates.length > 0) {
    const candidate = semanticCandidates[0];
    const blocked = attempts.filter(({ state }) => state === "blocked");
    return {
      action: blocked.length > 0 ? "resolve-specialization-blockers" : "derive-source-semantic-facts-if-expressed",
      requiredForAvailability: false,
      patternId: candidate.patternId,
      family: candidate.family,
      emitter: candidate.emitter,
      missingSemanticTokens: candidate.missingSemanticTokens,
      generatorBlockers: [...new Set(blocked.flatMap(({ blockers }) => blockers))].sort(compareCodeUnits),
      evidenceBoundary:
        "specialization may be selected only when the revision expresses the required facts; otherwise retain the universal call",
      preserveUniversalUntilSpecialized: true,
    };
  }
  return {
    action: "extend-composable-specialization-if-profitable",
    requiredForAvailability: false,
    observedShape: shape,
    closestPatterns: candidates.slice(0, 3).map(({ patternId, family, emitter, structuralBlockers }) => ({
      patternId,
      family,
      emitter,
      structuralBlockers,
    })),
    preserveUniversalUntilSpecialized: true,
  };
}

function baseRecommendation(indexEntry, recipe) {
  const materialization = indexEntry?.materialization ?? {
    state: "specialization-required",
    requirements: recipe.fallback.requirements,
    diagnostic: "no call-symbol-index entry",
  };
  if (materialization.state === "universal-ready") {
    return {
      action: "use-universal-materializer",
      state: materialization.state,
      requirements: [],
      diagnostic: null,
    };
  }
  return {
    action: "supply-usage-facts",
    state: materialization.state,
    requirements: [...new Set(materialization.requirements ?? recipe.fallback.requirements ?? [])].sort(compareCodeUnits),
    diagnostic: materialization.diagnostic ?? null,
  };
}

function normalizeAttempt(attempt) {
  return {
    family: attempt.family,
    state: attempt.state,
    patternId: attempt.patternId ?? null,
    emitter: attempt.emitter,
    blockers: [...new Set(attempt.blockers ?? [])].sort(compareCodeUnits),
  };
}

export function createDmSdkFallbackAudit({
  defoldRevision,
  recipes,
  shapes,
  patterns,
  callIndex,
  projectionRows,
  specializationAttempts = new Map(),
  sourceHashes,
}) {
  assert(typeof defoldRevision === "string" && defoldRevision.length > 0, "dmSDK fallback audit requires a revision");
  assert(Array.isArray(recipes) && Array.isArray(shapes) && Array.isArray(patterns), "dmSDK fallback audit inputs are invalid");
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const projectionById = new Map(projectionRows.map((row) => [row.id, row]));
  assert(shapeById.size === shapes.length, "dmSDK fallback audit ABI shapes contain duplicate declaration ids");
  const registry = patternRows(patterns);
  const fallbackRecipes = recipes.filter(({ preferredLowering }) => preferredLowering.state === "universal-fallback");
  const groups = new Map();
  const declarations = fallbackRecipes.map((recipe) => {
    const shape = shapeById.get(recipe.declarationId);
    const projection = projectionById.get(recipe.declarationId);
    assert(shape, `${recipe.declarationId}: universal fallback has no ABI shape`);
    assert(projection, `${recipe.declarationId}: universal fallback has no projection row`);
    const facts = {
      id: recipe.declarationId,
      kind: shape.kind,
      result: shape.result,
      parameters: shape.parameters,
      families: shape.families,
      semanticTokens: [],
    };
    const decision = selectDmSdkPattern(facts, patterns);
    const candidates = candidateRows(decision, registry);
    const attempts = (specializationAttempts.get(recipe.declarationId) ?? []).map(normalizeAttempt).sort(
      (left, right) => compareCodeUnits(left.family, right.family) || compareCodeUnits(left.patternId ?? "", right.patternId ?? ""),
    );
    const recommendation = optimizationRecommendation(candidates, attempts, shape.shape);
    const groupBody = {
      kind: shape.kind,
      shape: shape.shape,
      families: [...shape.families].sort(compareCodeUnits),
      semanticCandidates: candidates
        .filter(({ structuralBlockers }) => structuralBlockers.length === 0)
        .map(({ patternId, family, emitter, missingSemanticTokens }) => ({
          patternId,
          family,
          emitter,
          missingSemanticTokens,
        })),
      closestStructuralPatterns: candidates
        .filter(({ structuralBlockers }) => structuralBlockers.length > 0)
        .slice(0, 3)
        .map(({ patternId, family, emitter, structuralBlockers }) => ({
          patternId,
          family,
          emitter,
          structuralBlockers,
        })),
    };
    const groupId = sha256(canonicalJson(groupBody));
    const existing = groups.get(groupId) ?? { groupId, ...groupBody, declarationIds: [] };
    existing.declarationIds.push(recipe.declarationId);
    groups.set(groupId, existing);
    return {
      numericId: recipe.numericId,
      declarationId: recipe.declarationId,
      groupId,
      universal: baseRecommendation(callIndex.declarations[recipe.declarationId], recipe),
      optimization: recommendation,
      attempts,
      sourceState: {
        loweringState: projection.loweringState,
        family: projection.lowering?.family ?? null,
        policy: projection.lowering?.policy ?? null,
        semanticTokensNeeded: [...(projection.semanticTokensNeeded ?? [])].sort(compareCodeUnits),
      },
      availability: {
        state: "emitted",
        route: "universal-recipe",
        interventionRequired: false,
      },
    };
  });
  declarations.sort((left, right) => left.numericId - right.numericId || compareCodeUnits(left.declarationId, right.declarationId));
  const shapeGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      declarationIds: group.declarationIds.sort(compareCodeUnits),
      declarationCount: group.declarationIds.length,
    }))
    .sort((left, right) => compareCodeUnits(left.groupId, right.groupId));
  assert(declarations.length === fallbackRecipes.length, "dmSDK fallback audit omitted a universal fallback");
  assert(declarations.every(({ groupId }) => groups.has(groupId)), "dmSDK fallback audit declaration has no shape group");
  const catalog = patterns.map(({ schemaVersion, id, family, emitter, priority, cost, fallback, when }) => ({
    schemaVersion,
    id,
    family,
    emitter,
    priority,
    cost,
    fallback,
    when,
  }));
  const body = {
    schemaVersion: 1,
    kind: "deherm.dmsdk-fallback-audit",
    defoldRevision,
    sourceHashes,
    patternCatalogSha256: sha256(canonicalJson(catalog)),
    coverage: {
      declarations: recipes.length,
      preferredSpecialized: recipes.length - fallbackRecipes.length,
      universalFallback: fallbackRecipes.length,
      auditedFallback: declarations.length,
      silentlyOmitted: 0,
      shapeGroups: shapeGroups.length,
      universalReady: declarations.filter(({ universal }) => universal.state === "universal-ready").length,
      usageFactsRequired: declarations.filter(({ universal }) => universal.action === "supply-usage-facts").length,
      existingAuxiliarySpecialization: declarations.filter(
        ({ optimization }) => optimization.action === "retain-universal-preferred",
      ).length,
      semanticRecipeCandidates: declarations.filter(
        ({ optimization }) =>
          ["derive-source-semantic-facts-if-expressed", "resolve-specialization-blockers"].includes(
            optimization.action,
          ),
      ).length,
      composableUniversalOnly: declarations.filter(
        ({ optimization }) => optimization.action === "extend-composable-specialization-if-profitable",
      ).length,
    },
    patternCatalog: catalog,
    shapeGroups,
    declarations,
  };
  return Object.freeze({ ...body, reportSha256: sha256(canonicalJson(body)) });
}
