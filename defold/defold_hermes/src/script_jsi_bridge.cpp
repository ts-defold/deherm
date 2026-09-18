#include <defold_hermes/script_jsi_bridge.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>

namespace defold_hermes {
namespace jsi = facebook::jsi;
namespace {

constexpr size_t kMaximumArguments = 6;
constexpr size_t kMaximumResults = 8;
constexpr size_t kMaximumTableEntries = 16;
constexpr size_t kStringScratchCapacity = 64 * 1024;
constexpr size_t kMaximumReentrantDepth = 16;
constexpr const char* kDefoldValueKindProperty = "__dehermValueKind";

struct ScratchSlot {
  std::array<ScriptValue, kMaximumArguments> arguments{};
  std::array<ScriptValue, kMaximumResults> results{};
  std::array<std::string, kMaximumArguments> inputStrings{};
  std::array<std::array<ScriptTableEntry, kMaximumTableEntries>, kMaximumArguments> tableEntries{};
  std::array<std::array<std::string, kMaximumTableEntries * 2>, kMaximumArguments> tableStrings{};
  std::array<char, kStringScratchCapacity> outputStrings{};
  ScriptMatrix4Arena matrix4Arena{};
};

struct Scratch {
  std::array<ScratchSlot, kMaximumReentrantDepth> slots{};
  size_t depth = 0;
};

class ScratchFrame {
 public:
  explicit ScratchFrame(Scratch& scratch) : scratch_(scratch) {
    if (scratch_.depth < scratch_.slots.size()) slot_ = &scratch_.slots[scratch_.depth++];
  }
  ~ScratchFrame() { if (slot_) { slot_->matrix4Arena.rewind(0); --scratch_.depth; } }
  ScratchSlot* get() noexcept { return slot_; }
 private:
  Scratch& scratch_;
  ScratchSlot* slot_ = nullptr;
};

uint32_t stableId(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isNumber()) throw jsi::JSError(runtime, "Defold script stable ID must be a number");
  const double number = value.asNumber();
  if (!std::isfinite(number) || std::trunc(number) != number ||
      number < 0.0 || number > 4294967295.0) {
    throw jsi::JSError(runtime, "Defold script stable ID must be a u32");
  }
  return static_cast<uint32_t>(number);
}

float toFloat32(double value) noexcept {
  if (value > std::numeric_limits<float>::max()) return std::numeric_limits<float>::infinity();
  if (value < -std::numeric_limits<float>::max()) return -std::numeric_limits<float>::infinity();
  return static_cast<float>(value);
}

class ScriptHandleHostObject final : public jsi::HostObject {
 public:
  ScriptHandleHostObject(ScriptHandleKind kind, uint32_t runtime, uint64_t payload) noexcept
      : kind_(kind), runtime_(runtime), payload_(payload) {}

  ~ScriptHandleHostObject() override {
    releaseScriptHandle(kind_, runtime_, payload_);
  }

  ScriptHandleKind kind() const noexcept { return kind_; }
  uint32_t runtime() const noexcept { return runtime_; }
  uint64_t payload() const noexcept { return payload_; }

