const PATTERN_KEYS = new Set(["schemaVersion", "id", "family", "emitter", "priority", "cost", "fallback", "when"]);
const WHEN_KEYS = new Set(["declarationKinds", "result", "parameters", "rejectFamilies", "requireSemanticTokens"]);
const PARAMETER_KEYS = new Set(["count", "positions", "every", "some"]);
const COUNT_KEYS = new Set(["exact", "minimum", "maximum"]);
const MATCHER_KEYS = new Set(["roles", "rolePrefixes", "directions"]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, allowed, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label} has unsupported key '${key}'`);
}

function stringArray(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value) && (allowEmpty || value.length > 0), `${label} must be a non-empty string array`);
  assert(
    value.every((entry) => typeof entry === "string" && entry.length > 0),
    `${label} contains an invalid string`,
  );
  assert(new Set(value).size === value.length, `${label} contains a duplicate`);
  return [...value].sort(compareCodeUnits);
}

function normalizeMatcher(value, label) {
  exactKeys(value, MATCHER_KEYS, label);
  const matcher = {};
  if (value.roles !== undefined) matcher.roles = stringArray(value.roles, `${label}.roles`);
  if (value.rolePrefixes !== undefined) matcher.rolePrefixes = stringArray(value.rolePrefixes, `${label}.rolePrefixes`);
  if (value.directions !== undefined) matcher.directions = stringArray(value.directions, `${label}.directions`);
  assert(matcher.roles || matcher.rolePrefixes, `${label} must constrain roles or rolePrefixes`);
  return matcher;
}

function normalizeCount(value, label) {
  exactKeys(value, COUNT_KEYS, label);
  const count = {};
  for (const key of COUNT_KEYS) {
    if (value[key] === undefined) continue;
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, `${label}.${key} must be a non-negative safe integer`);
    count[key] = value[key];
  }
  assert(Object.keys(count).length > 0, `${label} must define exact, minimum, or maximum`);
  if (count.exact !== undefined) {
    assert(
      count.minimum === undefined && count.maximum === undefined,
      `${label}.exact cannot be combined with minimum or maximum`,
    );
  } else if (count.minimum !== undefined && count.maximum !== undefined) {
    assert(count.minimum <= count.maximum, `${label}.minimum exceeds maximum`);
  }
  return count;
}

function normalizeParameters(value, label) {
  exactKeys(value, PARAMETER_KEYS, label);
  const parameters = {};
  if (value.count !== undefined) parameters.count = normalizeCount(value.count, `${label}.count`);
  if (value.positions !== undefined) {
    assert(Array.isArray(value.positions), `${label}.positions must be an array`);
    parameters.positions = value.positions.map((entry, index) =>
      normalizeMatcher(entry, `${label}.positions[${index}]`),
    );
  }
  if (value.every !== undefined) {
    assert(Array.isArray(value.every) && value.every.length > 0, `${label}.every must be a non-empty matcher array`);
    parameters.every = value.every.map((entry, index) => normalizeMatcher(entry, `${label}.every[${index}]`));
  }
  if (value.some !== undefined) {
    assert(Array.isArray(value.some) && value.some.length > 0, `${label}.some must be a non-empty matcher array`);
    parameters.some = value.some.map((entry, index) => normalizeMatcher(entry, `${label}.some[${index}]`));
  }
  assert(Object.keys(parameters).length > 0, `${label} must contain at least one constraint`);
  return parameters;
}

function normalizeWhen(value, label) {
  exactKeys(value, WHEN_KEYS, label);
  const when = {};
  if (value.declarationKinds !== undefined)
    when.declarationKinds = stringArray(value.declarationKinds, `${label}.declarationKinds`);
  if (value.result !== undefined) when.result = normalizeMatcher(value.result, `${label}.result`);
  if (value.parameters !== undefined) when.parameters = normalizeParameters(value.parameters, `${label}.parameters`);
  if (value.rejectFamilies !== undefined)
    when.rejectFamilies = stringArray(value.rejectFamilies, `${label}.rejectFamilies`);
  if (value.requireSemanticTokens !== undefined)
    when.requireSemanticTokens = stringArray(value.requireSemanticTokens, `${label}.requireSemanticTokens`);
  assert(Object.keys(when).length > 0, `${label} must contain at least one condition`);
  return when;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function defineDmSdkPattern(value) {
  exactKeys(value, PATTERN_KEYS, "dmSDK pattern");
  assert(value.schemaVersion === 1, "dmSDK pattern schemaVersion must be 1");
  assert(typeof value.id === "string" && /^[a-z][a-z0-9.-]+$/u.test(value.id), "dmSDK pattern id is invalid");
  assert(typeof value.family === "string" && value.family.length > 0, `${value.id}: family is required`);
  assert(
    value.emitter === null || (typeof value.emitter === "string" && value.emitter.length > 0),
    `${value.id}: emitter must be a string or null`,
  );
  assert(
    Number.isSafeInteger(value.priority) && value.priority >= 0,
    `${value.id}: priority must be a non-negative safe integer`,
  );
  assert(Number.isSafeInteger(value.cost) && value.cost >= 0, `${value.id}: cost must be a non-negative safe integer`);
  assert(typeof value.fallback === "boolean", `${value.id}: fallback must be boolean`);
  if (value.fallback) {
    assert(value.when === null, `${value.id}: fallback pattern cannot have conditions`);
    assert(value.emitter !== null, `${value.id}: fallback pattern requires an emitter`);
  } else {
    assert(value.when !== null, `${value.id}: non-fallback pattern requires conditions`);
  }
  const pattern = {
    schemaVersion: 1,
    id: value.id,
    family: value.family,
    emitter: value.emitter,
    priority: value.priority,
    cost: value.cost,
    fallback: value.fallback,
    when: value.fallback ? null : normalizeWhen(value.when, `${value.id}.when`),
  };
  return deepFreeze(pattern);
}

function normalizeFacts(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "dmSDK selector facts must be an object");
  assert(typeof value.id === "string" && value.id.length > 0, "dmSDK selector facts require an id");
  assert(typeof value.kind === "string" && value.kind.length > 0, `${value.id}: declaration kind is required`);
  assert(value.result && typeof value.result.role === "string", `${value.id}: result role is required`);
  assert(Array.isArray(value.parameters), `${value.id}: parameters must be an array`);
  const parameters = value.parameters.map((parameter, index) => {
    assert(
      parameter && typeof parameter.role === "string" && typeof parameter.direction === "string",
      `${value.id}: invalid parameter ${index}`,
    );
    return { position: index, role: parameter.role, direction: parameter.direction };
  });
  return {
    id: value.id,
    kind: value.kind,
    result: { role: value.result.role, direction: value.result.direction ?? "value" },
    parameters,
    families: stringArray(value.families ?? [], `${value.id}.families`, { allowEmpty: true }),
    semanticTokens: stringArray(value.semanticTokens ?? [], `${value.id}.semanticTokens`, { allowEmpty: true }),
  };
}

function roleMatches(value, matcher) {
  const role = value.role;
  const roleMatch =
    (matcher.roles?.includes(role) ?? false) ||
    (matcher.rolePrefixes?.some((prefix) => role.startsWith(prefix)) ?? false);
  return roleMatch && (!matcher.directions || matcher.directions.includes(value.direction));
}

function evaluate(pattern, facts) {
  const blockers = [];
  const when = pattern.when;
  if (when.declarationKinds && !when.declarationKinds.includes(facts.kind)) {
    blockers.push(`declaration-kind:${facts.kind}`);
  }
  if (when.result && !roleMatches(facts.result, when.result)) {
    blockers.push(`result-role:${facts.result.role}`);
  }
  const parameterRules = when.parameters;
  if (parameterRules?.count) {
    const { exact, minimum, maximum } = parameterRules.count;
    if (exact !== undefined && facts.parameters.length !== exact)
      blockers.push(`parameter-count:${facts.parameters.length}`);
    if (minimum !== undefined && facts.parameters.length < minimum) blockers.push(`parameter-count-below:${minimum}`);
    if (maximum !== undefined && facts.parameters.length > maximum) blockers.push(`parameter-count-above:${maximum}`);
  }
  if (parameterRules?.positions) {
    if (facts.parameters.length !== parameterRules.positions.length) {
      blockers.push(`parameter-position-count:${facts.parameters.length}`);
    } else {
      parameterRules.positions.forEach((matcher, index) => {
        if (!roleMatches(facts.parameters[index], matcher))
          blockers.push(
            `parameter-position:${index}:${facts.parameters[index].direction}:${facts.parameters[index].role}`,
          );
      });
    }
  }
  if (parameterRules?.every) {
    for (const parameter of facts.parameters) {
      if (!parameterRules.every.some((matcher) => roleMatches(parameter, matcher))) {
        blockers.push(`parameter-role:${parameter.position}:${parameter.direction}:${parameter.role}`);
      }
    }
  }
  if (
    parameterRules?.some &&
    !parameterRules.some.some((matcher) => facts.parameters.some((parameter) => roleMatches(parameter, matcher)))
  ) {
    blockers.push("required-parameter-shape-absent");
  }
  for (const family of when.rejectFamilies ?? []) {
    if (facts.families.includes(family)) blockers.push(`rejected-family:${family}`);
  }
  for (const token of when.requireSemanticTokens ?? []) {
    if (!facts.semanticTokens.includes(token)) blockers.push(`semantic-token-missing:${token}`);
  }
  blockers.sort(compareCodeUnits);
  return Object.freeze({ patternId: pattern.id, applicable: blockers.length === 0, blockers: Object.freeze(blockers) });
}

/**
 * Select exactly one deterministic lowering pattern. A new lower-ranked rule
 * cannot alter an existing selection; an equal-ranked match fails closed.
 */
export function selectDmSdkPattern(rawFacts, rawPatterns) {
  const facts = normalizeFacts(rawFacts);
  assert(Array.isArray(rawPatterns) && rawPatterns.length > 0, `${facts.id}: pattern registry is empty`);
  const patterns = rawPatterns.map(defineDmSdkPattern);
  assert(new Set(patterns.map(({ id }) => id)).size === patterns.length, `${facts.id}: duplicate pattern id`);
  const fallbacks = patterns.filter(({ fallback }) => fallback);
  assert(fallbacks.length === 1, `${facts.id}: pattern registry requires exactly one fallback`);
  const evaluations = patterns
    .filter(({ fallback }) => !fallback)
    .map((pattern) => ({ pattern, trace: evaluate(pattern, facts) }));
  const traces = evaluations.map(({ trace }) => trace);
  const applicable = evaluations
    .filter(({ trace }) => trace.applicable)
    .map(({ pattern }) => pattern)
    .sort(
      (left, right) => right.priority - left.priority || left.cost - right.cost || compareCodeUnits(left.id, right.id),
    );
  let selected = applicable[0] ?? fallbacks[0];
  if (
    applicable.length > 1 &&
    applicable[0].priority === applicable[1].priority &&
    applicable[0].cost === applicable[1].cost
  ) {
    const tied = applicable
      .filter(({ priority, cost }) => priority === applicable[0].priority && cost === applicable[0].cost)
      .map(({ id }) => id);
    throw new Error(
      `${facts.id}: ambiguous dmSDK patterns at priority ${applicable[0].priority} cost ${applicable[0].cost}: ${tied.join(", ")}`,
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    declarationId: facts.id,
    patternId: selected.id,
    family: selected.family,
    emitter: selected.emitter,
    fallback: selected.fallback,
    priority: selected.priority,
    cost: selected.cost,
    trace: traces,
  });
}

export function compactDmSdkPatternDecision(decision) {
  assert(
    decision?.schemaVersion === 1 && typeof decision.patternId === "string" && Array.isArray(decision.trace),
    "invalid dmSDK pattern decision",
  );
  return decision.patternId;
}

export const DMSDK_UNIVERSAL_FALLBACK_PATTERN = defineDmSdkPattern({
  schemaVersion: 1,
  id: "universal.default",
  family: "universal-recipe",
  emitter: "@deherm/compiler/dmsdk-universal-materializer",
  priority: 0,
  cost: 1000,
  fallback: true,
  when: null,
});
