#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import {
  parseCanonicalLuaRegistrationSurface,
  registeredRouteCapability,
} from "./lib/defold-lua-structural-capabilities.mjs";
import { assertReviewedRevision, declaredDerivation, expectReviewedCount } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptOverloadDispatchRecipeFacts,
  renderScriptOverloadDispatchOutputs,
} from "../packages/compiler/src/script-overload-dispatch-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  override: new URL("packages/bindings/overrides/script-overload-dispatch.json", root),
  owned: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  registrationSurface: new URL("packages/bindings/generated/defold-lua-registration-surface.json", root),
  report: new URL("packages/bindings/generated/defold-script-overload-dispatch.json", root),
  facts: new URL("packages/bindings/generated/defold-script-overload-dispatch-recipe-facts.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_overload_dispatch.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_overload_dispatch.cpp", root),
  target: new URL("packages/sdk/src/generated/script/overload-dispatch-target-support.ts", root),
};

const codecs = new Map([
  ["number", "Number"],
  ["vector3", "Vector3"],
  ["vector4", "Vector4"],
  ["quaternion", "Quaternion"],
  ["matrix4", "Matrix4"],
]);

function assert(value, message) {
  if (!value) throw new Error(message);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function split(value, delimiter = "|") {
  const result = [];
  let start = 0;
  let angle = 0;
  let round = 0;
  let square = 0;
  for (let index = 0; index < value.length; ++index) {
    const char = value[index];
    if (char === "<") ++angle;
    else if (char === ">") --angle;
    else if (char === "(") ++round;
    else if (char === ")") --round;
    else if (char === "[") ++square;
    else if (char === "]") --square;
    else if (char === delimiter && !angle && !round && !square) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}
function overloadSignature(signature) {
  const match = signature.match(/^fun\((.*)\):/);
  assert(match, `unsupported overload signature '${signature}'`);
  const returns = signature.slice(signature.indexOf("):") + 2).trim();
  return {
    parameters: match[1].trim() ? split(match[1], ",").map((item) => item.slice(item.indexOf(":") + 1).trim()) : [],
    returns: returns.startsWith("(") && returns.endsWith(")") ? split(returns.slice(1, -1), ",") : [returns],
  };
}
function cartesian(parts) {
  return parts.reduce((rows, part) => rows.flatMap((row) => part.map((item) => [...row, item])), [[]]);
}
function genericMap(fn) {
  return new Map(
    fn.generics.map((entry) => {
      const index = entry.indexOf(":");
      return [entry.slice(0, index).trim(), split(entry.slice(index + 1)).map((type) => type.trim())];
    }),
  );
}
function shapesFor(fn) {
  const generics = genericMap(fn);
  const signatures = [
    { parameters: fn.parameters.map(({ rawType }) => rawType), returns: fn.returns },
    ...fn.overloads.map(overloadSignature),
  ];
  const shapes = [];
  for (const signature of signatures) {
    const variables = [...new Set(signature.parameters.filter((type) => generics.has(type)))].map((name) => [
      name,
      generics.get(name),
    ]);
    for (const assignmentValues of cartesian(variables.map(([, values]) => values))) {
      const assignment = new Map(variables.map(([name], index) => [name, assignmentValues[index]]));
      const resolve = (type) => {
        const resolved = assignment.get(type) ?? type;
        const variants = split(resolved);
        assert(
          variants.every((variant) => codecs.has(variant)),
          `${fn.id}: unsupported overload type '${resolved}'`,
        );
        return variants.map((variant) => codecs.get(variant));
      };
      const resultTypes = signature.returns.map((type) => assignment.get(type) ?? type);
      assert(resultTypes.length === 1, `${fn.id}: executable overload dispatcher requires one result`);
      assert(codecs.has(resultTypes[0]), `${fn.id}: unsupported result type '${resultTypes[0]}'`);
      for (const arguments_ of cartesian(signature.parameters.map(resolve))) {
        shapes.push({ arguments: arguments_, resultCodec: codecs.get(resultTypes[0]) });
      }
    }
  }
  const unique = new Map(shapes.map((shape) => [`${shape.arguments.join(",")}>${shape.resultCodec}`, shape]));
  return [...unique.values()];
}

export async function loadInputs() {
  const [irText, patternsText, overrideText, ownedText, registrationSurfaceText] = await Promise.all([
    readFile(urls.ir, "utf8"),
    readFile(urls.patterns, "utf8"),
    readFile(urls.override, "utf8"),
    readFile(urls.owned, "utf8"),
    readFile(urls.registrationSurface, "utf8"),
  ]);
  return { irText, patternsText, overrideText, ownedText, registrationSurfaceText };
}

export function generate(inputs) {
  const ir = JSON.parse(inputs.irText);
  const patterns = JSON.parse(inputs.patternsText);
  const override = JSON.parse(inputs.overrideText);
  const owned = JSON.parse(inputs.ownedText);
  const registrationSurface = parseCanonicalLuaRegistrationSurface(inputs.registrationSurfaceText);
  assert(override.schemaVersion === 2, "overload-dispatch override schema drifted");
  assert(ir.schemaVersion === 1 && patterns.schemaVersion === 1, "overload-dispatch input schema drifted");
  assert(ir.defoldRevision === patterns.defoldRevision, "overload-dispatch inputs use different Defold revisions");
  // Reviewed evidence, compared against the revision being generated. The
  // reviewed call shapes are re-checked below against this revision's IR - every
  // reviewed route must still exist, still be classified `defold-value`, and
  // still match its recorded census - so the substance is verified at the
  // revision even when the review was performed at another one.
  assertReviewedRevision({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    reviewed: override.defoldRevision,
    derived: ir.defoldRevision,
    detail: "the reviewed overload call shapes",
  });
  assert(patterns.sourceSha256 === sha256(inputs.irText), "overload-dispatch patterns are stale against script IR");
  assert(owned?.schemaVersion === 1, "overload-dispatch already-owned report schema drifted");
  assert(
    owned.defoldRevision === ir.defoldRevision,
    "overload-dispatch already-owned report uses a different Defold revision",
  );
  // A census of the value-binding lane recorded at the reviewed revision. It is
  // fatal in an ordinary generation and an observation in a declared derivation:
  // a revision with a different number of value bindings is the measurement.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "already-owned value-binding census",
    expected: 78,
    observed: owned.bindingCount,
  });
  assert(
    Array.isArray(owned.bindings) && owned.bindings.length === owned.bindingCount,
    "overload-dispatch already-owned report binding array/count drifted",
  );
  const ownedBindingIds = new Set();
  const ownedStableIds = new Set();
  for (const binding of owned.bindings) {
    assert(
      typeof binding?.id === "string" && binding.id.length > 0,
      "overload-dispatch already-owned report has a binding without an id",
    );
    assert(!ownedBindingIds.has(binding.id), `${binding.id}: duplicate already-owned binding id`);
    ownedBindingIds.add(binding.id);
    assert(
      Number.isInteger(binding.stableId) && binding.stableId >= 0 && binding.stableId <= 0xffffffff,
      `${binding.id}: already-owned binding has an invalid stable ID`,
    );
    assert(!ownedStableIds.has(binding.stableId), `${binding.id}: duplicate already-owned binding stable ID`);
    ownedStableIds.add(binding.stableId);
    assert(binding.stableId === stableBindingId(binding.id), `${binding.id}: already-owned binding stable ID drifted`);
  }
  assert(Array.isArray(patterns.bindings), "overload-dispatch binding patterns are not an array");
  assert(
    patterns.classifiedFunctionCount === patterns.bindings.length &&
      patterns.pendingFunctionCount === patterns.bindings.length,
    "overload-dispatch binding-pattern classifier count drifted",
  );
  const patternIds = new Set();
  for (const pattern of patterns.bindings) {
    assert(
      typeof pattern?.id === "string" && pattern.id.length > 0,
      "overload-dispatch binding patterns contain a row without an id",
    );
    assert(!patternIds.has(pattern.id), `${pattern.id}: duplicate binding-pattern id`);
    patternIds.add(pattern.id);
  }
  const irById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  assert(irById.size === ir.functions.length, "overload-dispatch script IR has duplicate ids");
  for (const id of patternIds) assert(irById.has(id), `${id}: binding-pattern row is absent from pinned script IR`);
  const omittedFromPatterns = ir.functions.filter(({ id }) => !patternIds.has(id));
  assert(
    patterns.bindings.length + omittedFromPatterns.length === ir.functions.length &&
      omittedFromPatterns.every(({ runtimeStatus }) => runtimeStatus === "implemented-generated-lua-bridge"),
    "overload-dispatch binding-pattern count drifted against script IR",
  );
  const classified = patterns.bindings.filter((row) => row.loweringFamily === "overload-dispatch");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "overload-dispatch classified census",
    expected: override.expected.classifiedRouteCount,
    observed: classified.length,
  });
  const ownedIds = new Set(override.alreadyOwned.ids);
  assert(ownedIds.size === override.alreadyOwned.ids.length, "overload-dispatch already-owned ids are duplicated");
  // Whether each reviewed already-owned route is still in the value-binding
  // report is a census of that lane at this revision, not a property of this
  // file: the value lane withdraws routes a revision no longer bears out.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "already-owned route membership",
    expected: ownedIds.size,
    observed: [...ownedIds].filter((id) => ownedBindingIds.has(id)).length,
  });
  const selected = classified.filter(({ id }) => !ownedIds.has(id));
  assert(
    new Set(selected.map(({ id }) => id)).size === selected.length,
    "overload-dispatch selected routes contain duplicate ids",
  );
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "overload-dispatch selected census",
    expected: override.expected.selectedRouteCount,
    observed: selected.length,
  });
  // A classified route with no reviewed policy cannot be emitted - its strategy
  // and blocker are exactly what a review decides. Fatal at the reviewed
  // revision; withdrawn and reported in a declared derivation of another.
  const reviewedSelected = selected.filter((pattern) => {
    if (override.routes[pattern.id]) return true;
    assert(declaredDerivation(), `${pattern.id}: missing reviewed policy`);
    recordAudit({
      input: "packages/bindings/overrides/script-overload-dispatch.json",
      id: pattern.id,
      status: VOID,
      reason: "unreviewed-route",
    });
    return false;
  });
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "overload-dispatch policy coverage",
    expected: Object.keys(override.routes).length,
    observed: reviewedSelected.length,
  });
  const rows = reviewedSelected
    .map((pattern) => {
      const fn = irById.get(pattern.id);
      const policy = override.routes[pattern.id];
      assert(fn, `${pattern.id}: selected route is absent from pinned IR`);
      assert(policy, `${pattern.id}: missing reviewed policy`);
      const routeName = [...fn.modulePath, fn.member].join(".");
      const registration = registeredRouteCapability(registrationSurface, routeName);
      const candidate = policy.strategy === "generated-defold-value-dispatch";
      if (candidate && !registration) {
        const message = `${pattern.id}: positive Lua registration is absent or ambiguous in canonical registration surface`;
        assert(declaredDerivation(), message);
        recordAudit({
          input: "packages/bindings/overrides/script-overload-dispatch.json",
          id: pattern.id,
          status: VOID,
          reason: "canonical-registration-unavailable",
          detail: message,
        });
        return null;
      }
      assert(
        candidate || policy.strategy === "blocked",
        `${pattern.id}: unknown reviewed strategy '${policy.strategy}'`,
      );
      assert(candidate || typeof policy.blocker === "string", `${pattern.id}: blocked route has no machine blocker`);
      // A candidate whose documented overloads this revision spells in a way the
      // generator cannot read - Defold 1.13.1 writes `fun(t, q1, q2)`, with no
      // parameter types - has no call shapes to emit. Fatal at the reviewed
      // revision; withdrawn and reported in a declared derivation of another.
      let callShapes = [];
      if (candidate) {
        try {
          callShapes = shapesFor(fn);
        } catch (error) {
          assert(declaredDerivation(), error.message);
          recordAudit({
            input: "packages/bindings/overrides/script-overload-dispatch.json",
            id: fn.id,
            status: VOID,
            reason: "unreadable-signature",
            detail: error.message,
          });
          return null;
        }
      }
      return {
        id: fn.id,
        stableId: stableBindingId(fn.id),
        modulePath: fn.modulePath,
        member: fn.member,
        strategy: policy.strategy,
        generatedFamilyExecutableCandidate: candidate,
        callShapes,
        blocker: candidate ? null : policy.blocker,
        sourceCapabilities: { registration },
        targetSupport: candidate
          ? {
              nativeDynamicHermes: "generated-executable-shared-script-adapter",
              nativeStaticHermes: "not-integrated-fail-closed",
              html5BrowserHost: "not-executable-no-generated-provider",
            }
          : {
              nativeDynamicHermes: `blocked-${policy.blocker}`,
              nativeStaticHermes: `blocked-${policy.blocker}`,
              html5BrowserHost: `blocked-${policy.blocker}`,
            },
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.stableId - right.stableId);
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "overload-dispatch stable-ID collision");
  const candidates = rows.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate);
  expectReviewedCount({
    input: "packages/bindings/overrides/script-overload-dispatch.json",
    label: "overload-dispatch candidate census",
    expected: override.expected.candidateCount,
    observed: candidates.length,
  });
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: override.scope,
    routeCount: rows.length,
    generatedFamilyCandidateCount: candidates.length,
    blockedCount: rows.length - candidates.length,
    disjointCensus: {
      classifierOverloadDispatch: classified.length,
      alreadyOwnedDefoldValue: ownedIds.size,
      selectedForThisWave: rows.length,
    },
    inputEvidence: {
      scriptIrSha256: sha256(inputs.irText),
      bindingPatternsSha256: sha256(inputs.patternsText),
      reviewedPolicySha256: sha256(inputs.overrideText),
      alreadyOwnedReportSha256: sha256(inputs.ownedText),
      luaRegistrationSurfaceSha256: sha256(inputs.registrationSurfaceText),
    },
    evidencePolicy:
      "The canonical source-derived Lua registration surface supplies route identity, C function, registration array, source path, and source line. The eight candidates are installed in the shared native-dynamic ScriptAdapter/JSI router; real Defold Lua 5.1 tests reach every candidate descriptor and a local Bob/Extender arm64-osx bundle links the extension. Packaged-engine semantic execution, Static Hermes, and browser-host execution remain unclaimed.",
    allocationPolicy:
      "Dispatch performs a sorted static descriptor lookup, scans only reviewed fixed call shapes, and uses cached Lua references plus caller-owned frame arenas. The warmed native test observes zero C++ operator-new calls; Lua, Hermes, and engine-internal allocation is outside that claim.",
    blockerCounts: Object.fromEntries(
      [...new Set(rows.filter(({ blocker }) => blocker).map(({ blocker }) => blocker))]
        .sort(compare)
        .map((blocker) => [blocker, rows.filter((row) => row.blocker === blocker).length]),
    ),
    bindings: rows,
  };
  const recipeFacts = createScriptOverloadDispatchRecipeFacts(report);
  const native = renderScriptOverloadDispatchOutputs(recipeFacts);
  return {
    report: `${JSON.stringify(report, null, 2)}\n`,
    facts: `${JSON.stringify(recipeFacts, null, 2)}\n`,
    header: native.header,
    source: native.source,
    target: native.target,
  };
}

export async function run(check = false) {
  const inputs = await loadInputs();
  const outputs = generate(inputs);
  for (const [key, text] of Object.entries(outputs)) {
    if (check) assert((await readFile(urls[key], "utf8")) === text, `${urls[key].pathname}: generated output is stale`);
    else await writeFile(urls[key], text);
  }
  return JSON.parse(outputs.report);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check"))
    .then((report) =>
      console.log(
        `Generated ${report.generatedFamilyCandidateCount}/${report.routeCount} overload-dispatch candidates; ${report.blockedCount} are machine-blocked.`,
      ),
    )
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
