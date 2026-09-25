import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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
