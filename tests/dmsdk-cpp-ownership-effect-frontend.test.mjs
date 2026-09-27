import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveDmSdkCppOwnershipEffectFacts,
  validateDmSdkCppOwnershipEffectFrontend,
  validateDmSdkCppOwnershipEffectReport,
} from "../packages/compiler/src/dmsdk-cpp-ownership-effect-frontend.mjs";

const declaration = {
  id: "dmsdk:dm::Observe@upstream/defold/engine/dm.h:12:1",
  name: "dm::Observe",
  header: "upstream/defold/engine/dm.h",
  line: 12,
  parameters: [{ name: "handle", type: "HHandle", description: "" }],
};

function fixtureAst({ includeBody = true } = {}) {
  const parameter = { kind: "ParmVarDecl", id: "param", name: "handle", type: { qualType: "HHandle" } };
  const body = {
    kind: "FunctionDecl",
    id: "definition",
    name: "Observe",
    type: { qualType: "void (HHandle)" },
    loc: { line: 30 },
    inner: [parameter, ...(includeBody ? [{ kind: "CompoundStmt", inner: [] }] : [])],
  };
  return {
    kind: "TranslationUnitDecl",
    inner: [
      {
        kind: "NamespaceDecl",
        name: "dm",
        inner: [
          {
            kind: "FunctionDecl",
            id: "header",
            name: "Observe",
            type: { qualType: "void (HHandle)" },
            loc: { line: 12, includedFrom: { file: "upstream/defold/engine/dm.h" } },
            inner: [{ kind: "ParmVarDecl", id: "header-param", name: "handle", type: { qualType: "HHandle" } }],
          },
          body,
        ],
      },
    ],
  };
}

test("frontend authenticates source identity and extracts by AST declaration identity", () => {
  const artifact = deriveDmSdkCppOwnershipEffectFacts({
    ast: fixtureAst(),
    declarations: [declaration],
    sourcePath: "upstream/defold/engine/dm.cpp",
    sourceText: "void dm::Observe(HHandle) {}",
    translationUnitText: "clang invocation + source",
  });
  assert.equal(artifact.functions.length, 1);
  assert.equal(artifact.functions[0].state, "observed");
  assert.equal(artifact.functions[0].fact.declarationId, declaration.id);
  assert.match(artifact.functions[0].ast.headerDeclarationId, /^[a-f0-9]{64}$/u);
  assert.match(artifact.functions[0].ast.definitionId, /^[a-f0-9]{64}$/u);
  validateDmSdkCppOwnershipEffectFrontend(artifact);
});

test("frontend identities and evidence paths do not depend on the checkout root", () => {
  const derive = (checkoutRoot) => {
    const ast = fixtureAst();
    ast.inner[0].inner[0].loc = {
      line: 12,
      file: `${checkoutRoot}/upstream/defold/engine/dm.h`,
    };
    ast.inner[0].inner[1].loc = {
      line: 30,
      col: 7,
      file: `${checkoutRoot}/upstream/defold/engine/dm.cpp`,
    };
    return deriveDmSdkCppOwnershipEffectFacts({
      ast,
      declarations: [declaration],
      sourcePath: "upstream/defold/engine/dm.cpp",
      sourceText: "void dm::Observe(HHandle) {}",
      translationUnitText: "canonical invocation + source",
    });
  };
  assert.deepEqual(derive("/checkout/a"), derive("/private/tmp/checkout-b"));
});

test("source-alias overlay evidence paths do not depend on the checkout root", () => {
  const derive = (checkoutRoot) => {
    const ast = fixtureAst();
    ast.inner[0].inner[1].loc = {
      line: 30,
      col: 7,
      file: `${checkoutRoot}/.deherm/cache/dmsdk-semantic-includes/deadbeef/dlib/atomic.h`,
    };
    return deriveDmSdkCppOwnershipEffectFacts({
      ast,
      declarations: [declaration],
      sourcePath: "upstream/defold/engine/dm.cpp",
      sourceText: "void dm::Observe(HHandle) {}",
      translationUnitText: "canonical invocation + source",
    });
  };
  const first = derive("/checkout/a");
  assert.equal(first.functions[0].ast.definitionFile, "<source-alias-overlay>/dlib/atomic.h");
  assert.deepEqual(first, derive("/private/tmp/checkout-b"));
});

