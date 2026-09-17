import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..");
const reportPath = join(repositoryRoot, "bindings/generated/defold-dmsdk-scalar-thunks.json");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe", ...options });
}

test("scalar thunk artifacts are deterministic", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "deherm-dmsdk-scalar-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-scalar-thunks.mjs", "--out-root", outputRoot]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [...report.artifacts, "bindings/generated/defold-dmsdk-scalar-thunks.json"]) {
      assert.equal(await readFile(join(outputRoot, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("all 31 scalar-direct candidates have an evidence-backed disposition", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.coverage, {
    reviewed: 31,
    generated: 26,
    objectCompileCovered: 26,
    hostSourceLinkCovered: 25,
    hostBehaviorCovered: 25,
    blocked: 5,
    policyBlocked: 4,
    sourceBlocked: 1,
    packagedLibraryLinked: 0,
    allTargetConformant: 0,
  });
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 31);
  assert.equal(new Set(report.declarations.filter(({ emitted }) => emitted).map(({ wrapper }) => wrapper)).size, 26);
  for (const declaration of report.declarations) {
    assert.ok(declaration.headerEvidence.sha256.match(/^[a-f0-9]{64}$/));
    assert.ok(declaration.headerEvidence.declarationLine > 0);
    for (const stage of ["generated", "compiled", "linked", "conformant"]) {
      assert.ok(declaration.stages[stage].status);
      assert.ok(declaration.stages[stage].evidence);
    }
  }
  const graphics = report.declarations.find(({ symbol }) => symbol === "dmGraphics::Finalize");
  assert.equal(graphics.emitted, false);
  assert.equal(graphics.blocker.missingDependency, "graphics/graphics_ddf.h");
  assert.equal(graphics.blocker.checkedPath, "upstream/defold/engine/graphics/src/graphics/graphics_ddf.h");
  const unsafeLifecycle = new Set([
    "dmLog::LogFinalize", "dmLogFinalize", "ProfileInitialize", "ProfileFinalize"
  ]);
  for (const declaration of report.declarations.filter(({ symbol }) => unsafeLifecycle.has(symbol))) {
    assert.equal(declaration.emitted, false);
    assert.equal(declaration.blocker.policy, "lifecycle-capability-required");
    assert.equal(declaration.stages.generated.status, "blocked-by-policy");
  }
  const publicHeader = await readFile(join(repositoryRoot,
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h"), "utf8");
  assert.doesNotMatch(publicHeader, /(?:log_finalize|profile_initialize|profile_finalize)/);
  assert.equal(report.declarations.filter(({ stages }) => stages.linked.status === "not-yet-tested").length, 1);
});

test("every emitted module compiles to an object against pinned Defold headers", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const sources = report.artifacts.filter((artifact) => artifact.endsWith(".cpp"));
  const includeArgs = [
    `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
    "-isystem", join(repositoryRoot, "upstream/defold/engine/dlib/src"),
    "-DDLIB_LOG_DOMAIN=\"deherm\"",
  ];
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-scalar-objects-"));
  try {
    for (const [index, source] of sources.entries()) {
      run(compiler, [
        "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
        ...includeArgs,
        "-c", source,
        "-o", join(outputDirectory, `module-${index}.o`),
      ]);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("the public thunk header is C-compatible, C-linkable, and generated glue is allocation-free", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-scalar-c-abi-"));
  try {
    const cObject = join(outputDirectory, "caller.o");
    const executable = join(outputDirectory, "c-abi-test");
    run(cCompiler, [
      "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-c", "native/dmsdk_scalar_c_header_test.c", "-o", cObject,
    ]);
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-isystem", join(repositoryRoot, "upstream/defold/engine/dlib/src"),
      "defold/defold_hermes/src/generated_dmsdk_scalar_endian.cpp", cObject,
      "-o", executable,
    ]);
    run(executable, []);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const source of report.artifacts.filter((artifact) => artifact.endsWith(".cpp"))) {
    const content = await readFile(join(repositoryRoot, source), "utf8");
    assert.doesNotMatch(content, /\b(?:new|delete|malloc|calloc|realloc|free)\b/, source);
  }
});

test("25 wrappers link to pinned host sources and pass behavior checks", async (context) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    context.skip(`host source-link harness is not defined for ${process.platform}`);
    return;
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-scalar-native-"));
  try {
    const timeSource = process.platform === "darwin"
      ? "upstream/defold/engine/dlib/src/dlib/time_apple.cpp"
      : "upstream/defold/engine/dlib/src/dlib/time_posix.cpp";
    const sources = [
      "defold/defold_hermes/src/generated_dmsdk_scalar_endian.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_time.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_trig.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_utf8.cpp",
      "upstream/defold/engine/dlib/src/dlib/trig_lookup.cpp",
      timeSource,
      "native/dmsdk_scalar_thunks_test.cpp",
    ];
    const executable = join(outputDirectory, "dmsdk-scalar-thunks-test");
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-isystem", join(repositoryRoot, "upstream/defold/engine/dlib/src"),
      ...sources,
      "-o", executable,
    ]);
    assert.equal(run(executable, []).trim(), "dmsdk-scalar-thunks:ok");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
