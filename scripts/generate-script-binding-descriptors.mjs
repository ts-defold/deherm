import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";

const FAMILY_ENTRIES = [
  ["dynamic-values", "DynamicValues", 0],
  ["callback-lifecycle", "CallbackLifecycle", 1],
  ["overload-dispatch", "OverloadDispatch", 2],
  ["multi-result", "MultiResult", 3],
  ["lua-table", "LuaTable", 4],
  ["borrowed-handle", "BorrowedHandle", 5],
  ["defold-value", "DefoldValue", 6],
  ["scalar", "Scalar", 7]
];

const CODEC_ENTRIES = [
  ["scalar", "Scalar", 1 << 0],
  ["value", "Value", 1 << 1],
  ["table", "Table", 1 << 2],
  ["handle", "Handle", 1 << 3],
  ["callback", "Callback", 1 << 4],
  ["dynamic", "Dynamic", 1 << 5],
  ["polymorphic", "Polymorphic", 1 << 6],
  ["nil", "Nil", 1 << 7]
];

const TRAIT_ENTRIES = [
  ["variable-arguments", "VariableArguments", 1 << 0],
  ["variable-results", "VariableResults", 1 << 1],
  ["dynamic-any", "DynamicAny", 1 << 2],
  ["generic-runtime-tag", "GenericRuntimeTag", 1 << 3],
  ["callback-lifetime", "CallbackLifetime", 1 << 4],
  ["documented-overload-conformance", "DocumentedOverloadConformance", 1 << 5],
  ["generic-runtime-dispatch", "GenericRuntimeDispatch", 1 << 6],
  ["fixed-multi-result", "FixedMultiResult", 1 << 7],
  ["heterogeneous-union", "HeterogeneousUnion", 1 << 8]
];

const PARAMETER_FLAG_ENTRIES = [
  ["optional", "Optional", 1 << 0],
  ["variadic", "Variadic", 1 << 1]
];

const FAMILY_VALUE = new Map(FAMILY_ENTRIES.map(([key, , value]) => [key, value]));
const FAMILY_CPP = new Map(FAMILY_ENTRIES.map(([key, cpp]) => [key, cpp]));
const CODEC_VALUE = new Map(CODEC_ENTRIES.map(([key, , value]) => [key, value]));
const TRAIT_VALUE = new Map(TRAIT_ENTRIES.map(([key, , value]) => [key, value]));

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function enumObject(entries) {
  return Object.fromEntries(entries.map(([key, , value]) => [key, value]));
}

function codecMask(codecs, context) {
  let mask = 0;
  for (const codec of codecs) {
    const bit = CODEC_VALUE.get(codec);
    assert(bit !== undefined, `Unknown codec '${codec}' in ${context}`);
    mask |= bit;
  }
  return mask;
}

function traitKind(trait) {
  if (trait.startsWith("heterogeneous-union:")) return "heterogeneous-union";
  return trait;
}

function traitMask(traits, context) {
  let mask = 0;
  for (const trait of traits) {
    const kind = traitKind(trait);
    const bit = TRAIT_VALUE.get(kind);
    assert(bit !== undefined, `Unknown trait '${trait}' in ${context}`);
    mask |= bit;
  }
  return mask;
}

function intern(values) {
  const table = [...new Set(values)].sort(compareText);
  const index = new Map(table.map((value, position) => [value, position]));
  return { table, index };
}

