import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generate, loadInputs } from "../scripts/generate-script-copied-value-record-blockers.mjs";

const root = new URL("../", import.meta.url);
test("copied-value frontier is completely source-pinned and blocked", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-copied-value-record-blockers.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const report = JSON.parse(await readFile(new URL("bindings/generated/defold-script-copied-value-record-blockers.json", root), "utf8"));
  assert.equal(report.routeCount, 9); assert.equal(report.candidateCount, 0); assert.equal(report.executableCount, 0);
  assert.deepEqual(report.blockerCounts, { "captured-component-context": 3, "component-resource-url-resolution": 1, "font-resource-and-hash-resolution": 1, "physics-world-and-sparse-variant-record": 1, "physics-world-and-variant-record": 2, "render-context-and-camera-url": 1 });
  assert.match(report.coverageClaim, /No generated runtime is emitted/);
});
test("copied-value generator rejects stale source and incomplete blocker coverage", async () => {
  const inputs = await loadInputs(); const stale = new Map(inputs.sourceTexts); const [path, text] = stale.entries().next().value; stale.set(path, `${text}\n`);
  assert.throws(() => generate({ ...inputs, sourceTexts: stale }), /pinned copied-value source drifted/);
  const incomplete = JSON.parse(inputs.policyText); incomplete.routes.pop();
  assert.throws(() => generate({ ...inputs, policyText: JSON.stringify(incomplete) }), /does not cover the complete frontier/);
});
