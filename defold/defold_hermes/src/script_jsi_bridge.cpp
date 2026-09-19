#include <defold_hermes/script_jsi_bridge.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/deherm_profile.hpp>
#include <defold_hermes/generated_script_handle_kinds.hpp>
#include <defold_hermes/generated_script_universal_value_bindings.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>
#include <defold_hermes/script_url_arena.hpp>

#if defined(DEHERM_CANONICAL_RELEASE)
#include <deherm_canonical_release.h>
#endif

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace defold_hermes {
namespace jsi = facebook::jsi;

class ScriptJsiBridgeLifetime final {
 public:
  static constexpr size_t kMaximumRoots = 4096;
  using Invalidate = void (*)(void*) noexcept;

  ~ScriptJsiBridgeLifetime() { shutdown(); }

  bool attach(void* root, Invalidate invalidate) noexcept {
    if (!active_ || !root || !invalidate) return false;
    for (auto& slot : slots_) {
      if (slot.root) continue;
      slot = {root, invalidate};
      return true;
    }
    return false;
  }

  void detach(void* root) noexcept {
    if (!root) return;
    for (auto& slot : slots_) {
      if (slot.root != root) continue;
      slot = {};
      return;
    }
  }

  void shutdown() noexcept {
    if (!active_) return;
    active_ = false;
    for (auto& slot : slots_) {
      const Slot owned = slot;
      slot = {};
      if (owned.root) owned.invalidate(owned.root);
    }
  }

  bool active() const noexcept { return active_; }

 private:
  struct Slot {
    void* root = nullptr;
    Invalidate invalidate = nullptr;
  };
  std::array<Slot, kMaximumRoots> slots_{};
  bool active_ = true;
};

namespace {

constexpr size_t kMaximumArguments = universal_value::kMaximumArgumentCount;
constexpr size_t kMaximumResults = 8;
constexpr size_t kMaximumTableEntries = universal_value::kMaximumEntries;
constexpr size_t kMaximumTableDepth = universal_value::kMaximumDepth;
constexpr size_t kMaximumInputStrings = kMaximumArguments + kMaximumTableEntries * 2;
constexpr size_t kStringScratchCapacity = 64 * 1024;
constexpr size_t kMaximumReentrantDepth = 16;
constexpr const char* kDefoldValueKindProperty = "__dehermValueKind";
constexpr const char* kDefoldUrlProperty = "__dehermUrlV1";
constexpr const char* kLuaErrorTablePrefix = "__deherm_lua_error_table_v1__:";
thread_local uint32_t gJsiCallbackInvocationDepth = 0;

struct JsiCallbackInvocationGuard {
  JsiCallbackInvocationGuard() noexcept { ++gJsiCallbackInvocationDepth; }
  ~JsiCallbackInvocationGuard() { --gJsiCallbackInvocationDepth; }
};
constexpr uint8_t kTableSequence = static_cast<uint8_t>(ScriptTableKind::kSequence);
constexpr uint8_t kTableRecord = static_cast<uint8_t>(ScriptTableKind::kRecord);
constexpr uint8_t kTableMap = static_cast<uint8_t>(ScriptTableKind::kMap);

std::atomic<uint32_t> gNextUrlRuntimeToken{1};

uint32_t nextUrlRuntimeToken() noexcept {
  uint32_t token = gNextUrlRuntimeToken.fetch_add(1, std::memory_order_relaxed);
  if (token == 0) token = gNextUrlRuntimeToken.fetch_add(1, std::memory_order_relaxed);
  return token;
}

struct ScratchSlot {
  std::array<ScriptValue, kMaximumArguments> arguments{};
  std::array<ScriptValue, kMaximumResults> results{};
  std::array<std::string, kMaximumInputStrings> inputStrings{};
  std::array<ScriptTableEntry, kMaximumTableEntries> inputTableEntries{};
  std::array<ScriptTableEntry, kMaximumTableEntries> outputTableEntries{};
  std::array<char, kStringScratchCapacity> outputStrings{};
  ScriptMatrix4Arena matrix4Arena{};
  ScriptUrlArena<> urlArena{};
  uint32_t inputStringCount = 0;
  uint32_t inputTableEntryCount = 0;
  std::array<ScriptCallback*, kMaximumArguments> callbackRoots{};
  uint32_t callbackRootCount = 0;

  void resetCallScratch() noexcept {
    for (uint32_t index = 0; index < callbackRootCount; ++index) {
      ScriptCallback* callback = callbackRoots[index];
      if (callback && callback->release) callback->release(callback->context);
      callbackRoots[index] = nullptr;
    }
    callbackRootCount = 0;
    inputStringCount = 0;
    inputTableEntryCount = 0;
  }

  void trackCallback(ScriptCallback* callback) {
    if (callbackRootCount >= callbackRoots.size()) {
      throw std::out_of_range("Defold script callback root arena is exhausted");
    }
    callbackRoots[callbackRootCount++] = callback;
  }

  std::string& acquireInputString() {
    if (inputStringCount >= inputStrings.size()) {
      throw std::out_of_range("Defold script input string arena is exhausted");
    }
    return inputStrings[inputStringCount++];
  }

  ScriptTableEntry* reserveInputEntries(uint32_t count) noexcept {
    if (count > inputTableEntries.size() - inputTableEntryCount) return nullptr;
    ScriptTableEntry* result = inputTableEntries.data() + inputTableEntryCount;
    inputTableEntryCount += count;
    return result;
  }
};

struct Scratch {
  std::array<ScratchSlot, kMaximumReentrantDepth> slots{};
  size_t depth = 0;

  Scratch() noexcept {
    const uint32_t token = nextUrlRuntimeToken();
    for (auto& slot : slots) slot.urlArena.resetRuntime(token);
  }
};

class ScratchFrame {
 public:
  explicit ScratchFrame(Scratch& scratch) : scratch_(scratch) {
    if (scratch_.depth < scratch_.slots.size()) {
      slot_ = &scratch_.slots[scratch_.depth++];
      slot_->resetCallScratch();
      urlMark_ = slot_->urlArena.mark();
    }
  }
  ~ScratchFrame() {
    if (slot_) {
      slot_->resetCallScratch();
      slot_->matrix4Arena.rewind(0);
      slot_->urlArena.rewind(urlMark_);
      --scratch_.depth;
    }
  }
  ScratchSlot* get() noexcept { return slot_; }
 private:
  Scratch& scratch_;
  ScratchSlot* slot_ = nullptr;
  ScriptUrlArena<>::Mark urlMark_{};
};

void encodeCallback(
    jsi::Runtime& runtime,
    jsi::Function function,
    ScriptValue& output,
    ScratchSlot& slot,
    std::shared_ptr<Scratch> scratch,
    std::shared_ptr<ScriptJsiBridgeLifetime> lifetime);

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

class ScriptHandleHostObject final : public jsi::HostObject,
                                     public std::enable_shared_from_this<ScriptHandleHostObject> {
 public:
  ScriptHandleHostObject(
      ScriptHandleKind kind,
      uint8_t semanticKind,
      uint32_t runtime,
      uint64_t payload,
      bool owned) noexcept
      : kind_(kind), semanticKind_(semanticKind), runtime_(runtime), payload_(payload),
        owned_(owned) {}

  ~ScriptHandleHostObject() override { dispose(); }

  ScriptHandleKind kind() const noexcept { return kind_; }
  uint8_t semanticKind() const noexcept { return semanticKind_; }
  uint32_t runtime() const noexcept { return runtime_; }
  uint64_t payload() const noexcept { return payload_; }
  bool disposed() const noexcept { return disposed_.load(std::memory_order_acquire); }

  void dispose() noexcept {
    if (!owned_) return;
    bool expected = false;
    if (disposed_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
      releaseScriptHandle(kind_, runtime_, payload_);
    }
  }

  jsi::Value get(jsi::Runtime& runtime, const jsi::PropNameID& name) override {
    const std::string property = name.utf8(runtime);
    if (property == "runtime") return jsi::Value(static_cast<double>(runtime_));
    if (property == "slot") return jsi::Value(static_cast<double>(static_cast<uint32_t>(payload_)));
    if (property == "generation") return jsi::Value(static_cast<double>(static_cast<uint32_t>(payload_ >> 32u)));
    if (property == "kind") return jsi::String::createFromAscii(runtime, kindName());
    if (property == "dispose") {
      std::weak_ptr<ScriptHandleHostObject> weak = shared_from_this();
      return jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "dispose"),
          0,
          [weak](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
            if (const auto handle = weak.lock()) handle->dispose();
            return jsi::Value::undefined();
          });
    }
    return jsi::Value::undefined();
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& runtime) override {
    return jsi::PropNameID::names(runtime, "runtime", "slot", "generation", "kind", "dispose");
  }

 private:
  const char* kindName() const noexcept {
    if (kind_ == ScriptHandleKind::kLuaSemanticHandle && semanticKind_ > 0 &&
        semanticKind_ <= script_handle_lowering::kSemanticHandleKindNameCount) {
      return script_handle_lowering::semanticHandleKindName(semanticKind_);
    }
    if (kind_ == ScriptHandleKind::kGuiNode) return "gui-node";
    if (kind_ == ScriptHandleKind::kLuaUserdata) return "lua-userdata";
    return "unknown";
  }

  ScriptHandleKind kind_ = ScriptHandleKind::kNone;
  uint8_t semanticKind_ = 0;
  uint32_t runtime_ = 0;
  uint64_t payload_ = 0;
  bool owned_ = true;
  std::atomic<bool> disposed_{false};
};

