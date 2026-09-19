import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildConformancePlan,
  buildConformanceReport,
  conformanceSchema,
  loadConformanceInputs,
  parseShard,
  writeConformanceHarness
} from "../packages/cli/src/conformance.mjs";

test("conformance generator accounts for every script and dmSDK declaration", async () => {
  const inputs = await loadConformanceInputs();
  const plan = buildConformancePlan(inputs, { target: "arm64-macos", contexts: ["*"], shard: "0/1" });

  assert.equal(plan.selectedCaseCount, 3066);
  assert.deepEqual(plan.summary.surface, { dmsdk: 2141, script: 926 });
  assert.equal(new Set(plan.cases.map(({ id }) => id)).size, plan.cases.length);
  assert.equal(new Set(plan.cases.map(({ stableId }) => stableId)).size, plan.cases.length);
  const expectedSpecializedScript = inputs.scriptIr.functions.filter(({ runtimeStatus }) => runtimeStatus === "implemented-generated-lua-bridge").length;
  const expectedScalarScript = inputs.scriptDispatch.bindings.length;
  const expectedLinked = expectedSpecializedScript + expectedScalarScript +
    inputs.dmsdkThunks.declarations.filter((item) => item.emitted && item.stages?.linked?.status?.includes("covered")).length;
  const linkedButUnsafe = plan.cases.filter((item) =>
    item.stages.link.disposition === "linked" && item.execution.policy !== "safe").length;
  assert.equal(plan.summary.link.linked, expectedLinked);
  assert.equal(plan.summary.runtime.executable, expectedLinked - linkedButUnsafe);
  assert.equal(plan.summary.semantic["host-conformant"], expectedLinked - expectedScalarScript);
  assert.equal(plan.summary.semantic.unverified, expectedScalarScript);

  for (const item of plan.cases) {
    assert.ok(conformanceSchema.executionPolicies.includes(item.execution.policy), item.id);
    assert.ok(conformanceSchema.stageDispositions.includes(item.stages.compile.disposition), item.id);
    assert.ok(conformanceSchema.stageDispositions.includes(item.stages.link.disposition), item.id);
    assert.ok(conformanceSchema.stageDispositions.includes(item.stages.runtime.disposition), item.id);
    assert.ok(conformanceSchema.semanticStates.includes(item.stages.semantic.state), item.id);
  }

  const timer = plan.cases.find(({ id }) => id === "script:timer.delay");
  assert.equal(timer.stages.runtime.disposition, "executable");
  assert.equal(timer.stages.semantic.state, "host-conformant");
  assert.equal(timer.stages.semantic.targetConformant, false);

  const scalar = plan.cases.find(({ id }) => id === "script:bit.tohex");
  assert.equal(scalar.stages.link.disposition, "linked");
  assert.equal(scalar.stages.runtime.disposition, "executable");
  assert.equal(scalar.stages.semantic.state, "unverified");
  assert.deepEqual(scalar.targetProbeSelection.probeKeys, [
    "bit.tohex.explicit-width",
    "bit.tohex.default-width"
  ]);
  assert.equal(plan.cases.filter(({ targetProbeSelection }) => targetProbeSelection).length, 12);

  const html5 = plan.cases.find(({ id }) => id.startsWith("script:html5."));
  assert.equal(html5.execution.policy, "context-blocked");
  assert.match(html5.execution.reason, /requires target js-web/);
});

test("stable shards are exhaustive, disjoint, and argument validation is strict", async () => {
  const inputs = await loadConformanceInputs();
  const whole = buildConformancePlan(inputs, { shard: "0/1" });
  const parts = Array.from({ length: 7 }, (_, index) => buildConformancePlan(inputs, { shard: `${index}/7` }));
  const ids = parts.flatMap((part) => part.cases.map(({ id }) => id));

  assert.equal(ids.length, whole.cases.length);
  assert.equal(new Set(ids).size, whole.cases.length);
  assert.deepEqual([...ids].sort(), whole.cases.map(({ id }) => id).sort());
  assert.deepEqual(parseShard("3/7"), { index: 3, count: 7 });
  assert.throws(() => parseShard("7/7"), /require 0 <= INDEX < COUNT/);
  assert.throws(() => parseShard("one"), /INDEX\/COUNT/);
});

