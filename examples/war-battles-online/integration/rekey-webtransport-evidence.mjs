#!/usr/bin/env node

// One-time, fail-closed provenance migration. It changes no browser or server
// observation; only an overbroad root-manifest input and this metadata helper.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWebTransportEvidence,
  buildWebTransportSourceInputs,
  digestWebTransportSourceInputs,
} from "./webtransport-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const evidencePath = path.join(root, "examples/war-battles-online/evidence/webtransport-quic-loopback.json");
const baseCommit = "6151f80ba7faabc5603ebeb1cb6d828954200b38";
const previousKey = "6a920156d778d485795f01968af7f02217dfb07a9c22a4b63e0efd1f4bedae5a";
const observationsDigest = "2695a325fda06fc49aa0673d9f963f1395f1deae484e72748854aeff7115ee68";
const helperPath = "examples/war-battles-online/integration/webtransport-evidence.mjs";

function committed(pathname) {
  return execFileSync("git", ["show", `${baseCommit}:${pathname}`], { cwd: root });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function observationDigest(document) {
  const copy = structuredClone(document);
  delete copy.sourceInputs;
  delete copy.sourceKey;
  delete copy.sourceMetadataRekey;
  return digest(JSON.stringify(copy));
}

function runtimeManifestFields(bytes) {
  const value = JSON.parse(bytes);
  return Object.fromEntries(
    ["name", "version", "type", "dependencies", "devDependencies", "optionalDependencies", "engines", "packageManager"]
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, value[field]]),
  );
}

const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
assert.equal(observationDigest(recorded), observationsDigest, "runtime observations changed during source rekey");
const current = await buildWebTransportSourceInputs();
if (recorded.sourceKey === digestWebTransportSourceInputs(current)) {
  assertWebTransportEvidence(recorded, { sourceInputs: current });
  console.log("webtransport-evidence:source-rekey:current");
  process.exit(0);
}
assert.equal(recorded.sourceKey, previousKey, "recorded evidence is not the declared migration input");
assert.equal(digestWebTransportSourceInputs(recorded.sourceInputs), previousKey);
const oldRows = new Map(recorded.sourceInputs.map((row) => [row.path, row]));
for (const row of current) {
  if (row.path === helperPath) continue;
  assert.deepEqual(row, oldRows.get(row.path), `${row.path} changed; fresh runtime evidence is required`);
}
assert.deepEqual(
  [...oldRows.keys()].filter((pathname) => !current.some((row) => row.path === pathname)),
  ["package.json"],
);
for (const pathname of ["package.json", helperPath]) {
  const bytes = committed(pathname);
  const old = oldRows.get(pathname);
  assert.equal(old.sha256, digest(bytes), `${pathname} does not match the original recorded source`);
  assert.equal(old.bytes, bytes.byteLength);
}
assert.deepEqual(
  runtimeManifestFields(committed("package.json")),
  runtimeManifestFields(await readFile(path.join(root, "package.json"))),
  "root package runtime/dependency fields changed; fresh runtime evidence is required",
);
const oldHelper = committed(helperPath).toString("utf8");
const expectedHelper = oldHelper.replace(
  '  "package.json",\n',
  "  // Root CLI script changes do not affect this game/transport observation;\n" +
    "  // dependency resolution remains pinned by the lockfile below.\n",
);
assert.notEqual(expectedHelper, oldHelper);
assert.equal(await readFile(path.join(root, helperPath), "utf8"), expectedHelper);

const rekeyed = {
  ...recorded,
  sourceInputs: current,
  sourceKey: digestWebTransportSourceInputs(current),
  sourceMetadataRekey: {
    baseCommit,
    previousKey,
    scope: "provenance-only: root task scripts removed; browser/server observations unchanged",
  },
};
assert.equal(observationDigest(rekeyed), observationsDigest);
assertWebTransportEvidence(rekeyed, { sourceInputs: current });
await writeFile(evidencePath, `${JSON.stringify(rekeyed, null, 2)}\n`);
console.log(`webtransport-evidence:source-rekey:${rekeyed.sourceKey}`);
