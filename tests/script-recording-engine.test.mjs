import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generatedScriptArtifacts } from "../scripts/lib/script-generator-pipeline.mjs";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-script-recording-engine.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "pipe", encoding: "utf8", ...options });
}

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
});
