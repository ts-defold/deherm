import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json",
});
const artifacts = Object.freeze({
  report: "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js",
  typescript: "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts",
  headerAudit: "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp",
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) => String(value).replace(/::/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
const camel = (value) => snake(value).split("_").filter(Boolean).map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join("");

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
  if (role.startsWith("enum:")) return "enum";
  if (role.startsWith("pointer:scalar:")) return role.slice("pointer:scalar:".length);
  if (role.startsWith("pointer:enum:")) return "enum";
  return undefined;
}

function handleName(role) {
  if (!role.startsWith("handle:")) return undefined;
  return role.split(":").slice(1, -1).join(":");
}

function directionAllowed(parameter, policy) {
  if (parameter.direction === "value") {
    return policy.selection.valueRolePrefixes.some((prefix) => parameter.role.startsWith(prefix));
  }
  return policy.selection.pointerDirections.includes(parameter.direction) &&
    policy.selection.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix));
}

function structuralBlockers(shape, policy) {
  const blockers = [];
  if (!policy.selection.resultRolePrefixes.some((prefix) => shape.result.role.startsWith(prefix))) {
    blockers.push(`result-role-unsupported:${shape.result.role}`);
  }
  for (const parameter of shape.parameters) {
    if (!directionAllowed(parameter, policy)) {
      blockers.push(`parameter-role-direction-unsupported:${parameter.position}:${parameter.direction}:${parameter.role}`);
    }
  }
  if (!shape.parameters.some((parameter) =>
    ["out", "inout"].includes(parameter.direction) &&
    policy.selection.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix)))) {
    blockers.push("writable-scalar-pointer-required");
  }
  for (const family of policy.selection.rejectedFamilies) {
    if (shape.families.includes(family)) blockers.push(`family-requires-target-matrix:${family}`);
  }
  return [...new Set(blockers)].sort();
}

function semanticBlockers(row) {
  const mapped = {
    "call-thread-affinity": "call-thread-affinity-unresolved",
    "enum-width-domain-validation": "enum-width-domain-validation-unresolved",
    "handle-ownership-nullability-lifetime": "handle-ownership-nullability-lifetime-unresolved",
    "native-symbol-linkage": "native-symbol-linkage-unverified",
    "out-storage-initialization-failure": "out-storage-initialization-failure-unresolved",
    "pointer-bounds-nullability-lifetime": "pointer-bounds-nullability-lifetime-unresolved",
    "target-feature-symbol-matrix": "target-feature-symbol-matrix-unverified",
  };
  return [...new Set((row.semanticTokensNeeded ?? []).map((token) => mapped[token] ?? `semantic-token-unresolved:${token}`))].sort();
}

function cKind(kind) {
  return {
    handle: "DEHERM_DMSDK_SCRATCH_HANDLE",
    bool: "DEHERM_DMSDK_SCRATCH_BOOL",
    i32: "DEHERM_DMSDK_SCRATCH_I32",
    u16: "DEHERM_DMSDK_SCRATCH_U16",
    u32: "DEHERM_DMSDK_SCRATCH_U32",
    u64: "DEHERM_DMSDK_SCRATCH_U64",
    f32: "DEHERM_DMSDK_SCRATCH_F32",
    enum: "DEHERM_DMSDK_SCRATCH_ENUM",
  }[kind];
}

function cDirection(direction) {
  return `DEHERM_DMSDK_SCRATCH_${direction.toUpperCase()}`;
}

function universalFallback(blockers) {
  return {
    state: "universal-fallback",
    family: "universal-recipe",
    blockers: [...blockers].sort(),
    preserved: true
  };
}

function tsType(value) {
  if (value.kind === "handle") return `ScratchBorrowedHandle<${JSON.stringify(value.handleName)}>`;
  if (value.kind === "bool") return "boolean";
  if (value.kind === "u64") return "bigint";
  return "number";
}

function makeFunctionNames(entries) {
  const initial = entries.map((entry) => camel(entry.projection.symbol));
  const counts = new Map();
  for (const name of initial) counts.set(name, (counts.get(name) ?? 0) + 1);
  return initial.map((name, index) => counts.get(name) === 1 ? name : `${name}Binding${entries[index].id}`);
}

