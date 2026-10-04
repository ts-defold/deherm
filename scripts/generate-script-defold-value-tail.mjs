#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import {
  contextCapability,
  parseCanonicalLuaRegistrationSurface,
  registeredRouteCapability,
} from "./lib/defold-lua-structural-capabilities.mjs";
import { declaredDerivation, expectReviewedCount, observeReviewedSource } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptValueTailRecipeFacts,
  renderScriptValueTailOutputs,
} from "../packages/compiler/src/script-value-tail-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  value: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  url: new URL("packages/bindings/generated/defold-script-url-address-classification.json", root),
  policy: new URL("packages/bindings/overrides/script-defold-value-tail-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-value-tail-bindings.json", root),
  facts: new URL("packages/bindings/generated/defold-script-value-tail-recipe-facts.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_value_tail_bindings.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_value_tail_bindings.cpp", root),
  target: new URL("packages/sdk/src/generated/script/value-tail-target-support.ts", root),
  registrationSurface: new URL("packages/bindings/generated/defold-lua-registration-surface.json", root),
};

const CODECS = new Map([
  ["nil", "Nil"],
  ["boolean", "Boolean"],
  ["number", "Number"],
  ["integer", "Number"],
  ["string", "String"],
  ["hash", "Hash"],
  ["url", "Url"],
  ["vector3", "Vector3"],
  ["matrix4", "Matrix4"],
  ["image.TYPE", "String"],
  ["liveupdate.LIVEUPDATE", "Number"],
]);
const CODEC_VALUES = new Set([...CODECS.values(), "Bytes", "None"]);
const EXECUTION_CONTEXTS = new Set(["script-instance", "gui-script-instance", "render-script-instance"]);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function identities(rows, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const ids = new Set();
  for (const row of rows) {
    assert(row && typeof row.id === "string" && row.id.length !== 0, `${label} has an invalid identity`);
    assert(!ids.has(row.id), `${label} duplicates identity ${row.id}`);
    ids.add(row.id);
  }
  return ids;
}
function sameIdentitySet(left, right, leftLabel, rightLabel) {
  assert(
    left.size === right.size && [...left].every((id) => right.has(id)),
    `${leftLabel} identities do not exactly match ${rightLabel}`,
  );
}
function validateCrossInputProvenance(ir, patterns, value, url, irText, patternsText, valueText, urlText) {
  assert(
    ir.schemaVersion === 1 &&
      typeof ir.defoldRevision === "string" &&
      ir.defoldRevision.length !== 0 &&
      Array.isArray(ir.functions),
    "script IR schema is unsupported",
  );
  assert(
    patterns.schemaVersion === 1 && typeof patterns.defoldRevision === "string" && Array.isArray(patterns.bindings),
    "script binding-pattern schema is unsupported",
  );
  assert(
    value.schemaVersion === 1 && typeof value.defoldRevision === "string" && Array.isArray(value.bindings),
    "script value-binding schema is unsupported",
  );
  assert(
    url.schemaVersion === 1 && typeof url.defoldRevision === "string" && Array.isArray(url.rows),
    "script URL-binding schema is unsupported",
  );
  assert(
    patterns.defoldRevision === ir.defoldRevision &&
      value.defoldRevision === ir.defoldRevision &&
      url.defoldRevision === ir.defoldRevision,
    "script IR, patterns, value bindings, and URL bindings Defold revisions differ",
  );
  assert(patterns.sourceSha256 === sha256(irText), "script binding patterns are stale against script IR");
  assert(url.inputEvidence?.scriptIrSha256 === sha256(irText), "script URL bindings are stale against script IR");
  assert(
    url.inputEvidence?.bindingPatternsSha256 === sha256(patternsText),
    "script URL bindings are stale against script binding patterns",
  );
  const patternIds = identities(patterns.bindings, "script binding patterns");
  const pendingIrIds = new Set(
    ir.functions.filter(({ runtimeStatus }) => runtimeStatus === "requires-universal-lua-bridge").map(({ id }) => id),
  );
  sameIdentitySet(patternIds, pendingIrIds, "script binding patterns", "runtime-pending script IR functions");
  const valueIds = identities(value.bindings, "script value bindings");
  const urlIds = identities(url.rows, "script URL bindings");
  assert(value.bindingCount === value.bindings.length, "script value-binding count is stale");
  assert(url.routeCount === url.rows.length, "script URL-binding count is stale");
  for (const id of valueIds) assert(patternIds.has(id), `${id}: script value binding is not runtime-pending`);
  for (const id of urlIds)
    assert(patternIds.has(id) && !valueIds.has(id), `${id}: script URL binding is missing or overlaps value bindings`);
  assert(
    patterns.pendingFunctionCount === patterns.bindings.length &&
      patterns.classifiedFunctionCount === patterns.bindings.length,
    "script binding-pattern count differs from its unique binding identities",
  );
  assert(sha256(valueText) !== sha256(urlText), "script value and URL binding evidence unexpectedly aliases");
}

