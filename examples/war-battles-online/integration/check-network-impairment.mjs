#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runNetworkImpairmentMatrix } from "./network-impairment-matrix.ts";
import { buildAuthoritativeLoadSourceInputs } from "./authoritative-load-evidence.mjs";

const exampleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(exampleRoot, "../..");
const evidencePath = resolve(exampleRoot, "evidence/network-impairment-32.json");
const matrixSourcePaths = [
  "examples/war-battles-online/integration/network-impairment-matrix.ts",
  "examples/war-battles-online/integration/check-network-impairment.mjs",
];

async function sourceInventory() {
  const matrixInputs = await Promise.all(
    matrixSourcePaths.map(async (path) => {
      const bytes = await readFile(resolve(repositoryRoot, path));
      return {
        path,
        kind: "file",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  return [...(await buildAuthoritativeLoadSourceInputs()), ...matrixInputs];
}

export function assertNetworkImpairmentEvidence(document, expectedSources) {
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.kind, "war-battles.32-player-network-impairment-matrix");
  assert.equal(document.profiles.length, 3);
  assert.deepEqual(document.sourceInputs, expectedSources);
  assert.equal(document.sourceKey, createHash("sha256").update(JSON.stringify(expectedSources)).digest("hex"));
  assert.match(document.evidenceBoundary, /not a QUIC packet capture/u);
  const names = document.profiles.map((profile) => profile.name);
  assert.deepEqual(names, ["broadband-adverse", "mobile-congested", "edge-congested"]);
  for (const profile of document.profiles) {
    assert.equal(profile.config.players, 32);
    assert.equal(profile.convergence.allClientsConverged, true);
    assert.equal(profile.convergence.uniquePlayerIds, 32);
    assert.deepEqual(profile.errors.server, []);
    assert.deepEqual(profile.errors.clients, []);
    assert.equal(profile.errors.protocolErrors, 0);
    assert.ok(profile.server.inputAcceptanceRatio >= profile.server.minimumInputAcceptanceRatio);
    assert.ok(profile.server.snapshotsSent > 0);
    assert.ok(profile.server.snapshotBytesSent > 0);
    assert.ok(profile.clients.minimumSnapshotsApplied >= profile.clients.minimumSnapshotsAppliedFloor);
    assert.equal(profile.clients.everyBotDroveTheProduct, true);
    assert.equal(profile.clients.minimumBotCommandsStaged, profile.config.ticks);
    assert.ok(profile.clients.minimumBotNonIdleCommands >= profile.config.ticks / 2);
    assert.ok(profile.server.snapshotSkipRatio <= profile.server.maximumSnapshotSkipRatio);
    assert.equal(profile.clients.maximumRemoteInterpolationDiscontinuity, 0);
    assert.ok(profile.transport.droppedDatagrams > 0);
    assert.ok(profile.transport.reorderedDatagrams > 0);
    assert.ok(profile.transport.maximumSerializationDelayMilliseconds > 0);
    assert.ok(profile.transport.peakQueue <= profile.transport.queueBound);
    assert.ok(profile.transport.peakQueuedBytes > 0);
    assert.ok(profile.transport.serializedBytes > profile.transport.deliveredBytes);
    assert.ok(profile.transport.serializedUplinkBytesPerSecondPerClient > 0);
    assert.ok(profile.transport.uplinkCapacityUtilization > 0);
    assert.ok(profile.transport.uplinkCapacityUtilization <= 1);
    assert.ok(profile.transport.serializedDownlinkBytesPerSecondPerClient > 0);
    assert.ok(profile.transport.downlinkCapacityUtilization > 0);
    assert.ok(profile.transport.downlinkCapacityUtilization <= 1);
  }
  const edge = document.profiles[2];
  assert.ok(
    edge.transport.maximumSerializationDelayMilliseconds >
      document.profiles[0].transport.maximumSerializationDelayMilliseconds,
  );
  assert.ok(edge.server.snapshotFramesSkippedByBudget > 0);
  assert.ok(edge.transport.backpressuredDatagrams > 0);
  // The edge scheduler sheds snapshot cadence once the cap is saturated, so
  // utilization need not rise monotonically. Instead prove the tighter cap
  // admitted fewer bytes while forcing more cadence shedding than mobile.
  assert.ok(
    edge.transport.serializedDownlinkBytesPerSecondPerClient <
      document.profiles[1].transport.serializedDownlinkBytesPerSecondPerClient,
  );
  assert.ok(edge.server.snapshotSkipRatio > document.profiles[1].server.snapshotSkipRatio);
  assert.ok(
    document.profiles[1].transport.downlinkCapacityUtilization >
      document.profiles[0].transport.downlinkCapacityUtilization,
  );
}

const sourceInputs = await sourceInventory();
const generated = {
  ...(await runNetworkImpairmentMatrix()),
  owner: "examples/war-battles-online/integration/check-network-impairment.mjs",
  generator: "examples/war-battles-online/integration/check-network-impairment.mjs",
  sourceInputs,
  sourceKey: createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex"),
};
assertNetworkImpairmentEvidence(generated, sourceInputs);
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
const mode = process.argv[2] ?? "--record-evidence";
if (mode === "--record-evidence") {
  await writeFile(evidencePath, serialized);
  process.stdout.write(`war-battles-network-impairment:recorded:${evidencePath}\n`);
} else if (mode === "--check-evidence") {
  assert.equal(await readFile(evidencePath, "utf8"), serialized, "network impairment evidence is stale");
  process.stdout.write(`war-battles-network-impairment:fresh:${generated.sourceKey}\n`);
} else if (mode === "--json") {
  process.stdout.write(serialized);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
