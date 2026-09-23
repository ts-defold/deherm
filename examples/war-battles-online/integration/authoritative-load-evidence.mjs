import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const exampleRoot = resolve(integrationRoot, "..");
const repositoryRoot = resolve(exampleRoot, "../..");

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
      files.push({ path: local, kind: "symlink", bytes: target.byteLength, sha256: createHash("sha256").update(target).digest("hex") });
      bytes += target.byteLength;
      return;
    }
    assert.equal(metadata.isFile(), true, `unsupported authoritative load input: ${absolute}`);
    const contents = await readFile(absolute);
    files.push({ path: local, kind: "file", bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") });
    bytes += contents.byteLength;
  }
  await visit(root, "");
  return { path, kind: "tree", fileCount: files.length, bytes, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

export async function buildAuthoritativeLoadSourceInputs() {
  return Promise.all(AUTHORITATIVE_LOAD_SOURCE_PATHS.map((path) => path.endsWith("/core") ? treeInput(path) : fileInput(path)));
}

export function digestAuthoritativeLoadSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

export function assertAuthoritativeLoadEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 1);
  assert.equal(document?.kind, "war-battles.authoritative-32-player-load");
  if (sourceInputs !== undefined) {
    assert.deepEqual(document.sourceInputs, sourceInputs, "authoritative load evidence source inventory is stale");
    assert.equal(document.sourceKey, digestAuthoritativeLoadSourceInputs(sourceInputs), "authoritative load source key is stale");
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
  assert.equal(document.transport?.observed?.sentReliable, document.transport?.observed?.deliveredReliable);
  assert.ok(document.transport?.observed?.deliveredDatagrams > 0);
  assert.ok(document.transport?.observed?.droppedDatagrams > 0);
  assert.ok(document.transport?.observed?.backpressuredDatagrams > 0);
  assert.ok(document.transport?.observed?.reorderedDatagrams > 0);
  assert.ok(Number.isInteger(document.transport?.queueBound) && document.transport.observed.peakQueue <= document.transport.queueBound);
  for (const row of document.clients.rows) {
    assert.equal(row.state, "ready");
    assert.equal(row.converged, true);
    assert.equal(row.errors, 0);
    assert.equal(row.inputsSent + row.inputsDropped, document.config.ticks);
  }
  return document;
}
