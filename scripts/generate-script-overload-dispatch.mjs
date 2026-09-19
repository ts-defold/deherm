#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { assertReviewedRevision } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  override: new URL("packages/bindings/overrides/script-overload-dispatch.json", root),
  owned: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-overload-dispatch.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_overload_dispatch.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_overload_dispatch.cpp", root),
  target: new URL("packages/sdk/src/generated/script/overload-dispatch-target-support.ts", root)
};

const codecs = new Map([
  ["number", "Number"], ["vector3", "Vector3"], ["vector4", "Vector4"],
  ["quaternion", "Quaternion"], ["matrix4", "Matrix4"]
]);

function assert(value, message) { if (!value) throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function cpp(value) { return JSON.stringify(value); }
function split(value, delimiter = "|") {
  const result = []; let start = 0; let angle = 0; let round = 0; let square = 0;
  for (let index = 0; index < value.length; ++index) {
    const char = value[index];
    if (char === "<") ++angle; else if (char === ">") --angle;
    else if (char === "(") ++round; else if (char === ")") --round;
    else if (char === "[") ++square; else if (char === "]") --square;
    else if (char === delimiter && !angle && !round && !square) { result.push(value.slice(start, index).trim()); start = index + 1; }
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
    returns: returns.startsWith("(") && returns.endsWith(")") ? split(returns.slice(1, -1), ",") : [returns]
  };
}
function cartesian(parts) { return parts.reduce((rows, part) => rows.flatMap((row) => part.map((item) => [...row, item])), [[]]); }
function genericMap(fn) {
  return new Map(fn.generics.map((entry) => {
    const index = entry.indexOf(":");
    return [entry.slice(0, index).trim(), split(entry.slice(index + 1)).map((type) => type.trim())];
  }));
}
function shapesFor(fn) {
  const generics = genericMap(fn);
  const signatures = [
    { parameters: fn.parameters.map(({ rawType }) => rawType), returns: fn.returns },
    ...fn.overloads.map(overloadSignature)
  ];
  const shapes = [];
  for (const signature of signatures) {
    const variables = [...new Set(signature.parameters.filter((type) => generics.has(type)))]
      .map((name) => [name, generics.get(name)]);
    for (const assignmentValues of cartesian(variables.map(([, values]) => values))) {
      const assignment = new Map(variables.map(([name], index) => [name, assignmentValues[index]]));
      const resolve = (type) => {
        const resolved = assignment.get(type) ?? type;
        const variants = split(resolved);
        assert(variants.every((variant) => codecs.has(variant)), `${fn.id}: unsupported overload type '${resolved}'`);
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
  const [irText, patternsText, overrideText, ownedText] = await Promise.all([
    readFile(urls.ir, "utf8"), readFile(urls.patterns, "utf8"), readFile(urls.override, "utf8"), readFile(urls.owned, "utf8")
  ]);
  const override = JSON.parse(overrideText);
  const sources = await Promise.all(override.sources.map(async (entry) => ({
    ...entry, text: await readFile(new URL(`upstream/defold/${entry.path}`, root), "utf8")
  })));
  return { irText, patternsText, overrideText, ownedText, sources };
}

function renderNative(rows) {
  assert(rows.length <= 0xffff, "overload-dispatch operation count exceeds uint16_t descriptor capacity");
  const operations = rows.map((row, index) => ({ ...row, index }));
  const shapes = []; const argumentCodecs = [];
  for (const operation of operations) {
    assert(operation.index <= 0xffff, `${operation.id}: operation index exceeds uint16_t descriptor capacity`);
    assert(operation.callShapes.length <= 0xff, `${operation.id}: call-shape count exceeds uint8_t descriptor capacity`);
    assert(shapes.length <= 0xffff, `${operation.id}: shape offset exceeds uint16_t descriptor capacity`);
    operation.shapeOffset = shapes.length;
    for (const shape of operation.callShapes) {
      assert(shape.arguments.length <= 0xff, `${operation.id}: call-shape argument count exceeds uint8_t descriptor capacity`);
      assert(argumentCodecs.length <= 0xffff, `${operation.id}: argument-codec offset exceeds uint16_t descriptor capacity`);
      shapes.push({ argumentOffset: argumentCodecs.length, argumentCount: shape.arguments.length, resultCodec: shape.resultCodec });
      argumentCodecs.push(...shape.arguments);
    }
  }
  assert(shapes.length <= 0xffff, "overload-dispatch shape table exceeds uint16_t descriptor capacity");
  assert(argumentCodecs.length <= 0xffff, "overload-dispatch argument-codec table exceeds uint16_t descriptor capacity");
  const mask = (codec) => `k${codec}`;
  const header = `// Generated by scripts/generate-script-overload-dispatch.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n#include <cstdint>\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::overload_dispatch {\nenum class DispatchStatus : uint8_t { kMissing, kSuccess, kError };\nenum CodecMask : uint16_t { kNumber=1u<<0, kVector3=1u<<1, kVector4=1u<<2, kQuaternion=1u<<3, kMatrix4=1u<<4 };\nstruct Operation { uint16_t index; uint32_t stableId; const char* canonicalId; const char* modulePath; const char* member; uint16_t shapeOffset; uint8_t shapeCount; };\nstruct Shape { uint16_t argumentOffset; uint8_t argumentCount; uint16_t resultMask; };\nstruct LuaApi { void* context = nullptr; DispatchStatus (*invoke)(void*, const Operation&, const Shape&, ScriptCallFrame*, char*, size_t) noexcept = nullptr; };\ninline constexpr size_t kBindingCount = ${operations.length};\nconst Operation* operations() noexcept;\nconst Operation* find(uint32_t stableId) noexcept;\nconst Shape* shapes() noexcept;\nconst uint16_t* argumentCodecs() noexcept;\nDispatchStatus dispatch(ScriptCallFrame*, char*, size_t, const LuaApi*) noexcept;\n}\n`;
  const source = `// Generated by scripts/generate-script-overload-dispatch.mjs. Do not edit.\n#include <defold_hermes/generated_script_overload_dispatch.hpp>\n#include <cstdio>\n\nnamespace defold_hermes::overload_dispatch { namespace {\nconstexpr Operation kOperations[] = {\n${operations.map((row) => `  {${row.index}, ${row.stableId}u, ${cpp(row.id)}, ${cpp(row.modulePath.join("."))}, ${cpp(row.member)}, ${row.shapeOffset}, ${row.callShapes.length}},`).join("\n")}\n};\nconstexpr Shape kShapes[] = {\n${shapes.map((shape) => `  {${shape.argumentOffset}, ${shape.argumentCount}, ${mask(shape.resultCodec)}},`).join("\n")}\n};\nconstexpr uint16_t kArgumentCodecs[] = {\n${argumentCodecs.map((codec) => `  ${mask(codec)},`).join("\n")}\n};\nvoid fail(char* error,size_t capacity,const char* message) noexcept { if(error&&capacity) std::snprintf(error,capacity,"%s",message); }\nuint16_t valueMask(const ScriptValue& value) noexcept {\n  if(value.tag==ScriptValueTag::kNumber)return kNumber;\n  if(value.tag!=ScriptValueTag::kDefoldValue)return 0;\n  switch(value.defoldKind){case ScriptDefoldValueKind::kVector3:return kVector3;case ScriptDefoldValueKind::kVector4:return kVector4;case ScriptDefoldValueKind::kQuaternion:return kQuaternion;case ScriptDefoldValueKind::kMatrix4:return kMatrix4;default:return 0;}\n}\nbool matches(const Shape& shape,const ScriptCallFrame& frame) noexcept { if(frame.argumentCount!=shape.argumentCount||(frame.argumentCount&&!frame.arguments))return false;for(uint32_t index=0;index<frame.argumentCount;++index)if(!(valueMask(frame.arguments[index])&kArgumentCodecs[shape.argumentOffset+index]))return false;return true; }\n}\nconst Operation* find(uint32_t stableId) noexcept { size_t first=0,count=kBindingCount;while(count){const size_t step=count/2,index=first+step;if(kOperations[index].stableId<stableId){first=index+1;count-=step+1;}else count=step;}return first<kBindingCount&&kOperations[first].stableId==stableId?&kOperations[first]:nullptr;}\nconst Shape* shapes() noexcept{return kShapes;}\nconst uint16_t* argumentCodecs() noexcept{return kArgumentCodecs;}\nDispatchStatus dispatch(ScriptCallFrame* frame,char* error,size_t capacity,const LuaApi* api) noexcept {\n  if(!frame){fail(error,capacity,"Overload-dispatch call frame is null");return DispatchStatus::kError;}const Operation* operation=find(frame->stableId);if(!operation)return DispatchStatus::kMissing;frame->resultCount=0;const Shape* selected=nullptr;for(uint8_t index=0;index<operation->shapeCount;++index){const Shape& shape=kShapes[operation->shapeOffset+index];if(matches(shape,*frame)){selected=&shape;break;}}if(!selected){fail(error,capacity,"Overload-dispatch arguments do not match a reviewed call shape");return DispatchStatus::kError;}if(!frame->results||frame->resultCapacity<1){fail(error,capacity,"Overload-dispatch result storage is exhausted");return DispatchStatus::kError;}if(!api||!api->invoke){fail(error,capacity,"Overload-dispatch Lua backend is unavailable");return DispatchStatus::kError;}const DispatchStatus status=api->invoke(api->context,*operation,*selected,frame,error,capacity);if(status!=DispatchStatus::kSuccess){frame->resultCount=0;return status==DispatchStatus::kMissing?DispatchStatus::kError:status;}if(frame->resultCount!=1||!(valueMask(frame->results[0])&selected->resultMask)){frame->resultCount=0;fail(error,capacity,"Overload-dispatch Lua result does not match the reviewed call shape");return DispatchStatus::kError;}return DispatchStatus::kSuccess;\n}\n}\n`;
  const sourceWithAccessors = source.replace(
    "}\nconst Operation* find",
    "}\nconst Operation* operations() noexcept{return kOperations;}\nconst Operation* find");
  return { header, source: sourceWithAccessors };
}

export function generate(inputs) {
  const ir = JSON.parse(inputs.irText); const patterns = JSON.parse(inputs.patternsText);
  const override = JSON.parse(inputs.overrideText); const owned = JSON.parse(inputs.ownedText);
  assert(override.schemaVersion === 1, "overload-dispatch override schema drifted");
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
    detail: "the reviewed overload call shapes"
  });
  assert(patterns.sourceSha256 === sha256(inputs.irText), "overload-dispatch patterns are stale against script IR");
  assert(owned?.schemaVersion === 1, "overload-dispatch already-owned report schema drifted");
  assert(owned.defoldRevision === ir.defoldRevision, "overload-dispatch already-owned report uses a different Defold revision");
  assert(owned.bindingCount === 78, "overload-dispatch already-owned report bindingCount drifted from reviewed 78");
  assert(Array.isArray(owned.bindings) && owned.bindings.length === owned.bindingCount,
    "overload-dispatch already-owned report binding array/count drifted");
  const ownedBindingIds = new Set(); const ownedStableIds = new Set();
  for (const binding of owned.bindings) {
    assert(typeof binding?.id === "string" && binding.id.length > 0, "overload-dispatch already-owned report has a binding without an id");
    assert(!ownedBindingIds.has(binding.id), `${binding.id}: duplicate already-owned binding id`);
    ownedBindingIds.add(binding.id);
    assert(Number.isInteger(binding.stableId) && binding.stableId >= 0 && binding.stableId <= 0xffffffff,
      `${binding.id}: already-owned binding has an invalid stable ID`);
    assert(!ownedStableIds.has(binding.stableId), `${binding.id}: duplicate already-owned binding stable ID`);
    ownedStableIds.add(binding.stableId);
    assert(binding.stableId === stableBindingId(binding.id), `${binding.id}: already-owned binding stable ID drifted`);
  }
  assert(Array.isArray(patterns.bindings), "overload-dispatch binding patterns are not an array");
  assert(patterns.classifiedFunctionCount === patterns.bindings.length && patterns.pendingFunctionCount === patterns.bindings.length,
    "overload-dispatch binding-pattern classifier count drifted");
  const patternIds = new Set();
  for (const pattern of patterns.bindings) {
    assert(typeof pattern?.id === "string" && pattern.id.length > 0, "overload-dispatch binding patterns contain a row without an id");
    assert(!patternIds.has(pattern.id), `${pattern.id}: duplicate binding-pattern id`);
    patternIds.add(pattern.id);
  }
  const irById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  assert(irById.size === ir.functions.length, "overload-dispatch script IR has duplicate ids");
  for (const id of patternIds) assert(irById.has(id), `${id}: binding-pattern row is absent from pinned script IR`);
  const omittedFromPatterns = ir.functions.filter(({ id }) => !patternIds.has(id));
  assert(patterns.bindings.length + omittedFromPatterns.length === ir.functions.length &&
    omittedFromPatterns.every(({ runtimeStatus }) => runtimeStatus === "implemented-generated-lua-bridge"),
  "overload-dispatch binding-pattern count drifted against script IR");
  const sourceByKey = new Map();
  assert(Array.isArray(override.sources), "overload-dispatch reviewed policy has no source evidence");
  const expectedSourceByKey = new Map(); const expectedSourcePaths = new Set();
  for (const source of override.sources) {
    assert(typeof source?.key === "string" && source.key.length > 0, "overload-dispatch reviewed policy source has no key");
    assert(typeof source.path === "string" && source.path.length > 0, `${source.key}: reviewed policy source has no path`);
    assert(!expectedSourceByKey.has(source.key), `${source.key}: duplicate reviewed policy source key`);
    assert(!expectedSourcePaths.has(source.path), `${source.path}: duplicate reviewed policy source path`);
    expectedSourceByKey.set(source.key, source); expectedSourcePaths.add(source.path);
  }
  assert(inputs.sources.length === override.sources.length, "overload-dispatch pinned source count drifted");
  for (const source of inputs.sources) {
    const expected = expectedSourceByKey.get(source.key);
    assert(expected && expected.path === source.path && expected.sha256 === source.sha256, `${source.key}: unreviewed source evidence`);
    assert(sha256(source.text) === source.sha256, `${source.path}: pinned source hash drifted`);
    assert(!sourceByKey.has(source.key), `${source.key}: duplicate source key`); sourceByKey.set(source.key, source);
  }
  const classified = patterns.bindings.filter((row) => row.loweringFamily === "overload-dispatch");
  assert(classified.length === override.expected.classifiedRouteCount,
    `classified ${classified.length} overload-dispatch routes, expected ${override.expected.classifiedRouteCount}`);
  const ownedIds = new Set(override.alreadyOwned.ids);
  assert(ownedIds.size === override.alreadyOwned.ids.length, "overload-dispatch already-owned ids are duplicated");
  for (const id of ownedIds) assert(ownedBindingIds.has(id), `${id}: reviewed already-owned route is absent from the Defold-value report`);
  const selected = classified.filter(({ id }) => !ownedIds.has(id));
  assert(new Set(selected.map(({ id }) => id)).size === selected.length, "overload-dispatch selected routes contain duplicate ids");
  assert(selected.length === override.expected.selectedRouteCount,
    `selected ${selected.length} overload-dispatch routes, expected ${override.expected.selectedRouteCount}`);
  assert(Object.keys(override.routes).length === selected.length, "overload-dispatch policy coverage drifted");
  const rows = selected.map((pattern) => {
    const fn = irById.get(pattern.id); const policy = override.routes[pattern.id];
    assert(fn, `${pattern.id}: selected route is absent from pinned IR`); assert(policy, `${pattern.id}: missing reviewed policy`);
    const source = sourceByKey.get(policy.source); assert(source, `${pattern.id}: unknown reviewed source '${policy.source}'`);
    assert(source.text.includes(policy.anchor), `${pattern.id}: pinned source anchor drifted`);
    const candidate = policy.strategy === "generated-defold-value-dispatch";
    assert(candidate || policy.strategy === "blocked", `${pattern.id}: unknown reviewed strategy '${policy.strategy}'`);
    assert(candidate || typeof policy.blocker === "string", `${pattern.id}: blocked route has no machine blocker`);
    return { id: fn.id, stableId: stableBindingId(fn.id), modulePath: fn.modulePath, member: fn.member,
      strategy: policy.strategy, generatedFamilyExecutableCandidate: candidate,
      callShapes: candidate ? shapesFor(fn) : [], blocker: candidate ? null : policy.blocker,
      sourceEvidence: { path: `upstream/defold/${source.path}`, sha256: source.sha256, anchor: policy.anchor },
      targetSupport: candidate ? { nativeDynamicHermes: "generated-executable-shared-script-adapter", nativeStaticHermes: "not-integrated-fail-closed", html5BrowserHost: "not-executable-no-generated-provider" } :
        { nativeDynamicHermes: `blocked-${policy.blocker}`, nativeStaticHermes: `blocked-${policy.blocker}`, html5BrowserHost: `blocked-${policy.blocker}` }
    };
  }).sort((left, right) => left.stableId - right.stableId);
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "overload-dispatch stable-ID collision");
  const candidates = rows.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate);
  assert(candidates.length === override.expected.candidateCount, `classified ${candidates.length} overload-dispatch candidates, expected ${override.expected.candidateCount}`);
  const report = { schemaVersion: 1, defoldRevision: ir.defoldRevision,
    scope: override.scope, routeCount: rows.length, generatedFamilyCandidateCount: candidates.length, blockedCount: rows.length - candidates.length,
    disjointCensus: { classifierOverloadDispatch: classified.length, alreadyOwnedDefoldValue: ownedIds.size, selectedForThisWave: rows.length },
    inputEvidence: { scriptIrSha256: sha256(inputs.irText), bindingPatternsSha256: sha256(inputs.patternsText), reviewedPolicySha256: sha256(inputs.overrideText), alreadyOwnedReportSha256: sha256(inputs.ownedText) },
    evidencePolicy: "Pinned source hashes and anchors record the reviewed registration surface. The eight candidates are installed in the shared native-dynamic ScriptAdapter/JSI router; real Defold Lua 5.1 tests reach every candidate descriptor and a local Bob/Extender arm64-osx bundle links the extension. Packaged-engine semantic execution, Static Hermes, and browser-host execution remain unclaimed.",
    allocationPolicy: "Dispatch performs a sorted static descriptor lookup, scans only reviewed fixed call shapes, and uses cached Lua references plus caller-owned frame arenas. The warmed native test observes zero C++ operator-new calls; Lua, Hermes, and engine-internal allocation is outside that claim.",
    blockerCounts: Object.fromEntries([...new Set(rows.filter(({ blocker }) => blocker).map(({ blocker }) => blocker))].sort(compare).map((blocker) => [blocker, rows.filter((row) => row.blocker === blocker).length])),
    bindings: rows };
  const native = renderNative(candidates);
  const target = `// Generated by scripts/generate-script-overload-dispatch.mjs. Do not edit.\nexport const scriptOverloadDispatchTargetSupport = ${JSON.stringify(rows.map(({ id, stableId, generatedFamilyExecutableCandidate, targetSupport }) => ({ id, stableId, generatedFamilyExecutableCandidate, targetSupport })), null, 2)} as const;\nexport const scriptOverloadDispatchCandidateIds = ${JSON.stringify(candidates.map(({ id }) => id), null, 2)} as const;\nexport function assertOverloadDispatchTargetSupport(target: string | undefined, canonicalId: string): void {\n  const entry = scriptOverloadDispatchTargetSupport.find(({ id }) => id === canonicalId);\n  if (!entry) return;\n  if (target === "html5-browser-host") throw new Error(\`${"${canonicalId}"} is not executable in the HTML5 browser host: no generated overload-dispatch provider\`);\n  if (!entry.generatedFamilyExecutableCandidate) throw new Error(\`${"${canonicalId}"} is blocked: ${"${entry.targetSupport.nativeDynamicHermes}"}\`);\n}\n`;
  return { report: `${JSON.stringify(report, null, 2)}\n`, header: native.header, source: native.source, target };
}

export async function run(check = false) {
  const inputs = await loadInputs(); const outputs = generate(inputs);
  for (const [key, text] of Object.entries(outputs)) {
    if (check) assert(await readFile(urls[key], "utf8") === text, `${urls[key].pathname}: generated output is stale`);
    else await writeFile(urls[key], text);
  }
  return JSON.parse(outputs.report);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check")).then((report) => console.log(`Generated ${report.generatedFamilyCandidateCount}/${report.routeCount} overload-dispatch candidates; ${report.blockedCount} are machine-blocked.`)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
