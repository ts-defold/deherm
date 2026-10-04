/**
 * Package-owned projections for the Lua module declarations shared by the
 * native JSI, Static Hermes, and Web backends.
 *
 * The input is deliberately smaller than modules.json: descriptions and
 * source-document metadata do not affect these ABI adapters. Keeping the
 * renderer on this compact projection makes it usable from a revision policy
 * without shipping the source generator's entire declaration document.
 */

export const GENERATED_MODULE_RECIPE = "output.generated-modules.render.v1";
export const GENERATED_MODULE_FACTS = "defold-generated-module-recipe-facts.json";

const scalarTypes = Object.freeze({
  bool: { c: "uint8_t", sh: "c_u8", ts: "boolean", size: 1, align: 1, heap: "u8" },
  i32: { c: "int32_t", sh: "c_i32", ts: "number", size: 4, align: 4, heap: "i32" },
  u32: { c: "uint32_t", sh: "c_u32", ts: "number", size: 4, align: 4, heap: "u32" },
  f32: { c: "float", sh: "c_f32", ts: "number", size: 4, align: 4, heap: "f32" },
  f64: { c: "double", sh: "c_f64", ts: "number", size: 8, align: 8, heap: "f64" },
  callback: { c: null, sh: null, ts: "(handle: number, elapsed: number) => void", size: 0, align: 1, heap: null },
  void: { c: "void", sh: "void", ts: "void", size: 0, align: 1, heap: null },
});
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snake(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toLowerCase();
}

