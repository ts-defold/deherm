import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../scripts/generate-dmsdk-borrowed-handle-bindings.mjs";
import {
  DMSDK_BORROWED_HANDLE_ARTIFACTS,
  DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH,
  DMSDK_BORROWED_HANDLE_REVISION_OUTPUT_PATHS,
  DMSDK_BORROWED_HANDLE_SDK_OUTPUT_PATH,
  renderDmSdkBorrowedHandleOutputs,
} from "../packages/compiler/src/dmsdk-borrowed-handle-output-emitter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json");
const sdk = path.join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx = process.env.CXX || "clang++";
const cc = process.env.CC || "clang";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const includes = [
  `-I${path.join(root, "defold/defold_hermes/include")}`,
  "-isystem",
  path.join(sdk, "sdk/include"),
  "-isystem",
  path.join(sdk, "include"),
];

test("compiler-owned borrowed-handle recipe reproduces every family output and frozen policy surface byte", async () => {
  const [recipeText, fixtureText] = await Promise.all([
    readFile(path.join(root, DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH), "utf8"),
    readFile(path.join(root, "tests/fixtures/policy-surface-old-pipeline/manifest.json"), "utf8"),
  ]);
  const recipe = JSON.parse(recipeText);
  const fixture = JSON.parse(fixtureText);
  assert.ok(Buffer.byteLength(recipeText) < 90_000, "borrowed-handle recipe must stay below 90 KB");
  assert.deepEqual(DMSDK_BORROWED_HANDLE_REVISION_OUTPUT_PATHS, [
    DMSDK_BORROWED_HANDLE_ARTIFACTS.header,
    DMSDK_BORROWED_HANDLE_ARTIFACTS.runtime,
    DMSDK_BORROWED_HANDLE_ARTIFACTS.jsiHeader,
    DMSDK_BORROWED_HANDLE_ARTIFACTS.jsi,
    DMSDK_BORROWED_HANDLE_ARTIFACTS.browser,
    DMSDK_BORROWED_HANDLE_ARTIFACTS.staticHermes,
  ]);
  assert.equal(DMSDK_BORROWED_HANDLE_SDK_OUTPUT_PATH, DMSDK_BORROWED_HANDLE_ARTIFACTS.typescript);
  const rendered = renderDmSdkBorrowedHandleOutputs(recipe);
  for (const [relative, content] of rendered) {
    const actual = await readFile(path.join(root, relative), "utf8");
    assert.equal(content, actual, `${relative} differs from the source-pipeline output`);
    const frozen = fixture.outputs[relative];
    if (frozen) {
      assert.equal(Buffer.byteLength(content), frozen.bytes, `${relative} frozen byte count drifted`);
      assert.equal(sha256(content), frozen.sha256, `${relative} differs from the frozen output golden`);
    }
  }
  const frozenSdk = fixture.files["dmsdk/borrowed-handle.ts"];
  const sdkContent = rendered.get(DMSDK_BORROWED_HANDLE_SDK_OUTPUT_PATH);
  assert.equal(Buffer.byteLength(sdkContent), frozenSdk.bytes);
  assert.equal(sha256(sdkContent), frozenSdk.sha256, "borrowed-handle SDK differs from the frozen SDK golden");
});

test("compiler-owned borrowed-handle recipe fails closed on corrupt semantic indices and arity", async () => {
  const recipe = JSON.parse(await readFile(path.join(root, DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH), "utf8"));
  const corruptString = structuredClone(recipe);
  corruptString.entries[0][0] = corruptString.strings.length;
  assert.throws(() => renderDmSdkBorrowedHandleOutputs(corruptString), /string index is invalid/u);
  const corruptArity = structuredClone(recipe);
  corruptArity.maxArguments += 1;
  assert.throws(() => renderDmSdkBorrowedHandleOutputs(corruptArity), /maximum arity drifted/u);
});

