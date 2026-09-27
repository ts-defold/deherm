import assert from "node:assert/strict";
import test from "node:test";

import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  compactDmSdkPatternDecision,
  defineDmSdkPattern,
  selectDmSdkPattern,
} from "../packages/compiler/src/dmsdk-pattern-selector.mjs";

const scalar = defineDmSdkPattern({
  schemaVersion: 1,
  id: "scalar.direct",
  family: "scalar",
  emitter: "scalar-emitter",
  priority: 100,
  cost: 1,
  fallback: false,
  when: {
    declarationKinds: ["function"],
    result: { rolePrefixes: ["scalar:"] },
    parameters: { every: [{ rolePrefixes: ["scalar:"], directions: ["value"] }] },
    rejectFamilies: ["platform-gated"],
  },
});

const borrowed = defineDmSdkPattern({
  schemaVersion: 1,
  id: "handle.borrowed-scalar",
  family: "borrowed-handle",
  emitter: "borrowed-handle-emitter",
  priority: 200,
  cost: 2,
  fallback: false,
  when: {
    declarationKinds: ["function"],
    result: { roles: ["scalar:void"], rolePrefixes: ["scalar:"] },
    parameters: {
      every: [
        { rolePrefixes: ["handle:"], directions: ["value"] },
        { rolePrefixes: ["scalar:"], directions: ["value"] },
      ],
      some: [{ rolePrefixes: ["handle:"], directions: ["value"] }],
    },
    requireSemanticTokens: ["borrowed-handle-lifetime"],
  },
});

function facts(overrides = {}) {
  return {
    id: "dmsdk:Example",
    kind: "function",
    result: { role: "scalar:u32" },
    parameters: [{ role: "scalar:u32", direction: "value" }],
    families: [],
    semanticTokens: [],
    ...overrides,
  };
}

test("ranked structural selection is deterministic and records rejected patterns", () => {
  const selected = selectDmSdkPattern(facts(), [borrowed, DMSDK_UNIVERSAL_FALLBACK_PATTERN, scalar]);
  assert.equal(selected.patternId, "scalar.direct");
  assert.equal(selected.fallback, false);
  assert.deepEqual(
    selected.trace.map(({ patternId, applicable }) => ({ patternId, applicable })),
    [
      { patternId: "handle.borrowed-scalar", applicable: false },
      { patternId: "scalar.direct", applicable: true },
    ],
  );
  assert.ok(selected.trace[0].blockers.includes("required-parameter-shape-absent"));
  assert.equal(compactDmSdkPatternDecision(selected), "scalar.direct");
});

test("semantic facts are required instead of being inferred from a matching ABI shape", () => {
  const shape = facts({
    result: { role: "scalar:void" },
    parameters: [{ role: "handle:dmExample:opaque", direction: "value" }],
  });
  const blocked = selectDmSdkPattern(shape, [borrowed, DMSDK_UNIVERSAL_FALLBACK_PATTERN]);
  assert.equal(blocked.patternId, "universal.default");
  assert.equal(blocked.fallback, true);
  assert.deepEqual(blocked.trace[0].blockers, ["semantic-token-missing:borrowed-handle-lifetime"]);

  const selected = selectDmSdkPattern({ ...shape, semanticTokens: ["borrowed-handle-lifetime"] }, [
    borrowed,
    DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  ]);
  assert.equal(selected.patternId, "handle.borrowed-scalar");
});

test("a lower-ranked pattern cannot change an existing selection", () => {
  const slowScalar = defineDmSdkPattern({
    schemaVersion: 1,
    id: "scalar.slow",
    family: "scalar-slow",
    emitter: "scalar-slow-emitter",
    priority: 50,
    cost: 20,
    fallback: false,
    when: scalar.when,
  });
  assert.equal(
    selectDmSdkPattern(facts(), [slowScalar, scalar, DMSDK_UNIVERSAL_FALLBACK_PATTERN]).patternId,
    "scalar.direct",
  );
});

test("equal-ranked applicable patterns fail closed instead of using registry order", () => {
  const duplicate = defineDmSdkPattern({ ...scalar, id: "scalar.also-direct" });
  assert.throws(
    () => selectDmSdkPattern(facts(), [duplicate, DMSDK_UNIVERSAL_FALLBACK_PATTERN, scalar]),
    /ambiguous dmSDK patterns.*scalar\.also-direct, scalar\.direct/,
  );
});

test("pattern schemas reject route and source-name selectors", () => {
  assert.throws(() => defineDmSdkPattern({ ...scalar, symbol: "dmCrypt::HashSha256" }), /unsupported key 'symbol'/);
  assert.throws(() => defineDmSdkPattern({ ...scalar, header: "dmsdk/dlib/crypt.h" }), /unsupported key 'header'/);
  assert.throws(
    () => defineDmSdkPattern({ ...scalar, when: { ...scalar.when, routeIds: ["dmsdk:Example"] } }),
    /unsupported key 'routeIds'/,
  );
});

test("positional rules compose spans and out parameters without symbol knowledge", () => {
  const digest = defineDmSdkPattern({
    schemaVersion: 1,
    id: "span.fixed-output",
    family: "fixed-output-span",
    emitter: "fixed-output-emitter",
    priority: 300,
    cost: 3,
    fallback: false,
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
      requireSemanticTokens: ["fixed-output-byte-count", "synchronous-noescape"],
    },
  });
  const selected = selectDmSdkPattern(
    facts({
      result: { role: "scalar:void" },
      parameters: [
        { role: "pointer:scalar:u8", direction: "in" },
        { role: "scalar:u32", direction: "value" },
        { role: "pointer:scalar:u8", direction: "inout" },
      ],
      semanticTokens: ["synchronous-noescape", "fixed-output-byte-count"],
    }),
    [digest, DMSDK_UNIVERSAL_FALLBACK_PATTERN],
  );
  assert.equal(selected.patternId, "span.fixed-output");
});
