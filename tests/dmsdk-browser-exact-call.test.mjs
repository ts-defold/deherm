import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeBrowserExactVectors,
  resolveBrowserExactPrerequisites,
} from "../scripts/check-dmsdk-browser-exact-call.mjs";

test("browser exact-call materialization consumes real dmSDK recipes and owns no mock-memory lane", () => {
  const { materialized, corpus } = materializeBrowserExactVectors();
  assert.equal(corpus.report.universalReadyCount, 486);
  assert.equal(materialized.verification.vectorCount, 486);
  assert.deepEqual(
    materialized.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
    corpus.report.verification.vectors.map(({ vectorSha256 }) => vectorSha256),
  );
  assert.ok(materialized.verification.vectors.every(({ vectorSha256 }) => /^[0-9a-f]{64}$/.test(vectorSha256)));
  assert.match(materialized.verificationSource, /deherm_dmsdk_universal_ready_provider_install_run_exact_verification/);
  assert.doesNotMatch(materialized.verificationSource, /HEAP(?:8|U8|32|U32)|WebAssembly\.Memory/);
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
