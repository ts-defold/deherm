import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import { renderDmSdkUniversalJsiExactRunner } from "../packages/compiler/src/dmsdk-universal-jsi-exact-runner.mjs";
import { materializeDmSdkUniversalReadyCorpus } from "../packages/compiler/src/dmsdk-universal-ready-corpus.mjs";
import {
  dmSdkUniversalCatalogSha256,
  dmSdkUniversalRecipes,
} from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sdkIrPath = path.join(root, "packages/bindings/generated/defold-sdk-ir.json");
const compiler = process.env.CXX || "clang++";
const policyCatalog = Object.freeze({
  sourceHashes: Object.freeze({ catalog: dmSdkUniversalCatalogSha256 }),
  recipes: dmSdkUniversalRecipes,
});

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

test("compiler JSI exact runner reports callback-only usage without inventing coverage", () => {
  const rendered = renderDmSdkUniversalJsiExactRunner({ verification: {
    schemaVersion: 1,
    catalogSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    provider: { install: "install_exact_provider" },
    driver: { function: "run_native_exact" },
    observations: {
      reset: "reset_exact_observations",
      calls: "exact_call_count",
      failures: "exact_failure_count",
    },
    vectors: [{
      declarationId: "dmsdk:fixture-callback",
      numericId: 7,
      argumentCount: 1,
      wireArguments: [{ slot: 0, tag: "callback" }],
      result: { fakeReturn: { tag: "void", value: 0 } },
    }],
  } });

  assert.equal(rendered.report.vectorCount, 1);
  assert.equal(rendered.report.executableVectorCount, 0);
  assert.equal(rendered.report.unsupported.length, 1);
  assert.equal(rendered.report.unsupported[0].declarationId, "dmsdk:fixture-callback");
  assert.match(rendered.source, /extern "C" int deherm_dmsdk_run_jsi_exact_verification/);
});

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
  const sdkIr = JSON.parse(await readFile(sdkIrPath, "utf8"));
  const corpus = materializeDmSdkUniversalReadyCorpus(
    buildDmSdkCallSymbolIndex(sdkIr, policyCatalog),
    policyCatalog,
  );
  const { generated } = corpus;
  const runner = renderDmSdkUniversalJsiExactRunner(generated, {
    verificationInclude: "materialized.verify.cpp",
  });
  assert.equal(runner.report.transport, "dynamic-hermes-jsi");
  assert.equal(runner.report.vectorCount, 486);
  assert.equal(runner.report.executableVectorCount, 486);
  assert.deepEqual(runner.report.unsupported, []);
  assert.deepEqual(
    generated.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
    corpus.report.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
  );
  assert.match(runner.report.evidenceBoundary, /production DmSdkUniversal JSI host function/);
  assert.match(runner.report.evidenceBoundary, /does not execute Defold implementation semantics/);
  assert.equal(runner.report.verificationManifestSha256, generated.verification.manifestSha256);
  assert.equal(runner.report.verificationInclude, "materialized.verify.cpp");
  assert.equal(runner.report.sourceSha256, createHash("sha256").update(runner.source).digest("hex"));

  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-jsi-exact-"));
  try {
    const sdkRoot = path.join(
      root,
      "upstream/extender/server/app/sdk",
      corpus.report.defoldRevision,
      "defoldsdk",
    );
    const verification = path.join(output, "materialized.verify.cpp");
    const runnerSource = path.join(output, "jsi-exact-runner.cpp");
    const harness = path.join(output, "harness.cpp");
    const executable = path.join(output, "jsi-exact-runner");
    await writeFile(verification, generated.verificationSource);
    await writeFile(runnerSource, runner.source);
    await writeFile(harness, `#include "jsi-exact-runner.cpp"\nint main(){return deherm_dmsdk_run_jsi_exact_verification();}\n`);
    const linkFlags = process.platform === "linux"
      ? ["-pthread", "-ldl"]
      : ["-pthread", "-framework", "CoreFoundation"];
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(root, "upstream/defold/engine/dlib/src"),
      "-isystem", path.join(sdkRoot, "sdk/include"),
      "-isystem", path.join(sdkRoot, "include"),
      "-isystem", path.join(sdkRoot, "ext/include"),
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
