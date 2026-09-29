import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { formatDefoldHashBigInt, hashDefoldLiteral64 } from "../packages/compiler/src/defold-hash.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/hash-literal");

function run(file, arguments_, options = {}) {
  return execFileSync(file, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

test("actual ttsc source-plugin host emits constants and preserves non-hash values", async () => {
  const outputRoot = path.join(fixture, ".out");
  await rm(outputRoot, { recursive: true, force: true });
  try {
    run(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, "tsconfig.json")]);
    const output = await readFile(path.join(outputRoot, "tests/fixtures/hash-literal/entry.js"), "utf8");
    assert.match(output, /0x80356add32e752e9n/);
    assert.match(output, /0x686b6237f73adab7n/);
    assert.match(output, new RegExp(formatDefoldHashBigInt(hashDefoldLiteral64("#fire"))));
    assert.match(output, new RegExp(formatDefoldHashBigInt(hashDefoldLiteral64("#argument"))));
    assert.match(output, new RegExp(formatDefoldHashBigInt(hashDefoldLiteral64("#optional"))));
    assert.match(output, new RegExp(formatDefoldHashBigInt(hashDefoldLiteral64("#configured"))));
    for (const literal of ["#array", "#tuple", "#initial", "#assigned", "#returned"]) {
      assert.match(output, new RegExp(formatDefoldHashBigInt(hashDefoldLiteral64(literal))));
    }
    assert.match(output, /acceptsStringOrHash\("#ambiguous"\)/);
    assert.match(output, /address\("#sprite"\)/);
    assert.match(output, /untouchedDynamicString = "ordinary"/);
    assert.match(output, /const hashLiteral = \(value\) => value/);
    assert.match(output, /return hashLiteral\("#local"\)/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("ttsc source-plugin hash intrinsic fails closed for dynamic and empty names", async () => {
  run(path.join(root, "node_modules/.bin/tsc"), ["-p", path.join(fixture, "tsconfig.types.json")]);
  const outputRoot = path.join(fixture, ".out-dynamic");
  await rm(outputRoot, { recursive: true, force: true });
  try {
    assert.throws(
      () => run(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, "tsconfig.dynamic.json")]),
      (error) => /compile-time string literal/.test(String(error?.stderr)),
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }

  const contextualOutputRoot = path.join(fixture, ".out-contextual-empty");
  await rm(contextualOutputRoot, { recursive: true, force: true });
  try {
    assert.throws(
      () =>
        run(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, "tsconfig.contextual-empty.json")]),
      (error) => /used as DefoldHash must use the #name sigil/.test(String(error?.stderr)),
    );
  } finally {
    await rm(contextualOutputRoot, { recursive: true, force: true });
  }
});
