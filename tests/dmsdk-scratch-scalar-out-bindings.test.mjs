import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json");
const sdk = path.join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx = process.env.CXX || "clang++";
const cc = process.env.CC || "clang";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
const includes = [
  `-I${path.join(root, "defold/defold_hermes/include")}`,
  "-isystem",
  path.join(sdk, "sdk/include"),
  "-isystem",
  path.join(sdk, "include"),
];

test("scratch scalar-out emitter consumes the authenticated compiler plan without selecting symbols", async () => {
  const [report, plan, policy, emitter] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-plan.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs"), "utf8"),
  ]);
  assert.deepEqual(report.coverage, {
    candidates: 30,
    generated: 11,
    blocked: 19,
    sourceDerived: 6,
    defoldContractTrusted: 5,
    cAbiGenerated: 11,
    dynamicHermesJsiGenerated: 11,
    staticHermesGenerated: 11,
    browserDirectMemoryGenerated: 11,
    typescriptGenerated: 11,
    pinnedHeaderSignatureCompiled: 11,
    fakeProviderHostRuntimeTested: 11,
    packagedEngineRuntimeVerified: 0,
    warmedDispatchIterations: 100000,
    warmedDispatchObservedCppAllocations: 0,
  });
  assert.equal(report.declarations.length, plan.decisions.length);
  assert.deepEqual(
    report.declarations.map(({ id }) => id),
    plan.decisions.map(({ declarationId }) => declarationId),
  );
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 30);
  assert.equal(report.abi.maxParameters, 4);
  assert.equal(report.abi.maxOutputs, 2);
  assert.equal(report.handleKinds.length, 6);
  assert.match(report.selector, /no symbol allowlist/);
  assert.doesNotMatch(
    emitter,
    /dmsdk-pattern-selector|dmsdk-pattern-catalog|selectDmSdkPattern|scratchScalarOutPattern/,
  );
  assert.equal(Object.hasOwn(policy, "entries"), false);
  for (const row of report.declarations.filter(({ disposition }) => disposition === "blocked")) {
    assert.ok(row.blockers.length > 0, row.id);
    assert.ok(
      row.blockers.some((token) => /unavailable|unsupported|unresolved|unverified|required/.test(token)),
      row.id,
    );
  }
  for (const row of report.declarations.filter(({ disposition }) => disposition !== "blocked")) {
    assert.deepEqual(row.resolvedPolicies, policy.storageContract);
    assert.match(row.stages.engine, /not-claimed/);
    assert.ok(row.engineProviderBlockers.includes("native-symbol-linkage-unverified"));
    assert.ok(row.engineProviderBlockers.includes("enum-domain-to-native-success-policy-unresolved"));
  }
});

test("scratch scalar-out generation is clean-room deterministic and rejects stale authenticated plans", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-generate-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs", "--output-root", directory]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [
      ...report.artifacts,
      "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json",
    ]) {
      assert.equal(
        await readFile(path.join(directory, artifact), "utf8"),
        await readFile(path.join(root, artifact), "utf8"),
        artifact,
      );
    }
    const contents = Object.fromEntries(
      await Promise.all(
        Object.entries(report.sources).map(async ([key, relative]) => [
          key,
          await readFile(path.join(root, relative), "utf8"),
        ]),
      ),
    );
    const observed = await build(contents);
    assert.equal(observed.report.coverage.candidates, 30);
    assert.equal(observed.report.coverage.generated, 11);
    assert.equal(observed.report.coverage.blocked, 19);
    assert.deepEqual(observed.report.abi, {
      slotBytes: 8,
      maxParameters: 4,
      maxOutputs: 2,
      handleKindCount: 6,
      parameterStorage: "caller-owned contiguous uint64_t slots",
      resultStorage: "caller-owned uint64_t slot",
    });
    await assert.rejects(() => build({ ...contents, ir: `${contents.ir}\n` }), /IR provenance mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed scratch inputs cannot be emitted through a stale plan", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(report.sources).map(async ([key, relative]) => [
        key,
        await readFile(path.join(root, relative), "utf8"),
      ]),
    ),
  );
  const changedShapes = JSON.parse(contents.shapes);
  const changed = changedShapes.rows.find(
    (row) => row.id === JSON.parse(contents.plan).decisions.find(({ fallback }) => !fallback)?.declarationId,
  );
  assert.ok(changed);
  const changedParameter = changed.parameters.at(-1);
  changedParameter.role = "pointer:unknown-specialization";
  await assert.rejects(
    () => build({ ...contents, shapes: JSON.stringify(changedShapes) }),
    /scratch plan differs from strict source re-derivation/,
  );
});

test("all selected signatures compile against the pinned SDK projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-headers-"));
  try {
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      '-DDLIB_LOG_DOMAIN="deherm"',
      ...includes,
      "-c",
      "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp",
      "-o",
      path.join(directory, "audit.o"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("C ABI, Dynamic Hermes, Static Hermes, browser, and TypeScript projections compile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scratch-scalar-out-targets-"));
  try {
    run(cc, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...includes,
      "-c",
      "native/dmsdk_scratch_scalar_out_c_header_test.c",
      "-o",
      path.join(directory, "header.o"),
    ]);
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...includes,
      "-c",
      "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp",
      "-o",
      path.join(directory, "runtime.o"),
    ]);
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...includes,
      `-I${path.join(root, "upstream/hermes/API")}`,
      "-c",
      "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_jsi.cpp",
      "-o",
      path.join(directory, "jsi.o"),
    ]);
    run(process.execPath, ["--check", "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js"]);
    const tsc = path.join(root, "node_modules/.bin/tsc");
    const flags = [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--target",
      "ES2020",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--skipLibCheck",
    ];
    run(tsc, [...flags, "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts"]);
    run(tsc, [
      ...flags,
      "packages/static-hermes/src/globals.d.ts",
      "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts",
    ]);
    const browser = await readFile(
      path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js"),
      "utf8",
    );
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
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      "-fsanitize=address,undefined",
      "-fno-omit-frame-pointer",
      ...includes,
      "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp",
      "native/dmsdk_scratch_scalar_out_runtime_test.cpp",
      "-o",
      executable,
    ]);
    assert.equal(
      run(executable, [], {
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" },
      }).trim(),
      "dmsdk-scratch-scalar-out:ok",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated runtime remains bounded and does not embed dmSDK calls", async () => {
  const runtime = await readFile(
    path.join(root, "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp"),
    "utf8",
  );
  assert.doesNotMatch(runtime, /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
  assert.doesNotMatch(runtime, /\b(?:dmGameObject|dmHID)::[A-Za-z0-9_]+\s*\(/);
  assert.match(runtime, /thread_local bool gDispatchActive/);
  assert.match(runtime, /clearWritable/);
  assert.match(runtime, /validLane/);
});

test("scratch scalar-out generated IDs do not overlap prior generated families", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const selectedIds = new Set(
    report.declarations.filter(({ disposition }) => disposition === "generated-provider-boundary").map(({ id }) => id),
  );
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
    const prior = JSON.parse(await readFile(path.join(root, "packages/bindings/generated", name), "utf8"));
    const rows = prior.declarations ?? prior.bindings ?? [];
    for (const row of rows) {
      const generated =
        row.emitted === true ||
        row.disposition === "generated-provider-boundary" ||
        row.disposition === "generated" ||
        row.wrapper;
      if (generated) assert.equal(selectedIds.has(row.id), false, `${name}: ${row.id}`);
    }
  }
});
