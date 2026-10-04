import { hexBindingId } from "./binding-identity.mjs";
import { operationTemplateVocabulary, renderOperation } from "./script-value-binding-operation-templates.mjs";

export const SCRIPT_VALUE_BINDING_RECIPE_FACTS_NAME = "defold-script-value-binding-recipe-facts.json";

const CODECS = Object.freeze([
  "Nil",
  "Boolean",
  "Number",
  "String",
  "Hash",
  "Url",
  "Vector3",
  "Vector4",
  "Quaternion",
  "Matrix4",
  "Table",
  "Node",
  "AddressArray",
]);
const STRUCTURED_LUA_TEMPLATES = new Set([
  "message-post",
  "factory-spawn",
  "game-object-delete",
  "gui-node-lookup",
  "gui-node-text-set",
  "gui-node-setter",
  "current-instance-transform-get",
  "current-instance-transform-set",
]);

function pascal(value) {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has an invalid field set`);
  }
}

export function createScriptValueBindingRecipeFacts(report) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.bindings)) {
    throw new Error("Unsupported script value binding report");
  }
  const operations = [];
  const operationIndexes = new Map();
  const bindings = [];
  const shapeOffsets = [0];
  const shapeCodecIds = [];
  const usedCodecs = new Set();
  let callShapeCount = 0;

  for (const binding of report.bindings) {
    if (
      !binding ||
      typeof binding.id !== "string" ||
      typeof binding.rawName !== "string" ||
      !Number.isInteger(binding.stableId) ||
      binding.stableId < 0 ||
      binding.stableId > 0xffffffff
    ) {
      throw new Error("Script value binding has invalid identity facts");
    }
    if (
      !binding.operation ||
      typeof binding.operation.template !== "string" ||
      !operationTemplateVocabulary.includes(binding.operation.template) ||
      !binding.operation.parameters ||
      typeof binding.operation.parameters !== "object" ||
      Array.isArray(binding.operation.parameters)
    ) {
      throw new Error(`${binding.id}: invalid operation recipe facts`);
    }
    if (!Array.isArray(binding.implementedCallShapes) || binding.implementedCallShapes.length === 0) {
      throw new Error(`${binding.id}: implemented call shapes are required`);
    }
    const operationKey = JSON.stringify(binding.operation);
    let operationIndex = operationIndexes.get(operationKey);
    if (operationIndex === undefined) {
      operationIndex = operations.length;
      operationIndexes.set(operationKey, operationIndex);
      operations.push(binding.operation);
    }
    const browserStatus = binding.targetSupport?.html5BrowserHost?.status;
    if (browserStatus !== "generated-executable" && browserStatus !== "not-executable") {
      throw new Error(`${binding.id}: invalid browser target support fact`);
    }
    if (binding.unhandledShapePolicy !== "error" && binding.unhandledShapePolicy !== "universal-fallback") {
      throw new Error(`${binding.id}: invalid unhandled shape policy fact`);
    }
    if (typeof binding.resultCodec !== "string") throw new Error(`${binding.id}: invalid result codec fact`);
    bindings.push({
      id: binding.id,
      rawName: binding.rawName,
      stableId: binding.stableId,
      operation: operationIndex,
      resultCodec: binding.resultCodec,
      shapeCount: binding.implementedCallShapes.length,
      unhandledShapePolicy: binding.unhandledShapePolicy,
      html5BrowserHost: browserStatus,
    });
    for (const shape of binding.implementedCallShapes) {
      if (!Array.isArray(shape)) throw new Error(`${binding.id}: call shape must be an array`);
      for (const codec of shape) {
        if (!CODECS.includes(codec)) throw new Error(`${binding.id}: unsupported call shape codec ${codec}`);
        usedCodecs.add(codec);
        shapeCodecIds.push(codec);
      }
      shapeOffsets.push(shapeCodecIds.length);
      callShapeCount += 1;
    }
  }

  if (report.bindingCount !== bindings.length || report.callShapeCount !== callShapeCount) {
    throw new Error("Script value binding counts do not match recipe facts");
  }
  const codecVocabulary = CODECS.filter((codec) => usedCodecs.has(codec));
  const codecIndexes = new Map(codecVocabulary.map((codec, index) => [codec, index]));
  return {
    schemaVersion: 1,
    bindingCount: bindings.length,
    callShapeCount,
    codecVocabulary,
    operations,
    bindings,
    shapeOffsets,
    shapeCodecIds: shapeCodecIds.map((codec) => codecIndexes.get(codec)),
  };
}

export function validateScriptValueBindingRecipeFacts(facts) {
  assertExactKeys(
    facts,
    [
      "schemaVersion",
      "bindingCount",
      "callShapeCount",
      "codecVocabulary",
      "operations",
      "bindings",
      "shapeOffsets",
      "shapeCodecIds",
    ],
    "Script value binding recipe",
  );
  if (
    facts.schemaVersion !== 1 ||
    !Number.isInteger(facts.bindingCount) ||
    facts.bindingCount < 0 ||
    !Number.isInteger(facts.callShapeCount) ||
    facts.callShapeCount < 0 ||
    !Array.isArray(facts.codecVocabulary) ||
    facts.codecVocabulary.some(
      (codec, index) => !CODECS.includes(codec) || facts.codecVocabulary.indexOf(codec) !== index,
    ) ||
    !Array.isArray(facts.operations) ||
    !Array.isArray(facts.bindings) ||
    !Array.isArray(facts.shapeOffsets) ||
    !Array.isArray(facts.shapeCodecIds)
  ) {
    throw new Error("Invalid script value binding recipe schema");
  }
  if (
    facts.bindingCount !== facts.bindings.length ||
    facts.shapeOffsets.length !== facts.callShapeCount + 1 ||
    facts.shapeCodecIds.length !== facts.shapeOffsets.at(-1) ||
    facts.shapeOffsets[0] !== 0
  ) {
    throw new Error("Script value binding recipe counts are inconsistent");
  }
  const interned = new Set();
  for (const operation of facts.operations) {
    assertExactKeys(operation, ["template", "parameters"], "Interned script value operation");
    if (
      !operation ||
      typeof operation.template !== "string" ||
      !operationTemplateVocabulary.includes(operation.template) ||
      !operation.parameters ||
      typeof operation.parameters !== "object" ||
      Array.isArray(operation.parameters)
    ) {
      throw new Error("Invalid interned script value operation");
    }
    const key = JSON.stringify(operation);
    if (interned.has(key)) throw new Error("Script value operation intern table contains duplicates");
    interned.add(key);
  }
  let expectedShapeIndex = 0;
  let lastStableId = -1;
  const identities = new Set();
  const referencedOperations = new Set();
  const codecSet = new Set(facts.codecVocabulary);
  for (const [index, binding] of facts.bindings.entries()) {
    assertExactKeys(
      binding,
      [
        "id",
        "rawName",
        "stableId",
        "operation",
        "resultCodec",
        "shapeCount",
        "unhandledShapePolicy",
        "html5BrowserHost",
      ],
      `Script value recipe binding ${index}`,
    );
    if (
      typeof binding.id !== "string" ||
      typeof binding.rawName !== "string" ||
      !Number.isInteger(binding.stableId) ||
      binding.stableId <= lastStableId ||
      binding.stableId > 0xffffffff ||
      !Number.isInteger(binding.operation) ||
      binding.operation < 0 ||
      binding.operation >= facts.operations.length ||
      typeof binding.resultCodec !== "string" ||
      !Number.isInteger(binding.shapeCount) ||
      binding.shapeCount < 1 ||
      (binding.unhandledShapePolicy !== "error" && binding.unhandledShapePolicy !== "universal-fallback") ||
      (binding.html5BrowserHost !== "generated-executable" && binding.html5BrowserHost !== "not-executable")
    ) {
      throw new Error(`Invalid script value recipe binding ${index}`);
    }
    if (identities.has(binding.id)) throw new Error("Script value recipe contains duplicate binding IDs");
    identities.add(binding.id);
    referencedOperations.add(binding.operation);
    lastStableId = binding.stableId;
    for (let shape = 0; shape < binding.shapeCount; ++shape) {
      if (expectedShapeIndex >= facts.callShapeCount) throw new Error("Script value recipe has too few call shapes");
      const start = facts.shapeOffsets[expectedShapeIndex];
      const end = facts.shapeOffsets[expectedShapeIndex + 1];
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start)
        throw new Error("Invalid script value shape offsets");
      for (const codecId of facts.shapeCodecIds.slice(start, end)) {
        if (
          !Number.isInteger(codecId) ||
          codecId < 0 ||
          codecId >= facts.codecVocabulary.length ||
          !codecSet.has(facts.codecVocabulary[codecId])
        )
          throw new Error("Invalid script value shape codec reference");
      }
      expectedShapeIndex += 1;
    }
  }
  if (
    expectedShapeIndex !== facts.callShapeCount ||
    facts.shapeOffsets.some(
      (offset, index) => !Number.isInteger(offset) || (index > 0 && offset < facts.shapeOffsets[index - 1]),
    )
  ) {
    throw new Error("Script value recipe shape table is inconsistent");
  }
  if (referencedOperations.size !== facts.operations.length) {
    throw new Error("Script value operation intern table contains unreferenced entries");
  }
  return facts;
}

export function renderScriptValueBindingOutputs(facts) {
  validateScriptValueBindingRecipeFacts(facts);
  const shapes = [];
  for (let index = 0; index < facts.callShapeCount; ++index) {
    shapes.push(
      facts.shapeCodecIds
        .slice(facts.shapeOffsets[index], facts.shapeOffsets[index + 1])
        .map((codecId) => facts.codecVocabulary[codecId]),
    );
  }
  let shapeIndex = 0;
  const bindings = facts.bindings.map((fact) => {
    const operation = facts.operations[fact.operation];
    const implementedCallShapes = shapes.slice(shapeIndex, shapeIndex + fact.shapeCount);
    shapeIndex += fact.shapeCount;
    return {
      id: fact.id,
      rawName: fact.rawName,
      stableId: fact.stableId,
      operation,
      resultCodec: fact.resultCodec,
      implementedCallShapes,
      unhandledShapePolicy: fact.unhandledShapePolicy,
      targetSupport: { html5BrowserHost: { status: fact.html5BrowserHost } },
    };
  });
  let structuredLuaIndex = 0;
  for (const binding of bindings) {
    if (STRUCTURED_LUA_TEMPLATES.has(binding.operation.template)) {
      Object.defineProperty(binding, "structuredLuaIndex", { value: structuredLuaIndex, enumerable: false });
      structuredLuaIndex += 1;
    }
  }
  const bindingShapeOffsets = [0];
  for (const binding of bindings)
    bindingShapeOffsets.push(bindingShapeOffsets.at(-1) + binding.implementedCallShapes.length);
  const shapeArgumentOffsets = facts.shapeOffsets;
  const argumentCodecs = shapes.flat();
  const bindingAllowsUniversalFallback = bindings.map(
    ({ unhandledShapePolicy }) => unhandledShapePolicy === "universal-fallback",
  );
  const structuredLuaBindings = bindings.filter(({ operation }) => STRUCTURED_LUA_TEMPLATES.has(operation.template));
  const structuredLuaOperations = structuredLuaBindings
    .map((binding, index) => {
      const [module, member] = binding.rawName.split(".");
      const context =
        binding.operation.parameters.context === "active-gui-scene"
          ? "StructuredLuaContext::kGuiScriptInstance"
          : binding.operation.parameters.context === "script-sender-url"
            ? "StructuredLuaContext::kCurrentScriptInstance"
            : "StructuredLuaContext::kScriptInstance";
      const resultCodec =
        binding.operation.parameters.resultPolicy === "hash-or-undefined" ? "HashOrUndefined" : binding.resultCodec;
      return `  {${index}, ${hexBindingId(binding.stableId)}, ${JSON.stringify(binding.id)}, ${JSON.stringify(module)}, ${JSON.stringify(member)}, StructuredLuaResultCodec::k${resultCodec}, ${context}},`;
    })
    .join("\n");
  const bindingIds = bindings
    .map(({ rawName, stableId }) => `  ${pascal(rawName)} = ${hexBindingId(stableId)}`)
    .join(",\n");
  const header = `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::value_binding {\n\nenum class DispatchStatus { kMissing, kSuccess, kError };\nenum class StructuredLuaResultCodec : uint8_t { kNone, kHash, kHashOrUndefined, kNode, kVector3, kQuaternion };\nenum class StructuredLuaContext : uint8_t { kScriptInstance, kGuiScriptInstance, kCurrentScriptInstance };\nstruct StructuredLuaOperation {\n  uint16_t index;\n  uint32_t stableId;\n  const char* canonicalId;\n  const char* module;\n  const char* member;\n  StructuredLuaResultCodec resultCodec;\n  StructuredLuaContext context;\n};\nstruct StructuredLuaApi {\n  void* context = nullptr;\n  DispatchStatus (*invoke)(void* context, const StructuredLuaOperation& operation, ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept = nullptr;\n};\nenum class BindingId : uint32_t {\n${bindingIds}\n};\ninline constexpr size_t kBindingCount = ${facts.bindingCount};\ninline constexpr size_t kCallShapeCount = ${facts.callShapeCount};\ninline constexpr size_t kStructuredLuaOperationCount = ${structuredLuaBindings.length};\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity, const StructuredLuaApi* structuredLua = nullptr) noexcept;\n\n}  // namespace defold_hermes::value_binding\n`;

  const source = `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_script_value_bindings.hpp>\n\n#include <dmsdk/dlib/hash.h>\n#include <dmsdk/dlib/vmath.h>\n\n#include <cmath>\n#include <cstdio>\n#include <cstring>\n#include <limits>\n\nnamespace defold_hermes::value_binding {\nnamespace {\nenum class Codec : uint8_t { kNumber, kString, kHash, kVector3, kVector4, kQuaternion };\nconstexpr uint32_t kStableIds[] = {\n${bindings.map(({ stableId, id }) => `  ${hexBindingId(stableId)},  // ${id}`).join("\n")}\n};\nconstexpr uint16_t kBindingShapeOffsets[] = { ${bindingShapeOffsets.join(", ")} };\nconstexpr uint16_t kShapeArgumentOffsets[] = { ${shapeArgumentOffsets.join(", ")} };\nconstexpr uint8_t kShapeArgumentCounts[] = { ${shapes.map((shape) => shape.length).join(", ")} };\nconstexpr Codec kArgumentCodecs[] = {\n${argumentCodecs.map((codec) => `  Codec::k${codec},`).join("\n")}\n};\n\nbool fail(char* error, size_t capacity, const char* message) noexcept {\n  if (error && capacity) std::snprintf(error, capacity, "%s", message);\n  return false;\n}\n\nbool matches(Codec codec, const ScriptValue& value) noexcept {\n  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;\n  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);\n  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;\n  if (value.tag != ScriptValueTag::kDefoldValue) return false;\n  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;\n  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;\n  return value.defoldKind == ScriptDefoldValueKind::kQuaternion;\n}\n\nsize_t denseIndex(uint32_t stableId) noexcept {\n  for (size_t index = 0; index < kBindingCount; ++index) if (kStableIds[index] == stableId) return index;\n  return kBindingCount;\n}\n\nbool validateShape(size_t binding, const ScriptCallFrame& frame) noexcept {\n  for (size_t shape = kBindingShapeOffsets[binding]; shape < kBindingShapeOffsets[binding + 1]; ++shape) {\n    if (kShapeArgumentCounts[shape] != frame.argumentCount) continue;\n    const size_t offset = kShapeArgumentOffsets[shape];\n    bool valid = true;\n    for (size_t index = 0; index < frame.argumentCount; ++index) valid = valid && matches(kArgumentCodecs[offset + index], frame.arguments[index]);\n    if (valid) return true;\n  }\n  return false;\n}\n\nfloat number(const ScriptValue& value) noexcept {\n  const double number = value.number;\n  if (number > std::numeric_limits<float>::max()) return std::numeric_limits<float>::infinity();\n  if (number < -std::numeric_limits<float>::max()) return -std::numeric_limits<float>::infinity();\n  return static_cast<float>(number);\n}\ndmVMath::Vector3 vector3(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2]}; }\ndmVMath::Vector4 vector4(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]}; }\ndmVMath::Quat quaternion(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]}; }\n\nbool resultCell(ScriptCallFrame* frame, ScriptValue** out, char* error, size_t capacity) noexcept {\n  if (!frame->results || frame->resultCapacity < 1) return fail(error, capacity, "Defold value result storage is exhausted");\n  *out = &frame->results[0];\n  **out = {};\n  frame->resultCount = 1;\n  return true;\n}\n\nbool writeNumber(ScriptCallFrame* frame, double value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kNumber; out->number = value; return true;\n}\nbool writeVector3(ScriptCallFrame* frame, const dmVMath::Vector3& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kVector3;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); return true;\n}\nbool writeVector4(ScriptCallFrame* frame, const dmVMath::Vector4& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kVector4;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); out->defoldValue[3] = value.getW(); return true;\n}\nbool writeQuaternion(ScriptCallFrame* frame, const dmVMath::Quat& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kQuaternion;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); out->defoldValue[3] = value.getW(); return true;\n}\nDispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }\n}  // namespace\n\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept {\n  if (!frame) { fail(error, errorCapacity, "Defold value call frame is null"); return DispatchStatus::kError; }\n  const size_t binding = denseIndex(frame->stableId);\n  if (binding == kBindingCount) return DispatchStatus::kMissing;\n  frame->resultCount = 0;\n  if (frame->argumentCount && !frame->arguments) { fail(error, errorCapacity, "Defold value arguments are null"); return DispatchStatus::kError; }\n  if (!validateShape(binding, *frame)) { fail(error, errorCapacity, "Defold value arguments do not match a generated call shape"); return DispatchStatus::kError; }\n  switch (binding) {\n${bindings.map(renderOperation).join("\n")}\n    default: break;\n  }\n  fail(error, errorCapacity, "Generated Defold value binding has no implementation");\n  return DispatchStatus::kError;\n}\n\n}  // namespace defold_hermes::value_binding\n`;
  const sourceWithStructuredLua = source
    .replace(
      `size_t denseIndex(uint32_t stableId) noexcept {
  for (size_t index = 0; index < kBindingCount; ++index) if (kStableIds[index] == stableId) return index;
  return kBindingCount;
}`,
      `size_t denseIndex(uint32_t stableId) noexcept {
  size_t first = 0;
  size_t count = kBindingCount;
  while (count != 0) {
    const size_t step = count / 2;
    const size_t index = first + step;
    if (kStableIds[index] < stableId) {
      first = index + 1;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first < kBindingCount && kStableIds[first] == stableId ? first : kBindingCount;
}`,
    )
    .replace(
      "dmVMath::Vector3 vector3(const ScriptValue& value) noexcept",
      "bool hasNaN(const ScriptValue& value, size_t count) noexcept { for (size_t index = 0; index < count; ++index) if (std::isnan(value.defoldValue[index])) return true; return false; }\n" +
        "dmVMath::Vector3 vector3(const ScriptValue& value) noexcept",
    )
    .replace(
      "enum class Codec : uint8_t { kNumber, kString, kHash, kVector3, kVector4, kQuaternion };",
      "enum class Codec : uint8_t { kNil, kBoolean, kNumber, kString, kHash, kUrl, kVector3, kVector4, kQuaternion, kMatrix4, kTable, kNode, kAddressArray };",
    )
    .replace(
      "constexpr uint16_t kBindingShapeOffsets[] =",
      `constexpr StructuredLuaOperation kStructuredLuaOperations[] = {\n${structuredLuaOperations}\n};\n` +
        `constexpr bool kBindingAllowsUniversalFallback[] = { ${bindingAllowsUniversalFallback.join(", ")} };\n` +
        "constexpr uint16_t kBindingShapeOffsets[] =",
    )
    .replace(
      `bool matches(Codec codec, const ScriptValue& value) noexcept {
  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;
  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);
  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;
  if (value.tag != ScriptValueTag::kDefoldValue) return false;
  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;
  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;
  return value.defoldKind == ScriptDefoldValueKind::kQuaternion;
}`,
      `bool matches(Codec codec, const ScriptValue& value) noexcept {
  if (codec == Codec::kNil) return value.tag == ScriptValueTag::kUndefined || value.tag == ScriptValueTag::kNull;
  if (codec == Codec::kBoolean) return value.tag == ScriptValueTag::kBoolean;
  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;
  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);
  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;
  if (codec == Codec::kUrl) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kUrl;
  if (codec == Codec::kNode) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kGuiNode;
  if (codec == Codec::kTable) return value.tag == ScriptValueTag::kTable && (value.length == 0 || value.data);
  if (codec == Codec::kAddressArray) return false;
  if (value.tag != ScriptValueTag::kDefoldValue) return false;
  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;
  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;
  if (codec == Codec::kQuaternion) return value.defoldKind == ScriptDefoldValueKind::kQuaternion;
  return value.defoldKind == ScriptDefoldValueKind::kMatrix4;
}`,
    )
    .replace(
      "DispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }",
      `const float* matrix4Elements(ScriptCallFrame* frame, const ScriptValue& value, char* error, size_t capacity) noexcept {
  if (!frame->matrix4Arena) { fail(error, capacity, "Matrix4 frame arena is unavailable"); return nullptr; }
  const float* elements = frame->matrix4Arena->resolve(value);
  if (!elements) { fail(error, capacity, "Matrix4 token is stale or belongs to another frame arena"); return nullptr; }
  for (size_t index = 0; index < 16; ++index) {
    if (std::isnan(elements[index])) { fail(error, capacity, "Matrix4 input rejects NaN components"); return nullptr; }
  }
  return elements;
}
dmVMath::Matrix4 matrix4(ScriptCallFrame* frame, const ScriptValue& value) noexcept {
  const float* e = frame->matrix4Arena->resolve(value);
  return dmVMath::Matrix4(
      dmVMath::Vector4(e[0], e[1], e[2], e[3]), dmVMath::Vector4(e[4], e[5], e[6], e[7]),
      dmVMath::Vector4(e[8], e[9], e[10], e[11]), dmVMath::Vector4(e[12], e[13], e[14], e[15]));
}
bool writeMatrix4(ScriptCallFrame* frame, const dmVMath::Matrix4& value, char* error, size_t capacity) noexcept {
  if (!frame->matrix4Arena) return fail(error, capacity, "Matrix4 frame arena is unavailable");
  if (frame->matrix4Arena->used >= ScriptMatrix4Arena::kCapacity) return fail(error, capacity, "Matrix4 frame arena is exhausted");
  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;
  alignas(16) float elements[16];
  for (size_t column = 0; column < 4; ++column) {
    for (size_t row = 0; row < 4; ++row) elements[column * 4 + row] = value.getElem(column, row);
  }
  if (!frame->matrix4Arena->store(elements, out)) return fail(error, capacity, "Matrix4 frame arena store failed");
  return true;
}
DispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }`,
    )
    .replace(
      "DispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept {",
      "DispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity, const StructuredLuaApi* structuredLua) noexcept {",
    )
    .replace(
      `if (!validateShape(binding, *frame)) { fail(error, errorCapacity, "Defold value arguments do not match a generated call shape"); return DispatchStatus::kError; }`,
      `if (!validateShape(binding, *frame)) {
    if (kBindingAllowsUniversalFallback[binding]) return DispatchStatus::kMissing;
    if (error && errorCapacity) std::snprintf(
        error,
        errorCapacity,
        "Defold value arguments do not match a generated call shape (stable_id=0x%08x, arguments=%u)",
        frame->stableId,
        static_cast<unsigned>(frame->argumentCount));
    return DispatchStatus::kError;
  }`,
    );
  const sourceWithContext = sourceWithStructuredLua.replace(
    "#include <defold_hermes/generated_script_value_bindings.hpp>\n",
    '#include <defold_hermes/generated_script_value_bindings.hpp>\n#include <defold_hermes/active_game_object_context.hpp>\n#include <defold_hermes/script_matrix4_arena.hpp>\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN "DEFOLD_HERMES"\n#endif\n#include <dmsdk/dlib/log.h>\n',
  );

  const browserUnsupported = bindings.filter(
    ({ targetSupport }) => targetSupport.html5BrowserHost.status === "not-executable",
  );
  const targetSupportSource =
    `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n` +
    `export function assertValueRouteTargetSupport(stableId: number, target: string | undefined): void {\n` +
    `  if (target !== "html5-browser-host") return;\n` +
    `  switch (stableId >>> 0) {\n` +
    browserUnsupported
      .map(
        ({ stableId, id }) =>
          `    case ${hexBindingId(stableId).replace(/u$/u, "")}: throw new Error(${JSON.stringify(`${id} is not executable in the HTML5 browser host`)});`,
      )
      .join("\n") +
    `\n    default: return;\n  }\n}\n`;
  return { header, source: sourceWithContext, targetSupportSource };
}