 private:
  ScriptHandleKind kind_ = ScriptHandleKind::kNone;
  uint32_t runtime_ = 0;
  uint64_t payload_ = 0;
};

void encodeLeaf(
    jsi::Runtime& runtime,
    const jsi::Value& value,
    ScriptValue& output,
    std::string& string) {
  output = {};
  if (value.isUndefined()) {
    output.tag = ScriptValueTag::kUndefined;
  } else if (value.isNull()) {
    output.tag = ScriptValueTag::kNull;
  } else if (value.isBool()) {
    output.tag = ScriptValueTag::kBoolean;
    output.number = value.getBool() ? 1.0 : 0.0;
  } else if (value.isNumber()) {
    output.tag = ScriptValueTag::kNumber;
    output.number = value.asNumber();
  } else if (value.isBigInt()) {
    auto bigint = value.getBigInt(runtime);
    if (!bigint.isUint64(runtime)) throw jsi::JSError(runtime, "Defold hash must be an unsigned 64-bit bigint");
    output.tag = ScriptValueTag::kHandle;
    output.handleKind = ScriptHandleKind::kHash;
    output.payload = bigint.getUint64(runtime);
  } else if (value.isString()) {
    string = value.getString(runtime).utf8(runtime);
    if (string.size() > UINT32_MAX) throw jsi::JSError(runtime, "Defold script string exceeds ABI size");
    output.tag = ScriptValueTag::kString;
    output.length = static_cast<uint32_t>(string.size());
    output.data = string.data();
  } else if (value.isObject()) {
    auto object = value.asObject(runtime);
    if (object.isHostObject<ScriptHandleHostObject>(runtime)) {
      const auto handle = object.getHostObject<ScriptHandleHostObject>(runtime);
      output.tag = ScriptValueTag::kHandle;
      output.handleKind = handle->kind();
      output.length = handle->runtime();
      output.payload = handle->payload();
      return;
    }
    const auto kindValue = object.getProperty(runtime, kDefoldValueKindProperty);
    if (!kindValue.isString()) throw jsi::JSError(runtime, "Defold value object has no generated kind tag");
    const std::string kind = kindValue.getString(runtime).utf8(runtime);
    if (kind == "vector3") output.defoldKind = ScriptDefoldValueKind::kVector3;
    else if (kind == "vector4") output.defoldKind = ScriptDefoldValueKind::kVector4;
    else if (kind == "quaternion") output.defoldKind = ScriptDefoldValueKind::kQuaternion;
    else throw jsi::JSError(runtime, "Defold value object has an unknown generated kind tag");
    const size_t componentCount = output.defoldKind == ScriptDefoldValueKind::kVector3 ? 3 : 4;
    constexpr const char* names[] = {"x", "y", "z", "w"};
    for (size_t index = 0; index < componentCount; ++index) {
      const auto component = object.getProperty(runtime, names[index]);
      if (!component.isNumber()) throw jsi::JSError(runtime, "Defold value components must be numbers");
      output.defoldValue[index] = toFloat32(component.asNumber());
    }
    output.tag = ScriptValueTag::kDefoldValue;
  } else {
    throw jsi::JSError(
        runtime,
        "Defold script bridge accepts primitives and generated Defold value objects; "
        "handles, tables, and callbacks are not executable yet");
  }
}

void encode(
    jsi::Runtime& runtime,
    const jsi::Value& value,
    ScriptValue& output,
    std::string& string,
    std::array<ScriptTableEntry, kMaximumTableEntries>& tableEntries,
    std::array<std::string, kMaximumTableEntries * 2>& tableStrings,
    ScriptMatrix4Arena& matrix4Arena) {
  if (!value.isObject()) {
    encodeLeaf(runtime, value, output, string);
    return;
  }
  auto object = value.asObject(runtime);
  if (object.isArray(runtime)) {
    auto array = object.asArray(runtime);
    if (array.size(runtime) == 16) {
      alignas(16) float elements[16];
      for (size_t index = 0; index < 16; ++index) {
        const auto component = array.getValueAtIndex(runtime, index);
        if (!component.isNumber()) throw jsi::JSError(runtime, "Matrix4 components must be numbers");
        elements[index] = toFloat32(component.asNumber());
      }
      if (!matrix4Arena.store(elements, &output)) {
        throw jsi::JSError(runtime, "Matrix4 frame arena is exhausted");
      }
      return;
    }
  }
  if (object.isHostObject<ScriptHandleHostObject>(runtime) ||
      object.getProperty(runtime, kDefoldValueKindProperty).isString()) {
    encodeLeaf(runtime, value, output, string);
    return;
  }

  size_t entryCount = 0;
  auto append = [&](const jsi::Value& key, const jsi::Value& item) {
    if (entryCount >= kMaximumTableEntries) {
      throw jsi::JSError(runtime, "Defold script table exceeds the fixed 16-entry bound");
    }
    auto& entry = tableEntries[entryCount];
    encodeLeaf(runtime, key, entry.key, tableStrings[entryCount * 2]);
    encodeLeaf(runtime, item, entry.value, tableStrings[entryCount * 2 + 1]);
    if (entry.key.tag == ScriptValueTag::kNull || entry.key.tag == ScriptValueTag::kUndefined) {
      throw jsi::JSError(runtime, "Defold script table keys cannot be null or undefined");
    }
    ++entryCount;
  };

  const auto mapValue = runtime.global().getProperty(runtime, "Map");
  const bool isMap = mapValue.isObject() && mapValue.asObject(runtime).isFunction(runtime) &&
      object.instanceOf(runtime, mapValue.asObject(runtime).asFunction(runtime));
  if (isMap) {
    auto iteratorValue = object.getPropertyAsFunction(runtime, "entries").callWithThis(runtime, object);
    if (!iteratorValue.isObject()) throw jsi::JSError(runtime, "Map.entries did not return an iterator");
    auto iterator = iteratorValue.asObject(runtime);
    auto next = iterator.getPropertyAsFunction(runtime, "next");
    for (;;) {
      auto stepValue = next.callWithThis(runtime, iterator);
      if (!stepValue.isObject()) throw jsi::JSError(runtime, "Map iterator returned a non-object step");
      auto step = stepValue.asObject(runtime);
      const auto done = step.getProperty(runtime, "done");
      if (!done.isBool()) throw jsi::JSError(runtime, "Map iterator step has no boolean done field");
      if (done.getBool()) break;
      const auto pairValue = step.getProperty(runtime, "value");
      if (!pairValue.isObject() || !pairValue.asObject(runtime).isArray(runtime)) {
        throw jsi::JSError(runtime, "Map iterator step value is not a key/value pair");
      }
      auto pair = pairValue.asObject(runtime).asArray(runtime);
      if (pair.size(runtime) < 2) throw jsi::JSError(runtime, "Map iterator key/value pair is incomplete");
      append(pair.getValueAtIndex(runtime, 0), pair.getValueAtIndex(runtime, 1));
    }
  } else {
    auto names = object.getPropertyNames(runtime);
    const size_t count = names.size(runtime);
    if (count > kMaximumTableEntries) {
      throw jsi::JSError(runtime, "Defold script table exceeds the fixed 16-entry bound");
    }
    for (size_t index = 0; index < count; ++index) {
      const auto key = names.getValueAtIndex(runtime, index);
      append(key, object.getProperty(runtime, key.getString(runtime)));
    }
  }

  output = {};
  output.tag = ScriptValueTag::kTable;
  output.length = static_cast<uint32_t>(entryCount);
  output.data = tableEntries.data();
}

jsi::Value decode(jsi::Runtime& runtime, const ScriptValue& value, const ScriptMatrix4Arena& matrix4Arena) {
  switch (value.tag) {
    case ScriptValueTag::kUndefined: return jsi::Value::undefined();
    case ScriptValueTag::kNull: return jsi::Value(nullptr);
    case ScriptValueTag::kBoolean: return jsi::Value(value.number != 0.0);
    case ScriptValueTag::kNumber: return jsi::Value(value.number);
    case ScriptValueTag::kString:
      return jsi::String::createFromUtf8(
          runtime, static_cast<const uint8_t*>(value.data), value.length);
    case ScriptValueTag::kHandle:
      if (value.handleKind == ScriptHandleKind::kHash) {
        return jsi::Value(runtime, jsi::BigInt::fromUint64(runtime, value.payload));
      }
      if (value.handleKind == ScriptHandleKind::kGuiNode ||
          value.handleKind == ScriptHandleKind::kLuaUserdata) {
        return jsi::Object::createFromHostObject(
            runtime,
            std::make_shared<ScriptHandleHostObject>(
                value.handleKind, value.length, value.payload));
      }
      throw jsi::JSError(runtime, "Defold script bridge returned an unknown handle kind");
    case ScriptValueTag::kDefoldValue: {
      if (value.defoldKind == ScriptDefoldValueKind::kMatrix4) {
        const float* elements = matrix4Arena.resolve(value);
        if (!elements) throw jsi::JSError(runtime, "Defold script bridge returned a stale Matrix4 token");
        jsi::Array matrix(runtime, 16);
        for (size_t index = 0; index < 16; ++index) {
          matrix.setValueAtIndex(runtime, index, static_cast<double>(elements[index]));
        }
        return matrix;
      }
      jsi::Object object(runtime);
      const char* kind = nullptr;
      size_t componentCount = 0;
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) { kind = "vector3"; componentCount = 3; }
      else if (value.defoldKind == ScriptDefoldValueKind::kVector4) { kind = "vector4"; componentCount = 4; }
      else if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) { kind = "quaternion"; componentCount = 4; }
      else throw jsi::JSError(runtime, "Defold script bridge returned an unknown Defold value kind");
      constexpr const char* names[] = {"x", "y", "z", "w"};
      for (size_t index = 0; index < componentCount; ++index) {
        object.setProperty(runtime, names[index], static_cast<double>(value.defoldValue[index]));
      }
      object.setProperty(runtime, kDefoldValueKindProperty, jsi::String::createFromAscii(runtime, kind));
      return object;
    }
    case ScriptValueTag::kCallback:
    case ScriptValueTag::kTable:
      throw jsi::JSError(runtime, "Defold script bridge returned a value tag not implemented by JSI yet");
  }
  throw jsi::JSError(runtime, "Defold script bridge returned an unknown value tag");
}

}  // namespace