void encodeLeaf(
    jsi::Runtime& runtime,
    const jsi::Value& value,
    ScriptValue& output,
    ScratchSlot& scratch,
    const std::shared_ptr<Scratch>& bridgeScratch,
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime) {
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
    std::string& string = scratch.acquireInputString();
    string = value.getString(runtime).utf8(runtime);
    if (string.size() > UINT32_MAX) throw jsi::JSError(runtime, "Defold script string exceeds ABI size");
    output.tag = ScriptValueTag::kString;
    output.length = static_cast<uint32_t>(string.size());
    output.data = string.data();
  } else if (value.isObject()) {
    auto object = value.asObject(runtime);
    if (object.isFunction(runtime)) {
      encodeCallback(
          runtime, object.asFunction(runtime), output, scratch, bridgeScratch, lifetime);
      return;
    }
    if (object.isHostObject<ScriptHandleHostObject>(runtime)) {
      const auto handle = object.getHostObject<ScriptHandleHostObject>(runtime);
      if (handle->disposed()) throw jsi::JSError(runtime, "Defold handle is disposed");
      output.tag = ScriptValueTag::kHandle;
      output.handleKind = handle->kind();
      output.reserved = handle->semanticKind();
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

struct ObjectAncestor {
  const jsi::Object& object;
  const ObjectAncestor* parent;
};

bool containsAncestor(
    jsi::Runtime& runtime,
    const jsi::Object& object,
    const ObjectAncestor* ancestor) {
  while (ancestor) {
    if (jsi::Object::strictEquals(runtime, object, ancestor->object)) return true;
    ancestor = ancestor->parent;
  }
  return false;
}

void encode(
    jsi::Runtime& runtime,
    const jsi::Value& value,
    ScriptValue& output,
    ScratchSlot& scratch,
    ScriptMatrix4Arena& matrix4Arena,
    ScriptUrlArena<>& urlArena,
    const std::shared_ptr<Scratch>& bridgeScratch,
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime,
    size_t depth = 0,
    const ObjectAncestor* ancestor = nullptr) {
  if (!value.isObject()) {
    encodeLeaf(runtime, value, output, scratch, bridgeScratch, lifetime);
    return;
  }
  auto object = value.asObject(runtime);
  const auto urlKindValue = object.getProperty(runtime, kDefoldUrlProperty);
  if (urlKindValue.isBool() && urlKindValue.getBool()) {
    const auto socketValue = object.getProperty(runtime, "socket");
    const auto reservedValue = object.getProperty(runtime, "reserved");
    const auto pathValue = object.getProperty(runtime, "path");
    const auto fragmentValue = object.getProperty(runtime, "fragment");
    auto exactLane = [&](const jsi::Value& lane, const char* name) -> uint64_t {
      if (!lane.isBigInt()) {
        throw jsi::JSError(runtime, std::string("Defold URL ") + name + " must be an unsigned 64-bit bigint");
      }
      auto bigint = lane.getBigInt(runtime);
      if (!bigint.isUint64(runtime)) {
        throw jsi::JSError(runtime, std::string("Defold URL ") + name + " must be an unsigned 64-bit bigint");
      }
      return bigint.getUint64(runtime);
    };
    const ScriptResolvedUrl url{
      exactLane(socketValue, "socket"), exactLane(reservedValue, "reserved"),
      exactLane(pathValue, "path"), exactLane(fragmentValue, "fragment")
    };
    if (!urlArena.store(url, &output)) throw jsi::JSError(runtime, "Defold URL frame arena is exhausted");
    return;
  }
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
  if (object.isFunction(runtime) ||
      object.isHostObject<ScriptHandleHostObject>(runtime) ||
      object.getProperty(runtime, kDefoldValueKindProperty).isString()) {
    encodeLeaf(runtime, value, output, scratch, bridgeScratch, lifetime);
    return;
  }

  if (depth >= kMaximumTableDepth) {
    throw jsi::JSError(runtime, "Defold script value graph exceeds the generated depth bound");
  }
  if (containsAncestor(runtime, object, ancestor)) {
    throw jsi::JSError(runtime, "Defold script value graph contains a cycle");
  }
  const ObjectAncestor current{object, ancestor};

  size_t entryCount = 0;
  uint8_t tableKind = kTableRecord;
  size_t expectedEntryCount = 0;
  const bool isArray = object.isArray(runtime);
  const auto mapValue = runtime.global().getProperty(runtime, "Map");
  const bool isMap = mapValue.isObject() && mapValue.asObject(runtime).isFunction(runtime) &&
      object.instanceOf(runtime, mapValue.asObject(runtime).asFunction(runtime));
  if (isArray) {
    tableKind = kTableSequence;
    expectedEntryCount = object.asArray(runtime).size(runtime);
  } else if (isMap) {
    tableKind = kTableMap;
    const auto size = object.getProperty(runtime, "size");
    if (!size.isNumber() || !std::isfinite(size.asNumber()) ||
        std::trunc(size.asNumber()) != size.asNumber() || size.asNumber() < 0) {
      throw jsi::JSError(runtime, "Map.size is not a non-negative integer");
    }
    expectedEntryCount = static_cast<size_t>(size.asNumber());
  } else {
    expectedEntryCount = object.getPropertyNames(runtime).size(runtime);
  }
  if (expectedEntryCount > kMaximumTableEntries) {
    throw jsi::JSError(runtime, "Defold script table exceeds the generated entry bound");
  }
  ScriptTableEntry* tableEntries = scratch.reserveInputEntries(
      static_cast<uint32_t>(expectedEntryCount));
  if (expectedEntryCount && !tableEntries) {
    throw jsi::JSError(runtime, "Defold script call value arena is exhausted");
  }
  auto append = [&](const jsi::Value& key, const jsi::Value& item) {
    if (entryCount >= expectedEntryCount) {
      throw jsi::JSError(runtime, "Defold script table changed while it was encoded");
    }
    auto& entry = tableEntries[entryCount];
    encode(runtime, key, entry.key, scratch, matrix4Arena, urlArena, bridgeScratch,
        lifetime, depth + 1, &current);
    encode(runtime, item, entry.value, scratch, matrix4Arena, urlArena, bridgeScratch,
        lifetime, depth + 1, &current);
    if (entry.key.tag == ScriptValueTag::kNull || entry.key.tag == ScriptValueTag::kUndefined) {
      throw jsi::JSError(runtime, "Defold script table keys cannot be null or undefined");
    }
    ++entryCount;
  };

  if (isArray) {
    auto array = object.asArray(runtime);
    for (size_t index = 0; index < expectedEntryCount; ++index) {
      append(jsi::Value(static_cast<double>(index + 1)), array.getValueAtIndex(runtime, index));
    }
  } else if (isMap) {
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
    for (size_t index = 0; index < count; ++index) {
      const auto key = names.getValueAtIndex(runtime, index);
      append(key, object.getProperty(runtime, key.getString(runtime)));
    }
  }

  output = {};
  output.tag = ScriptValueTag::kTable;
  output.reserved = tableKind;
  output.length = static_cast<uint32_t>(entryCount);
  output.data = tableEntries;
}

jsi::Value decode(
    jsi::Runtime& runtime,
    const ScriptValue& value,
    const ScriptMatrix4Arena& matrix4Arena,
    const ScriptUrlArena<>& urlArena,
    const std::shared_ptr<Scratch>& bridgeScratch,
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime,
    bool ownHandles = true);

struct LuaClosureConsumeContext {
  jsi::Runtime* runtime = nullptr;
  const std::shared_ptr<Scratch>* scratch = nullptr;
  const std::shared_ptr<ScriptJsiBridgeLifetime>* lifetime = nullptr;
  std::optional<jsi::Value> value;
  std::string error;
};

bool ConsumeLuaClosureResults(void* opaque, const ScriptCallFrame* results) noexcept;

jsi::Value decode(
    jsi::Runtime& runtime,
    const ScriptValue& value,
    const ScriptMatrix4Arena& matrix4Arena,
    const ScriptUrlArena<>& urlArena,
    const std::shared_ptr<Scratch>& bridgeScratch,
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime,
    bool ownHandles) {
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
          value.handleKind == ScriptHandleKind::kLuaUserdata ||
          value.handleKind == ScriptHandleKind::kLuaSemanticHandle) {
        return jsi::Object::createFromHostObject(
            runtime,
            std::make_shared<ScriptHandleHostObject>(
                value.handleKind, value.reserved, value.length, value.payload, ownHandles));
      }
      if (value.handleKind == ScriptHandleKind::kUrl) {
        ScriptResolvedUrl url{};
        if (!urlArena.resolve(value, urlArena.runtimeToken(), &url)) {
          throw jsi::JSError(runtime, "Defold script bridge returned a stale URL token");
        }
        jsi::Object object(runtime);
        object.setProperty(runtime, "socket", jsi::BigInt::fromUint64(runtime, url.socket));
        object.setProperty(runtime, "reserved", jsi::BigInt::fromUint64(runtime, url.reserved));
        object.setProperty(runtime, "path", jsi::BigInt::fromUint64(runtime, url.path));
        object.setProperty(runtime, "fragment", jsi::BigInt::fromUint64(runtime, url.fragment));
        object.setProperty(runtime, kDefoldUrlProperty, true);
        return object;
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
    case ScriptValueTag::kTable: {
      if (value.length != 0 && !value.data) {
        throw jsi::JSError(runtime, "Defold script bridge returned a table with null storage");
      }
      const auto* entries = static_cast<const ScriptTableEntry*>(value.data);
      if (value.reserved == kTableSequence) {
        jsi::Array array(runtime, value.length);
        for (uint32_t index = 0; index < value.length; ++index) {
          const ScriptValue& key = entries[index].key;
          if (key.tag != ScriptValueTag::kNumber || !std::isfinite(key.number) ||
              std::trunc(key.number) != key.number || key.number < 1.0 ||
              key.number > static_cast<double>(value.length)) {
            throw jsi::JSError(runtime, "Defold script bridge returned an invalid sequence key");
          }
          array.setValueAtIndex(runtime, static_cast<size_t>(key.number - 1.0), decode(
              runtime, entries[index].value, matrix4Arena, urlArena,
              bridgeScratch, lifetime, ownHandles));
        }
        return array;
      }
      if (value.reserved == kTableRecord) {
        jsi::Object object(runtime);
        for (uint32_t index = 0; index < value.length; ++index) {
          const ScriptValue& key = entries[index].key;
          if (key.tag != ScriptValueTag::kString || (key.length != 0 && !key.data)) {
            throw jsi::JSError(runtime, "Defold script bridge returned a non-string record key");
          }
          const auto name = jsi::PropNameID::forUtf8(
              runtime, static_cast<const uint8_t*>(key.data), key.length);
          object.setProperty(runtime, name, decode(
              runtime, entries[index].value, matrix4Arena, urlArena,
              bridgeScratch, lifetime, ownHandles));
        }
        return object;
      }
      const auto mapConstructor = runtime.global().getPropertyAsFunction(runtime, "Map");
      auto map = mapConstructor.callAsConstructor(runtime).asObject(runtime);
      const auto set = map.getPropertyAsFunction(runtime, "set");
      for (uint32_t index = 0; index < value.length; ++index) {
        set.callWithThis(
            runtime,
            map,
            decode(runtime, entries[index].key, matrix4Arena, urlArena,
                bridgeScratch, lifetime, ownHandles),
            decode(runtime, entries[index].value, matrix4Arena, urlArena,
                bridgeScratch, lifetime, ownHandles));
      }
      return map;
    }
    case ScriptValueTag::kCallback: {
      auto* callback = const_cast<ScriptCallback*>(
          static_cast<const ScriptCallback*>(value.data));
      if (!callback || !callback->invoke || !callback->retain || !callback->release) {
        throw jsi::JSError(runtime, "Defold script bridge returned an incomplete callback descriptor");
      }
      std::shared_ptr<ScriptCallback> owner(callback, [](ScriptCallback* held) {
        held->release(held->context);
      });
      return jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "dehermLuaClosure"),
          0,
          [owner, bridgeScratch, lifetime](
              jsi::Runtime& runtime,
              const jsi::Value&,
              const jsi::Value* arguments,
              size_t argumentCount) -> jsi::Value {
            if (argumentCount > kMaximumArguments) {
              throw jsi::JSError(runtime, "Lua closure argument count exceeds the generated bound");
            }
            ScratchFrame scratchFrame(*bridgeScratch);
            ScratchSlot* slot = scratchFrame.get();
            if (!slot) {
              throw jsi::JSError(runtime, "Lua closure reentrancy exceeds the fixed scratch stack");
            }
            for (size_t index = 0; index < argumentCount; ++index) {
              encode(runtime, arguments[index], slot->arguments[index], *slot,
                  slot->matrix4Arena, slot->urlArena, bridgeScratch, lifetime);
            }
            ScriptCallFrame frame{};
            frame.arguments = slot->arguments.data();
            frame.argumentCount = static_cast<uint32_t>(argumentCount);
            frame.matrix4Arena = &slot->matrix4Arena;
            frame.urlArena = &slot->urlArena;
            LuaClosureConsumeContext consumed{&runtime, &bridgeScratch, &lifetime};
            char error[384]{};
            if (!owner->invoke(owner->context, &frame, &consumed,
                    ConsumeLuaClosureResults, error, sizeof(error))) {
              const char* message = error[0] ? error :
                  consumed.error.empty() ? "Lua closure invocation failed" : consumed.error.c_str();
              if (gJsiCallbackInvocationDepth == 0 &&
                  std::strncmp(message, kLuaErrorTablePrefix,
                      std::strlen(kLuaErrorTablePrefix)) == 0) {
                message += std::strlen(kLuaErrorTablePrefix);
              }
              throw jsi::JSError(runtime, message);
            }
            if (!consumed.value) {
              throw jsi::JSError(runtime, consumed.error.empty()
                  ? "Lua closure did not consume its results" : consumed.error);
            }
            return std::move(*consumed.value);
          });
    }
  }
  throw jsi::JSError(runtime, "Defold script bridge returned an unknown value tag");
}

