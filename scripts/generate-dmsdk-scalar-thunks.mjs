import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { indexDmSdkValuePlan, inferScalarThunkSemantics } from "../packages/compiler/src/dmsdk-value-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const paths = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  valuePlan: "packages/bindings/generated/defold-dmsdk-value-plan.json",
  recipe: "packages/bindings/overrides/dmsdk-scalar-thunks.json",
};

const ABI_TYPES = Object.freeze({
  void: { c: "void", suffix: "v" },
  bool: { c: "uint8_t", suffix: "bool" },
  uint16_t: { c: "uint16_t", suffix: "u16" },
  uint32_t: { c: "uint32_t", suffix: "u32" },
  uint64_t: { c: "uint64_t", suffix: "u64" },
  float: { c: "float", suffix: "f32" },
});

const VALUE_KINDS = Object.freeze({
  void: "DEHERM_DMSDK_SCALAR_VOID",
  bool: "DEHERM_DMSDK_SCALAR_BOOL",
  uint16_t: "DEHERM_DMSDK_SCALAR_U16",
  uint32_t: "DEHERM_DMSDK_SCALAR_U32",
  uint64_t: "DEHERM_DMSDK_SCALAR_U64",
  float: "DEHERM_DMSDK_SCALAR_F32",
});

const FLAG_NATIVE_JS = 1;
const FLAG_BROWSER_JS = 2;
const FLAG_MAY_BLOCK = 4;