function symbolFor(module, fn) {
  return fn.symbol ?? `defold_hermes_${snake(module.name)}_${snake(fn.name)}`;
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function cTypeName(name) {
  return `DefoldHermes${name}`;
}

/**
 * Drop prose and declaration-only fields that do not affect these adapters.
 * This is the generator-time projection that policy materialization stores.
 */
export function projectGeneratedModuleFacts(schema) {
  if (!schema || !Array.isArray(schema.modules)) fail("modules", "expected an array");
  if (!Array.isArray(schema.types)) fail("types", "expected an array");
  if (!Number.isInteger(schema.abiVersion) || schema.abiVersion < 1) fail("abiVersion", "expected a positive integer");
  return {
    schemaVersion: 1,
    abiVersion: schema.abiVersion,
    types: schema.types.map((type, typeIndex) => {
      const path = `types[${typeIndex}]`;
      if (typeof type.name !== "string" || !identifier.test(type.name)) fail(`${path}.name`, "expected an identifier");
      if (!Array.isArray(type.fields) || type.fields.length === 0) fail(`${path}.fields`, "expected non-empty fields");
      const fields = type.fields.map((field, fieldIndex) => {
        const fieldPath = `${path}.fields[${fieldIndex}]`;
        const scalar = scalarTypes[field.type];
        if (typeof field.name !== "string" || !identifier.test(field.name)) {
          fail(`${fieldPath}.name`, "expected an identifier");
        }
        if (!scalar?.c || field.type === "void" || field.type === "callback") {
          fail(`${fieldPath}.type`, `unsupported fixed-layout type ${field.type}`);
        }
        return { name: field.name, type: field.type };
      });
      return { name: type.name, fields };
    }),
    modules: schema.modules.map((module, moduleIndex) => {
      const path = `modules[${moduleIndex}]`;
      if (typeof module.name !== "string" || !identifier.test(module.name)) {
        fail(`${path}.name`, "expected an identifier");
      }
      if (!Array.isArray(module.functions)) fail(`${path}.functions`, "expected an array");
      return {
        name: module.name,
        functions: module.functions.map((fn, functionIndex) => {
          const functionPath = `${path}.functions[${functionIndex}]`;
          if (typeof fn.name !== "string" || !identifier.test(fn.name)) {
            fail(`${functionPath}.name`, "expected an identifier");
          }
          const symbol = symbolFor(module, fn);
          if (!identifier.test(symbol)) fail(`${functionPath}.symbol`, "expected an identifier");
          if (!Array.isArray(fn.parameters)) fail(`${functionPath}.parameters`, "expected an array");
          for (const [parameterIndex, parameter] of fn.parameters.entries()) {
            if (typeof parameter.name !== "string" || !identifier.test(parameter.name)) {
              fail(`${functionPath}.parameters[${parameterIndex}].name`, "expected an identifier");
            }
            if (!scalarTypes[parameter.type] || parameter.type === "void") {
              fail(`${functionPath}.parameters[${parameterIndex}].type`, `unsupported type ${parameter.type}`);
            }
          }
          if (!scalarTypes[fn.returns]) fail(`${functionPath}.returns`, `unsupported type ${fn.returns}`);
          return {
            name: fn.name,
            symbol,
            parameters: fn.parameters.map(({ name, type }) => ({ name, type })),
            returns: fn.returns,
            ...(fn.callbackFailureValue === undefined ? {} : { callbackFailureValue: fn.callbackFailureValue }),
          };
        }),
      };
    }),
  };
}

export function validateGeneratedModuleFacts(facts) {
  if (
    !facts ||
    facts.schemaVersion !== 1 ||
    !Number.isInteger(facts.abiVersion) ||
    !Array.isArray(facts.types) ||
    !Array.isArray(facts.modules)
  ) {
    fail("facts", "expected generated-module recipe facts v1");
  }
  const typeNames = new Set();
  for (const [typeIndex, type] of facts.types.entries()) {
    const path = `types[${typeIndex}]`;
    if (typeof type.name !== "string" || !identifier.test(type.name) || typeNames.has(type.name)) {
      fail(`${path}.name`, "expected a unique identifier");
    }
    typeNames.add(type.name);
    if (!Array.isArray(type.fields) || type.fields.length === 0) fail(`${path}.fields`, "expected non-empty fields");
    for (const [fieldIndex, field] of type.fields.entries()) {
      if (
        typeof field.name !== "string" ||
        !identifier.test(field.name) ||
        !scalarTypes[field.type]?.c ||
        field.type === "void" ||
        field.type === "callback"
      ) {
        fail(`${path}.fields[${fieldIndex}]`, "invalid fixed-layout type fact");
      }
    }
  }
  const moduleNames = new Set();
  for (const [moduleIndex, module] of facts.modules.entries()) {
    const path = `modules[${moduleIndex}]`;
    if (typeof module.name !== "string" || !identifier.test(module.name) || moduleNames.has(module.name)) {
      fail(`${path}.name`, "expected a unique identifier");
    }
    moduleNames.add(module.name);
    if (!Array.isArray(module.functions)) fail(`${path}.functions`, "expected an array");
    const functionNames = new Set();
    for (const [functionIndex, fn] of module.functions.entries()) {
      const functionPath = `${path}.functions[${functionIndex}]`;
      if (typeof fn.name !== "string" || !identifier.test(fn.name) || functionNames.has(fn.name)) {
        fail(`${functionPath}.name`, "expected a unique identifier");
      }
      functionNames.add(fn.name);
      if (typeof fn.symbol !== "string" || !identifier.test(fn.symbol)) {
        fail(`${functionPath}.symbol`, "expected an identifier");
      }
      if (!Array.isArray(fn.parameters) || !scalarTypes[fn.returns]) {
        fail(functionPath, "expected parameters and a supported return type");
      }
      const parameterNames = new Set();
      for (const [parameterIndex, parameter] of fn.parameters.entries()) {
        if (
          typeof parameter.name !== "string" ||
          !identifier.test(parameter.name) ||
          parameterNames.has(parameter.name) ||
          !scalarTypes[parameter.type] ||
          parameter.type === "void"
        ) {
          fail(`${functionPath}.parameters[${parameterIndex}]`, "invalid or duplicate parameter");
        }
        parameterNames.add(parameter.name);
      }
      if (
        fn.callbackFailureValue !== undefined &&
        (!Number.isSafeInteger(fn.callbackFailureValue) || fn.callbackFailureValue < 0)
      ) {
        fail(`${functionPath}.callbackFailureValue`, "expected a non-negative safe integer");
      }
    }
  }
  return facts;
}

function deriveTypeLayouts(types) {
  return types.map((type) => {
    let offset = 0;
    let alignment = 1;
    const fields = type.fields.map((field) => {
      const scalar = scalarTypes[field.type];
      offset = alignTo(offset, scalar.align);
      const layout = { ...field, offset, ...scalar };
      offset += scalar.size;
      alignment = Math.max(alignment, scalar.align);
      return layout;
    });
    return { ...type, fields, size: alignTo(offset, alignment), align: alignment };
  });
}

export function renderGeneratedModulesHeader(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  const layouts = deriveTypeLayouts(facts.types);
  const lines = [
    "// Generated by scripts/generate-bindings.mjs. Do not edit.",
    "#ifndef DEFOLD_HERMES_GENERATED_MODULES_H",
    "#define DEFOLD_HERMES_GENERATED_MODULES_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    `#define DEFOLD_HERMES_ABI_VERSION ${facts.abiVersion}`,
    "",
    "#ifdef __cplusplus",
    'extern "C" {',
    "#endif",
    "",
  ];
  for (const type of layouts) {
    lines.push(`typedef struct ${cTypeName(type.name)} {`);
    for (const field of type.fields) lines.push(`  ${scalarTypes[field.type].c} ${field.name};`);
    lines.push(`} ${cTypeName(type.name)};`, "");
  }
  for (const module of facts.modules) {
    for (const fn of module.functions) {
      const parameters =
        fn.parameters
          .flatMap((parameter) =>
            parameter.type === "callback"
              ? [
                  `uint32_t ${parameter.name}_runtime`,
                  `uint32_t ${parameter.name}_slot`,
                  `uint32_t ${parameter.name}_generation`,
                  `uint32_t ${parameter.name}_type`,
                ]
              : [`${scalarTypes[parameter.type].c} ${parameter.name}`],
          )
          .join(", ") || "void";
      lines.push(`${scalarTypes[fn.returns].c} ${fn.symbol}(${parameters});`);
    }
  }
  lines.push("", "#ifdef __cplusplus", '}  // extern "C"', "#endif", "");
  for (const type of layouts) {
    const name = cTypeName(type.name);
    lines.push("#if defined(__cplusplus)");
    lines.push(`static_assert(sizeof(${name}) == ${type.size}, "${name} ABI size mismatch");`);
    for (const field of type.fields) {
      lines.push(
        `static_assert(offsetof(${name}, ${field.name}) == ${field.offset}, "${name}.${field.name} ABI offset mismatch");`,
      );
    }
    lines.push("#else");
    lines.push(`_Static_assert(sizeof(${name}) == ${type.size}, "${name} ABI size mismatch");`);
    for (const field of type.fields) {
      lines.push(
        `_Static_assert(offsetof(${name}, ${field.name}) == ${field.offset}, "${name}.${field.name} ABI offset mismatch");`,
      );
    }
    lines.push("#endif", "");
  }
  lines.push("#endif  // DEFOLD_HERMES_GENERATED_MODULES_H", "");
  return lines.join("\n");
}

export function renderGeneratedAbiLayouts(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  const layouts = deriveTypeLayouts(facts.types);
  const imports = layouts.map((type) => type.name).join(", ");
  const lines = [
    "// Generated by scripts/generate-bindings.mjs. Do not edit.",
    ...(imports ? [`import type { ${imports} } from "../../../sdk/src/generated/modules";`, ""] : []),
    "export interface DefoldAbiMemory {",
    "  readonly u8: Uint8Array;",
    "  readonly i32: Int32Array;",
    "  readonly u32: Uint32Array;",
    "  readonly f32: Float32Array;",
    "  readonly f64: Float64Array;",
    "}",
    "",
    "export function createDefoldAbiMemory(buffer: ArrayBuffer): DefoldAbiMemory {",
    "  return {",
    "    u8: new Uint8Array(buffer),",
    "    i32: new Int32Array(buffer),",
    "    u32: new Uint32Array(buffer),",
    "    f32: new Float32Array(buffer),",
    "    f64: new Float64Array(buffer)",
    "  };",
    "}",
    "",
    `export const DEFOLD_ABI_LAYOUT_VERSION = ${facts.abiVersion} as const;`,
    "",
  ];
  for (const type of layouts) {
    lines.push(`export const ${type.name}Layout = {`);
    lines.push(`  size: ${type.size},`);
    lines.push(`  align: ${type.align},`);
    lines.push("  fields: {");
    for (const field of type.fields)
      lines.push(`    ${field.name}: { offset: ${field.offset}, type: "${field.type}" },`);
    lines.push("  },");
    lines.push(
      `  read(memory: DefoldAbiMemory, pointer: number, out: ${type.name} = {} as ${type.name}): ${type.name} {`,
    );
    for (const field of type.fields) {
      const scalar = scalarTypes[field.type];
      const index =
        scalar.size === 1 ? `pointer + ${field.offset}` : `(pointer + ${field.offset}) >>> ${Math.log2(scalar.size)}`;
      const expression = `memory.${scalar.heap}[${index}]`;
      lines.push(`    out.${field.name} = ${field.type === "bool" ? `${expression} !== 0` : expression};`);
    }
    lines.push("    return out;", "  },");
    lines.push(`  write(memory: DefoldAbiMemory, pointer: number, value: ${type.name}): void {`);
    for (const field of type.fields) {
      const scalar = scalarTypes[field.type];
      const index =
        scalar.size === 1 ? `pointer + ${field.offset}` : `(pointer + ${field.offset}) >>> ${Math.log2(scalar.size)}`;
      const value = field.type === "bool" ? `value.${field.name} ? 1 : 0` : `value.${field.name}`;
      lines.push(`    memory.${scalar.heap}[${index}] = ${value};`);
    }
    lines.push("  }", "} as const;", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function jsiValidation(parameter, index) {
  const at = `args[${index}]`;
  switch (parameter.type) {
    case "bool":
      return `${at}.isBool()`;
    case "i32":
      return `${at}.isNumber() && isI32(${at}.asNumber())`;
    case "u32":
      return `${at}.isNumber() && isU32(${at}.asNumber())`;
    case "f32":
    case "f64":
      return `${at}.isNumber()`;
    case "callback":
      return `${at}.isObject() && ${at}.asObject(runtime).isFunction(runtime)`;
    default:
      fail("parameter.type", `unhandled JSI type ${parameter.type}`);
  }
}

function jsiArgument(parameter, index) {
  const at = `args[${index}]`;
  switch (parameter.type) {
    case "bool":
      return `${at}.getBool() ? 1 : 0`;
    case "i32":
      return `static_cast<int32_t>(${at}.asNumber())`;
    case "u32":
      return `static_cast<uint32_t>(${at}.asNumber())`;
    case "f32":
      return `static_cast<float>(${at}.asNumber())`;
    case "f64":
      return `${at}.asNumber()`;
    default:
      fail("parameter.type", `unhandled JSI argument type ${parameter.type}`);
  }
}

function jsiArguments(parameter, index) {
  if (parameter.type !== "callback") return [jsiArgument(parameter, index)];
  const local = `${parameter.name}_handle`;
  return [`${local}.runtime`, `${local}.slot`, `${local}.generation`, `${local}.type`];
}

function jsiReturn(type, invocation) {
  if (type === "void") return `${invocation};\n        return jsi::Value::undefined();`;
  if (type === "bool") return `const auto result = ${invocation};\n        return jsi::Value(result != 0);`;
  return `const auto result = ${invocation};\n        return jsi::Value(static_cast<double>(result));`;
}

export function renderGeneratedJsiHeader() {
  return `// Generated by scripts/generate-bindings.mjs. Do not edit.\n#pragma once\n\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\n\nnamespace defold_hermes {\nclass CallbackRegistry;\nvoid installGeneratedModules(facebook::jsi::Runtime& runtime, facebook::jsi::Object& modules, CallbackRegistry& callbacks);\n}\n#endif\n`;
}

export function renderGeneratedJsiSource(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  const lines = [
    "// Generated by scripts/generate-bindings.mjs. Do not edit.",
    "#include <defold_hermes/generated_jsi.hpp>",
    "",
    "#if !defined(DM_PLATFORM_HTML5)",
    "#include <defold_hermes/callback_registry.hpp>",
    "#include <defold_hermes/generated_dmsdk_borrowed_handle_jsi.hpp>",
    "#include <defold_hermes/generated_dmsdk_enum_value_jsi.hpp>",
    "#include <defold_hermes/generated_dmsdk_scalar_jsi.hpp>",
    "#include <defold_hermes/generated_dmsdk_universal_jsi.hpp>",
    "#include <defold_hermes/generated_modules.h>",
    "",
    "#include <cmath>",
    "#include <cstdint>",
    "#include <utility>",
    "",
    "namespace defold_hermes {",
    "namespace jsi = facebook::jsi;",
    "namespace {",
    "bool isI32(double value) {",
    "  return std::isfinite(value) && std::trunc(value) == value &&",
    "      value >= -2147483648.0 && value <= 2147483647.0;",
    "}",
    "bool isU32(double value) {",
    "  return std::isfinite(value) && std::trunc(value) == value &&",
    "      value >= 0.0 && value <= 4294967295.0;",
    "}",
    "}  // namespace",
    "",
    "void installGeneratedModules(jsi::Runtime& runtime, jsi::Object& modules, CallbackRegistry& callbacks) {",
    "  (void)callbacks;",
  ];
  for (const module of facts.modules) {
    lines.push(`  jsi::Object ${snake(module.name)}(runtime);`);
    for (const fn of module.functions) {
      const displayName = `${module.name}.${fn.name}`;
      const local = `${snake(module.name)}_${snake(fn.name)}`;
      lines.push("  auto " + local + " = jsi::Function::createFromHostFunction(");
      lines.push("      runtime,");
      lines.push(`      jsi::PropNameID::forAscii(runtime, "${fn.name}"),`);
      lines.push(`      ${fn.parameters.length},`);
      const hasCallbacks = fn.parameters.some(({ type }) => type === "callback");
      lines.push(`      ${hasCallbacks ? "[&callbacks]" : "[]"}(jsi::Runtime& runtime,`);
      lines.push("         const jsi::Value&,");
      lines.push("         const jsi::Value* args,");
      lines.push("         size_t count) {");
      lines.push(`        if (count != ${fn.parameters.length}) {`);
      lines.push(
        `          throw jsi::JSError(runtime, "${displayName} expects exactly ${fn.parameters.length} argument(s)");`,
      );
      lines.push("        }");
      for (const [index, parameter] of fn.parameters.entries()) {
        lines.push(`        if (!(${jsiValidation(parameter, index)})) {`);
        lines.push(
          `          throw jsi::JSError(runtime, "${displayName}: argument ${index + 1} (${parameter.name}) must be ${parameter.type}");`,
        );
        lines.push("        }");
      }
      const callbacks = fn.parameters
        .map((parameter, index) => ({ parameter, index }))
        .filter(({ parameter }) => parameter.type === "callback");
      for (const [callbackIndex, { parameter, index }] of callbacks.entries()) {
        lines.push(`        auto ${parameter.name}_handle = callbacks.acquire(`);
        lines.push(`            args[${index}].asObject(runtime).asFunction(runtime));`);
        lines.push(`        if (!${parameter.name}_handle) {`);
        for (const { parameter: acquired } of callbacks.slice(0, callbackIndex)) {
          lines.push(`          callbacks.release(${acquired.name}_handle);`);
        }
        lines.push("          throw jsi::JSError(runtime, callbacks.lastError());");
        lines.push("        }");
      }
      const invocationArguments = fn.parameters.flatMap(jsiArguments).join(", ");
      const invocation = `${fn.symbol}(${invocationArguments})`;
      if (hasCallbacks && fn.callbackFailureValue !== undefined) {
        lines.push(`        const auto result = ${invocation};`);
        lines.push(`        if (result == ${fn.callbackFailureValue}) {`);
        for (const parameter of fn.parameters.filter(({ type }) => type === "callback")) {
          lines.push(`          callbacks.release(${parameter.name}_handle);`);
        }
        lines.push(`          throw jsi::JSError(runtime, "${displayName} failed");`);
        lines.push("        }");
        lines.push("        return jsi::Value(static_cast<double>(result));");
      } else {
        lines.push(`        ${jsiReturn(fn.returns, invocation)}`);
      }
      lines.push("      });");
      lines.push(`  ${snake(module.name)}.setProperty(runtime, "${fn.name}", std::move(${local}));`);
    }
    lines.push(`  modules.setProperty(runtime, "${module.name}", std::move(${snake(module.name)}));`, "");
  }
  lines.push(
    "  installDmSdkScalarModule(runtime, modules);",
    "  installDmSdkEnumValueModule(runtime, modules);",
    "  installDmSdkBorrowedHandleModule(runtime, modules);",
    "  installDmSdkUniversalModule(runtime, modules);",
    "}",
    "",
    "}  // namespace defold_hermes",
    "",
    "#endif  // !DM_PLATFORM_HTML5",
    "",
  );
  return lines.join("\n");
}

export function renderGeneratedStaticHermesFfi(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  const lines = [
    "// Generated by scripts/generate-bindings.mjs. Do not edit.",
    '"use strict";',
    "",
    "// Raw, allocation-free C ABI imports for Static Hermes typed code.",
    "// Higher-level string, span, and struct codecs are generated separately.",
    "",
  ];
  for (const module of facts.modules) {
    for (const fn of module.functions) {
      const parameters = fn.parameters
        .flatMap((parameter) =>
          parameter.type === "callback"
            ? [
                `${parameter.name}_runtime: c_u32`,
                `${parameter.name}_slot: c_u32`,
                `${parameter.name}_generation: c_u32`,
                `${parameter.name}_type: c_u32`,
              ]
            : [`${parameter.name}: ${scalarTypes[parameter.type].sh}`],
        )
        .join(", ");
      lines.push(`const __ffi_${module.name}_${fn.name} = $SHBuiltin.extern_c(`);
      lines.push('  {include: "defold_hermes/generated_modules.h"},');
      lines.push(`  function ${fn.symbol}(${parameters}): ${scalarTypes[fn.returns].sh} { throw 0; }`);
      lines.push(");", "");
    }
  }
  return lines.join("\n");
}

export function renderGeneratedWebModules(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  const symbols = facts.modules.flatMap((module) => module.functions.map(({ symbol }) => `'${symbol}'`));
  const lines = [
    "// Generated by scripts/generate-bindings.mjs. Do not edit.",
    "var LibraryDefoldHermesGeneratedModules = {",
    `  $DEFOLD_HERMES_GENERATED_MODULES__deps: [${[
      ...symbols,
      "'$DEFOLD_HERMES_DMSDK_SCALAR'",
      "'$DEFOLD_HERMES_DMSDK_UNIVERSAL'",
      ...(facts.modules.some((module) =>
        module.functions.some((fn) => fn.parameters.some(({ type }) => type === "callback")),
      )
        ? ["'$DEFOLD_HERMES_WEB_CALLBACKS'"]
        : []),
    ].join(", ")}],`,
    "  $DEFOLD_HERMES_GENERATED_MODULES: {",
    "    install: function() {",
    "      return {",
  ];
  for (const module of facts.modules) {
    lines.push(`        ${module.name}: {`);
    for (const [functionIndex, fn] of module.functions.entries()) {
      const parameters = fn.parameters.map(({ name }) => name).join(", ");
      const args = fn.parameters
        .flatMap((parameter) => {
          if (parameter.type === "callback") {
            return [
              `${parameter.name}Handle.runtime`,
              `${parameter.name}Handle.slot`,
              `${parameter.name}Handle.generation`,
              `${parameter.name}Handle.type`,
            ];
          }
          return [parameter.type === "bool" ? `(${parameter.name} ? 1 : 0)` : parameter.name];
        })
        .join(", ");
      lines.push(`          ${fn.name}: function(${parameters}) {`);
      const callbacks = fn.parameters.filter(({ type }) => type === "callback");
      for (const [callbackIndex, parameter] of callbacks.entries()) {
        if (callbackIndex === 0) {
          lines.push(
            `            var ${parameter.name}Handle = DEFOLD_HERMES_WEB_CALLBACKS.acquire(${parameter.name});`,
          );
          continue;
        }
        lines.push(`            var ${parameter.name}Handle;`);
        lines.push("            try {");
        lines.push(`              ${parameter.name}Handle = DEFOLD_HERMES_WEB_CALLBACKS.acquire(${parameter.name});`);
        lines.push("            } catch (error) {");
        for (const acquired of callbacks.slice(0, callbackIndex)) {
          lines.push(`              DEFOLD_HERMES_WEB_CALLBACKS.release(${acquired.name}Handle);`);
        }
        lines.push("              throw error;");
        lines.push("            }");
      }
      const call = `_${fn.symbol}(${args})`;
      if (fn.returns === "void") {
        lines.push(`            ${call};`);
      } else if (callbacks.length > 0 && fn.callbackFailureValue !== undefined) {
        lines.push(`            var result = ${call};`);
        lines.push(`            if (result === ${fn.callbackFailureValue}) {`);
        for (const parameter of callbacks) {
          lines.push(`              DEFOLD_HERMES_WEB_CALLBACKS.release(${parameter.name}Handle);`);
        }
        lines.push(`              throw new Error('${module.name}.${fn.name} failed');`);
        lines.push("            }");
        lines.push(`            return ${fn.returns === "bool" ? "result !== 0" : "result"};`);
      } else {
        lines.push(`            return ${fn.returns === "bool" ? `${call} !== 0` : call};`);
      }
      lines.push(`          }${functionIndex + 1 === module.functions.length ? "" : ","}`);
    }
    lines.push("        },");
  }
  lines.push(
    "        DmSdkScalar: DEFOLD_HERMES_DMSDK_SCALAR.install(),",
    "        DmSdkUniversalRaw: DEFOLD_HERMES_DMSDK_UNIVERSAL",
    "      };",
    "    }",
    "  }",
    "};",
    "",
    "autoAddDeps(LibraryDefoldHermesGeneratedModules, '$DEFOLD_HERMES_GENERATED_MODULES');",
    "addToLibrary(LibraryDefoldHermesGeneratedModules);",
    "",
  );
  return lines.join("\n");
}

export function renderGeneratedModuleOutputs(inputFacts) {
  const facts = validateGeneratedModuleFacts(inputFacts);
  return new Map([
    ["packages/abi/src/generated/layouts.ts", renderGeneratedAbiLayouts(facts)],
    ["defold/defold_hermes/include/defold_hermes/generated_modules.h", renderGeneratedModulesHeader(facts)],
    ["defold/defold_hermes/include/defold_hermes/generated_jsi.hpp", renderGeneratedJsiHeader()],
    ["defold/defold_hermes/src/generated_jsi.cpp", renderGeneratedJsiSource(facts)],
    ["defold/defold_hermes/lib/web/generated_modules.js", renderGeneratedWebModules(facts)],
    ["packages/static-hermes/src/generated/ffi.js", renderGeneratedStaticHermesFfi(facts)],
  ]);
}
