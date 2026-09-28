import { BOUNDED_SPAN_SEMANTIC_TOKENS } from "./dmsdk-bounded-span-recipes.mjs";
import { defineDmSdkPattern, DMSDK_UNIVERSAL_FALLBACK_PATTERN } from "./dmsdk-pattern-selector.mjs";

const HASH_STATE_SEMANTIC_TOKENS = Object.freeze([
  "generation-checked-state",
  "incremental-hash-lifecycle",
  "synchronous-noescape",
]);

function pattern({ id, family, emitter, priority, cost, when }) {
  return defineDmSdkPattern({
    schemaVersion: 1,
    id,
    family,
    emitter,
    priority,
    cost,
    fallback: false,
    when,
  });
}

export function directPrimitiveScalarPattern() {
  return pattern({
    id: "value.direct-primitive-scalar",
    family: "scalar-thunk",
    emitter: "scripts/generate-dmsdk-scalar-thunks.mjs",
    priority: 820,
    cost: 4,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["scalar:"] },
      parameters: { every: [{ rolePrefixes: ["scalar:"], directions: ["value"] }] },
      requireSemanticTokens: ["direct-native-primitive", "fixed-width-cell-codec", "synchronous-noescape"],
    },
  });
}

export function enumValuePattern() {
  return pattern({
    id: "value.enum-domain-direct",
    family: "enum-value",
    emitter: "scripts/generate-dmsdk-enum-value-bindings.mjs",
    priority: 810,
    cost: 6,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["scalar:", "enum:"] },
      parameters: { every: [{ rolePrefixes: ["scalar:", "enum:"], directions: ["value"] }] },
      requireSemanticTokens: ["declared-enum-domain", "fixed-width-cell-codec", "synchronous-noescape"],
    },
  });
}

export function namedScalarPattern() {
  return pattern({
    id: "value.named-scalar-direct",
    family: "named-scalar",
    emitter: "scripts/generate-dmsdk-named-scalar-bindings.mjs",
    priority: 820,
    cost: 5,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["scalar:"] },
      parameters: { every: [{ rolePrefixes: ["scalar:"], directions: ["value"] }] },
      requireSemanticTokens: ["fixed-width-cell-codec", "source-resolved-named-scalar", "synchronous-noescape"],
    },
  });
}

export function fixedDigestPattern() {
  return pattern({
    id: "span.fixed-output-digest",
    family: "fixed-digest",
    emitter: "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
    priority: 900,
    cost: 5,
    when: {
      declarationKinds: ["function"],
      result: { roles: ["scalar:void"] },
      parameters: {
        count: { exact: 3 },
        positions: [
          { roles: ["pointer:scalar:u8"], directions: ["in"] },
          { roles: ["scalar:u32"], directions: ["value"] },
          { roles: ["pointer:scalar:u8"], directions: ["out", "inout"] },
        ],
      },
      requireSemanticTokens: BOUNDED_SPAN_SEMANTIC_TOKENS.fixedDigest,
    },
  });
}

