import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generate, loadInputs } from "../scripts/generate-script-opaque-record-blockers.mjs";
const root = new URL("../", import.meta.url);
test("opaque records have exact source-pinned ownership blockers", async () => { execFileSync(process.execPath, ["scripts/generate-script-opaque-record-blockers.mjs", "--check"], { cwd: root, stdio: "pipe" }); const report = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-script-opaque-record-blockers.json", root), "utf8")); assert.equal(report.routeCount, 2); assert.equal(report.candidateCount, 0); assert.match(report.coverageClaim, /command queue/); assert.deepEqual(report.routes.map(({ id }) => id).toSorted(), ["script:render.dispatch_compute", "script:render.draw"]); });
test("opaque blocker generator rejects stale evidence and incomplete coverage", async () => { const inputs = await loadInputs(); const stale = new Map(inputs.sourceTexts); const [path, text] = stale.entries().next().value; stale.set(path, `${text}\n`); assert.throws(() => generate({ ...inputs, sourceTexts: stale }), /pinned opaque-record source drifted/); const incomplete = JSON.parse(inputs.policyText); incomplete.routes.pop(); assert.throws(() => generate({ ...inputs, policyText: JSON.stringify(incomplete) }), /does not cover the complete frontier/); });