function validateInputs(ir, patterns) {
  assert(ir.defoldRevision === patterns.defoldRevision, "IR and pattern Defold revisions differ");
  assert(patterns.coverageClaim === "classification only; no executable binding coverage is claimed", "Pattern report overstates executable coverage");

  const pending = ir.functions
    .filter((entry) => entry.runtimeStatus === "requires-universal-lua-bridge")
    .slice()
    .sort((left, right) => compareText(left.id, right.id));
  const classified = patterns.bindings.slice().sort((left, right) => compareText(left.id, right.id));
  assert(pending.length === patterns.pendingFunctionCount, "Pattern pending count differs from IR");
  assert(classified.length === patterns.classifiedFunctionCount, "Pattern classified count differs from binding rows");
  assert(pending.length === classified.length, "Pending functions are not classified exactly once");
  assert(new Set(classified.map((entry) => entry.id)).size === classified.length, "Pattern bindings contain duplicate stable keys");

  for (let index = 0; index < pending.length; index += 1) {
    const functionEntry = pending[index];
    const pattern = classified[index];
    assert(functionEntry.id === pattern.id, `Missing or extra classification at '${functionEntry.id}'`);
    assert(functionEntry.rawName === pattern.rawName, `Raw name mismatch for '${functionEntry.id}'`);
    assert(functionEntry.source === pattern.source, `Source mismatch for '${functionEntry.id}'`);
    assert(functionEntry.line === pattern.line, `Source line mismatch for '${functionEntry.id}'`);
    assert(pattern.runtimeStatus === "classified-not-implemented", `Unexpected runtime claim for '${functionEntry.id}'`);
    assert(FAMILY_VALUE.has(pattern.loweringFamily), `Unknown family '${pattern.loweringFamily}' in '${functionEntry.id}'`);
    assert(functionEntry.parameters.length === pattern.parameterCodecs.length, `Parameter count mismatch for '${functionEntry.id}'`);
    assert(functionEntry.returns.length === pattern.returnCodecs.length, `Return count mismatch for '${functionEntry.id}'`);
    for (let parameterIndex = 0; parameterIndex < functionEntry.parameters.length; parameterIndex += 1) {
      const parameter = functionEntry.parameters[parameterIndex];
      const codec = pattern.parameterCodecs[parameterIndex];
      assert(parameter.rawName === codec.name, `Parameter name mismatch for '${functionEntry.id}' at ${parameterIndex}`);
      assert(parameter.rawType === codec.rawType, `Parameter type mismatch for '${functionEntry.id}' at ${parameterIndex}`);
      assert(parameter.optional === codec.optional, `Parameter optionality mismatch for '${functionEntry.id}' at ${parameterIndex}`);
    }
    for (let returnIndex = 0; returnIndex < functionEntry.returns.length; returnIndex += 1) {
      const codec = pattern.returnCodecs[returnIndex];
      assert(codec.index === returnIndex, `Return index mismatch for '${functionEntry.id}' at ${returnIndex}`);
      assert(functionEntry.returns[returnIndex] === codec.rawType, `Return type mismatch for '${functionEntry.id}' at ${returnIndex}`);
    }
  }
  return { pending, classified };
}

function semanticInputHashes(pending, classified) {
  const irRows = pending.map(({ id, rawName, modulePath, member, jsName, parameters, returns, source, line, runtimeStatus }) => ({
    id,
    rawName,
    modulePath,
    member,
    jsName,
    parameters,
    returns,
    source,
    line,
    runtimeStatus
  }));
  const patternRows = classified.map(({ id, loweringFamily, parameterCodecs, returnCodecs, traits, runtimeStatus }) => ({
    id,
    loweringFamily,
    parameterCodecs,
    returnCodecs,
    traits,
    runtimeStatus
  }));
  return {
    scriptIrSemanticSha256: sha256(canonicalJson(irRows)),
    bindingPatternsSemanticSha256: sha256(canonicalJson(patternRows))
  };
}

