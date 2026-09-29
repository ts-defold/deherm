import { createHash } from "node:crypto";

import { cstringValuePatterns } from "./dmsdk-pattern-catalog.mjs";
import { DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const normalizedText = (value) =>
  String(value ?? "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

export const DMSDK_CSTRING_VALUE_PLAN_KIND = "deherm.dmsdk-cstring-value-plan";
export const DMSDK_CSTRING_VALUE_ELIGIBILITY = Object.freeze({
  id: "global-cstring-value-abi-v1",
  context: "global",
  declarationKind: "function",
  variadic: false,
  excludedEffects: Object.freeze(["callbacks", "records", "templates", "spans"]),
  result: Object.freeze(["void", "cstring", "enum", "bool", "i32", "u32", "u64"]),
  parameters: Object.freeze(["const-cstring-in", "enum", "u32", "u64"]),
  requiresCString: true,
});

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

export function validateDmSdkCStringValuePolicy(value) {
  exactKeys(value, ["family", "recipe", "schemaVersion"], "C-string policy");
  assert(value.schemaVersion === 1, "C-string policy schemaVersion must be 1");
  assert(value.family === "cstring-value", "C-string policy family is unsupported");
  exactKeys(
    value.recipe,
    ["candidateSource", "fallback", "input", "result", "scratchCapacity", "semanticSource", "transport"],
    "C-string recipe",
  );
  assert(value.recipe.transport === "bounded-utf8-cstring-value", "C-string transport is unsupported");
  assert(
    Number.isSafeInteger(value.recipe.scratchCapacity) &&
      value.recipe.scratchCapacity > 0 &&
      value.recipe.scratchCapacity <= 0xffffffff,
    "C-string scratch capacity is unsupported",
  );
  assert(
    JSON.stringify(value.recipe.input) ===
      JSON.stringify({ nullability: "non-null", encoding: "js-string-utf8-no-embedded-nul" }),
    "C-string input codec is unsupported",
  );
  assert(
    JSON.stringify(value.recipe.result) ===
      JSON.stringify({ encoding: "native-null-terminated-bytes-decoded-as-utf8" }),
    "C-string result codec is unsupported",
  );
  assert(
    value.recipe.candidateSource === "revision-projection-global-cstring-value-abi",
    "C-string candidate source is unsupported",
  );
  assert(value.recipe.semanticSource === "revision-ir-public-documentation", "C-string semantic source is unsupported");
  assert(value.recipe.fallback === "universal-recipe", "C-string fallback is unsupported");
}

export function isDmSdkCStringValueCandidate(row) {
  const result = row.signature.result;
  const resultSupported =
    result.kind === "void" ||
    result.kind === "enum" ||
    result.kind === "cstring" ||
    (result.kind === "scalar" && ["bool", "i32", "u32", "u64"].includes(result.name));
  const parametersSupported = row.signature.parameters.every(
    ({ type }) =>
      type.kind === "cstring" || type.kind === "enum" || (type.kind === "scalar" && ["u32", "u64"].includes(type.name)),
  );
  return (
    row.effects.context.kind === "global" &&
    row.provenance.declarationKind === "function" &&
    row.signature.variadic === false &&
    row.effects.callbacks.present === false &&
    row.effects.records.present === false &&
    row.effects.templates.present === false &&
    row.effects.spans.present === false &&
    resultSupported &&
    parametersSupported &&
    [result, ...row.signature.parameters.map(({ type }) => type)].some(({ kind }) => kind === "cstring") &&
    row.signature.parameters
      .filter(({ type }) => type.kind === "cstring")
      .every(({ direction, type }) => direction === "in" && type.mutable === false)
  );
}

function role(type, result = false) {
  if (type.kind === "cstring") return result ? "cstring-result" : "cstring-in";
  if (type.kind === "void") return "scalar:void";
  if (type.kind === "enum") return `enum:${type.name}`;
  return `scalar:${type.name}`;
}

function facts(row, semanticTokens = []) {
  return {
    id: row.id,
    kind: row.provenance.declarationKind,
    result: { role: role(row.signature.result, true), direction: "value" },
    parameters: row.signature.parameters.map((parameter) => ({
      role: role(parameter.type),
      direction: parameter.direction,
    })),
    families: [...row.provenance.families],
    semanticTokens,
  };
}

export function inferCStringSemantics(declaration, row, recipe) {
  if (!declaration || declaration.kind !== "function")
    return { blocker: "cstring-semantic-contract-unresolved", semanticTokens: [], contract: null, evidence: null };
  const description = normalizedText(declaration.description);
  const returnDescription = normalizedText(declaration.returnDescription);
  const parameterDescriptions = declaration.parameters.map((parameter) => normalizedText(parameter.description));
  const evidence = {
    source: "revision-ir-public-documentation",
    description: declaration.description ?? null,
    returnDescription: declaration.returnDescription ?? null,
    parameters: declaration.parameters.map(({ name, description: detail }) => ({ name, description: detail ?? null })),
  };
  const cstringParameterDescriptions = declaration.parameters
    .map((parameter, index) => ({ parameter, index, text: parameterDescriptions[index] }))
    .filter(({ index }) => row.signature.parameters[index]?.type.kind === "cstring")
    .map(({ text }) => text);
  if (
    cstringParameterDescriptions.some((text) => /\b(?:may|can) be null\b|\bnullable\b|\boptional string\b/u.test(text))
  )
    return { blocker: "cstring-input-nullability-contradiction", semanticTokens: [], contract: null, evidence };
  if (
    cstringParameterDescriptions.some((text) =>
      /\barbitrary (?:bytes|encoding)\b|\bnon[- ]?utf(?:-?8)?\b|\bnot (?:necessarily )?(?:valid )?utf(?:-?8)?\b|\bembedded (?:null|nul)\b|\bnull byte\b/u.test(
        text,
      ),
    )
  )
    return { blocker: "cstring-input-encoding-contradiction", semanticTokens: [], contract: null, evidence };
  if (
    cstringParameterDescriptions.some((text) =>
      /\b(?:retained|stored)\b|\basynchronous(?:ly)?\b|\bkeeps?\b[^.]*\bpointer\b|\blater use\b|\bafter (?:the )?(?:call|function) returns\b/u.test(
        text,
      ),
    )
  )
    return { blocker: "cstring-input-lifetime-unresolved", semanticTokens: [], contract: null, evidence };
  if (
    row.signature.result.kind === "cstring" &&
    /\bnot (?:null|nul)[- ]?terminated\b|\bunterminated\b|\blength[- ]delimited\b|\barbitrary bytes\b|\bnon[- ]?utf(?:-?8)?\b|\bnot (?:necessarily )?(?:valid )?utf(?:-?8)?\b/u.test(
      `${description} ${returnDescription}`,
    )
  )
    return { blocker: "cstring-result-codec-contradiction", semanticTokens: [], contract: null, evidence };
  if (
    row.signature.result.kind === "cstring" &&
    row.signature.parameters.length === 1 &&
    row.signature.parameters[0].type.kind === "enum" &&
    /\b(?:may|can) return (?:a )?(?:null|nil)\b|\breturns? (?:a )?(?:null|nil)\b|\b0 (?:if|when|otherwise)\b/u.test(
      `${description} ${returnDescription}`,
    )
  )
    return { blocker: "cstring-result-nullability-contradiction", semanticTokens: [], contract: null, evidence };
  if (row.signature.result.kind === "cstring" && description.includes("original string used to produce a hash"))
    return {
      blocker: "borrowed-registry-result-has-no-atomic-copy-contract",
      semanticTokens: [],
      contract: null,
      evidence,
    };
  if (
    description.includes("adapter family") &&
    description.includes("string identifier") &&
    row.signature.result.kind === "enum"
  )
    return { blocker: "restricted-string-domain-requires-validator", semanticTokens: [], contract: null, evidence };
  if (
    description.includes("profiler") ||
    description.includes("last added scope") ||
    description.includes("current thread name")
  )
    return { blocker: "profiler-logical-context-unresolved", semanticTokens: [], contract: null, evidence };
  if (
    row.signature.result.kind === "cstring" &&
    row.signature.parameters.length === 1 &&
    row.signature.parameters[0].type.kind === "enum" &&
    (description.includes("to string") ||
      description.includes("string representation") ||
      returnDescription.includes("as a string"))
  ) {
    return {
      blocker: null,
      semanticTokens: ["enum-string-representation", "non-null-cstring-result"],
      contract: { id: "enum-literal-result-utf8", input: null, result: { nullability: "non-null", ...recipe.result } },
      evidence,
    };
  }
  if (
    row.signature.result.kind === "cstring" &&
    row.signature.parameters.length === 1 &&
    row.signature.parameters[0].type.kind === "cstring" &&
    returnDescription.includes("0 otherwise")
  ) {
    return {
      blocker: null,
      semanticTokens: ["nullable-cstring-result", "safe-utf8-cstring-input"],
      contract: {
        id: "nullable-input-slice-utf8",
        input: recipe.input,
        result: { nullability: "nullable", ...recipe.result },
      },
      evidence,
    };
  }
  if (
    row.signature.parameters.some(({ type }) => type.kind === "cstring") &&
    row.signature.result.kind !== "cstring" &&
    declaration.parameters.every(
      (_, index) =>
        row.signature.parameters[index]?.type.kind !== "cstring" ||
        /(?:string|path|utf-?8)/u.test(parameterDescriptions[index]),
    )
  ) {
    return {
      blocker: null,
      semanticTokens: ["safe-utf8-cstring-input"],
      contract: { id: "input-js-utf8", input: recipe.input, result: null },
      evidence,
    };
  }
  return { blocker: "cstring-semantic-contract-unresolved", semanticTokens: [], contract: null, evidence };
}

function validateInputs({ projection, sdkIr, policy, texts }) {
  assert(projection?.schemaVersion === 1 && Array.isArray(projection.rows), "C-string plan has invalid projection IR");
  assert(sdkIr?.schemaVersion === 1 && Array.isArray(sdkIr.declarations), "C-string plan has invalid SDK IR");
  assert(projection.defoldRevision === sdkIr.defoldRevision, "C-string projection and SDK IR revisions differ");
  assert(
    texts &&
      typeof texts.projection === "string" &&
      typeof texts.sdkIr === "string" &&
      typeof texts.policy === "string",
    "C-string plan source texts are missing",
  );
  assert(
    JSON.stringify(JSON.parse(texts.projection)) === JSON.stringify(projection),
    "C-string projection object differs from its authenticated text",
  );
  assert(
    JSON.stringify(JSON.parse(texts.sdkIr)) === JSON.stringify(sdkIr),
    "C-string SDK IR object differs from its authenticated text",
  );
  assert(
    JSON.stringify(JSON.parse(texts.policy)) === JSON.stringify(policy),
    "C-string policy object differs from its authenticated text",
  );
  assert(
    projection.sources?.hashes?.ir === sha256(texts.sdkIr),
    "C-string projection does not authenticate the SDK IR",
  );
  assert(
    new Set(projection.rows.map(({ id }) => id)).size === projection.rows.length,
    "C-string projection has duplicate ids",
  );
  assert(
    new Set(sdkIr.declarations.map(({ id }) => id)).size === sdkIr.declarations.length,
    "C-string SDK IR has duplicate ids",
  );
  validateDmSdkCStringValuePolicy(policy);
}

export function resolveCStringContracts(rows, recipeDocument, sdkIr) {
  validateDmSdkCStringValuePolicy(recipeDocument);
  const declarations = new Map(sdkIr.declarations.map((declaration) => [declaration.id, declaration]));
  const patterns = [...cstringValuePatterns(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  return [...rows].map((row) => {
    const semantics = inferCStringSemantics(declarations.get(row.id), row, recipeDocument.recipe);
    const selected = selectDmSdkPattern(facts(row, semantics.semanticTokens), patterns);
    const blocker = semantics.blocker ?? (selected.fallback ? "cstring-semantic-contract-unresolved" : null);
    return {
      row,
      blocker,
      rule: blocker ? { id: blocker } : null,
      contract: blocker ? null : semantics.contract,
      semantics,
      patternDecision: selected,
    };
  });
}

export function buildDmSdkCStringValuePlan({ projection, sdkIr, policy, texts }) {
  validateInputs({ projection, sdkIr, policy, texts });
  const registry = [...cstringValuePatterns(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const sourceOrdinals = new Map(projection.rows.map((row, index) => [row.id, index]));
  const resolved = resolveCStringContracts(projection.rows.filter(isDmSdkCStringValueCandidate), policy, sdkIr);
  const selectedNames = new Map();
  for (const { row, blocker } of resolved) {
    if (blocker) continue;
    const base =
      String(row.symbol)
        .split(/[^A-Za-z0-9]+/u)
        .filter(Boolean)
        .map((part, index) =>
          index === 0 ? `${part[0].toLowerCase()}${part.slice(1)}` : `${part[0].toUpperCase()}${part.slice(1)}`,
        )
        .join("") || "binding";
    const members = selectedNames.get(base) ?? [];
    members.push(row.id);
    selectedNames.set(base, members);
  }
  const routeNames = new Map();
  for (const [base, ids] of selectedNames) {
    for (const id of ids) routeNames.set(id, ids.length === 1 ? base : `${base}_${sha256(id).slice(0, 8)}`);
  }
  const decisions = resolved.map(({ row, blocker, contract, semantics, patternDecision }) => ({
    declarationId: row.id,
    sourceOrdinal: sourceOrdinals.get(row.id),
    typescriptName: routeNames.get(row.id) ?? null,
    patternId: blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN.id : patternDecision.patternId,
    family: blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN.family : patternDecision.family,
    emitter: blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN.emitter : patternDecision.emitter,
    fallback: blocker !== null,
    priority: blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN.priority : patternDecision.priority,
    cost: blocker ? DMSDK_UNIVERSAL_FALLBACK_PATTERN.cost : patternDecision.cost,
    semanticTokens: semantics.semanticTokens,
    semantics,
    contract,
    blocker,
    trace: patternDecision.trace,
  }));
  return {
    schemaVersion: 1,
    kind: DMSDK_CSTRING_VALUE_PLAN_KIND,
    defoldRevision: projection.defoldRevision,
    sources: {
      projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
      sdkIr: "packages/bindings/generated/defold-sdk-ir.json",
      policy: "packages/bindings/overrides/dmsdk-cstring-value-bindings.json",
    },
    sourceHashes: {
      projection: sha256(texts.projection),
      sdkIr: sha256(texts.sdkIr),
      policy: sha256(texts.policy),
    },
    eligibility: DMSDK_CSTRING_VALUE_ELIGIBILITY,
    patternRegistry: registry,
    coverage: {
      candidates: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
    },
    decisions,
  };
}

export function indexDmSdkCStringValuePlan(plan, { revision, sourceHashes, inputs } = {}) {
  assert(plan?.schemaVersion === 1 && plan.kind === DMSDK_CSTRING_VALUE_PLAN_KIND, "invalid C-string value plan");
  exactKeys(
    plan,
    [
      "coverage",
      "decisions",
      "defoldRevision",
      "eligibility",
      "kind",
      "patternRegistry",
      "schemaVersion",
      "sourceHashes",
      "sources",
    ],
    "C-string value plan",
  );
  exactKeys(plan.sources, ["policy", "projection", "sdkIr"], "C-string value plan sources");
  exactKeys(plan.sourceHashes, ["policy", "projection", "sdkIr"], "C-string value plan source hashes");
  if (revision !== undefined) assert(plan.defoldRevision === revision, "C-string value plan revision differs");
  for (const [key, digest] of Object.entries(sourceHashes ?? {}))
    assert(plan.sourceHashes?.[key] === digest, `C-string value plan ${key} provenance differs`);
  assert(Array.isArray(plan.decisions) && Array.isArray(plan.patternRegistry), "C-string value plan rows are missing");
  assert(
    JSON.stringify(plan.eligibility) === JSON.stringify(DMSDK_CSTRING_VALUE_ELIGIBILITY),
    "C-string value plan eligibility differs",
  );
  if (inputs !== undefined) {
    const expected = buildDmSdkCStringValuePlan(inputs);
    assert(
      JSON.stringify(plan) === JSON.stringify(expected),
      "C-string value plan differs from its authenticated compiler derivation",
    );
  }
  const expectedRegistry = [...cstringValuePatterns(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  assert(
    JSON.stringify(plan.patternRegistry) === JSON.stringify(expectedRegistry),
    "C-string value plan registry differs",
  );
  const registry = new Map(plan.patternRegistry.map((pattern) => [pattern.id, pattern]));
  assert(registry.size === plan.patternRegistry.length, "C-string value plan registry has duplicate ids");
  assert(registry.has(DMSDK_UNIVERSAL_FALLBACK_PATTERN.id), "C-string value plan has no universal fallback");
  let previousOrdinal = -1;
  const names = new Set();
  const declarationIds = new Set();
  const contractByPattern = new Map([
    ["cstring-value.enum-literal-result", "enum-literal-result-utf8"],
    ["cstring-value.nullable-input-slice", "nullable-input-slice-utf8"],
    ["cstring-value.input-transform", "input-js-utf8"],
  ]);
  for (const decision of plan.decisions) {
    exactKeys(
      decision,
      [
        "blocker",
        "contract",
        "cost",
        "declarationId",
        "emitter",
        "fallback",
        "family",
        "patternId",
        "priority",
        "semanticTokens",
        "semantics",
        "sourceOrdinal",
        "trace",
        "typescriptName",
      ],
      `${decision.declarationId}: C-string value decision`,
    );
    assert(
      Number.isSafeInteger(decision.sourceOrdinal) && decision.sourceOrdinal > previousOrdinal,
      "C-string value plan decisions are not in canonical projection order",
    );
    previousOrdinal = decision.sourceOrdinal;
    assert(!declarationIds.has(decision.declarationId), `${decision.declarationId}: duplicate C-string value decision`);
    declarationIds.add(decision.declarationId);
    const selected = registry.get(decision.patternId);
    assert(selected, `${decision.declarationId}: C-string value decision names an unknown pattern`);
    assert(
      decision.family === selected.family && decision.emitter === selected.emitter,
      `${decision.declarationId}: C-string value decision owner differs`,
    );
    assert(
      decision.fallback === selected.fallback,
      `${decision.declarationId}: C-string value decision fallback differs`,
    );
    assert(
      decision.priority === selected.priority && decision.cost === selected.cost,
      `${decision.declarationId}: C-string value decision rank differs`,
    );
    assert(
      decision.semantics && typeof decision.semantics === "object",
      `${decision.declarationId}: C-string value semantics are missing`,
    );
    assert(Array.isArray(decision.trace), `${decision.declarationId}: C-string value decision trace is missing`);
    if (decision.fallback) {
      assert(
        typeof decision.blocker === "string" && decision.contract === null && decision.typescriptName === null,
        `${decision.declarationId}: C-string fallback is incomplete`,
      );
    } else {
      assert(
        decision.blocker === null && decision.contract?.id,
        `${decision.declarationId}: selected C-string contract is missing`,
      );
      assert(
        decision.patternId.startsWith("cstring-value."),
        `${decision.declarationId}: selected C-string pattern is invalid`,
      );
      assert(
        decision.contract.id === contractByPattern.get(decision.patternId),
        `${decision.declarationId}: C-string contract differs from its pattern`,
      );
      assert(
        JSON.stringify([...decision.semanticTokens].sort(compareCodeUnits)) ===
          JSON.stringify([...selected.when.requireSemanticTokens].sort(compareCodeUnits)),
        `${decision.declarationId}: C-string semantic tokens differ from the selected pattern`,
      );
      assert(
        /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(decision.typescriptName),
        `${decision.declarationId}: C-string TypeScript name is invalid`,
      );
      assert(!names.has(decision.typescriptName), `${decision.declarationId}: C-string TypeScript name collides`);
      names.add(decision.typescriptName);
    }
  }
  assert(plan.coverage?.candidates === plan.decisions.length, "C-string value plan coverage total differs");
  assert(
    plan.coverage.selected === plan.decisions.filter(({ fallback }) => !fallback).length,
    "C-string value plan selected count differs",
  );
  assert(
    plan.coverage.universalFallback === plan.decisions.filter(({ fallback }) => fallback).length,
    "C-string value plan fallback count differs",
  );
  return new Map(plan.decisions.map((decision) => [decision.declarationId, decision]));
}
