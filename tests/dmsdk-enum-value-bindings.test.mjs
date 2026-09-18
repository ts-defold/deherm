import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "bindings/generated/defold-dmsdk-enum-value-bindings.json");
const sdkRoot = join(repositoryRoot, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";

function run(command, args) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
}

function includeArgs() {
  return [
    `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
    "-isystem", join(sdkRoot, "sdk/include"),
    "-isystem", join(sdkRoot, "include"),
    "-DDLIB_LOG_DOMAIN=\"deherm\"",
  ];
}

test("enum-value generator is byte deterministic", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-enum-value-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-enum-value-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [...report.artifacts, "bindings/generated/defold-dmsdk-enum-value-bindings.json"]) {
      assert.equal(await readFile(join(output, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
    }
    run(process.execPath, ["scripts/generate-dmsdk-enum-value-bindings.mjs", "--out-root", output, "--check"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("all ten mechanically discovered enum-value candidates have an honest disposition", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.coverage, {
    baselineRuntimePending: 1361,
    previouslyEmittedScalar: 26,
    discovered: 10,
    emitted: 7,
    blocked: 3,
    hostRuntimeVerified: 4,
    engineContextPending: 3,
    remainingWithoutGeneratedAdapters: 1328,
  });
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 10);
  assert.equal(new Set(report.declarations.filter(({ emitted }) => emitted).map(({ bindingId }) => bindingId)).size, 7);
  assert.deepEqual(report.declarations.filter(({ emitted }) => !emitted).map(({ blocker }) => blocker).sort(), [
    "engine-lifecycle-capability-required",
    "extension-registry-capability-required",
    "extension-registry-capability-required",
  ]);
  assert.equal(Object.keys(report.artifactHashes).length, report.artifacts.length);
  for (const digest of [...Object.values(report.sourceHashes), ...Object.values(report.artifactHashes)]) assert.match(digest, /^[a-f0-9]{64}$/);
});

test("every emitted C++ and JSI translation unit compiles against the complete pinned packaged SDK", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-enum-objects-"));
  try {
    const sources = report.artifacts.filter((path) => path.endsWith(".cpp"));
    for (const [index, source] of sources.entries()) {
      run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includeArgs(), "-c", source, "-o", join(output, `${index}.o`)]);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("C ABI links to the packaged dmSDK and host-safe routes execute with zero warmed allocations", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(`pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`);
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-enum-host-"));
  try {
    const cObject = join(output, "c-caller.o");
    run(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-c", "native/dmsdk_enum_c_header_test.c", "-o", cObject]);
    const libraryArgs = [
      join(sdkRoot, "lib/arm64-macos/libdlib.a"),
      join(sdkRoot, "lib/arm64-macos/libprofile_null.a"),
      "-framework", "CoreFoundation", "-framework", "Foundation", "-framework", "Security",
    ];
    const cExecutable = join(output, "c-abi");
    run(compiler, ["-std=c++17", ...includeArgs(), "defold/defold_hermes/src/generated_dmsdk_enum_value_buffer.cpp", cObject, ...libraryArgs, "-o", cExecutable]);
    run(cExecutable, []);

    const executable = join(output, "host-runtime");
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includeArgs(),
      "defold/defold_hermes/src/generated_dmsdk_enum_value_buffer.cpp",
      "defold/defold_hermes/src/generated_dmsdk_enum_value_log.cpp",
      "defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp",
      "native/dmsdk_enum_pending_stubs.cpp", "native/dmsdk_enum_host_test.cpp",
      ...libraryArgs, "-o", executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("generated glue contains no heap ownership primitive", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const source of report.artifacts.filter((path) => path.endsWith(".cpp"))) {
    const content = await readFile(join(repositoryRoot, source), "utf8");
    assert.doesNotMatch(content, /\b(?:new|delete|malloc|calloc|realloc|free)\b/, source);
  }
});
