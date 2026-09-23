import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertProjectionEnvelope, projectionEnvelope } from "./projections.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");

export const WEBTRANSPORT_OWNER =
  "examples/war-battles-online/integration/check-real-webtransport.mjs";

// Keep the input roots explicit, but hash the complete core tree mechanically.
// A future imported core module therefore invalidates evidence without someone
// having to remember to add another filename to a hand-maintained allowlist.
export const WEBTRANSPORT_SOURCE_PATHS = Object.freeze([
  "examples/war-battles-online/core",
  "examples/war-battles-online/integration/check-real-webtransport.mjs",
  "examples/war-battles-online/integration/projections.mjs",
  "examples/war-battles-online/integration/webtransport-evidence.mjs",
  "examples/war-battles-online/package.json",
  "examples/war-battles-online/server/deno-main.ts",
  "package.json",
  "pnpm-lock.yaml",
  "packages/cli/src/dev/browser-host.mjs",
]);

async function sha256File(repositoryPath) {
  const bytes = await readFile(resolve(repositoryRoot, repositoryPath));
  return {
    path: repositoryPath,
    kind: "file",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function sha256Tree(repositoryPath) {
  const absoluteRoot = resolve(repositoryRoot, repositoryPath);
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
      const target = await readlink(absolute);
      const encoded = Buffer.from(target);
      files.push({ path: local, kind: "symlink", bytes: encoded.byteLength, sha256: createHash("sha256").update(encoded).digest("hex") });
      bytes += encoded.byteLength;
      return;
    }
    assert.equal(metadata.isFile(), true, `unsupported WebTransport evidence input: ${absolute}`);
    const contents = await readFile(absolute);
    files.push({ path: local, kind: "file", bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") });
    bytes += contents.byteLength;
  }
  await visit(absoluteRoot, "");
  assert.ok(files.length > 0, `WebTransport evidence input tree is empty: ${repositoryPath}`);
  return {
    path: repositoryPath,
    kind: "tree",
    fileCount: files.length,
    bytes,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export async function buildWebTransportSourceInputs() {
  return Promise.all(WEBTRANSPORT_SOURCE_PATHS.map((path) =>
    path === "examples/war-battles-online/core" ? sha256Tree(path) : sha256File(path)));
}

export function digestWebTransportSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

function displayPath(absolute) {
  return relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

function assertSourceInventory(document, sourceInputs) {
  assert.deepEqual(document.sourceInputs, sourceInputs, "WebTransport evidence source inventory is stale");
  assert.equal(
    document.sourceKey,
    digestWebTransportSourceInputs(sourceInputs),
    "WebTransport evidence source key is stale",
  );
}

export function assertWebTransportEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 2, "WebTransport evidence schemaVersion must be 2");
  assert.equal(document?.kind, "war-battles.real-webtransport-loopback");
  assert.equal(document?.owner, WEBTRANSPORT_OWNER);
  assert.equal(document?.generator, WEBTRANSPORT_OWNER);
  assertProjectionEnvelope("browser-webtransport-loopback", document);
  if (sourceInputs !== undefined) assertSourceInventory(document, sourceInputs);

  assert.equal(document.transport?.protocol, "webtransport-h3");
  assert.equal(document.transport?.reliableStreams, true);
  assert.equal(document.transport?.datagrams, true);
  assert.ok(Number.isInteger(document.transport?.maxDatagramBytes) && document.transport.maxDatagramBytes >= 32);
  assert.equal(document.rosterSize, 32);
  assert.ok(Number.isInteger(document.playerId) && document.playerId >= 1 && document.playerId <= 32);
  assert.ok(Number.isInteger(document.minimumSnapshotsApplied) && document.minimumSnapshotsApplied >= 3);
  assert.ok(Number.isInteger(document.minimumInputsSent) && document.minimumInputsSent >= 3);
  assert.ok(Number.isInteger(document.observedSnapshotsApplied) &&
    document.observedSnapshotsApplied >= document.minimumSnapshotsApplied);
  assert.ok(Number.isInteger(document.observedInputsSent) &&
    document.observedInputsSent >= document.minimumInputsSent);
  assert.ok(Number.isInteger(document.lastServerTick) && document.lastServerTick >= 0);
  assert.ok(Number.isInteger(document.lastLocalTick) && document.lastLocalTick >= 0);
  assert.deepEqual(document.input, { moveX: 1, moveY: 0, fire: false, boost: false, weapon: 0 });
  assert.ok(document.server?.inputsAcceptedAtLeast >= document.minimumInputsSent);
  assert.ok(Array.isArray(document.server?.markers) && document.server.markers.includes(
    `war-battles-server:stats:inputs-accepted:count=${document.minimumInputsSent}`,
  ));
  assert.equal(document.inputsDropped, 0);
  assert.ok(typeof document.runtime?.deno === "string" && typeof document.runtime?.chrome === "string");
  assert.ok(typeof document.evidenceBoundary === "string" && !document.evidenceBoundary.includes("persistent"));
  return document;
}

export function relativeEvidencePath(path) {
  return displayPath(resolve(exampleRoot, path));
}
