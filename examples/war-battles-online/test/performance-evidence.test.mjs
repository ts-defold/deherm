import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SNAPSHOT_BYTES } from "../core/constants.ts";
import { SNAPSHOT_FRAME_HEADER_BYTES, SNAPSHOT_MESSAGE_BYTES } from "../core/protocol.ts";
import { readSnapshotFrame, writeSnapshotDelta, writeSnapshotKeyframe } from "../core/snapshot.ts";
import { assertPerformanceEvidence, buildPerformanceSourceInputs } from "../integration/performance-evidence.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/performance-operability.json");
const gatePath = path.join(exampleRoot, "integration/check-performance.mjs");

test("performance/operability evidence is source-bound and fresh", async () => {
  const sourceInputs = await buildPerformanceSourceInputs();
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assertPerformanceEvidence(evidence, { sourceInputs });
  assert.match(
    execFileSync(process.execPath, [gatePath, "--check-evidence"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    /war-battles-performance-evidence:fresh:/u,
  );
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
  assert.equal(
    Object.values(evidence.snapshotBandwidth.byteAttribution).reduce((sum, value) => sum + value, 0),
    evidence.snapshotBandwidth.totalBytes,
  );
  assert.equal(evidence.snapshotBandwidth.targets.downstreamTargetSatisfied, false);
  assert.equal(evidence.snapshotBandwidth.targets.downstreamStretchTargetSatisfied, false);
  assert.equal(evidence.snapshotBandwidth.targets.snapshotP95TargetSatisfied, false);
  assert.equal(evidence.snapshotBandwidth.targets.keyframeTargetSatisfied, true);
  assert.equal(evidence.snapshotBandwidth.targets.worstCaseDownstreamTargetSatisfied, false);
  assert.equal(evidence.snapshotBandwidth.targets.upstreamTargetSatisfied, true);
  assert.ok(evidence.snapshotBandwidth.targets.requiredDownstreamReductionRatio > 0);
  assert.match(evidence.snapshotBandwidth.evidenceBoundary, /Application payload bytes only/u);
});

test("snapshot deltas coalesce unchanged gaps no larger than another varint run header", () => {
  const baseline = new Uint8Array(SNAPSHOT_BYTES).fill(9);
  const current = baseline.slice();
  const frame = new Uint8Array(SNAPSHOT_FRAME_HEADER_BYTES + SNAPSHOT_BYTES);
  const decoded = new Uint8Array(SNAPSHOT_BYTES);
  current[10] = 1;
  current[12] = 2; // one unchanged byte is cheaper than another run header
  current[20] = 3;
  current[23] = 4; // two unchanged bytes stay as separate runs

  const length = writeSnapshotDelta(frame, 2, 1, baseline, current);
  assert.equal(frame[14] | (frame[15] << 8), 3);
  assert.equal(length, SNAPSHOT_FRAME_HEADER_BYTES + (2 + 3) + (2 + 1) + (2 + 1));
  assert.equal(readSnapshotFrame(frame.subarray(0, length), { baseline, decoded, baselineTick: 1 }), 2);
  assert.deepEqual(decoded, current);
});

test("sparse keyframes round-trip and dense adversarial state uses the bounded raw fallback", () => {
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const scratch = {
    baseline: new Uint8Array(SNAPSHOT_BYTES),
    decoded: new Uint8Array(SNAPSHOT_BYTES),
    baselineTick: -1,
  };
  const sparse = new Uint8Array(SNAPSHOT_BYTES);
  sparse[10] = 1;
  sparse[SNAPSHOT_BYTES - 1] = 2;
  const sparseLength = writeSnapshotKeyframe(frame, 7, sparse);
  assert.ok(sparseLength < 32);
  assert.equal(readSnapshotFrame(frame.subarray(0, sparseLength), scratch), 7);
  assert.deepEqual(scratch.decoded, sparse);

  const dense = new Uint8Array(SNAPSHOT_BYTES).fill(1);
  const denseLength = writeSnapshotKeyframe(frame, 8, dense);
  assert.equal(denseLength, SNAPSHOT_MESSAGE_BYTES);
  assert.equal(readSnapshotFrame(frame.subarray(0, denseLength), scratch), 8);
  assert.deepEqual(scratch.decoded, dense);
});
