import assert from "node:assert/strict";
import test from "node:test";

import {
  CPP_OWNERSHIP_EFFECT_FACTS_KIND,
  extractCppOwnershipEffectFacts,
  validateCppOwnershipEffectArtifact,
  validateCppOwnershipEffectFact,
} from "../packages/compiler/src/cpp-ownership-effect-facts.mjs";

const parameter = (id, name, type) => ({ kind: "ParmVarDecl", id, name, type: { qualType: type } });
const parameterRef = (id, name, type = "void *") => ({
  kind: "DeclRefExpr",
  type: { qualType: type },
  referencedDecl: { kind: "ParmVarDecl", id, name, type: { qualType: type } },
});
const functionRef = (id, name) => ({
  kind: "DeclRefExpr",
  referencedDecl: { kind: "FunctionDecl", id, name },
});
const body = (...inner) => ({ kind: "CompoundStmt", inner });
const call = (id, name, ...arguments_) => ({ kind: "CallExpr", inner: [functionRef(id, name), ...arguments_] });
const fn = (id, name, type, parameters, statements) => ({
  kind: "FunctionDecl",
  id,
  name,
  type: { qualType: type },
  inner: [...parameters, body(...statements)],
});
const ast = (...definitions) => ({ kind: "TranslationUnitDecl", inner: definitions });

function fact(tree, id, options) {
  const artifact = extractCppOwnershipEffectFacts(tree, [id], options);
  assert.equal(artifact.kind, CPP_OWNERSHIP_EFFECT_FACTS_KIND);
  return artifact.functions[0];
}

function withoutIdentity(value) {
  const clone = structuredClone(value);
  delete clone.declarationId;
  return clone;
}

test("safe observer facts are body-derived and invariant under public/helper alpha-renaming", () => {
  const makeTree = (publicName, helperName) => {
    const p = parameter("observer-p", "opaque", "const int *");
    const helperParameter = parameter("helper-p", "renamed", "const int *");
    const helper = fn(
      "observer-helper",
      helperName,
      "int (const int *)",
      [helperParameter],
      [
        {
          kind: "ReturnStmt",
          inner: [{ kind: "UnaryOperator", opcode: "*", inner: [parameterRef("helper-p", "renamed", "const int *")] }],
        },
      ],
    );
    const publicFunction = fn(
      "observer",
      publicName,
      "int (const int *)",
      [p],
      [
        {
          kind: "ReturnStmt",
          inner: [call("observer-helper", helperName, parameterRef("observer-p", "opaque", "const int *"))],
        },
      ],
    );
    return ast(helper, publicFunction);
  };
  const first = fact(makeTree("LooksDestructive", "DeleteEverything"), "observer");
  const renamed = fact(makeTree("Observe", "ReadOne"), "observer");
  assert.deepEqual(withoutIdentity(first), withoutIdentity(renamed));
  assert.equal(first.ownershipEffect, "none");
  assert.equal(first.escape, "noescape");
  assert.equal(first.completion, "synchronous");
  assert.equal(first.resultProvenance, "plain-value");
  assert.equal(first.parameters[0].memoryEffect, "exact-one-read");
});

test("delete expressions and free wrappers propagate finalization without public-name rules", () => {
  const directParameter = parameter("direct-p", "value", "Widget *");
  const direct = fn(
    "direct-delete",
    "Inspect",
    "void (Widget *)",
    [directParameter],
    [{ kind: "CXXDeleteExpr", inner: [parameterRef("direct-p", "value", "Widget *")] }],
  );
  const wrapperParameter = parameter("wrapper-p", "value", "Widget *");
  const wrapper = fn(
    "wrapper",
    "ArbitraryWrapper",
    "void (Widget *)",
    [wrapperParameter],
    [call("c-free", "free", parameterRef("wrapper-p", "value", "Widget *"))],
  );
  const publicParameter = parameter("public-p", "value", "Widget *");
  const throughWrapper = fn(
    "through-wrapper",
    "HarmlessLooking",
    "void (Widget *)",
    [publicParameter],
    [call("wrapper", "ArbitraryWrapper", parameterRef("public-p", "value", "Widget *"))],
  );
  const tree = ast(direct, wrapper, throughWrapper);
  assert.equal(fact(tree, "direct-delete").ownershipEffect, "finalize");
  const wrapped = fact(tree, "through-wrapper");
  assert.equal(wrapped.ownershipEffect, "finalize");
  assert.equal(wrapped.parameters[0].ownershipEffect, "finalize");
});