test("the exhaustive generated TypeScript fixture compiles against the generated SDK", async () => {
  const inputs = await loadConformanceInputs();
  const plan = buildConformancePlan(inputs, { target: "arm64-macos", contexts: ["*"], shard: "0/1" });
  const output = await mkdtemp(path.join(tmpdir(), "defold-hermes-conformance-"));
  const harness = await writeConformanceHarness(plan, output);
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--project", harness.files.tsconfig, "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  const source = await readFile(harness.files.compile, "utf8");
  assert.match(source, /Script\.Bullet3dApi\["collisionObject"\]/);
  assert.match(source, /Dm\.DmSdkDeclarationMap\["dmsdk:/);
  const schema = JSON.parse(await readFile(harness.files.schema, "utf8"));
  assert.deepEqual(schema.$defs.executionPolicy.enum, conformanceSchema.executionPolicies);
  assert.deepEqual(schema.$defs.semanticState.enum, conformanceSchema.semanticStates);
  const runtime = await import(`${new URL(`file://${harness.files.runtime}`).href}?test=${Date.now()}`);
  assert.equal(runtime.cases.length, 3066);
  assert.equal(typeof runtime.runGeneratedConformance, "function");
});

test("reports never promote planned evidence into fresh observations", async () => {
  const inputs = await loadConformanceInputs();
  const plan = buildConformancePlan(inputs, { surface: "script", shard: "0/128" });
  const first = plan.cases[0];
  const report = buildConformanceReport(plan, [{
    schemaVersion: 1,
    planId: plan.planId,
    target: plan.target,
    results: [{ id: first.id, stages: { compile: { status: "passed", evidence: "tsc" } } }]
  }]);

  assert.equal(report.observationCount, 1);
  assert.equal(report.summary.compile.passed, 1);
  assert.equal(report.summary.link["not-run"], plan.cases.length);
  assert.equal(report.strictPass, false);
  assert.ok(report.strictFailures.length >= plan.cases.length - 1);
  assert.throws(() => buildConformanceReport(plan, [{
    schemaVersion: 1,
    planId: "wrong",
    target: plan.target,
    results: []
  }]), /does not match/);
  assert.throws(() => buildConformanceReport(plan, [{
    schemaVersion: 1,
    planId: plan.planId,
    target: plan.target,
    results: [{ id: "missing", stages: { compile: { status: "passed" } } }]
  }]), /unknown case/);
});

test("CLI generates sharded plans and writes honest reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "defold-hermes-conformance-cli-"));
  const harnessRoot = path.join(root, "harness");
  const cli = path.resolve("bin/deherm.mjs");
  const generated = spawnSync(process.execPath, [
    cli,
    "conformance", "generate",
    "--output", harnessRoot,
    "--surface", "script",
    "--target", "js-web",
    "--context", "browser,engine",
    "--shard", "2/16",
    "--json"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const summary = JSON.parse(generated.stdout);
  assert.deepEqual(summary.shard, { index: 2, count: 16 });
  assert.deepEqual(summary.contexts, ["browser", "engine"]);

  const compileObservation = path.join(root, "compile-observation.json");
  const compiled = spawnSync(process.execPath, [
    cli,
    "conformance", "compile",
    "--plan", path.join(harnessRoot, "plan.json"),
    "--output", compileObservation,
    "--json"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const compileResult = JSON.parse(compiled.stdout);
  assert.equal(compileResult.passed, true);
  const observedCompile = JSON.parse(await readFile(compileObservation, "utf8"));
  assert.equal(observedCompile.results.length, summary.selectedCaseCount);
  assert.ok(observedCompile.results.every((item) => item.stages.compile.status === "passed"));

  const reportPath = path.join(root, "report.json");
  const reported = spawnSync(process.execPath, [
    cli,
    "conformance", "report",
    "--plan", path.join(harnessRoot, "plan.json"),
    "--observation", compileObservation,
    "--output", reportPath
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(reported.status, 0, `${reported.stdout}\n${reported.stderr}`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.strictPass, false);
  assert.equal(report.observationCount, summary.selectedCaseCount);
  assert.equal(report.summary.compile.passed, summary.selectedCaseCount);

  const strict = spawnSync(process.execPath, [
    cli,
    "conformance", "report",
    "--plan", path.join(harnessRoot, "plan.json"),
    "--observation", compileObservation,
    "--output", reportPath,
    "--strict"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(strict.status, 1);
});
