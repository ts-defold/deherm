import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveScalarSourceEvidence } from "../scripts/generate-dmsdk-scalar-thunks.mjs";
import { DERIVED_REVISION_ENV } from "../scripts/lib/reviewed-revision.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-scalar-thunks.json");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
const otherRevision = "0123456789abcdef0123456789abcdef01234567";

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe", ...options });
}

test("scalar source-anchor drift withdraws evidence only during a declared revision derivation", () => {
  const input = {
    content: "void renamed_finalize();\n",
    relativePath: "upstream/defold/engine/example.cpp",
    needle: "void Finalize()",
    owner: "dmsdk:dmExample::Finalize"
  };
  assert.throws(() => resolveScalarSourceEvidence({ ...input, env: {} }), /Expected source evidence not found/u);
  assert.deepEqual(resolveScalarSourceEvidence({
    ...input,
    env: { [DERIVED_REVISION_ENV]: otherRevision }
  }), {
    path: input.relativePath,
    status: "withdrawn",
    reason: "source-anchor-moved",
    anchor: input.needle
  });
  assert.equal(resolveScalarSourceEvidence({
    ...input,
    content: null,
    env: { [DERIVED_REVISION_ENV]: otherRevision }
  }).reason, "absent-source");
});

test("scalar thunk artifacts are deterministic", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "deherm-dmsdk-scalar-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-scalar-thunks.mjs", "--out-root", outputRoot]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-scalar-thunks.json"]) {
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
    hostSourceLinkCovered: 26,
    hostBehaviorCovered: 26,
    blocked: 5,
    policyBlocked: 5,
    sourceBlocked: 0,
    packagedLibraryLinked: 26,
    dispatchReferenceCovered: 26,
    hostExecutableRetained: 26,
    extensionFinalBinaryRetained: 26,
    nativeTypeScriptAdapterGenerated: 26,
    nativeHermesRuntimeSmokeTested: 2,
    browserTypeScriptAdapterGenerated: 16,
    browserAdapterBehaviorTested: 16,
    warmedDispatchIterations: 100000,
    warmedDispatchObservedCppAllocations: 0,
    allTargetConformant: 0,
  });
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 31);
  assert.equal(new Set(report.declarations.filter(({ emitted }) => emitted).map(({ wrapper }) => wrapper)).size, 26);
  for (const declaration of report.declarations) {
    assert.ok(declaration.headerEvidence.sha256.match(/^[a-f0-9]{64}$/));
    assert.ok(declaration.headerEvidence.declarationLine > 0);
    for (const stage of ["generated", "compiled", "linked", "conformant", "retained", "typescriptCallable"]) {
      assert.ok(declaration.stages[stage].status);
      assert.ok(declaration.stages[stage].evidence);
    }
  }
  const graphics = report.declarations.find(({ symbol }) => symbol === "dmGraphics::Finalize");
  assert.equal(graphics.emitted, false);
  assert.equal(graphics.blocker.policy, "lifecycle-capability-required");
  assert.equal(graphics.blocker.category, "engine-lifecycle");
  assert.equal(graphics.stages.compiled.status, "header-compiled-policy-blocked");
  assert.ok(graphics.definitionEvidence.some(({ path }) => path.endsWith("/include/graphics/graphics_ddf.h")));
  const unsafeLifecycle = new Set([
    "dmGraphics::Finalize", "dmLog::LogFinalize", "dmLogFinalize", "ProfileInitialize", "ProfileFinalize"
  ]);
  for (const declaration of report.declarations.filter(({ symbol }) => unsafeLifecycle.has(symbol))) {
    assert.equal(declaration.emitted, false);
    assert.equal(declaration.blocker.policy, "lifecycle-capability-required");
    assert.equal(declaration.stages.generated.status, "blocked-by-policy");
  }
  const publicHeader = await readFile(join(repositoryRoot,
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h"), "utf8");
  assert.doesNotMatch(publicHeader, /(?:log_finalize|profile_initialize|profile_finalize)/);
  assert.equal(report.declarations.filter(({ stages }) => stages.linked.status === "not-yet-tested").length, 0);
  assert.match(report.sourceHashes.ir, /^[a-f0-9]{64}$/);
  assert.match(report.sourceHashes.classification, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(report.artifactHashes).length, report.artifacts.length);
  for (const digest of Object.values(report.artifactHashes)) assert.match(digest, /^[a-f0-9]{64}$/);
});

test("all lifecycle blockers compile from the complete pinned packaged SDK without being executed", async () => {
  const sdkRoot = join(repositoryRoot,
    "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-blocker-audit-"));
  try {
    const object = join(outputDirectory, "blockers.o");
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
      "-isystem", join(sdkRoot, "sdk/include"),
      "-isystem", join(sdkRoot, "include"),
      "-c", "native/dmsdk_scalar_blocker_audit.cpp", "-o", object,
    ]);
    const symbols = run("nm", ["-u", object]);
    for (const leaf of ["dmGraphics8Finalize", "dmLog11LogFinalize", "dmLogFinalize", "ProfileInitialize", "ProfileFinalize"]) {
      assert.match(symbols, new RegExp(leaf), `${leaf} signature reference is absent`);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
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
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-pedantic",
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

test("all 26 wrappers link to pinned host sources, are retained, and pass host behavior checks", async (context) => {
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
      "defold/defold_hermes/src/generated_dmsdk_scalar_profile.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_time.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_trig.cpp",
      "defold/defold_hermes/src/generated_dmsdk_scalar_utf8.cpp",
      "upstream/defold/engine/dlib/src/dlib/trig_lookup.cpp",
      "upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp",
      timeSource,
      "native/dmsdk_scalar_thunks_test.cpp",
    ];
    const executable = join(outputDirectory, "dmsdk-scalar-thunks-test");
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-isystem", join(repositoryRoot, "upstream/defold/engine/dlib/src"),
      ...sources,
      "-o", executable,
    ]);
    assert.equal(run(executable, []).trim(), "dmsdk-scalar-thunks:ok");
    const symbols = run("nm", [executable]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const { wrapper } of report.declarations.filter(({ emitted }) => emitted)) {
      assert.match(symbols, new RegExp(`\\b_?${wrapper}\\b`), `${wrapper} was not retained`);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
