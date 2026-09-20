import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generatedScriptArtifacts } from "../scripts/lib/script-generator-pipeline.mjs";
import { buildRecordingEngineModel } from "../packages/compiler/src/script-recording-engine.mjs";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-script-recording-engine.json");

function u64Sentinel(seed) {
  return (BigInt(seed + 0x10000) << 32n) | BigInt(seed);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "pipe", encoding: "utf8", ...options });
}

test("a lowering plan from another revision becomes an explicit recording fallback", async () => {
  const paths = {
    projection: "packages/bindings/generated/defold-script-projection-ir.json",
    universal: "packages/bindings/generated/defold-script-universal-value-bindings.json",
    handleLowering: "packages/bindings/generated/defold-script-handle-lowering.json",
    loweringPlan: "packages/bindings/generated/defold-binding-lowering-plan.json"
  };
  const texts = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) => [
    key,
    await readFile(path.join(root, relative), "utf8")
  ])));
  const inputs = Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, JSON.parse(text)]));
  inputs.loweringPlan.defoldRevision = "0".repeat(40);
  inputs.inputHashes = Object.fromEntries(Object.entries(texts).map(([key, text]) => [
    key,
    createHash("sha256").update(text).digest("hex")
  ]));

  const report = buildRecordingEngineModel(inputs);

  assert.match(report.planSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.planFallback.code, "canonical-lowering-plan-revision-unavailable");
  assert.equal(report.planFallback.routeCount, inputs.universal.bindings.length);
  assert.ok(report.routes.every(({ loweringPlanEvidence }) =>
    loweringPlanEvidence === "projection-derived-unverified-fallback"));
});

test("the recording engine is generated from the same IR as the bindings, and is deterministic", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const universal = JSON.parse(await readFile(
    path.join(root, "packages/bindings/generated/defold-script-universal-value-bindings.json"), "utf8"));

  // Every callable non-intrinsic route is modelled exactly once.
  assert.equal(report.routes.length, universal.bindings.length);
  assert.deepEqual(
    new Set(report.routes.map(({ id }) => id)),
    new Set(universal.bindings.map(({ id }) => id)));
  assert.equal(new Set(report.order).size, report.routes.length);

  // Contracts are the canonical lowering plan's interned indices, so a later
  // real-engine differential can diff this trace per contract.
  assert.match(report.planSha256, /^[0-9a-f]{64}$/);
  assert.ok(report.routes.every(({ contract }) => Number.isInteger(contract) && contract >= 0));

  // The evidence boundary must never claim engine conformance.
  assert.match(report.evidenceBoundary, /not Defold/);
  assert.match(report.evidenceBoundary, /nothing here is engine conformance evidence/);

  // Every route has an explicit per-transport disposition with a reason on skip.
  for (const route of report.routes) {
    for (const transport of report.transports.drivable) {
      const disposition = route.transports[transport];
      assert.ok(disposition, `${route.id} has no ${transport} disposition`);
      assert.ok(disposition.status === "exercise" || disposition.reason.length > 0,
        `${route.id} skips ${transport} without a machine-readable reason`);
    }
  }

  // JSI emits every universal row. Two documented input handle kinds have no
  // public constructor/return path, so deterministic provider fixtures mint
  // genuine HostObjects through the bridge before the census begins.
  assert.deepEqual(report.summary.byTransport.jsi, { exercised: 915, skipped: 0 });
  assert.deepEqual(
    report.handleSeeds.map(({ name }) => name),
    ["box2d-shape", "graphics-texture"],
  );
  assert.equal(new Set(report.handleSeeds.map(({ stableId }) => stableId)).size, report.handleSeeds.length);
  assert.ok(report.handleSeeds.every(({ stableId }) =>
    !report.routes.some((route) => route.stableId === stableId)));

  // Static URL/Matrix4 push support is now exercised, not hidden by an old
  // harness limitation. Only callback rows remain transport-inapplicable:
  // browser callbacks need the HTML5 registry and Static Hermes falls back to
  // JSI for function values.
  assert.deepEqual(report.summary.byTransport["direct-memory"], { exercised: 890, skipped: 25 });
  assert.deepEqual(report.summary.byTransport["typed-native"], { exercised: 890, skipped: 25 });
  assert.ok(report.routes.every((route) =>
    route.transports["typed-native"].reason !== "static-frame-has-no-url-or-matrix4-argument-push"));
  const directSkips = report.routes
    .filter((route) => route.transports["direct-memory"].status === "skip")
    .map((route) => route.transports["direct-memory"].reason);
  assert.deepEqual(new Set(directSkips), new Set([
    "callback-input-requires-the-html5-browser-registry",
    "callback-result-is-emitted-only-by-the-jsi-transport",
  ]));

  // Transports the canonical plan models but this harness cannot drive are
  // declared rather than silently absent.
  assert.deepEqual(report.transports.undrivable.map(({ transport }) => transport), ["lua-stack"]);

  // Generated artifacts are registered with the script clean-room gate.
  for (const artifact of Object.values(report.artifacts)) {
    assert.ok(generatedScriptArtifacts.includes(artifact),
      `${artifact} is not registered with the script generator pipeline`);
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-recording-engine-"));
  try {
    run(process.execPath, ["scripts/generate-script-recording-engine.mjs", "--output-root", temporary]);
    for (const artifact of Object.values(report.artifacts)) {
      assert.equal(
        await readFile(path.join(temporary, artifact), "utf8"),
        await readFile(path.join(root, artifact), "utf8"),
        artifact);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the expected trace is derived from the contract and covers every drivable transport", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const trace = await readFile(
    path.join(root, "tests/fixtures/generated_script_recording_expected_trace.txt"), "utf8");
  const lines = trace.split("\n").filter((line) => line && !line.startsWith("#"));
  const expectedLines = report.transports.drivable.reduce((total, transport) => {
    const exercised = report.summary.byTransport[transport].exercised;
    const skipped = report.summary.byTransport[transport].skipped;
    return total + exercised * 3 + skipped;
  }, 0);
  assert.equal(lines.length, expectedLines);
  assert.ok(lines.every((line) => /^(call|recv|end|skip) /.test(line)));
  assert.ok(lines.filter((line) => line.startsWith("call ")).every((line) => / c\d+ arity=\d+ /.test(line)));
  const bitBand = report.routes.find(({ id }) => id === "script:bit.band");
  const screenToWorld = report.routes.find(({ id }) => id === "script:camera.screen_xy_to_world");
  assert.ok(lines.includes(
    `call bit.band jsi c${bitBand.contract} arity=2 args=[num:1 num:2] ctx=context-policy-unresolved`,
  ));
  assert.ok(lines.includes(
    `call camera.screen_xy_to_world typed-native c${screenToWorld.contract} ` +
    `arity=3 args=[num:1 num:2 url:${[3, 4, 5, 6].map(u64Sentinel).join(",")}] ` +
    "ctx=context-policy-unresolved",
  ));
  assert.ok(lines.some((line) =>
    line.startsWith("recv b2d.joint.get_anchor_a jsi ") && line.endsWith("[dv:v3:257,258,259]")));
  assert.ok(lines.some((line) => /args=\[[^\]]*str:d1 str:d2/.test(line)));
  assert.ok(lines.some((line) => line.includes(`hash:${u64Sentinel(1)}`)),
    "the trace must carry a nonzero upper 32-bit hash sentinel");
});