bool ConsumeLuaClosureResults(void* opaque, const ScriptCallFrame* results) noexcept {
  auto* context = static_cast<LuaClosureConsumeContext*>(opaque);
  if (!context || !context->runtime || !context->scratch || !context->lifetime ||
      !results || results->resultCount > results->resultCapacity ||
      (results->resultCount && !results->results) || !results->matrix4Arena ||
      !results->urlArena) return false;
  try {
    if (results->resultCount == 0) {
      context->value.emplace(jsi::Value::undefined());
    } else if (results->resultCount == 1) {
      context->value.emplace(decode(*context->runtime, results->results[0],
          *results->matrix4Arena, *results->urlArena,
          *context->scratch, *context->lifetime));
    } else {
      jsi::Array output(*context->runtime, results->resultCount);
      for (uint32_t index = 0; index < results->resultCount; ++index) {
        output.setValueAtIndex(*context->runtime, index, decode(
            *context->runtime, results->results[index],
            *results->matrix4Arena, *results->urlArena,
            *context->scratch, *context->lifetime));
      }
      context->value.emplace(std::move(output));
    }
    return true;
  } catch (const std::exception& exception) {
    context->error = exception.what();
  } catch (...) {
    context->error = "Lua closure result decoding failed";
  }
  return false;
}

