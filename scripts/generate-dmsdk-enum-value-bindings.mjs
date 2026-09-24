import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { semanticDeclarationId, semanticEntryMap } from "./lib/dmsdk-semantic-id.mjs";

export { semanticDeclarationId } from "./lib/dmsdk-semantic-id.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  scalarReport: "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
  overrides: "packages/bindings/overrides/dmsdk-enum-value-bindings.json",
};
const KIND = { void: 0, bool: 1, u32: 2, u64: 3, i32: 4 };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) => value.replace(/::/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
const leaf = (value) => String(value).split("::").at(-1);

function parseArgs(argv) {
  const result = { outRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") result.check = true;
    else if (argv[index] === "--out-root") result.outRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return result;
}

function typeIndex(ir) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of ir.declarations) {
    if (!declaration.name || !["enum", "type-alias"].includes(declaration.kind)) continue;
    if (!exact.has(declaration.name) || declaration.kind === "enum") exact.set(declaration.name, declaration);
    const values = leaves.get(leaf(declaration.name)) ?? [];
    values.push(declaration);
    leaves.set(leaf(declaration.name), values);
  }
  return { exact, leaves };
}

function resolveType(type, symbol, index) {
  const clean = String(type).replace(/\b(?:const|volatile|enum|struct|class)\b/g, "").replace(/\s+/g, " ").trim();
  if (index.exact.has(clean)) return index.exact.get(clean);
  const namespace = String(symbol).split("::").slice(0, -1).join("::");
  if (namespace && index.exact.has(`${namespace}::${clean}`)) return index.exact.get(`${namespace}::${clean}`);
  const matches = index.leaves.get(leaf(clean)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function abiType(type, symbol, index, seen = new Set()) {
  const direct = { void: "void", bool: "bool", uint32_t: "u32", uint64_t: "u64", dmhash_t: "u64" }[type];
  if (direct) return { kind: direct, native: type };
  const resolved = resolveType(type, symbol, index);
  if (!resolved || seen.has(resolved.id)) throw new Error(`Unresolved enum-value ABI type ${type} in ${symbol}`);
  seen.add(resolved.id);
  if (resolved.kind === "enum") return { kind: "i32", native: type, enum: resolved };
  return abiType(resolved.type, resolved.name, index, seen);
}

function cType(kind) {
  return { void: "void", bool: "uint8_t", u32: "uint32_t", u64: "uint64_t", i32: "int32_t" }[kind];
}

function wrapperName(declaration, parameters) {
  const suffix = parameters.length ? parameters.map(({ abi }) => abi.kind).join("_") : "v";
  return `deherm_dmsdk_enum_${snake(declaration.name)}_${suffix}`;
}

function sourceGroup(header) {
  if (header.includes("/buffer.h")) return { name: "buffer", include: "dmsdk/dlib/buffer.h" };
  if (header.includes("/log.h")) return { name: "log", include: "dmsdk/dlib/log.h" };
  if (header.includes("/graphics.h")) return { name: "graphics", include: "dmsdk/graphics/graphics.h" };
  if (header.includes("/sound.h")) return { name: "sound", include: "dmsdk/sound/sound.h" };
  throw new Error(`No source group for ${header}`);
}

function cArguments(entry) {
  return entry.parameters.map(({ parameter, abi }) => {
    if (abi.enum) return `static_cast<${abi.native}>(${parameter.name})`;
    if (abi.kind === "bool") return `${parameter.name} != 0`;
    return parameter.name;
  }).join(", ");
}

function cDefinition(entry) {
  const parameters = entry.parameters.map(({ parameter, abi }) => `${cType(abi.kind)} ${parameter.name}`).join(", ") || "void";
  const call = `${entry.declaration.name}(${cArguments(entry)})`;
  let body = `    ${call};`;
  if (entry.result.kind === "bool") body = `    return ${call} ? UINT8_C(1) : UINT8_C(0);`;
  else if (entry.result.kind === "i32") body = `    return static_cast<int32_t>(${call});`;
  else if (entry.result.kind !== "void") body = `    return ${call};`;
  return `${cType(entry.result.kind)} ${entry.wrapper}(${parameters})\n{\n${body}\n}`;
}

function enumDomain(abi) {
  return abi.enum ? [...new Set(abi.enum.members.filter(({ name }) => !/(?:^|_)(?:MAX|COUNT|NUM)(?:_|$)/.test(name)).map(({ value }) => value))].sort((a, b) => a - b) : undefined;
}

function validateExpression(parameter, position) {
  const domain = enumDomain(parameter.abi);
  if (!domain) return undefined;
  return `(${domain.map((value) => `unpack_i32(arguments[${position}]) == INT32_C(${value})`).join(" || ")})`;
}

function rawCall(entry) {
  const validations = entry.parameters.map(validateExpression).filter(Boolean);
  const args = entry.parameters.map(({ abi }, position) => {
    if (abi.kind === "bool") return `arguments[${position}] != 0`;
    if (abi.kind === "i32") return `unpack_i32(arguments[${position}])`;
    return `static_cast<${cType(abi.kind)}>(arguments[${position}])`;
  }).join(", ");
  const call = `${entry.wrapper}(${args})`;
  const validation = validations.length ? `      if (!(${validations.join(" && ")})) return DEHERM_DMSDK_ENUM_INVALID_ENUM;\n` : "";
  let result = `      ${call};\n      *out_result = UINT64_C(0);`;
  if (entry.result.kind === "i32") result = `      *out_result = static_cast<uint64_t>(static_cast<int64_t>(${call}));`;
  else if (entry.result.kind !== "void") result = `      *out_result = static_cast<uint64_t>(${call});`;
  return `${validation}${result}`;
}

function tsType(abi) {
  if (abi.enum) return enumDomain(abi).join(" | ");
  return abi.kind === "bool" ? "boolean" : abi.kind === "u64" ? "bigint" : abi.kind === "void" ? "void" : "number";
}

function tsName(entry) {
  const words = snake(entry.declaration.name).split("_");
  return words[0] + words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
}

function renderHeader(entries) {
  const declarations = entries.map((entry) => `${cType(entry.result.kind)} ${entry.wrapper}(${entry.parameters.map(({ parameter, abi }) => `${cType(abi.kind)} ${parameter.name}`).join(", ") || "void"});`).join("\n");
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_ENUM_VALUE_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_ENUM_VALUE_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderSource(group, entries) {
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_enum_value.h>\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN "deherm"\n#endif\n#include <${group.include}>\nextern "C" {\n${entries.map(cDefinition).join("\n\n")}\n}\n`;
}

function renderRuntimeHeader(entries) {
  const maxArgs = Math.max(...entries.map(({ parameters }) => parameters.length));
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_ENUM_VALUE_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_ENUM_VALUE_RUNTIME_H\n#include <stdint.h>\n#define DEHERM_DMSDK_ENUM_MAX_ARGUMENTS ${maxArgs}\ntypedef enum DehermDmSdkEnumKind { DEHERM_DMSDK_ENUM_VOID=0, DEHERM_DMSDK_ENUM_BOOL=1, DEHERM_DMSDK_ENUM_U32=2, DEHERM_DMSDK_ENUM_U64=3, DEHERM_DMSDK_ENUM_I32=4 } DehermDmSdkEnumKind;\ntypedef enum DehermDmSdkEnumStatus { DEHERM_DMSDK_ENUM_OK=0, DEHERM_DMSDK_ENUM_UNKNOWN_ID=1, DEHERM_DMSDK_ENUM_WRONG_ARITY=2, DEHERM_DMSDK_ENUM_NULL_STORAGE=3, DEHERM_DMSDK_ENUM_INVALID_ENUM=4 } DehermDmSdkEnumStatus;\ntypedef struct DehermDmSdkEnumDescriptor { uint16_t id; uint8_t argument_count; uint8_t result_kind; uint8_t argument_kinds[DEHERM_DMSDK_ENUM_MAX_ARGUMENTS]; const char* declaration_id; } DehermDmSdkEnumDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_enum_count(void);\nconst DehermDmSdkEnumDescriptor* deherm_dmsdk_enum_descriptors(void);\nDehermDmSdkEnumStatus deherm_dmsdk_enum_dispatch(uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* out_result);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderRuntime(entries) {
  const maxArgs = Math.max(...entries.map(({ parameters }) => parameters.length));
  const descriptors = entries.map((entry) => {
    const kinds = entry.parameters.map(({ abi }) => KIND[abi.kind]);
    while (kinds.length < maxArgs) kinds.push(0);
    return `  { UINT16_C(${entry.id}), UINT8_C(${entry.parameters.length}), UINT8_C(${KIND[entry.result.kind]}), { ${kinds.map((kind) => `UINT8_C(${kind})`).join(", ")} }, ${JSON.stringify(entry.declaration.id)} }`;
  }).join(",\n");
  const cases = entries.map((entry) => `    case ${entry.id}:\n${rawCall(entry)}\n      return DEHERM_DMSDK_ENUM_OK;`).join("\n");
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_enum_value.h>\n#include <defold_hermes/generated_dmsdk_enum_value_runtime.h>\n#include <cstring>\nnamespace {\nconst DehermDmSdkEnumDescriptor kDescriptors[] = {\n${descriptors}\n};\nint32_t unpack_i32(uint64_t raw) { const uint32_t bits=static_cast<uint32_t>(raw); int32_t value=0; static_assert(sizeof(bits)==sizeof(value),"i32 width"); std::memcpy(&value,&bits,sizeof(value)); return value; }\n}\nextern "C" {\nuint32_t deherm_dmsdk_enum_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkEnumDescriptor* deherm_dmsdk_enum_descriptors(void) { return kDescriptors; }\nDehermDmSdkEnumStatus deherm_dmsdk_enum_dispatch(uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* out_result) {\n  if (id >= deherm_dmsdk_enum_count()) return DEHERM_DMSDK_ENUM_UNKNOWN_ID;\n  const DehermDmSdkEnumDescriptor& descriptor = kDescriptors[id];\n  if (argument_count != descriptor.argument_count) return DEHERM_DMSDK_ENUM_WRONG_ARITY;\n  if (out_result == nullptr || (argument_count && arguments == nullptr)) return DEHERM_DMSDK_ENUM_NULL_STORAGE;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_ENUM_UNKNOWN_ID;\n  }\n}\n}\n`;
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#pragma once\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes { void installDmSdkEnumValueModule(facebook::jsi::Runtime&, facebook::jsi::Object&); }\n#endif\n`;
}

function renderJsi() {
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_enum_value_jsi.hpp>\n#if !defined(DM_PLATFORM_HTML5)\n#include <defold_hermes/generated_dmsdk_enum_value_runtime.h>\n#include <cmath>\nnamespace defold_hermes { namespace jsi=facebook::jsi; namespace {\nbool integer(const jsi::Value& value) { return value.isNumber() && std::isfinite(value.asNumber()) && std::trunc(value.asNumber()) == value.asNumber(); }\nuint64_t encode(jsi::Runtime& runtime, const jsi::Value& value, uint8_t kind) {\n  if (kind == DEHERM_DMSDK_ENUM_BOOL) { if (!value.isBool()) throw jsi::JSError(runtime, "expected boolean"); return value.getBool(); }\n  if (kind == DEHERM_DMSDK_ENUM_U64) { if (!value.isBigInt()) throw jsi::JSError(runtime, "expected u64 bigint"); auto bigint=value.getBigInt(runtime); if (!bigint.isUint64(runtime)) throw jsi::JSError(runtime, "u64 bigint out of range"); return bigint.asUint64(runtime); }\n  if (!integer(value)) throw jsi::JSError(runtime, "expected integer enum/scalar");\n  const double number=value.asNumber(); if (kind == DEHERM_DMSDK_ENUM_U32 && (number < 0 || number > 4294967295.0)) throw jsi::JSError(runtime, "u32 out of range");\n  if (kind == DEHERM_DMSDK_ENUM_I32 && (number < -2147483648.0 || number > 2147483647.0)) throw jsi::JSError(runtime, "i32 out of range");\n  return kind == DEHERM_DMSDK_ENUM_I32 ? static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(number))) : static_cast<uint64_t>(number);\n}\njsi::Value decode(jsi::Runtime& runtime, uint8_t kind, uint64_t raw) {\n  if (kind == DEHERM_DMSDK_ENUM_VOID) return jsi::Value::undefined();\n  if (kind == DEHERM_DMSDK_ENUM_BOOL) return jsi::Value(raw != 0);\n  if (kind == DEHERM_DMSDK_ENUM_U64) return jsi::BigInt::fromUint64(runtime, raw);\n  if (kind == DEHERM_DMSDK_ENUM_I32) return jsi::Value(static_cast<double>(static_cast<int32_t>(raw)));\n  return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));\n}\n}\nvoid installDmSdkEnumValueModule(jsi::Runtime& runtime, jsi::Object& modules) {\n  jsi::Object module(runtime);\n  auto call=jsi::Function::createFromHostFunction(runtime,jsi::PropNameID::forAscii(runtime,"call"),2,[](jsi::Runtime& runtime,const jsi::Value&,const jsi::Value* args,size_t count){\n    if (!count || !integer(args[0])) throw jsi::JSError(runtime,"DmSdkEnumValue.call expects id"); const uint16_t id=static_cast<uint16_t>(args[0].asNumber());\n    if (id >= deherm_dmsdk_enum_count()) throw jsi::JSError(runtime,"unknown enum-value id"); const auto& descriptor=deherm_dmsdk_enum_descriptors()[id];\n    if (count != static_cast<size_t>(descriptor.argument_count)+1) throw jsi::JSError(runtime,"wrong enum-value arity"); uint64_t raw[DEHERM_DMSDK_ENUM_MAX_ARGUMENTS]={};\n    for(uint8_t i=0;i<descriptor.argument_count;++i) raw[i]=encode(runtime,args[i+1],descriptor.argument_kinds[i]); uint64_t result=0; const auto status=deherm_dmsdk_enum_dispatch(id,raw,descriptor.argument_count,&result);\n    if(status != DEHERM_DMSDK_ENUM_OK) throw jsi::JSError(runtime,status == DEHERM_DMSDK_ENUM_INVALID_ENUM ? "enum value outside generated domain" : "enum-value dispatch failed"); return decode(runtime,descriptor.result_kind,result);\n  }); module.setProperty(runtime,"call",std::move(call)); modules.setProperty(runtime,"DmSdkEnumValue",std::move(module));\n}\n}\n#endif\n`;
}

function renderTs(entries) {
  const ids = entries.map((entry) => `  ${tsName(entry)}: ${entry.id}`).join(",\n");
  const functions = entries.map((entry) => {
    const name = tsName(entry);
    const params = entry.parameters.map(({ parameter, abi }) => `${parameter.name}: ${tsType(abi)}`).join(", ");
    const args = entry.parameters.map(({ parameter }) => parameter.name).join(", ");
    return `/** Raw dmSDK binding for ${entry.declaration.name}. */\nexport function ${name}(${params}): ${tsType(entry.result)} {\n  return module().call(DmSdkEnumValueId.${name}${args ? `, ${args}` : ""}) as ${tsType(entry.result)};\n}`;
  }).join("\n\n");
  return `// Generated by scripts/generate-dmsdk-enum-value-bindings.mjs. Do not edit.\ninterface DmSdkEnumValueModule { call(id:number,...args:readonly (number|boolean|bigint)[]):unknown; }\ndeclare global { var __defoldModulesV1: Record<string,object>|undefined; }\nfunction module():DmSdkEnumValueModule { const value=globalThis.__defoldModulesV1?.DmSdkEnumValue as DmSdkEnumValueModule|undefined; if(!value) throw new Error("Defold module is not registered: DmSdkEnumValue"); return value; }\nexport const DmSdkEnumValueId = {\n${ids}\n} as const;\n\n${functions}\n`;
}

async function build() {
  const contents = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(resolve(root, path), "utf8")])));
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const scalarReport = JSON.parse(contents.scalarReport);
  const overrides = JSON.parse(contents.overrides);
  const candidates = shapes.rows.filter(({ tranche }) => tranche === overrides.family);
  const policiesBySemanticId = semanticEntryMap(overrides.entries, "enum-value policy");
  const declarationById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const index = typeIndex(ir);
  const reportRows = [];
  const entries = [];
  for (const candidate of candidates) {
    const policy = policiesBySemanticId.get(semanticDeclarationId(candidate.id));
    const declaration = declarationById.get(candidate.id);
    if (!declaration) throw new Error(`Enum-value candidate is absent from dmSDK IR: ${candidate.id}`);
    if (!policy) {
      reportRows.push({
        ...candidate,
        emitted: false,
        blocker: "unreviewed-enum-value-optimization",
        stages: { generated: "universal-fallback-retained", compiled: "not-applicable", linked: "not-applicable", runtime: "not-applicable" }
      });
      continue;
    }
    if (policy.status === "blocked") {
      reportRows.push({ ...candidate, emitted: false, blocker: policy.blocker, stages: { generated: "blocked-by-policy", compiled: "not-applicable", linked: "not-applicable", runtime: "not-applicable" } });
      continue;
    }
    const result = abiType(declaration.returns ?? "void", declaration.name, index);
    const parameters = declaration.parameters.map((parameter) => ({ parameter, abi: abiType(parameter.type, declaration.name, index) }));
    const group = sourceGroup(declaration.header);
    const entry = { id: entries.length, declaration, result, parameters, group, wrapper: wrapperName(declaration, parameters) };
    entries.push(entry);
    const hostRuntime = group.name === "buffer" || group.name === "log";
    reportRows.push({ ...candidate, emitted: true, bindingId: entry.id, wrapper: entry.wrapper, enumDomains: Object.fromEntries(parameters.filter(({ abi }) => abi.enum).map(({ parameter, abi }) => [parameter.name, enumDomain(abi)])), stages: { generated: "complete", compiled: "packaged-sdk-object-test", linked: hostRuntime ? "packaged-sdk-host-link-test" : "extension-link-pending", runtime: hostRuntime ? "packaged-sdk-host-runtime-test" : "engine-context-pending" } });
  }
  const artifacts = new Map();
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value.h", renderHeader(entries));
  for (const group of [...new Set(entries.map(({ group }) => group.name))].sort()) {
    const selected = entries.filter((entry) => entry.group.name === group);
    artifacts.set(`defold/defold_hermes/src/generated_dmsdk_enum_value_${group}.cpp`, renderSource(selected[0].group, selected));
  }
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_runtime.h", renderRuntimeHeader(entries));
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp", renderRuntime(entries));
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_jsi.hpp", renderJsiHeader());
  const jsiSource = renderJsi()
    .replace("if (!count || !integer(args[0]))", "if (!count || !integer(args[0]) || args[0].asNumber() < 0.0 || args[0].asNumber() > 65535.0)")
    .replace("static_cast<double>(static_cast<int32_t>(raw))", "static_cast<double>(static_cast<int64_t>(raw))")
    .replace("DmSdkEnumValue.call expects id", "DmSdkEnumValue.call expects u16 id");
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_enum_value_jsi.cpp", jsiSource);
  artifacts.set("packages/sdk/src/generated/dmsdk/enum-value.ts", renderTs(entries));
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sources: paths,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, sha256(content)])),
    policy: { cEnumRepresentation: "int32_t", enumInputs: "generated exact-domain validation before native call", uint64: "C uint64_t and native JSI bigint", allocation: "stack-only fixed slots; no glue allocation or ownership transfer", html5: "fail-closed until Wasm BigInt and linked-symbol matrix are validated" },
    universalFallback: { preserved: true, catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json", mutation: "none" },
    coverage: { baselineRuntimePending: shapes.coverage.runtimePending, previouslyEmittedScalar: scalarReport.coverage.generated, discovered: candidates.length, emitted: entries.length, blocked: reportRows.filter(({ emitted }) => !emitted).length, hostRuntimeVerified: reportRows.filter(({ stages }) => stages.runtime === "packaged-sdk-host-runtime-test").length, engineContextPending: reportRows.filter(({ stages }) => stages.runtime === "engine-context-pending").length, remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - scalarReport.coverage.generated - entries.length },
    artifactHashes: Object.fromEntries([...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(content)])),
    artifacts: [...artifacts.keys()].sort(),
    declarations: reportRows,
  };
  artifacts.set("packages/bindings/generated/defold-dmsdk-enum-value-bindings.json", `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) { if (await readFile(path, "utf8") !== content) throw new Error(`${relative} is stale`); return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build();
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} enum-value dmSDK bindings; ${report.coverage.blocked} optimization-blocked.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
