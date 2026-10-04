#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { declaredDerivation, expectReviewedCount, loadReviewedSources } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptCallbackLifecycleRecipeFacts,
  renderScriptCallbackLifecycleOutputs,
} from "../packages/compiler/src/script-callback-lifecycle-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  policy: new URL("packages/bindings/overrides/script-callback-lifecycle-policies.json", root),
  output: new URL("packages/bindings/generated/defold-script-callback-lifecycle.json", root),
  facts: new URL("packages/bindings/generated/defold-script-callback-lifecycle-recipe-facts.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_callback_lifecycle.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_callback_lifecycle.cpp", root),
  target: new URL("packages/sdk/src/generated/script/callback-lifecycle.ts", root),
};

const LIFETIMES = new Map([
  ["one-shot", "kOneShot"],
  ["terminal-event", "kTerminalEvent"],
  ["persistent-replaceable", "kPersistentReplaceable"],
  ["higher-order-closure", "kHigherOrderClosure"],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function counts(rows, select) {
  const result = {};
  for (const row of rows) {
    const key = select(row);
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => compare(a, b)));
}
function byId(rows, label) {
  const result = new Map();
  for (const row of rows) {
    assert(typeof row.id === "string" && row.id.length !== 0, `${label} has an empty route identity`);
    assert(!result.has(row.id), `${label} has duplicate route '${row.id}'`);
    result.set(row.id, row);
  }
  return result;
}

function validateSources(policy, sourceTexts, withdrawnSources) {
  assert(Array.isArray(policy.sourceEvidence), "callback lifecycle policy is missing pinned source evidence");
  const listed = new Map();
  for (const source of policy.sourceEvidence) {
    assert(
      typeof source.path === "string" && /^[0-9a-f]{64}$/.test(source.sha256),
      "callback lifecycle source evidence is malformed",
    );
    assert(!listed.has(source.path), `callback lifecycle source evidence duplicates '${source.path}'`);
    listed.set(source.path, source.sha256);
    // The hashes were already observed while loading; a withdrawn source has no
    // text to check and its routes are dropped by the caller.
    if (withdrawnSources.has(source.path)) continue;
    assert(typeof sourceTexts.get(source.path) === "string", `${source.path}: pinned callback source was not loaded`);
  }
  const evidencePaths = new Set(policy.routes.flatMap((route) => route.evidence.map((evidence) => evidence.path)));
  assert(evidencePaths.size === listed.size, "callback lifecycle source evidence coverage drifted");
  for (const path of evidencePaths) assert(listed.has(path), `${path}: route evidence has no pinned source hash`);
}

export function selectReviewedCallbackRoutes(policy, sourceTexts, withdrawnSources, env = process.env) {
  const derived = declaredDerivation(env);
  return policy.routes.filter((route) => {
    let withdrawn = false;
    for (const evidence of route.evidence) {
      assert(
        Array.isArray(evidence.anchors) && evidence.anchors.length !== 0,
        `${route.id}: evidence anchors are absent`,
      );
      if (withdrawnSources.has(evidence.path)) {
        withdrawn = true;
        continue;
      }
      const text = sourceTexts.get(evidence.path);
      const lost = evidence.anchors.filter((anchor) => !text.includes(anchor));
      if (!lost.length) continue;
      const message = `${route.id}: reviewed source anchor '${lost[0]}' is stale`;
      assert(derived, message);
      recordAudit(
        {
          input: "packages/bindings/overrides/script-callback-lifecycle-policies.json",
          id: route.id,
          source: evidence.path,
          status: VOID,
          reason: "reviewed-route-anchor-lost",
          anchorsLost: lost,
          detail: message,
          derived,
        },
        env,
      );
      withdrawn = true;
    }
    return !withdrawn;
  });
}

export function generateScriptCallbackLifecycle(inputs) {
  const ir = parse(inputs.irText, "script API IR");
  const patterns = parse(inputs.patternsText, "script binding patterns");
  const policy = parse(inputs.policyText, "callback lifecycle policy");
  assert(policy.schemaVersion === 1, "callback lifecycle policy has an unsupported schema");
  assert(
    Array.isArray(policy.routes) && Array.isArray(policy.policyVocabulary),
    "callback lifecycle policy is malformed",
  );
  assert(policy.expectedRouteCount === policy.routes.length, "callback lifecycle policy route count is stale");
  assert(
    new Set(policy.policyVocabulary).size === policy.policyVocabulary.length,
    "callback lifecycle policy vocabulary duplicates a lifetime",
  );
  assert(
    policy.policyVocabulary.every((lifetime) => LIFETIMES.has(lifetime)),
    "callback lifecycle policy has an unknown lifetime",
  );
  const withdrawnSources = inputs.withdrawnSources ?? new Set();
  validateSources(policy, inputs.sourceTexts, withdrawnSources);

  // A route whose reviewed evidence is not in this revision is withdrawn here.
  // The remaining routes are the callback lifecycle policy FOR THIS REVISION.
  const reviewedRoutes = selectReviewedCallbackRoutes(policy, inputs.sourceTexts, withdrawnSources, inputs.env);
  const withdrawnRoutes = policy.routes.length - reviewedRoutes.length;

  const irById = byId(ir.functions, "script API IR");
  const patternsById = byId(patterns.bindings, "script binding patterns");
  const policyById = byId(reviewedRoutes, "callback lifecycle policy");
  const callbackPatterns = patterns.bindings.filter(({ loweringFamily }) => loweringFamily === "callback-lifecycle");
  // The census is evidence at the revision it was counted at, and an observation
  // anywhere else. A revision that added or removed a callback route is a policy
  // difference to report, not a refusal.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-callback-lifecycle-policies.json",
    label: "callback-lifecycle pattern census",
    expected: policy.expectedRouteCount - withdrawnRoutes,
    observed: callbackPatterns.length,
  });
  for (const pattern of callbackPatterns) {
    if (!policyById.has(pattern.id)) {
      // A classified callback route with no reviewed policy cannot be emitted -
      // its lifetime and ownership are exactly what a review decides. At the
      // reviewed revision that is a gap in this tree and stays fatal.
      assert(declaredDerivation(), `${pattern.id}: classified callback route is missing reviewed lifecycle policy`);
    }
  }
  for (const id of policyById.keys()) {
    assert(
      patternsById.get(id)?.loweringFamily === "callback-lifecycle",
      `${id}: reviewed lifecycle policy is not a callback-lifecycle route`,
    );
  }

  const rows = reviewedRoutes
    .map((route) => {
      const fn = irById.get(route.id);
      const pattern = patternsById.get(route.id);
      assert(fn && pattern, `${route.id}: route is absent from pinned IR or patterns`);
      assert(
        JSON.stringify(fn.parameters.map(({ rawName, rawType, optional }) => ({ rawName, rawType, optional }))) ===
          JSON.stringify(
            pattern.parameterCodecs.map(({ name, rawType, optional }) => ({ rawName: name, rawType, optional })),
          ),
        `${route.id}: binding-pattern shape differs from pinned IR`,
      );
      assert(
        JSON.stringify(fn.returns) === JSON.stringify(pattern.returnCodecs.map(({ rawType }) => rawType)),
        `${route.id}: result shape differs from pinned IR`,
      );
      assert(
        typeof route.callbackParameter === "string" &&
          typeof route.owner === "string" &&
          typeof route.invocationContext === "string" &&
          typeof route.threadAffinity === "string",
        `${route.id}: lifecycle policy fields are malformed`,
      );
      assert(LIFETIMES.has(route.lifetime), `${route.id}: lifecycle is not in the generated vocabulary`);
      const callback = pattern.parameterCodecs.find(({ name }) => name === route.callbackParameter);
      assert(
        callback?.codecs?.includes("callback"),
        `${route.id}: reviewed callback parameter is absent or no longer callback-coded`,
      );
      assert(
        Array.isArray(route.payloadBlockers) && route.payloadBlockers.length > 0,
        `${route.id}: callback route requires explicit payload blockers`,
      );
      const stableId = stableBindingId(route.id);
      return { ...route, stableId, registryEligible: route.lifetime !== "higher-order-closure" };
    })
    .sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  assert(
    new Set(rows.map(({ stableId }) => stableId)).size === rows.length,
    "callback lifecycle stable-ID collision detected",
  );

  const targetSupport = {
    nativeDynamicHermes:
      "generated-registry-metadata-only; each route remains blocked until its reviewed engine adapter and payload codecs are implemented",
    nativeStaticHermes: "fail-closed-unverified",
    html5BrowserHost: "fail-closed-unverified",
  };
  const evidence = {
    scriptIrSha256: sha256(inputs.irText),
    bindingPatternsSha256: sha256(inputs.patternsText),
    policySha256: sha256(inputs.policyText),
    defoldSources: policy.sourceEvidence
      .filter(({ path }) => !withdrawnSources.has(path))
      .map(({ path, sha256: hash }) => ({ path: `upstream/defold/${path}`, sha256: hash }))
      .sort((a, b) => compare(a.path, b.path)),
  };
  evidence.aggregateInputSha256 = sha256(
    [
      evidence.scriptIrSha256,
      evidence.bindingPatternsSha256,
      evidence.policySha256,
      ...evidence.defoldSources.map(({ path, sha256: hash }) => `${path}\0${hash}`),
    ].join("\0"),
  );
  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "the exact callback-lifecycle family classified from the pinned Defold script IR",
    coverageClaim:
      "generated lifecycle metadata and fixed-capacity registry semantics only; no route-specific engine callback adapter or payload codec is executable",
    allocationClaim:
      "Registry construction allocates fixed storage; retain, invoke, cancel, owner cancellation, and teardown have no heap fallback",
    routeCount: rows.length,
    registryEligibleRouteCount: rows.filter(({ registryEligible }) => registryEligible).length,
    higherOrderClosureRouteCount: rows.filter(({ lifetime }) => lifetime === "higher-order-closure").length,
    lifetimeCounts: counts(rows, ({ lifetime }) => lifetime),
    threadAffinityCounts: counts(rows, ({ threadAffinity }) => threadAffinity),
    targetSupport,
    inputEvidence: evidence,
    routes: rows,
  };
}

