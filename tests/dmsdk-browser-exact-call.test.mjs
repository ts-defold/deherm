import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeBrowserExactVectors,
  resolveBrowserExactPrerequisites,
} from "../scripts/check-dmsdk-browser-exact-call.mjs";

test("browser exact-call materialization consumes real dmSDK recipes and owns no mock-memory lane", () => {
  const { materialized, selections } = materializeBrowserExactVectors();
  assert.equal(selections.length, 4);
  assert.equal(materialized.verification.vectorCount, selections.length);
  assert.deepEqual(
    materialized.verification.vectors.map(({ declarationId }) => declarationId),
    selections.map(({ recipe }) => recipe.declarationId),
  );
  assert.ok(materialized.verification.vectors.every(({ vectorSha256 }) => /^[0-9a-f]{64}$/.test(vectorSha256)));
  assert.match(materialized.verificationSource, /deherm_browser_exact_install_run_exact_verification/);
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
