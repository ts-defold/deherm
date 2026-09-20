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
    return cppSymbol(trampoline, `callback trampoline ${parameter.position}`);
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
  const includes = new Set([
    "#include <defold_hermes/generated_dmsdk_universal.h>",
    "#include <memory>",
    "#include <new>",
    "#include <stdint.h>",
    "#include <string.h>",
  ]);
  const wrappers = [];
  const exactWrappers = [];
  const fakeDeclarations = [];
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
      return {
        position: parameter.position,
        slot,
        name: parameter.name,
        direction: parameter.direction,
        resolvedNativeType: nativeType(parameter.shape, parameter.nativeType, usage.typeSubstitutions),
        shape: copy(parameter.shape),
        requirements: copy(parameter.requirements ?? []),
        expression,
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
    const fakeArguments = receiverType
      ? [receiverExpression(receiverType), ...expressions]
      : expressions;
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
      result: {
        resolvedNativeType: resultType,
        shape: copy(effective.abi.resultShape),
        customExpression: usage.resultExpression ?? null,
      },
      requirements: copy(recipe.fallback.requirements),
      productionWrapper: wrapper,
      exactWrapper,
      fakeCallee,
      productionWrapperSha256: sha256(productionWrapperSource),
      exactWrapperSha256: sha256(exactWrapperSource),
      fakeCalleeDeclarationSha256: sha256(fakeDeclarationSource),
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
  const preamble = `${[...includes].sort().join("\n")}\n` +
    "[[maybe_unused]] static int deherm_dmsdk_address_fits(uint64_t value){return sizeof(uintptr_t)>=sizeof(uint64_t)||value<=UINTPTR_MAX;}\n" +
    "[[maybe_unused]] static int64_t deherm_dmsdk_unpack_i64(uint64_t bits){int64_t value;memcpy(&value,&bits,sizeof(value));return value;}\n" +
    "[[maybe_unused]] static double deherm_dmsdk_unpack_f64(uint64_t bits){double value;memcpy(&value,&bits,sizeof(value));return value;}\n";
  const verification = {
    schemaVersion: 1,
    source: "deherm-dmsdk-exact-call-verification",
    evidenceBoundary: "Generated fake callees define the exact-call contract for wrapper selection, precondition checks, decoded native arguments, receiver transport, and result encoding. Evidence exists only when a consumer harness defines, compiles, and executes those callees; the contract does not execute Defold implementation semantics or prove handle/callback ownership lifecycles.",
    catalogSha256,
    provider: { function: exactProviderName, install: exactInstallName },
    vectorCount: verificationVectors.length,
    vectors: verificationVectors,
  };
  verification.manifestSha256 = sha256(canonicalJson(verification));

  return {
    source: "// Generated by @deherm/compiler dmSDK usage materializer. Do not edit.\n" +
      `${preamble}${wrappers.join("\n")}\n${provider}\n`,
    verificationSource:
      "// Generated by @deherm/compiler dmSDK exact-call materializer. Do not edit.\n" +
      `${preamble}${fakeDeclarations.join("\n")}\n${exactWrappers.join("\n")}\n${exactProvider}\n`,
    manifest: Object.freeze(manifest),
    provider: Object.freeze({ function: providerName, install: installName }),
    verification: Object.freeze(verification),
    catalogSha256,
  };
}
