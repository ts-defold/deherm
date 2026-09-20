import { createHash } from "node:crypto";

const signedNames = new Set(["i8", "i16", "i32", "i64", "isize", "word-signed"]);

function identifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} is not a C identifier: ${value}`);
  }
  return value;
}

function cppType(value, label) {
  const text = String(value ?? "").trim();
  if (!text || /[;{}#\n\r]/.test(text)) {
    throw new Error(`${label} is not a safe C++ type: ${value}`);
  }
  return text;
}

function cppSymbol(value, label) {
  const text = String(value ?? "").trim();
  if (!/^(?:::)?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_~][A-Za-z0-9_]*(?:<[^;{}#\n\r]+>)?)*$/.test(text)) {
    throw new Error(`${label} is not a qualified C++ symbol: ${value}`);
  }
  return text;
}

function acknowledgement(usage, name, reason) {
  const value = usage.acknowledgements?.[name];
  if (!value || typeof value.reason !== "string" || !value.reason.trim() ||
      typeof value.evidence !== "string" || !value.evidence.trim()) {
    throw new Error(
      `${usage.declarationId} needs acknowledgements.${name} with non-empty reason and evidence (${reason})`,
    );
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function scalarName(shape) {
  if (shape.kind === "scalar") return shape.name;
  if (shape.kind === "enum") return "i64";
  if (shape.kind === "named" && shape.target) return scalarName(shape.target);
  if (shape.kind === "handle" && shape.representation) return scalarName(shape.representation);
  return null;
}

function nativeType(shape, spelling, substitutions) {
  let result = String(spelling ?? "void");
  for (const [from, to] of Object.entries(substitutions ?? {})) {
    identifier(from, "type substitution name");
    result = result.replace(new RegExp(`\\b${from}\\b`, "g"), cppType(to, `type substitution ${from}`));
  }
  if (["unknown", "type-parameter", "template", "template-record"].includes(shape.kind) &&
      result === spelling) {
    throw new Error(`Native type ${spelling} needs a usage substitution`);
  }
  return cppType(result, "native type");
}

function decodeScalar(name, type, slot) {
  if (name === "bool") return `(arguments[${slot}].payload != 0)`;
  if (["f32", "f64"].includes(name)) {
    return `static_cast<${type}>(deherm_dmsdk_unpack_f64(arguments[${slot}].payload))`;
  }
  if (signedNames.has(name)) {
    return `static_cast<${type}>(deherm_dmsdk_unpack_i64(arguments[${slot}].payload))`;
  }
  return `static_cast<${type}>(arguments[${slot}].payload)`;
}

function decode(parameter, slot, usage) {
  const shape = parameter.shape;
  const type = nativeType(shape, parameter.nativeType, usage.typeSubstitutions);
  const name = scalarName(shape);
  if (name) return decodeScalar(name, type, slot);
  if (shape.kind === "callback") {
    const trampoline = usage.callbackTrampolines?.[parameter.position];
    if (!trampoline) {
      throw new Error(
        `${usage.declarationId} callback parameter ${parameter.position} needs callbackTrampolines.${parameter.position}`,
      );
    }
    return identifier(trampoline, `callback trampoline ${parameter.position}`);
  }
  if (["cstring", "pointer", "opaque"].includes(shape.kind)) {
    return `reinterpret_cast<${type}>(static_cast<uintptr_t>(arguments[${slot}].payload))`;
  }
  if (shape.kind === "reference") {
    const target = type.replace(/\s*&&?\s*$/, "");
    return `*reinterpret_cast<${target}*>(static_cast<uintptr_t>(arguments[${slot}].payload))`;
  }
  if (shape.kind === "handle") {
    return `reinterpret_cast<${type}>(static_cast<uintptr_t>(arguments[${slot}].payload))`;
  }
  throw new Error(`${parameter.name} (${shape.kind}) needs an explicit argumentExpressions entry`);
}

function tagCheck(shape, slot) {
  const tag = `arguments[${slot}].tag`;
  const name = scalarName(shape);
  if (name === "bool") {
    return `${tag} == DEHERM_DMSDK_UNIVERSAL_BOOL && arguments[${slot}].payload <= UINT64_C(1)`;
  }
  if (["f32", "f64"].includes(name)) return `${tag} == DEHERM_DMSDK_UNIVERSAL_F64`;
  if (["i8", "i16", "i32"].includes(name)) {
    const bits = Number(name.slice(1));
    return `${tag} == DEHERM_DMSDK_UNIVERSAL_I64 && ` +
      `deherm_dmsdk_unpack_i64(arguments[${slot}].payload) >= INT${bits}_MIN && ` +
      `deherm_dmsdk_unpack_i64(arguments[${slot}].payload) <= INT${bits}_MAX`;
  }
  if (signedNames.has(name)) return `${tag} == DEHERM_DMSDK_UNIVERSAL_I64`;
  if (["u8", "u16", "u32"].includes(name)) {
    return `${tag} == DEHERM_DMSDK_UNIVERSAL_U64 && ` +
      `arguments[${slot}].payload <= UINT${Number(name.slice(1))}_MAX`;
  }
  if (name) return `${tag} == DEHERM_DMSDK_UNIVERSAL_U64`;
  if (shape.kind === "callback") return `${tag} == DEHERM_DMSDK_UNIVERSAL_CALLBACK`;
  if (["cstring", "pointer", "reference", "handle", "opaque"].includes(shape.kind)) {
    return `${tag} == DEHERM_DMSDK_UNIVERSAL_ADDRESS`;
  }
  return "true";
}

function pointerCheck(parameter, slot, usage) {
  const shape = parameter.shape;
  if (!["cstring", "pointer", "reference", "opaque"].includes(shape.kind) &&
      !(shape.kind === "handle" && !scalarName(shape))) return null;
  const nullable = usage.nullableParameters?.includes(parameter.position);
  const base = nativeType(shape, parameter.nativeType, usage.typeSubstitutions)
    .replace(/\s*&&?\s*$/, "")
    .replace(/\*+\s*$/, "");
  return `${nullable ? "true" : `arguments[${slot}].payload != 0`} && ` +
    `deherm_dmsdk_address_fits(arguments[${slot}].payload) && ` +
    `(arguments[${slot}].payload == 0 || arguments[${slot}].payload % alignof(${base}) == 0)`;
}

function enumCheck(parameter, slot, usage) {
  if (parameter.shape.kind !== "enum") return null;
  const values = usage.enumDomains?.[parameter.position];
  if (!Array.isArray(values) || !values.length || values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(
      `${usage.declarationId} enum parameter ${parameter.position} needs a non-empty safe-integer enumDomains.${parameter.position}`,
    );
  }
  return `(${values.map((value) =>
    `deherm_dmsdk_unpack_i64(arguments[${slot}].payload) == INT64_C(${value})`).join(" || ")})`;
}

function resultBody(recipe, expression, resultType, custom) {
  if (custom) return custom.replaceAll("$result", "result").replaceAll("$value", expression);
  const shape = recipe.abi.resultShape;
  const name = scalarName(shape);
  if (shape.kind === "void") return `${expression};\n  result->tag = DEHERM_DMSDK_UNIVERSAL_VOID;`;
  if (name) {
    if (["f32", "f64"].includes(name)) {
      return `${resultType} value = ${expression};\n` +
        "  const double normalized = static_cast<double>(value); memcpy(&result->payload,&normalized,sizeof(normalized));\n" +
        "  result->tag = DEHERM_DMSDK_UNIVERSAL_F64;";
    }
    if (name === "bool") {
      return `auto value = ${expression}; result->payload = value ? 1 : 0; ` +
        "result->tag = DEHERM_DMSDK_UNIVERSAL_BOOL;";
    }
    const signed = signedNames.has(name);
    return `auto value = ${expression}; result->payload = static_cast<uint64_t>(` +
      `${signed ? "static_cast<int64_t>(value)" : "value"}); result->tag = ` +
      `${signed ? "DEHERM_DMSDK_UNIVERSAL_I64" : "DEHERM_DMSDK_UNIVERSAL_U64"};`;
  }
  if (shape.kind === "reference") {
    return `auto& value = ${expression}; result->payload = ` +
      "static_cast<uint64_t>(reinterpret_cast<uintptr_t>(&value)); " +
      "result->tag = DEHERM_DMSDK_UNIVERSAL_ADDRESS;";
  }
  if (["cstring", "pointer", "handle", "callback", "opaque"].includes(shape.kind)) {
    return `auto value = ${expression}; result->payload = ` +
      "static_cast<uint64_t>(reinterpret_cast<uintptr_t>(value)); " +
      "result->tag = DEHERM_DMSDK_UNIVERSAL_ADDRESS;";
  }
  throw new Error(`${recipe.declarationId} result (${shape.kind}) needs resultExpression`);
}

function receiverExpression(receiverType) {
  return `reinterpret_cast<${receiverType}*>(static_cast<uintptr_t>(arguments[0].payload))`;
}

function invoke(recipe, usage, args, receiverType) {
  const kind = recipe.invocation.kind;
  const symbol = cppSymbol(usage.nativeSymbol ?? recipe.symbol, "nativeSymbol");
  const template = usage.templateArguments?.length
    ? `<${usage.templateArguments.map((value) => cppType(value, "template argument")).join(", ")}>`
    : "";
  if (kind === "direct-function") return `${symbol}(${args.join(", ")})`;
  if (kind === "function-template-specialization") {
    if (!template) throw new Error(`${recipe.declarationId} needs templateArguments`);
    return `${symbol}${template}(${args.join(", ")})`;
  }
  if (!receiverType) throw new Error(`${recipe.declarationId} needs receiverCppType`);
  const receiver = receiverExpression(receiverType);
  if (kind === "member-function") {
    return `${receiver}->${identifier(usage.memberName ?? recipe.invocation.member, "memberName")}(${args.join(", ")})`;
  }
  if (kind === "placement-constructor") return `new (${receiver}) ${receiverType}(${args.join(", ")})`;
  if (kind === "explicit-destructor") return `std::destroy_at(${receiver})`;
  throw new Error(`Unknown invocation kind ${kind}`);
}

function renderWrapper({ wrapper, argumentCount, checks, body }) {
  return `extern "C" DehermDmSdkUniversalStatus ${wrapper}(` +
    "const DehermDmSdkUniversalValue* arguments,uint32_t argument_count," +
    `DehermDmSdkUniversalValue* result){\n` +
    ` if(argument_count != UINT32_C(${argumentCount})) return DEHERM_DMSDK_UNIVERSAL_WRONG_ARITY;\n` +
    " if((argument_count&&!arguments)||!result) return DEHERM_DMSDK_UNIVERSAL_INVALID_STORAGE;" +
    `${checks.length ? `\n if(!(${checks.join(" && ")})) return DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH;` : ""}\n` +
    ` ${body}\n return DEHERM_DMSDK_UNIVERSAL_OK;\n}`;
}

function renderProvider(providerName, installName, manifest, wrapperField) {
  return `static DehermDmSdkUniversalStatus ${providerName}(` +
    "void*,const DehermDmSdkUniversalDescriptor* descriptor," +
    "const DehermDmSdkUniversalValue* arguments,uint32_t argument_count," +
    "DehermDmSdkUniversalValue* result){ if(!descriptor)return DEHERM_DMSDK_UNIVERSAL_PROVIDER_ERROR; " +
    `switch(descriptor->id){\n${manifest.map((entry) =>
      `case UINT32_C(${entry.numericId}): return ${entry[wrapperField]}(arguments,argument_count,result);`).join("\n")}\n` +
    "default:return DEHERM_DMSDK_UNIVERSAL_PROVIDER_ERROR;}}\n" +
    `extern "C" void ${installName}(void){deherm_dmsdk_universal_install_provider(${providerName},nullptr);}`;
}

function verificationReturnType(kind, resultType, receiverType) {
  if (kind === "placement-constructor") return `${receiverType}*`;
  if (kind === "explicit-destructor") return "void";
  return resultType;
}

function renderFakeDeclaration({ fakeCallee, wrapper, kind, receiverType, resultType, parameters }) {
  const aliases = [];
  const returnAlias = `DehermExact_${wrapper}_Return`;
  aliases.push(`using ${returnAlias} = ${verificationReturnType(kind, resultType, receiverType)};`);
  const argumentAliases = [];
  if (receiverType) {
    const receiverAlias = `DehermExact_${wrapper}_Receiver`;
    aliases.push(`using ${receiverAlias} = ${receiverType}*;`);
    argumentAliases.push(receiverAlias);
  }
  for (const [index, parameter] of parameters.entries()) {
    const alias = `DehermExact_${wrapper}_Arg${index}`;
    aliases.push(`using ${alias} = ${parameter.resolvedNativeType};`);
    argumentAliases.push(alias);
  }
  return `${aliases.join("\n")}\nextern "C" ${returnAlias} ${fakeCallee}(${argumentAliases.join(",")});`;
}

function wireTag(shape) {
  const name = scalarName(shape);
  if (name === "bool") return "DEHERM_DMSDK_UNIVERSAL_BOOL";
  if (["f32", "f64"].includes(name)) return "DEHERM_DMSDK_UNIVERSAL_F64";
  if (signedNames.has(name)) return "DEHERM_DMSDK_UNIVERSAL_I64";
  if (name) return "DEHERM_DMSDK_UNIVERSAL_U64";
  if (shape.kind === "callback") return "DEHERM_DMSDK_UNIVERSAL_CALLBACK";
  if (["cstring", "pointer", "reference", "handle", "opaque"].includes(shape.kind)) {
    return "DEHERM_DMSDK_UNIVERSAL_ADDRESS";
  }
  return null;
}

function deterministicScalar(shape, seed, enumValues) {
  const name = scalarName(shape);
  if (shape.kind === "enum") return enumValues[0];
  if (name === "bool") return seed % 2;
  if (["f32", "f64"].includes(name)) return seed + 0.25;
  const unsignedMaximum = { u8: 0xff, u16: 0xffff, u32: 0xffffffff }[name];
  if (unsignedMaximum !== undefined) return seed % (unsignedMaximum + 1);
  const signedMaximum = { i8: 0x7f, i16: 0x7fff, i32: 0x7fffffff }[name];
  if (signedMaximum !== undefined) return -(seed % signedMaximum || 1);
  if (signedNames.has(name)) return -seed;
  return seed;
}

function fixturePlan({ shape, slot, seed, prefix, nativeAlias, enumValues, expression }) {
  const tag = wireTag(shape);
  if (!tag) return null;
  const name = scalarName(shape);
  const cell = { slot, tag: tag.replace("DEHERM_DMSDK_UNIVERSAL_", "").toLowerCase() };
  const setup = [];
  const declarations = [];
  if (name) {
    const value = deterministicScalar(shape, seed, enumValues);
    cell.value = value;
    if (["f32", "f64"].includes(name)) {
      setup.push(`{ const double value = ${Number(value).toFixed(2)}; memcpy(&${prefix}_arguments[${slot}].payload,&value,sizeof(value)); }`);
    } else if (signedNames.has(name)) {
      setup.push(`${prefix}_arguments[${slot}].payload=static_cast<uint64_t>(INT64_C(${value}));`);
    } else {
      setup.push(`${prefix}_arguments[${slot}].payload=UINT64_C(${value});`);
    }
    setup.push(`${prefix}_arguments[${slot}].tag=${tag};`);
  } else if (shape.kind === "cstring") {
    const fixture = `${prefix}_cstring_${slot}`;
    declarations.push(`static const char ${fixture}[]="deherm_exact_${seed}";`);
    setup.push(`${prefix}_arguments[${slot}].payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(${fixture}));`);
    setup.push(`${prefix}_arguments[${slot}].tag=${tag};`);
    cell.fixture = "cstring";
    cell.value = `deherm_exact_${seed}`;
  } else if (shape.kind === "reference") {
    const fixture = `${prefix}_reference_${slot}`;
    declarations.push(`static std::remove_cv_t<std::remove_reference_t<${nativeAlias}>> ${fixture}{};`);
    setup.push(`${prefix}_arguments[${slot}].payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(&${fixture}));`);
    setup.push(`${prefix}_arguments[${slot}].tag=${tag};`);
    cell.fixture = "value-object";
  } else if (shape.kind === "callback") {
    setup.push(`${prefix}_arguments[${slot}].payload=UINT64_C(0);`);
    setup.push(`${prefix}_arguments[${slot}].tag=${tag};`);
    cell.fixture = "fixed-trampoline";
  } else {
    const fixture = `${prefix}_address_${slot}`;
    declarations.push(`static std::max_align_t ${fixture}{};`);
    setup.push(`${prefix}_arguments[${slot}].payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(&${fixture}));`);
    setup.push(`${prefix}_arguments[${slot}].tag=${tag};`);
    cell.fixture = "aligned-address-token";
  }
  const expectedExpression = expression.replaceAll("arguments", `${prefix}_arguments`);
  return { cell, declarations, setup, expectedExpression };
}

function fakeReturnPlan({ shape, seed, prefix, returnAlias, kind, enumValue }) {
  if (kind === "placement-constructor") {
    return { declarations: [], statement: "return receiver;", cell: { tag: "void" } };
  }
  if (kind === "explicit-destructor" || shape.kind === "void") {
    return { declarations: [], statement: "return;", cell: { tag: "void" } };
  }
  const tag = wireTag(shape);
  if (!tag) return null;
  const name = scalarName(shape);
  if (name) {
    if (shape.kind === "enum" && !Number.isSafeInteger(enumValue)) return null;
    const value = deterministicScalar(shape, seed, [enumValue]);
    return {
      declarations: [],
      statement: `return static_cast<${returnAlias}>(${value});`,
      cell: { tag: tag.replace("DEHERM_DMSDK_UNIVERSAL_", "").toLowerCase(), value },
    };
  }
  if (shape.kind === "cstring") {
    const fixture = `${prefix}_return_cstring`;
    return {
      declarations: [`static const char ${fixture}[]="deherm_exact_result_${seed}";`],
      statement: `return ${fixture};`,
      cell: { tag: "address", fixture: "cstring", value: `deherm_exact_result_${seed}` },
      addressExpression: fixture,
    };
  }
  if (shape.kind === "reference") {
    const fixture = `${prefix}_return_reference`;
    return {
      declarations: [`static std::remove_cv_t<std::remove_reference_t<${returnAlias}>> ${fixture}{};`],
      statement: `return ${fixture};`,
      cell: { tag: "address", fixture: "value-object" },
      addressExpression: `&${fixture}`,
    };
  }
  if (shape.kind === "callback") {
    return {
      declarations: [],
      statement: `return static_cast<${returnAlias}>(nullptr);`,
      cell: { tag: "address", value: 0 },
      addressExpression: "nullptr",
    };
  }
  const fixture = `${prefix}_return_address`;
  return {
    declarations: [`static std::max_align_t ${fixture}{};`],
    statement: `return reinterpret_cast<${returnAlias}>(&${fixture});`,
    cell: { tag: "address", fixture: "aligned-address-token" },
    addressExpression: `&${fixture}`,
  };
}

function renderRecordingFake({ fakeCallee, wrapper, kind, receiverType, parameters, plan }) {
  const returnAlias = `DehermExact_${wrapper}_Return`;
  const argumentsList = [];
  const comparisons = [];
  if (receiverType) {
    argumentsList.push(`DehermExact_${wrapper}_Receiver receiver`);
    comparisons.push(`receiver==${plan.prefix}_expected_receiver`);
  }
  for (const [index, parameter] of parameters.entries()) {
    argumentsList.push(`DehermExact_${wrapper}_Arg${index} argument_${index}`);
    const expected = plan.arguments[index + (receiverType ? 1 : 0)].expectedExpression;
    comparisons.push(parameter.shape.kind === "reference"
      ? `&argument_${index}==&(${expected})`
      : `argument_${index}==${expected}`);
  }
  const condition = comparisons.length ? comparisons.join(" && ") : "true";
  return `extern "C" ${returnAlias} ${fakeCallee}(${argumentsList.join(",")}){\n` +
    ` ++${plan.prefix}_calls; if(!(${condition})) ++${plan.prefix}_failures; ${plan.result.statement}\n}`;
}

function expectedResultCheck(plan, result = "result") {
  const cell = plan.result.cell;
  if (cell.tag === "void") return `${result}.tag==DEHERM_DMSDK_UNIVERSAL_VOID`;
  if (cell.tag === "f64") {
    return `${result}.tag==DEHERM_DMSDK_UNIVERSAL_F64 && deherm_dmsdk_unpack_f64(${result}.payload)==${Number(cell.value).toFixed(2)}`;
  }
  if (cell.tag === "i64") {
    return `${result}.tag==DEHERM_DMSDK_UNIVERSAL_I64 && deherm_dmsdk_unpack_i64(${result}.payload)==INT64_C(${cell.value})`;
  }
  if (cell.tag === "u64" || cell.tag === "bool") {
    return `${result}.tag==DEHERM_DMSDK_UNIVERSAL_${cell.tag.toUpperCase()} && ${result}.payload==UINT64_C(${cell.value})`;
  }
  return `${result}.tag==DEHERM_DMSDK_UNIVERSAL_ADDRESS && ${result}.payload==static_cast<uint64_t>(reinterpret_cast<uintptr_t>(${plan.result.addressExpression}))`;
}

export function materializeDmSdkUsages(usages, options = {}) {
  const recipes = options.recipes;
  if (!Array.isArray(recipes) || !recipes.length) {
    throw new Error("dmSDK materializer requires a non-empty recipes catalog");
  }
  const catalogSha256 = options.catalogSha256;
  if (typeof catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(catalogSha256)) {
    throw new Error("dmSDK materializer requires the exact catalogSha256");
  }
  if (recipes.some((recipe, index) => recipe.numericId !== index)) {
    throw new Error("dmSDK recipe catalog numeric ids are not exact dense indices");
  }
  const byId = new Map(recipes.map((recipe) => [recipe.declarationId, recipe]));
  if (byId.size !== recipes.length) {
    throw new Error("dmSDK recipe catalog contains duplicate declaration ids");
  }
  const maxArguments = options.maxArguments ?? Math.max(...recipes.map((recipe) => recipe.abi.argumentCount));
  const providerName = identifier(options.providerName ?? "deherm_dmsdk_generated_provider", "providerName");
  const installName = identifier(options.installName ?? `${providerName}_install`, "installName");
  const exactProviderName = identifier(`${providerName}_exact_verification`, "exact verification providerName");
  const exactInstallName = identifier(`${installName}_exact_verification`, "exact verification installName");
  const exactDriverName = identifier(`${installName}_run_exact_verification`, "exact verification driverName");
  const exactResetName = identifier(`${installName}_reset_exact_observations`, "exact verification resetName");
  const exactCallsName = identifier(`${installName}_exact_call_count`, "exact verification callsName");
  const exactFailuresName = identifier(`${installName}_exact_failure_count`, "exact verification failuresName");
  const includes = new Set([
    "#include <defold_hermes/generated_dmsdk_universal.h>",
    "#include <memory>",
    "#include <new>",
    "#include <stdio.h>",
    "#include <stdint.h>",
    "#include <string.h>",
    "#include <type_traits>",
  ]);
  const wrappers = [];
  const exactWrappers = [];
  const fakeDeclarations = [];
  const recordingFakes = [];
  const verificationPlans = [];
  const callbackDeclarations = new Map();
  const callbackMacros = new Map();
  const manifest = [];
  const verificationVectors = [];
  const ids = new Set();
  const names = new Set();

  for (const usage of usages) {
    const recipe = byId.get(usage.declarationId);
    if (!recipe) throw new Error(`Unknown dmSDK declaration: ${usage.declarationId}`);
    if (recipe.preferredLowering.state === "generated-adapter") {
      acknowledgement(usage, "generatedAdapterBypass", "specialized adapter bypass");
    }
    for (const requirement of recipe.fallback.requirements) {
      if (["callback-trampoline", "record-layout", "native-type-substitution", "typed-nonvariadic-facade"].includes(requirement) ||
          requirement.startsWith("out-storage") || requirement.startsWith("scratch-")) {
        acknowledgement(
          usage,
          requirement.replace(/-([a-z])/g, (_, character) => character.toUpperCase()),
          requirement,
        );
      }
    }

    const wrapper = identifier(
      usage.wrapper ?? `deherm_dmsdk_usage_${recipe.numericId}`,
      "wrapper",
    );
    if (ids.has(recipe.numericId) || names.has(wrapper)) {
      throw new Error(`duplicate dmSDK materialization: ${usage.declarationId}`);
    }
    ids.add(recipe.numericId);
    names.add(wrapper);
    includes.add(`#include <${recipe.include}>`);

    if (usage.parameters && recipe.declarationKind !== "function-template") {
      throw new Error(`${usage.declarationId} may override parameters only for a function-template specialization`);
    }
    const sourceParameters = usage.parameters ?? recipe.abi.parameters;
    sourceParameters.forEach((parameter, index) => {
      if (parameter.position !== index) {
        throw new Error(`${usage.declarationId} parameters must use contiguous positions`);
      }
    });
    const offset = recipe.abi.argumentOffset;
    const invocationConsumesReceiver = [
      "member-function",
      "placement-constructor",
      "explicit-destructor",
    ].includes(recipe.invocation.kind);
    if (Boolean(offset) !== invocationConsumesReceiver) {
      throw new Error(
        `${usage.declarationId} has an inconsistent ${recipe.invocation.kind} argument offset ${offset}`,
      );
    }
    const argumentCount = offset + sourceParameters.length;
    if (argumentCount > maxArguments) {
      throw new Error(`${usage.declarationId} exceeds frame capacity ${maxArguments}`);
    }
    const receiverType = usage.receiverCppType
      ? cppType(usage.receiverCppType, "receiverCppType")
      : undefined;
    if (receiverType && !invocationConsumesReceiver) {
      throw new Error(`${usage.declarationId} may not declare receiverCppType for ${recipe.invocation.kind}`);
    }
    if (offset && !receiverType) {
      throw new Error(`${usage.declarationId} needs receiverCppType`);
    }
    const checks = [];
    if (offset) {
      checks.push(
        "arguments[0].tag == DEHERM_DMSDK_UNIVERSAL_ADDRESS && arguments[0].payload != 0 && " +
        `deherm_dmsdk_address_fits(arguments[0].payload) && arguments[0].payload % alignof(${receiverType}) == 0`,
      );
    }
    const parameters = sourceParameters.map((parameter, index) => {
      const slot = index + offset;
      checks.push(tagCheck(parameter.shape, slot));
      const pointer = pointerCheck(parameter, slot, usage);
      if (pointer) checks.push(pointer);
      const enumeration = enumCheck(parameter, slot, usage);
      if (enumeration) checks.push(enumeration);
      const expression = usage.argumentExpressions?.[index]
        ? usage.argumentExpressions[index]
          .replaceAll("$slot", String(slot))
          .replaceAll("$arguments", "arguments")
        : decode(parameter, slot, usage);
      const resolvedNativeType = nativeType(parameter.shape, parameter.nativeType, usage.typeSubstitutions);
      if (parameter.shape.kind === "callback") {
        const symbol = identifier(
          usage.callbackTrampolines?.[parameter.position],
          `callback trampoline ${parameter.position}`,
        );
        const alias = `DehermCallback_${wrapper}_Arg${index}`;
        const prior = callbackDeclarations.get(symbol);
        if (prior && prior.resolvedNativeType !== resolvedNativeType) {
          throw new Error(`${usage.declarationId} callback trampoline ${symbol} is reused with incompatible native types`);
        }
        callbackDeclarations.set(symbol, { alias, resolvedNativeType });
        callbackMacros.set(symbol, alias);
      }
      return {
        position: parameter.position,
        slot,
        name: parameter.name,
        direction: parameter.direction,
        resolvedNativeType,
        shape: copy(parameter.shape),
        requirements: copy(parameter.requirements ?? []),
        expression,
        exactExpression: expression,
      };
    });
    const expressions = parameters.map(({ expression }) => expression);
    const effective = usage.resultShape
      ? { ...recipe, abi: { ...recipe.abi, resultShape: usage.resultShape } }
      : recipe;
    const resultType = nativeType(
      effective.abi.resultShape,
      usage.resultCppType ?? recipe.abi.resultNativeType,
      usage.typeSubstitutions,
    );
    const productionCall = invoke(recipe, usage, expressions, receiverType);
    const productionBody = resultBody(effective, productionCall, resultType, usage.resultExpression);
    const productionWrapperSource = renderWrapper({
      wrapper,
      argumentCount,
      checks,
      body: productionBody,
    });
    wrappers.push(productionWrapperSource);

    const exactWrapper = identifier(`${wrapper}__exact_call`, "exact verification wrapper");
    const fakeCallee = identifier(`${wrapper}__exact_callee`, "exact verification fake callee");
    const exactExpressions = parameters.map(({ exactExpression }) => exactExpression);
    const fakeArguments = receiverType
      ? [receiverExpression(receiverType), ...exactExpressions]
      : exactExpressions;
    const exactCall = `${fakeCallee}(${fakeArguments.join(", ")})`;
    const exactBody = resultBody(effective, exactCall, resultType, usage.resultExpression);
    const fakeDeclarationSource = renderFakeDeclaration({
      fakeCallee,
      wrapper,
      kind: recipe.invocation.kind,
      receiverType,
      resultType,
      parameters,
    });
    fakeDeclarations.push(fakeDeclarationSource);

    const vectorIndex = verificationPlans.length;
    const prefix = `deherm_exact_vector_${vectorIndex}`;
    const plan = {
      prefix,
      declarations: [
        `static DehermDmSdkUniversalValue ${prefix}_arguments[${Math.max(1, argumentCount)}]{};`,
        `static uint32_t ${prefix}_calls=0;`,
        `static uint32_t ${prefix}_failures=0;`,
      ],
      setup: [
        `memset(${prefix}_arguments,0,sizeof(${prefix}_arguments));`,
      ],
      arguments: [],
    };
    if (receiverType) {
      const fixture = `${prefix}_receiver_storage`;
      plan.declarations.push(`alignas(${receiverType}) static unsigned char ${fixture}[sizeof(${receiverType})]{};`);
      plan.setup.push(`${prefix}_arguments[0].payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(${fixture}));`);
      plan.setup.push(`${prefix}_arguments[0].tag=DEHERM_DMSDK_UNIVERSAL_ADDRESS;`);
      plan.declarations.push(`static ${receiverType}* ${prefix}_expected_receiver=reinterpret_cast<${receiverType}*>(${fixture});`);
      plan.arguments.push({
        cell: { slot: 0, tag: "address", fixture: "aligned-receiver-storage" },
        expectedExpression: `${prefix}_expected_receiver`,
      });
    }
    for (const [index, parameter] of parameters.entries()) {
      const argumentPlan = fixturePlan({
        shape: parameter.shape,
        slot: parameter.slot,
        seed: (recipe.numericId + 1) * 17 + parameter.slot + 1,
        prefix,
        nativeAlias: `DehermExact_${wrapper}_Arg${index}`,
        enumValues: usage.enumDomains?.[parameter.position] ?? [],
        expression: parameter.exactExpression,
      });
      if (!argumentPlan) {
        throw new Error(`${usage.declarationId} exact-call driver cannot derive a wire fixture for ${parameter.name} (${parameter.shape.kind})`);
      }
      plan.declarations.push(...argumentPlan.declarations);
      plan.setup.push(...argumentPlan.setup);
      plan.arguments.push(argumentPlan);
    }
    plan.result = fakeReturnPlan({
      shape: effective.abi.resultShape,
      seed: (recipe.numericId + 1) * 19 + 7001,
      prefix,
      returnAlias: `DehermExact_${wrapper}_Return`,
      kind: recipe.invocation.kind,
      enumValue: usage.resultEnumValue,
    });
    if (!plan.result) {
      const detail = effective.abi.resultShape.kind === "enum" ? "; provide a safe-integer resultEnumValue" : "";
      throw new Error(`${usage.declarationId} exact-call driver cannot derive a fake result for ${effective.abi.resultShape.kind}${detail}`);
    }
    plan.declarations.push(...plan.result.declarations);
    const recordingFakeSource = renderRecordingFake({
      fakeCallee,
      wrapper,
      kind: recipe.invocation.kind,
      receiverType,
      parameters,
      plan,
    });
    recordingFakes.push(recordingFakeSource);
    verificationPlans.push(plan);
    const exactWrapperSource = renderWrapper({
      wrapper: exactWrapper,
      argumentCount,
      checks,
      body: exactBody,
    });
    exactWrappers.push(exactWrapperSource);

    const vector = {
      schemaVersion: 1,
      declarationId: recipe.declarationId,
      numericId: recipe.numericId,
      recipeId: recipe.projectionId,
      nativeSymbol: usage.nativeSymbol ?? recipe.symbol,
      include: recipe.include,
      invocation: {
        kind: recipe.invocation.kind,
        member: usage.memberName ?? recipe.invocation.member ?? null,
        templateArguments: copy(usage.templateArguments ?? []),
      },
      receiver: receiverType
        ? { slot: 0, cppType: receiverType, mode: recipe.invocation.receiver?.mode ?? "object" }
        : null,
      argumentCount,
      preconditions: [...checks],
      parameters,
      wireArguments: plan.arguments.map(({ cell }) => copy(cell)),
      result: {
        resolvedNativeType: resultType,
        shape: copy(effective.abi.resultShape),
        customExpression: usage.resultExpression ?? null,
        fakeReturn: copy(plan.result.cell),
      },
      requirements: copy(recipe.fallback.requirements),
      productionWrapper: wrapper,
      exactWrapper,
      fakeCallee,
      productionWrapperSha256: sha256(productionWrapperSource),
      exactWrapperSha256: sha256(exactWrapperSource),
      fakeCalleeDeclarationSha256: sha256(fakeDeclarationSource),
      fakeCalleeDefinitionSha256: sha256(recordingFakeSource),
      catalogSha256,
    };
    vector.vectorSha256 = sha256(canonicalJson(vector));
    verificationVectors.push(vector);
    manifest.push({
      declarationId: recipe.declarationId,
      numericId: recipe.numericId,
      wrapper,
      exactWrapper,
      fakeCallee,
      verificationVectorSha256: vector.vectorSha256,
      recipeId: recipe.projectionId,
      argumentCount,
      catalogSha256,
    });
  }

  const provider = renderProvider(providerName, installName, manifest, "wrapper");
  const exactProvider = renderProvider(exactProviderName, exactInstallName, manifest, "exactWrapper");
  const callbackDeclarationSource = [...callbackDeclarations.entries()].map(([symbol, { alias, resolvedNativeType }]) =>
    `using ${alias}=${resolvedNativeType}; static_assert(std::is_pointer_v<${alias}>); extern std::remove_pointer_t<${alias}> ${symbol};`
  ).join("\n");
  const callbackMacroSource = [...callbackMacros.entries()].map(([symbol, alias]) =>
    `#define ${symbol} (&DehermExactCallbackFixture<${alias}>::call)`
  ).join("\n");
  const callbackUndefSource = [...callbackMacros.keys()].map((symbol) => `#undef ${symbol}`).join("\n");
  const verificationState = verificationPlans.flatMap((plan) => plan.declarations).join("\n");
  const observationApi =
    `extern "C" void ${exactResetName}(void){${verificationPlans.map((plan) =>
      `${plan.prefix}_calls=0;${plan.prefix}_failures=0;`).join("")}}\n` +
    `extern "C" uint32_t ${exactCallsName}(uint32_t id){switch(id){${verificationPlans.map((plan, index) =>
      `case UINT32_C(${manifest[index].numericId}):return ${plan.prefix}_calls;`).join("")}default:return UINT32_MAX;}}\n` +
    `extern "C" uint32_t ${exactFailuresName}(uint32_t id){switch(id){${verificationPlans.map((plan, index) =>
      `case UINT32_C(${manifest[index].numericId}):return ${plan.prefix}_failures;`).join("")}default:return UINT32_MAX;}}`;
  const exactFailureName = identifier(`${installName}_exact_failure`, "exact verification failureName");
  const exactFailureReporter = `static int ${exactFailureName}(const char* stage,uint32_t vector,uint32_t id){` +
    `fprintf(stderr,"dmSDK exact-call failure: stage=%s vector=%u id=%u\\n",stage,vector,id);return 1;}`;
  const verificationDriver = `extern "C" int ${exactDriverName}(void){\n ${exactInstallName}(); ${exactResetName}();\n` +
    verificationPlans.map((plan, index) => {
      const argumentPointer = manifest[index].argumentCount ? `${plan.prefix}_arguments` : "nullptr";
      const resultName = `${plan.prefix}_result`;
      const id = `UINT32_C(${manifest[index].numericId})`;
      return ` ${plan.setup.join("\n ")}\n DehermDmSdkUniversalValue ${resultName}{};\n` +
        ` if(deherm_dmsdk_universal_dispatch(${id},${argumentPointer},UINT32_C(${manifest[index].argumentCount}),&${resultName})!=DEHERM_DMSDK_UNIVERSAL_OK)return ${exactFailureName}("dispatch",UINT32_C(${index}),${id});\n` +
        ` if(${exactCallsName}(${id})!=UINT32_C(1))return ${exactFailureName}("call-count",UINT32_C(${index}),${id});\n` +
        ` if(${exactFailuresName}(${id})!=UINT32_C(0))return ${exactFailureName}("arguments",UINT32_C(${index}),${id});\n` +
        ` if(!(${expectedResultCheck(plan, resultName)}))return ${exactFailureName}("result",UINT32_C(${index}),${id});`;
    }).join("\n") + "\n return 0;\n}";
  const preamble = `${[...includes].sort().join("\n")}\n` +
    "[[maybe_unused]] static int deherm_dmsdk_address_fits(uint64_t value){return sizeof(uintptr_t)>=sizeof(uint64_t)||value<=UINTPTR_MAX;}\n" +
    "[[maybe_unused]] static int64_t deherm_dmsdk_unpack_i64(uint64_t bits){int64_t value;memcpy(&value,&bits,sizeof(value));return value;}\n" +
    "[[maybe_unused]] static double deherm_dmsdk_unpack_f64(uint64_t bits){double value;memcpy(&value,&bits,sizeof(value));return value;}\n";
  const verification = {
    schemaVersion: 1,
    source: "deherm-dmsdk-exact-call-verification",
    evidenceBoundary: "Generated recording fake callees and the native C-ABI driver execute the exact-call contract for wrapper selection, precondition checks, deterministic wire inputs, decoded native arguments, receiver transport, and fake-result encoding; C-ABI observation accessors expose per-vector call and mismatch counts to other transport runners. This does not execute Defold implementation semantics or prove handle/callback ownership lifecycles.",
    catalogSha256,
    provider: { function: exactProviderName, install: exactInstallName },
    driver: { function: exactDriverName, transport: "native-c-abi", sourceSha256: sha256(verificationDriver) },
    observations: {
      reset: exactResetName,
      calls: exactCallsName,
      failures: exactFailuresName,
      sourceSha256: sha256(observationApi),
    },
    vectorCount: verificationVectors.length,
    vectors: verificationVectors,
  };
  verification.manifestSha256 = sha256(canonicalJson(verification));

  return {
    source: "// Generated by @deherm/compiler dmSDK usage materializer. Do not edit.\n" +
      `${preamble}${callbackDeclarationSource}\n${wrappers.join("\n")}\n${provider}\n`,
    verificationSource:
      "// Generated by @deherm/compiler dmSDK exact-call materializer. Do not edit.\n" +
      `#include <cstddef>\n${preamble}` +
      "template<typename> struct DehermExactCallbackFixture;\n" +
      "template<typename R,typename... A> struct DehermExactCallbackFixture<R(*)(A...)>{" +
      "static R call(A...){if constexpr(!std::is_void_v<R>)return R{};}};\n" +
      `${callbackDeclarationSource}\n${callbackMacroSource}\n` +
      `${fakeDeclarations.join("\n")}\n` +
      `${verificationState}\n${recordingFakes.join("\n")}\n` +
      `${exactWrappers.join("\n")}\n${exactProvider}\n${observationApi}\n${exactFailureReporter}\n${verificationDriver}\n${callbackUndefSource}\n`,
    manifest: Object.freeze(manifest),
    provider: Object.freeze({ function: providerName, install: installName }),
    verification: Object.freeze(verification),
    catalogSha256,
  };
}
