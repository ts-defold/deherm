import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json");
const sdkRoot = join(repositoryRoot, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
function run(command, args) { return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }); }
function includeArgs() { return [`-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-isystem", join(sdkRoot, "sdk/include"), "-isystem", join(sdkRoot, "include")]; }

test("hash-span generator is deterministic, census-derived, and policy complete", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-hash-span-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-hash-span-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, {
      baselineRuntimePending: 1361,
      previouslyGeneratedAdapters: 43,
      discovered: 2,
      emitted: 2,
      policyBlocked: 0,
      hostBehaviorVerified: 2,
      remainingWithoutGeneratedAdapters: 1316,
    });
    assert.deepEqual(report.declarations.map(({ symbol }) => symbol), ["dmHashBuffer32", "dmHashBuffer64"]);
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json"]) {
      assert.equal(await readFile(join(output, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
    }
    run(process.execPath, ["scripts/generate-dmsdk-hash-span-bindings.mjs", "--out-root", output, "--check"]);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("hash-span generation fails closed on provenance, policy, and evidence drift", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-hash-span-drift-"));
  try {
    const irPath = join(output, "ir.json");
    await writeFile(irPath, `${await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8")}\n`);
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-hash-span-bindings.mjs", "--ir", irPath, "--out-root", join(output, "out")]), /IR hash does not match ABI-shape census provenance/);
    const policyPath = join(output, "policy.json");
    await writeFile(policyPath, (await readFile(join(repositoryRoot, "packages/bindings/overrides/dmsdk-hash-span-bindings.json"), "utf8")).replace("Length of buffer", "Length drifted"));
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-hash-span-bindings.mjs", "--policy", policyPath, "--out-root", join(output, "out")]), /Hash-span evidence drifted/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("hash-span C ABI links to the packaged SDK, rejects invalid bounds, and matches Defold vectors", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(`pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`);
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-hash-span-host-"));
  try {
    const cObject = join(output, "header.o");
    run(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-c", "native/dmsdk_hash_span_c_header_test.c", "-o", cObject]);
    const libraries = [
      join(sdkRoot, "lib/arm64-macos/libdlib.a"),
      join(sdkRoot, "lib/arm64-macos/libprofile_null.a"),
      "-framework", "Security", "-framework", "CoreFoundation", "-framework", "Foundation",
    ];
    const cExecutable = join(output, "c-abi");
    run(compiler, ["-std=c++17", ...includeArgs(), "defold/defold_hermes/src/generated_dmsdk_hash_span.cpp", "defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp", cObject, ...libraries, "-o", cExecutable]);
    run(cExecutable, []);
    const executable = join(output, "host");
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includeArgs(), "defold/defold_hermes/src/generated_dmsdk_hash_span.cpp", "defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp", "native/dmsdk_hash_span_host_test.cpp", ...libraries, "-o", executable]);
    run(executable, []);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("hash-span generated C++ owns no heap allocation primitive", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const artifact of report.artifacts.filter((path) => path.endsWith(".cpp"))) {
    assert.doesNotMatch(await readFile(join(repositoryRoot, artifact), "utf8"), /\b(?:new|delete|malloc|calloc|realloc|free)\b/, artifact);
  }
});
