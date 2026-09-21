import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractProductionCallbackRegistry,
  materializeScriptBrowserCallbackExactVectors,
  resolveBrowserExactPrerequisites,
} from "../scripts/check-script-browser-callback-exact-call.mjs";

test("browser callback exact vectors close every generated callback-registry route", async () => {
  const materialized = await materializeScriptBrowserCallbackExactVectors();
  assert.equal(materialized.vectors.length, 23);
  assert.equal(materialized.vectors.reduce((count, vector) => count + vector.callbackSlots.length, 0), 23);
  assert.ok(materialized.vectors.every((vector) =>
    Number.isInteger(vector.stableId) && vector.stableId > 0 &&
    vector.callbackSlots.length > 0 &&
    vector.callbackInvocation.argumentValues.length === 2 &&
    vector.callbackInvocation.resultValues.length === 2 &&
    typeof vector.lifecycle.lifetime === "string" &&
    typeof vector.lifecycle.owner === "string"));
  assert.equal(new Set(materialized.vectors.map(({ stableId }) => stableId)).size, 23);
  assert.match(materialized.manifestSha256, /^[0-9a-f]{64}$/);
});

test("generated callback driver uses the production arena and reverse trampoline", async () => {
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
  assert.match(library, /runRoute\(1\)/);
  assert.match(library, /registry\.reset\(\)/);
  assert.doesNotMatch(library, /ccall|cwrap|Embind|embind/);
  assert.match(provider, /std::array<ScriptCallback,/);
  assert.match(provider, /callbacks\.callbacks\[callbacks\.count\+\+\] = \*callback/);
  assert.doesNotMatch(provider, /std::array<ScriptCallback\*,/);
  const registry = extractProductionCallbackRegistry(bootstrap);
  assert.match(registry, /\$DEFOLD_HERMES_WEB_CALLBACKS/);
  assert.match(registry, /Browser callback pool is exhausted/);
  assert.match(registry, /this\.runtime = \(this\.runtime \+ 1\)/);
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
