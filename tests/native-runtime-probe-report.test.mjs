import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateNativeValueProbeReport } from "../scripts/lib/native-runtime-probe-report.mjs";
import { executionTarget, parseTranscript } from "../scripts/check-headless-conformance.mjs";
import { runtimeEvidenceMatchesPlan } from "../scripts/generate-route-verification.mjs";

const root = new URL("../", import.meta.url);
const report = JSON.parse(await readFile(
  new URL("packages/bindings/generated/defold-script-value-real-engine-probes.json", root),
  "utf8"
));
const bindings = JSON.parse(await readFile(
  new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  "utf8"
));
const routeVerification = JSON.parse(await readFile(
  new URL("packages/bindings/generated/defold-route-verification.json", root),
  "utf8"
));
const policyWorkflow = await readFile(new URL(".github/workflows/policy.yml", root), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("headless reports distinguish the execution host from the planned API target", () => {
  assert.equal(executionTarget("linux", "x64"), "x86_64-linux");
  assert.equal(executionTarget("darwin", "arm64"), "arm64-macos");
  assert.equal(executionTarget("win32", "x64"), "x86_64-win32");
});

test("native runtime accepts complete emitted and planned-only value dispositions", () => {
  const instrumented = validateNativeValueProbeReport(report, bindings);
  assert.equal(instrumented.length, report.instrumentedProbeCount);
  assert.ok(instrumented.every(({ state, expectedMarker }) =>
    state === "instrumented" && typeof expectedMarker === "string"));
  assert.equal(report.routeDispositionCount, report.probeCount + report.plannedFamilyProbeCount);
  // Dispositions cover every binding; a binding with several implemented call
  // shapes legitimately carries several probes.
  assert.equal(new Set([...report.probes, ...report.plannedProbes].map(({ id }) => id)).size,
    bindings.bindingCount);
});

test("native runtime rejects missing, duplicate, and promoted dispositions", () => {
  assert.throws(
    () => validateNativeValueProbeReport({ ...report, routeDispositionCount: report.routeDispositionCount - 1 }, bindings),
    /account for every generated binding/
  );
  const duplicate = structuredClone(report);
  duplicate.plannedProbes[0].id = duplicate.probes[0].id;
  assert.throws(
    () => validateNativeValueProbeReport(duplicate, bindings),
    /cover each binding at least once/
  );
  const promoted = structuredClone(report);
  promoted.plannedProbes[0].state = "instrumented";
  assert.throws(
    () => validateNativeValueProbeReport(promoted, bindings),
    /Unknown non-emitted probe state/
  );
});

test("headless evidence parser ignores incomplete interleaved log markers", () => {
  const parsed = parseTranscript([
    "INFO:DEFOLD_HERMES: deherm-headless-conformance\tcontract_0001ERROR:GAMEOBJECT: interleaved stderr",
    "INFO:DEFOLD_HERMES: deherm-headless-conformance\tcontract_0001\tscript:go.set_parent#required\tresult-arity\tobserved\tundefined"
  ].join("\n"));
  assert.deepEqual(parsed.observations, [{
    contract: "contract_0001",
    route: "script:go.set_parent#required",
    property: "result-arity",
    disposition: "observed",
    detail: "undefined"
  }]);
});

test("route verification marks only contradictions and generator test-shape gaps", () => {
  assert.equal(routeVerification.routeCount, routeVerification.routes.length);
  assert.equal(new Set(routeVerification.routes.map(({ id }) => id)).size, routeVerification.routeCount);

  const marked = routeVerification.routes.filter(({ status }) => status === "suspect" || status === "unproven");
  assert.deepEqual(routeVerification.wantsIssue.map(({ id }) => id), marked.map(({ id }) => id));
  assert.equal(new Set(marked.map(({ issue }) => issue.key)).size, marked.length);
  assert.equal(new Set(marked.map(({ issue }) => issue.title)).size, marked.length);
  for (const row of marked) {
    assert.match(row.annotation, row.status === "suspect" ? /^@suspect / : /^@unverified /);
    assert.match(row.issue.url, /^https:\/\/github\.com\/ts-defold\/deherm\/issues\?/);
    assert.match(row.issue.body, new RegExp(row.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(row.issue.title.includes(routeVerification.defoldRevision.slice(0, 12)), false,
      "issue identity must stay stable when the Defold revision advances");
  }
  assert.ok(routeVerification.routes
    .filter(({ status }) => status === "supported" || status === "executed")
    .every((row) => row.annotation === undefined && row.issue === undefined));

  // Context/profile/effect gaps describe this harness and must not be promoted
  // to a caveat on a route. Missing synthesis/model capability is different:
  // the ordinary generated test cannot be emitted, so it is visibly unproven.
  const contextual = /^(?:context-fixture-missing|route-unavailable-in-runtime-profile|execution-policy-|handle-kind-outside-fixture-profile|harness-effect-guard|compile-time-intrinsic|separate-module-adapter|no-generated-universal-adapter)/;
  const generatorGap = /^(?:unsynthesizable-parameter-type|multi-result-shape-unmodelled|variadic-argument-shape-unmodelled|lua-stack-blocked-capability)/;
  assert.ok(routeVerification.routes
    .filter(({ notExecutedHere }) => contextual.test(notExecutedHere ?? ""))
    .every(({ status }) => status !== "unproven"));
  assert.ok(routeVerification.routes
    .filter(({ notExecutedHere }) => generatorGap.test(notExecutedHere ?? ""))
    .every(({ status }) => status === "unproven"));
});

test("source-backed route contradictions stay suspect and go.set_parent is not a false positive", () => {
  const suspects = routeVerification.routes.filter(({ status }) => status === "suspect");
  assert.deepEqual(suspects.map(({ id }) => id), [
    "script:b2d.body.get_user_data",
    "script:b2d.body.set_user_data",
    "script:sys.set_render_enable"
  ]);
  const setParent = routeVerification.routes.find(({ id }) => id === "script:go.set_parent");
  assert.ok(setParent);
  assert.equal(setParent.registration, "registered");
  assert.equal(setParent.arityDisagreement, undefined);
  assert.notEqual(setParent.status, "suspect");
});

test("route verification never carries runtime observations across a changed plan", () => {
  const report = {
    defoldRevision: "a".repeat(40),
    target: "arm64-macos",
    runtimeProfile: "default",
    planInputs: { "input.json": "old" }
  };
  const plan = {
    target: "arm64-macos",
    runtimeProfile: "default",
    inputs: { "input.json": "old" }
  };
  report.planSha256 = sha256(JSON.stringify(plan));
  assert.equal(runtimeEvidenceMatchesPlan(report, plan, report.defoldRevision), true);
  assert.equal(runtimeEvidenceMatchesPlan(report, { ...plan, inputs: { "input.json": "new" } }, report.defoldRevision), false);
  assert.equal(runtimeEvidenceMatchesPlan(report, { ...plan, target: "x86_64-linux" }, report.defoldRevision), false);
  assert.equal(runtimeEvidenceMatchesPlan(report, plan, "b".repeat(40)), false);
  assert.equal(runtimeEvidenceMatchesPlan({ ...report, planSha256: "0".repeat(64) }, plan, report.defoldRevision), false);
});

test("the policy workflow materializes the issue links emitted for marked routes", () => {
  const start = policyWorkflow.indexOf("      - name: Open or update per-route verification issues");
  const end = policyWorkflow.indexOf("      - name: Reconcile the real-engine evidence issue", start);
  assert.ok(start >= 0 && end > start);
  const step = policyWorkflow.slice(start, end);
  assert.match(step, /if:\s*>-[\s\S]*always\(\)[\s\S]*refs\/heads\/main/u);
  assert.match(step, /jq -c '\.wantsIssue\[\]'/u);
  assert.match(step, /generate-route-verification\.mjs --check \|\| exit 0/u);
  assert.match(step, /gh issue create --title/u);
  assert.match(step, /gh issue reopen/u);
  assert.match(step, /gh issue edit/u);
  assert.match(step, /gh issue close/u);
});

test("the policy workflow closes stale real-engine evidence issues after recovery", () => {
  const start = policyWorkflow.indexOf("      - name: Reconcile the real-engine evidence issue");
  const end = policyWorkflow.indexOf("      - name: Enforce engine-lane infrastructure health", start);
  assert.ok(start >= 0 && end > start);
  const step = policyWorkflow.slice(start, end);
  assert.match(step, /if:\s*>-[\s\S]*always\(\)[\s\S]*refs\/heads\/main/u);
  assert.match(step, /steps\.engine\.outcome.*!= success/u);
  assert.match(step, /gh issue reopen/u);
  assert.match(step, /gh issue close/u);
});
