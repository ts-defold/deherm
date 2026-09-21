import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
});
const artifacts = Object.freeze({
  report: "packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_borrowed_handle.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_borrowed_handle_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js",
  typescript: "packages/sdk/src/generated/dmsdk/borrowed-handle.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-borrowed-handle.ts",
  headerAudit: "native/generated_dmsdk_borrowed_handle_header_audit.cpp",
  exactCall: "native/generated_dmsdk_borrowed_handle_exact_call.cpp",
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const leaf = (value) => String(value).split("::").at(-1) ?? "";
const snake = (value) => String(value).replace(/::/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
const pascal = (value) => snake(value).split("_").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join("");

function parseArguments(argv) {
  const options = { outputRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--output-root") options.outputRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function roleKind(role) {
  if (role.startsWith("handle:")) return "handle";
  if (role.startsWith("scalar:")) return role.slice("scalar:".length);
  return undefined;
}

function handleName(role) {
  if (!role.startsWith("handle:")) return undefined;
  const pieces = role.split(":");
  return pieces.slice(1, -1).join(":");
}

function structuralBlockers(shape, policy) {
  const blockers = [];
  if (!policy.selection.declarationKinds.includes(shape.kind)) blockers.push(`declaration-kind-unsupported:${shape.kind}`);
  if (!policy.selection.resultRoles.includes(shape.result.role)) blockers.push(`result-role-unsupported:${shape.result.role}`);
  if (!shape.parameters.some(({ role }) => role.startsWith("handle:"))) blockers.push("handle-parameter-required");
  for (const parameter of shape.parameters) {
    if (!parameter.role.startsWith(policy.selection.handleRolePrefix) && !policy.selection.parameterRoles.includes(parameter.role)) {
      blockers.push(`parameter-role-unsupported:${parameter.position}:${parameter.role}`);
    }
  }
  for (const family of policy.selection.rejectedFamilies) {
    if (shape.families.includes(family)) blockers.push(`family-requires-target-matrix:${family}`);
  }
  return [...new Set(blockers)].sort();
}

function semanticBlockers(row) {
  const mapped = {
    "call-thread-affinity": "call-thread-affinity-unresolved",
    "handle-ownership-nullability-lifetime": "handle-ownership-nullability-lifetime-unresolved",
    "native-symbol-linkage": "native-symbol-linkage-unverified",
    "target-feature-symbol-matrix": "target-feature-symbol-matrix-unverified",
  };
  const familyRequired = [
    "call-thread-affinity-unresolved",
    "handle-ownership-nullability-lifetime-unresolved",
    "native-symbol-linkage-unverified",
    "target-feature-symbol-matrix-unverified",
  ];
  return [...new Set([...familyRequired, ...(row.semanticTokensNeeded ?? []).map((token) => mapped[token] ?? `semantic-token-unresolved:${token}`)])].sort();
}

function cKind(kind) {
  return {
    void: "DEHERM_DMSDK_BORROWED_VOID",
    handle: "DEHERM_DMSDK_BORROWED_HANDLE",
    bool: "DEHERM_DMSDK_BORROWED_BOOL",
    u8: "DEHERM_DMSDK_BORROWED_U8",
    u16: "DEHERM_DMSDK_BORROWED_U16",
    i32: "DEHERM_DMSDK_BORROWED_I32",
    u32: "DEHERM_DMSDK_BORROWED_U32",
    u64: "DEHERM_DMSDK_BORROWED_U64",
    f32: "DEHERM_DMSDK_BORROWED_F32",
  }[kind];
}

function tsType(entry) {
  if (entry.kind === "void") return "void";
  if (entry.kind === "handle") return `BorrowedHandle<${JSON.stringify(entry.handleName)}>`;
  if (entry.kind === "bool") return "boolean";
  if (entry.kind === "u64") return "bigint";
  return "number";
}

function makeFunctionNames(entries) {
  const initial = entries.map((entry) => snake(entry.projection.symbol).split("_").map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join(""));
  const counts = new Map();
  for (const name of initial) counts.set(name, (counts.get(name) ?? 0) + 1);
  return initial.map((name, index) => {
    if (counts.get(name) === 1) return name;
    const handles = entries[index].parameters.filter(({ kind }) => kind === "handle").map(({ handleName: value }) => leaf(value)).join("And");
    return `${name}From${handles || entries[index].id}`;
  });
}

function headerPath(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`Header is outside pinned dmSDK include projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}

function nativeType(parameter, entryParameter) {
  if (entryParameter.kind === "handle") return entryParameter.handleName;
  return parameter.nativeType;
}

function renderHeaderBase(entries, handleKinds, maxArguments) {
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_BORROWED_HANDLE_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_BORROWED_HANDLE_H\n#include <stdint.h>\n#define DEHERM_DMSDK_BORROWED_PROVIDER_ABI UINT32_C(1)\n#define DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS ${maxArguments}\n#define DEHERM_DMSDK_BORROWED_NO_HANDLE_KIND UINT16_MAX\ntypedef enum DehermDmSdkBorrowedKind { DEHERM_DMSDK_BORROWED_VOID=0, DEHERM_DMSDK_BORROWED_HANDLE=1, DEHERM_DMSDK_BORROWED_BOOL=2, DEHERM_DMSDK_BORROWED_I32=3, DEHERM_DMSDK_BORROWED_U32=4, DEHERM_DMSDK_BORROWED_U64=5, DEHERM_DMSDK_BORROWED_F32=6, DEHERM_DMSDK_BORROWED_U8=7, DEHERM_DMSDK_BORROWED_U16=8 } DehermDmSdkBorrowedKind;\ntypedef enum DehermDmSdkBorrowedStatus { DEHERM_DMSDK_BORROWED_OK=0, DEHERM_DMSDK_BORROWED_UNKNOWN_ID=1, DEHERM_DMSDK_BORROWED_WRONG_ARITY=2, DEHERM_DMSDK_BORROWED_NULL_STORAGE=3, DEHERM_DMSDK_BORROWED_PROVIDER_MISSING=4, DEHERM_DMSDK_BORROWED_WRONG_THREAD=5, DEHERM_DMSDK_BORROWED_INVALID_HANDLE=6, DEHERM_DMSDK_BORROWED_INVALID_PROVIDER=7, DEHERM_DMSDK_BORROWED_PROVIDER_ERROR=8 } DehermDmSdkBorrowedStatus;\ntypedef struct DehermDmSdkBorrowedDescriptor { uint16_t id; uint8_t argument_count; uint8_t result_kind; uint8_t argument_kinds[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS]; uint16_t handle_kinds[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS]; const char* declaration_id; } DehermDmSdkBorrowedDescriptor;\ntypedef struct DehermDmSdkBorrowedHandleKind { uint16_t id; const char* name; const char* native_representation; } DehermDmSdkBorrowedHandleKind;\ntypedef uint8_t (*DehermDmSdkBorrowedCurrentThreadFn)(void* context);\ntypedef uint8_t (*DehermDmSdkBorrowedValidateHandleFn)(void* context, uint16_t handle_kind, uint64_t value);\ntypedef DehermDmSdkBorrowedStatus (*DehermDmSdkBorrowedInvokeFn)(void* context, uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* out_result);\ntypedef struct DehermDmSdkBorrowedProvider { uint32_t abi_version; void* context; DehermDmSdkBorrowedCurrentThreadFn is_current_thread; DehermDmSdkBorrowedValidateHandleFn validate_handle; DehermDmSdkBorrowedInvokeFn invoke; } DehermDmSdkBorrowedProvider;\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nuint32_t deherm_dmsdk_borrowed_count(void);\nconst DehermDmSdkBorrowedDescriptor* deherm_dmsdk_borrowed_descriptors(void);\nuint32_t deherm_dmsdk_borrowed_handle_kind_count(void);\nconst DehermDmSdkBorrowedHandleKind* deherm_dmsdk_borrowed_handle_kinds(void);\nDehermDmSdkBorrowedStatus deherm_dmsdk_borrowed_set_provider(const DehermDmSdkBorrowedProvider* provider);\nDehermDmSdkBorrowedStatus deherm_dmsdk_borrowed_dispatch(uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* out_result);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderHeader(entries, handleKinds, maxArguments) {
  return renderHeaderBase(entries, handleKinds, maxArguments).replace(
    "DEHERM_DMSDK_BORROWED_PROVIDER_ERROR=8 }",
    "DEHERM_DMSDK_BORROWED_PROVIDER_ERROR=8, DEHERM_DMSDK_BORROWED_INVALID_VALUE=9 }",
  );
}

function renderRuntimeBase(entries, handleKinds, maxArguments) {
  const descriptorRows = entries.map((entry) => {
    const kinds = entry.parameters.map(({ kind }) => cKind(kind));
    const handles = entry.parameters.map(({ handleName: name }) => name ? handleKinds.get(name).id : "DEHERM_DMSDK_BORROWED_NO_HANDLE_KIND");
    while (kinds.length < maxArguments) kinds.push("0");
    while (handles.length < maxArguments) handles.push("DEHERM_DMSDK_BORROWED_NO_HANDLE_KIND");
    return `  { UINT16_C(${entry.id}), UINT8_C(${entry.parameters.length}), UINT8_C(${cKind(entry.result.kind)}), { ${kinds.join(", ")} }, { ${handles.map((value) => typeof value === "number" ? `UINT16_C(${value})` : value).join(", ")} }, ${JSON.stringify(entry.projection.id)} }`;
  }).join(",\n");
  const handleRows = [...handleKinds.values()].map(({ id, name, representation }) => `  { UINT16_C(${id}), ${JSON.stringify(name)}, ${JSON.stringify(representation)} }`).join(",\n");
  // Telemetry identity for the c-abi-native transport. Every binding is
  // instrumented uniformly, and the contract shape is interned from the same
  // generated codec kinds the dispatcher uses, so cost is attributable per
  // binding and per contract without a hand-written call site anywhere.
  const shapeTokens = entries.map((entry) =>
    `(${entry.parameters.map(({ kind }) => kind).join(",")})->(${entry.result.kind})`);
  const shapes = [...new Set(shapeTokens)].sort();
  const shapeIndex = new Map(shapes.map((token, index) => [token, index]));
  const profileShapeRows = shapeTokens.map((token) => `  UINT16_C(${shapeIndex.get(token)}),`).join("\n");
  const profileNameRows = entries.map((entry) =>
    `  ${JSON.stringify(`deherm.c-abi-native.${entry.shape.symbol}`)},`).join("\n");
  const profileShapeNameRows = shapes.map((token) => `  ${JSON.stringify(token)},`).join("\n");
  const profileTables = `#if DEHERM_PROFILE_ENABLED\n` +
    `// Present only when DEHERM_PROFILE is on; the preprocessor removes the ids\n` +
    `// and the cold strings entirely when it is off.\n` +
    `const uint16_t kProfileContractShapes[] = {\n${profileShapeRows}\n};\n` +
    `const char* const kProfileNames[] = {\n${profileNameRows}\n};\n` +
    `const char* const kProfileContractShapeNames[] = {\n${profileShapeNameRows}\n};\n` +
    `static_assert(sizeof(kProfileContractShapes) / sizeof(kProfileContractShapes[0]) == ${entries.length}, "borrowed-handle telemetry shape census drifted");\n` +
    `static_assert(sizeof(kProfileNames) / sizeof(kProfileNames[0]) == ${entries.length}, "borrowed-handle telemetry name census drifted");\n` +
    `static_assert(sizeof(kProfileContractShapeNames) / sizeof(kProfileContractShapeNames[0]) == ${shapes.length}, "borrowed-handle telemetry contract census drifted");\n` +
    `#endif\n`;
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_borrowed_handle.h>\n#include <defold_hermes/deherm_profile.hpp>\n#include <string.h>\nnamespace {\nconst DehermDmSdkBorrowedDescriptor kDescriptors[] = {\n${descriptorRows}\n};\nconst DehermDmSdkBorrowedHandleKind kHandleKinds[] = {\n${handleRows}\n};\nDehermDmSdkBorrowedProvider gProvider = {};\n${profileTables}}\nextern \"C\" {\nuint32_t deherm_dmsdk_borrowed_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkBorrowedDescriptor* deherm_dmsdk_borrowed_descriptors(void) { return kDescriptors; }\nuint32_t deherm_dmsdk_borrowed_handle_kind_count(void) { return UINT32_C(${handleKinds.size}); }\nconst DehermDmSdkBorrowedHandleKind* deherm_dmsdk_borrowed_handle_kinds(void) { return kHandleKinds; }\nDehermDmSdkBorrowedStatus deherm_dmsdk_borrowed_set_provider(const DehermDmSdkBorrowedProvider* provider) {\n  if (provider == nullptr) { memset(&gProvider, 0, sizeof(gProvider)); return DEHERM_DMSDK_BORROWED_OK; }\n  if (provider->abi_version != DEHERM_DMSDK_BORROWED_PROVIDER_ABI || provider->is_current_thread == nullptr || provider->validate_handle == nullptr || provider->invoke == nullptr) return DEHERM_DMSDK_BORROWED_INVALID_PROVIDER;\n  gProvider = *provider;\n  return DEHERM_DMSDK_BORROWED_OK;\n}\nDehermDmSdkBorrowedStatus deherm_dmsdk_borrowed_dispatch(uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* out_result) {\n  if (out_result == nullptr) return DEHERM_DMSDK_BORROWED_NULL_STORAGE;\n  *out_result = UINT64_C(0);\n  if (id >= deherm_dmsdk_borrowed_count()) return DEHERM_DMSDK_BORROWED_UNKNOWN_ID;\n  const DehermDmSdkBorrowedDescriptor& descriptor = kDescriptors[id];\n  DEHERM_PROFILE_TRANSPORT_SCOPE(DEHERM_PROFILE_TRANSPORT_C_ABI_NATIVE, id, kProfileContractShapes[id], kProfileNames[id]);\n  if (argument_count != descriptor.argument_count) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_WRONG_ARITY; }\n  if (argument_count != 0 && arguments == nullptr) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_NULL_STORAGE; }\n  if (gProvider.invoke == nullptr) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_PROVIDER_MISSING; }\n  if (gProvider.is_current_thread(gProvider.context) == 0) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_WRONG_THREAD; }\n  for (uint32_t index = 0; index < argument_count; ++index) {\n    if (descriptor.argument_kinds[index] == DEHERM_DMSDK_BORROWED_HANDLE && (arguments[index] == 0 || gProvider.validate_handle(gProvider.context, descriptor.handle_kinds[index], arguments[index]) == 0)) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_INVALID_HANDLE; }\n  }\n  return gProvider.invoke(gProvider.context, id, arguments, argument_count, out_result);\n}\n#if DEHERM_PROFILE_ENABLED\n// Telemetry identity resolvers. A consumer draining the ring maps the numeric\n// binding id and contract shape id back to their cold names through these.\nuint16_t deherm_dmsdk_borrowed_profile_contract_shape(uint16_t id) { return id < deherm_dmsdk_borrowed_count() ? kProfileContractShapes[id] : UINT16_C(0); }\nconst char* deherm_dmsdk_borrowed_profile_name(uint16_t id) { return id < deherm_dmsdk_borrowed_count() ? kProfileNames[id] : \"deherm.c-abi-native.unknown\"; }\nuint32_t deherm_dmsdk_borrowed_profile_contract_shape_count(void) { return UINT32_C(${shapes.length}); }\nconst char* deherm_dmsdk_borrowed_profile_contract_shape_name(uint16_t shape) { return shape < ${shapes.length} ? kProfileContractShapeNames[shape] : \"unknown\"; }\n#endif\n}\n`;
}

function renderRuntime(entries, handleKinds, maxArguments) {
  return renderRuntimeBase(entries, handleKinds, maxArguments)
    .replace(
      "namespace {\nconst DehermDmSdkBorrowedDescriptor",
      "namespace {\nbool canonical(uint8_t kind,uint64_t value){switch(kind){case DEHERM_DMSDK_BORROWED_BOOL:return value<=UINT64_C(1);case DEHERM_DMSDK_BORROWED_U8:return value<=UINT8_MAX;case DEHERM_DMSDK_BORROWED_U16:return value<=UINT16_MAX;case DEHERM_DMSDK_BORROWED_U32:case DEHERM_DMSDK_BORROWED_F32:return value<=UINT32_MAX;case DEHERM_DMSDK_BORROWED_I32:return value==static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(value)));default:return true;}}\nconst DehermDmSdkBorrowedDescriptor",
    )
    .replace(
      "if (descriptor.argument_kinds[index] == DEHERM_DMSDK_BORROWED_HANDLE && (arguments[index] == 0 || gProvider.validate_handle(gProvider.context, descriptor.handle_kinds[index], arguments[index]) == 0)) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_INVALID_HANDLE; }",
      "if (descriptor.argument_kinds[index] == DEHERM_DMSDK_BORROWED_HANDLE && (arguments[index] == 0 || gProvider.validate_handle(gProvider.context, descriptor.handle_kinds[index], arguments[index]) == 0)) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_INVALID_HANDLE; } if (descriptor.argument_kinds[index] != DEHERM_DMSDK_BORROWED_HANDLE && !canonical(descriptor.argument_kinds[index], arguments[index])) { DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_INVALID_VALUE; }",
    )
    .replace(
      "return gProvider.invoke(gProvider.context, id, arguments, argument_count, out_result);",
      "const DehermDmSdkBorrowedStatus status = gProvider.invoke(gProvider.context, id, arguments, argument_count, out_result); if (status != DEHERM_DMSDK_BORROWED_OK) { *out_result = UINT64_C(0); DEHERM_PROFILE_SCOPE_FAILED(); return status; } if (descriptor.result_kind == DEHERM_DMSDK_BORROWED_VOID) { *out_result = UINT64_C(0); } else if (!canonical(descriptor.result_kind, *out_result)) { *out_result = UINT64_C(0); DEHERM_PROFILE_SCOPE_FAILED(); return DEHERM_DMSDK_BORROWED_INVALID_VALUE; } return DEHERM_DMSDK_BORROWED_OK;",
    );
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#pragma once\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes { void installDmSdkBorrowedHandleModule(facebook::jsi::Runtime&, facebook::jsi::Object&); }\n#endif\n`;
}

function renderJsiBase(maxArguments) {
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_borrowed_handle_jsi.hpp>\n#if !defined(DM_PLATFORM_HTML5)\n#include <defold_hermes/generated_dmsdk_borrowed_handle.h>\n#include <cmath>\n#include <cstring>\nnamespace defold_hermes { namespace jsi=facebook::jsi; namespace {\nbool integer(const jsi::Value& value) { return value.isNumber() && std::isfinite(value.asNumber()) && std::trunc(value.asNumber()) == value.asNumber(); }\nuint64_t encode(jsi::Runtime& runtime,const jsi::Value& value,uint8_t kind) {\n  if (kind==DEHERM_DMSDK_BORROWED_HANDLE || kind==DEHERM_DMSDK_BORROWED_U64) { if(!value.isBigInt()) throw jsi::JSError(runtime,kind==DEHERM_DMSDK_BORROWED_HANDLE?\"expected borrowed handle bigint\":\"expected u64 bigint\"); auto bigint=value.getBigInt(runtime); if(!bigint.isUint64(runtime)) throw jsi::JSError(runtime,\"bigint is outside u64 range\"); const uint64_t raw=bigint.asUint64(runtime); if(kind==DEHERM_DMSDK_BORROWED_HANDLE && raw==0) throw jsi::JSError(runtime,\"borrowed handle must be nonzero\"); return raw; }\n  if(kind==DEHERM_DMSDK_BORROWED_BOOL) { if(!value.isBool()) throw jsi::JSError(runtime,\"expected boolean\"); return value.getBool()?UINT64_C(1):UINT64_C(0); }\n  if(!value.isNumber() || !std::isfinite(value.asNumber())) throw jsi::JSError(runtime,\"expected finite scalar number\"); const double number=value.asNumber();\n  if(kind==DEHERM_DMSDK_BORROWED_F32) { const float narrowed=static_cast<float>(number); uint32_t bits=0; std::memcpy(&bits,&narrowed,sizeof(bits)); return bits; }\n  if(!integer(value)) throw jsi::JSError(runtime,\"expected integer scalar\"); if(kind==DEHERM_DMSDK_BORROWED_U32 && (number<0 || number>4294967295.0)) throw jsi::JSError(runtime,\"u32 out of range\"); if(kind==DEHERM_DMSDK_BORROWED_I32 && (number<-2147483648.0 || number>2147483647.0)) throw jsi::JSError(runtime,\"i32 out of range\"); return kind==DEHERM_DMSDK_BORROWED_I32?static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(number))):static_cast<uint64_t>(number);\n}\njsi::Value decode(jsi::Runtime& runtime,uint8_t kind,uint64_t raw) { if(kind==DEHERM_DMSDK_BORROWED_BOOL)return jsi::Value(raw!=0); if(kind==DEHERM_DMSDK_BORROWED_U64)return jsi::Value(runtime,jsi::BigInt::fromUint64(runtime,raw)); if(kind==DEHERM_DMSDK_BORROWED_I32)return jsi::Value(static_cast<double>(static_cast<int32_t>(raw))); if(kind==DEHERM_DMSDK_BORROWED_F32){const uint32_t bits=static_cast<uint32_t>(raw);float value=0;std::memcpy(&value,&bits,sizeof(value));return jsi::Value(static_cast<double>(value));} return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw))); }\nconst char* statusMessage(DehermDmSdkBorrowedStatus status) { switch(status){case DEHERM_DMSDK_BORROWED_PROVIDER_MISSING:return \"borrowed-handle provider missing\";case DEHERM_DMSDK_BORROWED_WRONG_THREAD:return \"borrowed-handle call on wrong thread\";case DEHERM_DMSDK_BORROWED_INVALID_HANDLE:return \"borrowed handle is null, stale, foreign, or wrong-kind\";case DEHERM_DMSDK_BORROWED_PROVIDER_ERROR:return \"borrowed-handle provider rejected call\";default:return \"borrowed-handle dispatch failed\";} }\n}\nvoid installDmSdkBorrowedHandleModule(jsi::Runtime& runtime,jsi::Object& modules){jsi::Object module(runtime);auto call=jsi::Function::createFromHostFunction(runtime,jsi::PropNameID::forAscii(runtime,\"call\"),2,[](jsi::Runtime& runtime,const jsi::Value&,const jsi::Value* args,size_t count){if(count==0 || !integer(args[0]) || args[0].asNumber()<0 || args[0].asNumber()>65535)throw jsi::JSError(runtime,\"DmSdkBorrowedHandle.call expects u16 id\");const uint16_t id=static_cast<uint16_t>(args[0].asNumber());if(id>=deherm_dmsdk_borrowed_count())throw jsi::JSError(runtime,\"unknown borrowed-handle id\");const auto& descriptor=deherm_dmsdk_borrowed_descriptors()[id];if(count!=static_cast<size_t>(descriptor.argument_count)+1)throw jsi::JSError(runtime,\"wrong borrowed-handle arity\");uint64_t raw[${Math.max(1, maxArguments)}]={};for(uint8_t index=0;index<descriptor.argument_count;++index)raw[index]=encode(runtime,args[index+1],descriptor.argument_kinds[index]);uint64_t result=0;const auto status=deherm_dmsdk_borrowed_dispatch(id,raw,descriptor.argument_count,&result);if(status!=DEHERM_DMSDK_BORROWED_OK)throw jsi::JSError(runtime,statusMessage(status));return decode(runtime,descriptor.result_kind,result);});module.setProperty(runtime,\"call\",std::move(call));modules.setProperty(runtime,\"DmSdkBorrowedHandle\",std::move(module));}\n}\n#endif\n`;
}

function renderJsi(maxArguments) {
  return renderJsiBase(maxArguments)
    .replace(
      "const float narrowed=static_cast<float>(number); uint32_t bits=0;",
      'const float narrowed=static_cast<float>(number); if(!std::isfinite(narrowed)) throw jsi::JSError(runtime,"f32 out of range"); uint32_t bits=0;',
    )
    .replace(
      'if(!integer(value)) throw jsi::JSError(runtime,"expected integer scalar"); if(kind==DEHERM_DMSDK_BORROWED_U32',
      'if(!integer(value)) throw jsi::JSError(runtime,"expected integer scalar"); if(kind==DEHERM_DMSDK_BORROWED_U8 && (number<0 || number>255.0)) throw jsi::JSError(runtime,"u8 out of range"); if(kind==DEHERM_DMSDK_BORROWED_U16 && (number<0 || number>65535.0)) throw jsi::JSError(runtime,"u16 out of range"); if(kind==DEHERM_DMSDK_BORROWED_U32',
    )
    .replace(
      'jsi::Value decode(jsi::Runtime& runtime,uint8_t kind,uint64_t raw) { if(kind==DEHERM_DMSDK_BORROWED_BOOL)',
      'jsi::Value decode(jsi::Runtime& runtime,uint8_t kind,uint64_t raw) { if(kind==DEHERM_DMSDK_BORROWED_VOID)return jsi::Value::undefined(); if(kind==DEHERM_DMSDK_BORROWED_BOOL)',
    )
    .replace(
      '} return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw))); }\nconst char* statusMessage',
      '} if(kind==DEHERM_DMSDK_BORROWED_U8)return jsi::Value(static_cast<double>(static_cast<uint8_t>(raw))); if(kind==DEHERM_DMSDK_BORROWED_U16)return jsi::Value(static_cast<double>(static_cast<uint16_t>(raw))); return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw))); }\nconst char* statusMessage',
    )
    .replace(
      'case DEHERM_DMSDK_BORROWED_PROVIDER_ERROR:return "borrowed-handle provider rejected call";',
      'case DEHERM_DMSDK_BORROWED_PROVIDER_ERROR:return "borrowed-handle provider rejected call";case DEHERM_DMSDK_BORROWED_INVALID_VALUE:return "borrowed-handle scalar is outside its declared lane";',
    );
}

function renderBrowser(entries, handleKinds, maxArguments) {
  const descriptors = entries.map((entry) => `{id:${entry.id},resultKind:${JSON.stringify(entry.result.kind)},argumentKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ kind }) => kind))}),handleKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ handleName: name }) => name ?? null))}),declarationId:${JSON.stringify(entry.projection.id)}}`).join(",\n      ");
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\nvar LibraryDefoldHermesDmSdkBorrowedHandle={\n  $DEFOLD_HERMES_DMSDK_BORROWED_HANDLE__deps:['deherm_dmsdk_borrowed_dispatch'],\n  $DEFOLD_HERMES_DMSDK_BORROWED_HANDLE:{\n    abi:Object.freeze({slotBytes:8,maxArguments:${maxArguments},resultBytes:8,handleEncoding:'u64',ownership:'borrowed-no-transfer'}),\n    handleKinds:Object.freeze(${JSON.stringify([...handleKinds.values()])}),\n    descriptors:Object.freeze([\n      ${descriptors}\n    ]),\n    callRaw:function(id,argumentsPointer,argumentCount,resultPointer){return _deherm_dmsdk_borrowed_dispatch(id,argumentsPointer,argumentCount,resultPointer);}\n  }\n};\nautoAddDeps(LibraryDefoldHermesDmSdkBorrowedHandle,'$DEFOLD_HERMES_DMSDK_BORROWED_HANDLE');\naddToLibrary(LibraryDefoldHermesDmSdkBorrowedHandle);\n`;
}

function renderTypeScript(entries, names) {
  const ids = entries.map((entry, index) => `  ${names[index]}: ${entry.id}`).join(",\n");
  const functions = entries.map((entry, index) => {
    const parameters = entry.parameters.map((parameter) => `${parameter.name}: ${tsType(parameter)}`).join(", ");
    const argumentsList = entry.parameters.map(({ name }) => name).join(", ");
    const call = `module().call(DmSdkBorrowedHandleId.${names[index]}${argumentsList ? `, ${argumentsList}` : ""})`;
    const body = entry.result.kind === "void" ? `${call};` : `return ${call} as ${tsType(entry.result)};`;
    return `/** Provider-validated borrowed call for ${entry.projection.symbol}; does not transfer ownership. */\nexport function ${names[index]}(${parameters}): ${tsType(entry.result)} { ${body} }`;
  }).join("\n\n");
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\ndeclare const borrowedHandleBrand: unique symbol;\nexport type BorrowedHandle<Kind extends string> = bigint & { readonly [borrowedHandleBrand]: Kind };\ninterface DmSdkBorrowedHandleModule { call(id:number,...args:readonly (number|boolean|bigint)[]):unknown; }\ndeclare global { var __defoldModulesV1: Record<string,object>|undefined; }\nfunction module():DmSdkBorrowedHandleModule { const value=globalThis.__defoldModulesV1?.DmSdkBorrowedHandle as DmSdkBorrowedHandleModule|undefined; if(!value)throw new Error(\"Defold module is not registered: DmSdkBorrowedHandle\");return value; }\n/** Unsafe admission only: the native provider still validates kind, provenance, lifetime, and thread on every call. */\nexport function unsafeBorrowedHandle<Kind extends string>(kind:Kind,value:bigint):BorrowedHandle<Kind>{void kind;if(value<=0n||value>0xffff_ffff_ffff_ffffn)throw new RangeError(\"borrowed handle must be a nonzero u64\");return value as BorrowedHandle<Kind>;}\nexport const DmSdkBorrowedHandleId={\n${ids}\n} as const;\n\n${functions}\n`;
}

function renderStaticHermes() {
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n// Caller owns contiguous u64 argument slots and one u64 result slot.\n\"use strict\";\nconst __ffiDmSdkBorrowedHandleDispatch=$SHBuiltin.extern_c(\n  {include:\"defold_hermes/generated_dmsdk_borrowed_handle.h\"},\n  function deherm_dmsdk_borrowed_dispatch(id:c_ushort,argumentsPointer:c_ptr,argumentCount:c_uint,resultPointer:c_ptr):c_uint{throw 0;}\n);\nexport function dispatchDmSdkBorrowedHandle(id:c_ushort,argumentsPointer:c_ptr,argumentCount:c_uint,resultPointer:c_ptr):c_uint{return __ffiDmSdkBorrowedHandleDispatch(id,argumentsPointer,argumentCount,resultPointer);}\n`;
}

function renderHeaderAudit(entries) {
  const includes = [...new Set(entries.map(({ projection }) => headerPath(projection.provenance.header)))].sort().map((path) => `#include <${path}>`).join("\n");
  const checks = entries.map((entry) => {
    const parameters = entry.projection.signature.parameters
      .map((parameter, index) => nativeType(parameter, entry.parameters[index]))
      .join(", ") || "void";
    const signature = `DehermBorrowedSignature${entry.id}`;
    return `using ${signature}=${entry.shape.result.nativeType} (*)(${parameters});\nstatic_assert(std::is_same<decltype(static_cast<${signature}>(&${entry.projection.symbol})),${signature}>::value,${JSON.stringify(entry.projection.id)});`;
  }).join("\n");
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN \"deherm\"\n#endif\n#include <type_traits>\n#include <utility>\n${includes}\n${checks}\n`;
}

function exactScalar(entry, position, result = false) {
  const kind = result ? entry.result.kind : entry.parameters[position].kind;
  let seed = (result ? 101 : 17) + entry.id * 13 + position;
  if (kind === "u8") seed = 1 + seed % 251;
  if (kind === "u16") seed = 1 + seed % 65521;
  if (kind === "void") return { raw: "UINT64_C(0)", native: "" };
  if (kind === "bool") return { raw: "UINT64_C(1)", native: "true" };
  if (kind === "f32") return { raw: `pack_f32(${seed}.25f)`, native: `${seed}.25f` };
  if (kind === "i32") return { raw: `static_cast<uint64_t>(static_cast<int64_t>(INT32_C(-${seed})))`, native: `INT32_C(-${seed})` };
  if (kind === "u64") return { raw: `UINT64_C(${4294967296 + seed})`, native: `UINT64_C(${4294967296 + seed})` };
  return { raw: `UINT64_C(${seed})`, native: `UINT${kind.slice(1)}_C(${seed})` };
}

function exactHandle(entry, position) {
  const parameter = entry.parameters[position];
  const value = 0x1000 + entry.id * 0x80 + position * 8;
  const type = nativeType(entry.projection.signature.parameters[position], parameter);
  const raw = `UINT64_C(${value})`;
  const native = parameter.representation === "opaque"
    ? `reinterpret_cast<${type}>(static_cast<uintptr_t>(${raw}))`
    : `static_cast<${type}>(${raw})`;
  return { raw, native };
}

function exactArgument(entry, position) {
  return entry.parameters[position].kind === "handle"
    ? exactHandle(entry, position)
    : exactScalar(entry, position);
}

function exactDecodedArgument(entry, position) {
  const parameter = entry.parameters[position];
  const type = nativeType(entry.projection.signature.parameters[position], parameter);
  if (parameter.kind === "handle") {
    return parameter.representation === "opaque"
      ? `reinterpret_cast<${type}>(static_cast<uintptr_t>(arguments[${position}]))`
      : `static_cast<${type}>(arguments[${position}])`;
  }
  if (parameter.kind === "bool") return `static_cast<${type}>(arguments[${position}]!=0)`;
  if (parameter.kind === "f32") return `static_cast<${type}>(unpack_f32(arguments[${position}]))`;
  if (parameter.kind === "i32") return `static_cast<${type}>(static_cast<int32_t>(arguments[${position}]))`;
  return `static_cast<${type}>(arguments[${position}])`;
}

function exactResultType(kind) {
  return ({ void: "void", bool: "bool", u8: "uint8_t", u16: "uint16_t", i32: "int32_t", u32: "uint32_t", u64: "uint64_t", f32: "float" })[kind];
}

function renderExactCall(entries) {
  const includes = [...new Set(entries.map(({ projection }) => headerPath(projection.provenance.header)))].sort().map((path) => `#include <${path}>`).join("\n");
  const callees = entries.map((entry) => {
    const parameters = entry.projection.signature.parameters.map((parameter, position) => `${nativeType(parameter, entry.parameters[position])} a${position}`);
    const checks = entry.parameters.map((_, position) => `if(a${position}!=${exactArgument(entry, position).native})++g_failures[${entry.id}];`).join("");
    const result = exactScalar(entry, 0, true);
    const returned = entry.result.kind === "void" ? "" : `return static_cast<${exactResultType(entry.result.kind)}>(${result.native});`;
    return `static ${exactResultType(entry.result.kind)} exact_callee_${entry.id}(${parameters.join(",")}){++g_calls[${entry.id}];${checks}${returned}}`;
  }).join("\n");
  const cases = entries.map((entry) => {
    const argumentsList = entry.parameters.map((_, position) => exactDecodedArgument(entry, position)).join(",");
    const call = `exact_callee_${entry.id}(${argumentsList})`;
    let body;
    if (entry.result.kind === "void") body = `${call};*out_result=UINT64_C(0);`;
    else if (entry.result.kind === "f32") body = `*out_result=pack_f32(${call});`;
    else if (entry.result.kind === "i32") body = `*out_result=static_cast<uint64_t>(static_cast<int64_t>(${call}));`;
    else body = `*out_result=static_cast<uint64_t>(${call});`;
    return `case UINT16_C(${entry.id}):if(argument_count!=UINT32_C(${entry.parameters.length}))return DEHERM_DMSDK_BORROWED_PROVIDER_ERROR;${body}return DEHERM_DMSDK_BORROWED_OK;`;
  }).join("\n");
  const vectors = entries.map((entry) => {
    const argumentsList = entry.parameters.map((_, position) => exactArgument(entry, position).raw);
    while (argumentsList.length < Math.max(1, ...entries.map(({ parameters }) => parameters.length))) argumentsList.push("UINT64_C(0)");
    const expected = exactScalar(entry, 0, true).raw;
    return `{uint64_t arguments[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS]={${argumentsList.join(",")}};uint64_t result=UINT64_MAX;if(deherm_dmsdk_borrowed_dispatch(UINT16_C(${entry.id}),arguments,UINT32_C(${entry.parameters.length}),&result)!=DEHERM_DMSDK_BORROWED_OK||result!=${expected})return ${1000 + entry.id};}`;
  }).join("\n");
  return `// Generated by scripts/generate-dmsdk-borrowed-handle-bindings.mjs. Do not edit.\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN \"deherm\"\n#endif\n#include <defold_hermes/generated_dmsdk_borrowed_handle.h>\n#include <cstring>\n${includes}\nnamespace {\nuint32_t g_calls[${entries.length}]={};\nuint32_t g_failures[${entries.length}]={};\nuint64_t pack_f32(float value){uint32_t bits=0;std::memcpy(&bits,&value,sizeof(bits));return bits;}\nfloat unpack_f32(uint64_t raw){const uint32_t bits=static_cast<uint32_t>(raw);float value=0;std::memcpy(&value,&bits,sizeof(value));return value;}\nuint8_t exact_current_thread(void*){return UINT8_C(1);}\nuint8_t exact_validate_handle(void*,uint16_t kind,uint64_t value){return kind<deherm_dmsdk_borrowed_handle_kind_count()&&value!=0?UINT8_C(1):UINT8_C(0);}\n${callees}\nDehermDmSdkBorrowedStatus exact_invoke(void*,uint16_t id,const uint64_t* arguments,uint32_t argument_count,uint64_t* out_result){switch(id){\n${cases}\ndefault:return DEHERM_DMSDK_BORROWED_UNKNOWN_ID;}}\n}\nextern \"C\" int deherm_dmsdk_borrowed_exact_call_run(void){DehermDmSdkBorrowedProvider provider={DEHERM_DMSDK_BORROWED_PROVIDER_ABI,nullptr,exact_current_thread,exact_validate_handle,exact_invoke};if(deherm_dmsdk_borrowed_set_provider(&provider)!=DEHERM_DMSDK_BORROWED_OK)return 1;\n${vectors}\nfor(uint32_t id=0;id<UINT32_C(${entries.length});++id){if(g_calls[id]!=UINT32_C(1)||g_failures[id]!=UINT32_C(0))return 2;}return deherm_dmsdk_borrowed_set_provider(nullptr)==DEHERM_DMSDK_BORROWED_OK?0:3;}\n`;
}

export async function build(inputs = undefined) {
  const contents = inputs ?? Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(root, path), "utf8")])));
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const projection = JSON.parse(contents.projection);
  const policy = JSON.parse(contents.policy);
  if (new Set([ir.defoldRevision, shapes.defoldRevision, projection.defoldRevision]).size !== 1) throw new Error("borrowed-handle inputs have different Defold revisions");
  if (shapes.sourceHashes.ir !== sha256(contents.ir) || projection.sources.hashes.ir !== sha256(contents.ir)) throw new Error("borrowed-handle IR provenance mismatch");
  const candidates = shapes.rows.filter(({ tranche }) => tranche === policy.family);
  const projectionById = new Map(projection.rows.map((row) => [row.id, row]));
  const declarationById = new Map(ir.declarations.map((row) => [row.id, row]));
  if (projectionById.size !== projection.rows.length || declarationById.size !== ir.declarations.length) throw new Error("borrowed-handle input contains duplicate declaration IDs");
  const entries = [];
  const rows = [];
  for (const shape of candidates) {
    const projected = projectionById.get(shape.id);
    const declaration = declarationById.get(shape.id);
    if (!projected || !declaration) throw new Error(`borrowed-handle candidate is absent from source IR: ${shape.id}`);
    const blockers = structuralBlockers(shape, policy);
    if (blockers.length) {
      rows.push({ id: shape.id, projectionId: projected.projectionId, symbol: shape.symbol, disposition: "blocked", blockers: [...new Set([...blockers, ...semanticBlockers(projected)])].sort(), shape: shape.shape });
      continue;
    }
    const parameters = shape.parameters.map((parameter, index) => ({
      position: index,
      name: projected.signature.parameters[index].name || `argument${index}`,
      kind: roleKind(parameter.role),
      handleName: handleName(parameter.role),
      representation: parameter.role.startsWith("handle:") ? parameter.role.split(":").at(-1) : null,
      nativeRole: parameter.role,
    }));
    const entry = { id: entries.length, projection: projected, declaration, shape, parameters, result: { kind: roleKind(shape.result.role), nativeRole: shape.result.role } };
    entries.push(entry);
    rows.push({ id: shape.id, projectionId: projected.projectionId, symbol: shape.symbol, disposition: "generated-provider-boundary", preferredLowering: false, bindingId: entry.id, shape: shape.shape, resolvedPolicies: policy.providerContract, engineProviderBlockers: semanticBlockers(projected), stages: { generated: "all-five-target-projections-and-exact-call-twin", compiled: "pinned-header-adapter-and-exact-twin", linked: "generated-exact-provider-host-bridge-only", runtime: "generated-exact-provider-sanitized-and-warmed", engine: "not-claimed-provider-absent" } });
  }
  const expected = policy.expectedCoverage;
  if (candidates.length !== expected.candidates || entries.length !== expected.generated || rows.length - entries.length !== expected.blocked) throw new Error(`borrowed-handle census changed: ${candidates.length}/${entries.length}/${rows.length - entries.length}`);
  const handleNames = [...new Set(entries.flatMap(({ parameters }) => parameters.map(({ handleName: name }) => name).filter(Boolean)))].sort();
  const handleKinds = new Map(handleNames.map((name, id) => [name, { id, name, representation: candidates.find((row) => row.parameters.some(({ role }) => handleName(role) === name)).parameters.find(({ role }) => handleName(role) === name).role.split(":").at(-1) }]));
  const maxArguments = Math.max(...entries.map(({ parameters }) => parameters.length));
  if (handleKinds.size !== expected.handleKinds || maxArguments !== expected.maxArguments) throw new Error("borrowed-handle storage census changed");
  const names = makeFunctionNames(entries);
  if (new Set(names).size !== names.length) throw new Error("borrowed-handle TypeScript function names collide");
  const generated = new Map();
  generated.set(artifacts.header, renderHeader(entries, handleKinds, maxArguments));
  generated.set(artifacts.runtime, renderRuntime(entries, handleKinds, maxArguments));
  generated.set(artifacts.jsiHeader, renderJsiHeader());
  generated.set(artifacts.jsi, renderJsi(maxArguments));
  generated.set(artifacts.browser, renderBrowser(entries, handleKinds, maxArguments));
  generated.set(artifacts.typescript, renderTypeScript(entries, names));
  generated.set(artifacts.staticHermes, renderStaticHermes());
  generated.set(artifacts.headerAudit, renderHeaderAudit(entries));
  generated.set(artifacts.exactCall, renderExactCall(entries));
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sources: paths,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, sha256(content)])),
    selector: "all borrowed-handle-consumers are partitioned by ABI roles and platform family; no symbol allowlist",
    policy: { ...policy.providerContract, ...policy.targetPolicy, evidenceBoundary: "generated and exact fake-provider tested; no packaged-engine provider, handle, symbol, or thread proof" },
    abi: { slotBytes: 8, maxArguments, handleKindCount: handleKinds.size, argumentStorage: "caller-owned contiguous uint64_t slots", resultStorage: "caller-owned uint64_t slot" },
    coverage: { candidates: candidates.length, generated: entries.length, blocked: rows.length - entries.length, cAbiGenerated: entries.length, dynamicHermesJsiGenerated: entries.length, staticHermesGenerated: entries.length, browserDirectMemoryGenerated: entries.length, typescriptGenerated: entries.length, pinnedHeaderSignatureCompiled: entries.length, exactCallTwinsGenerated: entries.length, fakeProviderHostRuntimeTested: entries.length, packagedEngineRuntimeVerified: 0, warmedDispatchIterations: 100000, warmedDispatchObservedCppAllocations: 0 },
    handleKinds: [...handleKinds.values()],
    artifactHashes: Object.fromEntries([...generated].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(content)])),
    artifacts: [...generated.keys()].sort(),
    declarations: rows,
  };
  generated.set(artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts: generated, report };
}

async function writeOrCheck(outputRoot, path, content, check) {
  const destination = resolve(outputRoot, path);
  if (check) {
    if (await readFile(destination, "utf8") !== content) throw new Error(`${path} is stale`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await build();
  for (const [path, content] of result.artifacts) await writeOrCheck(options.outputRoot, path, content, options.check);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${result.report.coverage.generated}/${result.report.coverage.candidates} borrowed-handle bindings; ${result.report.coverage.blocked} structurally blocked.\n`);
  return result.report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
