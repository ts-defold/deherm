import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertWebTransportEvidence,
  buildWebTransportSourceInputs,
  WEBTRANSPORT_SOURCE_PATHS,
} from "../integration/webtransport-evidence.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/webtransport-quic-loopback.json");
const gatePath = path.join(exampleRoot, "integration/check-real-webtransport.mjs");

test("WebTransport evidence is source-bound and statically fresh", async () => {
  const sourceInputs = await buildWebTransportSourceInputs();
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assertWebTransportEvidence(evidence, { sourceInputs });
  assert.deepEqual(sourceInputs.map(({ path: sourcePath }) => sourcePath), [...WEBTRANSPORT_SOURCE_PATHS]);
  assert.match(execFileSync(process.execPath, [gatePath, "--check-sources"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }), /war-battles-webtransport-sources:fresh:/u);
  assert.match(execFileSync(process.execPath, [gatePath, "--check-evidence"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }), /war-battles-webtransport-evidence:fresh:/u);
});

test("WebTransport evidence source inventory names every gate input", () => {
  for (const required of [
    "examples/war-battles-online/core",
    "examples/war-battles-online/server/deno-main.ts",
    "examples/war-battles-online/integration/check-real-webtransport.mjs",
    "packages/cli/src/dev/browser-host.mjs",
    "examples/war-battles-online/package.json",
    "package.json",
    "pnpm-lock.yaml",
  ]) assert.ok(WEBTRANSPORT_SOURCE_PATHS.includes(required), required);
});

test("WebTransport evidence retains observations and server-side acceptance", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.ok(evidence.observedSnapshotsApplied >= evidence.minimumSnapshotsApplied);
  assert.ok(evidence.observedInputsSent >= evidence.minimumInputsSent);
  assert.equal(evidence.server.inputsAcceptedAtLeast, evidence.minimumInputsSent);
  assert.ok(evidence.server.markers.includes("war-battles-server:stats:inputs-accepted:count=3"));
  assert.match(evidence.evidenceBoundary, /persistence is not claimed/u);
});
