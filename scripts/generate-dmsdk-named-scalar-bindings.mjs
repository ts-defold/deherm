#!/usr/bin/env node

// Generates the named-scalar dmSDK C ABI from source-resolved scalar aliases.
// One recipe owns the public wrapper, raw-cell dispatcher, and exact-call twin.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultIrPath = "packages/bindings/generated/defold-sdk-ir.json";
const defaultShapesPath = "packages/bindings/generated/defold-dmsdk-abi-shapes.json";
const defaultSymbolEvidencePath = "packages/bindings/generated/defold-dmsdk-symbol-evidence.json";
const defaultPolicyPath = "packages/bindings/overrides/dmsdk-named-scalar-policies.json";
const outputReportPath = "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json";
const outputPaths = Object.freeze({
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar.h",
  runtimeHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_runtime.h",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_jsi.hpp",
  runtime: "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_named_scalar_jsi.cpp",
  exact: "tests/fixtures/generated_dmsdk_named_scalar_exact_verification.cpp",
  typescript: "packages/sdk/src/generated/dmsdk/named-scalar.ts",
});

const builtinTypes = Object.freeze({
  void: Object.freeze({ c: "void", lane: "void" }),
  bool: Object.freeze({ c: "uint8_t", lane: "bool" }),
  int: Object.freeze({ c: "int32_t", lane: "i32" }),
  int32_t: Object.freeze({ c: "int32_t", lane: "i32" }),
  uint32_t: Object.freeze({ c: "uint32_t", lane: "u32" }),
  int64_t: Object.freeze({ c: "int64_t", lane: "i64" }),
  uint64_t: Object.freeze({ c: "uint64_t", lane: "u64" }),
  uintptr_t: Object.freeze({ c: "uintptr_t", lane: "usize" }),
  float: Object.freeze({ c: "float", lane: "f32" }),
  double: Object.freeze({ c: "double", lane: "f64" }),
});

const digest = (content) => createHash("sha256").update(content).digest("hex");
export const orderedBlockingReasons = ({ symbolBlocker = null, resultBlocker = null, parameterBlockers = [] }) =>
  [...new Set([symbolBlocker, resultBlocker, ...parameterBlockers].filter(Boolean))];
const normalizedInputPath = (input) => {
  const absolute = resolve(repositoryRoot, input);
  const repositoryRelative = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  return repositoryRelative && repositoryRelative !== ".." && !repositoryRelative.startsWith("../")
    ? repositoryRelative
    : absolute.replaceAll("\\", "/");
};
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

