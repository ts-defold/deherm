import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractProductionCallbackRegistry,
  materializeScriptBrowserCallbackExactVectors,
  resolveBrowserExactPrerequisites,
} from "../scripts/check-script-browser-callback-exact-call.mjs";

test("browser exact vectors close every emitted direct-memory and callback route", async () => {
  const materialized = await materializeScriptBrowserCallbackExactVectors();
  const browserSummary = materialized.report.summary.browserExact;
  const callbackRouteCount = browserSummary.callbackRouteCount;
  assert.equal(materialized.vectors.length, browserSummary.routeCount);
  assert.equal(materialized.vectors.filter(({ lane }) => lane === "browser-wasm-direct-memory").length,
    browserSummary.routeCount - callbackRouteCount);
  assert.equal(materialized.vectors.filter(({ lane }) => lane === "browser-wasm-callback-registry").length, callbackRouteCount);
  assert.equal(materialized.vectors.reduce((count, vector) => count + vector.callbackSlots.length, 0), browserSummary.callbackCount);
  assert.ok(materialized.vectors.every((vector) =>
    Number.isInteger(vector.stableId) && vector.stableId > 0 &&
    vector.contract &&
    (vector.lane === "browser-wasm-direct-memory" || vector.lane === "browser-wasm-callback-registry")));
  assert.ok(materialized.vectors.filter(({ lane }) => lane === "browser-wasm-callback-registry").every((vector) =>
    vector.callbackSlots.length > 0 &&
    vector.callbackInvocation.argumentValues.length === 2 &&
    vector.callbackInvocation.resultValues.length === 2 &&
    typeof vector.lifecycle.lifetime === "string" &&
    typeof vector.lifecycle.owner === "string"));
  assert.equal(new Set(materialized.vectors.map(({ stableId }) => stableId)).size, browserSummary.routeCount);
  const constantRoutes = materialized.report.routes.filter(({ loweringFamily, applicability }) =>
    loweringFamily === "script-constant" &&
    materialized.report.applicabilityCatalog.lanes[applicability[materialized.report.applicabilityCatalog.targets.indexOf("browser-wasm")]].status === "exercise");
  const constantVectors = materialized.vectors.filter(({ id }) =>
    constantRoutes.some((route) => route.id === id));
  assert.equal(constantVectors.length, constantRoutes.length);
  const constant = constantVectors.find(({ id }) => id === "script:constant.physics.SHAPE_TYPE_MESH");
  assert.ok(constant, "generated browser exact vectors omit a constant route");
  assert.equal(constant.lane, "browser-wasm-direct-memory");
  assert.deepEqual([constant.contract.argumentValues, constant.contract.resultValues], [[], ["num:257"]]);
  assert.match(materialized.manifestSha256, /^[0-9a-f]{64}$/);
});

test("generated browser driver uses the production arena and reverse trampoline", async () => {
  const [driver, library, provider, bootstrap] = await Promise.all([
    readFile("tests/fixtures/generated_script_recording_browser_callback_driver.cpp", "utf8"),
    readFile("tests/fixtures/generated_script_recording_browser_callback_driver.js", "utf8"),
    readFile("tests/fixtures/generated_script_recording_provider.cpp", "utf8"),
    readFile("defold/defold_hermes/lib/web/library_defold_hermes.js", "utf8"),
  ]);
  assert.match(driver, /deherm_recording_browser_run_exact/);
  assert.match(library, /DEFOLD_HERMES_SCRIPT_UNIVERSAL\.install\(\)/);
  assert.match(library, /_deherm_recording_browser_invoke_callback/);
  assert.match(library, /_deherm_recording_browser_release_callbacks/);
  assert.match(library, /callback token survived finalization/);
  assert.match(library, /registry capacity did not fail closed/);
  assert.match(library, /runRoute\(reentrantTargetOrdinal\)/);
  assert.match(library, /registry\.reset\(\)/);
  assert.match(library, /_deherm_recording_browser_handle_release_count/);
  assert.match(library, /_deherm_recording_browser_drain_handle_releases/);
  assert.match(library, /releasedHandles!==vector\[12\]/);
  assert.match(library, /result handles; expected/);
  assert.doesNotMatch(library, /ccall|cwrap|Embind|embind/);
  assert.match(provider, /std::array<ScriptCallback,/);
  assert.match(provider, /callbacks\.callbacks\[callbacks\.count\+\+\] = \*callback/);
  assert.match(provider, /gBrowserHandleReleaseCount/);
  assert.match(provider, /browser released the wrong handle identity/);
  assert.doesNotMatch(provider, /void Release\(void\*, ScriptHandleKind, uint32_t, uint64_t\) noexcept \{\}/);
  assert.doesNotMatch(provider, /std::array<ScriptCallback\*,/);
  const registry = extractProductionCallbackRegistry(bootstrap);
  assert.match(registry, /\$DEFOLD_HERMES_WEB_CALLBACKS/);
  assert.match(registry, /Browser callback pool is exhausted/);
  assert.match(registry, /this\.runtime = \(this\.runtime \+ 1\)/);
});

test("browser runtime acceptance waits for clean exit and checks failure before success", async () => {
  const runner = await readFile("scripts/check-script-browser-callback-exact-call.mjs", "utf8");
  assert.match(runner, /Module\.onExit/);
  assert.match(runner, /DEHERM_SCRIPT_BROWSER_EXACT_EXIT status=0/);
  const waitBody = runner.slice(runner.indexOf("await waitFor"), runner.indexOf("what: \"the real script callback Wasm marker\""));
  assert.ok(waitBody.indexOf("DEHERM_SCRIPT_BROWSER_EXACT_FAIL") < waitBody.indexOf("const successes"));
  assert.match(runner, /lateFailure/);
});

test("script callback browser prerequisites fail closed without real tools", () => {
  const prerequisites = resolveBrowserExactPrerequisites({
    DEHERM_EMSDK_ROOT: "/definitely/missing/deherm-emsdk",
    DEHERM_CHROME: "/definitely/missing/deherm-chrome",
    EM_CACHE: "/tmp/deherm-unused-script-callback-em-cache",
  });
  const blockers = new Set(prerequisites.blockers.map(({ code }) => code));
  assert.ok(blockers.has("pinned-emscripten-unavailable"));
  assert.ok(blockers.has("real-browser-unavailable"));
});
