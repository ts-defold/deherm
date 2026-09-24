import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertRuntimeMeasurementEvidence,
  buildRuntimeMeasurementSourceInputs,
} from "../integration/runtime-measurement-evidence.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/runtime-measurement.json");
const gatePath = path.join(exampleRoot, "integration/check-runtime-measurement.mjs");

test("runtime measurement evidence is source-bound and owner-checkable", async () => {
  const sourceInputs = await buildRuntimeMeasurementSourceInputs();
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assertRuntimeMeasurementEvidence(evidence, { sourceInputs });
  assert.match(execFileSync(process.execPath, [gatePath, "--check-evidence"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }), /war-battles-runtime-measurement-evidence:fresh:/u);
});

test("runtime observations do not promote memory snapshots to allocation claims", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.runtime.wallClockObserved, true);
  assert.ok(evidence.authoritativeServer.samples.samples > 0);
  assert.equal(evidence.allocations.measured, false);
  assert.equal(evidence.allocations.perTick, null);
  assert.equal(evidence.allocations.zeroClaim, false);
  assert.equal(evidence.workload.deterministicEvidenceSeparate, true);
  if (!evidence.browser.observed) {
    assert.equal(evidence.browser.timing, null);
    assert.equal(evidence.browser.memory, null);
    assert.match(evidence.browser.unavailable, /browser measurement/i);
  }
});

test("runtime measurement rejects internally inconsistent percentile ordering", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.authoritativeServer.samples.p50 = evidence.authoritativeServer.samples.p95 + 1;
  assert.throws(() => assertRuntimeMeasurementEvidence(evidence), /percentile order is invalid/u);
});