function parseArguments(argv) {
  const options = { outRoot: repositoryRoot, irPath: defaultIrPath, shapesPath: defaultShapesPath, symbolEvidencePath: defaultSymbolEvidencePath, policyPath: defaultPolicyPath, check: false };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--out-root") options.outRoot = resolve(argv[++index]);
    else if (argv[index] === "--ir") options.irPath = resolve(argv[++index]);
    else if (argv[index] === "--shapes") options.shapesPath = resolve(argv[++index]);
    else if (argv[index] === "--symbol-evidence") options.symbolEvidencePath = resolve(argv[++index]);
    else if (argv[index] === "--policy") options.policyPath = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function snakeCase(value) {
  return value.replace(/::/g, "_").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").toLowerCase();
}

function wrapperName(declaration) { return `deherm_dmsdk_named_scalar_${snakeCase(declaration.name)}`; }

function declarationEvidence(content, declaration, policy) {
  const leaf = declaration.name.split("::").at(-1);
  const lines = content.split(/\r?\n/);
  let index = lines.findIndex((line) => new RegExp(`\\b${leaf}\\s*\\(`).test(line));
  if (index < 0) {
    const rule = policy.declarationEvidenceRules.find(({ symbolPattern }) => new RegExp(symbolPattern).test(declaration.name));
    if (rule) index = lines.findIndex((line) => line.includes(rule.anchor));
  }
  if (index < 0) throw new Error(`Declaration evidence is missing for ${declaration.id}`);
  return { line: index + 1, text: lines[index].trim() };
}

function includeFor(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  if (index < 0) throw new Error(`No public dmSDK include path in ${header}`);
  return `dmsdk/${header.slice(index + marker.length)}`;
}

function qualifiedNativeType(type, declaration, policy) {
  const named = policy.namedTypes[type];
  if (!named) return type;
  if (named.qualification === "declaration-namespace") {
    const scope = declaration.name.includes("::") ? declaration.name.slice(0, declaration.name.lastIndexOf("::")) : "";
    return scope ? `${scope}::${type}` : type;
  }
  return type;
}

async function typeSpec(type, declaration, policy, evidenceCache) {
  const named = policy.namedTypes[type];
  const underlying = named?.underlying ?? type;
  const builtin = builtinTypes[underlying];
  if (!builtin) return { blocked: `unknown-native-scalar:${type}` };
  let evidence = null;
  if (named) {
    if (!Array.isArray(named.evidence) || named.evidence.length !== 2) throw new Error(`${type}: invalid named-type evidence`);
    const [path, anchor] = named.evidence;
    let content = evidenceCache.get(path);
    if (!content) { content = await readFile(resolve(repositoryRoot, path), "utf8"); evidenceCache.set(path, content); }
    const lines = content.split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(anchor));
    if (index < 0) throw new Error(`${type}: source alias evidence drifted: ${anchor}`);
    evidence = { path, line: index + 1, text: lines[index].trim(), sha256: digest(content) };
  }
  return { ...builtin, source: type, underlying, native: qualifiedNativeType(type, declaration, policy), evidence };
}

function publicDeclaration(entry) {
  const parameters = entry.parameters.map((parameter) => `${parameter.c} ${parameter.name}`).join(", ");
  return `${entry.result.c} ${entry.wrapper}(${parameters || "void"});`;
}

function nativeArgument(parameter) {
  if (parameter.native === parameter.c) return parameter.name;
  return `static_cast<${parameter.native}>(${parameter.name})`;
}

function wrapperDefinition(entry) {
  const parameters = entry.parameters.map((parameter) => `${parameter.c} ${parameter.name}`).join(", ");
  const call = `${entry.symbol}(${entry.parameters.map(nativeArgument).join(", ")})`;
  let statement;
  if (entry.result.lane === "void") statement = `${call};`;
  else if (entry.result.lane === "bool") statement = `return ${call} ? UINT8_C(1) : UINT8_C(0);`;
  else if (entry.result.native !== entry.result.c) statement = `return static_cast<${entry.result.c}>(${call});`;
  else statement = `return ${call};`;
  return `${entry.result.c} ${entry.wrapper}(${parameters || "void"})\n{\n  ${statement}\n}`;
}

function nativePrototype(entry) {
  const parameters = entry.parameters.map((parameter) => `${parameter.native} ${parameter.name}`).join(", ");
  return `${entry.result.native} ${entry.symbol}(${parameters || "void"});`;
}

function rawArgument(parameter, position) {
  const raw = `arguments[${position}]`;
  if (parameter.lane === "f32") return `unpack_f32(${raw})`;
  if (parameter.lane === "f64") return `unpack_f64(${raw})`;
  if (parameter.lane === "i32") return `unpack_i32(${raw})`;
  if (parameter.lane === "i64") return `unpack_i64(${raw})`;
  return `static_cast<${parameter.c}>(${raw})`;
}

function rawResult(entry) {
  const call = `${entry.wrapper}(${entry.parameters.map(rawArgument).join(", ")})`;
  if (entry.result.lane === "void") return `${call};\n      *result = UINT64_C(0);`;
  if (entry.result.lane === "f32") return `*result = pack_f32(${call});`;
  if (entry.result.lane === "f64") return `*result = pack_f64(${call});`;
  if (entry.result.lane === "i32" || entry.result.lane === "i64") return `*result = static_cast<uint64_t>(static_cast<int64_t>(${call}));`;
  return `*result = static_cast<uint64_t>(${call});`;
}

