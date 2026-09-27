import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  clangAst,
  clangInvocation,
} from "../scripts/generate-dmsdk-source-semantic-facts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json";

function run(args) {
  return execFileSync(process.execPath, ["scripts/generate-dmsdk-source-semantic-facts.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("bounded-span source facts regenerate deterministically from pinned C/C++ implementations", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-source-semantic-facts-"));
  try {
    run(["--out-root", output]);
    const [expected, actual] = await Promise.all([
      readFile(path.join(root, artifact), "utf8"),
      readFile(path.join(output, artifact), "utf8"),
    ]);
    assert.equal(actual, expected);
    const report = JSON.parse(actual);
    assert.deepEqual(report.coverage, { requested: 10, observed: 10, missing: 0 });
    assert.equal(report.extraction, "clang-json-ast/compact-dataflow-v1");
    assert.ok(report.sources.every(({ path, sha256 }) => path.startsWith("upstream/defold/") && /^[0-9a-f]{64}$/u.test(sha256)));
    run(["--out-root", output, "--check"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("translation-unit language follows the source language instead of forcing C++", () => {
  assert.deepEqual(clangInvocation("source.c", []).slice(0, 4), ["-x", "c", "-std=c11", "-fsyntax-only"]);
  assert.deepEqual(clangInvocation("source.cpp", []).slice(0, 4), ["-x", "c++", "-std=c++17", "-fsyntax-only"]);
  assert.deepEqual(clangInvocation("source.mm", []).slice(0, 4), ["-x", "objective-c++", "-std=c++17", "-fsyntax-only"]);
});

test("errored recovery ASTs are categorically unavailable as positive semantic evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-recovery-ast-"));
  try {
    const cases = [
      ["before.cpp", "this is not C++;\nint Target(int value) { return value; }\n"],
      ["inside.c", "int Target(int value) { int broken[; return value; }\n"],
      ["after.mm", "int Target(int value) { return value; }\n@interface Broken\n"],
    ];
    for (const [name, source] of cases) {
      const file = path.join(workspace, name);
      await writeFile(file, source);
      const result = await clangAst(file, [], workspace);
      assert.equal(result.complete, false, name);
      assert.equal(result.ast, null, `${name}: recovery AST must not cross the admission boundary`);
      assert.notEqual(result.diagnostics.length, 0, name);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