class JsiCallbackRoot final {
 public:
  JsiCallbackRoot(
      jsi::Runtime& runtime,
      jsi::Function function,
      std::shared_ptr<Scratch> scratch,
      std::shared_ptr<ScriptJsiBridgeLifetime> lifetime)
      : runtime_(&runtime), function_(std::move(function)), scratch_(std::move(scratch)),
        lifetime_(std::move(lifetime)) {
    if (!lifetime_ || !lifetime_->attach(this, Invalidate)) {
      throw std::out_of_range("Defold script callback lifetime arena is exhausted or shut down");
    }
    descriptor_ = {this, Invoke, Retain, Release};
  }

  ~JsiCallbackRoot() {
    if (lifetime_) lifetime_->detach(this);
  }

  ScriptCallback* descriptor() noexcept { return &descriptor_; }

 private:
  static void Retain(void* opaque) noexcept {
    static_cast<JsiCallbackRoot*>(opaque)->references_.fetch_add(1, std::memory_order_relaxed);
  }

  static void Release(void* opaque) noexcept {
    auto* self = static_cast<JsiCallbackRoot*>(opaque);
    if (self->references_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete self;
  }

  static void Invalidate(void* opaque) noexcept {
    auto* self = static_cast<JsiCallbackRoot*>(opaque);
    // Publish invalidation before releasing the JSI function. Callback invoke
    // is owner-thread-only, so teardown and invocation cannot race legally;
    // this ordering still ensures reentrant release observes an inert root.
    self->runtime_ = nullptr;
    self->function_.reset();
    self->scratch_.reset();
  }

  static bool Invoke(
      void* opaque,
      const ScriptCallFrame* arguments,
      void* consumeContext,
      ScriptCallbackConsume consume,
      char* error,
      size_t errorCapacity) noexcept {
    auto* self = static_cast<JsiCallbackRoot*>(opaque);
    auto fail = [&](const char* message) {
      if (error && errorCapacity) std::snprintf(error, errorCapacity, "%s", message ? message : "JavaScript callback failed");
      return false;
    };
    if (!self->runtime_ || !self->function_ || !self->scratch_) {
      return fail("JavaScript callback belongs to a destroyed Hermes runtime");
    }
    if (!arguments || !consume ||
        arguments->argumentCount > kMaximumArguments ||
        (arguments->argumentCount && !arguments->arguments) ||
        !arguments->matrix4Arena || !arguments->urlArena) {
      return fail("JavaScript callback received an invalid bounded frame");
    }
    try {
      ScratchFrame scratchFrame(*self->scratch_);
      ScratchSlot* slot = scratchFrame.get();
      if (!slot) return fail("Reentrant JavaScript callback depth exceeds the fixed scratch stack");
      std::array<jsi::Value, kMaximumArguments> values{};
      for (uint32_t index = 0; index < arguments->argumentCount; ++index) {
        values[index] = decode(*self->runtime_, arguments->arguments[index],
            *arguments->matrix4Arena, *arguments->urlArena,
            self->scratch_, self->lifetime_, false);
      }
      JsiCallbackInvocationGuard invocationGuard;
      jsi::Value result = self->function_->call(
          *self->runtime_, static_cast<const jsi::Value*>(values.data()),
          static_cast<size_t>(arguments->argumentCount));
      ScriptCallFrame output{};
      output.results = slot->results.data();
      output.resultCapacity = static_cast<uint32_t>(slot->results.size());
      output.tableScratch = slot->inputTableEntries.data();
      output.tableScratchCapacity = static_cast<uint32_t>(slot->inputTableEntries.size());
      output.stringScratch = slot->outputStrings.data();
      output.stringScratchCapacity = static_cast<uint32_t>(slot->outputStrings.size());
      output.matrix4Arena = &slot->matrix4Arena;
      output.urlArena = &slot->urlArena;
      bool encodedMultiple = false;
      if (result.isObject()) {
        auto object = result.asObject(*self->runtime_);
        const auto marker = object.getProperty(
            *self->runtime_, "__dehermCallbackResultsV1");
        if (marker.isBool() && marker.getBool()) {
          const auto valuesProperty = object.getProperty(*self->runtime_, "values");
          if (!valuesProperty.isObject() ||
              !valuesProperty.asObject(*self->runtime_).isArray(*self->runtime_)) {
            return fail("JavaScript callback multi-result marker has no values array");
          }
          auto outputValues = valuesProperty.asObject(*self->runtime_).asArray(*self->runtime_);
          const size_t count = outputValues.size(*self->runtime_);
          if (count > slot->results.size()) {
            return fail("JavaScript callback result count exceeds the generated bound");
          }
          for (size_t index = 0; index < count; ++index) {
            encode(*self->runtime_, outputValues.getValueAtIndex(*self->runtime_, index),
                slot->results[index], *slot, slot->matrix4Arena, slot->urlArena,
                self->scratch_, self->lifetime_);
          }
          output.resultCount = static_cast<uint32_t>(count);
          encodedMultiple = true;
        }
      }
      if (!encodedMultiple && !result.isUndefined()) {
        encode(*self->runtime_, result, slot->results[0], *slot,
            slot->matrix4Arena, slot->urlArena, self->scratch_, self->lifetime_);
        output.resultCount = 1;
      }
      if (!consume(consumeContext, &output)) return fail("Lua rejected JavaScript callback results");
      return true;
    } catch (const std::exception& exception) {
      return fail(exception.what());
    } catch (...) {
      return fail("JavaScript callback threw a non-standard exception");
    }
  }

  std::atomic<uint32_t> references_{1};
  jsi::Runtime* runtime_ = nullptr;
  std::optional<jsi::Function> function_;
  std::shared_ptr<Scratch> scratch_;
  std::shared_ptr<ScriptJsiBridgeLifetime> lifetime_;
  ScriptCallback descriptor_{};
};

void encodeCallback(
    jsi::Runtime& runtime,
    jsi::Function function,
    ScriptValue& output,
    ScratchSlot& slot,
    std::shared_ptr<Scratch> scratch,
    std::shared_ptr<ScriptJsiBridgeLifetime> lifetime) {
  auto* root = new JsiCallbackRoot(
      runtime, std::move(function), std::move(scratch), std::move(lifetime));
  ScriptCallback* descriptor = root->descriptor();
  try {
    slot.trackCallback(descriptor);
  } catch (...) {
    descriptor->release(descriptor->context);
    throw;
  }
  output = {};
  output.tag = ScriptValueTag::kCallback;
  output.data = descriptor;
}

}  // namespace

