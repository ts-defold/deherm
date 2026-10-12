import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  assertAuthoritativeLoadEvidence,
  buildAuthoritativeLoadSourceInputs,
} from "../integration/authoritative-load-evidence.mjs";
import {
  LOAD_HARNESS_CONFIG,
  ImpairedNetwork,
  runAuthoritativeLoadHarness,
} from "../integration/authoritative-load-harness.ts";
import { NETWORK_IMPAIRMENT_PROFILES } from "../integration/network-impairment-matrix.ts";
import { TRANSPORT_CHANNEL_CONTROL, TRANSPORT_CHANNEL_SNAPSHOT } from "../core/transport.ts";
import { UNITS_PER_PIXEL } from "../core/constants.ts";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/authoritative-load-32.json");
const gatePath = path.join(exampleRoot, "integration/check-authoritative-load.mjs");

test("independent snapshot streams may reorder while control stays ordered", () => {
  const makeNetwork = () =>
    new ImpairedNetwork({
      ...LOAD_HARNESS_CONFIG,
      seed: 4,
      baseLatencyMilliseconds: 100,
      jitterMilliseconds: 100,
      downlinkBitsPerSecond: 1_000_000,
    });
  const snapshotNetwork = makeNetwork();
  const snapshots = [];
  const snapshotReceiver = {
    onReliable(_channel, payload) {
      snapshots.push(payload[0]);
    },
    onDatagram() {},
    onClose() {},
  };
  void snapshotNetwork.enqueue(
    1,
    "server-to-client",
    snapshotReceiver,
    "reliable",
    Uint8Array.of(1),
    TRANSPORT_CHANNEL_SNAPSHOT,
  );
  void snapshotNetwork.enqueue(
    1,
    "server-to-client",
    snapshotReceiver,
    "reliable",
    Uint8Array.of(2),
    TRANSPORT_CHANNEL_SNAPSHOT,
  );
  snapshotNetwork.advanceTo(500);
  assert.deepEqual(snapshots, [2, 1]);
  assert.equal(snapshotNetwork.stats.reorderedSnapshotStreams, 1);
  assert.equal(snapshotNetwork.stats.reliableOrderViolations, 0);

  const controlNetwork = makeNetwork();
  const controls = [];
  const controlReceiver = {
    onReliable(_channel, payload) {
      controls.push(payload[0]);
    },
    onDatagram() {},
    onClose() {},
  };
  void controlNetwork.enqueue(
    1,
    "server-to-client",
    controlReceiver,
    "reliable",
    Uint8Array.of(1),
    TRANSPORT_CHANNEL_CONTROL,
  );
  void controlNetwork.enqueue(
    1,
    "server-to-client",
    controlReceiver,
    "reliable",
    Uint8Array.of(2),
    TRANSPORT_CHANNEL_CONTROL,
  );
  controlNetwork.advanceTo(500);
  assert.deepEqual(controls, [1, 2]);
  assert.equal(controlNetwork.stats.reliableOrderViolations, 0);
});

test("clean 16-client active-play corrections exclude the forced convergence probe", async () => {
  const evidence = await runAuthoritativeLoadHarness({
    ...LOAD_HARNESS_CONFIG,
    players: 16,
    baseLatencyMilliseconds: 0,
    jitterMilliseconds: 0,
    datagramLossPercent: 0,
    uplinkBitsPerSecond: 10_000_000,
    downlinkBitsPerSecond: 10_000_000,
    minimumInputAcceptanceRatio: 0.99,
  });
  const workload = evidence.clients.workloadCorrections;
  // Collision with other predicted tanks can disagree with the server even
  // on localhost. Keep that simulation-error signal, but test the sampled
  // presentation pose separately: correction is eased before it is rendered.
  assert.ok(workload.localCorrectionBuckets.slice(5).reduce((sum, count) => sum + count, 0) <= 16);
  assert.equal(workload.localCorrectionBuckets[7], 0, "clean localhost has no >32-pixel prediction correction");
  assert.ok(workload.maximumLocalCorrectionMagnitude <= 32 * UNITS_PER_PIXEL);
  assert.equal(workload.localPresentedStepsOverThirtyTwoPixels, 0);
  assert.ok(workload.maximumLocalPresentedStepDistance <= 16 * UNITS_PER_PIXEL);
  assert.ok(evidence.clients.maximumLocalCorrectionMagnitude >= workload.maximumLocalCorrectionMagnitude);
  assert.ok(
    evidence.clients.localCorrectionBuckets.reduce((sum, count) => sum + count, 0) >
      workload.localCorrectionBuckets.reduce((sum, count) => sum + count, 0),
    "the convergence probe adds samples but does not contaminate the active-play distribution",
  );
  assert.equal(evidence.server.inputsLate, 0);
  assert.equal(evidence.convergence.allClientsConverged, true);
});

