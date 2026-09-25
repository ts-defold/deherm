import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const exampleRoot = resolve(integrationRoot, "..");
const repositoryRoot = resolve(exampleRoot, "../..");

export const PERFORMANCE_OWNER = "examples/war-battles-online/integration/check-performance.mjs";

export const PERFORMANCE_SOURCE_PATHS = Object.freeze([
  "examples/war-battles-online/core",
  "examples/war-battles-online/integration/performance-harness.ts",
  "examples/war-battles-online/integration/performance-evidence.mjs",
  PERFORMANCE_OWNER,
]);

async function hashFile(path) {
  const bytes = await readFile(resolve(repositoryRoot, path));
  return { path, kind: "file", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function hashTree(path) {
  const root = resolve(repositoryRoot, path);
  const files = [];
  let bytes = 0;
  async function visit(absolute, local) {
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(resolve(absolute, entry.name), local === "" ? entry.name : `${local}/${entry.name}`);
      }
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      files.push({
        path: local,
        kind: "symlink",
        bytes: target.byteLength,
        sha256: createHash("sha256").update(target).digest("hex"),
      });
      bytes += target.byteLength;
      return;
    }
    assert.equal(metadata.isFile(), true, `unsupported performance evidence input: ${absolute}`);
    const contents = await readFile(absolute);
    files.push({
      path: local,
      kind: "file",
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
    bytes += contents.byteLength;
  }
  await visit(root, "");
  return {
    path,
    kind: "tree",
    fileCount: files.length,
    bytes,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export async function buildPerformanceSourceInputs() {
  return Promise.all(
    PERFORMANCE_SOURCE_PATHS.map((path) => (path.endsWith("/core") ? hashTree(path) : hashFile(path))),
  );
}

export function digestPerformanceSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

export function assertPerformanceEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 1);
  assert.equal(document?.kind, "war-battles.performance-operability");
  assert.equal(document?.owner, PERFORMANCE_OWNER);
  assert.equal(document?.generator, PERFORMANCE_OWNER);
  assert.equal(document?.config?.players, 32);
  assert.equal(document?.config?.ticks, 600);
  assert.equal(document?.config?.warmupTicks, 60);
  assert.equal(document?.timings?.unit, "deterministic-work-units");
  assert.equal(document?.timings?.wallClockObserved, false);
  for (const phase of ["simulation", "frame"]) {
    assert.ok(Number.isInteger(document.timings[phase].samples) && document.timings[phase].samples > 0);
    assert.ok(document.timings[phase].p50 <= document.timings[phase].p95);
    assert.ok(document.timings[phase].p95 <= document.timings[phase].p99);
  }
  assert.ok(document.snapshotBandwidth.frames > 0);
  assert.equal(document.snapshotBandwidth.totalBytes > 0, true);
  assert.equal(
    document.snapshotBandwidth.keyframes + document.snapshotBandwidth.deltas,
    document.snapshotBandwidth.frames,
  );
  const attribution = document.snapshotBandwidth.byteAttribution;
  assert.equal(
    Object.values(attribution).reduce((sum, value) => sum + value, 0),
    document.snapshotBandwidth.totalBytes,
    "snapshot byte attribution must account for every application payload byte",
  );
  assert.equal(
    document.snapshotBandwidth.bitsPerSimulatedSecond,
    document.snapshotBandwidth.bytesPerSimulatedSecond * 8,
  );
  assert.equal(
    document.snapshotBandwidth.aggregateServerPayloadBytesPerSecond,
    document.snapshotBandwidth.bytesPerSimulatedSecond * document.config.players,
  );
  assert.equal(
    document.snapshotBandwidth.aggregateServerPayloadBitsPerSecond,
    document.snapshotBandwidth.aggregateServerPayloadBytesPerSecond * 8,
  );
  assert.equal(
    document.snapshotBandwidth.aggregateInputPayloadBytesPerSecond,
    document.snapshotBandwidth.inputPayloadBytesPerSecondPerClient * document.config.players,
  );
  assert.equal(document.snapshotBandwidth.targets.downstreamBytesPerSecondPerClient, 24_000);
  assert.equal(document.snapshotBandwidth.targets.downstreamStretchBytesPerSecondPerClient, 8_000);
  assert.equal(document.snapshotBandwidth.targets.upstreamBytesPerSecondPerClient, 6_000);
  assert.equal(document.snapshotBandwidth.targets.worstCaseDownstreamBytesPerSecondPerClient, 64_000);
  assert.equal(
    document.snapshotBandwidth.targets.downstreamTargetSatisfied,
    document.snapshotBandwidth.bytesPerSimulatedSecond <=
      document.snapshotBandwidth.targets.downstreamBytesPerSecondPerClient,
  );
  assert.equal(
    document.snapshotBandwidth.targets.upstreamTargetSatisfied,
    document.snapshotBandwidth.inputPayloadBytesPerSecondPerClient <=
      document.snapshotBandwidth.targets.upstreamBytesPerSecondPerClient,
  );
  assert.equal(
    document.snapshotBandwidth.worstCaseBound.bytesPerSecondPerClient,
    document.snapshotBandwidth.fixedFrameCapacity * document.snapshotBandwidth.worstCaseBound.framesPerSecond,
  );
  assert.equal(
    document.snapshotBandwidth.targets.worstCaseDownstreamTargetSatisfied,
    document.snapshotBandwidth.worstCaseBound.bytesPerSecondPerClient <=
      document.snapshotBandwidth.targets.worstCaseDownstreamBytesPerSecondPerClient,
  );
  assert.match(document.snapshotBandwidth.evidenceBoundary, /QUIC/u);
  assert.ok(document.reconciliation.samples > 0);
  assert.equal(document.reconciliation.postRestoreError, 0);
  assert.ok(document.reconciliation.correctedSnapshots > 0);
  assert.equal(document.fixedPools.players.highWater, 32);
  assert.ok(document.fixedPools.projectiles.highWater <= document.fixedPools.projectiles.capacity);
  assert.ok(document.fixedPools.presentationEvents.highWater <= document.fixedPools.presentationEvents.capacity);
  assert.equal(
    document.fixedPools.presentationEvents.failures,
    document.fixedPools.presentationEvents.droppedByOverflow,
  );
  assert.equal(document.fixedPools.snapshotFrame.failures, 0);
  assert.equal(document.fixedPools.arena.observable, false);
  assert.equal(document.fixedPools.arena.failures, null);
  assert.equal(document.allocationShape.vmAllocationsMeasured, false);
  assert.equal(document.allocationShape.simulationHotPath.sourceInspectionImplemented, false);
  assert.equal(document.allocationShape.simulationHotPath.explicitHeapAllocationsPerTick, null);
  assert.equal(document.allocationShape.simulationHotPath.dynamicContainerGrowthPerTick, null);
  if (sourceInputs !== undefined) {
    assert.deepEqual(document.sourceInputs, sourceInputs, "performance evidence source inventory is stale");
    assert.equal(document.sourceKey, digestPerformanceSourceInputs(sourceInputs), "performance source key is stale");
  }
  return document;
}