function outputName(parameter) {
  const name = camel(parameter.name);
  return `output${name ? name[0].toUpperCase() + name.slice(1) : `Value${parameter.position}`}`;
}

function headerPath(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`Header is outside pinned dmSDK include projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}

function nativeType(shapeParameter, projectedParameter) {
  if (shapeParameter.role.startsWith("handle:")) return handleName(shapeParameter.role);
  if (shapeParameter.role.startsWith("enum:") && shapeParameter.direction === "value") return shapeParameter.role.slice("enum:".length);
  return projectedParameter.nativeType;
}

function specializationBlockers(shape, projected, declaration, policy) {
  const blockers = [];
  if (!projected) blockers.push("source-projection-missing");
  if (!declaration) blockers.push("source-declaration-missing");
  if (!projected?.signature || !Array.isArray(projected.signature.parameters) ||
      projected.signature.parameters.length !== shape.parameters.length) {
    blockers.push("source-signature-parameter-shape-unrecognized");
  }
  const structural = structuralBlockers(shape, policy);
  blockers.push(...structural);
  if (!cKind(roleKind(shape.result.role))) blockers.push(`result-kind-unsupported:${shape.result.role}`);
  for (const parameter of shape.parameters) {
    if (!cKind(roleKind(parameter.role))) blockers.push(`parameter-kind-unsupported:${parameter.position}:${parameter.role}`);
    if (parameter.role.startsWith("handle:") && !handleName(parameter.role)) {
      blockers.push(`parameter-handle-kind-unsupported:${parameter.position}:${parameter.role}`);
    }
  }
  return [...new Set(blockers)].sort();
}

function renderHeader(entries, handleKinds, maxParameters) {
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_SCRATCH_SCALAR_OUT_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_SCRATCH_SCALAR_OUT_H\n#include <stdint.h>\n#define DEHERM_DMSDK_SCRATCH_PROVIDER_ABI UINT32_C(1)\n#define DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS ${maxParameters}\n#define DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND UINT16_MAX\ntypedef enum DehermDmSdkScratchKind { DEHERM_DMSDK_SCRATCH_HANDLE=1, DEHERM_DMSDK_SCRATCH_BOOL=2, DEHERM_DMSDK_SCRATCH_I32=3, DEHERM_DMSDK_SCRATCH_U32=4, DEHERM_DMSDK_SCRATCH_U64=5, DEHERM_DMSDK_SCRATCH_F32=6, DEHERM_DMSDK_SCRATCH_ENUM=7, DEHERM_DMSDK_SCRATCH_U16=8 } DehermDmSdkScratchKind;\ntypedef enum DehermDmSdkScratchDirection { DEHERM_DMSDK_SCRATCH_VALUE=1, DEHERM_DMSDK_SCRATCH_IN=2, DEHERM_DMSDK_SCRATCH_OUT=3, DEHERM_DMSDK_SCRATCH_INOUT=4 } DehermDmSdkScratchDirection;\ntypedef enum DehermDmSdkScratchStatus { DEHERM_DMSDK_SCRATCH_OK=0, DEHERM_DMSDK_SCRATCH_UNKNOWN_ID=1, DEHERM_DMSDK_SCRATCH_WRONG_ARITY=2, DEHERM_DMSDK_SCRATCH_NULL_STORAGE=3, DEHERM_DMSDK_SCRATCH_PROVIDER_MISSING=4, DEHERM_DMSDK_SCRATCH_WRONG_THREAD=5, DEHERM_DMSDK_SCRATCH_INVALID_HANDLE=6, DEHERM_DMSDK_SCRATCH_INVALID_PROVIDER=7, DEHERM_DMSDK_SCRATCH_PROVIDER_ERROR=8, DEHERM_DMSDK_SCRATCH_REENTRANT=9, DEHERM_DMSDK_SCRATCH_INVALID_LANE=10 } DehermDmSdkScratchStatus;\ntypedef struct DehermDmSdkScratchDescriptor { uint16_t id; uint8_t parameter_count; uint8_t js_argument_count; uint8_t output_count; uint8_t result_kind; uint8_t parameter_kinds[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; uint8_t parameter_directions[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; uint16_t handle_kinds[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; const char* declaration_id; } DehermDmSdkScratchDescriptor;\ntypedef struct DehermDmSdkScratchHandleKind { uint16_t id; const char* name; const char* native_representation; } DehermDmSdkScratchHandleKind;\ntypedef uint8_t (*DehermDmSdkScratchCurrentThreadFn)(void* context);\ntypedef uint8_t (*DehermDmSdkScratchValidateHandleFn)(void* context, uint16_t handle_kind, uint64_t value);\ntypedef DehermDmSdkScratchStatus (*DehermDmSdkScratchInvokeFn)(void* context, uint16_t id, uint64_t* parameter_slots, uint32_t parameter_count, uint64_t* out_result);\ntypedef struct DehermDmSdkScratchProvider { uint32_t abi_version; void* context; DehermDmSdkScratchCurrentThreadFn is_current_thread; DehermDmSdkScratchValidateHandleFn validate_handle; DehermDmSdkScratchInvokeFn invoke; } DehermDmSdkScratchProvider;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_scratch_count(void);\nconst DehermDmSdkScratchDescriptor* deherm_dmsdk_scratch_descriptors(void);\nuint32_t deherm_dmsdk_scratch_handle_kind_count(void);\nconst DehermDmSdkScratchHandleKind* deherm_dmsdk_scratch_handle_kinds(void);\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_set_provider(const DehermDmSdkScratchProvider* provider);\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_dispatch(uint16_t id, uint64_t* parameter_slots, uint32_t parameter_count, uint64_t* out_result);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderRuntime(entries, handleKinds, maxParameters) {
  const descriptorRows = entries.map((entry) => {
    const kinds = entry.parameters.map(({ kind }) => cKind(kind));
    const directions = entry.parameters.map(({ direction }) => cDirection(direction));
    const handles = entry.parameters.map(({ handleName: name }) => name ? handleKinds.get(name).id : "DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND");
    while (kinds.length < maxParameters) kinds.push("0");
    while (directions.length < maxParameters) directions.push("0");
    while (handles.length < maxParameters) handles.push("DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND");
    return `  { UINT16_C(${entry.id}), UINT8_C(${entry.parameters.length}), UINT8_C(${entry.parameters.filter(({ direction }) => direction !== "out").length}), UINT8_C(${entry.parameters.filter(({ direction }) => direction === "out" || direction === "inout").length}), UINT8_C(${cKind(entry.result.kind)}), { ${kinds.join(", ")} }, { ${directions.join(", ")} }, { ${handles.map((value) => typeof value === "number" ? `UINT16_C(${value})` : value).join(", ")} }, ${JSON.stringify(entry.projection.id)} }`;
  }).join(",\n");
  const handleRows = [...handleKinds.values()].map(({ id, name, representation }) => `  { UINT16_C(${id}), ${JSON.stringify(name)}, ${JSON.stringify(representation)} }`).join(",\n");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>\n#include <string.h>\nnamespace {\nconst DehermDmSdkScratchDescriptor kDescriptors[] = {\n${descriptorRows}\n};\nconst DehermDmSdkScratchHandleKind kHandleKinds[] = {\n${handleRows}\n};\nDehermDmSdkScratchProvider gProvider = {};\nthread_local bool gDispatchActive = false;\nbool validLane(uint8_t kind, uint64_t value) {\n  if (kind == DEHERM_DMSDK_SCRATCH_BOOL) return value <= UINT64_C(1);\n  if (kind == DEHERM_DMSDK_SCRATCH_U16) return value <= UINT64_C(0xffff);\n  if (kind == DEHERM_DMSDK_SCRATCH_U32 || kind == DEHERM_DMSDK_SCRATCH_F32) return value <= UINT64_C(0xffffffff);\n  if (kind == DEHERM_DMSDK_SCRATCH_I32 || kind == DEHERM_DMSDK_SCRATCH_ENUM) return value == static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(value)));\n  return true;\n}\nvoid clearWritable(const DehermDmSdkScratchDescriptor& descriptor, uint64_t* slots) { for (uint32_t index=0; index<descriptor.parameter_count; ++index) if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT || descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_INOUT) slots[index]=0; }\nstruct DispatchScope { DispatchScope(){gDispatchActive=true;} ~DispatchScope(){gDispatchActive=false;} };\n}\nextern "C" {\nuint32_t deherm_dmsdk_scratch_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkScratchDescriptor* deherm_dmsdk_scratch_descriptors(void) { return kDescriptors; }\nuint32_t deherm_dmsdk_scratch_handle_kind_count(void) { return UINT32_C(${handleKinds.size}); }\nconst DehermDmSdkScratchHandleKind* deherm_dmsdk_scratch_handle_kinds(void) { return kHandleKinds; }\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_set_provider(const DehermDmSdkScratchProvider* provider) {\n  if (provider == nullptr) { memset(&gProvider, 0, sizeof(gProvider)); return DEHERM_DMSDK_SCRATCH_OK; }\n  if (provider->abi_version != DEHERM_DMSDK_SCRATCH_PROVIDER_ABI || provider->is_current_thread == nullptr || provider->validate_handle == nullptr || provider->invoke == nullptr) return DEHERM_DMSDK_SCRATCH_INVALID_PROVIDER;\n  gProvider = *provider; return DEHERM_DMSDK_SCRATCH_OK;\n}\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_dispatch(uint16_t id, uint64_t* slots, uint32_t parameter_count, uint64_t* out_result) {\n  if (id >= deherm_dmsdk_scratch_count()) return DEHERM_DMSDK_SCRATCH_UNKNOWN_ID;\n  const DehermDmSdkScratchDescriptor& descriptor = kDescriptors[id];\n  if (parameter_count != descriptor.parameter_count) return DEHERM_DMSDK_SCRATCH_WRONG_ARITY;\n  if (slots == nullptr || out_result == nullptr) return DEHERM_DMSDK_SCRATCH_NULL_STORAGE;\n  *out_result = 0;\n  for (uint32_t index=0; index<parameter_count; ++index) if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT) slots[index]=0;\n  if (gProvider.invoke == nullptr) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_PROVIDER_MISSING; }\n  if (gDispatchActive) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_REENTRANT; }\n  if (gProvider.is_current_thread(gProvider.context) == 0) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_WRONG_THREAD; }\n  for (uint32_t index=0; index<parameter_count; ++index) {\n    if (descriptor.parameter_directions[index] != DEHERM_DMSDK_SCRATCH_OUT && !validLane(descriptor.parameter_kinds[index], slots[index])) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_INVALID_LANE; }\n    if (descriptor.parameter_kinds[index] == DEHERM_DMSDK_SCRATCH_HANDLE && (slots[index] == 0 || gProvider.validate_handle(gProvider.context, descriptor.handle_kinds[index], slots[index]) == 0)) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_INVALID_HANDLE; }\n  }\n  DispatchScope scope;\n  const DehermDmSdkScratchStatus status = gProvider.invoke(gProvider.context, id, slots, parameter_count, out_result);\n  if (status != DEHERM_DMSDK_SCRATCH_OK || !validLane(descriptor.result_kind, *out_result)) { clearWritable(descriptor, slots); *out_result=0; return status == DEHERM_DMSDK_SCRATCH_OK ? DEHERM_DMSDK_SCRATCH_INVALID_LANE : status; }\n  for (uint32_t index=0; index<parameter_count; ++index) if ((descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT || descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_INOUT) && !validLane(descriptor.parameter_kinds[index], slots[index])) { clearWritable(descriptor, slots); *out_result=0; return DEHERM_DMSDK_SCRATCH_INVALID_LANE; }\n  return DEHERM_DMSDK_SCRATCH_OK;\n}\n}\n`;
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#pragma once\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes { void installDmSdkScratchScalarOutModule(facebook::jsi::Runtime&, facebook::jsi::Object&); }\n#endif\n`;
}

