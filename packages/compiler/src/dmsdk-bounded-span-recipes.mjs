import { inferForwardedFixedOutputExtent } from "./cpp-semantic-facts.mjs";

export const BOUNDED_SPAN_SEMANTIC_TOKENS = Object.freeze({
  fixedDigest: Object.freeze(["fixed-output-byte-count", "synchronous-noescape"]),
  base64: Object.freeze(["bounded-output-capacity", "synchronous-noescape", "zero-capacity-size-query"]),
  astc: Object.freeze(["bounded-input-span", "fixed-three-u32-output", "synchronous-noescape"]),
  xtea: Object.freeze(["bounded-key-span", "in-place-byte-transform", "single-algorithm-enum", "synchronous-noescape"]),
  hashSpan: Object.freeze(["bounded-input-span", "fixed-width-scalar-result", "synchronous-noescape"]),
});

function result(semantics, missingFacts = []) {
  return Object.freeze({
    semantics: semantics ? Object.freeze(semantics) : null,
    missingFacts: Object.freeze([...missingFacts].sort()),
  });
}

function evidence(declaration, facts, semanticSource = "revision-ir-abi+identifier-grammar+stable-format-recipe") {
  return {
    header: declaration.header,
    declarationLine: declaration.line,
    semanticSource,
    ...facts,
  };
}

function enumName(role) {
  return role?.startsWith("enum:") ? role.slice("enum:".length) : null;
}

function enumExpression(type, member) {
  const separator = type.lastIndexOf("::");
  return separator < 0 ? member : `${type.slice(0, separator)}::${member}`;
}

function matchesAbi(candidate, resultRoles, parameters) {
  return (
    resultRoles.includes(candidate?.result?.role) &&
    candidate.parameters?.length === parameters.length &&
    parameters.every(
      ({ roles, directions }, index) =>
        roles.includes(candidate.parameters[index].role) && directions.includes(candidate.parameters[index].direction),
    )
  );
}

function expressionContains(value, predicate) {
  if (!value || typeof value !== "object") return false;
  if (predicate(value)) return true;
  return Object.values(value).some((child) =>
    Array.isArray(child)
      ? child.some((entry) => expressionContains(entry, predicate))
      : expressionContains(child, predicate),
  );
}

function expressionValues(value, predicate, select) {
  if (!value || typeof value !== "object") return [];
  const own = predicate(value) ? [select(value)] : [];
  return own.concat(
    ...Object.values(value).map((child) =>
      Array.isArray(child)
        ? child.flatMap((entry) => expressionValues(entry, predicate, select))
        : expressionValues(child, predicate, select),
    ),
  );
}

function dereferencedParameter(expression, index) {
  return (
    expression?.kind === "unary" &&
    expression.operator === "*" &&
    expression.operand?.kind === "parameter" &&
    expression.operand.index === index
  );
}

function sourceEvidence(definition, detail = {}) {
  return { source: definition.source, line: definition.line, ...detail };
}

function resolvedCallTarget(definition, call) {
  const reachable = definition.reachableDefinitions ?? [];
  const byId = reachable.find(({ identity }) => identity && identity === call.calleeIdentity);
  if (byId) return byId;
  const byLeaf = reachable.filter(({ name }) => name.split("::").at(-1) === call.callee);
  return byLeaf.length === 1 ? byLeaf[0] : null;
}

function exactParameterArguments(call, indices) {
  return (
    call.arguments?.length === indices.length &&
    call.arguments.every((argument, index) => argument.kind === "parameter" && argument.index === indices[index])
  );
}

function conditionContains(conditions, predicate) {
  return (conditions ?? []).some(({ expression }) => expressionContains(expression, predicate));
}

function zeroCapacityQuery(definition, index) {
  return (definition.operations ?? []).some(
    ({ operator, left, conditions }) =>
      operator === "=" &&
      dereferencedParameter(left, index) &&
      conditionContains(
        conditions,
        (expression) =>
          expression.kind === "binary" &&
          expression.operator === "==" &&
          dereferencedParameter(expression.left, index) &&
          expression.right?.kind === "integer" &&
          expression.right.value === 0,
      ),
  );
}

function falseReturnControlledByVariable(definition, name) {
  return (definition.returns ?? []).some(
    ({ kind, value, conditions }) =>
      kind === "boolean" &&
      value === false &&
      conditionContains(
        conditions,
        (expression) =>
          expression.kind === "binary" &&
          ["!=", "=="].includes(expression.operator) &&
          expression.left?.kind === "variable" &&
          expression.left.name === name &&
          expression.right?.kind === "integer" &&
          expression.right.value === 0,
      ),
  );
}

function variableInitializer(definition, name) {
  const matches = (definition.variables ?? []).filter((variable) => variable.name === name);
  return matches.length === 1 ? matches[0].initializer : null;
}

