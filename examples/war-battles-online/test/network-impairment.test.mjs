import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { LOAD_HARNESS_CONFIG, runAuthoritativeLoadHarness } from "../integration/authoritative-load-harness.ts";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const evidencePath = path.join(exampleRoot, "evidence/network-impairment-32.json");

test("32-player capped-link matrix is source-bound and reproducible", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.profiles.length, 3);
  assert.equal(
    evidence.profiles.every((profile) => profile.convergence.allClientsConverged),
    true,
  );
  assert.match(
    execFileSync(process.execPath, ["integration/check-network-impairment.mjs", "--check-evidence"], {
      cwd: exampleRoot,
      encoding: "utf8",
    }),
    /war-battles-network-impairment:fresh:/u,
  );
});

test("per-session late feedback improves a severe link without raising healthy-link lead", async () => {
  const run = async (latency, jitter, loss) =>
    runAuthoritativeLoadHarness({
      ...LOAD_HARNESS_CONFIG,
      players: 1,
      ticks: 600,
      baseLatencyMilliseconds: latency,
      jitterMilliseconds: jitter,
      datagramLossPercent: loss,
      uplinkBitsPerSecond: 1_000_000,
      downlinkBitsPerSecond: 1_000_000,
      minimumInputAcceptanceRatio: 0,
    });
  const moderate = await run(65, 15, 10);
  assert.equal(moderate.server.inputsLate, 0);
  assert.equal(moderate.clients.maxInputLeadTicks, 8);
  const severe = await run(120, 60, 20);
  assert.ok(severe.server.inputsLate <= 13, `authority saw ${severe.server.inputsLate} late inputs`);
  assert.ok(severe.server.inputsAccepted >= 550);
  assert.ok(severe.clients.maxInputLeadTicks >= 12);
  assert.equal(severe.clients.workloadCorrections.localPresentedStepsOverThirtyTwoPixels, 0);
  assert.equal(severe.convergence.allClientsConverged, true);
});