test("frontend fails closed when the exact header declaration is absent", () => {
  const ast = fixtureAst();
  ast.inner[0].inner.shift();
  const artifact = deriveDmSdkCppOwnershipEffectFacts({ ast, declarations: [declaration], sourcePath: "dm.cpp" });
  assert.equal(artifact.functions[0].state, "unknown");
  assert.deepEqual(artifact.functions[0].diagnostics, ["implementation-symbol-not-found"]);
  assert.equal(artifact.functions[0].fact, null);
});

test("frontend joins an implementation to source IR by exact mangled symbol", () => {
  const ast = fixtureAst();
  ast.inner[0].inner.shift();
  ast.inner[0].inner[0].mangledName = "_ZN2dm7ObserveEP6Handle";
  const artifact = deriveDmSdkCppOwnershipEffectFacts({
    ast,
    declarations: [{ ...declaration, mangledName: "_ZN2dm7ObserveEP6Handle", type: "void (HHandle)" }],
    sourcePath: "dm.cpp",
  });
  assert.equal(artifact.functions[0].state, "observed");
  assert.equal(artifact.functions[0].ast.join, "mangled-symbol");
});

test("frontend fails closed when multiple source definitions disagree or are unresolved", () => {
  const artifact = deriveDmSdkCppOwnershipEffectFacts({
    ast: fixtureAst({ includeBody: false }),
    declarations: [declaration],
    sourcePath: "dm.cpp",
  });
  assert.equal(artifact.functions[0].state, "unknown");
  assert.deepEqual(artifact.functions[0].diagnostics, ["implementation-not-found"]);
});

test("forced-header identity is not a global same-spelling admission", () => {
  const ast = fixtureAst();
  ast.inner[0].inner.splice(1, 0, {
    kind: "FunctionDecl",
    id: "second-definition",
    name: "Observe",
    type: { qualType: "void (HHandle)" },
    loc: { line: 30 },
    inner: [
      { kind: "ParmVarDecl", id: "second-param", name: "handle", type: { qualType: "HHandle" } },
      { kind: "CompoundStmt", inner: [] },
    ],
  });
  const artifact = deriveDmSdkCppOwnershipEffectFacts({
    ast,
    declarations: [declaration],
    sourcePath: "dm.cpp",
    includedHeaders: ["upstream/defold/engine/dm.h"],
  });
  assert.equal(artifact.functions[0].state, "unknown");
  assert.deepEqual(artifact.functions[0].diagnostics, ["implementation-ambiguous"]);
});

test("generated revision artifact is authenticated, exhaustive, and remains audit-only", async () => {
  const report = JSON.parse(
    await readFile(
      new URL("../packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json", import.meta.url),
      "utf8",
    ),
  );
  validateDmSdkCppOwnershipEffectReport(report);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.admission, "audit-only-single-profile");
  assert.deepEqual(report.coverage, {
    requested: 212,
    observed: 160,
    unknown: 52,
    envelopes: {
      "borrowed-handle": { requested: 182, observed: 142, unknown: 40 },
      "scratch-scalar-out": { requested: 30, observed: 18, unknown: 12 },
    },
  });
  assert.ok(
    report.functions.every((row) => row.observations.length < report.sources.length),
    "route observations must be joined only to relevant source files",
  );
  assert.ok(
    report.sources.every((source) => /^[a-f0-9]{64}$/u.test(source.translationUnitSha256)),
    "complete and rejected translation units must both retain deterministic identity",
  );
  assert.ok(
    report.sources
      .filter((source) => source.astState === "rejected-with-diagnostics")
      .every((source) => source.blockers.length > 0),
    "rejected translation units must expose machine-readable blockers",
  );
});