function rawGuard(parameter, position) {
  const raw = `arguments[${position}]`;
  if (parameter.lane === "bool") return `${raw} > UINT64_C(1)`;
  if (parameter.lane === "i32") return `${raw} != static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(${raw})))`;
  if (parameter.lane === "u32" || parameter.lane === "f32") return `${raw} > UINT32_MAX`;
  if (parameter.lane === "usize") return `${raw} > static_cast<uint64_t>(UINTPTR_MAX)`;
  return null;
}

function renderHeader(entries) {
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.
#ifndef DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_H
#define DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

${entries.map(publicDeclaration).join("\n")}

#ifdef __cplusplus
} // extern "C"
#endif

#endif // DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_H
`;
}

function renderRuntimeHeader() {
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.
#ifndef DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_RUNTIME_H
#define DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_RUNTIME_H

#include <stdint.h>

typedef enum DehermDmSdkNamedScalarStatus {
  DEHERM_DMSDK_NAMED_SCALAR_OK = 0,
  DEHERM_DMSDK_NAMED_SCALAR_UNKNOWN_ID = 1,
  DEHERM_DMSDK_NAMED_SCALAR_WRONG_ARITY = 2,
  DEHERM_DMSDK_NAMED_SCALAR_NULL_STORAGE = 3,
  DEHERM_DMSDK_NAMED_SCALAR_RANGE = 4
} DehermDmSdkNamedScalarStatus;

typedef struct DehermDmSdkNamedScalarDescriptor {
  uint16_t id;
  uint8_t argument_count;
  const char* declaration_id;
  const char* symbol;
} DehermDmSdkNamedScalarDescriptor;

#ifdef __cplusplus
extern "C" {
#endif

uint32_t deherm_dmsdk_named_scalar_count(void);
const DehermDmSdkNamedScalarDescriptor* deherm_dmsdk_named_scalar_descriptors(void);
DehermDmSdkNamedScalarStatus deherm_dmsdk_named_scalar_dispatch(
    uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* result);

#ifdef __cplusplus
} // extern "C"
#endif

#endif // DEFOLD_HERMES_GENERATED_DMSDK_NAMED_SCALAR_RUNTIME_H
`;
}

