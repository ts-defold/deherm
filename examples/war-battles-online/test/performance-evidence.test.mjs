import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertPerformanceEvidence,
  buildPerformanceSourceInputs,
} from "../integration/performance-evidence.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/performance-operability.json");
const gatePath = path.join(exampleRoot, "integration/check-performance.mjs");

test("performance/operability evidence is source-bound and fresh", async () => {
  const sourceInputs = await buildPerformanceSourceInputs();
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assertPerformanceEvidence(evidence, { sourceInputs });
  assert.match(execFileSync(process.execPath, [gatePath, "--check-evidence"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }), /war-battles-performance-evidence:fresh:/u);
});

test("performance evidence keeps observable and unobservable boundaries explicit", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.timings.wallClockObserved, false);
  assert.equal(evidence.allocationShape.vmAllocationsMeasured, false);
  assert.equal(evidence.allocationShape.simulationHotPath.sourceInspectionImplemented, false);
  assert.equal(evidence.allocationShape.simulationHotPath.explicitHeapAllocationsPerTick, null);
  assert.equal(evidence.fixedPools.arena.observable, false);
  assert.equal(evidence.fixedPools.presentationEvents.failures, 0);
  assert.equal(evidence.reconciliation.postRestoreError, 0);
  assert.ok(evidence.reconciliation.correctedSnapshots > 0);
  assert.ok(evidence.snapshotBandwidth.totalBytes > 0);
});
