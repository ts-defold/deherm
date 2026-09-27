import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCppImplementationFacts,
  inferForwardedFixedOutputExtent,
} from "../packages/compiler/src/cpp-semantic-facts.mjs";

function reference(kind, id, name) {
  return { kind: "DeclRefExpr", referencedDecl: { kind, id, name } };
}

function digestAst(bytes) {
  return {
    kind: "TranslationUnitDecl",
    inner: [{
      kind: "NamespaceDecl",
      name: "dmCrypt",
      inner: [{
        kind: "FunctionDecl",
        name: "RenamedDigest",
        type: { qualType: "void (const uint8_t *, uint32_t, uint8_t *)" },
        loc: { line: 12 },
        inner: [
          { kind: "ParmVarDecl", id: "p0", name: "input" },
          { kind: "ParmVarDecl", id: "p1", name: "length" },
          { kind: "ParmVarDecl", id: "p2", name: "output" },
          {
            kind: "CompoundStmt",
            inner: [{
              kind: "CallExpr",
              inner: [
                reference("FunctionDecl", "helper", "DigestHelper"),
                reference("EnumConstantDecl", "algorithm", "DIGEST_V2"),
                reference("ParmVarDecl", "p0", "input"),
                reference("ParmVarDecl", "p1", "length"),
                reference("ParmVarDecl", "p2", "output"),
                { kind: "IntegerLiteral", value: String(bytes) },
              ],
            }],
          },
        ],
      }],
    }],
  };
}

test("C++ source facts preserve parameter forwarding and constants independently of callable names", () => {
  const definitions = extractCppImplementationFacts(
    digestAst(32),
    new Set(["dmCrypt::RenamedDigest"]),
    "engine/example.cpp",
  );
  assert.equal(definitions.length, 1);
  assert.deepEqual(definitions[0].calls[0], {
    callee: "DigestHelper",
    arguments: [
      { kind: "enum-constant", name: "DIGEST_V2" },
      { kind: "parameter", index: 0, name: "input" },
      { kind: "parameter", index: 1, name: "length" },
      { kind: "parameter", index: 2, name: "output" },
      { kind: "integer", value: 32 },
    ],
  });
  const extent = inferForwardedFixedOutputExtent(definitions, 3);
  assert.equal(extent.state, "resolved");
  assert.equal(extent.bytes, 32);
});

test("fixed-output inference reports absent and contradictory source evidence instead of guessing", () => {
  assert.deepEqual(inferForwardedFixedOutputExtent([], 3), {
    state: "absent",
    values: [],
    observations: [],
  });
  const left = extractCppImplementationFacts(digestAst(32), ["dmCrypt::RenamedDigest"], "a.cpp");
  const right = extractCppImplementationFacts(digestAst(64), ["dmCrypt::RenamedDigest"], "b.cpp");
  const result = inferForwardedFixedOutputExtent([...left, ...right], 3);
  assert.equal(result.state, "contradictory");
  assert.deepEqual(result.values, [32, 64]);
});
