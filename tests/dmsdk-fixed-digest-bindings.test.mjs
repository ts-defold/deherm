import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "bindings/generated/defold-dmsdk-fixed-digest-bindings.json");
const sdkRoot = join(repositoryRoot, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
function run(command, args) { return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }); }
function includeArgs() { return [`-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-isystem", join(sdkRoot, "sdk/include"), "-isystem", join(sdkRoot, "include")]; }

test("fixed-digest generator is deterministic and provenance-bound to the IR census", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, { baselineRuntimePending: 1361, discovered: 4, emitted: 4, policyBlocked: 0, hostBehaviorVerified: 4, remainingWithoutGeneratedAdapters: 1324 });
    for (const artifact of [...report.artifacts, "bindings/generated/defold-dmsdk-fixed-digest-bindings.json"])
      assert.equal(await readFile(join(output, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
    run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--out-root", output, "--check"]);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("fixed-digest generation fails closed when ABI-shape provenance no longer names the supplied IR", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-provenance-"));
  try {
    const irPath = join(output, "ir.json");
    await writeFile(irPath, `${await readFile(join(repositoryRoot, "bindings/generated/defold-sdk-ir.json"), "utf8")}\n`);
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--ir", irPath, "--out-root", join(output, "out")]), /IR hash does not match ABI-shape census provenance/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("fixed-digest generation rejects drifted per-entry digest evidence", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-evidence-"));
  try {
    const policyPath = join(output, "policy.json");
    await writeFile(policyPath, (await readFile(join(repositoryRoot, "bindings/overrides/dmsdk-fixed-digest-bindings.json"), "utf8")).replace("output is 16 bytes", "output is 17 bytes"));
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--policy", policyPath, "--out-root", join(output, "out")]), /Fixed-digest evidence drifted/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("fixed-digest C ABI compiles, links, hashes known input, rejects invalid bounds, and allocates nothing warmed", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") { context.skip(`pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`); return; }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-host-"));
  try {
    const cObject = join(output, "header.o");
    run(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-c", "native/dmsdk_fixed_digest_c_header_test.c", "-o", cObject]);
    const libraryArgs = [join(sdkRoot, "lib/arm64-macos/libdlib.a"), "-framework", "Security", "-framework", "CoreFoundation", "-framework", "Foundation"];
    const cExecutable = join(output, "c-abi");
    run(compiler, ["-std=c++17", ...includeArgs(), "defold/defold_hermes/src/generated_dmsdk_fixed_digest_crypt.cpp", cObject, ...libraryArgs, "-o", cExecutable]);
    run(cExecutable, []);
    const executable = join(output, "host");
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includeArgs(), "defold/defold_hermes/src/generated_dmsdk_fixed_digest_crypt.cpp", "defold/defold_hermes/src/generated_dmsdk_fixed_digest_runtime.cpp", "native/dmsdk_fixed_digest_host_test.cpp", ...libraryArgs, "-o", executable]);
    run(executable, []);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("fixed-digest generated C++ has no heap ownership primitive", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const artifact of report.artifacts.filter((path) => path.endsWith(".cpp")))
    assert.doesNotMatch(await readFile(join(repositoryRoot, artifact), "utf8"), /\b(?:new|delete|malloc|calloc|realloc|free)\b/, artifact);
});
