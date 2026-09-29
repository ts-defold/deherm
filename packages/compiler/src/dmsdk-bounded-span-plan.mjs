import { createHash } from "node:crypto";

import {
  analyzeAstcProbeRecipe,
  analyzeBase64SpanRecipe,
  analyzeFixedDigestRecipe,
  analyzeHashSpanRecipe,
  analyzeXteaSpanRecipe,
} from "./dmsdk-bounded-span-recipes.mjs";
import { indexCppSemanticFactArtifact } from "./cpp-semantic-facts.mjs";
import {
  astcProbePattern,
  base64SpanPattern,
  fixedDigestPattern,
  fixedWidthHashPattern,
  xteaSpanPattern,
} from "./dmsdk-pattern-catalog.mjs";
import { DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const DMSDK_BOUNDED_SPAN_PLAN_KIND = "deherm.dmsdk-bounded-span-plan";

export const DMSDK_BOUNDED_SPAN_FAMILIES = Object.freeze([
  Object.freeze({
    key: "fixedDigest",
    family: "fixed-digest",
    policySource: "packages/bindings/overrides/dmsdk-fixed-digest-bindings.json",
    pattern: fixedDigestPattern(),
    policyVersion: "fixed-digest-v4",
    requiresSourceFacts: true,
    analyze({ declaration, candidate, policy, sourceFact }) {
      return analyzeFixedDigestRecipe(declaration, candidate, policy.recipe, sourceFact);
    },
  }),
  Object.freeze({
    key: "base64",
    family: "base64-span",
    policySource: "packages/bindings/overrides/dmsdk-base64-span-bindings.json",
    pattern: base64SpanPattern(),
    policyVersion: "base64-span-v5",
    requiresSourceFacts: true,
    analyze({ declaration, candidate, policy, sourceFact }) {
      return analyzeBase64SpanRecipe(declaration, candidate, policy.recipe, sourceFact);
    },
  }),
  Object.freeze({
    key: "astc",
    family: "astc-probe",
    policySource: "packages/bindings/overrides/dmsdk-astc-probe-bindings.json",
    pattern: astcProbePattern(),
    policyVersion: "astc-probe-v4",
    requiresSourceFacts: true,
    analyze({ declaration, candidate, policy, sourceFact }) {
      return analyzeAstcProbeRecipe(declaration, candidate, policy.recipe, sourceFact);
    },
  }),
  Object.freeze({
    key: "xtea",
    family: "xtea-span",
    policySource: "packages/bindings/overrides/dmsdk-xtea-span-bindings.json",
    pattern: xteaSpanPattern(),
    policyVersion: "xtea-span-v4",
    requiresSourceFacts: true,
    analyze({ declaration, candidate, policy, sourceFact, enumDeclarations }) {
      return analyzeXteaSpanRecipe(declaration, candidate, enumDeclarations, policy.recipe, sourceFact);
    },
  }),
  Object.freeze({
    key: "hashSpan",
    family: "hash-span",
    policySource: "packages/bindings/overrides/dmsdk-hash-span-bindings.json",
    pattern: fixedWidthHashPattern(),
    policyVersion: "hash-span-v3",
    requiresSourceFacts: false,
    analyze({ declaration, candidate, policy }) {
      return analyzeHashSpanRecipe(declaration, candidate, policy.recipe);
    },
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function structurallyEligible(candidate, pattern) {
  const decision = selectDmSdkPattern(patternFacts(candidate), [pattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN]);
  const trace = decision.trace.find(({ patternId }) => patternId === pattern.id);
  return trace !== undefined && trace.blockers.every((blocker) => blocker.startsWith("semantic-token-missing:"));
}

export function isDmSdkBoundedSpanSourceFactCandidate(candidate) {
  return DMSDK_BOUNDED_SPAN_FAMILIES.some(
    ({ pattern, requiresSourceFacts }) => requiresSourceFacts && structurallyEligible(candidate, pattern),
  );
}

function validateInputs({ ir, shapes, sourceFacts, policies, texts }) {
  assert(ir.defoldRevision === shapes.defoldRevision, "bounded-span plan IR and ABI-shape revisions differ");
  assert(ir.defoldRevision === sourceFacts.defoldRevision, "bounded-span plan source-fact revision differs");
  assert(sha256(texts.ir) === shapes.sourceHashes.ir, "bounded-span plan ABI shapes do not authenticate the IR");
  assert(sha256(texts.ir) === sourceFacts.sourceHashes.ir, "bounded-span plan source facts do not authenticate the IR");
  assert(
    sha256(texts.shapes) === sourceFacts.sourceHashes.shapes,
    "bounded-span plan source facts do not authenticate the ABI shapes",
  );
  assert(
    new Set(ir.declarations.map(({ id }) => id)).size === ir.declarations.length,
    "bounded-span plan IR has duplicate ids",
  );
  assert(
    new Set(shapes.rows.map(({ id }) => id)).size === shapes.rows.length,
    "bounded-span plan shapes have duplicate ids",
  );
  for (const family of DMSDK_BOUNDED_SPAN_FAMILIES) {
    const policy = policies[family.key];
    assert(policy?.schemaVersion === 1, `${family.family}: unsupported policy schema`);
    assert(policy.policyVersion === family.policyVersion, `${family.family}: unsupported policy version`);
    assert(policy.recipe?.fallback === "universal-recipe", `${family.family}: universal fallback is required`);
  }
}

/**
 * Produce one compiler-owned decision for every structurally relevant bounded
 * span declaration. Family emitters consume this plan; they do not select or
 * reinterpret patterns independently.
 */
export function buildDmSdkBoundedSpanPlan({ ir, shapes, sourceFacts, policies, texts }) {
  validateInputs({ ir, shapes, sourceFacts, policies, texts });
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const enumDeclarations = new Map(
    ir.declarations.filter(({ kind }) => kind === "enum").map((declaration) => [declaration.name, declaration]),
  );
  const sourceFactsById = indexCppSemanticFactArtifact(sourceFacts, {
    revision: ir.defoldRevision,
    irText: texts.ir,
    shapesText: texts.shapes,
  });
  const patterns = DMSDK_BOUNDED_SPAN_FAMILIES.map(({ pattern }) => pattern);
  const registry = [...patterns, DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const decisions = [];

  for (const candidate of [...shapes.rows].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const eligible = DMSDK_BOUNDED_SPAN_FAMILIES.filter(({ pattern }) => structurallyEligible(candidate, pattern));
    if (eligible.length === 0) continue;
    const declaration = declarations.get(candidate.id);
    assert(declaration, `bounded-span structural candidate is absent from dmSDK IR: ${candidate.id}`);
    const analyses = eligible.map((family) => {
      const analysis = family.analyze({
        declaration,
        candidate,
        policy: policies[family.key],
        sourceFact: sourceFactsById.get(candidate.id),
        enumDeclarations,
      });
      return {
        family: family.family,
        patternId: family.pattern.id,
        semantics: analysis.semantics,
        missingFacts: analysis.missingFacts,
      };
    });
    const semanticTokens = [...new Set(analyses.flatMap(({ semantics }) => semantics?.semanticTokens ?? []))].sort(
      compareCodeUnits,
    );
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
      missingFacts: selected ? [] : analyses.flatMap(({ missingFacts }) => missingFacts).sort(compareCodeUnits),
      structuralCandidates: analyses.map(({ patternId }) => patternId).sort(compareCodeUnits),
      trace: decision.trace,
    });
  }

  return {
    schemaVersion: 1,
    kind: DMSDK_BOUNDED_SPAN_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      sourceFacts: "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json",
      policies: Object.fromEntries(DMSDK_BOUNDED_SPAN_FAMILIES.map(({ key, policySource }) => [key, policySource])),
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

export function indexDmSdkBoundedSpanPlan(plan, { revision, sourceHashes } = {}) {
  assert(plan?.schemaVersion === 1 && plan.kind === DMSDK_BOUNDED_SPAN_PLAN_KIND, "invalid bounded-span plan");
  if (revision !== undefined) assert(plan.defoldRevision === revision, "bounded-span plan revision differs");
  for (const [key, digest] of Object.entries(sourceHashes ?? {})) {
    assert(plan.sourceHashes?.[key] === digest, `bounded-span plan ${key} provenance differs`);
  }
  assert(Array.isArray(plan.decisions), "bounded-span plan decisions are missing");
  assert(Array.isArray(plan.patternRegistry), "bounded-span plan registry is missing");
  const registry = new Map(plan.patternRegistry.map((pattern) => [pattern.id, pattern]));
  assert(registry.size === plan.patternRegistry.length, "bounded-span plan registry has duplicate ids");
  assert(registry.has(DMSDK_UNIVERSAL_FALLBACK_PATTERN.id), "bounded-span plan registry has no universal fallback");
  let previousId = "";
  for (const decision of plan.decisions) {
    assert(
      typeof decision.declarationId === "string" && decision.declarationId.length > 0,
      "bounded-span decision has no id",
    );
    assert(
      previousId === "" || compareCodeUnits(previousId, decision.declarationId) < 0,
      "bounded-span decisions are not uniquely sorted",
    );
    previousId = decision.declarationId;
    const pattern = registry.get(decision.patternId);
    assert(pattern, `${decision.declarationId}: bounded-span decision names an unknown pattern`);
    assert(
      decision.family === pattern.family,
      `${decision.declarationId}: bounded-span family differs from its pattern`,
    );
    assert(
      decision.emitter === pattern.emitter,
      `${decision.declarationId}: bounded-span emitter differs from its pattern`,
    );
    assert(
      decision.fallback === pattern.fallback,
      `${decision.declarationId}: bounded-span fallback differs from its pattern`,
    );
    assert(
      decision.priority === pattern.priority && decision.cost === pattern.cost,
      `${decision.declarationId}: bounded-span rank differs from its pattern`,
    );
    assert(
      Array.isArray(decision.structuralCandidates) && decision.structuralCandidates.length > 0,
      `${decision.declarationId}: bounded-span structural candidates are missing`,
    );
    assert(
      decision.structuralCandidates.every((patternId) => registry.has(patternId) && !registry.get(patternId).fallback),
      `${decision.declarationId}: bounded-span structural candidate is unknown or fallback`,
    );
    assert(
      JSON.stringify(decision.structuralCandidates) ===
        JSON.stringify([...new Set(decision.structuralCandidates)].sort(compareCodeUnits)),
      `${decision.declarationId}: bounded-span structural candidates are not unique and sorted`,
    );
    assert(
      JSON.stringify(decision.semanticTokens) ===
        JSON.stringify([...new Set(decision.semanticTokens)].sort(compareCodeUnits)),
      `${decision.declarationId}: bounded-span semantic tokens are not unique and sorted`,
    );
    assert(Array.isArray(decision.trace), `${decision.declarationId}: bounded-span selection trace is missing`);
    if (decision.fallback)
      assert(decision.semantics === null, `${decision.declarationId}: fallback cannot carry selected semantics`);
    else {
      assert(
        decision.structuralCandidates.includes(decision.patternId),
        `${decision.declarationId}: selected pattern is not structural`,
      );
      assert(
        decision.semantics && typeof decision.semantics === "object",
        `${decision.declarationId}: selected semantics are missing`,
      );
    }
  }
  assert(plan.coverage?.structurallyRelevant === plan.decisions.length, "bounded-span plan coverage total differs");
  assert(
    plan.coverage.selected === plan.decisions.filter(({ fallback }) => !fallback).length,
    "bounded-span selected count differs",
  );
  assert(
    plan.coverage.universalFallback === plan.decisions.filter(({ fallback }) => fallback).length,
    "bounded-span fallback count differs",
  );
  const index = new Map(plan.decisions.map((decision) => [decision.declarationId, decision]));
  return index;
}
