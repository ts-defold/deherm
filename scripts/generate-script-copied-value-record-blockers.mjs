#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { stableBindingId } from "./lib/binding-identity.mjs";
import { expectReviewedCount, observeReviewedSource, expectSameRevision, declaredDerivation } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  frontier: new URL("packages/bindings/generated/defold-script-table-record-bindings.json", root),
  policy: new URL("packages/bindings/overrides/script-copied-value-record-blockers.json", root),
  report: new URL("packages/bindings/generated/defold-script-copied-value-record-blockers.json", root),
  target: new URL("packages/sdk/src/generated/script/copied-value-record-blockers.ts", root)
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export async function loadInputs() {
  const [irText, patternsText, frontierText, policyText] = await Promise.all(Object.values(paths).slice(0, 4).map((path) => readFile(path, "utf8")));
  const policy = JSON.parse(policyText);
  const sourceTexts = new Map(await Promise.all(policy.sources.map(async ({ path }) => [path, await readFile(new URL(`upstream/defold/${path}`, root), "utf8")])));
  return { irText, patternsText, frontierText, policyText, sourceTexts };
}

export function generate(inputs) {
  const ir = JSON.parse(inputs.irText), patterns = JSON.parse(inputs.patternsText), frontier = JSON.parse(inputs.frontierText), policy = JSON.parse(inputs.policyText);
  assert(policy.schemaVersion === 1 && Array.isArray(policy.sources) && Array.isArray(policy.routes), "copied-value blocker policy schema is unsupported");
  assert(ir.schemaVersion === 1 && patterns.schemaVersion === 1 && frontier.schemaVersion === 1, "copied-value blocker input schema is unsupported");
  expectSameRevision({
    label: "copied-value record blockers",
    inputs: [
      { path: "packages/bindings/generated/defold-script-api-ir.json", revision: ir.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-patterns.json", revision: patterns.defoldRevision },
      { path: "packages/bindings/generated/defold-script-table-record-bindings.json", revision: frontier.defoldRevision }
    ]
  });
  assert(patterns.sourceSha256 === sha256(inputs.irText), "copied-value blocker patterns are stale against script IR");
  const sourceByKey = new Map();
  for (const source of policy.sources) { const text = inputs.sourceTexts.get(source.path); assert(!sourceByKey.has(source.key), `${source.key}: duplicate copied-value source`); if (observeReviewedSource({ input: "packages/bindings/overrides/script-copied-value-record-blockers.json", id: source.path, source: text ?? null, evidence: source }).status === VOID) continue; sourceByKey.set(source.key, { ...source, text }); }
  const frontierRows = frontier.blockedRoutes.filter(({ blocker }) => blocker === "copied-defold-value-record");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-copied-value-record-blockers.json",
    label: "copied-value frontier census",
    expected: policy.expectedRouteCount, observed: frontierRows.length
  });
  const frontierIds = new Set(frontierRows.map(({ id }) => id)), fnById = new Map(ir.functions.map((fn) => [fn.id, fn]),), patternById = new Map(patterns.bindings.map((row) => [row.id, row]));
  // A reviewed blocker this revision does not bear out - the route left the
  // frontier, or the source anchor its reason rests on is gone - is withdrawn
  // and reported rather than asserted. Fatal where the review was read.
  const withdraw = (id, reason, message) => {
    assert(declaredDerivation(), message);
    recordAudit({ input: "packages/bindings/overrides/script-copied-value-record-blockers.json", id, status: VOID, reason, detail: message });
    return [];
  };
  const seen = new Set(); const routes = policy.routes.flatMap((rule) => {
    assert(!seen.has(rule.id), `${rule.id}: duplicate copied-value blocker`); seen.add(rule.id);
    if (!frontierIds.has(rule.id)) return withdraw(rule.id, "left-frontier", `${rule.id}: route left the copied-value frontier`);
    const source = sourceByKey.get(rule.source), fn = fnById.get(rule.id), pattern = patternById.get(rule.id);
    if (!(source && fn && pattern && Array.isArray(rule.anchors) && rule.anchors.every((anchor) => source.text.includes(anchor)))) {
      return withdraw(rule.id, "stale-anchor", `${rule.id}: copied-value source anchor drifted`);
    }
    assert(pattern.loweringFamily === "lua-table", `${rule.id}: copied-value route is not lua-table`);
    return [{ id: rule.id, stableId: stableBindingId(rule.id), modulePath: fn.modulePath, member: fn.member, parameters: fn.parameters.map(({ rawName, rawType, optional }) => ({ name: rawName, rawType, optional })), returns: fn.returns, blocker: rule.blocker, source: `upstream/defold/${source.path}`, sourceSha256: source.sha256, anchors: rule.anchors }];
  }).sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-copied-value-record-blockers.json",
    label: "copied-value frontier coverage",
    expected: frontierIds.size, observed: [...frontierIds].filter((id) => seen.has(id)).length
  });
  assert(policy.expectedCandidateCount === 0, "copied-value candidate census is unsafe");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-copied-value-record-blockers.json",
    label: "copied-value route census", expected: policy.expectedRouteCount, observed: routes.length
  });
  const blockerCounts = Object.fromEntries([...new Set(routes.map(({ blocker }) => blocker))].sort(compare).map((blocker) => [blocker, routes.filter((route) => route.blocker === blocker).length]));
  const report = { schemaVersion: 1, defoldRevision: ir.defoldRevision, scope: "All copied-Defold-value records blocked by the table-record frontier", routeCount: routes.length, candidateCount: 0, executableCount: 0, blockerCounts, coverageClaim: "No generated runtime is emitted: every route requires captured engine/component/resource/render context or a sparse, discriminator-dependent record schema. A future wave must install exact value, URL/hash, target-context, and sparse-field codecs before promoting any route.", inputEvidence: { scriptIrSha256: sha256(inputs.irText), bindingPatternsSha256: sha256(inputs.patternsText), tableRecordFrontierSha256: sha256(inputs.frontierText), reviewedPolicySha256: sha256(inputs.policyText), defoldSources: policy.sources.map(({ path, sha256: hash }) => ({ path: `upstream/defold/${path}`, sha256: hash })).sort((a, b) => compare(a.path, b.path)) }, routes };
  const target = `// Generated by scripts/generate-script-copied-value-record-blockers.mjs. Do not edit.\nexport const scriptCopiedValueRecordBlockers = ${JSON.stringify(routes.map(({ id, stableId, blocker }) => ({ id, stableId: `0x${stableId.toString(16).padStart(8, "0")}`, blocker })), null, 2)} as const;\nexport const scriptCopiedValueRecordCandidateCount = 0 as const;\nexport function assertScriptCopiedValueRecordTargetSupport(_: number): never { throw new Error("Copied-Defold-value records have no generated provider: see generated blocker metadata"); }\n`;
  return { report, target };
}

export async function run(check = false) { const generated = generate(await loadInputs()); const outputs = [[paths.report, `${JSON.stringify(generated.report, null, 2)}\n`], [paths.target, generated.target]]; for (const [path, expected] of outputs) { if (check) assert(await readFile(path, "utf8") === expected, `${path.pathname}: copied-value blocker output is stale`); else await writeFile(path, expected); } return generated.report; }
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run(process.argv.includes("--check")).then((report) => console.log(`${process.argv.includes("--check") ? "Verified" : "Generated"} ${report.routeCount} copied-value record blockers; ${report.candidateCount} candidates.`)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
