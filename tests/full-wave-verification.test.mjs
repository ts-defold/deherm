import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evidenceStages,
  loadVerificationPlan,
  runFullWaveVerification,
  validateVerificationPlan,
} from "../scripts/run-full-wave-verification.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const fake = "tests/fixtures/full-wave-verification/fake-command.mjs";

function declared(status = "unavailable") {
  return { kind: "declared", status, claim: `declared ${status} evidence`, reason: `${status} by fixture design` };
}

function command(id, exit = 0, modes = ["focused", "full"]) {
  return {
    kind: "command",
    claim: `${id} command evidence`,
    modes,
    commands: [{
      id,
      executable: "$NODE",
      arguments: [fake, "--stdout", `${id}:out`, "--stderr", `${id}:err`, "--exit", String(exit)],
    }],
  };
}

function fakePlan() {
  const alpha = Object.fromEntries(evidenceStages.map((stage) => [stage, declared()]));
  alpha.generation = {
    kind: "command",
    claim: "failure stops only the remaining commands in this cell",
    modes: ["focused", "full"],
    commands: [
      { id: "first-fails", executable: "$NODE", arguments: [fake, "--stdout", "before failure", "--exit", "7"] },
      { id: "must-not-run", executable: "$NODE", arguments: [fake, "--stdout", "incorrect", "--exit", "0"] },
    ],
  };
  alpha.compile = command("compile-passes");
  alpha.link = declared("blocked");
  alpha.runtime = command("runtime-passes");
  alpha["packaged-engine"] = declared("unobserved");
  alpha.sanitizer = declared("unavailable");
  alpha.allocation = command("full-only-allocation", 0, ["full"]);
  alpha["clean-room"] = command("clean-room-passes");
  alpha.target = declared("blocked");

  const beta = Object.fromEntries(evidenceStages.map((stage) => [stage, declared()]));
  beta.generation = command("later-row-passes");
  return {
    schemaVersion: 1,
    matrixId: "fake-full-wave",
    description: "Fake command plan for deterministic orchestrator tests.",
    rows: [
      { id: "alpha", title: "Alpha", scope: "Per-cell failure semantics.", cells: alpha },
      { id: "beta", title: "Beta", scope: "Global continuation semantics.", cells: beta },
    ],
  };
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else output.push(child);
  }
  return output;
}

test("the checked whole-repository matrix is complete and fail-closed", async () => {
  const { plan } = await loadVerificationPlan("verification/full-wave-matrix.json", root);
  assert.equal(plan.rows.length, 8);
  for (const row of plan.rows) {
    assert.deepEqual(Object.keys(row.cells).sort(), [...evidenceStages].sort());
    assert.notEqual(row.cells["packaged-engine"].status, "passed");
  }
  assert.ok(plan.rows.some(({ cells }) => cells["packaged-engine"].status === "unobserved"));
  assert.ok(plan.rows.some(({ cells }) => cells.target.status === "blocked"));
});

test("plan validation rejects missing stages and declared green evidence", () => {
  const missing = fakePlan();
  delete missing.rows[0].cells.target;
  assert.throws(() => validateVerificationPlan(missing), /must contain exactly/);

  const promoted = fakePlan();
  promoted.rows[0].cells["packaged-engine"].status = "passed";
  assert.throws(() => validateVerificationPlan(promoted), /blocked, unavailable, or unobserved/);

  const hiddenCommand = fakePlan();
  hiddenCommand.rows[0].cells.target.commands = [{ id: "hidden", executable: "$NODE", arguments: [] }];
  assert.throws(() => validateVerificationPlan(hiddenCommand), /must not contain commands/);
});

test("focused execution fails fast per cell, continues globally, and writes atomic exact evidence", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-full-wave-focused-"));
  try {
    const { report, reportPath } = await runFullWaveVerification({
      repositoryRoot: root,
      plan: fakePlan(),
      mode: "focused",
      outputRoot: temporary,
      runId: "focused-fixture",
    });
    assert.equal(report.summary.outcome, "failed");
    assert.equal(report.rows[0].cells.generation.status, "failed");
    assert.equal(report.rows[0].cells.generation.commands[0].exitCode, 7);
    assert.equal(report.rows[0].cells.generation.commands[1].status, "not-run-after-cell-failure");
    assert.equal(report.rows[0].cells.generation.commands[1].logPath, null);
    assert.equal(report.rows[0].cells.compile.status, "passed");
    assert.equal(report.rows[0].cells.runtime.status, "passed");
    assert.equal(report.rows[1].cells.generation.status, "passed");
    assert.equal(report.rows[0].cells.allocation.status, "not-run");
    assert.equal(report.rows[0].cells.link.status, "blocked");
    assert.equal(report.rows[0].cells["packaged-engine"].status, "unobserved");
    const commandRecord = report.rows[0].cells.compile.commands[0];
    assert.equal(commandRecord.executable, process.execPath);
    assert.deepEqual(commandRecord.arguments.slice(0, 2), [fake, "--stdout"]);
    assert.equal(commandRecord.cwd, root);
    assert.ok(commandRecord.durationMs >= 0);
    assert.equal(path.isAbsolute(commandRecord.logPath), true);
    const log = await readFile(commandRecord.logPath, "utf8");
    assert.match(log, /compile-passes:out/);
    assert.match(log, /compile-passes:err/);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    assert.deepEqual(JSON.parse(await readFile(path.join(temporary, "latest.json"), "utf8")), report);
    assert.equal((await walk(temporary)).some((file) => file.includes(".tmp-")), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("full mode executes full-only cells without promoting declared gaps", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-full-wave-full-"));
  try {
    const { report } = await runFullWaveVerification({
      repositoryRoot: root,
      plan: fakePlan(),
      mode: "full",
      outputRoot: temporary,
      runId: "full-fixture",
    });
    assert.equal(report.rows[0].cells.allocation.status, "passed");
    assert.equal(report.rows[0].cells.target.status, "blocked");
    assert.equal(report.rows[0].cells["packaged-engine"].status, "unobserved");
    assert.equal(report.summary.outcome, "failed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the CLI returns failure only after persisting the complete matrix", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-full-wave-cli-"));
  try {
    const planPath = path.join(temporary, "plan.json");
    const output = path.join(temporary, "evidence");
    await writeFile(planPath, `${JSON.stringify(fakePlan(), null, 2)}\n`);
    const result = spawnSync(process.execPath, [
      "scripts/run-full-wave-verification.mjs",
      "--plan", planPath,
      "--output-root", output,
      "--run-id", "cli-fixture",
      "--mode", "focused",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Full-wave verification: failed/);
    const report = JSON.parse(await readFile(path.join(output, "runs/cli-fixture/matrix.json"), "utf8"));
    assert.equal(report.rows[1].cells.generation.status, "passed");
    assert.equal(report.summary.pending, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