test("borrowed-handle emission exactly projects the authenticated plan and retains universal coverage", async () => {
  const [report, plan, policy, universal, generator] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "scripts/generate-dmsdk-borrowed-handle-bindings.mjs"), "utf8"),
  ]);
  assert.equal(report.providerAbiVersion, plan.providerAbiVersion);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.coverage.candidates, plan.coverage.structurallyRelevant);
  assert.equal(report.coverage.generated, plan.coverage.selected);
  assert.equal(report.coverage.blocked, plan.coverage.universalFallback);
  assert.deepEqual(report.coverage, {
    candidates: plan.coverage.structurallyRelevant,
    generated: plan.coverage.selected,
    blocked: plan.coverage.universalFallback,
    lifecycleGenerated: plan.coverage.lifecycleSelected,
    cAbiGenerated: plan.coverage.selected,
    dynamicHermesJsiGenerated: plan.coverage.selected,
    staticHermesGenerated: plan.coverage.selected,
    browserDirectMemoryGenerated: plan.coverage.selected,
    typescriptGenerated: plan.coverage.selected,
    pinnedHeaderSignatureCompiled: plan.coverage.selected,
    exactCallTwinsGenerated: plan.coverage.selected,
    fakeProviderHostRuntimeTested: plan.coverage.selected,
    packagedEngineRuntimeVerified: 0,
    warmedDispatchIterations: 100000,
    warmedDispatchObservedCppAllocations: 0,
  });
  assert.equal(report.declarations.length, plan.decisions.length);
  assert.equal(universal.coverage.recipes, 1361);
  assert.equal(universal.recipes.length, 1361);
  assert.equal(universal.coverage.silentlyOmitted, 0);
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, plan.decisions.length);
  assert.equal(report.handleKinds.length, report.abi.handleKindCount);
  assert.equal(report.abi.maxArguments, 8);
  assert.deepEqual(report.abi.lifecycleEffects, ["borrow", "retain", "release", "finalize"]);
  assert.match(report.abi.lifecycleCommit, /after successful invoke/u);
  assert.deepEqual(report.selector, plan.eligibility);
  assert.equal(Object.hasOwn(policy, "entries"), false);
  assert.doesNotMatch(
    generator,
    /dmsdk-pattern-selector|dmsdk-pattern-catalog|selectDmSdkPattern|borrowedHandlePattern/u,
  );
  for (const row of report.declarations.filter(({ disposition }) => disposition !== "blocked")) {
    const decision = plan.decisions.find(({ declarationId }) => declarationId === row.id);
    assert.ok(decision && !decision.fallback, row.id);
    assert.deepEqual(row.patternDecision, decision);
    assert.deepEqual(row.resolvedPolicies, decision.semantics);
    assert.match(row.stages.engine, /not-claimed/);
    assert.ok(row.engineProviderBlockers.includes("handle-ownership-nullability-lifetime-unresolved"));
    assert.ok(row.engineProviderBlockers.includes("call-thread-affinity-unresolved"));
  }
  for (const row of report.declarations.filter(({ disposition }) => disposition === "blocked")) {
    const decision = plan.decisions.find(({ declarationId }) => declarationId === row.id);
    assert.ok(decision?.fallback, row.id);
    assert.deepEqual(row.patternDecision, decision);
    assert.equal(row.universalFallback, "retained");
  }
});