function renderRuntime(entries) {
  const includes = [...new Set(entries.map(({ include }) => include))].sort().map((include) => `#include <${include}>`).join("\n");
  // profile.h deliberately hides its property function declarations in
  // release/null-profile preprocessing modes even though both pinned profile
  // implementations export the same functions. Re-declare only those
  // source-generated global macro-family signatures from the recipe.
  const conditionalDeclarations = entries.filter(({ symbol }) => !symbol.includes("::")).map(nativePrototype).join("\n");
  const descriptors = entries.map((entry) => `  { UINT16_C(${entry.bindingId}), UINT8_C(${entry.parameters.length}), ${JSON.stringify(entry.declarationId)}, ${JSON.stringify(entry.symbol)} }`).join(",\n");
  const signatureAssertions = entries.map((entry) => {
    const parameters = entry.parameters.map(({ native }) => native).join(", ") || "void";
    const signature = `DehermNamedScalarSignature${entry.bindingId}`;
    return `using ${signature}=${entry.result.native} (*)(${parameters});\nstatic_assert(std::is_same<decltype(static_cast<${signature}>(&${entry.symbol})),${signature}>::value,${JSON.stringify(entry.declarationId)});`;
  }).join("\n");
  const cases = entries.map((entry) => {
    const range = entry.parameters.map((parameter, position) => {
      const guard = rawGuard(parameter, position);
      return guard ? `      if (${guard}) return DEHERM_DMSDK_NAMED_SCALAR_RANGE;\n` : "";
    }).join("");
    return `    case ${entry.bindingId}:\n${range}      ${rawResult(entry)}\n      return DEHERM_DMSDK_NAMED_SCALAR_OK;`;
  }).join("\n");
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.
#include <defold_hermes/generated_dmsdk_named_scalar.h>
#include <defold_hermes/generated_dmsdk_named_scalar_runtime.h>
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN "defold_hermes"
#endif
${includes}
#include <cstring>
#include <type_traits>

${conditionalDeclarations}
${signatureAssertions}

namespace {
const DehermDmSdkNamedScalarDescriptor kDescriptors[] = {
${descriptors}
};
float unpack_f32(uint64_t raw){uint32_t bits=static_cast<uint32_t>(raw);float value=0;std::memcpy(&value,&bits,sizeof(value));return value;}
double unpack_f64(uint64_t raw){double value=0;std::memcpy(&value,&raw,sizeof(value));return value;}
int32_t unpack_i32(uint64_t raw){uint32_t bits=static_cast<uint32_t>(raw);int32_t value=0;std::memcpy(&value,&bits,sizeof(value));return value;}
int64_t unpack_i64(uint64_t raw){int64_t value=0;std::memcpy(&value,&raw,sizeof(value));return value;}
[[maybe_unused]] uint64_t pack_f32(float value){uint32_t bits=0;std::memcpy(&bits,&value,sizeof(bits));return bits;}
[[maybe_unused]] uint64_t pack_f64(double value){uint64_t bits=0;std::memcpy(&bits,&value,sizeof(bits));return bits;}
} // namespace

extern "C" {

${entries.map(wrapperDefinition).join("\n\n")}

uint32_t deherm_dmsdk_named_scalar_count(void){return UINT32_C(${entries.length});}
const DehermDmSdkNamedScalarDescriptor* deherm_dmsdk_named_scalar_descriptors(void){return kDescriptors;}

DehermDmSdkNamedScalarStatus deherm_dmsdk_named_scalar_dispatch(
    uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* result)
{
  if(id>=deherm_dmsdk_named_scalar_count())return DEHERM_DMSDK_NAMED_SCALAR_UNKNOWN_ID;
  const auto& descriptor=kDescriptors[id];
  if(argument_count!=descriptor.argument_count)return DEHERM_DMSDK_NAMED_SCALAR_WRONG_ARITY;
  if(result==nullptr||(argument_count!=0&&arguments==nullptr))return DEHERM_DMSDK_NAMED_SCALAR_NULL_STORAGE;
  switch(id){
${cases}
    default:return DEHERM_DMSDK_NAMED_SCALAR_UNKNOWN_ID;
  }
}

} // extern "C"
`;
}

function sentinel(spec, id, position, result = false) {
  const seed = (result ? 7000 : 3000) + id * 17 + position;
  if (spec.lane === "bool") return { native: "true", raw: "UINT64_C(1)" };
  if (spec.lane === "i32") return { native: `-${seed}`, raw: `static_cast<uint64_t>(INT64_C(-${seed}))` };
  if (spec.lane === "i64") return { native: `INT64_C(-${4294967296 + seed})`, raw: `static_cast<uint64_t>(INT64_C(-${4294967296 + seed}))` };
  if (spec.lane === "u32") return { native: `UINT32_C(${seed})`, raw: `UINT64_C(${seed})` };
  if (spec.lane === "u64") return { native: `UINT64_C(${4294967296 + seed})`, raw: `UINT64_C(${4294967296 + seed})` };
  if (spec.lane === "usize") return { native: `static_cast<uintptr_t>(${seed})`, raw: `UINT64_C(${seed})` };
  if (spec.lane === "f32") return { native: `${100 + id + position + (result ? 0.75 : 0.25)}f`, raw: `pack_f32(${100 + id + position + (result ? 0.75 : 0.25)}f)` };
  if (spec.lane === "f64") return { native: `${200 + id + position + (result ? 0.875 : 0.375)}`, raw: `pack_f64(${200 + id + position + (result ? 0.875 : 0.375)})` };
  return { native: "", raw: "UINT64_C(0)" };
}

function fakeDefinition(entry) {
  const parameters = entry.parameters.map((parameter, position) => `${parameter.native} a${position}`).join(", ");
  const checks = entry.parameters.map((parameter, position) => {
    const expected = sentinel(parameter, entry.bindingId, position).native;
    return `if(a${position}!=static_cast<${parameter.native}>(${expected}))++g_failures[${entry.bindingId}];`;
  }).join("");
  let returned = "";
  if (entry.result.lane !== "void") {
    const expected = sentinel(entry.result, entry.bindingId, 0, true).native;
    returned = `return static_cast<${entry.result.native}>(${expected});`;
  }
  return `${entry.result.native} ${entry.symbol}(${parameters}){++g_calls[${entry.bindingId}];${checks}${returned}}`;
}

function renderExact(entries) {
  const includes = [...new Set(entries.map(({ include }) => include))].sort().map((include) => `#include <${include}>`).join("\n");
  const checks = entries.map((entry) => {
    const argumentsList = entry.parameters.map((parameter, position) => sentinel(parameter, entry.bindingId, position).raw);
    const result = sentinel(entry.result, entry.bindingId, 0, true).raw;
    return `  {uint64_t arguments[2]={${argumentsList.join(",") || "UINT64_C(0)"}};uint64_t output=UINT64_C(0xffff);if(deherm_dmsdk_named_scalar_dispatch(UINT16_C(${entry.bindingId}),arguments,UINT32_C(${argumentsList.length}),&output)!=DEHERM_DMSDK_NAMED_SCALAR_OK)return ${entry.bindingId + 100};if(g_calls[${entry.bindingId}]!=UINT32_C(1)||g_failures[${entry.bindingId}]!=UINT32_C(0)||output!=${entry.result.lane === "void" ? "UINT64_C(0)" : result})return ${entry.bindingId + 200};}`;
  }).join("\n");
  const descriptorChecks = entries.map((entry) => `  if(deherm_dmsdk_named_scalar_descriptors()[${entry.bindingId}].id!=UINT16_C(${entry.bindingId})||strcmp(deherm_dmsdk_named_scalar_descriptors()[${entry.bindingId}].declaration_id,${JSON.stringify(entry.declarationId)})!=0)return ${entry.bindingId + 300};`).join("\n");
  const rejectionChecks = entries.flatMap((entry) => entry.parameters.map((parameter, position) => {
    const invalid = {
      bool: "UINT64_C(2)",
      i32: "UINT64_C(0x00000000ffffffff)",
      u32: "UINT64_C(0x100000000)",
      f32: "UINT64_C(0x100000000)",
      usize: "UINT64_MAX",
    }[parameter.lane];
    if (!invalid) return "";
    const argumentsList = entry.parameters.map((value, index) => index === position ? invalid : sentinel(value, entry.bindingId, index).raw);
    const check = `  {uint64_t arguments[2]={${argumentsList.join(",")}};uint64_t output=UINT64_C(0xfeed);const uint32_t calls=g_calls[${entry.bindingId}];if(deherm_dmsdk_named_scalar_dispatch(UINT16_C(${entry.bindingId}),arguments,UINT32_C(${argumentsList.length}),&output)!=DEHERM_DMSDK_NAMED_SCALAR_RANGE||g_calls[${entry.bindingId}]!=calls||output!=UINT64_C(0xfeed))return ${500 + entry.bindingId * 4 + position};}`;
    return parameter.lane === "usize" ? `#if UINTPTR_MAX < UINT64_MAX\n${check}\n#endif` : check;
  })).filter(Boolean).join("\n");
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.
#include <defold_hermes/generated_dmsdk_named_scalar_runtime.h>
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN "defold_hermes"
#endif
${includes}
#include <cstring>
namespace {uint32_t g_calls[${entries.length}]{};uint32_t g_failures[${entries.length}]{};uint64_t pack_f32(float value){uint32_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}uint64_t pack_f64(double value){uint64_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}}
${entries.map(fakeDefinition).join("\n")}
extern "C" int deherm_dmsdk_named_scalar_exact_verify(void){
  if(deherm_dmsdk_named_scalar_count()!=UINT32_C(${entries.length}))return 1;
${descriptorChecks}
${checks}
${rejectionChecks}
  return 0;
}
`;
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.\n#pragma once\n\n// The production C ABI is generated; no JavaScript ownership or scheduling policy is inferred.\n`;
}

