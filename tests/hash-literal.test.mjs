import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createIncrementalCompiler } from "../packages/cli/src/dev/compiler.mjs";
import {
  formatDefoldHashBigInt,
  hashDefoldLiteral64,
  hashDefoldString64,
} from "../packages/compiler/src/defold-hash.mjs";

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

test("Defold hash literal projection matches pinned native vectors", () => {
  assert.equal(formatDefoldHashBigInt(hashDefoldString64("my_hash")), "0xa2bc06d97f580aabn");
  assert.equal(formatDefoldHashBigInt(hashDefoldLiteral64("#up")), "0x80356add32e752e9n");
  assert.equal(
    formatDefoldHashBigInt(hashDefoldLiteral64("#räksmörgås🚀")),
    "0x686b6237f73adab7n",
  );
});

test("actual ttsc host emits constants and preserves addresses, strings, and shadowed names", async () => {
  const outputRoot = path.join(fixture, ".out");
  await rm(outputRoot, {recursive: true, force: true});
  try {
    run(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, "tsconfig.json")]);
    const output = await readFile(
      path.join(outputRoot, "tests/fixtures/hash-literal/entry.js"),
      "utf8",
    );
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
    await rm(outputRoot, {recursive: true, force: true});
  }
});

test("hash intrinsic is fail-closed for dynamic and empty names", async () => {
  run(path.join(root, "node_modules/.bin/tsc"), [
    "-p", path.join(fixture, "tsconfig.types.json"),
  ]);
  const outputRoot = path.join(fixture, ".out-dynamic");
  await rm(outputRoot, {recursive: true, force: true});
  try {
    assert.throws(
      () => run(path.join(root, "node_modules/.bin/ttsc"), [
        "-p", path.join(fixture, "tsconfig.dynamic.json"),
      ]),
      (error) => /compile-time string literal/.test(String(error?.stderr)),
    );
  } finally {
    await rm(outputRoot, {recursive: true, force: true});
  }

  const contextualOutputRoot = path.join(fixture, ".out-contextual-empty");
  await rm(contextualOutputRoot, {recursive: true, force: true});
  try {
    assert.throws(
      () => run(path.join(root, "node_modules/.bin/ttsc"), [
        "-p", path.join(fixture, "tsconfig.contextual-empty.json"),
      ]),
      (error) => /used as DefoldHash must use the #name sigil/.test(String(error?.stderr)),
    );
  } finally {
    await rm(contextualOutputRoot, {recursive: true, force: true});
  }
});

test("War Battles compiles literals through the real incremental ttsc/esbuild pipeline", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-hash-bundle-"));
  const output = path.join(temporary, "battle.js");
  const compiler = await createIncrementalCompiler({
    entryPoint: path.join(root, "examples/war-battles-online/defold/reference/battle.gui.ts"),
    outputFile: output,
    tsconfig: path.join(root, "examples/war-battles-online/defold/tsconfig.deherm.gui.json"),
    sourcemap: false,
  });
  t.after(async () => {
    await compiler.dispose();
    await rm(temporary, {recursive: true, force: true});
  });
  await compiler.rebuild();
  const bundle = await readFile(output, "utf8");
  for (const constant of [
    "80356add32e752e9", "cca3db06273fbcb7", "7d1b470c20c0961c",
    "f26b82c786881201", "fde875820cf4ae70", "bf9a1e17147d9fd0",
    "3ab1e73e8d660678", "9adf6a1d5c268bf5", "048dba1670b92225",
  ]) assert.match(bundle, new RegExp(`0x${constant}n`));
  assert.doesNotMatch(bundle, /hashLiteral|defold\.hash\s*\(|builtins\.hash|callScriptApi\(0xa994c4c0/);

  const hermesc = path.join(root, "build/native/bin/hermesc");
  try {
    await access(hermesc);
    run(hermesc, ["-O", "-emit-binary", output, "-out", path.join(temporary, "battle.hbc")]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

test("sound-typed Static Hermes accepts the exact bigint representation", async (t) => {
  const shermes = path.join(root, "build/native/bin/shermes");
  try {
    await access(shermes);
  } catch (error) {
    if (error?.code === "ENOENT") return t.skip("pinned shermes has not been built");
    throw error;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-hash-static-"));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const output = path.join(temporary, "hash.c");
  run(shermes, [
    "-typed", "-strict", "-O", "-emit-c",
    "-exported-unit=deherm_hash_literal_static",
    path.join(fixture, "static-bigint.ts"), "-o", output,
  ]);
  const generated = await readFile(output, "utf8");
  assert.match(generated, /deherm_hash_literal_static_report/);
});

test("native Defold exports agree on ASCII and Unicode vectors", async (t) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return t.skip("native engine probe is specific to the checked-in macOS arm64 engine");
  }
  const engine = path.join(root, "defold/build/arm64-osx/dmengine");
  try {
    await access(engine);
  } catch (error) {
    if (error?.code === "ENOENT") return t.skip("Defold engine artifact has not been built");
    throw error;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-hash-native-"));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const dylib = path.join(temporary, "probe.dylib");
  const executable = path.join(temporary, "dmengine");
  run("clang++", [
    "-std=c++17", "-dynamiclib", "-undefined", "dynamic_lookup",
    path.join(root, "tests/native/hash-ground-truth-probe.cpp"), "-o", dylib,
  ]);
  await copyFile(engine, executable);
  run("chmod", ["755", executable]);
  const output = run(executable, [], {env: {...process.env, DYLD_INSERT_LIBRARIES: dylib}});
  assert.equal(
    output,
    "my_hash=a2bc06d97f580aab\nup=80356add32e752e9\nunicode=686b6237f73adab7\n",
  );
});
