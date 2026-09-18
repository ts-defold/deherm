import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json");
const sdk = path.join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx = process.env.CXX || "clang++";
const cc = process.env.CC || "clang";
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
const includes = [
  `-I${path.join(root, "defold/defold_hermes/include")}`,
  "-isystem", path.join(sdk, "sdk/include"),
  "-isystem", path.join(sdk, "include"),
];

function selected(row, policy) {
  return policy.selection.resultRolePrefixes.some((prefix) => row.result.role.startsWith(prefix)) &&
    row.parameters.every((parameter) => parameter.direction === "value"
      ? policy.selection.valueRolePrefixes.some((prefix) => parameter.role.startsWith(prefix))
      : policy.selection.pointerDirections.includes(parameter.direction) &&
        policy.selection.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix))) &&
    row.parameters.some((parameter) => ["out", "inout"].includes(parameter.direction) &&
      policy.selection.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix))) &&
    policy.selection.rejectedFamilies.every((family) => !row.families.includes(family));
}

test("scratch scalar-out census is independent, exhaustive, and symbol-agnostic", async () => {
  const [report, shapes, policy] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.join(root, "bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "bindings/overrides/dmsdk-scratch-scalar-out-bindings.json"), "utf8").then(JSON.parse),
  ]);
  const candidates = shapes.rows.filter(({ tranche }) => tranche === "scratch-out-parameters");
  const generated = candidates.filter((row) => selected(row, policy));
  assert.equal(candidates.length, 79);
  assert.equal(generated.length, 7);
  assert.deepEqual(report.coverage, {
    candidates: 79,
    generated: 7,
    blocked: 72,
    cAbiGenerated: 7,
    dynamicHermesJsiGenerated: 7,
    staticHermesGenerated: 7,
    browserDirectMemoryGenerated: 7,
    typescriptGenerated: 7,
    pinnedHeaderSignatureCompiled: 7,
    fakeProviderHostRuntimeTested: 7,
    packagedEngineRuntimeVerified: 0,
    warmedDispatchIterations: 100000,
    warmedDispatchObservedCppAllocations: 0,
  });
  assert.equal(report.declarations.length, candidates.length);
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 79);
  assert.equal(report.abi.maxParameters, 4);
  assert.equal(report.abi.maxOutputs, 1);
  assert.equal(report.handleKinds.length, 4);
  assert.match(report.selector, /no symbol allowlist/);
  assert.equal(Object.hasOwn(policy, "entries"), false);
  for (const row of report.declarations.filter(({ disposition }) => disposition === "blocked")) {
    assert.ok(row.blockers.length > 0, row.id);
    assert.ok(row.blockers.some((token) => /unsupported|unresolved|unverified|required/.test(token)), row.id);
  }
  for (const row of report.declarations.filter(({ disposition }) => disposition !== "blocked")) {
    assert.deepEqual(row.resolvedPolicies, policy.storageContract);
    assert.match(row.stages.engine, /not-claimed/);
    assert.ok(row.engineProviderBlockers.includes("native-symbol-linkage-unverified"));
    assert.ok(row.engineProviderBlockers.includes("enum-domain-to-native-success-policy-unresolved"));
  }
});

test("scratch scalar-out generation is clean-room deterministic and rejects drift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-generate-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs", "--output-root", directory]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [...report.artifacts, "bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json"]) {
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

test("all seven selected signatures compile against the pinned SDK projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-headers-"));
  try {
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-DDLIB_LOG_DOMAIN=\"deherm\"", ...includes, "-c", "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp", "-o", path.join(directory, "audit.o")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("C ABI, Dynamic Hermes, Static Hermes, browser, and TypeScript projections compile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-targets-"));
  try {
    run(cc, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, "-c", "native/dmsdk_scratch_scalar_out_c_header_test.c", "-o", path.join(directory, "header.o")]);
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, "-c", "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp", "-o", path.join(directory, "runtime.o")]);
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, `-I${path.join(root, "upstream/hermes/API")}`, "-c", "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_jsi.cpp", "-o", path.join(directory, "jsi.o")]);
    run(process.execPath, ["--check", "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js"]);
    const tsc = path.join(root, "node_modules/.bin/tsc");
    const flags = ["--ignoreConfig", "--noEmit", "--strict", "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck"];
    run(tsc, [...flags, "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts"]);
    run(tsc, [...flags, "packages/static-hermes/src/globals.d.ts", "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts"]);
    const browser = await readFile(path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js"), "utf8");
    assert.match(browser, /slotBytes:8,maxParameters:4,resultBytes:8/);
    assert.match(browser, /reentrancy:'rejected'/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake-provider host bridge covers every route, failure zeroing, reentrancy, sanitizers, and warmed allocation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-runtime-"));
  try {
    const executable = path.join(directory, "runtime");
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", ...includes, "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp", "native/dmsdk_scratch_scalar_out_runtime_test.cpp", "-o", executable]);
    assert.equal(run(executable, [], { env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } }).trim(), "dmsdk-scratch-scalar-out:ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated runtime remains bounded and does not embed dmSDK calls", async () => {
  const runtime = await readFile(path.join(root, "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp"), "utf8");
  assert.doesNotMatch(runtime, /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
  assert.doesNotMatch(runtime, /\b(?:dmGameObject|dmHID)::[A-Za-z0-9_]+\s*\(/);
  assert.match(runtime, /thread_local bool gDispatchActive/);
  assert.match(runtime, /clearWritable/);
  assert.match(runtime, /validLane/);
});

test("scratch scalar-out generated IDs do not overlap prior generated families", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const selectedIds = new Set(report.declarations.filter(({ disposition }) => disposition === "generated-provider-boundary").map(({ id }) => id));
  const priorReports = [
    "defold-dmsdk-borrowed-handle-bindings.json",
    "defold-dmsdk-cstring-value-bindings.json",
    "defold-dmsdk-scalar-thunks.json",
    "defold-dmsdk-enum-value-bindings.json",
    "defold-dmsdk-fixed-digest-bindings.json",
    "defold-dmsdk-base64-span-bindings.json",
    "defold-dmsdk-astc-probe-bindings.json",
    "defold-dmsdk-xtea-span-bindings.json",
    "defold-dmsdk-hash-span-bindings.json",
  ];
  for (const name of priorReports) {
    const prior = JSON.parse(await readFile(path.join(root, "bindings/generated", name), "utf8"));
    const rows = prior.declarations ?? prior.bindings ?? [];
    for (const row of rows) {
      const generated = row.emitted === true || row.disposition === "generated-provider-boundary" || row.disposition === "generated" || row.wrapper;
      if (generated) assert.equal(selectedIds.has(row.id), false, `${name}: ${row.id}`);
    }
  }
});
