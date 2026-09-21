import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBrowserExactRuntime,
  browserRunnerSource,
  browserSupportSource,
  classifyBrowserExactVectors,
  materializeBrowserExactVectors,
  resolveBrowserExactPrerequisites,
} from "../scripts/check-dmsdk-browser-exact-call.mjs";

test("browser exact-call materialization partitions every canonical vector from wire tags and arity", () => {
  const { materialized, corpus, applicability } = materializeBrowserExactVectors();
  assert.equal(corpus.report.universalReadyCount, 566);
  assert.equal(materialized.verification.vectorCount, 566);
  assert.equal(applicability.vectorCount, 566);
  assert.equal(applicability.applicableCount, 566);
  assert.equal(applicability.unsupportedCount, 0);
  assert.equal(applicability.maximumArgumentCount, 15);
  assert.match(applicability.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    materialized.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
    corpus.report.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
  );
  assert.ok(materialized.verification.vectors.every(({ vectorSha256 }) => /^[0-9a-f]{64}$/.test(vectorSha256)));
  assert.match(materialized.verificationSource, /deherm_dmsdk_universal_ready_provider_install_run_exact_verification/);
  assert.doesNotMatch(materialized.verificationSource, /HEAP(?:8|U8|32|U32)|WebAssembly\.Memory/);

  const unsupportedVerification = structuredClone(materialized.verification);
  unsupportedVerification.vectors.push({
    ...structuredClone(unsupportedVerification.vectors[0]),
    declarationId: "dmsdk:test-unsupported-browser-wire-tag",
    numericId: 0xfffffff0,
    wireArguments: [{ slot: 0, tag: "opaque-record" }],
    argumentCount: 1,
  });
  const unsupported = classifyBrowserExactVectors(unsupportedVerification);
  assert.equal(unsupported.unsupportedCount, 1);
  assert.deepEqual(unsupported.reasonCounts, { "browser-arena-unsupported-argument-tag": 1 });
});

test("browser runner imports the production arena and uses live Emscripten memory with direct exports", async () => {
  const { materialized, applicability } = materializeBrowserExactVectors();
  const support = browserSupportSource(materialized);
  const runner = browserRunnerSource({ materialized, applicability, moduleFile: "dmsdk-exact-module.mjs" });
  assert.match(support, /deherm_dmsdk_browser_exact_preflight/);
  assert.match(support, /std::strcmp/);
  assert.match(support, /\.auxiliary!=deherm_exact_vector_/);
  assert.match(support, /run_exact_verification/);
  assert.match(runner, /createBrowserDmSdkUniversalBridge/);
  assert.match(runner, /module\.wasmMemory instanceof WebAssembly\.Memory/);
  assert.match(runner, /module\.wasmMemory\.buffer!==module\.HEAPU8/);
  assert.match(runner, /module\._malloc/);
  assert.match(runner, /module\._free/);
  assert.match(runner, /_deherm_dmsdk_universal_dispatch/);
  assert.match(runner, /browser scratch release order mismatch/);
  assert.match(runner, /allocationCount!==releaseCount/);
  assert.doesNotMatch(runner, /\bccall\b|\bcwrap\b|\bEmbind\b|\bembind\b/);
  const buildSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../scripts/check-dmsdk-browser-exact-call.mjs", import.meta.url), "utf8"));
  assert.match(buildSource, /-sALLOW_MEMORY_GROWTH=1/);
});

test("browser exact-call runtime evidence must agree with the generated applicability partition", () => {
  const { applicability } = materializeBrowserExactVectors();
  const valid = {
    vectorCount: applicability.applicableCount,
    observationCount: applicability.applicableCount,
    allocationCount: 994,
    releaseCount: 994,
    peakActiveBytes: 240,
    reverseRelease: true,
    liveEmscriptenHeap: true,
  };
  assert.equal(assertBrowserExactRuntime(valid, applicability), valid);
  assert.throws(
    () => assertBrowserExactRuntime({ ...valid, observationCount: valid.observationCount - 1 }, applicability),
    (error) => error.code === "DEHERM_BROWSER_EXACT_RUNTIME_MISMATCH" &&
      error.violations.some(({ name }) => name === "runtime.observationCount"),
  );
  assert.throws(
    () => assertBrowserExactRuntime({ ...valid, releaseCount: valid.releaseCount - 1 }, applicability),
    (error) => error.code === "DEHERM_BROWSER_EXACT_RUNTIME_MISMATCH" &&
      error.violations.some(({ name }) => name === "runtime.releaseCount"),
  );
});

test("browser exact-call prerequisites fail closed when real tools are absent", () => {
  const prerequisites = resolveBrowserExactPrerequisites({
    DEHERM_EMSDK_ROOT: "/definitely/missing/deherm-emsdk",
    DEHERM_CHROME: "/definitely/missing/deherm-chrome",
    EM_CACHE: "/tmp/deherm-unused-em-cache",
  });
  const blockers = new Set(prerequisites.blockers.map(({ code }) => code));
  for (const expected of [
    "pinned-emscripten-revision-mismatch",
    "pinned-emscripten-unavailable",
    "pinned-emscripten-config-unavailable",
    "real-browser-unavailable",
  ]) assert.ok(blockers.has(expected), `missing prerequisite blocker ${expected}`);
});