void installScriptJsiBridge(jsi::Runtime& runtime) {
  auto scratch = std::make_shared<Scratch>();
  jsi::Object bridge(runtime);
  bridge.setProperty(runtime, "target", jsi::String::createFromAscii(runtime, "native-hermes"));
  auto call = jsi::Function::createFromHostFunction(
      runtime,
      jsi::PropNameID::forAscii(runtime, "call"),
      2,
      [scratch](jsi::Runtime& runtime,
                const jsi::Value&,
                const jsi::Value* args,
                size_t count) -> jsi::Value {
        if (count != 2 || !args[1].isObject() || !args[1].asObject(runtime).isArray(runtime)) {
          throw jsi::JSError(runtime, "Defold script bridge expects call(stableId, argsArray)");
        }
        ScratchFrame scratchFrame(*scratch);
        ScratchSlot* slot = scratchFrame.get();
        if (!slot) throw jsi::JSError(runtime, "Reentrant Defold script call depth exceeds the fixed scratch stack");
        const uint32_t id = stableId(runtime, args[0]);
        auto array = args[1].asObject(runtime).asArray(runtime);
        const size_t argumentCount = array.size(runtime);
        if (argumentCount > kMaximumArguments) {
          throw jsi::JSError(runtime, "Defold script scalar call exceeds generated maximum argument count");
        }
        for (size_t index = 0; index < argumentCount; ++index) {
          encode(
              runtime,
              array.getValueAtIndex(runtime, index),
              slot->arguments[index],
              slot->inputStrings[index],
              slot->tableEntries[index],
              slot->tableStrings[index],
              slot->matrix4Arena);
        }
        ScriptCallFrame frame;
        frame.stableId = id;
        frame.arguments = slot->arguments.data();
        frame.argumentCount = static_cast<uint32_t>(argumentCount);
        frame.results = slot->results.data();
        frame.resultCapacity = static_cast<uint32_t>(slot->results.size());
        frame.stringScratch = slot->outputStrings.data();
        frame.stringScratchCapacity = static_cast<uint32_t>(slot->outputStrings.size());
        frame.matrix4Arena = &slot->matrix4Arena;
        if (!dispatchScriptCall(&frame)) throw jsi::JSError(runtime, scriptBridgeLastError());
        if (frame.resultCount == 0) return jsi::Value::undefined();
        if (frame.resultCount == 1) return decode(runtime, frame.results[0], slot->matrix4Arena);
        jsi::Array results(runtime, frame.resultCount);
        for (size_t index = 0; index < frame.resultCount; ++index) {
          results.setValueAtIndex(runtime, index, decode(runtime, frame.results[index], slot->matrix4Arena));
        }
        return results;
      });
  bridge.setProperty(runtime, "call", std::move(call));
  runtime.global().setProperty(runtime, "__defoldScriptBridgeV1", std::move(bridge));
}

}  // namespace defold_hermes

#endif