test("declaration-identity callee rules carry refcount and deferred-transfer semantics", () => {
  const p = parameter("retain-p", "resource", "Resource *");
  const retain = fn(
    "retain-call",
    "Observe",
    "void (Resource *)",
    [p],
    [call("external-retain", "spelling_is_irrelevant", parameterRef("retain-p", "resource", "Resource *"))],
  );
  const options = {
    externalCalleeRules: {
      "external-retain": {
        ownershipEffect: "retain",
        escape: "retained",
        completion: "synchronous",
        arguments: {
          0: { ownershipEffect: "retain", escape: "retained", memoryEffect: "atomic", writePredicate: "always" },
        },
      },
    },
  };
  const result = fact(ast(retain), "retain-call", options);
  assert.equal(result.ownershipEffect, "retain");
  assert.equal(result.escape, "retained");
  assert.equal(result.parameters[0].ownershipEffect, "retain");
  assert.equal(result.parameters[0].memoryEffect, "atomic");
});

test("increment/decrement and new expressions are recovered from AST operations", () => {
  const counter = parameter("counter", "counter", "unsigned int *");
  const mutate = fn(
    "mutate-counter",
    "NotARefcountName",
    "void (unsigned int *)",
    [counter],
    [
      {
        kind: "UnaryOperator",
        opcode: "++",
        inner: [{ kind: "UnaryOperator", opcode: "*", inner: [parameterRef("counter", "counter", "unsigned int *")] }],
      },
    ],
  );
  const create = fn(
    "create",
    "ActuallyNamedObserve",
    "Widget * ()",
    [],
    [{ kind: "ReturnStmt", inner: [{ kind: "CXXNewExpr", type: { qualType: "Widget *" } }] }],
  );
  const cursor = parameter("cursor", "cursor", "unsigned int *");
  const advance = fn(
    "advance-pointer",
    "StillNotARefcount",
    "void (unsigned int *)",
    [cursor],
    [{ kind: "UnaryOperator", opcode: "++", inner: [parameterRef("cursor", "cursor", "unsigned int *")] }],
  );
  const tree = ast(mutate, create, advance);
  const mutation = fact(tree, "mutate-counter");
  assert.equal(mutation.ownershipEffect, "none");
  assert.equal(mutation.parameters[0].memoryEffect, "exact-one-readwrite");
  assert.equal(mutation.parameters[0].writePredicate, "always");
  const created = fact(tree, "create");
  assert.equal(created.ownershipEffect, "acquire");
  assert.equal(created.resultProvenance, "owned-resource");
  assert.equal(fact(tree, "advance-pointer").parameters[0].memoryEffect, "unknown");
});

test("release, transfer, and deferred completion remain explicit callee semantics", () => {
  const p = parameter("deferred-p", "resource", "Resource *");
  const route = fn(
    "deferred",
    "Observe",
    "void (Resource *)",
    [p],
    [call("external-defer", "any_spelling", parameterRef("deferred-p", "resource", "Resource *"))],
  );
  const result = fact(ast(route), "deferred", {
    externalCalleeRules: {
      "external-defer": {
        ownershipEffect: "transfer",
        escape: "deferred",
        completion: "deferred",
        arguments: {
          0: { ownershipEffect: "transfer", escape: "deferred", completion: "deferred" },
        },
      },
    },
  });
  assert.equal(result.ownershipEffect, "transfer");
  assert.equal(result.escape, "deferred");
  assert.equal(result.completion, "deferred");
  assert.equal(result.parameters[0].ownershipEffect, "transfer");
});

