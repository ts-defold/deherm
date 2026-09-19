#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stableBindingId } from "./lib/binding-identity.mjs";
import { declaredDerivation, expectReviewedCount, loadReviewedSources } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  schemaOverrides: new URL("packages/bindings/overrides/script-table-tuple-schema-overrides.json", root),
  registrations: new URL("packages/bindings/overrides/script-fixed-tuple-registrations.json", root),
  report: new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root),
  probes: new URL("packages/bindings/generated/defold-script-fixed-tuple-probes.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_fixed_tuples.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_fixed_tuples.cpp", root),
  target: new URL("packages/sdk/src/generated/script/fixed-tuple-target-support.ts", root)
};

function assert(value, message) { if (!value) throw new Error(message); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function hex(id) { return `0x${id.toString(16).padStart(8, "0")}`; }
function cpp(value) { return JSON.stringify(value); }

const primitive = new Map([
  ["nil", "Nil"], ["boolean", "Boolean"], ["integer", "Integer"], ["number", "Number"],
  ["string", "String"], ["hash", "Hash"], ["url", "Url"], ["node", "GuiNode"],
  ["vector3", "Vector3"], ["vector4", "Vector4"], ["quaternion", "Quaternion"]
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
  const [irText, patternsText, schemaOverridesText, registrationsText] = await Promise.all([
    readFile(urls.ir, "utf8"), readFile(urls.patterns, "utf8"),
    readFile(urls.schemaOverrides, "utf8"), readFile(urls.registrations, "utf8")
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
    derived: JSON.parse(irText).defoldRevision
  });
  const sources = registrations.sources
    .filter(({ path }) => !loaded.withdrawn.has(path))
    .map((entry) => ({ ...entry, text: loaded.texts.get(entry.path) }));
  return {
    irText, patternsText, schemaOverridesText, registrationsText, sources,
    withdrawnSources: loaded.withdrawn
  };
}

export function generate(irText, patternsText, schemaOverridesText, registrationsText, sources, withdrawnSources = new Set()) {
  const ir = JSON.parse(irText);
  const patterns = JSON.parse(patternsText);
  const schemaOverrides = JSON.parse(schemaOverridesText);
  const registrations = JSON.parse(registrationsText);
  assert(registrations.schemaVersion === 1, "fixed tuple registration schema drifted");
  const sourceByPrefix = new Map();
  for (const source of sources) {
    // The reviewed hash was observed while loading, where a moved file becomes
    // an audit line rather than a refusal: a pinned hash only detects that
    // Defold edited its own source, which across a release is expected and is
    // the input to this generator. What actually checks this policy against the
    // revision being generated is the census below, read from that revision's IR.
    assert(!sourceByPrefix.has(source.modulePrefix), `duplicate module source ${source.modulePrefix}`);
    sourceByPrefix.set(source.modulePrefix, source);
  }
  // A module whose reviewed registration source this revision does not have
  // registers nothing here. Its routes are withdrawn rather than asserted
  // against a source that is gone.
  const withdrawnPrefixes = new Set(registrations.sources
    .filter(({ path }) => withdrawnSources.has(path)).map(({ modulePrefix }) => modulePrefix));
  const functionById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const excluded = new Set(schemaOverrides.overrides.map(({ id }) => id));
  const selected = patterns.bindings.filter(({ id, loweringFamily, parameterCodecs, returnCodecs }) =>
    loweringFamily === "multi-result" && !excluded.has(id) &&
    [...parameterCodecs, ...returnCodecs].every(({ rawType }) => rawType.split("|").every((type) => {
      try { atomCodec(type, id); return true; } catch { return false; }
    }))).map((pattern) => ({
      id: pattern.id,
      bucket: pattern.returnCodecs.some(({ rawType }) => /(?:^|\|)(?:vector3|vector4|quaternion)(?:\||$)/.test(rawType))
        ? "fixed-value-tuple" : "fixed-scalar-tuple"
    })).filter(({ id }) => {
      const module = functionById.get(id)?.modulePath.join(".");
      if (withdrawnPrefixes.has(module)) return false;
      if (sourceByPrefix.has(module)) return true;
      // A multi-result route in a module the review never saw. At the reviewed
      // revision that is a gap in this tree and stays fatal; in a derivation of
      // another revision it is a module that revision registers and this one
      // does not, so it is withdrawn and reported rather than emitted with a
      // context nobody reviewed.
      assert(declaredDerivation(), `${id}: no exact source registration`);
      recordAudit({
        input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
        id, status: VOID, reason: "unreviewed-module", module
      });
      return false;
    });
  // The census is evidence at the revision it was counted at and an observation
  // anywhere else: a revision that registers a different number of fixed tuples
  // is the measurement, not an error.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
    label: "fixed-tuple route census",
    expected: registrations.expectedRouteCount, observed: selected.length
  });
  const bucketCounts = Object.fromEntries(Object.keys(registrations.expectedBucketCounts).map((bucket) =>
    [bucket, selected.filter((row) => row.bucket === bucket).length]));
  for (const [bucket, expected] of Object.entries(registrations.expectedBucketCounts)) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-fixed-tuple-registrations.json",
      label: `fixed-tuple bucket census:${bucket}`,
      expected, observed: bucketCounts[bucket]
    });
  }
  const rows = selected.map((classified) => {
    const fn = functionById.get(classified.id);
    assert(fn, `${classified.id}: absent from pinned IR`);
    const module = fn.modulePath.join(".");
    const evidence = sourceByPrefix.get(module);
    assert(evidence, `${classified.id}: no exact source registration`);
    const registration = new RegExp(`["']${fn.member}["']\\s*,`);
    assert(registration.test(evidence.text), `${classified.id}: Lua registration anchor drifted`);
    const args = fn.parameters.map((parameter, index) => ({
      index, rawType: parameter.rawType, optional: parameter.optional,
      codecs: codecs(parameter.rawType, `${fn.id} argument ${index}`),
      implementedCodecs: codecs(parameter.rawType, `${fn.id} argument ${index}`).filter((codec) => codec !== "Url")
    }));
    const results = fn.returns.map((rawType, index) => ({
      index, rawType, codecs: codecs(rawType, `${fn.id} result ${index}`)
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
      sourceEvidence: { path: evidence.path, sha256: evidence.sha256, registration: fn.member },
      targetSupport: {
        nativeHermes: "generated-executable",
        // The fixed-tuple codecs are a native optimization, not the route's
        // only lane: `callScriptApi` dispatches the same stable ID through the
        // generated universal direct-memory provider in the browser.
        html5BrowserHost: "generated-executable-through-universal-transport",
        publicTypeScriptFixture: hasUserdataInput ? "blocked-missing-handle-producer" : "reachable"
      }
    };
  }).sort((left, right) => Number.parseInt(left.stableId) - Number.parseInt(right.stableId));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "fixed tuple stable ID collision");
  const codecVocabulary = [...new Set(rows.flatMap((row) => [
    ...row.arguments.flatMap((arg) => arg.codecs), ...row.results.flatMap((result) => result.codecs)
  ]))].sort(compare);
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    bindingCount: rows.length,
    bucketCounts,
    tupleArityCounts: Object.fromEntries([2, 3, 4].map((arity) => [arity, rows.filter((row) => row.results.length === arity).length])),
    publicTypeScriptReachableCount: rows.filter((row) => row.targetSupport.publicTypeScriptFixture === "reachable").length,
    blockedHandleProducerCount: rows.filter((row) => row.targetSupport.publicTypeScriptFixture === "blocked-missing-handle-producer").length,
    codecVocabulary,
    allocationPolicy: "Fixed descriptor arrays and caller-owned result/string scratch; result strings and Defold POD values are copied before Lua stack restoration; no recursive marshaler.",
    bindings: rows
  };
  const probes = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "Planned real-engine evidence dispositions for generated fixed tuples; no observation is promoted by generation",
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
        "reject-wrong-tag-arity-context-target"
      ]
    }))
  };

  const allCodecs = ["Nil", "Boolean", "Integer", "Number", "String", "Hash", "Url", "GuiNode", "LuaUserdata", "Vector3", "Vector4", "Quaternion"];
  const codecBits = new Map(allCodecs.map((name, index) => [name, 1 << index]));
  const flatArgs = rows.flatMap((row) => row.arguments.map((arg) => arg.implementedCodecs.reduce((bits, codec) => bits | codecBits.get(codec), 0)));
  const flatResults = rows.flatMap((row) => row.results.map((result) => result.codecs.reduce((bits, codec) => bits | codecBits.get(codec), 0)));
  let argOffset = 0; let resultOffset = 0;
  const descriptors = rows.map((row, index) => {
    const value = { ...row, index, argOffset, resultOffset };
    argOffset += row.arguments.length; resultOffset += row.results.length;
    return value;
  });
  const header = `// Generated by scripts/generate-script-fixed-tuples.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n#include <cstdint>\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::fixed_tuple {\nenum class DispatchStatus : uint8_t { kMissing, kSuccess, kError };\nenum class Context : uint8_t { kGlobal, kScriptInstance, kGuiScriptInstance };\nenum CodecMask : uint16_t {\n${allCodecs.map((name, index) => `  k${name} = 1u << ${index},`).join("\n")}\n};\nstruct Operation { uint16_t index; uint32_t stableId; const char* canonicalId; const char* modulePath; const char* member; Context context; uint16_t argumentOffset; uint16_t resultOffset; uint8_t requiredArgumentCount; uint8_t maximumArgumentCount; uint8_t resultCount; };\nstruct LuaApi { void* context = nullptr; DispatchStatus (*invoke)(void*, const Operation&, const uint16_t*, const uint16_t*, ScriptCallFrame*, char*, size_t) noexcept = nullptr; };\ninline constexpr size_t kBindingCount = ${rows.length};\ninline constexpr size_t kMaximumResultCount = ${Math.max(...rows.map((row) => row.results.length))};\nconst Operation* find(uint32_t stableId) noexcept;\nconst uint16_t* argumentCodecs() noexcept;\nconst uint16_t* resultCodecs() noexcept;\nDispatchStatus dispatch(ScriptCallFrame*, char*, size_t, const LuaApi*) noexcept;\n}\n`;
  const source = `// Generated by scripts/generate-script-fixed-tuples.mjs. Do not edit.\n#include <defold_hermes/generated_script_fixed_tuples.hpp>\n#include <cmath>\n#include <cstdio>\n\nnamespace defold_hermes::fixed_tuple { namespace {\nconstexpr Operation kOperations[] = {\n${descriptors.map((row) => `  {${row.index}, ${row.stableId}u, ${cpp(row.id)}, ${cpp(row.modulePath.join("."))}, ${cpp(row.member)}, Context::k${row.context}, ${row.argOffset}, ${row.resultOffset}, ${row.requiredArgumentCount}, ${row.maximumArgumentCount}, ${row.results.length}},`).join("\n")}\n};\nconstexpr uint16_t kArgumentCodecs[] = { ${flatArgs.join(", ")} };\nconstexpr uint16_t kResultCodecs[] = { ${flatResults.join(", ")} };\nbool fail(char* error, size_t capacity, const char* message) noexcept { if (error && capacity) std::snprintf(error, capacity, "%s", message); return false; }\nuint16_t valueMask(const ScriptValue& value) noexcept {\n  switch (value.tag) {\n    case ScriptValueTag::kNull: case ScriptValueTag::kUndefined: return kNil;\n    case ScriptValueTag::kBoolean: return kBoolean;\n    case ScriptValueTag::kNumber: return kInteger | kNumber;\n    case ScriptValueTag::kString: return kString;\n    case ScriptValueTag::kHandle: if (value.handleKind == ScriptHandleKind::kHash) return kHash; if (value.handleKind == ScriptHandleKind::kUrl) return kUrl; if (value.handleKind == ScriptHandleKind::kGuiNode) return kGuiNode; if (value.handleKind == ScriptHandleKind::kLuaUserdata) return kLuaUserdata; return 0;\n    case ScriptValueTag::kDefoldValue: if (value.defoldKind == ScriptDefoldValueKind::kVector3) return kVector3; if (value.defoldKind == ScriptDefoldValueKind::kVector4) return kVector4; if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) return kQuaternion; return 0;\n    default: return 0;\n  }\n}\n}\nconst Operation* find(uint32_t stableId) noexcept { size_t first=0,count=kBindingCount; while(count){size_t step=count/2,index=first+step;if(kOperations[index].stableId<stableId){first=index+1;count-=step+1;}else count=step;} return first<kBindingCount&&kOperations[first].stableId==stableId?&kOperations[first]:nullptr; }\nconst uint16_t* argumentCodecs() noexcept { return kArgumentCodecs; }\nconst uint16_t* resultCodecs() noexcept { return kResultCodecs; }\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t capacity, const LuaApi* api) noexcept {\n  if (!frame) { fail(error,capacity,"Fixed tuple call frame is null"); return DispatchStatus::kError; }\n  const Operation* operation=find(frame->stableId); if(!operation) return DispatchStatus::kMissing; frame->resultCount=0;\n  if(frame->argumentCount<operation->requiredArgumentCount||frame->argumentCount>operation->maximumArgumentCount||(frame->argumentCount&&!frame->arguments)){fail(error,capacity,"Fixed tuple argument count does not match descriptor");return DispatchStatus::kError;}\n  for(uint32_t index=0;index<frame->argumentCount;++index){const ScriptValue& value=frame->arguments[index];const uint16_t mask=valueMask(value);if(!(mask&kArgumentCodecs[operation->argumentOffset+index])){fail(error,capacity,"Fixed tuple argument tag does not match positional codec");return DispatchStatus::kError;}if(value.tag==ScriptValueTag::kNumber&&(kArgumentCodecs[operation->argumentOffset+index]&kInteger)&&!(kArgumentCodecs[operation->argumentOffset+index]&kNumber)&&(!std::isfinite(value.number)||std::trunc(value.number)!=value.number)){fail(error,capacity,"Fixed tuple integer argument is not exact");return DispatchStatus::kError;}}\n  if(!frame->results||frame->resultCapacity<operation->resultCount){fail(error,capacity,"Fixed tuple result storage is exhausted");return DispatchStatus::kError;}\n  if(!api||!api->invoke){fail(error,capacity,"Fixed tuple Lua backend is unavailable");return DispatchStatus::kError;}\n  return api->invoke(api->context,*operation,kArgumentCodecs,kResultCodecs,frame,error,capacity);\n}\n}\n`;
  const ids = rows.map((row) => `  ${cpp(row.id)},`).join("\n");
  const target = `// Generated by scripts/generate-script-fixed-tuples.mjs. Do not edit.\n// The fixed-tuple lane is a native codec optimization. Every one of these\n// routes still reaches the browser host through the generated universal\n// direct-memory provider, so this gate carries no route and exists only so the\n// SDK keeps one declared target-support seam per family.\nconst fixedTupleIds: ReadonlySet<string> = new Set<string>([\n${ids}\n]);\nexport function assertFixedTupleTargetSupport(target: string | undefined, stableId: number, canonicalId?: string): void {\n  if (target !== "html5-browser-host") return;\n  void fixedTupleIds;\n  void stableId;\n  void canonicalId;\n}\n`;
  return { report: `${JSON.stringify(report, null, 2)}\n`, probes: `${JSON.stringify(probes, null, 2)}\n`, header, source, target };
}

export async function run(check = false) {
  const outputs = generate(...Object.values(await loadInputs()));
  for (const [key, contents] of Object.entries(outputs)) {
    const url = urls[key];
    if (check) assert(await readFile(url, "utf8") === contents, `${url.pathname}: generated output is stale`);
    else await writeFile(url, contents);
  }
  return JSON.parse(outputs.report);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check")).then((report) => console.log(`Generated ${report.bindingCount} fixed tuple bindings (${report.publicTypeScriptReachableCount} publicly reachable, ${report.blockedHandleProducerCount} awaiting handle producers).`)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode=1; });
}
