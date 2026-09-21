import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { emitDmSdkUniversalStaticFrame } from "../packages/compiler/src/dmsdk-universal-static-frame.mjs";
import {
  classifyPackageInventory,
  packageInventoryPaths,
  stableGeneratedExceptions,
  verifyStableGeneratedExceptionBytes
} from "../scripts/check-package-revision-boundary.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checker = path.join(repositoryRoot, "scripts", "check-package-revision-boundary.mjs");

test("package revision boundary groups every fixed-revision output family", () => {
  const report = classifyPackageInventory([{ files: [
    { path: "package/packages/bindings/generated/defold-policy-index.json" },
    { path: "packages/bindings/generated/policy/v1/object/abc.json" },
    { path: "packages/bindings/generated/defold-script-api-ir.json" },
    { path: "packages/bindings/lua-compat.json" },
    { path: "packages/bindings/overrides/script-overload-dispatch.json" },
    { path: "packages/bindings/probes/defold-script-real-engine-probes.json" },
    { path: "packages/sdk/src/generated/script/types.ts" },
    { path: "packages/abi/src/generated/layouts.ts" },
    { path: "packages/static-hermes/src/generated/script-vmath.ts" },
    { path: "packages/compiler/src/generated/dmsdk-universal-recipes.mjs" },
    { path: "packages/toolchains/defold-bundle-targets.json" },
    { path: "defold/defold_hermes/include/libhermesvm-config.h" },
    { path: "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp" },
    { path: "defold/defold_hermes/src/generated_script_handle_lowering.cpp" },
    { path: "defold/defold_hermes/lib/web/generated_script_universal_value.js" }
  ] }]);

  assert.equal(report.ok, false);
  assert.deepEqual(Object.fromEntries(Object.entries(report.forbidden).map(([group, files]) => [group, files.length])), {
    "bundled-policy": 2,
    "revision-binding-surface": 1,
    "legacy-fixed-binding-declarations": 1,
    "revision-policy-overrides": 1,
    "revision-evidence-probes": 1,
    "revision-sdk-output": 1,
    "revision-abi-output": 1,
    "revision-static-hermes-output": 1,
    "revision-compiler-catalog": 1,
    "revision-toolchain-surface": 1,
    "target-native-config": 1,
    "revision-native-header-output": 1,
    "revision-native-source-output": 1,
    "revision-web-output": 1
  });
  assert.equal(report.summary.forbiddenFileCount, 15);
});

test("generated-looking exceptions are exact and carry package-side provenance", () => {
  const exceptionPaths = Object.keys(stableGeneratedExceptions);
  const nearMiss = "defold/defold_hermes/src/generated_dmsdk_universal_static_frame_extra.cpp";
  const report = classifyPackageInventory([
    ...exceptionPaths,
    nearMiss,
    "packages/compiler/src/policy-surface-materializer.mjs",
    "packages/toolchains/host-compilers.json",
    "packages/sdk/src/address.ts",
    "defold/defold_hermes/src/runtime.cpp"
  ]);

  assert.deepEqual(report.forbidden["revision-native-source-output"], [nearMiss]);
  assert.equal(report.allowed.provenExceptions.length, exceptionPaths.length);
  for (const exception of report.allowed.provenExceptions) {
    assert.equal(typeof exception.provenance, "string");
    assert.ok(exception.provenance.length > 20);
  }
  assert.deepEqual(report.allowed.groups["compiler-realizer"], ["packages/compiler/src/policy-surface-materializer.mjs"]);
  assert.deepEqual(report.allowed.groups["toolchain-artifact"], ["packages/toolchains/host-compilers.json"]);
});

test("compiler-owned static-frame exceptions reproduce from their package emitter", async () => {
  const emitted = emitDmSdkUniversalStaticFrame();
  const expected = new Map([
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h", emitted.header],
    ["defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp", emitted.source],
    ["packages/static-hermes/src/generated/dmsdk-universal.ts", emitted.staticHermes]
  ]);
  for (const [relative, source] of expected) {
    assert.equal(await readFile(path.join(repositoryRoot, relative), "utf8"), source, relative);
  }
});

test("other generated exceptions prove that their inputs are package-owned", async () => {
  const buildConfig = await readFile(path.join(
    repositoryRoot,
    "defold/defold_hermes/include/defold_hermes/generated_build_config.h"
  ), "utf8");
  assert.match(buildConfig, /This is the skeleton the package ships: it defines nothing/u);

  const componentGenerator = await readFile(path.join(
    repositoryRoot,
    "scripts/generate-component-proxy-runtime-capability.mjs"
  ), "utf8");
  const inputs = componentGenerator.slice(
    componentGenerator.indexOf("const inputs ="),
    componentGenerator.indexOf("const outputs =")
  );
  assert.doesNotMatch(inputs, /packages\/bindings\/generated|upstream\//u);
  assert.match(inputs, /packages\/compiler\/src\/component-proxy-generator\.mjs/u);
  assert.match(inputs, /defold\/defold_hermes\/src\/runtime\.cpp/u);
});

test("every stable generated exception matches its package-owned emitter", async () => {
  const report = await verifyStableGeneratedExceptionBytes(repositoryRoot);
  assert.deepEqual(report.checked.sort(), Object.keys(stableGeneratedExceptions).sort());
});

test("fixture CLI exits nonzero with a machine-readable grouped report", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-package-boundary-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "inventory.json");
  await writeFile(inventory, `${JSON.stringify({ files: [
    { path: "packages/bindings/generated/defold-sdk-ir.json" },
    { path: "packages/compiler/src/api-policy.mjs" }
  ] })}\n`);

  const failed = spawnSync(process.execPath, [checker, "--inventory", inventory], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.kind, "deherm.package-revision-boundary-report");
  assert.equal(report.ok, false);
  assert.deepEqual(report.forbidden["revision-binding-surface"], ["packages/bindings/generated/defold-sdk-ir.json"]);

  await writeFile(inventory, `${JSON.stringify([
    "packages/compiler/src/api-policy.mjs",
    "packages/toolchains/host-compilers.json"
  ])}\n`);
  const passed = spawnSync(process.execPath, [checker, "--inventory", inventory], { encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).ok, true);
});

test("inventory normalization is deterministic and rejects missing paths", () => {
  assert.deepEqual(packageInventoryPaths(["./b", "package/a", "b"]), ["a", "b"]);
  assert.throws(() => packageInventoryPaths({ files: [{}] }), /without a non-empty path/u);
  const report = classifyPackageInventory(["safe/file.txt", "unsafe/../escape.txt", "/absolute.txt"]);
  assert.deepEqual(report.forbidden["invalid-inventory-path"], ["/absolute.txt", "unsafe/../escape.txt"]);
});
