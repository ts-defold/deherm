import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../scripts/generate-dmsdk-borrowed-handle-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json");
const sdk = path.join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx = process.env.CXX || "clang++";
const cc = process.env.CC || "clang";
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
const includes = [
  `-I${path.join(root, "defold/defold_hermes/include")}`,
  "-isystem", path.join(sdk, "sdk/include"),
  "-isystem", path.join(sdk, "include"),
];

test("borrowed-handle census is independently structural, exhaustive, and provider-gated", async () => {
  const [report, shapes, policy] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json"), "utf8").then(JSON.parse),
  ]);
  const candidates = shapes.rows.filter(({ tranche }) => tranche === "borrowed-handle-consumers");
  const generated = candidates.filter((row) =>
    policy.selection.resultRoles.includes(row.result.role) &&
    row.parameters.some(({ role }) => role.startsWith("handle:")) &&
    row.parameters.every(({ role }) => policy.selection.parameterRolePrefixes.some((prefix) => role.startsWith(prefix))) &&
    policy.selection.rejectedFamilies.every((family) => !row.families.includes(family))
  );
  assert.equal(candidates.length, 348);
  assert.equal(generated.length, 82);
  assert.deepEqual(report.coverage, {
    candidates: 348,
    generated: 82,
    blocked: 266,
    cAbiGenerated: 82,
    dynamicHermesJsiGenerated: 82,
    staticHermesGenerated: 82,
    browserDirectMemoryGenerated: 82,
    typescriptGenerated: 82,
    pinnedHeaderSignatureCompiled: 82,
    fakeProviderHostRuntimeTested: 82,
    packagedEngineRuntimeVerified: 0,
    warmedDispatchIterations: 100000,
    warmedDispatchObservedCppAllocations: 0,
  });
  assert.equal(report.declarations.length, candidates.length);
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, candidates.length);
  assert.equal(report.handleKinds.length, 32);
  assert.equal(report.abi.maxArguments, 2);
  assert.match(report.selector, /no symbol allowlist/);
  assert.equal(Object.hasOwn(policy, "entries"), false);
  for (const row of report.declarations.filter(({ disposition }) => disposition === "blocked")) {
    assert.ok(row.blockers.some((token) => token.includes("ownership-nullability-lifetime")), row.id);
    assert.ok(row.blockers.some((token) => token.includes("thread-affinity")), row.id);
    assert.ok(row.blockers.some((token) => token.includes("symbol-linkage")), row.id);
  }
  for (const row of report.declarations.filter(({ disposition }) => disposition !== "blocked")) {
    assert.deepEqual(row.resolvedPolicies, policy.providerContract);
    assert.match(row.stages.engine, /not-claimed/);
    assert.ok(row.engineProviderBlockers.includes("handle-ownership-nullability-lifetime-unresolved"));
    assert.ok(row.engineProviderBlockers.includes("call-thread-affinity-unresolved"));
  }
});

test("borrowed-handle generation is clean-room deterministic and rejects census drift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-generate-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-borrowed-handle-bindings.mjs", "--output-root", directory]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json"]) {
      assert.equal(await readFile(path.join(directory, artifact), "utf8"), await readFile(path.join(root, artifact), "utf8"), artifact);
    }
    const contents = {
      ir: await readFile(path.join(root, report.sources.ir), "utf8"),
      shapes: await readFile(path.join(root, report.sources.shapes), "utf8"),
      projection: await readFile(path.join(root, report.sources.projection), "utf8"),
      policy: await readFile(path.join(root, report.sources.policy), "utf8"),
    };
    const changed = JSON.parse(contents.policy);
    changed.expectedCoverage.generated += 1;
    await assert.rejects(() => build({ ...contents, policy: JSON.stringify(changed) }), /census changed/);
    await assert.rejects(() => build({ ...contents, ir: `${contents.ir}\n` }), /IR provenance mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all 82 selected signatures compile against the complete pinned SDK projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-headers-"));
  try {
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-DDLIB_LOG_DOMAIN=\"deherm\"", ...includes, "-c", "native/generated_dmsdk_borrowed_handle_header_audit.cpp", "-o", path.join(directory, "audit.o")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("C ABI, Dynamic Hermes adapter, browser descriptor, and TypeScript projections compile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-targets-"));
  try {
    run(cc, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, "-c", "native/dmsdk_borrowed_handle_c_header_test.c", "-o", path.join(directory, "header.o")]);
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, "-c", "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp", "-o", path.join(directory, "runtime.o")]);
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, `-I${path.join(root, "upstream/hermes/API")}`, "-c", "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_jsi.cpp", "-o", path.join(directory, "jsi.o")]);
    run(process.execPath, ["--check", "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js"]);
    const tsc = path.join(root, "node_modules/.bin/tsc");
    const flags = ["--ignoreConfig", "--noEmit", "--strict", "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck"];
    run(tsc, [...flags, "packages/sdk/src/generated/dmsdk/borrowed-handle.ts"]);
    run(tsc, [...flags, "packages/static-hermes/src/globals.d.ts", "packages/static-hermes/src/generated/dmsdk-borrowed-handle.ts"]);
    const browser = await readFile(path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js"), "utf8");
    assert.match(browser, /slotBytes:8,maxArguments:2,resultBytes:8/);
    assert.match(browser, /callRaw:function\(id,argumentsPointer,argumentCount,resultPointer\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake-provider host bridge links, enforces guards, sanitizes, and allocates zero when warm", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-runtime-"));
  try {
    const executable = path.join(directory, "runtime");
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", ...includes, "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp", "native/dmsdk_borrowed_handle_runtime_test.cpp", "-o", executable]);
    assert.equal(run(executable, [], { env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } }).trim(), "dmsdk-borrowed-handle:ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated runtime remains allocation-free and does not embed dmSDK symbol calls", async () => {
  const runtime = await readFile(path.join(root, "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp"), "utf8");
  assert.doesNotMatch(runtime, /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
  assert.doesNotMatch(runtime, /\b(?:dmGraphics|dmGameObject|dmResource)::[A-Za-z0-9_]+\s*\(/);
  assert.match(runtime, /validate_handle/);
  assert.match(runtime, /is_current_thread/);
});
