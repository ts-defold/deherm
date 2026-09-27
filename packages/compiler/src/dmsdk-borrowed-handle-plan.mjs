import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { borrowedHandlePattern } from "./dmsdk-pattern-catalog.mjs";
import { defineDmSdkPattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SOURCE_KEYS = Object.freeze(["ir", "shapes", "projection", "policy"]);

export const DMSDK_BORROWED_HANDLE_PLAN_KIND = "deherm.dmsdk-borrowed-handle-plan";

// This is package-owned shaping knowledge. It intentionally contains no
// Defold declaration names, IDs, headers, or revision facts.
export const DMSDK_BORROWED_HANDLE_ELIGIBILITY = Object.freeze({
  schemaVersion: 1,
  patternId: "handle.borrowed-provider-boundary",
  trustDefault: Object.freeze({
    id: "defold-public-by-value-resource-borrow",
    assertion: "by-value resource parameters are synchronous/noescape borrowed unless revision evidence contradicts",
    contradictionPolicy: "unsafe-or-unknown-dominates",
  }),
  requiredSemanticTokens: Object.freeze([
    "borrowed-handle-consumer",
    "provider-validated-handle",
    "synchronous-noescape",
  ]),
  effectPrecedence: Object.freeze([
    "transferred",
    "retained",
    "asynchronous",
    "destructive",
    "acquired-or-leased",
    "returned-to-owner",
  ]),
  declarationNameTerms: Object.freeze({
    destructive: Object.freeze(["close", "dealloc", "deallocate", "delete", "destroy", "dispose", "free", "shutdown"]),
    retained: Object.freeze(["addref", "incref", "retain"]),
    "acquired-or-leased": Object.freeze(["acquire", "lease"]),
    "returned-to-owner": Object.freeze(["release", "return"]),
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

function effectSignals(declaration, projection) {
  const signals = [];
  const add = (category, source, value) => signals.push({ category, source, value });
  for (const ownership of [
    projection.effects?.ownership?.result,
    ...(projection.effects?.ownership?.parameters ?? []),
  ]) {
    if (typeof ownership !== "string") continue;
    if (/consum|destroy|finaliz/iu.test(ownership)) add("destructive", "projection-ownership", ownership);
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
      if (prose.includes(phrase)) add(category, "public-documentation", phrase);
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

function effectTaxonomy(classification, handlePositions) {
  const unsafeArgument = {
    transferred: "transfer",
    retained: "retain",
    asynchronous: "escape",
    destructive: "finalize",
    "acquired-or-leased": "retain",
    "returned-to-owner": "release",
  }[classification];
  return {
    resourceArguments: handlePositions.map((position) => ({
      position,
      effect: unsafeArgument ?? "mutate-nonownership",
    })),
    result: classification === "acquired-or-leased" ? "lease-token" : "plain",
    completion: classification === "asynchronous" ? "retained/deferred" : "synchronous-noescape",
  };
}

export function inferDmSdkBorrowedHandleEffect(declaration, projection, handlePositions = []) {
  const signals = effectSignals(declaration, projection);
  const classification = signals[0]?.category ?? "trusted-borrowed-default";
  return {
    classification,
    admission: {
      kind: signals.length ? "revision-contradiction" : "trusted-defold-default",
      trustDefault: DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.id,
    },
    taxonomy: effectTaxonomy(classification, handlePositions),
    sources: sortedUnique(signals.map(({ source }) => source)),
    signals,
  };
}

function validatePolicy(policy) {
  exactKeys(
    policy,
    ["schemaVersion", "family", "selection", "providerContract", "targetPolicy"],
    "borrowed-handle policy",
  );
  assert(
    policy.schemaVersion === 1 && policy.family === "borrowed-handle-consumers",
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

function validateInputs({ ir, shapes, projection, policy, texts }) {
  for (const key of SOURCE_KEYS) {
    assert(typeof texts?.[key] === "string", `borrowed-handle plan is missing exact ${key} source text`);
    assert(
      isDeepStrictEqual(JSON.parse(texts[key]), { ir, shapes, projection, policy }[key]),
      `borrowed-handle plan ${key} object differs from its source text`,
    );
  }
  assert(ir?.schemaVersion === 1 && Array.isArray(ir.declarations), "borrowed-handle plan has invalid dmSDK IR");
  assert(shapes?.schemaVersion === 1 && Array.isArray(shapes.rows), "borrowed-handle plan has invalid ABI shapes");
  assert(
    projection?.schemaVersion === 1 && Array.isArray(projection.rows),
    "borrowed-handle plan has invalid projection IR",
  );
  assert(
    ir.defoldRevision === shapes.defoldRevision && ir.defoldRevision === projection.defoldRevision,
    "borrowed-handle plan inputs use different Defold revisions",
  );
  assert(shapes.sourceHashes?.ir === sha256(texts.ir), "borrowed-handle shapes do not authenticate the IR");
  assert(
    projection.sources?.hashes?.ir === sha256(texts.ir),
    "borrowed-handle projection does not authenticate the IR",
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

export function buildDmSdkBorrowedHandlePlan({ ir, shapes, projection, policy, texts }) {
  validateInputs({ ir, shapes, projection, policy, texts });
  const declarations = new Map(ir.declarations.map((row) => [row.id, row]));
  const projections = new Map(projection.rows.map((row) => [row.id, row]));
  const structural = borrowedHandlePattern(policy.selection);
  const specialized = semanticPattern(policy.selection);
  const registry = [specialized, DMSDK_UNIVERSAL_FALLBACK_PATTERN];
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
    const effect = inferDmSdkBorrowedHandleEffect(declaration, projected, handleParameterPositions);
    const safe = effect.classification === "trusted-borrowed-default";
    const semanticTokens = safe ? [...DMSDK_BORROWED_HANDLE_ELIGIBILITY.requiredSemanticTokens] : [];
    const decision = selectDmSdkPattern(patternFacts(shape, semanticTokens), registry);
    const blockers = safe
      ? []
      : sortedUnique(effect.signals.map(({ category }) => `borrowed-handle-effect:${category}`));
    const semantics = safe
      ? {
          transport: "provider-validated-u64-handle",
          ownership: "borrowed-only-no-transfer-no-release",
          lifetime: "synchronous-call-only",
          thread: "provider-current-thread",
          handleParameterPositions,
          evidenceBasis: DMSDK_BORROWED_HANDLE_ELIGIBILITY.trustDefault.id,
        }
      : null;
    return {
      declarationId: shape.id,
      sourceOrdinal: ordinal,
      order: safe ? selectedOrder++ : null,
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
    schemaVersion: 1,
    kind: DMSDK_BORROWED_HANDLE_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    providerAbiVersion: 2,
    abi: {
      version: 2,
      compatibility: "intentional-breaking-replan",
      bindingIdentity: "dense-selected-order-within-authenticated-plan",
      reason: "withdrawal renumbers private pre-release version-one IDs atomically",
    },
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
      policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
    },
    sourceHashes: Object.fromEntries(SOURCE_KEYS.map((key) => [key, sha256(texts[key])])),
    eligibility: DMSDK_BORROWED_HANDLE_ELIGIBILITY,
    patternRegistry: registry,
    coverage: {
      structurallyRelevant: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
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
    plan.schemaVersion === 1 && plan.kind === DMSDK_BORROWED_HANDLE_PLAN_KIND,
    "invalid borrowed-handle plan identity",
  );
  assert(plan.providerAbiVersion === 2, "borrowed-handle provider ABI version differs");
  exactKeys(plan.abi, ["version", "compatibility", "bindingIdentity", "reason"], "borrowed-handle ABI policy");
  assert(plan.abi.version === 2, "borrowed-handle plan must explicitly use ABI version two");
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
      ["classification", "admission", "taxonomy", "sources", "signals"],
      `${decision.declarationId}: borrowed-handle effect`,
    );
    exactKeys(decision.effect.admission, ["kind", "trustDefault"], `${decision.declarationId}: effect admission`);
    exactKeys(
      decision.effect.taxonomy,
      ["resourceArguments", "result", "completion"],
      `${decision.declarationId}: effect taxonomy`,
    );
    assert(
      Array.isArray(decision.effect.sources) && Array.isArray(decision.effect.signals),
      `${decision.declarationId}: borrowed-handle effect evidence is invalid`,
    );
    assert(
      Array.isArray(decision.effect.taxonomy.resourceArguments),
      `${decision.declarationId}: resource effects are invalid`,
    );
    for (const resourceArgument of decision.effect.taxonomy.resourceArguments)
      exactKeys(resourceArgument, ["position", "effect"], `${decision.declarationId}: resource argument effect`);
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
        decision.patternId === DMSDK_BORROWED_HANDLE_ELIGIBILITY.patternId,
        `${decision.declarationId}: selected borrowed-handle pattern differs`,
      );
      assert(
        decision.order === selectedOrder++,
        `${decision.declarationId}: borrowed-handle selected order is not dense`,
      );
      assert(
        decision.effect.classification === "trusted-borrowed-default",
        `${decision.declarationId}: unsafe effect was selected`,
      );
      assert(
        decision.effect.admission.kind === "trusted-defold-default",
        `${decision.declarationId}: trust basis differs`,
      );
      assert(
        decision.effect.signals.length === 0,
        `${decision.declarationId}: selected route has contradiction evidence`,
      );
      exactKeys(
        decision.semantics,
        ["transport", "ownership", "lifetime", "thread", "handleParameterPositions", "evidenceBasis"],
        `${decision.declarationId}: borrowed-handle semantics`,
      );
    }
    index.set(decision.declarationId, decision);
  }
  exactKeys(
    plan.coverage,
    ["structurallyRelevant", "selected", "universalFallback", "effectBlockers"],
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
