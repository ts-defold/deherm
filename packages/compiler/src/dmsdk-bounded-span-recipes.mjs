const DIGEST_BYTES = Object.freeze({ md5: 16, sha1: 20, sha256: 32, sha512: 64 });

export const BOUNDED_SPAN_SEMANTIC_TOKENS = Object.freeze({
  fixedDigest: Object.freeze(["fixed-output-byte-count", "synchronous-noescape"]),
  base64: Object.freeze(["bounded-output-capacity", "synchronous-noescape", "zero-capacity-size-query"]),
  astc: Object.freeze(["bounded-input-span", "fixed-three-u32-output", "synchronous-noescape"]),
  xtea: Object.freeze(["bounded-key-span", "in-place-byte-transform", "single-algorithm-enum", "synchronous-noescape"]),
});

function result(semantics, missingFacts = []) {
  return Object.freeze({
    semantics: semantics ? Object.freeze(semantics) : null,
    missingFacts: Object.freeze([...missingFacts].sort()),
  });
}

function compactIdentifier(value) {
  return String(value ?? "")
    .split("::")
    .at(-1)
    .replace(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
}

function evidence(declaration, facts) {
  return {
    header: declaration.header,
    declarationLine: declaration.line,
    semanticSource: "revision-ir-abi+identifier-grammar+stable-format-recipe",
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

export function analyzeFixedDigestRecipe(declaration, candidate, recipe) {
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
  const identifier = compactIdentifier(declaration.name);
  const match = identifier.match(/hash(md5|sha1|sha256|sha512)$/u);
  if (!match) return result(null, ["standard-digest-identifier"]);
  const algorithm = match[1];
  if (!recipe.algorithms.includes(algorithm)) return result(null, [`digest-recipe:${algorithm}`]);
  const digestBytes = DIGEST_BYTES[algorithm];
  if (!digestBytes) return result(null, [`digest-width:${algorithm}`]);
  return result({
    digestBytes,
    algorithm,
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.fixedDigest].sort(),
    evidence: evidence(declaration, { algorithm, digestBytes }),
  });
}

export function analyzeBase64SpanRecipe(declaration, candidate, recipe) {
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
  const identifier = compactIdentifier(declaration.name);
  if (!identifier.includes(recipe.codec)) return result(null, [`codec-identifier:${recipe.codec}`]);
  const mode = recipe.operations.find((operation) => identifier.endsWith(operation));
  if (!mode) return result(null, ["codec-operation:encode-or-decode"]);
  return result({
    mode,
    requirePaddedInput: mode === "decode" && recipe.decodeInput === "canonical-padded",
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.base64].sort(),
    evidence: evidence(declaration, { codec: recipe.codec, operation: mode }),
  });
}

export function analyzeAstcProbeRecipe(declaration, candidate, recipe) {
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
  const identifier = compactIdentifier(declaration.name);
  if (!identifier.includes(recipe.format)) return result(null, [`format-identifier:${recipe.format}`]);
  const operation = identifier.endsWith("blocksize")
    ? "block-size"
    : identifier.endsWith("dimensions")
      ? "dimensions"
      : null;
  if (!operation || !recipe.operations.includes(operation)) return result(null, ["astc-probe-operation"]);
  return result({
    mode: operation,
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.astc].sort(),
    evidence: evidence(declaration, {
      format: recipe.format,
      operation,
      minimumHeaderBytes: recipe.minimumHeaderBytes,
    }),
  });
}

export function analyzeXteaSpanRecipe(declaration, candidate, enumDeclarations, recipe) {
  if (!declaration || declaration.kind !== "function") return result(null, ["function-declaration"]);
  const identifier = compactIdentifier(declaration.name);
  const mode = recipe.operations.find((operation) => identifier.endsWith(operation));
  if (!mode) return result(null, ["transform-operation:encrypt-or-decrypt"]);

  const algorithmType = enumName(candidate.parameters?.[0]?.role);
  const resultType = enumName(candidate.result?.role);
  const algorithm = enumDeclarations.get(algorithmType);
  const resultEnum = enumDeclarations.get(resultType);
  if (!algorithmType || !algorithm) return result(null, ["algorithm-enum"]);
  if (recipe.requireSingleAlgorithm && algorithm.members?.length !== 1) return result(null, ["single-algorithm-enum"]);
  const algorithmMember = algorithm.members?.[0];
  if (!compactIdentifier(algorithmMember?.name).includes(recipe.algorithm))
    return result(null, [`algorithm-member:${recipe.algorithm}`]);
  if (!resultType || !resultEnum) return result(null, ["result-enum"]);
  const success = resultEnum.members?.filter(({ value }) => value === recipe.successEnumValue) ?? [];
  if (success.length !== 1) return result(null, [`unique-success-enum:${recipe.successEnumValue}`]);

  return result({
    mode,
    algorithmExpression: enumExpression(algorithmType, algorithmMember.name),
    successExpression: enumExpression(resultType, success[0].name),
    semanticTokens: [...BOUNDED_SPAN_SEMANTIC_TOKENS.xtea].sort(),
    evidence: evidence(declaration, {
      operation: mode,
      algorithmType,
      algorithmMember,
      resultType,
      successMember: success[0],
    }),
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