function splitUnion(type) {
  return type
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}
function codecForType(type, id) {
  if (CODECS.has(type)) return CODECS.get(type);
  throw new Error(`${id}: exact tail codec is not reviewed for ${type}`);
}
function callShapes(fn) {
  let required = fn.parameters.length;
  while (required > 0 && fn.parameters[required - 1].optional) --required;
  const result = [];
  for (let count = required; count <= fn.parameters.length; ++count) {
    const alternatives = fn.parameters
      .slice(0, count)
      .map(({ rawType }) => splitUnion(rawType).map((type) => codecForType(type, fn.id)));
    let rows = [[]];
    for (const choices of alternatives) rows = rows.flatMap((row) => choices.map((choice) => [...row, choice]));
    result.push(...rows);
  }
  return [...new Map(result.map((shape) => [JSON.stringify(shape), shape])).values()];
}
function applyBinaryParameters(fn, family, sourceText, shapes) {
  const binaryParameters = family.codecEvidence?.binaryParameters ?? [];
  assert(Array.isArray(binaryParameters), `${family.id}: binary parameters must be an array`);
  for (const parameter of binaryParameters) {
    assert(
      Number.isInteger(parameter.index) && parameter.index >= 0 && parameter.index < fn.parameters.length,
      `${fn.id}: binary parameter index is invalid`,
    );
    const declared = fn.parameters[parameter.index];
    assert(declared.rawName === parameter.name, `${fn.id}: binary parameter name is stale`);
    assert(declared.rawType === "string", `${fn.id}: binary parameter must originate as a Lua string`);
    assert(parameter.carrier === "Uint8Array | ArrayBuffer", `${fn.id}: binary carrier is unsupported`);
    assert(
      Array.isArray(parameter.sourceSignatures) &&
        parameter.sourceSignatures.length > 0 &&
        parameter.sourceSignatures.every((signature) => sourceText.includes(signature)),
      `${fn.id}: binary parameter source evidence is stale`,
    );
    for (const shape of shapes) {
      assert(
        parameter.index < shape.length && shape[parameter.index] === "String",
        `${fn.id}: binary codec shape drifted`,
      );
      shape[parameter.index] = "Bytes";
    }
  }
  return binaryParameters;
}
function resultCodec(fn) {
  assert(fn.returns.length <= 1, `${fn.id}: tail candidate has multiple results`);
  return fn.returns.length === 0 ? "None" : codecForType(fn.returns[0], fn.id);
}
function canonicalCodecs(fn, route, sourceText, symbol) {
  assert(route, `${fn.id}: route is absent from the canonical Lua registration surface`);
  const sourceParameters = route.parameters ?? [];
  assert(sourceParameters.length === fn.parameters.length, `${fn.id}: canonical Lua parameter count drifted`);
  const inputs = fn.parameters.map(({ rawType }, index) => {
    const expected = splitUnion(rawType)
      .map((type) => codecForType(type, fn.id))
      .toSorted(compare);
    const actual = [...(sourceParameters[index]?.derived?.types ?? [])]
      .map((type) => codecForType(type, fn.id))
      .toSorted(compare);
    const optionalNil = fn.parameters[index].optional ? ["Nil"] : [];
    const codecs = [...new Set([...actual, ...optionalNil])].toSorted(compare);
    return {
      index: index + 1,
      codecs,
      documentedCodecs: expected,
      stackEvidence: sourceParameters[index].derived.accessors,
    };
  });
  const sourceResultCount =
    route.results?.derived?.min === fn.returns.length && route.results?.derived?.max === fn.returns.length
      ? route.results.derived.max
      : fn.returns.length === 0 &&
          new RegExp(
            `\\b${symbol}\\s*\\([^)]*\\)[\\s\\S]*?DM_LUA_STACK_CHECK\\s*\\(\\s*L\\s*,\\s*0\\s*\\)[\\s\\S]*?return\\s+0\\s*;`,
          ).test(sourceText)
        ? 0
        : null;
  assert(sourceResultCount !== null, `${fn.id}: canonical Lua result count drifted`);
  return {
    inputs,
    result: { codec: resultCodec(fn), sourceResultCount, canonicalSurfaceVerdict: route.results.verdict },
  };
}
function canonicalCallShapes(fn, route) {
  const allowed = (route.parameters ?? []).map(({ derived }) => {
    const codecs = (derived?.types ?? []).map((type) => codecForType(type, fn.id));
    if (derived?.optional) codecs.push("Nil");
    return new Set(codecs);
  });
  return callShapes(fn).filter((shape) => shape.every((codec, index) => allowed[index]?.has(codec)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function enumResultDomain(policy, sourceByKey, sourceTexts, id) {
  if (!policy) return { names: [], values: [] };
  const enumSource = sourceByKey.get(policy.source);
  const exportSource = sourceByKey.get(policy.exportSource);
  assert(enumSource && exportSource, `${id}: named result-domain source is missing`);
  const enumText = sourceTexts.get(enumSource.path);
  const exportText = sourceTexts.get(exportSource.path);
  const enumMatch = enumText.match(new RegExp(`\\benum\\s+${escapeRegExp(policy.enumName)}\\s*\\{([\\s\\S]*?)\\}`));
  assert(enumMatch, `${id}: named result enum ${policy.enumName} is missing`);
  const valuesByName = new Map();
  const constant = new RegExp(`\\b${escapeRegExp(policy.constantPrefix)}([A-Z0-9_]+)\\s*=\\s*(-?[0-9]+)\\s*,?`, "g");
  for (const match of enumMatch[1].matchAll(constant)) valuesByName.set(match[1], Number(match[2]));
  assert(valuesByName.size > 0, `${id}: named result enum has no explicit integer constants`);
  const exported = [...exportText.matchAll(new RegExp(`\\b${escapeRegExp(policy.exportMacro)}\\(([A-Z0-9_]+)\\)`, "g"))]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("_"));
  assert(
    exported.length > 0 && new Set(exported).size === exported.length,
    `${id}: exported named result domain is empty or duplicated`,
  );
  assert(
    exported.length === valuesByName.size && exported.every((name) => valuesByName.has(name)),
    `${id}: exported named result domain differs from ${policy.enumName}`,
  );
  const values = exported.map((name) => {
    assert(valuesByName.has(name), `${id}: exported result ${name} is absent from ${policy.enumName}`);
    return valuesByName.get(name);
  });
  assert(new Set(values).size === values.length, `${id}: named result domain aliases integer values`);
  return { names: exported.map((name) => `${policy.constantPrefix}${name}`), values };
}

export function generateScriptDefoldValueTail(inputs) {
  const ir = JSON.parse(inputs.irText);
  const patterns = JSON.parse(inputs.patternsText);
  const value = JSON.parse(inputs.valueText);
  const url = JSON.parse(inputs.urlText);
  const policy = JSON.parse(inputs.policyText);
  const registrationSurface = parseCanonicalLuaRegistrationSurface(inputs.registrationSurfaceText);
  validateCrossInputProvenance(
    ir,
    patterns,
    value,
    url,
    inputs.irText,
    inputs.patternsText,
    inputs.valueText,
    inputs.urlText,
  );
  assert(
    policy.schemaVersion === 1 && Array.isArray(policy.sources) && Array.isArray(policy.families),
    "value-tail policy schema is unsupported",
  );
  assert(
    same(policy.codecVocabulary, ["Nil", "Boolean", "Number", "String", "Hash", "Url", "Vector3", "Matrix4", "None"]),
    "value-tail codec vocabulary drifted",
  );
  const sourceByKey = new Map();
  for (const source of policy.sources) {
    assert(
      !sourceByKey.has(source.key) && inputs.sourceTexts.has(source.path),
      `${source.path}: value-tail source is missing or duplicated`,
    );
    // OBSERVED, not asserted. A pinned hash only detects that Defold edited its
    // own source, which across a release is expected and is the input to this
    // generator rather than a failure of it. A moved file becomes an audit line
    // and a restated pin for this revision. What actually checks this policy
    // against the revision being generated is the census below, which is read
    // from that revision's IR.
    observeReviewedSource({
      input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
      id: `${source.path}: value-tail`,
      source: inputs.sourceTexts.get(source.path),
      evidence: source,
    });
    sourceByKey.set(source.key, source);
  }
  const patternRows = patterns.bindings.filter(({ loweringFamily }) => loweringFamily === "defold-value");
  const alreadyOwned = new Set([...value.bindings, ...url.rows].map(({ id }) => id));
  const tailPatterns = patternRows.filter(({ id }) => !alreadyOwned.has(id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail pattern census",
    expected: policy.expectedRouteCount,
    observed: tailPatterns.length,
  });
  const fnById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const patternById = new Map(tailPatterns.map((row) => [row.id, row]));
  const seen = new Set();
  const rows = [];
  for (const family of policy.families) {
    assert(
      ["candidate", "blocked"].includes(family.disposition) && Number.isInteger(family.expectedRouteCount),
      `${family.id}: invalid value-tail family`,
    );
    assert(
      EXECUTION_CONTEXTS.has(family.requiredContext),
      `${family.id}: invalid or missing value-tail execution context`,
    );
    const familyIds = family.sourceRoutes.flatMap(({ ids }) => ids);
    assert(
      familyIds.length === family.expectedRouteCount && new Set(familyIds).size === familyIds.length,
      `${family.id}: reviewed route count drifted`,
    );
    for (const group of family.sourceRoutes) {
      const source = sourceByKey.get(group.source);
      assert(source, `${family.id}: unknown source ${group.source}`);
      const text = inputs.sourceTexts.get(source.path);
      for (const id of group.ids) {
        assert(!seen.has(id), `${id}: value-tail policy duplicates a route`);
        seen.add(id);
        const fn = fnById.get(id);
        const pattern = patternById.get(id);
        // A reviewed tail route this revision does not leave in the tail - it
        // went away, or another lane now owns it. Fatal at the reviewed
        // revision; withdrawn and reported in a declared derivation.
        if (!fn || !pattern) {
          assert(
            declaredDerivation(),
            `${id}: reviewed value-tail route is no longer the unimplemented defold-value tail`,
          );
          recordAudit({
            input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
            id,
            status: VOID,
            reason: "absent-route",
            family: family.id,
          });
          continue;
        }
        const entry = {
          id,
          stableId: stableBindingId(id),
          modulePath: fn.modulePath,
          member: fn.member,
          sourcePath: source.path,
          disposition: family.disposition,
          family: family.id,
          backend: family.backend ?? null,
          accountingDisposition: family.accountingDisposition ?? "generated-family",
          requiredContext: family.requiredContext,
        };
        const routeName =
          fn.modulePath.length && fn.modulePath[0] !== "builtins" ? [...fn.modulePath, fn.member].join(".") : fn.member;
        const registration = registeredRouteCapability(
          registrationSurface,
          routeName,
          source.path.replace(/^engine\//, ""),
        );
        if (!registration) {
          const message = `${id}: positive Lua registration is absent from canonical registration surface`;
          assert(declaredDerivation(), message);
          recordAudit({
            input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
            id,
            status: VOID,
            reason: "canonical-registration-unavailable",
            detail: message,
          });
          continue;
        }
        const surfaceRoute = registrationSurface.routes.get(routeName);
        assert(
          registration.cFunction === surfaceRoute.cFunction,
          `${id}: canonical Lua registration symbol is inconsistent`,
        );
        const context = contextCapability(text, registration.cFunction, family.requiredContext);
        if (!context) {
          const message = `${id}: canonical source does not prove ${family.requiredContext} context`;
          assert(declaredDerivation(), message);
          recordAudit({
            input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
            id,
            status: VOID,
            reason: "execution-context-unavailable",
            detail: message,
          });
          continue;
        }
        const codecEvidence = canonicalCodecs(fn, surfaceRoute, text, registration.cFunction);
        entry.sourceCapabilities = {
          registration,
          context,
          codecs: codecEvidence,
        };
        if (family.disposition === "candidate") {
          entry.sourceSymbol = registration.cFunction;
          entry.callShapes = canonicalCallShapes(fn, surfaceRoute);
          assert(entry.callShapes.length > 0, `${id}: canonical Lua codecs prove no documented call shape`);
          entry.binaryParameters = applyBinaryParameters(fn, family, text, entry.callShapes);
          if (entry.binaryParameters.length === 0) delete entry.binaryParameters;
          entry.resultCodec = resultCodec(fn);
          entry.blocker = null;
          assert(
            entry.callShapes.length !== 0 && entry.callShapes.flat().every((codec) => CODEC_VALUES.has(codec)),
            `${id}: candidate codec shape is invalid`,
          );
          if (family.codecEvidence) entry.codecEvidence = family.codecEvidence;
          if (id === "script:gui.set_texture_data") {
            assert(
              entry.callShapes.every((shape) => shape[3] === "String" && shape[4] === "Bytes"),
              `${id}: pinned Lua source requires a string texture-type codec and counted-byte payload`,
            );
          }
          if (id === "script:liveupdate.remove_mount") {
            assert(entry.resultCodec === "Number", `${id}: pinned Lua source pushes an integer dmLiveUpdate::Result`);
          }
          entry.resultDomain = enumResultDomain(family.resultDomain, sourceByKey, inputs.sourceTexts, id);
          if (entry.resultDomain.values.length === 0) delete entry.resultDomain;
        } else {
          assert(
            typeof family.blocker === "string" && typeof family.detail === "string",
            `${id}: blocked route lacks a machine-readable blocker`,
          );
          entry.sourceSymbol = registration.cFunction;
          entry.callShapes = [];
          entry.resultCodec = "None";
          entry.blocker = family.blocker;
          entry.blockerDetail = family.detail;
        }
        rows.push(entry);
      }
    }
  }
  // The reviewed policy must cover the whole remaining tail. At the reviewed
  // revision a gap is a regression in this tree; deriving another revision it
  // counts the routes that revision added to or removed from the tail.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail policy coverage",
    expected: tailPatterns.length,
    observed: [...patternById].filter(([id]) => seen.has(id)).length,
  });
  rows.sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "value-tail stable ID collision");
  const candidates = rows.filter(({ disposition }) => disposition === "candidate");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail candidate census",
    expected: policy.expectedCandidateCount,
    observed: candidates.length,
  });
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "the complete remaining defold-value tail after the generated native value-binding wave",
    coverageClaim:
      "The shared native-dynamic ScriptAdapter/JSI router can execute all 26 game-object, GUI-script, and render-script tail routes when the caller supplies the matching captured context, with source-pinned descriptors and exact ABI shape/result validation. The generated real-Lua adapter fixture reaches every descriptor through its required captured instance. Product GUI/render proxy attachment and packaged-engine semantic execution remain unverified.",
    allocationClaim:
      "Descriptor lookup, cached Lua references, and caller-owned ScriptCallFrame/arena storage avoid C++ heap allocation on the measured warmed path. The zero-allocation observation covers C++ operator new only; Lua, Hermes, and engine-internal allocators are outside that claim.",
    targetSupport: {
      nativeDynamicHermes: "generated-executable-shared-script-adapter",
      nativeStaticHermes: "not-integrated-fail-closed",
      html5BrowserHost: "not-executable-no-provider",
    },
    inputEvidence: {
      scriptIrSha256: sha256(inputs.irText),
      bindingPatternsSha256: sha256(inputs.patternsText),
      valueBindingsSha256: sha256(inputs.valueText),
      urlBindingsSha256: sha256(inputs.urlText),
      luaRegistrationSurfaceSha256: sha256(inputs.registrationSurfaceText),
      reviewedPolicySha256: sha256(inputs.policyText),
      defoldSources: policy.sources
        .map(({ path, sha256: hash }) => ({ path: `upstream/defold/${path}`, sha256: hash }))
        .sort((a, b) => compare(a.path, b.path)),
    },
    routeCount: rows.length,
    candidateCount: candidates.length,
    blockedCount: rows.length - candidates.length,
    blockerCounts: Object.fromEntries(
      [...new Set(rows.filter(({ blocker }) => blocker).map(({ blocker }) => blocker))]
        .sort(compare)
        .map((blocker) => [blocker, rows.filter((row) => row.blocker === blocker).length]),
    ),
    bindings: rows,
  };
  const recipeFacts = createScriptValueTailRecipeFacts(report);
  return { report, recipeFacts, ...renderScriptValueTailOutputs(recipeFacts) };
}

