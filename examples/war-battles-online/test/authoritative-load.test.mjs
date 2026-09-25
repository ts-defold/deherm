import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertAuthoritativeLoadEvidence,
  buildAuthoritativeLoadSourceInputs,
} from "../integration/authoritative-load-evidence.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/authoritative-load-32.json");
const gatePath = path.join(exampleRoot, "integration/check-authoritative-load.mjs");

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
  assert.equal(evidence.transport.observed.sentReliable, evidence.transport.observed.deliveredReliable);
  assert.ok(evidence.transport.observed.droppedDatagrams > 0);
  assert.ok(evidence.transport.observed.backpressuredDatagrams > 0);
  assert.ok(evidence.transport.observed.reorderedDatagrams > 0);
  assert.ok(evidence.transport.observed.peakQueue <= evidence.transport.queueBound);
  assert.equal(evidence.transport.pendingQueue, 0);
  assert.equal(evidence.convergence.allClientsConverged, true);
  assert.ok(evidence.server.inputsAccepted > 0);
  assert.ok(evidence.server.inputAcceptanceRatio >= evidence.server.minimumInputAcceptanceRatio);
  assert.ok(evidence.server.inputsLate > 0);
  assert.equal(
    evidence.server.inputsAccepted + evidence.server.inputsLate + evidence.server.inputCommandsUnobserved,
    evidence.server.generatedInputCommands,
  );
  assert.ok(evidence.clients.minInputLeadTicks > 2);
  assert.ok(evidence.clients.maxInputLeadTicks <= 16);
  assert.equal(
    evidence.clients.rows.every(
      (row) => row.inputsSent + row.inputsDropped === evidence.config.ticks + row.inputLeadIncreases,
    ),
    true,
  );
  assert.equal(
    evidence.clients.rows.every((row) => row.inputsSent > 0 && row.snapshotsApplied > 0),
    true,
  );
});