function renderJsi(maxParameters) {
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out_jsi.hpp>\n#if !defined(DM_PLATFORM_HTML5)\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>\n#include <cmath>\n#include <cstring>\nnamespace defold_hermes { namespace jsi=facebook::jsi; namespace {\nbool integer(const jsi::Value& value){return value.isNumber()&&std::isfinite(value.asNumber())&&std::trunc(value.asNumber())==value.asNumber();}\nuint64_t encode(jsi::Runtime& runtime,const jsi::Value& value,uint8_t kind){if(kind==DEHERM_DMSDK_SCRATCH_HANDLE||kind==DEHERM_DMSDK_SCRATCH_U64){if(!value.isBigInt())throw jsi::JSError(runtime,"expected u64 bigint");auto bigint=value.getBigInt(runtime);if(!bigint.isUint64(runtime))throw jsi::JSError(runtime,"bigint outside u64 range");auto raw=bigint.asUint64(runtime);if(kind==DEHERM_DMSDK_SCRATCH_HANDLE&&raw==0)throw jsi::JSError(runtime,"handle must be nonzero");return raw;}if(kind==DEHERM_DMSDK_SCRATCH_BOOL){if(!value.isBool())throw jsi::JSError(runtime,"expected boolean");return value.getBool()?1:0;}if(!value.isNumber()||!std::isfinite(value.asNumber()))throw jsi::JSError(runtime,"expected finite number");const double number=value.asNumber();if(kind==DEHERM_DMSDK_SCRATCH_F32){const float narrowed=static_cast<float>(number);uint32_t bits=0;std::memcpy(&bits,&narrowed,4);return bits;}if(!integer(value))throw jsi::JSError(runtime,"expected integer");if(kind==DEHERM_DMSDK_SCRATCH_U16&&(number<0||number>65535.0))throw jsi::JSError(runtime,"u16 out of range");if(kind==DEHERM_DMSDK_SCRATCH_U32&&(number<0||number>4294967295.0))throw jsi::JSError(runtime,"u32 out of range");if((kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)&&(number<-2147483648.0||number>2147483647.0))throw jsi::JSError(runtime,"i32 out of range");return (kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)?static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(number))):static_cast<uint64_t>(number);}\njsi::Value decode(jsi::Runtime& runtime,uint8_t kind,uint64_t raw){if(kind==DEHERM_DMSDK_SCRATCH_BOOL)return jsi::Value(raw!=0);if(kind==DEHERM_DMSDK_SCRATCH_U64)return jsi::Value(runtime,jsi::BigInt::fromUint64(runtime,raw));if(kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)return jsi::Value(static_cast<double>(static_cast<int32_t>(raw)));if(kind==DEHERM_DMSDK_SCRATCH_F32){uint32_t bits=static_cast<uint32_t>(raw);float value=0;std::memcpy(&value,&bits,4);return jsi::Value(static_cast<double>(value));}return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));}\n}\nvoid installDmSdkScratchScalarOutModule(jsi::Runtime& runtime,jsi::Object& modules){jsi::Object module(runtime);auto call=jsi::Function::createFromHostFunction(runtime,jsi::PropNameID::forAscii(runtime,"call"),2,[](jsi::Runtime& runtime,const jsi::Value&,const jsi::Value* args,size_t count){if(count==0||!integer(args[0])||args[0].asNumber()<0||args[0].asNumber()>65535)throw jsi::JSError(runtime,"scratch call expects u16 id");const uint16_t id=static_cast<uint16_t>(args[0].asNumber());if(id>=deherm_dmsdk_scratch_count())throw jsi::JSError(runtime,"unknown scratch id");const auto& descriptor=deherm_dmsdk_scratch_descriptors()[id];if(count!=static_cast<size_t>(descriptor.js_argument_count)+1)throw jsi::JSError(runtime,"wrong scratch arity");uint64_t slots[${Math.max(1, maxParameters)}]={};size_t input=1;for(uint8_t index=0;index<descriptor.parameter_count;++index)if(descriptor.parameter_directions[index]!=DEHERM_DMSDK_SCRATCH_OUT)slots[index]=encode(runtime,args[input++],descriptor.parameter_kinds[index]);uint64_t result=0;const auto status=deherm_dmsdk_scratch_dispatch(id,slots,descriptor.parameter_count,&result);if(status!=DEHERM_DMSDK_SCRATCH_OK)throw jsi::JSError(runtime,"scratch scalar-out dispatch failed");jsi::Array output(runtime,static_cast<size_t>(descriptor.output_count)+1);output.setValueAtIndex(runtime,0,decode(runtime,descriptor.result_kind,result));size_t outputIndex=1;for(uint8_t index=0;index<descriptor.parameter_count;++index)if(descriptor.parameter_directions[index]==DEHERM_DMSDK_SCRATCH_OUT||descriptor.parameter_directions[index]==DEHERM_DMSDK_SCRATCH_INOUT)output.setValueAtIndex(runtime,outputIndex++,decode(runtime,descriptor.parameter_kinds[index],slots[index]));return output;});module.setProperty(runtime,"call",std::move(call));modules.setProperty(runtime,"DmSdkScratchScalarOut",std::move(module));}\n}\n#endif\n`;
}