test("pointer stores report retention and pointer returns report borrowed provenance", () => {
  const p = parameter("escape-p", "resource", "Resource *");
  const store = fn(
    "store",
    "Anything",
    "void (Resource *)",
    [p],
    [
      {
        kind: "BinaryOperator",
        opcode: "=",
        inner: [
          {
            kind: "MemberExpr",
            name: "slot",
            inner: [{ kind: "DeclRefExpr", referencedDecl: { kind: "VarDecl", id: "global", name: "state" } }],
          },
          parameterRef("escape-p", "resource", "Resource *"),
        ],
      },
    ],
  );
  const returned = fn(
    "return",
    "AnythingElse",
    "Resource * (Resource *)",
    [p],
    [{ kind: "ReturnStmt", inner: [parameterRef("escape-p", "resource", "Resource *")] }],
  );
  const stored = fact(ast(store), "store");
  assert.equal(stored.ownershipEffect, "retain");
  assert.equal(stored.escape, "retained");
  assert.equal(stored.parameters[0].escape, "retained");
  const borrowed = fact(ast(returned), "return");
  assert.equal(borrowed.escape, "returned");
  assert.equal(borrowed.resultProvenance, "borrowed-resource");
});

test("copying a pointee value does not retain the source pointer", () => {
  const values = parameter("values", "values", "const float *");
  const copy = fn(
    "copy-value",
    "CopyValue",
    "void (const float *)",
    [values],
    [
      {
        kind: "BinaryOperator",
        opcode: "=",
        inner: [
          { kind: "DeclRefExpr", type: { qualType: "float" }, referencedDecl: { kind: "VarDecl", id: "slot", name: "slot" } },
          {
            kind: "ArraySubscriptExpr",
            type: { qualType: "float" },
            inner: [parameterRef("values", "values", "const float *"), { kind: "IntegerLiteral", value: "0" }],
          },
        ],
      },
    ],
  );
  const result = fact(ast(copy), "copy-value");
  assert.equal(result.ownershipEffect, "none");
  assert.equal(result.escape, "noescape");
  assert.equal(result.parameters[0].ownershipEffect, "none");
  assert.equal(result.parameters[0].memoryEffect, "span");
});

test("indirect calls involving pointers fail closed as unknown", () => {
  const p = parameter("indirect-p", "resource", "Resource *");
  const indirect = fn(
    "indirect",
    "Observe",
    "void (Resource *)",
    [p],
    [
      {
        kind: "CallExpr",
        inner: [
          { kind: "DeclRefExpr", referencedDecl: { kind: "VarDecl", id: "callback", name: "callback" } },
          parameterRef("indirect-p", "resource", "Resource *"),
        ],
      },
    ],
  );
  const result = fact(ast(indirect), "indirect");
  assert.equal(result.ownershipEffect, "unknown");
  assert.equal(result.escape, "unknown");
  assert.equal(result.completion, "unknown");
  assert.equal(result.parameters[0].memoryEffect, "unknown");
  assert.deepEqual(result.diagnostics, ["indirect-callee-effect"]);
});

test("typedef-backed handle pointers remain pointer effects at the AST boundary", () => {
  const handle = {
    kind: "ParmVarDecl",
    id: "handle",
    name: "handle",
    type: { qualType: "HResource", desugaredQualType: "struct Resource *" },
  };
  const unresolved = fn(
    "typedef-handle",
    "Observe",
    "void (HResource)",
    [handle],
    [{ kind: "CallExpr", inner: [{ kind: "DeclRefExpr", referencedDecl: { kind: "FunctionDecl", id: "unknown", name: "opaque" } }, parameterRef("handle", "handle", "HResource")] }],
  );
  const result = fact(ast(unresolved), "typedef-handle");
  assert.equal(result.parameters[0].memoryEffect, "unknown");
  assert.equal(result.parameters[0].ownershipEffect, "unknown");
  assert.deepEqual(result.diagnostics, ["unresolved-callee-effect"]);
});

test("callee semantic rules can prove a lease-token result without callable spelling", () => {
  const acquire = fn(
    "lease",
    "DestroyEverything",
    "uint64_t ()",
    [],
    [{ kind: "ReturnStmt", inner: [call("external-lease", "renamed_again")] }],
  );
  const result = fact(ast(acquire), "lease", {
    externalCalleeRules: {
      "external-lease": {
        ownershipEffect: "acquire",
        escape: "noescape",
        completion: "synchronous",
        resultProvenance: "lease-token",
      },
    },
  });
  assert.equal(result.ownershipEffect, "acquire");
  assert.equal(result.resultProvenance, "lease-token");
});