export function generateScriptBindingDescriptors(ir, patterns) {
  const { pending, classified } = validateInputs(ir, patterns);
  assert(pending.length <= 0xffff, "Binding count exceeds uint16_t ID capacity");

  const byId = new Map(pending.map((entry) => [entry.id, entry]));
  const sourceFiles = intern(pending.map((entry) => entry.source));
  const modulePaths = intern(pending.map((entry) => entry.modulePath.join(".")));
  assert(sourceFiles.table.length <= 0xff, "Source-file table exceeds uint8_t index capacity");
  assert(modulePaths.table.length <= 0xff, "Module-path table exceeds uint8_t index capacity");

  const hot = {
    stableId: [],
    family: [],
    parameterBegin: [],
    parameterCount: [],
    returnBegin: [],
    returnCount: [],
    minimumArity: [],
    maximumArity: [],
    traitMask: [],
    parameterCodecUnion: [],
    returnCodecUnion: [],
    parameterCodecMask: [],
    parameterFlags: [],
    returnCodecMask: []
  };
  const cold = {
    sourceFiles: sourceFiles.table,
    modulePaths: modulePaths.table,
    stableKeys: [],
    rawNames: [],
    jsNames: [],
    members: [],
    sourceFileIndex: [],
    sourceLines: [],
    modulePathIndex: []
  };
  const stableIds = new Map();

  for (let numericId = 0; numericId < classified.length; numericId += 1) {
    const pattern = classified[numericId];
    const functionEntry = byId.get(pattern.id);
    const persistentId = stableBindingId(pattern.id);
    const collision = stableIds.get(persistentId);
    assert(!collision, `Stable binding ID collision: '${collision}' and '${pattern.id}'`);
    stableIds.set(persistentId, pattern.id);
    assert(hot.parameterCodecMask.length <= 0xffff, "Parameter codec table exceeds uint16_t offsets");
    assert(hot.returnCodecMask.length <= 0xffff, "Return codec table exceeds uint16_t offsets");

    const parameterMasks = pattern.parameterCodecs.map((parameter) => codecMask(parameter.codecs, `${pattern.id}:${parameter.name}`));
    const returnMasks = pattern.returnCodecs.map((result) => codecMask(result.codecs, `${pattern.id}:return:${result.index}`));
    const variadic = pattern.traits.includes("variable-arguments");
    const minimumArity = pattern.parameterCodecs.filter((parameter) => !parameter.optional && parameter.name !== "...").length;
    assert(pattern.parameterCodecs.length <= 0xff, `Parameter count exceeds uint8_t in '${pattern.id}'`);
    assert(pattern.returnCodecs.length <= 0xff, `Return count exceeds uint8_t in '${pattern.id}'`);
    assert(minimumArity <= 0xff, `Minimum arity exceeds uint8_t in '${pattern.id}'`);

    hot.stableId.push(persistentId);
    hot.family.push(FAMILY_VALUE.get(pattern.loweringFamily));
    hot.parameterBegin.push(hot.parameterCodecMask.length);
    hot.parameterCount.push(pattern.parameterCodecs.length);
    hot.returnBegin.push(hot.returnCodecMask.length);
    hot.returnCount.push(pattern.returnCodecs.length);
    hot.minimumArity.push(minimumArity);
    hot.maximumArity.push(variadic ? 0xff : pattern.parameterCodecs.length);
    hot.traitMask.push(traitMask(pattern.traits, pattern.id));
    hot.parameterCodecUnion.push(parameterMasks.reduce((mask, value) => mask | value, 0));
    hot.returnCodecUnion.push(returnMasks.reduce((mask, value) => mask | value, 0));
    hot.parameterCodecMask.push(...parameterMasks);
    hot.parameterFlags.push(...pattern.parameterCodecs.map((parameter) =>
      (parameter.optional ? PARAMETER_FLAG_ENTRIES[0][2] : 0) |
      (parameter.name === "..." ? PARAMETER_FLAG_ENTRIES[1][2] : 0)));
    hot.returnCodecMask.push(...returnMasks);

    cold.stableKeys.push(pattern.id);
    cold.rawNames.push(pattern.rawName);
    cold.jsNames.push(functionEntry.jsName);
    cold.members.push(functionEntry.member);
    cold.sourceFileIndex.push(sourceFiles.index.get(pattern.source));
    cold.sourceLines.push(pattern.line);
    cold.modulePathIndex.push(modulePaths.index.get(functionEntry.modulePath.join(".")));
  }

  assert(hot.parameterCodecMask.length <= 0xffff, "Parameter codec table exceeds uint16_t offsets");
  assert(hot.returnCodecMask.length <= 0xffff, "Return codec table exceeds uint16_t offsets");
  assert(Math.max(...cold.sourceLines) <= 0xffff, "Source line exceeds uint16_t capacity");

  const semanticHashes = semanticInputHashes(pending, classified);
  const descriptorPayload = {
    defoldRevision: ir.defoldRevision,
    idPolicy: "persistent collision-checked FNV-1a stable IDs plus dense zero-based revision-scoped indices",
    families: enumObject(FAMILY_ENTRIES),
    codecs: enumObject(CODEC_ENTRIES),
    traits: enumObject(TRAIT_ENTRIES),
    parameterFlags: enumObject(PARAMETER_FLAG_ENTRIES),
    hot,
    cold
  };
  const descriptorAbiSha256 = sha256(canonicalJson(descriptorPayload));
  const artifact = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "runtime-pending Defold script functions only",
    coverageClaim: "descriptor generation only; no executable binding coverage is claimed",
    idPolicy: {
      stableIdentity: "cold.stableKeys[denseIndex]",
      stableId: "32-bit FNV-1a of the canonical stable key; generation fails on collision",
      denseIndex: "zero-based array index",
      ordering: "ascending Unicode code-unit order of stable keys",
      compatibility: "stable IDs persist when unrelated rows are added; dense indices require an exact descriptor ABI fingerprint"
    },
    inputHashes: semanticHashes,
    descriptorAbiSha256,
    bindingCount: classified.length,
    parameterSlotCount: hot.parameterCodecMask.length,
    returnSlotCount: hot.returnCodecMask.length,
    families: enumObject(FAMILY_ENTRIES),
    codecs: enumObject(CODEC_ENTRIES),
    traits: enumObject(TRAIT_ENTRIES),
    parameterFlags: enumObject(PARAMETER_FLAG_ENTRIES),
    hot,
    cold
  };
  return { artifact, header: renderCppHeader(artifact) };
}