function renderJsi() {
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.\n// Intentionally empty: this wave proves the typed C ABI and exact dispatcher call only.\n`;
}

function renderTypeScript() {
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.\n\n// The named-scalar C ABI is generated, but no JavaScript lifecycle policy is inferred.\nexport {};\n`;
}

function requireUniqueIds(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) throw new Error(`${label} contains an invalid declaration id`);
    if (ids.has(row.id)) throw new Error(`${label} contains duplicate declaration id: ${row.id}`);
    ids.add(row.id);
  }
}

function validateProvenance(ir, irContent, shapes) {
  if (ir.schemaVersion !== 1 || !Array.isArray(ir.declarations) || typeof ir.defoldRevision !== "string") throw new Error("Invalid dmSDK IR schema");
  if (shapes.schemaVersion !== 1 || !Array.isArray(shapes.rows) || typeof shapes.defoldRevision !== "string") throw new Error("Invalid dmSDK ABI-shape schema");
  if (ir.defoldRevision !== shapes.defoldRevision) throw new Error("dmSDK IR and ABI-shape Defold revisions differ");
  if (shapes.sourceHashes?.ir !== digest(irContent)) throw new Error("dmSDK ABI-shape IR hash does not match the exact IR input");
  requireUniqueIds(ir.declarations, "dmSDK IR"); requireUniqueIds(shapes.rows, "dmSDK ABI-shape report");
  if (!Number.isSafeInteger(shapes.trancheSummary?.["next-named-scalar-direct"])) throw new Error("dmSDK ABI-shape report must declare its named-scalar candidate count");
}

