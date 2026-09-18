import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateScriptCallbackLifecycle, loadScriptCallbackLifecycleInputs } from "../scripts/generate-script-callback-lifecycle.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("callback lifecycle generator covers the exact classified family with bounded support", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-callback-lifecycle.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const report = JSON.parse(await readFile(new URL("bindings/generated/defold-script-callback-lifecycle.json", root), "utf8"));
  assert.equal(report.routeCount, 25);
  assert.equal(report.registryEligibleRouteCount, 23);
  assert.equal(report.higherOrderClosureRouteCount, 2);
  assert.deepEqual(report.lifetimeCounts, { "higher-order-closure": 2, "one-shot": 14, "persistent-replaceable": 5, "terminal-event": 4 });
  assert.equal(new Set(report.routes.map(({ id }) => id)).size, 25);
  assert.equal(new Set(report.routes.map(({ stableId }) => stableId)).size, 25);
  assert.equal(report.routes.every(({ id, stableId }) => stableId === stableBindingId(id)), true);
  assert.equal(report.routes.filter(({ lifetime }) => lifetime === "higher-order-closure").every(({ registryEligible }) => !registryEligible), true);
  assert.match(report.coverageClaim, /no route-specific engine callback adapter/);
  assert.match(report.targetSupport.nativeDynamicHermes, /metadata-only/);
  assert.match(report.inputEvidence.aggregateInputSha256, /^[0-9a-f]{64}$/);
});

test("callback lifecycle generation rejects source, census, and callback-shape drift", async () => {
  const inputs = await loadScriptCallbackLifecycleInputs();
  const staleSource = structuredClone(inputs);
  const [path, text] = staleSource.sourceTexts.entries().next().value;
  staleSource.sourceTexts.set(path, `${text}\n`);
  assert.throws(() => generateScriptCallbackLifecycle(staleSource), /source hash drifted/);

  const missingPolicy = structuredClone(inputs);
  const policy = JSON.parse(missingPolicy.policyText);
  policy.routes.pop();
  missingPolicy.policyText = JSON.stringify(policy);
  assert.throws(() => generateScriptCallbackLifecycle(missingPolicy), /route count is stale/);

  const shapeDrift = structuredClone(inputs);
  const patterns = JSON.parse(shapeDrift.patternsText);
  patterns.bindings.find(({ id }) => id === "script:go.animate").parameterCodecs.find(({ name }) => name === "complete_function").codecs = ["nil"];
  shapeDrift.patternsText = JSON.stringify(patterns);
  assert.throws(() => generateScriptCallbackLifecycle(shapeDrift), /callback-coded/);
});

test("generated native route table and TypeScript surface remain metadata-only", async () => {
  const [header, source, target] = await Promise.all([
    readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_callback_lifecycle.hpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/src/generated_script_callback_lifecycle.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/callback-lifecycle.ts", root), "utf8")
  ]);
  assert.match(header, /kRouteCount = 25/);
  assert.match(header, /registryEligible/);
  assert.match(source, /Lifetime::kPersistentReplaceable/);
  assert.match(source, /find\(uint32_t stableId\)/);
  assert.match(target, /scriptCallbackLifecycleRouteCount = 25/);
  assert.match(target, /Metadata only/);
  assert.doesNotMatch(target, /new Function|eval\(/);
});

test("native callback lifecycle registry proves release, terminal, replacement, reentrancy, and teardown rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-callback-lifecycle-"));
  try {
    const executable = join(directory, "script-callback-lifecycle-test");
    execFileSync(process.env.CXX || "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      "-Idefold/defold_hermes/include",
      "native/script_callback_lifecycle_test.cpp",
      "defold/defold_hermes/src/callback_lifecycle_registry.cpp",
      "defold/defold_hermes/src/generated_script_callback_lifecycle.cpp",
      "-o", executable
    ], { cwd: root, stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(), "script-callback-lifecycle:ok allocations:0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