export async function loadScriptDefoldValueTailInputs() {
  const [irText, patternsText, valueText, urlText, policyText, registrationSurfaceText] = await Promise.all([
    readFile(paths.ir, "utf8"),
    readFile(paths.patterns, "utf8"),
    readFile(paths.value, "utf8"),
    readFile(paths.url, "utf8"),
    readFile(paths.policy, "utf8"),
    readFile(paths.registrationSurface, "utf8"),
  ]);
  const policy = JSON.parse(policyText);
  const sourceTexts = new Map(
    await Promise.all(
      policy.sources.map(async ({ path }) => [path, await readFile(new URL(`upstream/defold/${path}`, root), "utf8")]),
    ),
  );
  return { irText, patternsText, valueText, urlText, policyText, sourceTexts, registrationSurfaceText };
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  assert(argv.length === (check ? 1 : 0), `Unknown argument: ${argv.find((argument) => argument !== "--check")}`);
  const generated = generateScriptDefoldValueTail(await loadScriptDefoldValueTailInputs());
  const report = `${JSON.stringify(generated.report, null, 2)}\n`;
  const facts = `${JSON.stringify(generated.recipeFacts, null, 2)}\n`;
  const output = [
    [paths.report, report],
    [paths.facts, facts],
    [paths.header, generated.header],
    [paths.source, generated.source],
    [paths.target, generated.target],
  ];
  if (check)
    for (const [path, content] of output)
      assert((await readFile(path, "utf8")) === content, `${path.pathname}: generated value-tail output is stale`);
  else await Promise.all(output.map(([path, content]) => writeFile(path, content)));
  console.log(
    `${check ? "Verified" : "Generated"} ${generated.report.candidateCount}/${generated.report.routeCount} Defold value-tail captured-Lua candidates; ${generated.report.blockedCount} blocked.`,
  );
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