test("borrowed-handle generation is clean-room deterministic and treats historical counts as observations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-generate-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-borrowed-handle-bindings.mjs", "--output-root", directory]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const artifact of [
      ...report.artifacts,
      "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json",
      DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH,
    ]) {
      assert.equal(
        await readFile(path.join(directory, artifact), "utf8"),
        await readFile(path.join(root, artifact), "utf8"),
        artifact,
      );
    }
    const contents = {
      ir: await readFile(path.join(root, report.sources.ir), "utf8"),
      shapes: await readFile(path.join(root, report.sources.shapes), "utf8"),
      projection: await readFile(path.join(root, report.sources.projection), "utf8"),
      policy: await readFile(path.join(root, report.sources.policy), "utf8"),
      effectFacts: await readFile(path.join(root, report.sources.effectFacts), "utf8"),
      plan: await readFile(path.join(root, report.sources.plan), "utf8"),
    };
    const observed = await build(contents);
    assert.deepEqual(observed.report.coverage, report.coverage);
    assert.equal(observed.report.abi.maxArguments, report.abi.maxArguments);
    await assert.rejects(() => build({ ...contents, ir: `${contents.ir}\n` }), /IR provenance mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("borrowed-handle emitter rejects stale source/plan combinations instead of privately reselecting", async () => {
  const contents = Object.fromEntries(
    await Promise.all(
      [
        ["ir", reportPath.replace("defold-dmsdk-borrowed-handle-bindings.json", "defold-sdk-ir.json")],
        ["shapes", path.join(root, "packages/bindings/generated/defold-dmsdk-abi-shapes.json")],
        ["projection", path.join(root, "packages/bindings/generated/defold-dmsdk-projection-ir.json")],
        ["policy", path.join(root, "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json")],
        ["effectFacts", path.join(root, "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json")],
        ["plan", path.join(root, "packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json")],
      ].map(async ([key, source]) => [key, await readFile(source, "utf8")]),
    ),
  );
  const shapes = JSON.parse(contents.shapes);
  const candidate = shapes.rows.find((row) => row.symbol === "dmBuffer::IsBufferValid");
  assert.ok(candidate);
  candidate.result.role = "scalar:future-lane";
  await assert.rejects(
    () => build({ ...contents, shapes: JSON.stringify(shapes) }),
    /effect facts do not authenticate|strict source re-derivation/u,
  );
});

test("all planned selected signatures compile against the complete pinned SDK projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-headers-"));
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
      "native/generated_dmsdk_borrowed_handle_header_audit.cpp",
      "-o",
      path.join(directory, "audit.o"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("C ABI, Dynamic Hermes adapter, browser descriptor, and TypeScript projections compile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-targets-"));
  try {
    run(cc, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...includes,
      "-c",
      "native/dmsdk_borrowed_handle_c_header_test.c",
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
      "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp",
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
      `-I${path.join(root, "upstream/hermes/API/jsi")}`,
      "-c",
      "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_jsi.cpp",
      "-o",
      path.join(directory, "jsi.o"),
    ]);
    run(process.execPath, ["--check", "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js"]);
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
    run(tsc, [...flags, "packages/sdk/src/generated/dmsdk/borrowed-handle.ts"]);
    run(tsc, [
      ...flags,
      "packages/static-hermes/src/globals.d.ts",
      "packages/static-hermes/src/generated/dmsdk-borrowed-handle.ts",
    ]);
    const browser = await readFile(
      path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js"),
      "utf8",
    );
    assert.match(browser, /slotBytes:8,maxArguments:8,resultBytes:8/);
    assert.match(browser, /per-argument-lifecycle-effects/);
    assert.match(browser, /argumentEffects:Object\.freeze/);
    assert.match(browser, /callRaw:function\(id,argumentsPointer,argumentCount,resultPointer\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake-provider host bridge links, enforces guards, sanitizes, and allocates zero when warm", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-borrowed-handle-runtime-"));
  try {
    const executable = path.join(directory, process.platform === "win32" ? "runtime.exe" : "runtime");
    const sanitizerFlags =
      process.platform === "win32" ? [] : ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...sanitizerFlags,
      ...includes,
      "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp",
      "native/generated_dmsdk_borrowed_handle_exact_call.cpp",
      "native/dmsdk_borrowed_handle_runtime_test.cpp",
      "-o",
      executable,
    ]);
    assert.equal(
      run(executable, [], {
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" },
      }).trim(),
      "dmsdk-borrowed-handle:ok",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated runtime remains allocation-free and does not embed dmSDK symbol calls", async () => {
  const runtime = await readFile(
    path.join(root, "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp"),
    "utf8",
  );
  assert.doesNotMatch(runtime, /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
  assert.doesNotMatch(runtime, /\b(?:dmGraphics|dmGameObject|dmResource)::[A-Za-z0-9_]+\s*\(/);
  assert.match(runtime, /validate_handle/);
  assert.match(runtime, /is_current_thread/);
  assert.match(runtime, /transition_handle/);
  assert.match(runtime, /argument_effects/);
});

test("Dynamic Hermes f32 admission rejects finite doubles that overflow the native lane", async () => {
  const source = await readFile(
    path.join(root, "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_jsi.cpp"),
    "utf8",
  );
  assert.match(
    source,
    /const float narrowed=static_cast<float>\(number\);\s*if\(!std::isfinite\(narrowed\)\) throw jsi::JSError\(runtime,"f32 out of range"\)/,
  );
});