function base64PaddingAdapters(definitions) {
  return definitions.flatMap((definition) => {
    const adapters = (definition.calls ?? []).filter(
      ({ callee, arguments: args }) =>
        callee === "memset" && args?.[1]?.kind === "character" && args[1].value === 61 && args[2]?.kind === "variable",
    );
    return adapters.flatMap(({ arguments: args }) => {
      const initializer = variableInitializer(definition, args[2].name);
      const derivesPadding = expressionContains(
        initializer,
        ({ kind, operator, left, right }) =>
          kind === "binary" &&
          operator === "%" &&
          left?.kind === "parameter" &&
          left.index === 1 &&
          right?.kind === "integer" &&
          right.value === 4,
      );
      return derivesPadding ? [sourceEvidence(definition, { paddingVariable: args[2].name })] : [];
    });
  });
}

export function analyzeFixedDigestRecipe(declaration, candidate, recipe, sourceFacts) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  if (
    !matchesAbi(
      candidate,
      ["scalar:void"],
      [
        { roles: ["pointer:scalar:u8"], directions: ["in"] },
        { roles: ["scalar:u32"], directions: ["value"] },
        { roles: ["pointer:scalar:u8"], directions: ["out", "inout"] },
      ],
    )
  )
    return result(null, ["fixed-digest-abi-shape"]);
  const extent = inferForwardedFixedOutputExtent(sourceFacts?.definitions ?? [], 3);
  if (extent.state === "absent") return result(null, ["implementation-fixed-output-extent"]);
  if (extent.state === "contradictory") return result(null, ["implementation-fixed-output-extent-conflict"]);
  const algorithmConstants = [
    ...new Set(
      extent.observations.flatMap(({ leadingArguments }) =>
        leadingArguments.filter(({ kind }) => kind === "enum-constant").map(({ name }) => name),
      ),
    ),
  ].sort();
  const digestBytes = extent.bytes;
  return result({
    digestBytes,
    algorithm: algorithmConstants.length === 1 ? algorithmConstants[0] : "implementation-defined-digest",
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.fixedDigest].sort(),
    evidence: evidence(
      declaration,
      {
        digestBytes,
        implementationObservations: extent.observations.map(({ bytes, source, line, callee }) => ({
          bytes,
          source,
          line,
          callee,
        })),
      },
      "revision-implementation-ast+abi-shape",
    ),
  });
}

export function analyzeHashSpanRecipe(declaration, candidate, recipe) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  const resultBits = Number(candidate?.result?.role?.match(/^scalar:u(32|64)$/u)?.[1]);
  if (
    !recipe.resultWidths?.includes(resultBits) ||
    !matchesAbi(
      candidate,
      [`scalar:u${resultBits}`],
      [
        { roles: ["opaque-pointer"], directions: ["in"] },
        { roles: ["scalar:u32"], directions: ["value"] },
      ],
    )
  )
    return result(null, ["fixed-width-hash-abi-shape"]);
  return result({
    resultBits,
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.hashSpan].sort(),
    evidence: evidence(declaration, { resultBits }, "revision-ir-abi-shape"),
  });
}

export function analyzeBase64SpanRecipe(declaration, candidate, recipe, sourceFacts) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  if (
    !matchesAbi(
      candidate,
      ["scalar:bool"],
      [
        { roles: ["pointer:scalar:u8"], directions: ["in"] },
        { roles: ["scalar:u32"], directions: ["value"] },
        { roles: ["pointer:scalar:u8"], directions: ["out", "inout"] },
        { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
      ],
    )
  )
    return result(null, ["base64-span-abi-shape"]);
  const observations = [];
  for (const definition of sourceFacts?.definitions ?? []) {
    if (!zeroCapacityQuery(definition, 3)) continue;
    for (const variable of definition.variables ?? []) {
      const call = variable.initializer;
      if (call?.kind !== "call" || !falseReturnControlledByVariable(definition, variable.name)) continue;
      const callee = String(call.callee ?? "").toLowerCase();
      const mode =
        callee.includes("base64") && callee.includes("encode")
          ? "encode"
          : callee.includes("base64") && callee.includes("decode")
            ? "decode"
            : null;
      if (!mode) continue;
      const capacity = call.arguments?.[1];
      const output = call.arguments?.[0];
      const input = call.arguments?.at(-2);
      const inputLength = call.arguments?.at(-1);
      if (
        !dereferencedParameter(capacity, 3) ||
        output?.kind !== "parameter" ||
        output.index !== 2 ||
        input?.kind !== "parameter" ||
        input.index !== 0 ||
        inputLength?.kind !== "parameter" ||
        inputLength.index !== 1
      )
        continue;
      observations.push(
        sourceEvidence(definition, {
          callee: call.callee,
          calleeIdentity: call.calleeIdentity ?? null,
          calleeType: call.calleeType ?? null,
          resultVariable: variable.name,
          mode,
        }),
      );
    }
  }
  const modes = [...new Set(observations.map(({ mode }) => mode))].sort();
  if (modes.length !== 1)
    return result(null, [modes.length ? "implementation-codec-operation-conflict" : "implementation-codec-operation"]);
  const capacityQuery = (sourceFacts?.definitions ?? []).some((definition) => zeroCapacityQuery(definition, 3));
  if (!capacityQuery) return result(null, ["implementation-zero-capacity-query"]);
  const [mode] = modes;
  const paddingAdapters = mode === "decode" ? base64PaddingAdapters(sourceFacts?.definitions ?? []) : [];
  return result({
    mode,
    requirePaddedInput: mode === "decode" && paddingAdapters.length === 0,
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.base64].sort(),
    evidence: evidence(
      declaration,
      {
        operation: mode,
        capacityQuery: "dereferenced-capacity-equals-zero",
        unpaddedInput:
          mode === "decode"
            ? paddingAdapters.length > 0
              ? "accepted-by-padding-adapter"
              : "not-proven"
            : "not-applicable",
        implementationObservations: observations,
        paddingAdapterObservations: paddingAdapters,
      },
      "revision-implementation-ast+abi-shape",
    ),
  });
}