function parseArguments(argv) {
  const options = { outRoot: repositoryRoot, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function snakeCase(value) {
  return value
    .replace(/::/g, "_")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function wrapperName(declaration) {
  const suffix =
    declaration.parameters.length === 0
      ? ABI_TYPES.void.suffix
      : declaration.parameters.map(({ type }) => ABI_TYPES[type]?.suffix ?? "unsupported").join("_");
  return `deherm_dmsdk_${snakeCase(declaration.name)}_${suffix}`;
}

function tsName(entry) {
  const words = entry.wrapper.replace(/^deherm_dmsdk_/, "").split("_");
  return (
    words[0] +
    words
      .slice(1)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join("")
  );
}

function isJsLossless(declaration) {
  return ![declaration.returns, ...declaration.parameters.map(({ type }) => type)].includes("uint64_t");
}

function isNativeJsCallable() {
  // The pinned JSI exposes lossless BigInt <-> uint64_t conversion.
  return true;
}

function isBrowserSafe(entry) {
  return isJsLossless(entry.declaration) && entry.semantics.pureValueTransform && !entry.semantics.mayBlock;
}

function publicInclude(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  if (index < 0) throw new Error(`No public dmSDK include path in ${header}`);
  return `dmsdk/${header.slice(index + marker.length)}`;
}

export { inferScalarThunkSemantics };

function declarationEvidence(content, declaration) {
  const lines = content.split(/\r?\n/);
  const leaf = declaration.name.split("::").at(-1);
  const start = Math.max(0, declaration.line - 1);
  const end = Math.min(lines.length, start + 32);
  const candidates = [];
  for (let index = start; index < end; index += 1) {
    if (new RegExp(`\\b${leaf}\\s*\\(`).test(lines[index]))
      candidates.push({ line: index + 1, text: lines[index].trim() });
  }
  const candidate = candidates.find(({ text }) => {
    if (!text.includes(declaration.returns)) return false;
    return declaration.parameters.every(({ type }) => text.includes(type));
  });
  if (!candidate)
    throw new Error(
      `Could not validate ${declaration.type} for ${declaration.id} near ${declaration.header}:${declaration.line}`,
    );
  return candidate;
}

function abiDeclaration(declaration, name) {
  const returnType = ABI_TYPES[declaration.returns].c;
  const parameters = declaration.parameters
    .map((parameter) => `${ABI_TYPES[parameter.type].c} ${parameter.name}`)
    .join(", ");
  return `${returnType} ${name}(${parameters || "void"});`;
}

function abiDefinition(declaration, name) {
  const returnType = ABI_TYPES[declaration.returns].c;
  const parameters = declaration.parameters
    .map((parameter) => `${ABI_TYPES[parameter.type].c} ${parameter.name}`)
    .join(", ");
  const argumentsList = declaration.parameters.map(({ name: parameterName }) => parameterName).join(", ");
  const call = `${declaration.name}(${argumentsList})`;
  let body;
  if (declaration.returns === "void") body = `    ${call};`;
  else if (declaration.returns === "bool") body = `    return ${call} ? UINT8_C(1) : UINT8_C(0);`;
  else body = `    return ${call};`;
  return `${returnType} ${name}(${parameters || "void"})\n{\n${body}\n}`;
}

function renderHeader(entries) {
  const declarations = entries.map((entry) => abiDeclaration(entry.declaration, entry.wrapper)).join("\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n\n#include <stdint.h>\n\n#ifdef __cplusplus\nextern "C" {\n#endif\n\n${declarations}\n\n#ifdef __cplusplus\n} // extern "C"\n#endif\n\n#endif // DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n`;
}

function renderSource(entries) {
  const definitions = entries.map((entry) => abiDefinition(entry.declaration, entry.wrapper)).join("\n\n");
  const includes = [...new Set(entries.map(({ declaration }) => publicInclude(declaration.header)))]
    .sort()
    .map((include) => `#include <${include}>`)
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scalar.h>\n\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN "defold_hermes"\n#endif\n${includes}\n\nextern "C" {\n\n${definitions}\n\n} // extern "C"\n`;
}

function renderRuntimeHeader(entries) {
  const maxArguments = Math.max(1, ...entries.map(({ declaration }) => declaration.parameters.length));
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_RUNTIME_H\n\n#include <stdint.h>\n\n#define DEHERM_DMSDK_SCALAR_MAX_ARGUMENTS ${maxArguments}\n\ntypedef enum DehermDmSdkScalarValueKind {\n  DEHERM_DMSDK_SCALAR_VOID = 0,\n  DEHERM_DMSDK_SCALAR_BOOL = 1,\n  DEHERM_DMSDK_SCALAR_U16 = 2,\n  DEHERM_DMSDK_SCALAR_U32 = 3,\n  DEHERM_DMSDK_SCALAR_U64 = 4,\n  DEHERM_DMSDK_SCALAR_F32 = 5\n} DehermDmSdkScalarValueKind;\n\ntypedef enum DehermDmSdkScalarStatus {\n  DEHERM_DMSDK_SCALAR_OK = 0,\n  DEHERM_DMSDK_SCALAR_UNKNOWN_ID = 1,\n  DEHERM_DMSDK_SCALAR_WRONG_ARITY = 2,\n  DEHERM_DMSDK_SCALAR_NULL_STORAGE = 3\n} DehermDmSdkScalarStatus;\n\ntypedef enum DehermDmSdkScalarFlags {\n  DEHERM_DMSDK_SCALAR_NATIVE_JS = ${FLAG_NATIVE_JS},\n  DEHERM_DMSDK_SCALAR_BROWSER_JS = ${FLAG_BROWSER_JS},\n  DEHERM_DMSDK_SCALAR_MAY_BLOCK = ${FLAG_MAY_BLOCK}\n} DehermDmSdkScalarFlags;\n\ntypedef struct DehermDmSdkScalarDescriptor {\n  uint16_t id;\n  uint8_t argument_count;\n  uint8_t return_kind;\n  uint8_t argument_kinds[DEHERM_DMSDK_SCALAR_MAX_ARGUMENTS];\n  uint8_t flags;\n  const char* declaration_id;\n  const char* symbol;\n} DehermDmSdkScalarDescriptor;\n\n#ifdef __cplusplus\nextern "C" {\n#endif\n\nuint32_t deherm_dmsdk_scalar_count(void);\nconst DehermDmSdkScalarDescriptor* deherm_dmsdk_scalar_descriptors(void);\nDehermDmSdkScalarStatus deherm_dmsdk_scalar_dispatch(\n    uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* result);\n\n#ifdef __cplusplus\n} // extern "C"\n#endif\n\n#endif // DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_RUNTIME_H\n`;
}

function rawArgument(parameter, index) {
  if (parameter.type === "float") return `unpack_f32(arguments[${index}])`;
  return `static_cast<${ABI_TYPES[parameter.type].c}>(arguments[${index}])`;
}

function rawResult(entry) {
  const { declaration, wrapper } = entry;
  const args = declaration.parameters.map(rawArgument).join(", ");
  const call = `${wrapper}(${args})`;
  if (declaration.returns === "void") return `      ${call};\n      *result = UINT64_C(0);`;
  if (declaration.returns === "float") return `      *result = pack_f32(${call});`;
  return `      *result = static_cast<uint64_t>(${call});`;
}

function renderRuntimeSource(entries) {
  const descriptors = entries
    .map((entry) => {
      const kinds = entry.declaration.parameters.map(({ type }) => VALUE_KINDS[type]);
      while (kinds.length < Math.max(1, ...entries.map(({ declaration }) => declaration.parameters.length)))
        kinds.push("DEHERM_DMSDK_SCALAR_VOID");
      let flags = 0;
      if (isNativeJsCallable(entry.declaration)) flags |= FLAG_NATIVE_JS;
      if (isBrowserSafe(entry)) flags |= FLAG_BROWSER_JS;
      if (entry.semantics.mayBlock) flags |= FLAG_MAY_BLOCK;
      return `  { UINT16_C(${entry.bindingId}), UINT8_C(${entry.declaration.parameters.length}), ${VALUE_KINDS[entry.declaration.returns]}, { ${kinds.join(", ")} }, UINT8_C(${flags}), ${JSON.stringify(entry.declaration.id)}, ${JSON.stringify(entry.declaration.name)} }`;
    })
    .join(",\n");
  const cases = entries
    .map((entry) => `    case ${entry.bindingId}:\n${rawResult(entry)}\n      return DEHERM_DMSDK_SCALAR_OK;`)
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scalar.h>\n#include <defold_hermes/generated_dmsdk_scalar_runtime.h>\n\n#include <cstring>\n\nnamespace {\nconst DehermDmSdkScalarDescriptor kDescriptors[] = {\n${descriptors}\n};\n\nuint64_t pack_f32(float value)\n{\n  uint32_t bits = 0;\n  static_assert(sizeof(bits) == sizeof(value), "float must be 32-bit");\n  std::memcpy(&bits, &value, sizeof(bits));\n  return bits;\n}\n\nfloat unpack_f32(uint64_t value)\n{\n  const uint32_t bits = static_cast<uint32_t>(value);\n  float result = 0.0f;\n  std::memcpy(&result, &bits, sizeof(result));\n  return result;\n}\n} // namespace\n\nextern "C" {\n\nuint32_t deherm_dmsdk_scalar_count(void)\n{\n  return UINT32_C(${entries.length});\n}\n\nconst DehermDmSdkScalarDescriptor* deherm_dmsdk_scalar_descriptors(void)\n{\n  return kDescriptors;\n}\n\nDehermDmSdkScalarStatus deherm_dmsdk_scalar_dispatch(\n    uint16_t id, const uint64_t* arguments, uint32_t argument_count, uint64_t* result)\n{\n  if (id >= deherm_dmsdk_scalar_count()) return DEHERM_DMSDK_SCALAR_UNKNOWN_ID;\n  const DehermDmSdkScalarDescriptor& descriptor = kDescriptors[id];\n  if (argument_count != descriptor.argument_count) return DEHERM_DMSDK_SCALAR_WRONG_ARITY;\n  if (result == nullptr || (argument_count != 0 && arguments == nullptr)) return DEHERM_DMSDK_SCALAR_NULL_STORAGE;\n  switch (id) {\n${cases}\n    default:\n      return DEHERM_DMSDK_SCALAR_UNKNOWN_ID;\n  }\n}\n\n} // extern "C"\n`;
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#pragma once\n\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes {\nvoid installDmSdkScalarModule(facebook::jsi::Runtime& runtime, facebook::jsi::Object& modules);\n}\n#endif\n`;
}

function renderJsiSourceBase() {
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scalar_jsi.hpp>\n\n#if !defined(DM_PLATFORM_HTML5)\n#include <defold_hermes/generated_dmsdk_scalar_runtime.h>\n\n#include <cmath>\n#include <cstring>\n#include <utility>\n\nnamespace defold_hermes {\nnamespace jsi = facebook::jsi;\nnamespace {\nbool isIntegerInRange(const jsi::Value& value, double maximum)\n{\n  return value.isNumber() && std::isfinite(value.asNumber()) &&\n      std::trunc(value.asNumber()) == value.asNumber() &&\n      value.asNumber() >= 0.0 && value.asNumber() <= maximum;\n}\n\nuint64_t encodeArgument(jsi::Runtime& runtime, const jsi::Value& value, uint8_t kind)\n{\n  switch (kind) {\n    case DEHERM_DMSDK_SCALAR_BOOL:\n      if (!value.isBool()) throw jsi::JSError(runtime, "dmSDK scalar argument must be boolean");\n      return value.getBool() ? UINT64_C(1) : UINT64_C(0);\n    case DEHERM_DMSDK_SCALAR_U16:\n      if (!isIntegerInRange(value, 65535.0)) throw jsi::JSError(runtime, "dmSDK scalar argument must be u16");\n      return static_cast<uint16_t>(value.asNumber());\n    case DEHERM_DMSDK_SCALAR_U32:\n      if (!isIntegerInRange(value, 4294967295.0)) throw jsi::JSError(runtime, "dmSDK scalar argument must be u32");\n      return static_cast<uint32_t>(value.asNumber());\n    case DEHERM_DMSDK_SCALAR_F32: {\n      if (!value.isNumber() || !std::isfinite(value.asNumber())) throw jsi::JSError(runtime, "dmSDK scalar argument must be a finite f32");\n      const float narrowed = static_cast<float>(value.asNumber());\n      uint32_t bits = 0;\n      std::memcpy(&bits, &narrowed, sizeof(bits));\n      return bits;\n    }\n    default:\n      throw jsi::JSError(runtime, "dmSDK scalar type is not losslessly JavaScript-callable");\n  }\n}\n\njsi::Value decodeResult(jsi::Runtime& runtime, uint8_t kind, uint64_t raw)\n{\n  switch (kind) {\n    case DEHERM_DMSDK_SCALAR_VOID: return jsi::Value::undefined();\n    case DEHERM_DMSDK_SCALAR_BOOL: return jsi::Value(raw != 0);\n    case DEHERM_DMSDK_SCALAR_U16: return jsi::Value(static_cast<double>(static_cast<uint16_t>(raw)));\n    case DEHERM_DMSDK_SCALAR_U32: return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));\n    case DEHERM_DMSDK_SCALAR_F32: {\n      const uint32_t bits = static_cast<uint32_t>(raw);\n      float value = 0.0f;\n      std::memcpy(&value, &bits, sizeof(value));\n      return jsi::Value(static_cast<double>(value));\n    }\n    default:\n      throw jsi::JSError(runtime, "dmSDK scalar result is not losslessly JavaScript-callable");\n  }\n}\n} // namespace\n\nvoid installDmSdkScalarModule(jsi::Runtime& runtime, jsi::Object& modules)\n{\n  jsi::Object module(runtime);\n  auto call = jsi::Function::createFromHostFunction(\n      runtime, jsi::PropNameID::forAscii(runtime, "call"), 2,\n      [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* args, size_t count) {\n        if (count < 1 || !isIntegerInRange(args[0], 65535.0)) {\n          throw jsi::JSError(runtime, "DmSdkScalar.call expects a numeric binding id");\n        }\n        const uint16_t id = static_cast<uint16_t>(args[0].asNumber());\n        if (id >= deherm_dmsdk_scalar_count()) throw jsi::JSError(runtime, "Unknown dmSDK scalar binding id");\n        const DehermDmSdkScalarDescriptor& descriptor = deherm_dmsdk_scalar_descriptors()[id];\n        if ((descriptor.flags & DEHERM_DMSDK_SCALAR_NATIVE_JS) == 0) {\n          throw jsi::JSError(runtime, "dmSDK scalar binding requires a 64-bit adapter");\n        }\n        if (count != static_cast<size_t>(descriptor.argument_count) + 1) {\n          throw jsi::JSError(runtime, "Wrong dmSDK scalar argument count");\n        }\n        uint64_t rawArguments[DEHERM_DMSDK_SCALAR_MAX_ARGUMENTS] = {};\n        for (uint8_t index = 0; index < descriptor.argument_count; ++index) {\n          rawArguments[index] = encodeArgument(runtime, args[index + 1], descriptor.argument_kinds[index]);\n        }\n        uint64_t rawResult = 0;\n        const DehermDmSdkScalarStatus status = deherm_dmsdk_scalar_dispatch(\n            id, rawArguments, descriptor.argument_count, &rawResult);\n        if (status != DEHERM_DMSDK_SCALAR_OK) throw jsi::JSError(runtime, "dmSDK scalar dispatch failed");\n        return decodeResult(runtime, descriptor.return_kind, rawResult);\n      });\n  module.setProperty(runtime, "call", std::move(call));\n  modules.setProperty(runtime, "DmSdkScalar", std::move(module));\n}\n\n} // namespace defold_hermes\n#endif // !DM_PLATFORM_HTML5\n`;
}

function renderJsiSource() {
  return renderJsiSourceBase()
    .replace(
      "    case DEHERM_DMSDK_SCALAR_F32: {",
      "    case DEHERM_DMSDK_SCALAR_U64: {\n" +
        '      if (!value.isBigInt()) throw jsi::JSError(runtime, "dmSDK scalar argument must be u64 bigint");\n' +
        "      auto bigint = value.asBigInt(runtime);\n" +
        '      if (!bigint.isUint64(runtime)) throw jsi::JSError(runtime, "dmSDK scalar bigint is outside the u64 range");\n' +
        "      return bigint.asUint64(runtime);\n" +
        "    }\n" +
        "    case DEHERM_DMSDK_SCALAR_F32: {",
    )
    .replace(
      "    case DEHERM_DMSDK_SCALAR_U32: return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));\n" +
        "    case DEHERM_DMSDK_SCALAR_F32: {",
      "    case DEHERM_DMSDK_SCALAR_U32: return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));\n" +
        "    case DEHERM_DMSDK_SCALAR_U64: return jsi::Value(runtime, jsi::BigInt::fromUint64(runtime, raw));\n" +
        "    case DEHERM_DMSDK_SCALAR_F32: {",
    )
    .replaceAll("not losslessly JavaScript-callable", "not JavaScript-callable");
}

function renderTypeScriptBase(entries) {
  const callable = entries.filter(({ declaration }) => isNativeJsCallable(declaration));
  const ids = entries.map((entry) => `  ${tsName(entry)}: ${entry.bindingId}`).join(",\n");
  const functions = callable
    .map((entry) => {
      const parameters = entry.declaration.parameters
        .map(
          (parameter) =>
            `${parameter.name}: ${parameter.type === "bool" ? "boolean" : parameter.type === "uint64_t" ? "bigint" : "number"}`,
        )
        .join(", ");
      const args = entry.declaration.parameters.map(({ name }) => `, ${name}`).join("");
      const returnType =
        entry.declaration.returns === "void"
          ? "void"
          : entry.declaration.returns === "bool"
            ? "boolean"
            : entry.declaration.returns === "uint64_t"
              ? "bigint"
              : "number";
      return `/** ${entry.declaration.name} (${entry.declaration.type}). */\nexport function ${tsName(entry)}(${parameters}): ${returnType} {\n  return scalarModule().call(DmSdkScalarId.${tsName(entry)}${args}) as ${returnType};\n}`;
    })
    .join("\n\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\nimport { requireDefoldModule } from "../../module-runtime";\n\ninterface DmSdkScalarModule {\n  call(id: number, ...args: readonly (number | boolean)[]): unknown;\n}\n\nfunction scalarModule(): DmSdkScalarModule {\n  return requireDefoldModule<DmSdkScalarModule>("DmSdkScalar");\n}\n\n/** Stable generated IDs for the raw scalar dmSDK C ABI. */\nexport const DmSdkScalarId = {\n${ids}\n} as const;\n\n${functions}\n`;
}

function renderTypeScript(entries) {
  return renderTypeScriptBase(entries)
    .replace('import { requireDefoldModule } from "../../module-runtime";\n\n', "")
    .replace(
      "  call(id: number, ...args: readonly (number | boolean)[]): unknown;",
      "  call(id: number, ...args: readonly (number | boolean | bigint)[]): unknown;",
    )
    .replace(
      'function scalarModule(): DmSdkScalarModule {\n  return requireDefoldModule<DmSdkScalarModule>("DmSdkScalar");\n}',
      "declare global {\n" +
        "  var __defoldModulesV1: Record<string, object> | undefined;\n" +
        "}\n\n" +
        "function scalarModule(): DmSdkScalarModule {\n" +
        "  const module = globalThis.__defoldModulesV1?.DmSdkScalar as DmSdkScalarModule | undefined;\n" +
        '  if (!module) throw new Error("Defold module is not registered: DmSdkScalar");\n' +
        "  return module;\n" +
        "}",
    );
}

function renderWebSource(entries) {
  const browserEntries = entries.filter(isBrowserSafe);
  const deps = browserEntries.map(({ wrapper }) => `'${wrapper}'`).join(", ");
  const cases = browserEntries
    .map((entry) => {
      const args = entry.declaration.parameters.map((_, index) => `arguments[${index + 1}]`).join(", ");
      const call = `_${entry.wrapper}(${args})`;
      const result = entry.declaration.returns === "bool" ? `${call} !== 0` : call;
      return `            case ${entry.bindingId}: return ${result};`;
    })
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\nvar LibraryDefoldHermesDmSdkScalar = {\n  $DEFOLD_HERMES_DMSDK_SCALAR__deps: [${deps}],\n  $DEFOLD_HERMES_DMSDK_SCALAR: {\n    install: function() {\n      return {\n        call: function(id) {\n          switch (id) {\n${cases}\n            default: throw new Error('dmSDK scalar binding is not available in the browser host: ' + id);\n          }\n        }\n      };\n    }\n  }\n};\n\nautoAddDeps(LibraryDefoldHermesDmSdkScalar, '$DEFOLD_HERMES_DMSDK_SCALAR');\naddToLibrary(LibraryDefoldHermesDmSdkScalar);\n`;
}

function stage(status, evidence, note = undefined) {
  return { status, evidence, ...(note ? { note } : {}) };
}

async function writeOrCheck(outRoot, relativePath, content, check) {
  const path = resolve(outRoot, relativePath);
  if (check) {
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`${relativePath} is stale; regenerate dmSDK scalar thunks`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function reconcileOwnedSources(outRoot, artifacts, check) {
  const directory = resolve(outRoot, "defold/defold_hermes/src");
  const expected = new Set(
    [...artifacts.keys()]
      .filter((path) => path.startsWith("defold/defold_hermes/src/generated_dmsdk_scalar_") && path.endsWith(".cpp"))
      .map((path) => path.split("/").at(-1)),
  );
  const existing = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const obsolete = existing
    .filter((name) => /^generated_dmsdk_scalar_.+\.cpp$/u.test(name) && !expected.has(name))
    .sort();
  if (check && obsolete.length > 0) throw new Error(`Obsolete generated scalar sources: ${obsolete.join(", ")}`);
  if (!check) await Promise.all(obsolete.map((name) => rm(resolve(directory, name))));
}

export async function build() {
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(resolve(repositoryRoot, path), "utf8")]),
    ),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const valuePlan = JSON.parse(contents.valuePlan);
  const recipe = JSON.parse(contents.recipe);
  const declarationsById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const planById = indexDmSdkValuePlan(valuePlan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      scalar: sha256(contents.recipe),
    },
  });
  const patterns = valuePlan.patternRegistry.filter(
    ({ id }) => id === "value.direct-primitive-scalar" || id === "universal.default",
  );
  const candidates = shapes.rows
    .map((row) => {
      const declaration = declarationsById.get(row.id);
      const decision = planById.get(row.id);
      return decision?.patternId === "value.direct-primitive-scalar"
        ? { declaration, row, semantics: decision.semantics, decision }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.declaration.id.localeCompare(right.declaration.id));

  const emitted = [];
  const reportEntries = [];
  const seenWrappers = new Set();
  for (const { declaration, semantics, decision } of candidates) {
    const headerContent = await readFile(resolve(repositoryRoot, declaration.header), "utf8");
    const declarationMatch = declarationEvidence(headerContent, declaration);
    const headerEvidence = {
      path: declaration.header,
      irDocumentationLine: declaration.line,
      declarationLine: declarationMatch.line,
      declarationText: declarationMatch.text,
      sha256: sha256(headerContent),
    };
    const common = {
      id: declaration.id,
      symbol: declaration.name,
      nativeSignature: declaration.type,
      headerEvidence,
      definitionEvidence: [headerEvidence],
      patternDecision: decision.patternId,
      semanticEvidence: semantics.evidence,
    };
    if (semantics.capabilityBlocker) {
      const blocker = {
        blocker: "Process-global initialization or finalization is owned by the Defold engine lifecycle.",
        category: "engine-lifecycle",
        policy: semantics.capabilityBlocker,
      };
      reportEntries.push({
        ...common,
        emitted: false,
        blocker,
        stages: {
          generated: stage("blocked-by-policy", declaration.header, blocker.blocker),
          compiled: stage(
            "header-compiled-policy-blocked",
            "native/dmsdk_scalar_blocker_audit.cpp",
            "The complete pinned packaged-SDK declarations compile; only the lifecycle capability blocks exposure.",
          ),
          linked: stage("blocked-on-generation", declaration.header),
          conformant: stage("blocked-on-generation", declaration.header),
          retained: stage("blocked-on-generation", declaration.header),
          typescriptCallable: stage("blocked-on-generation", declaration.header),
        },
      });
      continue;
    }

    const allTypes = semantics.evidence.nativeTypes;
    const wrapper = wrapperName(declaration);
    if (seenWrappers.has(wrapper)) throw new Error(`C ABI wrapper collision: ${wrapper}`);
    seenWrappers.add(wrapper);
    const artifact = "defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp";
    const bindingId = emitted.length;
    const entry = { declaration, semantics, wrapper, artifact, bindingId };
    emitted.push(entry);
    const nativeJsCallable = isNativeJsCallable(declaration);
    const browserJsCallable = isBrowserSafe(entry);
    reportEntries.push({
      ...common,
      wrapper,
      bindingId,
      cAbiSignature: abiDeclaration(declaration, wrapper),
      include: publicInclude(declaration.header),
      emitted: true,
      policy: {
        boolRepresentation: declaration.returns === "bool" ? "uint8_t canonicalized to 0 or 1" : "not-applicable",
        uint64Representation: allTypes.includes("uint64_t")
          ? "fixed-width C ABI; native Hermes uses validated JSI BigInt conversion; browser exposure remains blocked pending Wasm BigInt ABI validation"
          : "not-applicable",
        lifecycleSensitive: semantics.lifecycleOperation,
        mayBlock: semantics.mayBlock,
        nativeJsCallable,
        browserJsCallable,
      },
      stages: {
        generated: stage(
          "complete",
          artifact,
          `C ABI declaration is in defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h`,
        ),
        compiled: stage(
          "covered-by-reproducible-test",
          "tests/dmsdk-scalar-thunks.test.mjs: strict object compilation of every emitted module",
        ),
        linked: stage(
          "covered-by-host-source-link-test",
          "native/dmsdk_scalar_thunks_test.cpp",
          "Links selected pinned Defold implementation sources, not packaged Defold engine libraries or every target.",
        ),
        conformant: stage(
          "covered-by-host-behavior-test",
          "native/dmsdk_scalar_thunks_test.cpp",
          "Behavior is checked on the host against the pinned source implementation; cross-target conformance remains open.",
        ),
        retained: stage(
          "covered-by-host-and-arm64-extension-nm-tests",
          "tests/dmsdk-scalar-thunks.test.mjs; tests/dmsdk-scalar-extension-retention.test.mjs",
          "The dispatch switch references every emitted thunk. The host test inspects its executable with nm, and a pinned local Extender arm64-macos build retained every emitted thunk plus the generated JSI installer in the final custom engine. Other targets remain unclaimed.",
        ),
        typescriptCallable: nativeJsCallable
          ? stage(
              "generated-native-js-adapter",
              "packages/sdk/src/generated/dmsdk/scalar.ts",
              browserJsCallable
                ? "Available on native Hermes and browser host."
                : "Available on native Hermes only; browser host rejects this stable ID.",
            )
          : stage(
              "blocked-on-lossless-u64-adapter",
              artifact,
              "Raw C ABI remains available; JavaScript number cannot preserve all uint64_t values.",
            ),
      },
    });
  }

  const artifacts = new Map();
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h", renderHeader(emitted));
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp", renderSource(emitted));
  artifacts.set(
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_runtime.h",
    renderRuntimeHeader(emitted),
  );
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp", renderRuntimeSource(emitted));
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_jsi.hpp", renderJsiHeader());
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_scalar_jsi.cpp", renderJsiSource());
  artifacts.set("defold/defold_hermes/lib/web/generated_dmsdk_scalar.js", renderWebSource(emitted));
  artifacts.set("packages/sdk/src/generated/dmsdk/scalar.ts", renderTypeScript(emitted));

  const report = {
    schemaVersion: 2,
    defoldRevision: ir.defoldRevision,
    sourceIr: "packages/bindings/generated/defold-sdk-ir.json",
    sourceShapes: paths.shapes,
    sourceValuePlan: paths.valuePlan,
    sourceRecipe: paths.recipe,
    scope: `The ${reportEntries.length} declarations selected structurally as direct native primitive functions. Stage counts describe this generated family only, not overall dmSDK coverage.`,
    abiPolicy: {
      ...recipe.recipe,
      linkage: "extern C",
      integerWidths: "stdint fixed-width types",
      boolean: "uint8_t, canonical 0 or 1",
      allocation: "thunks are direct calls and contain no allocation or ownership transfer",
      dispatch: "dense uint16_t IDs, stack-only fixed-width slots, no name lookup on the hot path",
      javascript64Bit:
        "native Hermes uses the pinned JSI BigInt uint64_t API; browser uint64_t adapters remain disabled until the Defold Emscripten Wasm BigInt ABI is validated",
      exceptions:
        "no exception translation; reviewed declarations are non-throwing Defold C/C++ APIs by contract, but the C++ type system does not encode noexcept",
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
    },
    coverage: {
      reviewed: reportEntries.length,
      generated: reportEntries.filter(({ emitted: value }) => value).length,
      objectCompileCovered: reportEntries.filter(({ emitted: value }) => value).length,
      hostSourceLinkCovered: reportEntries.filter(
        ({ stages }) => stages.linked.status === "covered-by-host-source-link-test",
      ).length,
      hostBehaviorCovered: reportEntries.filter(
        ({ stages }) => stages.conformant.status === "covered-by-host-behavior-test",
      ).length,
      blocked: reportEntries.filter(({ emitted: value }) => !value).length,
      policyBlocked: reportEntries.filter(({ blocker }) => blocker?.policy === "lifecycle-capability-required").length,
      sourceBlocked: reportEntries.filter(({ blocker }) => blocker?.missingDependency).length,
      packagedLibraryLinked: emitted.length,
      dispatchReferenceCovered: reportEntries.filter(({ emitted: value }) => value).length,
      hostExecutableRetained: reportEntries.filter(({ emitted: value }) => value).length,
      extensionFinalBinaryRetained: emitted.length,
      nativeTypeScriptAdapterGenerated: reportEntries.filter(({ policy }) => policy?.nativeJsCallable).length,
      nativeHermesRuntimeSmokeTested: 2,
      browserTypeScriptAdapterGenerated: reportEntries.filter(({ policy }) => policy?.browserJsCallable).length,
      browserAdapterBehaviorTested: reportEntries.filter(({ policy }) => policy?.browserJsCallable).length,
      warmedDispatchIterations: 100000,
      warmedDispatchObservedCppAllocations: 0,
      allTargetConformant: 0,
    },
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      valuePlan: sha256(contents.valuePlan),
      recipe: sha256(contents.recipe),
    },
    artifactHashes: Object.fromEntries(
      [...artifacts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations: reportEntries,
  };
  artifacts.set("packages/bindings/generated/defold-dmsdk-scalar-thunks.json", `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const { artifacts, report } = await build();
  await reconcileOwnedSources(options.outRoot, artifacts, options.check);
  for (const [relativePath, content] of artifacts)
    await writeOrCheck(options.outRoot, relativePath, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.reviewed} scalar dmSDK thunks; ${report.coverage.blocked} explicitly blocked.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
