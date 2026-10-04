#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { stableBindingId } from "./lib/binding-identity.mjs";
import {
  parseCanonicalLuaRegistrationSurface,
  registeredRouteCapability,
} from "./lib/defold-lua-structural-capabilities.mjs";
import { declaredDerivation, expectReviewedCount, observeReviewedSource } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptDynamicValuesRecipeFacts,
  renderScriptDynamicValuesOutputs,
} from "../packages/compiler/src/script-dynamic-values-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  registrations: new URL("packages/bindings/generated/defold-lua-registration-surface.json", root),
  overrides: new URL("packages/bindings/overrides/script-dynamic-value-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root),
  facts: new URL("packages/bindings/generated/defold-script-dynamic-values-recipe-facts.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_dynamic_values.cpp", root),
  target: new URL("packages/sdk/src/generated/script/dynamic-values.ts", root),
};

function assert(value, message) {
  if (!value) throw new Error(message);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function hex(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function structuralReplayShape(fn, pattern) {
  const parameterTypes = fn.parameters.map(({ rawType }) => rawType);
  const patternParameterTypes = pattern.parameterCodecs.map(({ rawType }) => rawType);
  const returnTypes = [...fn.returns];
  const patternReturnTypes = pattern.returnCodecs.map(({ rawType }) => rawType);
  const shapesAgree =
    JSON.stringify(parameterTypes) === JSON.stringify(patternParameterTypes) &&
    JSON.stringify(returnTypes) === JSON.stringify(patternReturnTypes);
  const variableArguments = pattern.traits.includes("variable-arguments");
  const variableResults = pattern.traits.includes("variable-results");
  const supportedParameters = parameterTypes.every(
    (type, index) =>
      ["number", "integer", "any"].includes(type) &&
      (index === 0 || !variableArguments || fn.parameters[index].rawName === "..."),
  );
  const resultMode =
    variableResults && returnTypes.length === 1 && returnTypes[0] === "..."
      ? "variable-values"
      : returnTypes.length === 1 && ["number", "boolean"].includes(returnTypes[0])
        ? returnTypes[0]
        : null;
  const strategy =
    resultMode === "boolean" && parameterTypes.length === 1 && parameterTypes[0] === "any"
      ? "exact-lua-type-query"
      : resultMode
        ? "exact-lua-call"
        : null;
  return {
    parameterTypes,
    returnTypes,
    traits: [...pattern.traits],
    proven: shapesAgree && supportedParameters && strategy !== null,
    strategy,
    resultMode,
  };
}

function canonicalRegistrationSurfaces(registrationsText, targetIds) {
  const surfaces = new Map();
  let report = null;
  for (const targetId of targetIds) {
    const surface = parseCanonicalLuaRegistrationSurface(registrationsText, targetId);
    report ??= surface.report;
    // Canonical extraction can repeat the same registration through equivalent
    // build paths. Collapse only byte-for-byte equivalent structured rows;
    // distinct variants remain visible to registeredRouteCapability and make
    // the optimization withdraw rather than guessing.
    const routeVariants = new Map(
      [...surface.routeVariants].map(([routeName, variants]) => [
        routeName,
        [...new Map(variants.map((route) => [JSON.stringify(route), route])).values()],
      ]),
    );
    surfaces.set(targetId, { ...surface, routeVariants });
  }
  return { report, surfaces };
}

function replayRegistrationEvidence(registrationSurfaces, fn) {
  const facts = [];
  for (const [targetId, surface] of registrationSurfaces) {
    const capability = registeredRouteCapability(surface, fn.rawName);
    const route = capability ? surface.routes.get(capability.route) : null;
    const minimumArguments = route?.arity?.derived?.min;
    if (
      !capability ||
      capability.module !== fn.modulePath.join(".") ||
      capability.route !== `${capability.module}.${fn.member}` ||
      !Number.isInteger(minimumArguments) ||
      minimumArguments < 0 ||
      minimumArguments > 255
    ) {
      return { proven: false, facts };
    }
    facts.push({
      target: targetId,
      module: capability.module,
      member: fn.member,
      minimumArguments,
      registrationPath: capability.sourcePath,
    });
  }
  return {
    proven:
      facts.length === registrationSurfaces.size &&
      new Set(facts.map(({ minimumArguments }) => minimumArguments)).size === 1,
    facts,
  };
}

const anchors = {
  "script:json.decode": /\{\s*"decode",\s*Json_Decode\s*\}/,
  "script:json.encode": /\{\s*"encode",\s*Json_Encode\s*\}/,
  "script:pprint": /int LuaPPrint\(lua_State\* L\)/,
};

export async function loadInputs() {
  const [patternsText, irText, overridesText, registrationsText] = await Promise.all([
    readFile(urls.patterns, "utf8"),
    readFile(urls.ir, "utf8"),
    readFile(urls.overrides, "utf8"),
    readFile(urls.registrations, "utf8"),
  ]);
  const overrides = JSON.parse(overridesText);
  const sources = await Promise.all(
    overrides.sources.map(async (source) => ({
      ...source,
      text: await readFile(new URL(`upstream/defold/${source.path}`, root), "utf8").catch(() => null),
    })),
  );
  return { patternsText, irText, overridesText, registrationsText, sources };
}

export function generate(patternsText, irText, overridesText, sources, registrationsText) {
  const patterns = JSON.parse(patternsText);
  const ir = JSON.parse(irText);
  const overrides = JSON.parse(overridesText);
  assert(patterns.schemaVersion === 1, "dynamic-value binding-pattern schema drifted");
  assert(ir.schemaVersion === 1, "dynamic-value script IR schema drifted");
  assert(
    patterns.defoldRevision === ir.defoldRevision,
    "dynamic-value binding patterns and script IR use different Defold revisions",
  );
  assert(patterns.sourceSha256 === sha256(irText), "dynamic-value binding patterns are stale against script IR");
  assert(ir.counts?.functions === ir.functions?.length, "dynamic-value script IR function count is stale");
  assert(
    patterns.classifiedFunctionCount === patterns.bindings?.length,
    "dynamic-value classified binding count is stale",
  );
  assert(patterns.pendingFunctionCount === patterns.bindings?.length, "dynamic-value pending binding count is stale");
  assert(overrides.schemaVersion === 2, "dynamic-value override schema drifted");
  assert(
    Number.isInteger(overrides.maximumArgumentCount) &&
      overrides.maximumArgumentCount > 0 &&
      overrides.maximumArgumentCount <= 255,
    "dynamic-value maximum argument count must fit the generated descriptor",
  );
  assert(
    Array.isArray(overrides.requiredRegistrationTargets) && overrides.requiredRegistrationTargets.length > 0,
    "dynamic-value replay needs registered-callable targets",
  );
  assert(
    new Set(overrides.requiredRegistrationTargets).size === overrides.requiredRegistrationTargets.length,
    "dynamic-value replay repeats a registration target",
  );
  for (const key of ["executionContext", "codecEvidence", "ownership"])
    assert(typeof overrides.replayContract?.[key] === "string", `dynamic-value replay contract lacks ${key}`);
  const canonicalRegistrations = canonicalRegistrationSurfaces(
    registrationsText,
    overrides.requiredRegistrationTargets,
  );
  assert(
    canonicalRegistrations.report.defoldRevision === ir.defoldRevision,
    "dynamic-value registration revision drifted",
  );
  assert(sources.length === overrides.sources.length, "dynamic-value pinned source count drifted");
  const expectedSourceByKey = new Map();
  for (const source of overrides.sources) {
    assert(typeof source.key === "string" && source.key.length > 0, "dynamic-value pinned source has no key");
    assert(!expectedSourceByKey.has(source.key), `${source.key}: duplicate reviewed source`);
    expectedSourceByKey.set(source.key, source);
  }
  const sourceByKey = new Map();
  for (const source of sources) {
    const expected = expectedSourceByKey.get(source.key);
    assert(expected, `${source.key}: unreviewed pinned source`);
    assert(
      source.path === expected.path && source.sha256 === expected.sha256,
      `${source.key}: pinned source metadata drifted`,
    );
    // OBSERVED, not asserted. A pinned hash only detects that Defold edited its
    // own source, which across a release is expected and is the input to this
    // generator rather than a failure of it. A moved file becomes an audit line
    // and a restated pin for this revision. What actually checks this policy
    // against the revision being generated is the census below, which is read
    // from that revision's IR.
    observeReviewedSource({
      input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
      id: `${source.key}: dynamic-value`,
      source: source.text,
      evidence: expected,
    });
    assert(!sourceByKey.has(source.key), `${source.key}: duplicate pinned source`);
    sourceByKey.set(source.key, source);
  }
  const irIds = new Set();
  for (const fn of ir.functions) {
    assert(typeof fn.id === "string" && fn.id.length > 0, "dynamic-value script IR contains a function without an id");
    assert(!irIds.has(fn.id), `${fn.id}: duplicate script IR function id`);
    irIds.add(fn.id);
  }
  const patternIds = new Set();
  for (const pattern of patterns.bindings) {
    assert(
      typeof pattern.id === "string" && pattern.id.length > 0,
      "dynamic-value binding patterns contain a row without an id",
    );
    assert(!patternIds.has(pattern.id), `${pattern.id}: duplicate binding-pattern id`);
    patternIds.add(pattern.id);
  }
  const selected = patterns.bindings.filter((row) => row.loweringFamily === "dynamic-values");
  // The census is evidence at the revision it was counted at and an observation
  // anywhere else: Defold 1.13.1 classifies 17 dynamic-value routes where the
  // review counted 14, and 17 is the answer rather than an error.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
    label: "dynamic-value route census",
    expected: overrides.expectedRouteCount,
    observed: selected.length,
  });
  // A classified route with no reviewed rule cannot be emitted - its strategy,
  // argument floor and blocker are exactly what a review decides. At the
  // reviewed revision that is a gap in this tree and stays fatal; in a declared
  // derivation it is a route this revision has and the review never saw, so it
  // is withdrawn and reported as queued review work.
  const reviewedSelected = selected.filter((pattern) => {
    if (overrides.routes[pattern.id]) return true;
    assert(declaredDerivation(), `${pattern.id}: missing reviewed dynamic-value rule`);
    recordAudit({
      input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
      id: pattern.id,
      status: VOID,
      reason: "unreviewed-route",
    });
    return false;
  });
  expectReviewedCount({
    input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
    label: "dynamic-value override coverage",
    expected: Object.keys(overrides.routes).length,
    observed: reviewedSelected.length,
  });
  const irById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const rows = reviewedSelected
    .map((pattern) => {
      const rule = overrides.routes[pattern.id];
      assert(rule, `${pattern.id}: missing reviewed dynamic-value rule`);
      const fn = irById.get(pattern.id);
      assert(fn, `${pattern.id}: absent from pinned script IR`);
      const candidate = rule.strategy !== "blocked";
      if (!candidate) {
        const source = sourceByKey.get(rule.source);
        assert(source, `${pattern.id}: unknown source key ${rule.source}`);
        if (typeof source.text !== "string" || !anchors[pattern.id]?.test(source.text)) {
          const message = `${pattern.id}: pinned blocker implementation ${source.text === null ? "source is absent" : "anchor drifted"}`;
          assert(declaredDerivation(), message);
          recordAudit({
            input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
            id: pattern.id,
            source: source.path,
            status: VOID,
            reason: source.text === null ? "absent-source" : "reviewed-route-anchor-lost",
            detail: message,
          });
          return null;
        }
        assert(rule.blocker && rule.detail, `${pattern.id}: blocked route needs a machine blocker and detail`);
        return {
          id: pattern.id,
          stableId: hex(stableBindingId(pattern.id)),
          modulePath: fn.modulePath,
          member: fn.member,
          strategy: rule.strategy,
          generatedFamilyExecutableCandidate: false,
          optimizationProven: false,
          optimizationBlockers: [rule.blocker],
          minimumArguments: null,
          maximumArguments: null,
          resultMode: null,
          blocker: rule.blocker,
          blockerDetail: rule.detail,
          sourceEvidence: { path: source.path, sha256: source.sha256, anchor: anchors[pattern.id].source },
          focusedNativeEvidence: "not-applicable-blocked",
          targetSupport: {
            nativeDynamicHermes: `blocked-${rule.blocker}`,
            nativeStaticHermes: `blocked-${rule.blocker}`,
            html5BrowserHost: `blocked-${rule.blocker}`,
          },
        };
      }

      assert(rule.strategy === "registered-replay", `${pattern.id}: candidate strategy is not structural replay`);
      const shape = structuralReplayShape(fn, pattern);
      const registration = replayRegistrationEvidence(canonicalRegistrations.surfaces, fn);
      const optimizationBlockers = [
        ...(!registration.proven ? ["registered-global-callable-evidence-missing"] : []),
        ...(!shape.proven ? ["structural-codec-evidence-missing"] : []),
      ];
      const optimizationProven = optimizationBlockers.length === 0;
      const minimumArguments = registration.facts[0]?.minimumArguments ?? 0;
      return {
        id: pattern.id,
        stableId: hex(stableBindingId(pattern.id)),
        modulePath: fn.modulePath,
        member: fn.member,
        strategy: shape.strategy ?? "exact-lua-call",
        generatedFamilyExecutableCandidate: true,
        optimizationProven,
        optimizationBlockers,
        minimumArguments,
        maximumArguments: overrides.maximumArgumentCount,
        resultMode: shape.resultMode ?? "variable-values",
        blocker: null,
        blockerDetail: null,
        replayEvidence: {
          registrations: registration.facts,
          executionContext: overrides.replayContract.executionContext,
          parameterTypes: shape.parameterTypes,
          returnTypes: shape.returnTypes,
          traits: shape.traits,
          ownership: overrides.replayContract.ownership,
        },
        focusedNativeEvidence: "observed-bounded-registered-Lua-replay-transport",
        targetSupport: {
          nativeDynamicHermes: optimizationProven
            ? "candidate-awaits-shared-router-integration"
            : "universal-fallback-missing-proof",
          nativeStaticHermes: optimizationProven ? "planned-generated-adapter" : "universal-fallback-missing-proof",
          html5BrowserHost: "not-executable-no-generated-provider",
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number.parseInt(left.stableId) - Number.parseInt(right.stableId));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "dynamic-value stable ID collision");
  const candidates = rows.filter((row) => row.generatedFamilyExecutableCandidate);
  const optimizedCandidates = candidates.filter((row) => row.optimizationProven);
  const universalFallbackCandidates = candidates.filter((row) => !row.optimizationProven);
  const blocked = rows.filter((row) => !row.generatedFamilyExecutableCandidate);
  expectReviewedCount({
    input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
    label: "dynamic-value candidate census",
    expected: overrides.expectedCandidateCount,
    observed: candidates.length,
  });
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "All routes classified as dynamic-values by the pinned script binding classifier",
    inputEvidence: {
      scriptIrSha256: sha256(irText),
      bindingPatternsSha256: sha256(patternsText),
      reviewedOverridesSha256: sha256(overridesText),
      registeredCallableEvidenceSha256: sha256(
        JSON.stringify(
          candidates.map(({ id, replayEvidence }) => ({ id, registrations: replayEvidence.registrations })),
        ),
      ),
    },
    routeCount: rows.length,
    generatedFamilyCandidateCount: candidates.length,
    optimizedReplayCount: optimizedCandidates.length,
    universalFallbackCount: universalFallbackCandidates.length,
    blockedCount: blocked.length,
    maximumArgumentCount: overrides.maximumArgumentCount,
    allocationPolicy:
      "Generated dispatch uses sorted static descriptors and caller-owned ScriptCallFrame storage. The exact Lua backend must cache function references and use fixed-capacity stack/scratch; there is no heap fallback in generated glue.",
    evidencePolicy:
      "Replay admission uses callable registration in every required engine profile plus exact IR/pattern codec shape and registration-derived arity. Private C function names and implementation bodies are non-evidence. Blocked recursive routes retain their separate source-reviewed semantic blockers. Focused native tests prove bounded Lua replay transport, not packaged-engine implementation semantics.",
    replayContract: overrides.replayContract,
    blockerCounts: Object.fromEntries(
      [...new Set(blocked.map(({ blocker }) => blocker))]
        .sort(compare)
        .map((blocker) => [blocker, blocked.filter((row) => row.blocker === blocker).length]),
    ),
    bindings: rows,
  };

  const recipeFacts = createScriptDynamicValuesRecipeFacts(report);
  const rendered = renderScriptDynamicValuesOutputs(recipeFacts);
  return {
    report: `${JSON.stringify(report, null, 2)}\n`,
    facts: `${JSON.stringify(recipeFacts, null, 2)}\n`,
    header: rendered.header,
    source: rendered.source,
    target: rendered.target,
  };
}

export async function run(check = false) {
  const inputs = await loadInputs();
  const outputs = generate(
    inputs.patternsText,
    inputs.irText,
    inputs.overridesText,
    inputs.sources,
    inputs.registrationsText,
  );
  for (const [key, contents] of Object.entries(outputs)) {
    if (check)
      assert((await readFile(urls[key], "utf8")) === contents, `${urls[key].pathname}: generated output is stale`);
    else await writeFile(urls[key], contents);
  }
  return JSON.parse(outputs.report);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check"))
    .then((report) => {
      console.log(
        `Generated ${report.optimizedReplayCount}/${report.generatedFamilyCandidateCount} optimized dynamic-value replay candidates, ${report.universalFallbackCount} universal fallbacks; ${report.blockedCount} are machine-blocked.`,
      );
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
