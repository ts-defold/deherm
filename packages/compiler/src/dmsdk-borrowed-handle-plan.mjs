import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION,
  validateDmSdkCppOwnershipEffectReport,
} from "./dmsdk-cpp-ownership-effect-frontend.mjs";
import { borrowedHandlePattern, handleLifecyclePattern } from "./dmsdk-pattern-catalog.mjs";
import { defineDmSdkPattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SOURCE_KEYS = Object.freeze(["ir", "shapes", "projection", "policy", "effectFacts"]);
const BORROWED_SEMANTIC_TOKENS = Object.freeze([
  "borrowed-handle-consumer",
  "provider-validated-handle",
  "synchronous-noescape",
]);
const LIFECYCLE_SEMANTIC_TOKENS = Object.freeze([
  "handle-lifecycle-transition",
  "provider-validated-handle",
  "synchronous-noescape",
]);

export const DMSDK_BORROWED_HANDLE_PLAN_KIND = "deherm.dmsdk-borrowed-handle-plan";

// This is package-owned shaping knowledge. It intentionally contains no
// Defold declaration names, IDs, headers, or revision facts.
export const DMSDK_BORROWED_HANDLE_ELIGIBILITY = Object.freeze({
  schemaVersion: 1,
  patternId: "handle.borrowed-provider-boundary",
  trustDefault: Object.freeze({
    id: "defold-public-by-value-resource-borrow",
    assertion: "by-value resource parameters are synchronous/noescape borrowed unless revision evidence contradicts",
    contradictionPolicy: "positive-defold-revision-contradiction-dominates",
  }),
  requiredSemanticTokens: BORROWED_SEMANTIC_TOKENS,
  effectPrecedence: Object.freeze([
    "transferred",
    "retained",
    "asynchronous",
    "destructive",
    "acquired-or-leased",
    "returned-to-owner",
    "state-transition",
  ]),
  declarationNameTerms: Object.freeze({
    destructive: Object.freeze(["dealloc", "deallocate", "delete", "destroy", "dispose", "free"]),
    retained: Object.freeze(["addref", "incref", "retain"]),
    "acquired-or-leased": Object.freeze(["acquire", "lease"]),
    "returned-to-owner": Object.freeze(["release", "return"]),
    "state-transition": Object.freeze(["close", "shutdown"]),
  }),
  documentationPhrases: Object.freeze({
    transferred: Object.freeze(["takes ownership", "take ownership", "transfers ownership", "transfer ownership"]),
    retained: Object.freeze(["retains the", "retained by", "reference count", "shared reference"]),
    asynchronous: Object.freeze([
      "asynchronous",
      "asynchronously",
      "stored for later",
      "invoked later",
      "called later",
    ]),
    destructive: Object.freeze(["becomes invalid after this call", "deallocates the", "destroys the", "frees the"]),
    "acquired-or-leased": Object.freeze(["acquire a", "acquires a", "lease a", "leases a"]),
    "returned-to-owner": Object.freeze([
      "return to the pool",
      "returns to the pool",
      "release a previously",
      "releases a previously",
    ]),
    "state-transition": Object.freeze(["close the", "closes the", "shut down", "shuts down"]),
  }),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(object(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unsupported schema keys: ${actual.join(", ")}`,
  );
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function splitIdentifier(value) {
  return String(value)
    .replace(/::/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function sourceOrdinal(id) {
  const match = String(id).match(/:(\d+)$/u);
  assert(match, `${id}: borrowed-handle candidate has no source ordinal`);
  const ordinal = Number(match[1]);
  assert(Number.isSafeInteger(ordinal) && ordinal >= 0, `${id}: borrowed-handle source ordinal is invalid`);
  return ordinal;
}

function patternFacts(shape, semanticTokens = []) {
  return {
    id: shape.id,
    kind: shape.kind,
    result: shape.result,
    parameters: shape.parameters,
    families: shape.families,
    semanticTokens,
  };
}

function semanticPattern(selection) {
  const structural = borrowedHandlePattern(selection);
  return defineDmSdkPattern({
    ...structural,
    when: {
      ...structural.when,
      requireSemanticTokens: DMSDK_BORROWED_HANDLE_ELIGIBILITY.requiredSemanticTokens,
    },
  });
}

function lifecycleSemanticPattern(selection) {
  return defineDmSdkPattern(handleLifecyclePattern(selection));
}

function structurallyRelevant(shape, pattern) {
  const decision = selectDmSdkPattern(patternFacts(shape, DMSDK_BORROWED_HANDLE_ELIGIBILITY.requiredSemanticTokens), [
    pattern,
    DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  ]);
  return !decision.fallback;
}

function documentation(declaration) {
  return [
    declaration.description,
    declaration.returnDescription,
    ...(declaration.parameters ?? []).map(({ description }) => description),
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "u").test(text);
}

function effectSignals(declaration, projection) {
  const signals = [];
  const add = (category, source, value) => signals.push({ category, source, value });
  for (const ownership of [
    projection.effects?.ownership?.result,
    ...(projection.effects?.ownership?.parameters ?? []),
  ]) {
    if (typeof ownership !== "string") continue;
    // A `*-candidate-requires-token` projection is an unresolved request for
    // lifecycle facts, never positive evidence of a transition.
    if (/^(?:consumed|ownership-consumed|destroyed|finalized|ownership-finalized)$/iu.test(ownership))
      add("destructive", "projection-ownership", ownership);
    // `borrowed-or-transferred-requires-token` is the projection's unresolved
    // default, not positive transfer evidence. Only an asserted effect wins.
    if (/^(?:transferred|ownership-transferred|takes-ownership)$/iu.test(ownership))
      add("transferred", "projection-ownership", ownership);
    if (/^(?:retained|ownership-retained|reference-retained)$/iu.test(ownership))
      add("retained", "projection-ownership", ownership);
  }
  if (
    projection.effects?.callbacks?.present === true ||
    /async|stored|deferred/iu.test(projection.effects?.thread?.callbacks ?? "")
  ) {
    add("asynchronous", "projection-effects", "callback-or-deferred-lifetime");
  }

  const nameTokens = new Set(splitIdentifier(String(declaration.name).split("::").at(-1)));
  for (const [category, terms] of Object.entries(DMSDK_BORROWED_HANDLE_ELIGIBILITY.declarationNameTerms)) {
    for (const term of terms) {
      if (nameTokens.has(term)) add(category, "declaration-name", term);
    }
  }

  const prose = documentation(declaration);
  for (const [category, phrases] of Object.entries(DMSDK_BORROWED_HANDLE_ELIGIBILITY.documentationPhrases)) {
    for (const phrase of phrases) {
      if (containsPhrase(prose, phrase)) add(category, "public-documentation", phrase);
    }
  }
  return signals
    .filter(
      (signal, index, values) =>
        values.findIndex(
          (other) =>
            other.category === signal.category && other.source === signal.source && other.value === signal.value,
        ) === index,
    )
    .sort(
      (left, right) =>
        DMSDK_BORROWED_HANDLE_ELIGIBILITY.effectPrecedence.indexOf(left.category) -
          DMSDK_BORROWED_HANDLE_ELIGIBILITY.effectPrecedence.indexOf(right.category) ||
        compareCodeUnits(left.source, right.source) ||
        compareCodeUnits(left.value, right.value),
    );
}

const LIFECYCLE_WORDS = new Set([
  "acquire",
  "add",
  "close",
  "dealloc",
  "deallocate",
  "delete",
  "destroy",
  "dispose",
  "free",
  "inc",
  "incref",
  "lease",
  "ref",
  "release",
  "retain",
  "return",
  "shutdown",
]);

function lifecycleTargetWords(declaration) {
  return splitIdentifier(String(declaration.name).split("::").at(-1)).filter((word) => !LIFECYCLE_WORDS.has(word));
}

function parameterWords(declaration, position) {
  const parameter = declaration.parameters?.[position] ?? {};
  return new Set(splitIdentifier(`${parameter.name ?? ""} ${parameter.type ?? ""} ${parameter.description ?? ""}`));
}

function matchingHandlePositions(declaration, handlePositions, targetWords) {
  if (targetWords.length === 0) return [];
  return handlePositions.filter((position) => {
    const words = parameterWords(declaration, position);
    return targetWords.some((word) => words.has(word));
  });
}

function replaceResourceEffect(resourceArguments, positions, effect) {
  const selected = new Set(positions);
  return resourceArguments.map((argument) => (selected.has(argument.position) ? { ...argument, effect } : argument));
}

function effectTaxonomy(classification, declaration, shape, handlePositions) {
  let resourceArguments = handlePositions.map((position) => ({ position, effect: "borrow" }));
  const targetWords = lifecycleTargetWords(declaration);
  const matches = matchingHandlePositions(declaration, handlePositions, targetWords);
  const prose = documentation(declaration);
  const nonLocalEffects = [];

  if (classification === "destructive") {
    // A named resource target wins. A bare Delete/Destroy/Free conventionally
    // consumes the final handle, while DeleteBones(parent) is intentionally a
    // non-local descendant transition because "bones" matches no parameter.
    const descendantTransition =
      targetWords.length > 0 &&
      matches.length === 0 &&
      /recursive|child|descendant|hierarchy|bone/iu.test(`${declaration.name} ${prose}`);
    const positions =
      matches.length > 0
        ? [matches.at(-1)]
        : !descendantTransition && (targetWords.length === 0 || handlePositions.length === 1)
          ? [handlePositions.at(-1)]
          : [];
    resourceArguments = replaceResourceEffect(resourceArguments, positions.filter(Number.isInteger), "finalize");
    if (descendantTransition) nonLocalEffects.push("descendant-finalize");
    if (/associated resources|all resources|owned/iu.test(prose)) nonLocalEffects.push("owned-descendants-finalized");
  } else if (classification === "retained") {
    resourceArguments = replaceResourceEffect(resourceArguments, [matches.at(-1) ?? handlePositions.at(-1)], "retain");
  } else if (classification === "returned-to-owner") {
    resourceArguments = replaceResourceEffect(resourceArguments, [matches.at(-1) ?? handlePositions.at(-1)], "release");
  } else if (classification === "acquired-or-leased") {
    // A void Acquire is the conventional AddRef spelling. A scalar result is
    // not promoted into an owned handle merely because the function says
    // Acquire (AcquireInstanceIndex returns a plain uint32_t pool index).
    if (shape.result.role === "scalar:void")
      resourceArguments = replaceResourceEffect(
        resourceArguments,
        [matches.at(-1) ?? handlePositions.at(-1)],
        "retain",
      );
  } else if (classification === "state-transition") {
    const connection = handlePositions.find((position) => parameterWords(declaration, position).has("connection"));
    if (connection !== undefined) {
      resourceArguments = replaceResourceEffect(resourceArguments, [connection], "release");
      nonLocalEffects.push("connection-closed", "pool-slot-invalidated");
    } else if (/window/iu.test(`${declaration.name} ${prose}`)) {
      nonLocalEffects.push("associated-window-closed");
    } else {
      nonLocalEffects.push("associated-state-closed");
    }
  }

  return {
    resourceArguments,
    result: "none",
    completion: classification === "asynchronous" ? "retained/deferred" : "synchronous-noescape",
    nonLocalEffects: sortedUnique(nonLocalEffects),
  };
}

export function inferDmSdkBorrowedHandleEffect(declaration, projection, shape, handlePositions = []) {
  const signals = effectSignals(declaration, projection);
  const classification = signals[0]?.category ?? "trusted-borrowed-default";
  return {
    classification,
    admission: {
      kind: signals.length ? "revision-contradiction" : "defold-contract-trusted",
      trustDefault: DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.id,
    },
    taxonomy: effectTaxonomy(classification, declaration, shape, handlePositions),
    sources: sortedUnique(signals.map(({ source }) => source)),
    signals,
  };
}

function effectMode(effect) {
  if (effect.signals.some(({ category }) => ["transferred", "asynchronous"].includes(category))) return "fallback";
  if (
    effect.taxonomy.resourceArguments.some(({ effect: argumentEffect }) => argumentEffect !== "borrow") ||
    effect.taxonomy.result !== "none" ||
    effect.taxonomy.nonLocalEffects.length > 0
  )
    return "lifecycle";
  return "borrowed";
}

function sourceEffectProof(effectFacts, declarationId, handlePositions) {
  const row = effectFacts.functions.find(({ declarationId: candidate }) => candidate === declarationId);
  if (!row)
    return {
      state: "unknown",
      evidenceGaps: ["cpp-effect:declaration-not-observed"],
    };
  if (row.state !== "observed" || !object(row.fact))
    return {
      state: "unknown",
      evidenceGaps: sortedUnique(
        row.diagnostics.length > 0
          ? row.diagnostics.map((diagnostic) => `cpp-effect:${diagnostic}`)
          : ["cpp-effect:fact-unavailable"],
      ),
    };

  const fact = row.fact;
  const gaps = [];
  if (fact.diagnostics.length > 0) gaps.push("cpp-effect:compiler-diagnostics");
  if (fact.ownershipEffect !== "none") gaps.push("cpp-effect:function-ownership-unresolved");
  if (fact.resultProvenance !== "plain-value") gaps.push("cpp-effect:result-provenance-unresolved");
  if (fact.completion !== "synchronous") gaps.push("cpp-effect:completion-unresolved");
  if (fact.escape !== "noescape") gaps.push("cpp-effect:escape-unresolved");
  const parameters = new Map(fact.parameters.map((parameter) => [parameter.index, parameter]));
  for (const position of handlePositions) {
    const parameter = parameters.get(position);
    if (!parameter) {
      gaps.push(`cpp-effect:parameter-${position}-unavailable`);
      continue;
    }
    if (!["none", "borrowed"].includes(parameter.ownershipEffect))
      gaps.push(`cpp-effect:parameter-${position}-ownership-unresolved`);
    if (parameter.completion !== "synchronous") gaps.push(`cpp-effect:parameter-${position}-completion-unresolved`);
    if (parameter.escape !== "noescape") gaps.push(`cpp-effect:parameter-${position}-escape-unresolved`);
  }
  return {
    state: gaps.length === 0 ? "proven" : "unknown",
    evidenceGaps: sortedUnique(gaps),
  };
}

function validatePolicy(policy) {
  exactKeys(
    policy,
    ["schemaVersion", "family", "selection", "providerContract", "targetPolicy"],
    "borrowed-handle policy",
  );
  assert(
    policy.schemaVersion === 2 && policy.family === "borrowed-handle-consumers",
    "borrowed-handle policy identity is invalid",
  );
  exactKeys(
    policy.selection,
    [
      "declarationKinds",
      "resultRoles",
      "handleRolePrefix",
      "parameterRoles",
      "requiresHandleParameter",
      "rejectedFamilies",
    ],
    "borrowed-handle selection",
  );
  assert(policy.selection.requiresHandleParameter === true, "borrowed-handle policy must require a handle parameter");
  assert(
    policy.selection.handleRolePrefix === "handle:",
    "borrowed-handle policy has an unsupported handle role prefix",
  );
  // borrowedHandlePattern performs the remaining stable recipe schema validation.
  borrowedHandlePattern(policy.selection);
}

function validateInputs({ ir, shapes, projection, policy, effectFacts, texts }) {
  for (const key of SOURCE_KEYS) {
    assert(typeof texts?.[key] === "string", `borrowed-handle plan is missing exact ${key} source text`);
    assert(
      isDeepStrictEqual(JSON.parse(texts[key]), { ir, shapes, projection, policy, effectFacts }[key]),
      `borrowed-handle plan ${key} object differs from its source text`,
    );
  }
  assert(ir?.schemaVersion === 1 && Array.isArray(ir.declarations), "borrowed-handle plan has invalid dmSDK IR");
  assert(shapes?.schemaVersion === 1 && Array.isArray(shapes.rows), "borrowed-handle plan has invalid ABI shapes");
  assert(
    projection?.schemaVersion === 1 && Array.isArray(projection.rows),
    "borrowed-handle plan has invalid projection IR",
  );
  validateDmSdkCppOwnershipEffectReport(effectFacts);
  assert(
    isDeepStrictEqual(effectFacts.semanticAdmission, DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION),
    "borrowed-handle plan requires revision-authoritative source semantics",
  );
  assert(
    ir.defoldRevision === shapes.defoldRevision &&
      ir.defoldRevision === projection.defoldRevision &&
      ir.defoldRevision === effectFacts.defoldRevision,
    "borrowed-handle plan inputs use different Defold revisions",
  );
  assert(shapes.sourceHashes?.ir === sha256(texts.ir), "borrowed-handle shapes do not authenticate the IR");
  assert(
    projection.sources?.hashes?.ir === sha256(texts.ir),
    "borrowed-handle projection does not authenticate the IR",
  );
  assert(
    effectFacts.inputs?.ir === sha256(texts.ir) &&
      effectFacts.inputs?.shapes === sha256(texts.shapes) &&
      effectFacts.inputs?.policy === sha256(texts.policy),
    "borrowed-handle effect facts do not authenticate their plan inputs",
  );
  for (const [label, rows] of [
    ["IR", ir.declarations],
    ["shapes", shapes.rows],
    ["projection", projection.rows],
  ]) {
    assert(
      new Set(rows.map(({ id }) => id)).size === rows.length,
      `borrowed-handle ${label} has duplicate declaration IDs`,
    );
  }
  validatePolicy(policy);
}

export function buildDmSdkBorrowedHandlePlan({ ir, shapes, projection, policy, effectFacts, texts }) {
  validateInputs({ ir, shapes, projection, policy, effectFacts, texts });
  const declarations = new Map(ir.declarations.map((row) => [row.id, row]));
  const projections = new Map(projection.rows.map((row) => [row.id, row]));
  const structural = borrowedHandlePattern(policy.selection);
  const borrowed = semanticPattern(policy.selection);
  const lifecycle = lifecycleSemanticPattern(policy.selection);
  const registry = [lifecycle, borrowed, DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const candidates = shapes.rows
    .filter((shape) => structurallyRelevant(shape, structural))
    .map((shape) => {
      const declaration = declarations.get(shape.id);
      const projected = projections.get(shape.id);
      assert(declaration, `${shape.id}: borrowed-handle structural candidate is absent from dmSDK IR`);
      assert(projected, `${shape.id}: borrowed-handle structural candidate is absent from projection IR`);
      return { shape, declaration, projected, sourceOrdinal: sourceOrdinal(shape.id) };
    })
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal || compareCodeUnits(left.shape.id, right.shape.id));

  let selectedOrder = 0;
  const decisions = candidates.map(({ shape, declaration, projected, sourceOrdinal: ordinal }) => {
    const handleParameterPositions = shape.parameters
      .map(({ role }, position) => (role.startsWith(policy.selection.handleRolePrefix) ? position : null))
      .filter((position) => position !== null);
    const inferredEffect = inferDmSdkBorrowedHandleEffect(declaration, projected, shape, handleParameterPositions);
    const sourceProof = sourceEffectProof(effectFacts, shape.id, handleParameterPositions);
    const mode = effectMode(inferredEffect);
    const admissionKind =
      mode === "fallback"
        ? "revision-contradiction"
        : mode === "lifecycle"
          ? "revision-derived-lifecycle"
          : sourceProof.state === "proven"
            ? "source-derived"
            : "defold-contract-trusted";
    const effect = {
      ...inferredEffect,
      admission: {
        ...inferredEffect.admission,
        kind: admissionKind,
      },
      sourceProof,
    };
    const semanticTokens =
      mode === "borrowed" ? [...BORROWED_SEMANTIC_TOKENS] : mode === "lifecycle" ? [...LIFECYCLE_SEMANTIC_TOKENS] : [];
    const decision = selectDmSdkPattern(patternFacts(shape, semanticTokens), registry);
    const blockers =
      mode === "fallback"
        ? sortedUnique(effect.signals.map(({ category }) => `borrowed-handle-effect:${category}`))
        : [];
    const semantics =
      mode === "borrowed"
        ? {
            transport: "provider-validated-u64-handle",
            ownership: "borrowed-only-no-transfer-no-release",
            lifetime: "synchronous-call-only",
            thread: "provider-current-thread",
            handleParameterPositions,
            evidenceBasis:
              admissionKind === "source-derived"
                ? "cpp-ownership-effect-facts"
                : DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.id,
          }
        : mode === "lifecycle"
          ? {
              transport: "provider-validated-u64-handle",
              ownership: "generated-per-argument-lifecycle-transitions",
              lifetime: "synchronous-transition-committed-after-success",
              thread: "provider-current-thread",
              handleParameterPositions,
              lifecycle: effect.taxonomy,
              evidenceBasis: "pinned-defold-declaration-and-source-semantics",
            }
          : null;
    return {
      declarationId: shape.id,
      sourceOrdinal: ordinal,
      order: mode === "fallback" ? null : selectedOrder++,
      patternId: decision.patternId,
      family: decision.family,
      emitter: decision.emitter,
      fallback: decision.fallback,
      rank: { priority: decision.priority, cost: decision.cost },
      semanticTokens,
      semantics,
      effect,
      blockers,
      trace: decision.trace,
    };
  });

  return {
    schemaVersion: 4,
    kind: DMSDK_BORROWED_HANDLE_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    providerAbiVersion: 3,
    abi: {
      version: 3,
      compatibility: "intentional-breaking-replan",
      bindingIdentity: "dense-selected-order-within-authenticated-plan",
      reason: "lifecycle effect vectors and post-success transitions extend the private provider ABI",
    },
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
      policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
      effectFacts: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
    },
    sourceHashes: Object.fromEntries(SOURCE_KEYS.map((key) => [key, sha256(texts[key])])),
    eligibility: DMSDK_BORROWED_HANDLE_ELIGIBILITY,
    patternRegistry: registry,
    coverage: {
      structurallyRelevant: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
      borrowedSelected: decisions.filter(({ fallback, family }) => !fallback && family === "borrowed-handle").length,
      lifecycleSelected: decisions.filter(({ fallback, family }) => !fallback && family === "handle-lifecycle").length,
      sourceDerived: decisions.filter(({ fallback, effect }) => !fallback && effect.admission.kind === "source-derived")
        .length,
      defoldContractTrusted: decisions.filter(
        ({ fallback, effect }) => !fallback && effect.admission.kind === "defold-contract-trusted",
      ).length,
      revisionDerivedLifecycle: decisions.filter(
        ({ fallback, effect }) => !fallback && effect.admission.kind === "revision-derived-lifecycle",
      ).length,
      effectBlockers: Object.fromEntries(
        DMSDK_BORROWED_HANDLE_ELIGIBILITY.effectPrecedence.map((category) => [
          category,
          decisions.filter(({ effect }) => effect.signals.some((signal) => signal.category === category)).length,
        ]),
      ),
    },
    decisions,
  };
}

function validatePlan(plan) {
  exactKeys(
    plan,
    [
      "schemaVersion",
      "kind",
      "defoldRevision",
      "providerAbiVersion",
      "abi",
      "sources",
      "sourceHashes",
      "eligibility",
      "patternRegistry",
      "coverage",
      "decisions",
    ],
    "borrowed-handle plan",
  );
  assert(
    plan.schemaVersion === 4 && plan.kind === DMSDK_BORROWED_HANDLE_PLAN_KIND,
    "invalid borrowed-handle plan identity",
  );
  assert(plan.providerAbiVersion === 3, "borrowed-handle provider ABI version differs");
  exactKeys(plan.abi, ["version", "compatibility", "bindingIdentity", "reason"], "borrowed-handle ABI policy");
  assert(plan.abi.version === 3, "borrowed-handle plan must explicitly use ABI version three");
  assert(plan.abi.compatibility === "intentional-breaking-replan", "borrowed-handle ABI compatibility differs");
  assert(
    isDeepStrictEqual(plan.eligibility, DMSDK_BORROWED_HANDLE_ELIGIBILITY),
    "borrowed-handle eligibility recipe differs",
  );
  assert(Array.isArray(plan.patternRegistry) && Array.isArray(plan.decisions), "borrowed-handle plan rows are missing");
  exactKeys(plan.sources, SOURCE_KEYS, "borrowed-handle plan sources");
  exactKeys(plan.sourceHashes, SOURCE_KEYS, "borrowed-handle plan source hashes");
  for (const key of SOURCE_KEYS) {
    assert(
      typeof plan.sources[key] === "string" && plan.sources[key].length > 0,
      `borrowed-handle ${key} source is invalid`,
    );
    assert(/^[a-f0-9]{64}$/u.test(plan.sourceHashes[key]), `borrowed-handle ${key} source hash is invalid`);
  }
  for (const pattern of plan.patternRegistry) {
    assert(
      isDeepStrictEqual(pattern, defineDmSdkPattern(pattern)),
      `${pattern?.id ?? "unknown"}: invalid plan pattern`,
    );
  }
  const registry = new Map(plan.patternRegistry.map((pattern) => [pattern.id, pattern]));
  assert(registry.size === plan.patternRegistry.length, "borrowed-handle plan registry has duplicate IDs");
  assert(registry.has(DMSDK_UNIVERSAL_FALLBACK_PATTERN.id), "borrowed-handle plan has no universal fallback");
  let previousOrdinal = -1;
  let previousId = "";
  let selectedOrder = 0;
  const index = new Map();
  for (const decision of plan.decisions) {
    exactKeys(
      decision,
      [
        "declarationId",
        "sourceOrdinal",
        "order",
        "patternId",
        "family",
        "emitter",
        "fallback",
        "rank",
        "semanticTokens",
        "semantics",
        "effect",
        "blockers",
        "trace",
      ],
      `${decision.declarationId ?? "unknown"}: borrowed-handle decision`,
    );
    assert(
      typeof decision.declarationId === "string" && decision.declarationId.length > 0,
      "borrowed-handle decision has no ID",
    );
    assert(!index.has(decision.declarationId), `${decision.declarationId}: duplicate borrowed-handle decision`);
    assert(
      Number.isSafeInteger(decision.sourceOrdinal) && decision.sourceOrdinal >= 0,
      `${decision.declarationId}: invalid source ordinal`,
    );
    assert(
      decision.sourceOrdinal > previousOrdinal ||
        (decision.sourceOrdinal === previousOrdinal && compareCodeUnits(previousId, decision.declarationId) < 0),
      `${decision.declarationId}: borrowed-handle decisions are not canonically ordered`,
    );
    previousOrdinal = decision.sourceOrdinal;
    previousId = decision.declarationId;
    const pattern = registry.get(decision.patternId);
    assert(pattern, `${decision.declarationId}: borrowed-handle decision names an unknown pattern`);
    assert(
      decision.family === pattern.family && decision.emitter === pattern.emitter,
      `${decision.declarationId}: borrowed-handle decision owner differs`,
    );
    assert(decision.fallback === pattern.fallback, `${decision.declarationId}: borrowed-handle fallback differs`);
    exactKeys(decision.rank, ["priority", "cost"], `${decision.declarationId}: borrowed-handle rank`);
    assert(
      decision.rank.priority === pattern.priority && decision.rank.cost === pattern.cost,
      `${decision.declarationId}: borrowed-handle rank differs`,
    );
    assert(
      Array.isArray(decision.semanticTokens) && Array.isArray(decision.blockers) && Array.isArray(decision.trace),
      `${decision.declarationId}: borrowed-handle decision arrays are invalid`,
    );
    assert(
      isDeepStrictEqual(decision.semanticTokens, sortedUnique(decision.semanticTokens)),
      `${decision.declarationId}: borrowed-handle semantic tokens are not unique and sorted`,
    );
    assert(
      isDeepStrictEqual(decision.blockers, sortedUnique(decision.blockers)),
      `${decision.declarationId}: borrowed-handle blockers are not unique and sorted`,
    );
    exactKeys(
      decision.effect,
      ["classification", "admission", "taxonomy", "sources", "signals", "sourceProof"],
      `${decision.declarationId}: borrowed-handle effect`,
    );
    exactKeys(decision.effect.admission, ["kind", "trustDefault"], `${decision.declarationId}: effect admission`);
    exactKeys(decision.effect.sourceProof, ["state", "evidenceGaps"], `${decision.declarationId}: source proof`);
    exactKeys(
      decision.effect.taxonomy,
      ["resourceArguments", "result", "completion", "nonLocalEffects"],
      `${decision.declarationId}: effect taxonomy`,
    );
    assert(
      Array.isArray(decision.effect.sources) && Array.isArray(decision.effect.signals),
      `${decision.declarationId}: borrowed-handle effect evidence is invalid`,
    );
    assert(
      ["proven", "unknown"].includes(decision.effect.sourceProof.state) &&
        isDeepStrictEqual(
          decision.effect.sourceProof.evidenceGaps,
          sortedUnique(decision.effect.sourceProof.evidenceGaps),
        ) &&
        (decision.effect.sourceProof.state === "proven") === (decision.effect.sourceProof.evidenceGaps.length === 0),
      `${decision.declarationId}: borrowed-handle source proof is invalid`,
    );
    assert(
      Array.isArray(decision.effect.taxonomy.resourceArguments) &&
        Array.isArray(decision.effect.taxonomy.nonLocalEffects),
      `${decision.declarationId}: resource effects are invalid`,
    );
    const resourcePositions = new Set();
    for (const resourceArgument of decision.effect.taxonomy.resourceArguments) {
      exactKeys(resourceArgument, ["position", "effect"], `${decision.declarationId}: resource argument effect`);
      assert(
        Number.isSafeInteger(resourceArgument.position) &&
          resourceArgument.position >= 0 &&
          !resourcePositions.has(resourceArgument.position),
        `${decision.declarationId}: resource argument positions are invalid`,
      );
      assert(
        ["borrow", "retain", "release", "finalize"].includes(resourceArgument.effect),
        `${decision.declarationId}: resource argument effect is invalid`,
      );
      resourcePositions.add(resourceArgument.position);
    }
    assert(decision.effect.taxonomy.result === "none", `${decision.declarationId}: resource result effect is invalid`);
    assert(
      ["synchronous-noescape", "retained/deferred"].includes(decision.effect.taxonomy.completion),
      `${decision.declarationId}: resource completion is invalid`,
    );
    assert(
      isDeepStrictEqual(
        decision.effect.taxonomy.nonLocalEffects,
        sortedUnique(decision.effect.taxonomy.nonLocalEffects),
      ),
      `${decision.declarationId}: non-local effects are not unique and sorted`,
    );
    for (const signal of decision.effect.signals)
      exactKeys(signal, ["category", "source", "value"], `${decision.declarationId}: borrowed-handle effect signal`);
    assert(
      decision.effect.admission.trustDefault === DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.id,
      `${decision.declarationId}: effect trust default differs`,
    );
    assert(
      isDeepStrictEqual(decision.effect.sources, sortedUnique(decision.effect.signals.map(({ source }) => source))),
      `${decision.declarationId}: effect sources differ from evidence`,
    );
    const expectedBlockers = sortedUnique(
      decision.effect.signals.map(({ category }) => `borrowed-handle-effect:${category}`),
    );
    if (decision.fallback) {
      assert(
        decision.order === null && decision.semantics === null,
        `${decision.declarationId}: fallback carries selected semantics`,
      );
      assert(decision.blockers.length > 0, `${decision.declarationId}: fallback has no blocker`);
      assert(
        decision.effect.admission.kind === "revision-contradiction",
        `${decision.declarationId}: fallback has no contradiction admission`,
      );
      assert(
        isDeepStrictEqual(decision.blockers, expectedBlockers),
        `${decision.declarationId}: fallback blockers differ from contradiction evidence`,
      );
    } else {
      assert(
        decision.order === selectedOrder++,
        `${decision.declarationId}: borrowed-handle selected order is not dense`,
      );
      if (decision.family === "borrowed-handle") {
        assert(
          decision.patternId === DMSDK_BORROWED_HANDLE_ELIGIBILITY.patternId,
          `${decision.declarationId}: selected borrowed-handle pattern differs`,
        );
        assert(
          ["source-derived", "defold-contract-trusted"].includes(decision.effect.admission.kind),
          `${decision.declarationId}: source/Defold-contract admission differs`,
        );
        assert(
          (decision.effect.admission.kind === "source-derived") === (decision.effect.sourceProof.state === "proven"),
          `${decision.declarationId}: source proof differs from admission`,
        );
        exactKeys(
          decision.semantics,
          ["transport", "ownership", "lifetime", "thread", "handleParameterPositions", "evidenceBasis"],
          `${decision.declarationId}: borrowed-handle semantics`,
        );
      } else {
        assert(decision.family === "handle-lifecycle", `${decision.declarationId}: selected family is unsupported`);
        assert(
          decision.effect.admission.kind === "revision-derived-lifecycle",
          `${decision.declarationId}: lifecycle admission differs`,
        );
        assert(effectMode(decision.effect) === "lifecycle", `${decision.declarationId}: lifecycle effect differs`);
        exactKeys(
          decision.semantics,
          ["transport", "ownership", "lifetime", "thread", "handleParameterPositions", "lifecycle", "evidenceBasis"],
          `${decision.declarationId}: handle-lifecycle semantics`,
        );
        assert(
          isDeepStrictEqual(decision.semantics.lifecycle, decision.effect.taxonomy),
          `${decision.declarationId}: lifecycle semantics differ from taxonomy`,
        );
      }
    }
    index.set(decision.declarationId, decision);
  }
  exactKeys(
    plan.coverage,
    [
      "structurallyRelevant",
      "selected",
      "universalFallback",
      "borrowedSelected",
      "lifecycleSelected",
      "sourceDerived",
      "defoldContractTrusted",
      "revisionDerivedLifecycle",
      "effectBlockers",
    ],
    "borrowed-handle coverage",
  );
  exactKeys(
    plan.coverage.effectBlockers,
    DMSDK_BORROWED_HANDLE_ELIGIBILITY.effectPrecedence,
    "borrowed-handle effect blocker coverage",
  );
  assert(plan.coverage.structurallyRelevant === plan.decisions.length, "borrowed-handle coverage total differs");
  assert(plan.coverage.selected === selectedOrder, "borrowed-handle selected coverage differs");
  assert(
    plan.coverage.universalFallback === plan.decisions.length - selectedOrder,
    "borrowed-handle fallback coverage differs",
  );
  assert(
    plan.coverage.borrowedSelected + plan.coverage.lifecycleSelected === plan.coverage.selected,
    "borrowed/lifecycle selected coverage differs",
  );
  assert(
    plan.coverage.sourceDerived ===
      plan.decisions.filter(({ fallback, effect }) => !fallback && effect.admission.kind === "source-derived").length,
    "borrowed-handle source-derived coverage differs",
  );
  assert(
    plan.coverage.defoldContractTrusted ===
      plan.decisions.filter(({ fallback, effect }) => !fallback && effect.admission.kind === "defold-contract-trusted")
        .length,
    "borrowed-handle Defold-contract coverage differs",
  );
  assert(
    plan.coverage.revisionDerivedLifecycle ===
      plan.decisions.filter(
        ({ fallback, effect }) => !fallback && effect.admission.kind === "revision-derived-lifecycle",
      ).length,
    "borrowed-handle lifecycle coverage differs",
  );
  for (const category of DMSDK_BORROWED_HANDLE_ELIGIBILITY.effectPrecedence) {
    const count = plan.decisions.filter(({ effect }) =>
      effect.signals.some((signal) => signal.category === category),
    ).length;
    assert(plan.coverage.effectBlockers[category] === count, `borrowed-handle ${category} coverage differs`);
  }
  return index;
}

export function indexDmSdkBorrowedHandlePlan(plan, inputs = undefined) {
  const index = validatePlan(plan);
  if (inputs !== undefined) {
    const rebuilt = buildDmSdkBorrowedHandlePlan(inputs);
    assert(isDeepStrictEqual(plan, rebuilt), "borrowed-handle plan differs from strict source re-derivation");
  }
  return index;
}
