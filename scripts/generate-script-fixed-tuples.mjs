#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableBindingId } from "./lib/binding-identity.mjs";
import {
  contextCapability,
  parseCanonicalLuaRegistrationSurface,
  registeredRouteCapability,
} from "./lib/defold-lua-structural-capabilities.mjs";
import { declaredDerivation, expectReviewedCount, loadReviewedSources } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptFixedTuplesRecipeFacts,
  renderScriptFixedTuplesOutputs,
} from "../packages/compiler/src/script-fixed-tuples-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  schemaOverrides: new URL("packages/bindings/overrides/script-table-tuple-schema-overrides.json", root),
  registrations: new URL("packages/bindings/overrides/script-fixed-tuple-registrations.json", root),
  registrationSurface: new URL("packages/bindings/generated/defold-lua-registration-surface.json", root),
  report: new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root),
  facts: new URL("packages/bindings/generated/defold-script-fixed-tuples-recipe-facts.json", root),
  probes: new URL("packages/bindings/generated/defold-script-fixed-tuple-probes.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_fixed_tuples.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_fixed_tuples.cpp", root),
  target: new URL("packages/sdk/src/generated/script/fixed-tuple-target-support.ts", root),
};

function assert(value, message) {
  if (!value) throw new Error(message);
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function hex(id) {
  return `0x${id.toString(16).padStart(8, "0")}`;
}
const primitive = new Map([
  ["nil", "Nil"],
  ["boolean", "Boolean"],
  ["integer", "Integer"],
  ["number", "Number"],
  ["string", "String"],
  ["hash", "Hash"],
  ["url", "Url"],
  ["node", "GuiNode"],
  ["vector3", "Vector3"],
  ["vector4", "Vector4"],
  ["quaternion", "Quaternion"],
]);
function atomCodec(type, position) {
  if (primitive.has(type)) return primitive.get(type);
  if (/^(?:btCollisionObject|btTypedConstraint|btRigidBody|btCollisionShape)$/.test(type)) return "LuaUserdata";
  if (/^[a-z0-9_.]+\.[A-Z][A-Z0-9_]*$/.test(type)) return "Integer";
  throw new Error(`${position}: no reviewed fixed tuple codec for '${type}'`);
}
function codecs(rawType, position) {
  return [...new Set(rawType.split("|").map((type) => atomCodec(type, position)))].sort(compare);
}

export async function loadInputs() {
  const [irText, patternsText, schemaOverridesText, registrationsText, registrationSurfaceText] = await Promise.all([
    readFile(urls.ir, "utf8"),
    readFile(urls.patterns, "utf8"),
    readFile(urls.schemaOverrides, "utf8"),
    readFile(urls.registrations, "utf8"),
    readFile(urls.registrationSurface, "utf8"),
  ]);
  const registrations = JSON.parse(registrationsText);
  // Tolerant on purpose: the reviewed registrations cite the whole `bullet3d`
  // backend, which Defold 1.13.1 does not ship at all. Opening each path with a
  // bare `readFile` died with ENOENT on the first of them, which is a backend
  // that revision does not have rather than a broken review. Sources that are
  // absent - or present with a reviewed anchor gone - are withdrawn, and the
  // routes their module registers are dropped below.
  const loaded = await loadReviewedSources({
    input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
    defoldRoot: fileURLToPath(new URL("upstream/defold", root)),
    evidence: registrations.sources,
    derived: JSON.parse(irText).defoldRevision,
  });
  const sources = registrations.sources
    .filter(({ path }) => !loaded.withdrawn.has(path))
    .map((entry) => ({ ...entry, text: loaded.texts.get(entry.path) }));
  return {
    irText,
    patternsText,
    schemaOverridesText,
    registrationsText,
    registrationSurfaceText,
    sources,
    withdrawnSources: loaded.withdrawn,
  };
}

export function generate(
  irText,
  patternsText,
  schemaOverridesText,
  registrationsText,
  registrationSurfaceText,
  sources,
  withdrawnSources = new Set(),
) {
  const ir = JSON.parse(irText);
  const patterns = JSON.parse(patternsText);
  const schemaOverrides = JSON.parse(schemaOverridesText);
  const registrations = JSON.parse(registrationsText);
  const registrationSurface = parseCanonicalLuaRegistrationSurface(registrationSurfaceText);
  assert(registrations.schemaVersion === 2, "fixed tuple registration schema drifted");
  const sourceByPath = new Map();
  for (const source of sources) {
    // The reviewed hash was observed while loading, where a moved file becomes
    // an audit line rather than a refusal: a pinned hash only detects that
    // Defold edited its own source, which across a release is expected and is
    // the input to this generator. What actually checks this policy against the
    // revision being generated is the census below, read from that revision's IR.
    const canonicalPath = source.path.replace(/^engine\//, "");
    assert(!sourceByPath.has(canonicalPath), `duplicate fixed-tuple source ${canonicalPath}`);
    sourceByPath.set(canonicalPath, source);
  }
  // A module whose reviewed registration source this revision does not have
  // registers nothing here. Its routes are withdrawn rather than asserted
  // against a source that is gone.
  const withdrawnPaths = new Set(
    registrations.sources
      .filter(({ path }) => withdrawnSources.has(path))
      .map(({ path }) => path.replace(/^engine\//, "")),
  );
  const functionById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const excluded = new Set(schemaOverrides.overrides.map(({ id }) => id));
  const selected = patterns.bindings
    .filter(
      ({ id, loweringFamily, parameterCodecs, returnCodecs }) =>
        loweringFamily === "multi-result" &&
        !excluded.has(id) &&
        [...parameterCodecs, ...returnCodecs].every(({ rawType }) =>
          rawType.split("|").every((type) => {
            try {
              atomCodec(type, id);
              return true;
            } catch {
              return false;
            }
          }),
        ),
    )
    .map((pattern) => ({
      id: pattern.id,
      bucket: pattern.returnCodecs.some(({ rawType }) => /(?:^|\|)(?:vector3|vector4|quaternion)(?:\||$)/.test(rawType))
        ? "fixed-value-tuple"
        : "fixed-scalar-tuple",
    }))
    .filter(({ id }) => {
      const fn = functionById.get(id);
      const routeName = [...fn.modulePath, fn.member].join(".");
      const registration = registeredRouteCapability(registrationSurface, routeName);
      if (!registration || withdrawnPaths.has(registration?.sourcePath)) {
        const message = `${id}: positive Lua registration is absent or its reviewed source was withdrawn`;
        assert(declaredDerivation(), message);
        recordAudit({
          input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
          id,
          status: VOID,
          reason: registration ? "withdrawn-registration-source" : "canonical-registration-unavailable",
          detail: message,
        });
        return false;
      }
      if (sourceByPath.has(registration.sourcePath)) return true;
      assert(declaredDerivation(), `${id}: canonical registration source has no reviewed execution context`);
      recordAudit({
        input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
        id,
        status: VOID,
        reason: "unreviewed-context-source",
        source: registration.sourcePath,
      });
      return false;
    });
  // The census is evidence at the revision it was counted at and an observation
  // anywhere else: a revision that registers a different number of fixed tuples
  // is the measurement, not an error.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
    label: "fixed-tuple route census",
    expected: registrations.expectedRouteCount,
    observed: selected.length,
  });
  const bucketCounts = Object.fromEntries(
    Object.keys(registrations.expectedBucketCounts).map((bucket) => [
      bucket,
      selected.filter((row) => row.bucket === bucket).length,
    ]),
  );
  for (const [bucket, expected] of Object.entries(registrations.expectedBucketCounts)) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
      label: `fixed-tuple bucket census:${bucket}`,
      expected,
      observed: bucketCounts[bucket],
    });
  }
  const rows = selected
    .map((classified) => {
      const fn = functionById.get(classified.id);
      assert(fn, `${classified.id}: absent from pinned IR`);
      const routeName = [...fn.modulePath, fn.member].join(".");
      const registration = registeredRouteCapability(registrationSurface, routeName);
      assert(registration, `${classified.id}: positive Lua registration is absent from canonical registration surface`);
      const evidence = sourceByPath.get(registration.sourcePath);
      assert(evidence, `${classified.id}: canonical registration source has no reviewed execution context`);
      const contextKind =
        evidence.context === "GuiScriptInstance"
          ? "gui-script-instance"
          : evidence.context === "ScriptInstance"
            ? "script-instance"
            : evidence.context === "Global"
              ? "global"
              : null;
      assert(contextKind, `${classified.id}: unsupported reviewed execution context`);
      const context = contextCapability(evidence.text, registration.cFunction, contextKind);
      if (!context) {
        const message = `${classified.id}: canonical registered function does not prove ${contextKind} context`;
        assert(declaredDerivation(), message);
        recordAudit({
          input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
          id: classified.id,
          status: VOID,
          reason: "execution-context-unavailable",
          detail: message,
        });
        return null;
      }
      const args = fn.parameters.map((parameter, index) => ({
        index,
        rawType: parameter.rawType,
        optional: parameter.optional,
        codecs: codecs(parameter.rawType, `${fn.id} argument ${index}`),
        implementedCodecs: codecs(parameter.rawType, `${fn.id} argument ${index}`).filter((codec) => codec !== "Url"),
      }));
      const results = fn.returns.map((rawType, index) => ({
        index,
        rawType,
        codecs: codecs(rawType, `${fn.id} result ${index}`),
      }));
      assert(results.length >= 2 && results.length <= 4, `${fn.id}: tuple arity is outside fixed capacity`);
      const hasUserdataInput = args.some((arg) => arg.codecs.includes("LuaUserdata"));
      return {
        id: fn.id,
        stableId: hex(stableBindingId(fn.id)),
        modulePath: fn.modulePath,
        member: fn.member,
        context: evidence.context,
        bucket: classified.bucket,
        requiredArgumentCount: args.filter(({ optional }) => !optional).length,
        maximumArgumentCount: args.length,
        arguments: args,
        results,
        sourceCapabilities: { registration, context },
        sourceEvidence: { path: evidence.path, sha256: evidence.sha256, registration: fn.member },
        targetSupport: {
          nativeHermes: "generated-executable",
          // The fixed-tuple codecs are a native optimization, not the route's
          // only lane: `callScriptApi` dispatches the same stable ID through the
          // generated universal direct-memory provider in the browser.
          html5BrowserHost: "generated-executable-through-universal-transport",
          publicTypeScriptFixture: hasUserdataInput ? "blocked-missing-handle-producer" : "reachable",
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number.parseInt(left.stableId) - Number.parseInt(right.stableId));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "fixed tuple stable ID collision");
  const emittedBucketCounts = Object.fromEntries(
    Object.keys(registrations.expectedBucketCounts).map((bucket) => [
      bucket,
      rows.filter((row) => row.bucket === bucket).length,
    ]),
  );
  const codecVocabulary = [
    ...new Set(
      rows.flatMap((row) => [
        ...row.arguments.flatMap((arg) => arg.codecs),
        ...row.results.flatMap((result) => result.codecs),
      ]),
    ),
  ].sort(compare);
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    bindingCount: rows.length,
    bucketCounts: emittedBucketCounts,
    tupleArityCounts: Object.fromEntries(
      [2, 3, 4].map((arity) => [arity, rows.filter((row) => row.results.length === arity).length]),
    ),
    publicTypeScriptReachableCount: rows.filter((row) => row.targetSupport.publicTypeScriptFixture === "reachable")
      .length,
    blockedHandleProducerCount: rows.filter(
      (row) => row.targetSupport.publicTypeScriptFixture === "blocked-missing-handle-producer",
    ).length,
    codecVocabulary,
    allocationPolicy:
      "Fixed descriptor arrays and caller-owned result/string scratch; result strings and Defold POD values are copied before Lua stack restoration; no recursive marshaler.",
    bindings: rows,
  };
  const probes = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope:
      "Planned real-engine evidence dispositions for generated fixed tuples; no observation is promoted by generation",
    routeCount: rows.length,
    scenarios: rows.map((row) => ({
      id: `fixed-tuple.${row.id.slice("script:".length)}`,
      routeId: row.id,
      evidence: { compile: "planned", link: "planned", runtime: "planned" },
      exactResultCount: row.results.length,
      preserveInteriorNil: row.results.some((result) => result.codecs.includes("Nil")),
      publicTypeScriptFixture: row.targetSupport.publicTypeScriptFixture,
      requirements: [
        `active-context:${row.context}`,
        `exact-positional-codecs:${row.results.map((result) => result.codecs.join("|")).join(",")}`,
        "copy-before-stack-restore",
        "reject-wrong-tag-arity-context-target",
      ],
    })),
  };

  const recipeFacts = createScriptFixedTuplesRecipeFacts(report);
  const rendered = renderScriptFixedTuplesOutputs(recipeFacts);
  return {
    report: `${JSON.stringify(report, null, 2)}\n`,
    probes: `${JSON.stringify(probes, null, 2)}\n`,
    facts: `${JSON.stringify(recipeFacts, null, 2)}\n`,
    header: rendered.header,
    source: rendered.source,
    target: rendered.target,
  };
}

export async function run(check = false) {
  const outputs = generate(...Object.values(await loadInputs()));
  for (const [key, contents] of Object.entries(outputs)) {
    const url = urls[key];
    if (check) assert((await readFile(url, "utf8")) === contents, `${url.pathname}: generated output is stale`);
    else await writeFile(url, contents);
  }
  return JSON.parse(outputs.report);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check"))
    .then((report) =>
      console.log(
        `Generated ${report.bindingCount} fixed tuple bindings (${report.publicTypeScriptReachableCount} publicly reachable, ${report.blockedHandleProducerCount} awaiting handle producers).`,
      ),
    )
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