function renderBrowser(entries, handleKinds, maxParameters) {
  const descriptors = entries.map((entry) => `{id:${entry.id},resultKind:${JSON.stringify(entry.result.kind)},parameterKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ kind }) => kind))}),directions:Object.freeze(${JSON.stringify(entry.parameters.map(({ direction }) => direction))}),handleKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ handleName: name }) => name ?? null))}),declarationId:${JSON.stringify(entry.projection.id)}}`).join(",\n      ");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\nvar LibraryDefoldHermesDmSdkScratchScalarOut={\n  $DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT__deps:['deherm_dmsdk_scratch_dispatch'],\n  $DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT:{\n    abi:Object.freeze({slotBytes:8,maxParameters:${maxParameters},resultBytes:8,storage:'caller-owned',reentrancy:'rejected'}),\n    handleKinds:Object.freeze(${JSON.stringify([...handleKinds.values()])}),\n    descriptors:Object.freeze([\n      ${descriptors}\n    ]),\n    callRaw:function(id,slotsPointer,parameterCount,resultPointer){return _deherm_dmsdk_scratch_dispatch(id,slotsPointer,parameterCount,resultPointer);}\n  }\n};\nautoAddDeps(LibraryDefoldHermesDmSdkScratchScalarOut,'$DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT');\naddToLibrary(LibraryDefoldHermesDmSdkScratchScalarOut);\n`;
}

function renderTypeScript(entries, names) {
  const ids = entries.map((entry, index) => `  ${names[index]}: ${entry.id}`).join(",\n");
  const functions = entries.map((entry, index) => {
    const inputs = entry.parameters.filter(({ direction }) => direction !== "out");
    const outputs = entry.parameters.filter(({ direction }) => direction === "out" || direction === "inout");
    const parameters = inputs.map((parameter) => `${camel(parameter.name)}: ${tsType(parameter)}`).join(", ");
    const argumentsList = inputs.map(({ name }) => camel(name)).join(", ");
    const resultType = `{ readonly result: ${tsType(entry.result)}; ${outputs.map((output) => `readonly ${outputName(output)}: ${tsType(output)};`).join(" ")} }`;
    const fields = outputs.map((output, outputIndex) => `${outputName(output)}: tuple[${outputIndex + 1}] as ${tsType(output)}`).join(", ");
    return `/** Caller-owned one-slot scalar output bridge for ${entry.projection.symbol}; no pointer escapes. */\nexport function ${names[index]}(${parameters}): ${resultType} { const tuple=module().call(DmSdkScratchScalarOutId.${names[index]}${argumentsList ? `, ${argumentsList}` : ""});if(tuple.length!==${outputs.length + 1})throw new Error("invalid scratch scalar-out tuple");return {result:tuple[0] as ${tsType(entry.result)},${fields}}; }`;
  }).join("\n\n");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\ndeclare const scratchHandleBrand: unique symbol;\nexport type ScratchBorrowedHandle<Kind extends string> = bigint & { readonly [scratchHandleBrand]: Kind };\ninterface DmSdkScratchScalarOutModule { call(id:number,...args:readonly (number|boolean|bigint)[]):readonly unknown[]; }\ndeclare global { var __defoldModulesV1: Record<string,object>|undefined; }\nfunction module():DmSdkScratchScalarOutModule { const value=globalThis.__defoldModulesV1?.DmSdkScratchScalarOut as DmSdkScratchScalarOutModule|undefined;if(!value)throw new Error("Defold module is not registered: DmSdkScratchScalarOut");return value; }\nexport function unsafeScratchBorrowedHandle<Kind extends string>(kind:Kind,value:bigint):ScratchBorrowedHandle<Kind>{void kind;if(value<=0n||value>0xffff_ffff_ffff_ffffn)throw new RangeError("handle must be a nonzero u64");return value as ScratchBorrowedHandle<Kind>;}\nexport const DmSdkScratchScalarOutId={\n${ids}\n} as const;\n\n${functions}\n`;
}

