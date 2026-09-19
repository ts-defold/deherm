import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Defold Android suppresses Hermes' fbjni finalizer-thread wrapper", async () => {
  const source = await readFile("defold/defold_hermes/src/runtime.cpp", "utf8");

  const android = source.match(
    /#if defined\(DM_PLATFORM_ANDROID\)([\s\S]*?)#else/u
  )?.[1];
  assert.ok(android, "runtime construction has no Android-specific configuration");
  assert.match(android, /withFinalizerThreadRunner\(::hermes::vm::ThreadRunner\{\}\)/u);
  assert.doesNotMatch(android, /withFinalizerThreadRunner\(\{\}\)/u);
  assert.match(source, /runtime_\(makeRuntime\(\)\)/u);
});

test("Android native compilation has a bounded per-row worker count", async () => {
  const dockerfile = await readFile("toolchains/hermes/Dockerfile.android", "utf8");
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(dockerfile, /ARG BUILD_JOBS=2/u);
  assert.doesNotMatch(instructions, /\$\(nproc\)/u);
  assert.equal((instructions.match(/\$\{BUILD_JOBS\}/gu) ?? []).length, 5);
});

test("Android applies the pinned Hermes missing-vector fix before compilation", async () => {
  const dockerfile = await readFile("toolchains/hermes/Dockerfile.android", "utf8");
  const patch = await readFile("toolchains/hermes/patches/pass-manager-vector.patch", "utf8");
  const fingerprints = await readFile("scripts/lib/artifact-releases.mjs", "utf8");

  assert.match(patch, /PassManager\.h[\s\S]*\+#include <vector>/u);
  assert.match(dockerfile, /git -C \/src\/hermes apply --check \/tmp\/hermes-pass-manager-vector\.patch/u);
  assert.match(fingerprints, /toolchains\/hermes\/patches\/pass-manager-vector\.patch/u);
});