test("pointer memory facts distinguish exact write, absent write, span, atomic, and persistent rebind", () => {
  const out = parameter("out", "out", "int *");
  const exactWrite = fn(
    "write",
    "Alpha",
    "void (int *)",
    [out],
    [
      {
        kind: "BinaryOperator",
        opcode: "=",
        inner: [
          { kind: "UnaryOperator", opcode: "*", inner: [parameterRef("out", "out", "int *")] },
          { kind: "IntegerLiteral", value: "7" },
        ],
      },
    ],
  );
  const missingWrite = fn("missing", "Beta", "void (int *)", [out], []);
  const span = fn(
    "span",
    "Gamma",
    "int (int *)",
    [out],
    [
      {
        kind: "ReturnStmt",
        inner: [
          {
            kind: "ArraySubscriptExpr",
            inner: [parameterRef("out", "out", "int *"), { kind: "IntegerLiteral", value: "2" }],
          },
        ],
      },
    ],
  );
  const atomic = fn(
    "atomic",
    "Delta",
    "void (int *)",
    [out],
    [call("fetch-add", "fetch_add", parameterRef("out", "out", "int *"), { kind: "IntegerLiteral", value: "1" })],
  );
  const slot = parameter("slot", "slot", "Widget **");
  const rebind = fn(
    "rebind",
    "Epsilon",
    "void (Widget **)",
    [slot],
    [
      {
        kind: "BinaryOperator",
        opcode: "=",
        inner: [
          { kind: "UnaryOperator", opcode: "*", inner: [parameterRef("slot", "slot", "Widget **")] },
          { kind: "CXXNewExpr", type: { qualType: "Widget *" } },
        ],
      },
    ],
  );
  const tree = ast(exactWrite, missingWrite, span, atomic, rebind);
  assert.deepEqual(
    ["write", "missing", "span", "atomic", "rebind"].map((id) => {
      const parameterFact = fact(tree, id).parameters[0];
      return [parameterFact.memoryEffect, parameterFact.writePredicate];
    }),
    [
      ["exact-one-write", "always"],
      ["unknown", "never"],
      ["span", "never"],
      ["atomic", "always"],
      ["persistent-rebind", "always"],
    ],
  );
});

test("conditional writes preserve their predicate and schema validation rejects extra keys", () => {
  const out = parameter("conditional-out", "out", "int *");
  const conditional = fn(
    "conditional",
    "Whatever",
    "void (int *)",
    [out],
    [
      {
        kind: "IfStmt",
        inner: [
          { kind: "CXXBoolLiteralExpr", value: true },
          body({
            kind: "BinaryOperator",
            opcode: "=",
            inner: [
              { kind: "UnaryOperator", opcode: "*", inner: [parameterRef("conditional-out", "out", "int *")] },
              { kind: "IntegerLiteral", value: "1" },
            ],
          }),
        ],
      },
    ],
  );
  const result = fact(ast(conditional), "conditional");
  assert.equal(result.parameters[0].writePredicate, "conditional");
  assert.throws(
    () => validateCppOwnershipEffectFact({ ...structuredClone(result), callableName: "forbidden" }),
    /unsupported schema keys/u,
  );
  assert.throws(
    () =>
      validateCppOwnershipEffectArtifact({
        schemaVersion: 1,
        kind: CPP_OWNERSHIP_EFFECT_FACTS_KIND,
        functions: [result, result],
      }),
    /duplicate declaration ids/u,
  );
});

test("loop-carried pointer access cannot masquerade as an exact-one operation", () => {
  const out = parameter("loop-out", "out", "int *");
  const loop = fn(
    "loop",
    "OneWriteAccordingToTheName",
    "void (int *)",
    [out],
    [
      {
        kind: "WhileStmt",
        inner: [
          { kind: "CXXBoolLiteralExpr", value: true },
          body({
            kind: "UnaryOperator",
            opcode: "++",
            inner: [{ kind: "UnaryOperator", opcode: "*", inner: [parameterRef("loop-out", "out", "int *")] }],
          }),
        ],
      },
    ],
  );
  const result = fact(ast(loop), "loop");
  assert.equal(result.parameters[0].memoryEffect, "unknown");
  assert.equal(result.parameters[0].writePredicate, "unknown");
  assert.deepEqual(result.diagnostics, ["repeated-pointer-effect"]);
});