function renderNumbers(values, indent = "    ", columns = 20) {
  const lines = [];
  for (let index = 0; index < values.length; index += columns) {
    lines.push(`${indent}${values.slice(index, index + columns).join(", ")}`);
  }
  return lines.join(",\n");
}

function renderStrings(values, indent = "    ", columns = 4) {
  const encoded = values.map((value) => JSON.stringify(value));
  return renderTokens(encoded, indent, columns);
}

function renderTokens(values, indent = "    ", columns = 8) {
  const lines = [];
  for (let index = 0; index < values.length; index += columns) {
    lines.push(`${indent}${values.slice(index, index + columns).join(", ")}`);
  }
  return lines.join(",\n");
}

function renderFamilyValues(values) {
  return values.map((value) => {
    const entry = FAMILY_ENTRIES.find(([, , enumValue]) => enumValue === value);
    return `Family::${entry[1]}`;
  });
}

function renderEnum(name, underlyingType, entries) {
  return `enum class ${name} : ${underlyingType} {\n${entries.map(([, cpp, value]) => `  ${cpp} = ${value}`).join(",\n")}\n};`;
}

function renderBitEnum(name, underlyingType, entries) {
  return `enum ${name} : ${underlyingType} {\n  ${name}None = 0,\n${entries.map(([, cpp, value]) => `  ${name}${cpp} = ${value}`).join(",\n")}\n};`;
}

