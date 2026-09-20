import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeDmSdkUsages } from "../packages/compiler/src/dmsdk-universal-materializer.mjs";
import {
  dmSdkUniversalCatalogSha256,
  dmSdkUniversalRecipes,
} from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";
import { renderDmSdkUniversalJsiExactRunner } from "../scripts/lib/dmsdk-universal-jsi-exact-runner.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json");
const compiler = process.env.CXX || "clang++";
const policyCatalog = Object.freeze({
  sourceHashes: Object.freeze({ catalog: dmSdkUniversalCatalogSha256 }),
  recipes: dmSdkUniversalRecipes,
});

function recipe(report, symbol, predicate = () => true) {
  const matches = report.recipes.filter((item) => item.symbol === symbol && predicate(item));
  assert.equal(matches.length, 1, `expected one recipe for ${symbol}, got ${matches.length}`);
  return matches[0];
}

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

async function packagedHermesArchive() {
  const platform = `${process.platform}-${process.arch}`;
  const relative = {
    "darwin-arm64": "defold/defold_hermes/lib/arm64-osx/libhermes.a",
    "linux-x64": "defold/defold_hermes/lib/x86_64-linux/libhermes.a",
  }[platform];
  if (!relative) return null;
  const absolute = path.join(root, relative);
  try {
    await stat(absolute);
    return absolute;
  } catch {
    return null;
  }
}

test("dynamic Hermes JSI runner executes exact dmSDK vectors through the production host function", async (context) => {
  const hermesArchive = await packagedHermesArchive();
  if (!hermesArchive) {
    if (process.env.DEHERM_REQUIRE_PACKAGED_HERMES === "1") {
      assert.fail(`required packaged Hermes archive is missing for ${process.platform}-${process.arch}`);
    }
    context.skip(`no packaged Hermes archive for ${process.platform}-${process.arch}`);
    return;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const boolean = recipe(report, "dmUtf8::IsWhiteSpace");
  const floating = recipe(report, "dmTrigLookup::Cos");
  const pointerHandle = recipe(report, "ConfigFileGetFloat");
  const constructor = recipe(report, "dmArray::dmArray::dmArray<T>", (item) => item.line === 101);
  const clamp = recipe(report, "dmMath::Clamp");
  const callback = recipe(report, "dmLog::RegisterLogListener");
  const i32 = (name, position) => ({
    name,
    position,
    nativeType: "int32_t",
    direction: "value",
    shape: { kind: "scalar", name: "i32" },
    requirements: [],
  });
  const generated = materializeDmSdkUsages([
    {
      declarationId: boolean.declarationId,
      wrapper: "jsi_verify_bool",
      acknowledgements: { generatedAdapterBypass: { reason: "exercise universal JSI transport", evidence: "real Hermes exact-call runner" } },
    },
    {
      declarationId: floating.declarationId,
      wrapper: "jsi_verify_float",
      acknowledgements: { generatedAdapterBypass: { reason: "exercise universal JSI transport", evidence: "real Hermes exact-call runner" } },
    },
    {
      declarationId: pointerHandle.declarationId,
      wrapper: "jsi_verify_pointer_handle",
      acknowledgements: { recordLayout: { reason: "opaque handle remains an identity token", evidence: "real Hermes address-cell round trip without dereference" } },
    },
    {
      declarationId: constructor.declarationId,
      wrapper: "jsi_verify_constructor",
      receiverCppType: "dmArray<uint32_t>",
      typeSubstitutions: { T: "uint32_t" },
      acknowledgements: { outStorageInitializationFailure: { reason: "fixture owns aligned receiver storage", evidence: "real Hermes exact-call runner verifies receiver and argument order" } },
    },
    {
      declarationId: clamp.declarationId,
      wrapper: "jsi_verify_template",
      templateArguments: ["int32_t"],
      parameters: [i32("value", 0), i32("minimum", 1), i32("maximum", 2)],
      resultCppType: "int32_t",
      resultShape: { kind: "scalar", name: "i32" },
    },
    {
      declarationId: callback.declarationId,
      wrapper: "jsi_verify_callback",
      callbackTrampolines: { 0: "native_log_listener" },
      acknowledgements: { callbackTrampoline: { reason: "retain the native callback contract", evidence: "runner report must keep the unsupported JSI wire boundary explicit" } },
    },
  ], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  const runner = renderDmSdkUniversalJsiExactRunner(generated);
  assert.equal(runner.report.transport, "dynamic-hermes-jsi");
  assert.equal(runner.report.vectorCount, 6);
  assert.equal(runner.report.executableVectorCount, 5);
  assert.deepEqual(runner.report.unsupported, [{
    declarationId: callback.declarationId,
    numericId: callback.numericId,
    reason: "production JSI encoder has no callback wire-value representation",
  }]);
  assert.match(runner.report.evidenceBoundary, /production DmSdkUniversal JSI host function/);
  assert.match(runner.report.evidenceBoundary, /does not execute Defold implementation semantics/);
  assert.equal(runner.report.verificationManifestSha256, generated.verification.manifestSha256);
  assert.equal(runner.report.sourceSha256, createHash("sha256").update(runner.source).digest("hex"));

  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-jsi-exact-"));
  try {
    const verification = path.join(output, "materialized.verify.cpp");
    const runnerSource = path.join(output, "jsi-exact-runner.cpp");
    const harness = path.join(output, "harness.cpp");
    const executable = path.join(output, "jsi-exact-runner");
    await writeFile(verification, generated.verificationSource);
    await writeFile(runnerSource, runner.source);
    await writeFile(harness, `#include "materialized.verify.cpp"\n#include "jsi-exact-runner.cpp"\nint main(){return deherm_dmsdk_run_jsi_exact_verification();}\n`);
    const linkFlags = process.platform === "linux"
      ? ["-pthread", "-ldl"]
      : ["-pthread", "-framework", "CoreFoundation"];
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(root, "upstream/defold/engine/dlib/src"),
      "-isystem", path.join(root, "upstream/hermes/API"),
      "-isystem", path.join(root, "upstream/hermes/API/jsi"),
      "-isystem", path.join(root, "upstream/hermes/public"),
      "defold/defold_hermes/src/generated_dmsdk_universal.cpp",
      "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp",
      harness,
      hermesArchive,
      ...linkFlags,
      "-o", executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
