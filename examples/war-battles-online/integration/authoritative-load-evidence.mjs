import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const exampleRoot = resolve(integrationRoot, "..");
const repositoryRoot = resolve(exampleRoot, "../..");

export const AUTHORITATIVE_LOAD_OWNER = "examples/war-battles-online/integration/check-authoritative-load.mjs";

export const AUTHORITATIVE_LOAD_SOURCE_PATHS = Object.freeze([
  "examples/war-battles-online/core",
  "examples/war-battles-online/integration/authoritative-load-harness.ts",
  "examples/war-battles-online/integration/authoritative-load-evidence.mjs",
  "examples/war-battles-online/integration/check-authoritative-load.mjs",
  "examples/war-battles-online/package.json",
  "package.json",
  "pnpm-lock.yaml",
]);

async function fileInput(path) {
  const bytes = await readFile(resolve(repositoryRoot, path));
  return { path, kind: "file", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function treeInput(path) {
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
    assert.equal(metadata.isFile(), true, `unsupported authoritative load input: ${absolute}`);
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

export async function buildAuthoritativeLoadSourceInputs() {
  return Promise.all(
    AUTHORITATIVE_LOAD_SOURCE_PATHS.map((path) => (path.endsWith("/core") ? treeInput(path) : fileInput(path))),
  );
}

export function digestAuthoritativeLoadSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

export function assertAuthoritativeLoadEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 2);
  assert.equal(document?.kind, "war-battles.authoritative-32-player-load");
  assert.equal(document?.owner, AUTHORITATIVE_LOAD_OWNER);
  assert.equal(document?.generator, AUTHORITATIVE_LOAD_OWNER);
  if (sourceInputs !== undefined) {
    assert.deepEqual(document.sourceInputs, sourceInputs, "authoritative load evidence source inventory is stale");
    assert.equal(
      document.sourceKey,
      digestAuthoritativeLoadSourceInputs(sourceInputs),
      "authoritative load source key is stale",
    );
  }
  assert.equal(document.config?.players, 32);
  assert.equal(document.server?.rosterSize, 32);
  assert.equal(document.server?.humans, 32);
  assert.equal(document.server?.bots, 0);
  assert.equal(document.clients?.count, 32);
  assert.equal(document.clients?.ready, 32);
  assert.equal(document.clients?.rows?.length, 32);
  assert.equal(document.convergence?.allClientsConverged, true);
  assert.equal(document.convergence?.uniquePlayerIds, 32);
  assert.equal(document.errors?.uncaught, 0);
  assert.deepEqual(document.errors?.server, []);
  assert.deepEqual(document.errors?.clients, []);
  assert.equal(document.transport?.pendingQueue, 0);
  assert.equal(document.transport?.observed?.backpressuredReliable, 0);
  assert.equal(
    document.transport?.observed?.sentReliable,
    document.transport?.observed?.deliveredReliable + document.transport?.observed?.cancelledReliable,
  );
  assert.equal(document.transport?.observed?.cancelledReliable, 0);
  assert.equal(document.transport?.uplinkBitsPerSecond, document.config?.uplinkBitsPerSecond);
  assert.equal(document.transport?.downlinkBitsPerSecond, document.config?.downlinkBitsPerSecond);
  assert.match(document.transport?.capBoundary, /application payload/u);
  assert.ok(
    Math.abs(document.transport?.workload?.durationMilliseconds - document.config?.ticks * (1_000 / 60)) < 1e-6,
  );
  assert.ok(document.transport?.workload?.bytes?.serialized > 0);
  assert.equal(
    document.transport?.workload?.bytes?.serialized,
    document.transport?.workload?.bytes?.clientToServerSerialized +
      document.transport?.workload?.bytes?.serverToClientSerialized,
  );
  assert.ok(document.transport?.observed?.clientToServerOfferedBytes > 0);
  assert.ok(document.transport?.observed?.serverToClientOfferedBytes > 0);
  assert.ok(document.transport?.observed?.clientToServerSerializedBytes > 0);
  assert.ok(document.transport?.observed?.serverToClientSerializedBytes > 0);
  assert.equal(
    document.transport?.observed?.serializedBytes,
    document.transport?.observed?.clientToServerSerializedBytes +
      document.transport?.observed?.serverToClientSerializedBytes,
  );
  assert.equal(
    document.transport?.observed?.offeredBytes,
    document.transport?.observed?.serializedBytes + document.transport?.observed?.backpressuredBytes,
  );
  assert.equal(
    document.transport?.observed?.serializedBytes,
    document.transport?.observed?.deliveredBytes +
      document.transport?.observed?.droppedBytes +
      document.transport?.observed?.cancelledReliableBytes,
  );
  assert.equal(document.transport?.observed?.cancelledReliableBytes, 0);
  assert.ok(document.transport?.observed?.maximumSerializationDelayMilliseconds > 0);
  assert.ok(document.transport?.observed?.peakQueuedBytes > 0);
  assert.ok(document.transport?.observed?.deliveredDatagrams > 0);
  assert.ok(document.transport?.observed?.droppedDatagrams > 0);
  // At the production 30 Hz input cadence the deterministic 42 +/- 25 ms link
  // must remain below its four-datagram bound. Dedicated transport tests force
  // saturation; this load trace proves the ordinary cadence avoids it.
  assert.equal(document.transport?.observed?.backpressuredDatagrams, 0);
  assert.ok(document.transport?.observed?.reorderedDatagrams > 0);
  assert.equal(document.server?.minimumInputAcceptanceRatio, document.config?.minimumInputAcceptanceRatio);
  assert.equal(document.config?.minimumInputAcceptanceRatio, 0.93);
  assert.ok(document.server?.inputAcceptanceRatio >= document.server.minimumInputAcceptanceRatio);
  assert.ok(document.server?.inputsLate > 0, "deterministic impairment must exercise unique late-input accounting");
  assert.ok(document.server?.inputCommandsUnobserved >= 0);
  assert.equal(
    document.server?.inputsAccepted + document.server?.inputsLate + document.server?.inputCommandsUnobserved,
    document.server?.generatedInputCommands,
  );
  assert.equal(document.server?.inputLateRatio, document.server?.inputsLate / document.server?.generatedInputCommands);
  assert.equal(
    document.server?.generatedInputCommands,
    document.clients.rows.reduce(
      (total, row) => total + document.config.ticks + row.inputLeadIncreases - row.inputLeadCatchdownSkips,
      0,
    ),
  );
  assert.equal(document.clients?.inputSendIntervalTicks, 2);
  assert.ok(document.clients?.minimumAttemptedInputDatagrams > 0);
  assert.ok(document.clients?.maximumAttemptedInputDatagrams >= document.clients?.minimumAttemptedInputDatagrams);
  assert.ok(document.clients?.minInputLeadTicks > 2);
  assert.ok(document.clients?.maxInputLeadTicks <= 16);
  assert.ok(Number.isInteger(document.clients?.totalInputLeadDecreases));
  assert.ok(document.clients.totalInputLeadDecreases > 0, "impaired load must exercise lead recovery");
  assert.ok(Number.isInteger(document.clients?.maximumLocalCorrectionMagnitude));
  assert.ok(document.clients.maximumLocalCorrectionMagnitude > 0, "impaired load must exercise local reconciliation");
  assert.ok(Number.isInteger(document.clients?.totalRemoteInterpolationRebases));
  assert.ok(document.clients.totalRemoteInterpolationRebases > 0, "impaired load must exercise in-flight rebasing");
  assert.ok(Number.isInteger(document.clients?.maximumRemoteInterpolationRebaseDistance));
  assert.ok(document.clients.maximumRemoteInterpolationRebaseDistance > 0);
  assert.equal(document.clients?.maximumRemoteInterpolationDiscontinuity, 0);
  assert.ok(Number.isInteger(document.clients?.totalRemoteLifecycleHardSnaps));
  assert.ok(document.clients.totalRemoteLifecycleHardSnaps > 0, "load must exercise lifecycle discontinuities");
  assert.ok(
    Number.isInteger(document.transport?.queueBound) &&
      document.transport.observed.peakQueue <= document.transport.queueBound,
  );
  for (const row of document.clients.rows) {
    assert.equal(row.state, "ready");
    assert.equal(row.converged, true);
    assert.equal(row.errors, 0);
    assert.equal(
      row.inputsSent + row.inputsDropped,
      Math.ceil(
        (document.config.ticks + row.inputLeadIncreases - row.inputLeadCatchdownSkips) /
          document.clients.inputSendIntervalTicks,
      ),
    );
    assert.equal(row.inputLeadTicks, row.inputLeadIncreases - row.inputLeadDecreases + 2);
    assert.ok(row.inputLeadCatchdownSkips <= row.inputLeadDecreases);
    assert.ok(Number.isInteger(row.maximumLocalCorrectionMagnitude) && row.maximumLocalCorrectionMagnitude >= 0);
    assert.ok(Number.isInteger(row.remoteInterpolationRebases) && row.remoteInterpolationRebases >= 0);
    assert.ok(
      Number.isInteger(row.maximumRemoteInterpolationRebaseDistance) &&
        row.maximumRemoteInterpolationRebaseDistance >= 0,
    );
    assert.equal(row.maximumRemoteInterpolationDiscontinuity, 0);
    assert.ok(Number.isInteger(row.remoteLifecycleHardSnaps) && row.remoteLifecycleHardSnaps >= 0);
    assert.equal(row.rateLimitAdvisories, 0);
  }
  return document;
}