export function analyzeAstcProbeRecipe(declaration, candidate, recipe, sourceFacts) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  if (
    !matchesAbi(
      candidate,
      ["scalar:bool"],
      [
        { roles: ["opaque-pointer"], directions: ["in"] },
        { roles: ["scalar:u32"], directions: ["value"] },
        { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
        { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
        { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
      ],
    )
  )
    return result(null, ["astc-probe-abi-shape"]);
  const astcWrites = new Map();
  const informative = (sourceFacts?.definitions ?? []).filter((definition) => {
    const probeCalls = (definition.calls ?? []).filter((call) => exactParameterArguments(call, [0, 1]));
    const probes = probeCalls.map((call) => resolvedCallTarget(definition, call)).filter(Boolean);
    if (probes.length !== 1) return false;
    const headerVariables = new Set(
      (definition.variables ?? [])
        .filter(({ initializer }) =>
          expressionContains(initializer, ({ kind, index }) => kind === "parameter" && index === 0),
        )
        .map(({ name }) => name),
    );
    if (headerVariables.size === 0) return false;
    const writes = (definition.operations ?? [])
      .filter(({ operator, left }) => operator === "=" && [2, 3, 4].some((index) => dereferencedParameter(left, index)))
      .filter(({ right }) =>
        expressionContains(right, ({ kind, name }) => kind === "variable" && headerVariables.has(name)),
      );
    astcWrites.set(definition, writes);
    const written = new Set(writes.map(({ left }) => left.operand.index));
    return written.size === 3;
  });
  const operations = informative.map((definition) => {
    const writes = astcWrites.get(definition) ?? [];
    const packed = writes.every(({ right }) =>
      expressionContains(
        right,
        ({ kind, operator, right: shift }) =>
          kind === "binary" && operator === "<<" && shift?.kind === "integer" && [8, 16].includes(shift.value),
      ),
    );
    return { definition, mode: packed ? "dimensions" : "block-size" };
  });
  const modes = [...new Set(operations.map(({ mode }) => mode))];
  if (modes.length !== 1)
    return result(null, [
      modes.length ? "implementation-three-u32-operation-conflict" : "implementation-three-u32-operation",
    ]);
  const probeHelpers = informative.flatMap((definition) =>
    (definition.calls ?? [])
      .filter((call) => exactParameterArguments(call, [0, 1]))
      .map((call) => resolvedCallTarget(definition, call))
      .filter(Boolean),
  );
  const minimums = [
    ...new Set(
      probeHelpers.flatMap((definition) =>
        (definition.returns ?? []).flatMap(({ kind, value, conditions }) =>
          kind === "boolean" && value === false
            ? (conditions ?? []).flatMap(({ expression }) =>
                expressionValues(
                  expression,
                  ({ kind: expressionKind, operator, left, right }) =>
                    expressionKind === "binary" &&
                    operator === "<" &&
                    left?.kind === "parameter" &&
                    left.index === 1 &&
                    right?.kind === "integer",
                  ({ right }) => right.value,
                ),
              )
            : [],
        ),
      ),
    ),
  ]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
  if (minimums.length !== 1)
    return result(null, [minimums.length ? "implementation-input-minimum-conflict" : "implementation-input-minimum"]);
  const [operation] = modes;
  const [minimumHeaderBytes] = minimums;
  return result({
    mode: operation,
    minimumHeaderBytes,
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.astc].sort(),
    evidence: evidence(
      declaration,
      {
        operation,
        minimumHeaderBytes,
        implementationObservations: operations.map(({ definition }) => sourceEvidence(definition)),
      },
      "revision-implementation-ast+abi-shape",
    ),
  });
}

export function analyzeXteaSpanRecipe(declaration, candidate, enumDeclarations, recipe, sourceFacts) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  const algorithmType = enumName(candidate.parameters?.[0]?.role);
  const resultType = enumName(candidate.result?.role);
  const algorithm = enumDeclarations.get(algorithmType);
  const resultEnum = enumDeclarations.get(resultType);
  if (!algorithmType || !algorithm) return result(null, ["algorithm-enum"]);
  if (recipe.requireSingleAlgorithm && algorithm.members?.length !== 1) return result(null, ["single-algorithm-enum"]);
  const algorithmMember = algorithm.members?.[0];
  if (!resultType || !resultEnum) return result(null, ["result-enum"]);
  const returnedConstants = [
    ...new Set(
      (sourceFacts?.definitions ?? []).flatMap((definition) =>
        (definition.returns ?? []).flatMap((returned) => (returned.kind === "enum-constant" ? [returned.name] : [])),
      ),
    ),
  ];
  if (returnedConstants.length !== 1)
    return result(null, [
      returnedConstants.length ? "implementation-success-enum-conflict" : "implementation-success-enum",
    ]);
  const success = resultEnum.members?.filter(({ name }) => name === returnedConstants[0]) ?? [];
  if (success.length !== 1) return result(null, ["implementation-success-enum-domain"]);
  const helpers = (sourceFacts?.definitions ?? []).flatMap((definition) =>
    (definition.calls ?? [])
      .filter((call) => exactParameterArguments(call, [1, 2, 3, 4]))
      .map((call) => resolvedCallTarget(definition, call))
      .filter(Boolean),
  );
  const capacityCandidates = [
    ...new Set(
      helpers.flatMap((definition) =>
        (definition.fixedArrays ?? []).flatMap(({ name, byteExtent }) => {
          if (!Number.isSafeInteger(byteExtent)) return [];
          const copiesKey = (definition.calls ?? []).some(
            ({ callee, arguments: args }) =>
              callee === "memcpy" &&
              args?.[0]?.kind === "variable" &&
              args[0].name === name &&
              args[1]?.kind === "parameter" &&
              args[1].index === 2 &&
              args[2]?.kind === "parameter" &&
              args[2].index === 3,
          );
          const guardsCapacity = (definition.operations ?? []).some(
            ({ operator, left, right }) =>
              operator === "<=" &&
              left?.kind === "parameter" &&
              left.index === 3 &&
              right?.kind === "integer" &&
              right.value === byteExtent,
          );
          const mutatesData = (definition.operations ?? []).some(({ left }) =>
            expressionContains(left, ({ kind, index }) => kind === "parameter" && index === 0),
          );
          return copiesKey && guardsCapacity && mutatesData ? [byteExtent] : [];
        }),
      ),
    ),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (capacityCandidates.length !== 1)
    return result(null, [
      capacityCandidates.length ? "implementation-key-capacity-conflict" : "implementation-key-capacity",
    ]);
  const [maximumKeyBytes] = capacityCandidates;

  return result({
    mode: "symmetric-in-place-transform",
    maximumKeyBytes,
    algorithmExpression: enumExpression(algorithmType, algorithmMember.name),
    successExpression: enumExpression(resultType, success[0].name),
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.xtea].sort(),
    evidence: evidence(
      declaration,
      {
        operation: "symmetric-in-place-transform",
        maximumKeyBytes,
        algorithmType,
        algorithmMember,
        resultType,
        successMember: success[0],
        implementationObservations: (sourceFacts?.definitions ?? []).map((definition) => sourceEvidence(definition)),
      },
      "revision-implementation-ast+abi-shape",
    ),
  });
}

export function createDmSdkFallbackAudit({ candidate, family, patternId, emitter, missingFacts }) {
  const missing = [...new Set(missingFacts)].sort();
  return Object.freeze({
    state: "universal-fallback",
    declarationId: candidate.id,
    observedShape: candidate.shape,
    attemptedFamily: family,
    attemptedPattern: patternId,
    retainedImplementation: "@deherm/compiler/dmsdk-universal-materializer",
    missingWiring: Object.freeze(missing),
    recommendation: Object.freeze({
      action: "extend-stable-semantic-recipe-or-identifier-grammar",
      emitter,
      requiredFacts: Object.freeze(missing),
      preserveFallbackUntilSpecialized: true,
    }),
  });
}

export function publicDmSdkHeader(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`dmSDK header is outside the public projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}