export async function loadScriptCallbackLifecycleInputs() {
  const [irText, patternsText, policyText] = await Promise.all([
    readFile(paths.ir, "utf8"),
    readFile(paths.patterns, "utf8"),
    readFile(paths.policy, "utf8"),
  ]);
  const policy = parse(policyText, "callback lifecycle policy");
  // Tolerant on purpose: a cited source a revision does not have - the whole
  // `bullet3d` backend at Defold 1.13.1, for instance - withdraws the routes
  // resting on it rather than killing the generator with ENOENT.
  const loaded = await loadReviewedSources({
    input: "packages/bindings/overrides/script-callback-lifecycle-policies.json",
    defoldRoot: fileURLToPath(new URL("upstream/defold", root)),
    evidence: policy.sourceEvidence,
    derived: parse(irText, "script API IR").defoldRevision,
  });
  const sourceTexts = loaded.texts;
  const withdrawnSources = loaded.withdrawn;
  return { irText, patternsText, policyText, sourceTexts, withdrawnSources };
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  assert(argv.length === (check ? 1 : 0), `Unknown argument: ${argv.find((argument) => argument !== "--check")}`);
  const report = generateScriptCallbackLifecycle(await loadScriptCallbackLifecycleInputs());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const facts = createScriptCallbackLifecycleRecipeFacts(report);
  const serializedFacts = `${JSON.stringify(facts, null, 2)}\n`;
  const rendered = renderScriptCallbackLifecycleOutputs(facts);
  if (check) {
    const current = await Promise.all([
      readFile(paths.output, "utf8"),
      readFile(paths.header, "utf8"),
      readFile(paths.source, "utf8"),
      readFile(paths.target, "utf8"),
      readFile(paths.facts, "utf8"),
    ]);
    assert(
      current[0] === serialized &&
        current[1] === rendered.header &&
        current[2] === rendered.source &&
        current[3] === rendered.target &&
        current[4] === serializedFacts,
      "callback lifecycle generated outputs are stale; run scripts/generate-script-callback-lifecycle.mjs",
    );
  } else
    await Promise.all([
      writeFile(paths.output, serialized),
      writeFile(paths.header, rendered.header),
      writeFile(paths.source, rendered.source),
      writeFile(paths.target, rendered.target),
      writeFile(paths.facts, serializedFacts),
    ]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