test("16-player edge admission recovers lead before startup corrections dominate", async () => {
  const edge = NETWORK_IMPAIRMENT_PROFILES.find((profile) => profile.name === "edge-congested");
  assert.ok(edge);
  let lateAfterStartup;
  const evidence = await runAuthoritativeLoadHarness(
    { ...edge.config, players: 16 },
    {
      now: () => performance.now(),
      onClientStep({ tick, clientIndex, server }) {
        if (tick === 72 && clientIndex === 0) lateAfterStartup = server.stats.inputsLate;
      },
    },
  );
  assert.ok(evidence.server.inputsLate < 500, "delayed first keyframes must not leave input late for seconds");
  assert.ok(evidence.server.inputAcceptanceRatio > 0.93, "the full run keeps the product input-acceptance floor");
  assert.notEqual(lateAfterStartup, undefined, "the observer samples the settled prediction lead");
  assert.ok(
    evidence.server.inputsLate - lateAfterStartup <= 5,
    "after startup, adaptive lead must stop persistent late inputs",
  );
  assert.ok(evidence.clients.workloadCorrections.localCorrectionBuckets[7] <= 16);
  assert.ok(evidence.clients.workloadCorrections.maximumLocalCorrectionMagnitude <= 64 * UNITS_PER_PIXEL);
  assert.equal(evidence.clients.workloadCorrections.localPresentedStepsOverThirtyTwoPixels, 0);
  assert.ok(evidence.clients.workloadCorrections.maximumLocalPresentedStepDistance <= 16 * UNITS_PER_PIXEL);
  assert.equal(evidence.convergence.allClientsConverged, true);
});

test("authoritative 32-player load evidence is source-bound and fresh", async () => {
  const sourceInputs = await buildAuthoritativeLoadSourceInputs();
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assertAuthoritativeLoadEvidence(evidence, { sourceInputs });
  assert.match(
    execFileSync(process.execPath, [gatePath, "--check-evidence"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    /war-battles-authoritative-load-evidence:fresh:/u,
  );
});

test("impaired load records loss, reordering, bounded queues, and all-client convergence", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.transport.observed.reliableOrderViolations, 0);
  assert.equal(evidence.transport.observed.backpressuredReliable, 0);
  assert.equal(
    evidence.transport.observed.sentReliable,
    evidence.transport.observed.deliveredReliable + evidence.transport.observed.cancelledReliable,
  );
  assert.equal(evidence.transport.observed.cancelledReliable, 0);
  assert.ok(evidence.transport.observed.droppedDatagrams > 0);
  assert.equal(
    evidence.transport.observed.backpressuredDatagrams,
    0,
    "the production 30 Hz input cadence must remain below the modeled queue bound",
  );
  assert.ok(evidence.transport.observed.reorderedDatagrams > 0);
  assert.ok(evidence.transport.observed.maximumSerializationDelayMilliseconds > 0);
  assert.ok(evidence.transport.observed.peakQueuedBytes > 0);
  assert.ok(evidence.transport.observed.clientToServerOfferedBytes > 0);
  assert.ok(evidence.transport.observed.serverToClientOfferedBytes > 0);
  assert.ok(evidence.transport.observed.peakQueue <= evidence.transport.queueBound);
  assert.equal(evidence.transport.pendingQueue, 0);
  assert.equal(evidence.convergence.allClientsConverged, true);
  assert.ok(evidence.server.inputsAccepted > 0);
  assert.ok(evidence.server.inputAcceptanceRatio >= evidence.server.minimumInputAcceptanceRatio);
  // Packet loss and reordering are exercised above. Input lead can prevent
  // every late command even under that impairment; keep the identity below.
  assert.ok(Number.isInteger(evidence.server.inputsLate) && evidence.server.inputsLate >= 0);
  assert.equal(
    evidence.server.inputsAccepted + evidence.server.inputsLate + evidence.server.inputCommandsUnobserved,
    evidence.server.generatedInputCommands,
  );
  assert.ok(evidence.clients.minInputLeadTicks > 2);
  assert.ok(evidence.clients.maxInputLeadTicks <= 16);
  assert.equal(
    evidence.clients.rows.every(
      (row) =>
        row.inputsSent + row.inputsDropped ===
        Math.ceil(
          (evidence.config.ticks + row.inputLeadIncreases - row.inputLeadCatchdownSkips) /
            evidence.clients.inputSendIntervalTicks,
        ),
    ),
    true,
  );
  assert.equal(evidence.clients.maximumRemoteInterpolationDiscontinuity, 0);
  assert.ok(evidence.clients.totalInputLeadDecreases > 0);
  assert.ok(evidence.clients.maximumLocalCorrectionMagnitude > 0);
  assert.ok(evidence.clients.totalRemoteInterpolationRebases > 0);
  assert.ok(evidence.clients.maximumRemoteInterpolationRebaseDistance > 0);
  assert.ok(evidence.clients.totalRemoteLifecycleHardSnaps > 0);
  assert.equal(
    evidence.clients.rows.every((row) => row.inputsSent > 0 && row.snapshotsApplied > 0),
    true,
  );
});