export function base64SpanPattern() {
  return pattern({
    id: "span.bounded-byte-transform",
    family: "base64-span",
    emitter: "scripts/generate-dmsdk-base64-span-bindings.mjs",
    priority: 890,
    cost: 7,
    when: {
      declarationKinds: ["function"],
      result: { roles: ["scalar:bool"] },
      parameters: {
        count: { exact: 4 },
        positions: [
          { roles: ["pointer:scalar:u8"], directions: ["in"] },
          { roles: ["scalar:u32"], directions: ["value"] },
          { roles: ["pointer:scalar:u8"], directions: ["out", "inout"] },
          { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
        ],
      },
      requireSemanticTokens: BOUNDED_SPAN_SEMANTIC_TOKENS.base64,
    },
  });
}

export function astcProbePattern() {
  return pattern({
    id: "span.fixed-three-u32-probe",
    family: "astc-probe",
    emitter: "scripts/generate-dmsdk-astc-probe-bindings.mjs",
    priority: 880,
    cost: 8,
    when: {
      declarationKinds: ["function"],
      result: { roles: ["scalar:bool"] },
      parameters: {
        count: { exact: 5 },
        positions: [
          { roles: ["opaque-pointer"], directions: ["in"] },
          { roles: ["scalar:u32"], directions: ["value"] },
          { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
          { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
          { roles: ["pointer:scalar:u32"], directions: ["out", "inout"] },
        ],
      },
      requireSemanticTokens: BOUNDED_SPAN_SEMANTIC_TOKENS.astc,
    },
  });
}

export function xteaSpanPattern() {
  return pattern({
    id: "span.in-place-keyed-transform",
    family: "xtea-span",
    emitter: "scripts/generate-dmsdk-xtea-span-bindings.mjs",
    priority: 870,
    cost: 9,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["enum:"] },
      parameters: {
        count: { exact: 5 },
        positions: [
          { rolePrefixes: ["enum:"], directions: ["value"] },
          { roles: ["pointer:scalar:u8"], directions: ["out", "inout"] },
          { roles: ["scalar:u32"], directions: ["value"] },
          { roles: ["pointer:scalar:u8"], directions: ["in"] },
          { roles: ["scalar:u32"], directions: ["value"] },
        ],
      },
      requireSemanticTokens: BOUNDED_SPAN_SEMANTIC_TOKENS.xtea,
    },
  });
}

export function fixedWidthHashPattern() {
  return pattern({
    id: "span.fixed-width-hash",
    family: "hash-span",
    emitter: "scripts/generate-dmsdk-hash-span-bindings.mjs",
    priority: 860,
    cost: 4,
    when: {
      declarationKinds: ["function"],
      result: { roles: ["scalar:u32", "scalar:u64"] },
      parameters: {
        count: { exact: 2 },
        positions: [
          { roles: ["opaque-pointer"], directions: ["in"] },
          { roles: ["scalar:u32"], directions: ["value"] },
        ],
      },
      requireSemanticTokens: BOUNDED_SPAN_SEMANTIC_TOKENS.hashSpan,
    },
  });
}

export function incrementalHashStatePattern() {
  return pattern({
    id: "state.incremental-hash-lifecycle",
    family: "hash-state",
    emitter: "scripts/generate-dmsdk-hash-state-bindings.mjs",
    priority: 850,
    cost: 12,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["scalar:"] },
      parameters: { some: [{ rolePrefixes: ["pointer:record:"], directions: ["in", "inout"] }] },
      requireSemanticTokens: HASH_STATE_SEMANTIC_TOKENS,
    },
  });
}

function arenaPattern(id, kind, result, positions, semanticTokens) {
  return pattern({
    id,
    family: `arena-cstring.${kind}`,
    emitter: "scripts/generate-dmsdk-arena-span-blockers.mjs",
    priority: 790,
    cost: 8,
    when: {
      declarationKinds: ["function"],
      result,
      parameters: { count: { exact: positions.length }, positions },
      requireSemanticTokens: semanticTokens,
    },
  });
}

export function arenaCStringPatterns() {
  return Object.freeze([
    arenaPattern("arena-cstring.error-string", "error-string", { roles: ["scalar:void"] }, [
      { roles: ["cstring-mutable"], directions: ["out"] },
      { roles: ["scalar:usize"], directions: ["value"] },
      { roles: ["scalar:i32"], directions: ["value"] },
    ], ["bounded-cstring-output", "error-string", "null-terminated-output", "synchronous-noescape"]),
    arenaPattern("arena-cstring.trimmed-string", "trimmed-string", { roles: ["scalar:usize"] }, [
      { roles: ["cstring-mutable"], directions: ["out"] },
      { roles: ["scalar:usize"], directions: ["value"] },
      { roles: ["cstring-in"], directions: ["in"] },
    ], ["bounded-cstring-output", "counted-cstring-input", "null-terminated-output", "trimmed-string"]),
    arenaPattern("arena-cstring.canonical-path", "canonical-path", { roles: ["scalar:u32"] }, [
      { roles: ["cstring-in"], directions: ["in"] },
      { roles: ["cstring-mutable"], directions: ["inout"] },
      { roles: ["scalar:u32"], directions: ["value"] },
    ], ["bounded-cstring-output", "canonical-path", "counted-cstring-input", "output-length-result"]),
    arenaPattern("arena-cstring.uri-encode", "uri-encode", { rolePrefixes: ["enum:"] }, [
      { roles: ["cstring-in"], directions: ["in"] },
      { roles: ["cstring-mutable"], directions: ["out"] },
      { roles: ["scalar:u32"], directions: ["value"] },
      { roles: ["pointer:scalar:u32"], directions: ["inout"] },
    ], ["bounded-cstring-output", "counted-cstring-input", "output-byte-count", "uri-encode"]),
  ]);
}