function renderCppHeader(artifact) {
  const { hot, cold } = artifact;
  const bindingCount = artifact.bindingCount;
  const parameterCount = artifact.parameterSlotCount;
  const returnCount = artifact.returnSlotCount;
  return `// Generated by scripts/generate-script-binding-descriptors.mjs. Do not edit.
#ifndef DEFOLD_HERMES_GENERATED_SCRIPT_BINDING_DESCRIPTORS_HPP
#define DEFOLD_HERMES_GENERATED_SCRIPT_BINDING_DESCRIPTORS_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace defold_hermes::script_descriptors {

using StableBindingId = std::uint32_t;
using DenseBindingIndex = std::uint16_t;
inline constexpr std::size_t kBindingCount = ${bindingCount};
inline constexpr std::size_t kParameterSlotCount = ${parameterCount};
inline constexpr std::size_t kReturnSlotCount = ${returnCount};
inline constexpr std::uint8_t kVariableArity = 255;
inline constexpr std::string_view kDescriptorAbiSha256 = "${artifact.descriptorAbiSha256}";

${renderEnum("Family", "std::uint8_t", FAMILY_ENTRIES)}

${renderBitEnum("Codec", "std::uint16_t", CODEC_ENTRIES)}

${renderBitEnum("Trait", "std::uint16_t", TRAIT_ENTRIES)}

${renderBitEnum("ParameterFlag", "std::uint8_t", PARAMETER_FLAG_ENTRIES)}

namespace hot {

inline constexpr std::array<StableBindingId, kBindingCount> kStableId = {{
${renderNumbers(hot.stableId)}
}};
inline constexpr std::array<Family, kBindingCount> kFamily = {{
${renderTokens(renderFamilyValues(hot.family))}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kParameterBegin = {{
${renderNumbers(hot.parameterBegin)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kParameterCount = {{
${renderNumbers(hot.parameterCount)}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kReturnBegin = {{
${renderNumbers(hot.returnBegin)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kReturnCount = {{
${renderNumbers(hot.returnCount)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kMinimumArity = {{
${renderNumbers(hot.minimumArity)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kMaximumArity = {{
${renderNumbers(hot.maximumArity)}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kTraitMask = {{
${renderNumbers(hot.traitMask)}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kParameterCodecUnion = {{
${renderNumbers(hot.parameterCodecUnion)}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kReturnCodecUnion = {{
${renderNumbers(hot.returnCodecUnion)}
}};
inline constexpr std::array<std::uint16_t, kParameterSlotCount> kParameterCodecMask = {{
${renderNumbers(hot.parameterCodecMask)}
}};
inline constexpr std::array<std::uint8_t, kParameterSlotCount> kParameterFlags = {{
${renderNumbers(hot.parameterFlags)}
}};
inline constexpr std::array<std::uint16_t, kReturnSlotCount> kReturnCodecMask = {{
${renderNumbers(hot.returnCodecMask)}
}};

}  // namespace hot

namespace cold {

inline constexpr std::array<std::string_view, ${cold.sourceFiles.length}> kSourceFiles = {{
${renderStrings(cold.sourceFiles)}
}};
inline constexpr std::array<std::string_view, ${cold.modulePaths.length}> kModulePaths = {{
${renderStrings(cold.modulePaths)}
}};
inline constexpr std::array<std::string_view, kBindingCount> kStableKeys = {{
${renderStrings(cold.stableKeys)}
}};
inline constexpr std::array<std::string_view, kBindingCount> kRawNames = {{
${renderStrings(cold.rawNames)}
}};
inline constexpr std::array<std::string_view, kBindingCount> kJsNames = {{
${renderStrings(cold.jsNames)}
}};
inline constexpr std::array<std::string_view, kBindingCount> kMembers = {{
${renderStrings(cold.members)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kSourceFileIndex = {{
${renderNumbers(cold.sourceFileIndex)}
}};
inline constexpr std::array<std::uint16_t, kBindingCount> kSourceLines = {{
${renderNumbers(cold.sourceLines)}
}};
inline constexpr std::array<std::uint8_t, kBindingCount> kModulePathIndex = {{
${renderNumbers(cold.modulePathIndex)}
}};

}  // namespace cold

constexpr bool isValidDenseIndex(DenseBindingIndex index) noexcept { return index < kBindingCount; }
constexpr bool hasCodec(std::uint16_t mask, Codec codec) noexcept {
  return (mask & static_cast<std::uint16_t>(codec)) != 0;
}
constexpr bool hasTrait(DenseBindingIndex index, Trait trait) noexcept {
  return isValidDenseIndex(index) &&
      (hot::kTraitMask[index] & static_cast<std::uint16_t>(trait)) != 0;
}

static_assert(kBindingCount <= 0xffff, "DenseBindingIndex capacity exceeded");
static_assert(kParameterSlotCount <= 0xffff, "parameter offset capacity exceeded");
static_assert(kReturnSlotCount <= 0xffff, "return offset capacity exceeded");
static_assert(hot::kParameterBegin.back() + hot::kParameterCount.back() == kParameterSlotCount,
              "parameter descriptor table is not contiguous");
static_assert(hot::kReturnBegin.back() + hot::kReturnCount.back() == kReturnSlotCount,
              "return descriptor table is not contiguous");

}  // namespace defold_hermes::script_descriptors

#endif  // DEFOLD_HERMES_GENERATED_SCRIPT_BINDING_DESCRIPTORS_HPP
`;
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const root = new URL("../", import.meta.url);
  const irUrl = new URL("bindings/generated/defold-script-api-ir.json", root);
  const patternUrl = new URL("bindings/generated/defold-script-binding-patterns.json", root);
  const jsonUrl = new URL("bindings/generated/defold-script-binding-descriptors.json", root);
  const headerUrl = new URL("defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp", root);
  const [irText, patternText] = await Promise.all([readFile(irUrl, "utf8"), readFile(patternUrl, "utf8")]);
  assert(sha256(irText) === JSON.parse(patternText).sourceSha256, "Pattern report is stale relative to the script IR");
  const { artifact, header } = generateScriptBindingDescriptors(JSON.parse(irText), JSON.parse(patternText));
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (check) {
    const [existingJson, existingHeader] = await Promise.all([readFile(jsonUrl, "utf8"), readFile(headerUrl, "utf8")]);
    assert(existingJson === json, `${jsonUrl.pathname} is stale; regenerate script binding descriptors`);
    assert(existingHeader === header, `${headerUrl.pathname} is stale; regenerate script binding descriptors`);
  } else {
    await Promise.all([writeFile(jsonUrl, json), writeFile(headerUrl, header)]);
  }
  console.log(`${check ? "Verified" : "Generated"} ${artifact.bindingCount} script binding descriptors (${artifact.parameterSlotCount} parameters, ${artifact.returnSlotCount} returns)`);
  console.log(`Descriptor ABI: ${artifact.descriptorAbiSha256}; executable coverage claimed: no`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
