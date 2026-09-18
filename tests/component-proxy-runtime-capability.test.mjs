import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const reportPath = "packages/bindings/generated/defold-component-proxy-runtime-capability.json";
const headerPath = "defold/defold_hermes/include/defold_hermes/generated_component_proxy_capability.hpp";

test("component proxy runtime gate regenerates deterministically", () => {
  const result = spawnSync("node", ["scripts/generate-component-proxy-runtime-capability.mjs", "--check"], {
    cwd: process.cwd(), encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("all generated Lua ABI methods have stage-qualified native provider evidence", async () => {
  const [report, manifest, extension] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile("tests/fixtures/component-proxy/expected/manifest.json", "utf8").then(JSON.parse),
    readFile("defold/defold_hermes/src/extension.cpp", "utf8")
  ]);
  assert.equal(report.capabilityState, "native-provider-capability-present");
  assert.equal(report.harnessEvidenceState, "native-lua-and-dynamic-hermes-harness-proven");
  assert.equal(report.runtimeConformant, false);
  assert.deepEqual(report.requiredLuaMethods, manifest.proxyRuntimeCapability.requiredMethods);
  assert.deepEqual(report.providerInstalledMethods, report.requiredLuaMethods);
  assert.deepEqual(report.adapterExecutableMethods, report.requiredLuaMethods);
  assert.deepEqual(report.packagedDefoldEngineVerifiedMethods, []);
  assert.match(extension, /registerUnavailableLuaApi/);
  assert.match(extension, /gComponentLuaRuntime->registerLuaApi/);
  for (const method of report.requiredLuaMethods) {
    assert.match(report.methodDisposition[method].nativeDynamicHermes, /harness-proven-packaged-engine-unverified/);
    assert.match(report.methodDisposition[method].nativeStaticHermes, /^fail-closed/);
    assert.match(report.methodDisposition[method].html5BrowserHost, /^fail-closed/);
  }
  assert.equal(report.evidence.packagedDefoldEngine, "unverified");
});

test("the generated native gate header compiles and exposes every method once", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const source = [
    `#include <defold_hermes/generated_component_proxy_capability.hpp>`,
    `#include <cstring>`,
    `int main() {`,
    `  static_assert(defold_hermes::component_proxy::kRequiredLuaMethods.size() == ${report.requiredLuaMethods.length});`,
    `  for (size_t i = 0; i < defold_hermes::component_proxy::kRequiredLuaMethods.size(); ++i)`,
    `    for (size_t j = i + 1; j < defold_hermes::component_proxy::kRequiredLuaMethods.size(); ++j)`,
    `      if (std::strcmp(defold_hermes::component_proxy::kRequiredLuaMethods[i], defold_hermes::component_proxy::kRequiredLuaMethods[j]) == 0) return 2;`,
    `  static_assert(!defold_hermes::component_proxy::kPackagedDefoldEngineVerified);`,
    `  return defold_hermes::component_proxy::kCapabilityState == "native-provider-capability-present" &&`,
    `      defold_hermes::component_proxy::kHarnessEvidenceState == "native-lua-and-dynamic-hermes-harness-proven" ? 0 : 3;`,
    `}`
  ].join("\n");
  const compile = spawnSync("clang++", [
    "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
    "-Idefold/defold_hermes/include", "-x", "c++", "-", "-o", "/tmp/deherm-component-proxy-capability-test"
  ], { cwd: process.cwd(), encoding: "utf8", input: source });
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync("/tmp/deherm-component-proxy-capability-test", [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("the report enumerates remaining runtime capabilities without erasing harness evidence", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.blockers, []);
  assert.equal(report.implementedCapabilities.compilerRegistry, "deterministic-full-inventory-generated-and-bundled");
  assert.match(report.implementedCapabilities.scriptAdapterContextSelection, /fixed-depth-16/);
  assert.match(report.implementedCapabilities.eventCodec, /256-fields-256-elements-depth-8/);
  assert.match(report.contexts["gui-scene"], /harness-proven-packaged-engine-unverified/);
  assert.match(report.contexts["render-instance+graphics"], /harness-proven-packaged-engine-unverified/);
});