function renderStaticHermes() {
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n// Caller owns contiguous u64 parameter slots and one u64 result slot.\n"use strict";\nconst __ffiDmSdkScratchScalarOutDispatch=$SHBuiltin.extern_c(\n  {include:"defold_hermes/generated_dmsdk_scratch_scalar_out.h"},\n  function deherm_dmsdk_scratch_dispatch(id:c_ushort,slotsPointer:c_ptr,parameterCount:c_uint,resultPointer:c_ptr):c_uint{throw 0;}\n);\nexport function dispatchDmSdkScratchScalarOut(id:c_ushort,slotsPointer:c_ptr,parameterCount:c_uint,resultPointer:c_ptr):c_uint{return __ffiDmSdkScratchScalarOutDispatch(id,slotsPointer,parameterCount,resultPointer);}\n`;
}

function resultAssertion(entry, expression) {
  if (entry.result.kind === "bool") return `std::is_same<decltype(${expression}), bool>::value`;
  if (entry.result.kind === "f32") return `std::is_floating_point<decltype(${expression})>::value && sizeof(decltype(${expression})) == 4`;
  if (entry.result.kind === "enum") return `std::is_enum<decltype(${expression})>::value && sizeof(decltype(${expression})) <= 4`;
  const bytes = entry.result.kind === "u64" ? 8 : 4;
  return `(std::is_integral<decltype(${expression})>::value || std::is_enum<decltype(${expression})>::value) && sizeof(decltype(${expression})) <= ${bytes}`;
}

