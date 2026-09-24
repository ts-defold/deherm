import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const exampleRoot = resolve(integrationRoot, "..");
const repositoryRoot = resolve(exampleRoot, "../..");

export const RUNTIME_MEASUREMENT_OWNER = "examples/war-battles-online/integration/check-runtime-measurement.mjs";

export const RUNTIME_MEASUREMENT_SOURCE_PATHS = Object.freeze([
  "examples/war-battles-online/core",
  "examples/war-battles-online/integration/authoritative-load-harness.ts",
  "examples/war-battles-online/integration/runtime-measurement-harness.ts",
  "examples/war-battles-online/integration/runtime-measurement-deno.ts",
  "examples/war-battles-online/integration/runtime-measurement-evidence.mjs",
  RUNTIME_MEASUREMENT_OWNER,
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
    assert.equal(metadata.isFile(), true, `unsupported runtime measurement input: ${absolute}`);
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

export async function buildRuntimeMeasurementSourceInputs() {
  return Promise.all(
    RUNTIME_MEASUREMENT_SOURCE_PATHS.map((path) => (path.endsWith("/core") ? hashTree(path) : hashFile(path))),
  );
}

export function digestRuntimeMeasurementSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

function assertSummary(summary, label) {
  assert.ok(Number.isInteger(summary?.samples) && summary.samples > 0, `${label} must contain samples`);
  for (const field of ["minimum", "mean", "p50", "p95", "p99", "maximum"]) {
    assert.equal(typeof summary[field], "number", `${label}.${field} must be numeric`);
    assert.ok(summary[field] >= 0, `${label}.${field} must be non-negative`);
  }
  assert.ok(
    summary.minimum <= summary.p50 &&
      summary.p50 <= summary.p95 &&
      summary.p95 <= summary.p99 &&
      summary.p99 <= summary.maximum,
    `${label} percentile order is invalid`,
  );
}

export function assertRuntimeMeasurementEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 1);
  assert.equal(document?.kind, "war-battles.runtime-performance-measurement");
  assert.equal(document?.runtime?.wallClockObserved, true);
  assert.equal(document?.runtime?.clock, "performance.now");
  assert.equal(document?.runtime?.clockUnit, "milliseconds");
  assert.equal(document?.workload?.deterministicEvidenceSeparate, true);
  assertSummary(document?.authoritativeServer?.samples, "authoritativeServer.samples");
  assert.equal(document?.allocations?.measured, false);
  assert.equal(document?.allocations?.zeroClaim, false);
  assert.equal(document?.allocations?.perTick, null);
  const memory = document?.memory;
  assert.equal(typeof memory?.observed, "boolean");
  if (memory?.observed) {
    assert.equal(typeof memory.source, "string");
    assert.ok(memory.samples > 0);
    assert.ok(memory.values && typeof memory.values === "object");
  } else {
    assert.equal(memory?.values, null);
    assert.equal(typeof memory?.unavailable, "string");
  }
  const browser = document?.browser;
  assert.equal(typeof browser?.observed, "boolean");
  if (browser?.observed) {
    assert.equal(typeof browser.timing?.navigationDurationMs, "number");
    assert.ok(browser.timing.navigationDurationMs >= 0);
    if (browser.memory?.observed) assert.equal(typeof browser.memory.jsHeapUsedBytes, "number");
    else assert.equal(typeof browser.memory?.unavailable, "string");
  } else {
    assert.equal(browser?.timing, null);
    assert.equal(browser?.memory, null);
    assert.equal(typeof browser?.unavailable, "string");
  }
  if (sourceInputs !== undefined) {
    assert.deepEqual(document.sourceInputs, sourceInputs, "runtime measurement source inventory is stale");
    assert.equal(
      document.sourceKey,
      digestRuntimeMeasurementSourceInputs(sourceInputs),
      "runtime measurement source key is stale",
    );
  }
  return document;
}
