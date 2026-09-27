import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { indexDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";

const root = new URL("../", import.meta.url);
const generated = (name) => new URL(`packages/bindings/generated/${name}`, root);
const readJson = async (name) => JSON.parse(await readFile(generated(name), "utf8"));

const familyReports = Object.freeze([
  ["span.fixed-output-digest", "defold-dmsdk-fixed-digest-bindings.json"],
  ["span.bounded-byte-transform", "defold-dmsdk-base64-span-bindings.json"],
  ["span.fixed-three-u32-probe", "defold-dmsdk-astc-probe-bindings.json"],
  ["span.in-place-keyed-transform", "defold-dmsdk-xtea-span-bindings.json"],
]);

test("one authenticated bounded-span plan owns every family emitter decision", async () => {
  const planText = await readFile(generated("defold-dmsdk-bounded-span-plan.json"), "utf8");
  const plan = JSON.parse(planText);
  const planHash = createHash("sha256").update(planText).digest("hex");
  const index = indexDmSdkBoundedSpanPlan(plan, { revision: plan.defoldRevision });
  assert.equal(plan.coverage.structurallyRelevant, 10);
  assert.equal(plan.coverage.selected, 10);
  assert.equal(plan.coverage.universalFallback, 0);

  for (const [patternId, reportName] of familyReports) {
    const report = await readJson(reportName);
    for (const entry of report.declarations.filter(({ patternDecision }) => patternDecision === patternId)) {
      const decision = index.get(entry.id);
      assert.ok(decision, `${entry.id} has no compiler-owned decision`);
      assert.equal(decision.patternId, patternId);
      assert.equal(entry.patternDecision, decision.patternId);
    }
    assert.equal(report.sourceHashes.plan, planHash);
  }
});

test("bounded-span family emitters cannot independently invoke the selector", async () => {
  for (const source of [
    "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
    "scripts/generate-dmsdk-base64-span-bindings.mjs",
    "scripts/generate-dmsdk-astc-probe-bindings.mjs",
    "scripts/generate-dmsdk-xtea-span-bindings.mjs",
  ]) {
    const text = await readFile(new URL(source, root), "utf8");
    assert.doesNotMatch(text, /selectDmSdkPattern|compactDmSdkPatternDecision/u, source);
    assert.match(text, /indexDmSdkBoundedSpanPlan/u, source);
  }
});

test("bounded-span plan verification rejects a forged selected pattern", async () => {
  const plan = await readJson("defold-dmsdk-bounded-span-plan.json");
  const forged = structuredClone(plan);
  forged.decisions[0].patternId = "universal.default";
  assert.throws(() => indexDmSdkBoundedSpanPlan(forged), /family differs from its pattern/);
});