export async function build({ irPath = defaultIrPath, shapesPath = defaultShapesPath, symbolEvidencePath = defaultSymbolEvidencePath, policyPath = defaultPolicyPath } = {}) {
  const [irContent, shapesContent, symbolEvidenceContent, policyContent] = await Promise.all([
    readFile(resolve(repositoryRoot, irPath), "utf8"), readFile(resolve(repositoryRoot, shapesPath), "utf8"),
    readFile(resolve(repositoryRoot, symbolEvidencePath), "utf8"), readFile(resolve(repositoryRoot, policyPath), "utf8")
  ]);
  const ir = JSON.parse(irContent); const shapes = JSON.parse(shapesContent); const symbolEvidence = JSON.parse(symbolEvidenceContent); const policy = JSON.parse(policyContent);
  const reportedSymbolEvidencePath = normalizedInputPath(symbolEvidencePath);
  validateProvenance(ir, irContent, shapes);
  if (symbolEvidence.schemaVersion !== 2 || symbolEvidence.defoldRevision !== ir.defoldRevision || !symbolEvidence.declarations || typeof symbolEvidence.declarations !== "object") throw new Error("Invalid or revision-mismatched dmSDK symbol evidence");
  if (policy.schemaVersion !== 2 || !policy.policyVersion || !policy.namedTypes || !policy.expectedCoverage || !Array.isArray(policy.declarationEvidenceRules) || !Array.isArray(policy.symbolEvidenceBlockers)) throw new Error("Invalid named-scalar structural policy");
  const reviewedSymbolBlockers = new Map(policy.symbolEvidenceBlockers.map((entry) => [entry.declarationId, entry]));
  if (reviewedSymbolBlockers.size !== policy.symbolEvidenceBlockers.length) throw new Error("Named-scalar policy contains duplicate symbol-evidence blocker declarations");
  const byId = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const candidates = shapes.rows.filter(({ tranche }) => tranche === "next-named-scalar-direct")
    .map((shape) => ({ shape, declaration: byId.get(shape.id) })).sort((a, b) => a.declaration.id.localeCompare(b.declaration.id));
  if (shapes.trancheSummary["next-named-scalar-direct"] !== policy.expectedCoverage.candidates || candidates.length !== policy.expectedCoverage.candidates || candidates.some(({ declaration }) => !declaration)) throw new Error(`The named-scalar census must contain exactly ${policy.expectedCoverage.candidates} resolvable declarations`);
  const evidenceCache = new Map(); const entries = []; const blocked = [];
  for (const { shape, declaration } of candidates) {
    const linkage = symbolEvidence.declarations[declaration.id];
    if (!linkage) throw new Error(`dmSDK symbol evidence is missing ${declaration.id}`);
    const result = await typeSpec(declaration.returns, declaration, policy, evidenceCache);
    const parameters = await Promise.all(declaration.parameters.map(async (parameter) => ({ ...await typeSpec(parameter.type, declaration, policy, evidenceCache), name: parameter.name, source: parameter.type })));
    const symbolBlocker = linkage.linkage === "header-only" || (linkage.linkage === "external" && linkage.availability === "all-targets-all-variants")
      ? null : `native-symbol-${linkage.linkage === "external" ? linkage.availability : linkage.linkage}`;
    const reviewedSymbolBlocker = symbolBlocker ? reviewedSymbolBlockers.get(declaration.id) : null;
    if (symbolBlocker && (reviewedSymbolBlocker?.blocker !== symbolBlocker || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/u.test(reviewedSymbolBlocker.issue ?? ""))) {
      throw new Error(`${declaration.id}: ${symbolBlocker} requires a matching reviewed issue in symbolEvidenceBlockers`);
    }
    const blockerReasons = orderedBlockingReasons({
      symbolBlocker,
      resultBlocker: result.blocked,
      parameterBlockers: parameters.map(({ blocked }) => blocked)
    });
    const blocker = blockerReasons[0];
    const header = await readFile(resolve(repositoryRoot, declaration.header), "utf8");
    const common = {
      declarationId: declaration.id, symbol: declaration.name, nativeSignature: declaration.type, shape: shape.shape,
      include: includeFor(declaration.header),
      headerEvidence: { path: declaration.header, ...declarationEvidence(header, declaration, policy), sha256: digest(header) },
      symbolEvidence: { path: reportedSymbolEvidencePath, sha256: digest(symbolEvidenceContent), linkage: linkage.linkage, availability: linkage.availability, linkedIn: linkage.linkedIn }
    };
    if (blocker) {
      blocked.push({
        ...common,
        emitted: false,
        blocker,
        ...(blockerReasons.length > 1 ? { blockerReasons } : {}),
        ...(reviewedSymbolBlocker ? { issue: reviewedSymbolBlocker.issue } : {})
      });
      continue;
    }
    const bindingId = entries.length; const wrapper = wrapperName(declaration);
    const recipe = { bindingId, declarationId: declaration.id, symbol: declaration.name, wrapper, include: common.include, result, parameters };
    entries.push({ ...common, ...recipe, exactVectorSha256: digest(canonicalJson(recipe)) });
  }
  if (blocked.filter(({ issue }) => issue).length !== reviewedSymbolBlockers.size) throw new Error("Named-scalar policy contains a stale symbol-evidence blocker review");
  if (entries.length !== policy.expectedCoverage.generated || blocked.length !== policy.expectedCoverage.blocked || candidates.length !== policy.expectedCoverage.candidates) throw new Error("Named-scalar structural coverage drifted from reviewed expectations");
  const artifacts = new Map([
    [outputPaths.header, renderHeader(entries)], [outputPaths.runtimeHeader, renderRuntimeHeader()], [outputPaths.runtime, renderRuntime(entries)],
    [outputPaths.jsiHeader, renderJsiHeader()], [outputPaths.jsi, renderJsi()], [outputPaths.exact, renderExact(entries)], [outputPaths.typescript, renderTypeScript()]
  ]);
  const declarations = [...entries.map((entry) => ({
    id: entry.declarationId, symbol: entry.symbol, nativeSignature: entry.nativeSignature, shape: entry.shape, emitted: true, bindingId: entry.bindingId, wrapper: entry.wrapper, preferredLowering: false,
    recipe: { include: entry.include, result: entry.result, parameters: entry.parameters, exactVectorSha256: entry.exactVectorSha256 }, headerEvidence: entry.headerEvidence, symbolEvidence: entry.symbolEvidence,
    stages: { generated: { status: "complete", evidence: outputPaths.runtime }, compiled: { status: "covered-by-reproducible-test", evidence: "tests/dmsdk-named-scalar-bindings.test.mjs" }, linked: { status: "covered-by-reproducible-test", evidence: reportedSymbolEvidencePath }, conformant: { status: "covered-by-reproducible-test", evidence: outputPaths.exact }, allocation: { status: "100000-warmed-dispatch-zero-cpp-allocations", evidence: "native/dmsdk_named_scalar_runtime_test.cpp" }, typescriptCallable: { status: "not-applicable", evidence: outputPaths.typescript } }
  })), ...blocked.map((entry) => ({
    id: entry.declarationId,
    symbol: entry.symbol,
    nativeSignature: entry.nativeSignature,
    shape: entry.shape,
    emitted: false,
    blocker: entry.blocker,
    ...(entry.blockerReasons ? { blockerReasons: entry.blockerReasons } : {}),
    issue: entry.issue,
    headerEvidence: entry.headerEvidence,
    symbolEvidence: entry.symbolEvidence
  }))];
  const report = {
    schemaVersion: 1, policyVersion: policy.policyVersion, defoldRevision: ir.defoldRevision, sourceShapeCensus: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
    scope: "All declarations structurally classified as next-named-scalar-direct. Admission requires source-resolved scalar ABI facts and a symbol that the pinned Defold target archives expose across all build variants; absent or target-partial symbols fail closed.",
    universalFallback: { preserved: true, catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json", mutation: "none" },
    coverage: { reviewed: candidates.length, generated: entries.length, policyBlocked: blocked.length, signatureCompileCovered: entries.length, linked: entries.length, behaviorCovered: entries.length, exactCallCovered: entries.length, typescriptCallable: 0, warmedDispatchIterations: 100000, warmedDispatchObservedCppAllocations: 0 },
    sourceHashes: { ir: digest(irContent), shapes: digest(shapesContent), symbolEvidence: digest(symbolEvidenceContent), policy: digest(policyContent) },
    artifactHashes: Object.fromEntries([...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, digest(content)])), artifacts: [...artifacts.keys()].sort(), declarations
  };
  artifacts.set(outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relativePath, content, check) {
  const path = resolve(outRoot, relativePath);
  if (check) { if (await readFile(path, "utf8") !== content) throw new Error(`${relativePath} is stale; regenerate named-scalar bindings`); return; }
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const { outRoot, check, irPath, shapesPath, symbolEvidencePath, policyPath } = parseArguments(argv);
  const { artifacts, report } = await build({ irPath, shapesPath, symbolEvidencePath, policyPath });
  for (const [path, content] of artifacts) await writeOrCheck(outRoot, path, content, check);
  process.stdout.write(`${check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.reviewed} named-scalar bindings; ${report.coverage.policyBlocked} ABI-blocked.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