std::shared_ptr<ScriptJsiBridgeLifetime> installScriptJsiBridge(jsi::Runtime& runtime) {
  auto scratch = std::make_shared<Scratch>();
  auto lifetime = std::make_shared<ScriptJsiBridgeLifetime>();
  jsi::Object bridge(runtime);
  bridge.setProperty(runtime, "target", jsi::String::createFromAscii(runtime, "native-hermes"));
  auto call = jsi::Function::createFromHostFunction(
      runtime,
      jsi::PropNameID::forAscii(runtime, "call"),
      2,
      [scratch, lifetime](jsi::Runtime& runtime,
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
        // The JSI crossing is the baseline transport every route falls back to.
        // Naming it here is what lets a drained ring say which transport a call
        // actually took rather than inferring it from a missing typed-native
        // span. The contract-shape dimension is zero: the JSI encoder is one
        // generic value-graph walker rather than a per-contract frame.
        DEHERM_PROFILE_TRANSPORT_SCOPE(DEHERM_PROFILE_TRANSPORT_JSI, id, 0u,
            "deherm.jsi.call");
#if defined(DEHERM_CANONICAL_RELEASE)
        if (!dehermCanonicalReleaseRouteEnabled(id)) {
          throw jsi::JSError(runtime, "Defold script route was removed from this release build");
        }
#endif
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
              *slot,
              slot->matrix4Arena,
              slot->urlArena,
              scratch,
              lifetime);
        }
        ScriptCallFrame frame;
        frame.stableId = id;
        frame.arguments = slot->arguments.data();
        frame.argumentCount = static_cast<uint32_t>(argumentCount);
        frame.results = slot->results.data();
        frame.resultCapacity = static_cast<uint32_t>(slot->results.size());
        frame.stringScratch = slot->outputStrings.data();
        frame.stringScratchCapacity = static_cast<uint32_t>(slot->outputStrings.size());
        frame.tableScratch = slot->outputTableEntries.data();
        frame.tableScratchCapacity = static_cast<uint32_t>(slot->outputTableEntries.size());
        frame.matrix4Arena = &slot->matrix4Arena;
        frame.urlArena = &slot->urlArena;
        if (!dispatchScriptCall(&frame)) {
          DEHERM_PROFILE_SCOPE_FAILED();
          throw jsi::JSError(runtime, scriptBridgeLastError());
        }
        const auto* universalOperation = universal_value::find(id);
        if (universalOperation && universalOperation->maximumResultCount > 1) {
          jsi::Array results(runtime, universalOperation->maximumResultCount);
          for (size_t index = 0; index < universalOperation->maximumResultCount; ++index) {
            results.setValueAtIndex(runtime, index,
                index < frame.resultCount
                    ? decode(runtime, frame.results[index], slot->matrix4Arena,
                        slot->urlArena, scratch, lifetime)
                    : jsi::Value::undefined());
          }
          return results;
        }
        if (frame.resultCount == 0) return jsi::Value::undefined();
        if (frame.resultCount == 1) return decode(
            runtime, frame.results[0], slot->matrix4Arena, slot->urlArena,
            scratch, lifetime);
        jsi::Array results(runtime, frame.resultCount);
        for (size_t index = 0; index < frame.resultCount; ++index) {
          results.setValueAtIndex(runtime, index, decode(
              runtime, frame.results[index], slot->matrix4Arena, slot->urlArena,
              scratch, lifetime));
        }
        return results;
      });
  bridge.setProperty(runtime, "call", std::move(call));
  runtime.global().setProperty(runtime, "__defoldScriptBridgeV1", std::move(bridge));
  return lifetime;
}

void shutdownScriptJsiBridge(
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime) noexcept {
  if (lifetime) lifetime->shutdown();
}

}  // namespace defold_hermes

#endif