export function cstringValuePatterns() {
  return Object.freeze([
    pattern({
      id: "cstring-value.enum-literal-result",
      family: "cstring-value.enum-literal-result",
      emitter: "scripts/generate-dmsdk-cstring-value-bindings.mjs",
      priority: 780,
      cost: 8,
      when: {
        declarationKinds: ["function"],
        result: { roles: ["cstring-result"] },
        parameters: { count: { exact: 1 }, positions: [{ rolePrefixes: ["enum:"], directions: ["value"] }] },
        requireSemanticTokens: ["enum-string-representation", "non-null-cstring-result"],
      },
    }),
    pattern({
      id: "cstring-value.nullable-input-slice",
      family: "cstring-value.nullable-input-slice",
      emitter: "scripts/generate-dmsdk-cstring-value-bindings.mjs",
      priority: 780,
      cost: 8,
      when: {
        declarationKinds: ["function"],
        result: { roles: ["cstring-result"] },
        parameters: { count: { exact: 1 }, positions: [{ roles: ["cstring-in"], directions: ["in"] }] },
        requireSemanticTokens: ["nullable-cstring-result", "safe-utf8-cstring-input"],
      },
    }),
    pattern({
      id: "cstring-value.input-transform",
      family: "cstring-value.input-transform",
      emitter: "scripts/generate-dmsdk-cstring-value-bindings.mjs",
      priority: 770,
      cost: 6,
      when: {
        declarationKinds: ["function"],
        result: {
          roles: ["scalar:void", "scalar:bool", "scalar:i32", "scalar:u32", "scalar:u64"],
          rolePrefixes: ["enum:"],
        },
        parameters: {
          every: [
            { roles: ["cstring-in"], directions: ["in"] },
            { roles: ["scalar:u32", "scalar:u64"], rolePrefixes: ["enum:"], directions: ["value"] },
          ],
          some: [{ roles: ["cstring-in"], directions: ["in"] }],
        },
        requireSemanticTokens: ["safe-utf8-cstring-input"],
      },
    }),
  ]);
}

export function borrowedHandlePattern(selection) {
  return pattern({
    id: "handle.borrowed-provider-boundary",
    family: "borrowed-handle",
    emitter: "scripts/generate-dmsdk-borrowed-handle-bindings.mjs",
    priority: 700,
    cost: 20,
    when: {
      declarationKinds: selection.declarationKinds,
      result: { roles: selection.resultRoles },
      parameters: {
        every: [{ rolePrefixes: [selection.handleRolePrefix] }, { roles: selection.parameterRoles }],
        some: [{ rolePrefixes: [selection.handleRolePrefix] }],
      },
      rejectFamilies: selection.rejectedFamilies,
    },
  });
}

export function handleLifecyclePattern(selection) {
  return pattern({
    id: "handle.lifecycle-provider-boundary",
    family: "handle-lifecycle",
    emitter: "scripts/generate-dmsdk-borrowed-handle-bindings.mjs",
    priority: 710,
    cost: 22,
    when: {
      declarationKinds: selection.declarationKinds,
      result: { roles: selection.resultRoles },
      parameters: {
        every: [{ rolePrefixes: [selection.handleRolePrefix] }, { roles: selection.parameterRoles }],
        some: [{ rolePrefixes: [selection.handleRolePrefix] }],
      },
      requireSemanticTokens: [
        "handle-lifecycle-transition",
        "provider-validated-handle",
        "synchronous-noescape",
      ],
      rejectFamilies: selection.rejectedFamilies,
    },
  });
}

export function scratchScalarOutPattern(selection) {
  return pattern({
    id: "pointer.scratch-scalar-out-provider-boundary",
    family: "scratch-scalar-out",
    emitter: "scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs",
    priority: 800,
    cost: 25,
    when: {
      result: { rolePrefixes: selection.resultRolePrefixes },
      parameters: {
        every: [
          { rolePrefixes: selection.valueRolePrefixes, directions: ["value"] },
          { rolePrefixes: selection.pointerRolePrefixes, directions: selection.pointerDirections },
        ],
        some: [{ rolePrefixes: selection.pointerRolePrefixes, directions: ["out", "inout"] }],
      },
      rejectFamilies: selection.rejectedFamilies,
    },
  });
}

export function createDmSdkPatternCatalog({ borrowedHandleSelection, scratchScalarOutSelection }) {
  const patterns = [
    fixedDigestPattern(),
    base64SpanPattern(),
    astcProbePattern(),
    xteaSpanPattern(),
    fixedWidthHashPattern(),
    incrementalHashStatePattern(),
    directPrimitiveScalarPattern(),
    namedScalarPattern(),
    enumValuePattern(),
    ...arenaCStringPatterns(),
    ...cstringValuePatterns(),
    handleLifecyclePattern(borrowedHandleSelection),
    borrowedHandlePattern(borrowedHandleSelection),
    scratchScalarOutPattern(scratchScalarOutSelection),
    DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  ];
  const ids = patterns.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("dmSDK pattern catalog contains duplicate pattern ids");
  return Object.freeze(patterns);
}