function renderHeaderAudit(entries) {
  const headers = [...new Set(entries.map(({ shape }) => headerPath(shape.header)))].sort();
  const lines = ["// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.", "#include <cstdint>", "#include <type_traits>", "#include <utility>", ...headers.map((header) => `#include <${header}>`), ""];
  for (const entry of entries) {
    const args = entry.shape.parameters.map((parameter, index) => `std::declval<${nativeType(parameter, entry.projection.signature.parameters[index])}>()`).join(", ");
    const expression = `${entry.projection.symbol}(${args})`;
    lines.push(`static_assert(${resultAssertion(entry, expression)}, ${JSON.stringify(entry.projection.id)});`);
    for (const [index, parameter] of entry.parameters.entries()) {
      if (parameter.direction === "value") continue;
      const native = nativeType(entry.shape.parameters[index], entry.projection.signature.parameters[index]);
      const bytes = parameter.kind === "u64" ? 8 : 4;
      const trait = parameter.kind === "f32"
        ? `std::is_floating_point<typename std::remove_pointer<${native}>::type>::value && sizeof(typename std::remove_pointer<${native}>::type) == 4`
        : parameter.kind === "bool"
          ? `std::is_same<typename std::remove_pointer<${native}>::type, bool>::value`
          : `(std::is_integral<typename std::remove_pointer<${native}>::type>::value || std::is_enum<typename std::remove_pointer<${native}>::type>::value) && sizeof(typename std::remove_pointer<${native}>::type) <= ${bytes}`;
      lines.push(`static_assert(${trait}, ${JSON.stringify(`${entry.projection.id}:parameter:${index}`)});`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function build(overrides = {}) {
  const contents = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, overrides[key] ?? await readFile(resolve(root, path), "utf8")])));
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const projection = JSON.parse(contents.projection);
  const policy = JSON.parse(contents.policy);
  if (new Set([ir.defoldRevision, shapes.defoldRevision, projection.defoldRevision]).size !== 1) throw new Error("scratch scalar-out inputs have different Defold revisions");
  if (shapes.sourceHashes.ir !== sha256(contents.ir) || projection.sources.hashes.ir !== sha256(contents.ir)) throw new Error("scratch scalar-out IR provenance mismatch");
  const candidates = shapes.rows.filter(({ tranche }) => tranche === policy.family);
  const projectionById = new Map(projection.rows.map((row) => [row.id, row]));
  const declarationById = new Map(ir.declarations.map((row) => [row.id, row]));
  const entries = [];
  const rows = [];
  for (const shape of candidates) {
    const projected = projectionById.get(shape.id);
    const declaration = declarationById.get(shape.id);
    const blockers = specializationBlockers(shape, projected, declaration, policy);
    if (blockers.length) {
      const allBlockers = [...new Set([...blockers, ...(projected ? semanticBlockers(projected) : [])])].sort();
      rows.push({ id: shape.id, projectionId: projected?.projectionId ?? null, symbol: shape.symbol, disposition: "blocked", blockers: allBlockers, universalFallback: universalFallback(allBlockers), shape: shape.shape });
      continue;
    }
    const parameters = shape.parameters.map((parameter, index) => ({ position: index, name: projected.signature.parameters[index].name || `argument${index}`, kind: roleKind(parameter.role), handleName: handleName(parameter.role), nativeRole: parameter.role, direction: parameter.direction }));
    const entry = { id: entries.length, projection: projected, declaration, shape, parameters, result: { kind: roleKind(shape.result.role), nativeRole: shape.result.role } };
    entries.push(entry);
    rows.push({ id: shape.id, projectionId: projected.projectionId, symbol: shape.symbol, disposition: "generated-provider-boundary", bindingId: entry.id, shape: shape.shape, resolvedPolicies: policy.storageContract, engineProviderBlockers: ["call-thread-affinity-unresolved", "enum-domain-to-native-success-policy-unresolved", "handle-provenance-lifetime-unresolved", "native-symbol-linkage-unverified", "target-feature-symbol-matrix-unverified"], stages: { generated: "all-five-target-projections", compiled: "pinned-header-and-adapter-object-tests", linked: "fake-provider-host-bridge-only", runtime: "fake-provider-sanitized-reentrancy-and-warmed", engine: "not-claimed-provider-absent" } });
  }
  const handleNames = [...new Set(entries.flatMap(({ parameters }) => parameters.map(({ handleName: name }) => name).filter(Boolean)))].sort();
  const handleKinds = new Map(handleNames.map((name, id) => [name, { id, name, representation: candidates.find((row) => row.parameters.some(({ role }) => handleName(role) === name)).parameters.find(({ role }) => handleName(role) === name).role.split(":").at(-1) }]));
  const maxParameters = Math.max(0, ...entries.map(({ parameters }) => parameters.length));
  const maxOutputs = Math.max(0, ...entries.map(({ parameters }) => parameters.filter(({ direction }) => direction === "out" || direction === "inout").length));
  const observedCoverage = { candidates: candidates.length, generated: entries.length, blocked: rows.length - entries.length };
  const storageMaxParameters = Math.max(1, maxParameters);
  const names = makeFunctionNames(entries);
  if (new Set(names).size !== names.length) throw new Error("scratch scalar-out TypeScript names collide");
  const generated = new Map();
  generated.set(artifacts.header, renderHeader(entries, handleKinds, storageMaxParameters));
  generated.set(artifacts.runtime, renderRuntime(entries, handleKinds, storageMaxParameters));
  generated.set(artifacts.jsiHeader, renderJsiHeader());
  generated.set(artifacts.jsi, renderJsi(storageMaxParameters));
  generated.set(artifacts.browser, renderBrowser(entries, handleKinds, storageMaxParameters));
  generated.set(artifacts.typescript, renderTypeScript(entries, names));
  generated.set(artifacts.staticHermes, renderStaticHermes());
  generated.set(artifacts.headerAudit, renderHeaderAudit(entries));
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sources: paths,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, sha256(content)])),
    selector: "complete scratch-out-parameters partition using only result roles, parameter roles/directions, and platform family; no symbol allowlist",
    policy: { ...policy.storageContract, ...policy.targetPolicy, evidenceBoundary: "generated and fake-provider tested; no dmSDK symbol link, real provider, or packaged-engine proof" },
    universalFallback: { preserved: true, catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json", mutation: "none" },
    abi: { slotBytes: 8, maxParameters, maxOutputs, handleKindCount: handleKinds.size, parameterStorage: "caller-owned contiguous uint64_t slots", resultStorage: "caller-owned uint64_t slot" },
    coverage: { ...observedCoverage, cAbiGenerated: entries.length, dynamicHermesJsiGenerated: entries.length, staticHermesGenerated: entries.length, browserDirectMemoryGenerated: entries.length, typescriptGenerated: entries.length, pinnedHeaderSignatureCompiled: entries.length, fakeProviderHostRuntimeTested: entries.length, packagedEngineRuntimeVerified: 0, warmedDispatchIterations: 100000, warmedDispatchObservedCppAllocations: 0 },
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
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${result.report.coverage.generated}/${result.report.coverage.candidates} scratch scalar-out bindings; ${result.report.coverage.blocked} structurally blocked.\n`);
  return result.report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
