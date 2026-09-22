#include <defold_hermes/runtime.hpp>
#include <defold_hermes/callback_registry.hpp>
#include <defold_hermes/generated_jsi.hpp>
#include <defold_hermes/script_jsi_bridge.hpp>

#if !defined(DM_PLATFORM_HTML5)

#if !defined(DEHERM_HERMES_DEBUGGER) && __has_include(<defold_hermes/generated_runtime_variant.h>)
#include <defold_hermes/generated_runtime_variant.h>
#endif
#ifndef DEHERM_HERMES_DEBUGGER
#define DEHERM_HERMES_DEBUGGER 0
#endif

#if DEHERM_HERMES_DEBUGGER
#ifndef HERMES_ENABLE_DEBUGGER
#define HERMES_ENABLE_DEBUGGER 1
#endif
#include <hermes/cdp/CDPAgent.h>
#include <hermes/cdp/CDPDebugAPI.h>
#endif

#include <memory>
#include <atomic>
#include <array>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <exception>
#include <functional>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <jsi/hermes-interfaces.h>
#include <jsi/instrumentation.h>

namespace jsi = facebook::jsi;

extern "C" size_t hermes_numberToString(
    double value, char* destination, size_t destinationSize);

namespace defold_hermes {

namespace {

std::atomic<uint32_t> gNextRuntimeId{1};

uint32_t acquireRuntimeId() {
  uint32_t id = gNextRuntimeId.fetch_add(1, std::memory_order_relaxed);
  if (id == 0) id = gNextRuntimeId.fetch_add(1, std::memory_order_relaxed);
  return id;
}

std::string asString(jsi::Runtime& runtime, const jsi::Value& value) {
  return value.toString(runtime).utf8(runtime);
}

std::unique_ptr<facebook::hermes::HermesRuntime> makeRuntime() {
  ::hermes::vm::RuntimeConfig::Builder config;
#if defined(DM_PLATFORM_ANDROID)
  // Hermes' Android default wraps its finalizer worker in fbjni::ThreadScope.
  // React Native initializes fbjni from JNI_OnLoad; Defold owns the process
  // entry point and does not. An explicitly empty runner suppresses that
  // platform default while preserving Hermes' own serial finalizer worker.
  // It must be ThreadRunner{}: passing bare {} means std::nullopt and selects
  // the crashing JNI default again.
  config.withFinalizerThreadRunner(::hermes::vm::ThreadRunner{});
#endif
#if DEHERM_HERMES_DEBUGGER
  config.withEnableSampleProfiling(true);
#endif
  return facebook::hermes::makeHermesRuntime(config.build());
}

#if DEHERM_HERMES_DEBUGGER

constexpr size_t kSnapshotPropertyCapacity = 32;
constexpr size_t kSnapshotStringByteCapacity = 256;
constexpr size_t kSnapshotFrameByteCapacity = 512 * 1024;
// Leave a conservative fixed allowance for the envelope and omission fields.
// The completed frame is checked again before it is returned.
constexpr size_t kSnapshotInstancesByteCapacity =
    kSnapshotFrameByteCapacity - 1024;
constexpr uint64_t kMaximumSafeJsonInteger = UINT64_C(9007199254740991);

void appendJsonString(std::string& output, const char* bytes, size_t length) {
  static constexpr char kHex[] = "0123456789abcdef";
  output.push_back('"');
  for (size_t index = 0; index < length; ++index) {
    const unsigned char byte = static_cast<unsigned char>(bytes[index]);
    switch (byte) {
      case '"': output.append("\\\""); break;
      case '\\': output.append("\\\\"); break;
      case '\b': output.append("\\b"); break;
      case '\f': output.append("\\f"); break;
      case '\n': output.append("\\n"); break;
      case '\r': output.append("\\r"); break;
      case '\t': output.append("\\t"); break;
      default:
        if (byte < 0x20) {
          output.append("\\u00");
          output.push_back(kHex[byte >> 4]);
          output.push_back(kHex[byte & 0xf]);
        } else {
          output.push_back(static_cast<char>(byte));
        }
    }
  }
  output.push_back('"');
}

void appendJsonString(std::string& output, const std::string& value) {
  appendJsonString(output, value.data(), value.size());
}

void appendUnsigned(std::string& output, uint64_t value) {
  std::array<char, 32> buffer{};
  const auto result = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
  if (result.ec != std::errc{}) throw std::runtime_error("Snapshot integer encoding failed");
  output.append(buffer.data(), static_cast<size_t>(result.ptr - buffer.data()));
}

void appendFiniteNumber(std::string& output, double value) {
  // Hermes' locale-independent ECMAScript number formatter uses only this
  // fixed caller-owned buffer. The symbol is part of the already-linked
  // Hermes support archive and avoids per-lane stream allocation.
  std::array<char, 32> buffer{};
  const size_t length = hermes_numberToString(value, buffer.data(), buffer.size());
  if (length >= buffer.size()) throw std::runtime_error("Snapshot number encoding failed");
  output.append(buffer.data(), length);
}

uint32_t saturatedAdd(uint32_t left, uint32_t right) {
  return UINT32_MAX - left < right ? UINT32_MAX : left + right;
}

void appendHex64(std::string& output, uint64_t value) {
  static constexpr char kHex[] = "0123456789abcdef";
  output.push_back('"');
  for (int shift = 60; shift >= 0; shift -= 4)
    output.push_back(kHex[(value >> shift) & 0xf]);
  output.push_back('"');
}

void appendUnavailable(std::string& output, const char* reason) {
  output.append(R"({"kind":"unavailable","reason":)");
  appendJsonString(output, reason, std::strlen(reason));
  output.push_back('}');
}

#endif

}  // namespace

class Runtime::Impl {
 public:
  explicit Impl(Host& host)
      : host_(host), runtime_(makeRuntime()), identity_(acquireRuntimeId()) {
    callbacks_ = std::make_unique<CallbackRegistry>(
        *runtime_, 4096, identity_);
#if DEHERM_HERMES_DEBUGGER
    auto object = runtime_->global().getPropertyAsObject(*runtime_, "Object");
    ownPropertyDescriptor_.emplace(
        object.getPropertyAsFunction(*runtime_, "getOwnPropertyDescriptor"));
#endif
    installHost();
  }

  ~Impl() {
#if DEHERM_HERMES_DEBUGGER
    closeInspector();
#endif
    // Lua closures can retain ScriptCallback descriptors beyond application
    // finalization. Clear their JSI functions while runtime_ is unquestionably
    // alive; a later Lua __gc may then release an inert native root safely.
    shutdownScriptJsiBridge(scriptBridgeLifetime_);
  }

  void load(const std::string& source, const std::string& sourceUrl) {
    if (loaded_) throw std::runtime_error("A Defold Hermes application is already loaded");

    auto buffer = std::make_shared<jsi::StringBuffer>(source);
    runtime_->evaluateJavaScript(buffer, sourceUrl);
    captureEntrypoints();
  }

  /// Evaluate AOT units into this runtime WITHOUT claiming the application
  /// entrypoints. This is the mixing seam: the same Hermes runtime then holds
  /// `shermes`-compiled native code and, after `load()`, ordinary bytecode.
  /// A unit evaluated here may install globals the later bundle reaches, which
  /// is how a typed-native route replaces a JSI crossing in-place.
  void evaluateStaticUnits(const StaticUnitCreator* unitCreators, size_t unitCount) {
    if (loaded_) throw std::runtime_error("Static units must be evaluated before the application bundle");
    if (!unitCreators || unitCount == 0) return;
    auto* hermes = jsi::castInterface<facebook::hermes::IHermes>(runtime_.get());
    if (!hermes) throw std::runtime_error("Hermes runtime does not expose the Static Hermes interface");
    for (size_t index = 0; index < unitCount; ++index) {
      if (!unitCreators[index]) throw std::invalid_argument("Static Hermes unit creator is null");
      hermes->evaluateSHUnit(unitCreators[index]);
    }
  }

  void loadStatic(
      const StaticUnitCreator* unitCreators,
      size_t unitCount,
      const std::string&) {
    if (loaded_) throw std::runtime_error("A Defold Hermes application is already loaded");
    if (!unitCreators || unitCount == 0) {
      throw std::invalid_argument("Static Hermes application requires at least one unit");
    }
    auto* hermes = jsi::castInterface<facebook::hermes::IHermes>(runtime_.get());
    if (!hermes) throw std::runtime_error("Hermes runtime does not expose the Static Hermes interface");
    for (size_t index = 0; index < unitCount; ++index) {
      if (!unitCreators[index]) throw std::invalid_argument("Static Hermes unit creator is null");
      hermes->evaluateSHUnit(unitCreators[index]);
    }
    captureEntrypoints();
  }

  void captureEntrypoints() {
    auto application = runtime_->global().getProperty(*runtime_, "__defoldAppV1");
    auto components = runtime_->global().getProperty(*runtime_, "__defoldComponentsV1");
    if (!application.isObject() && !components.isObject()) {
      throw jsi::JSError(*runtime_, "Bundle registered neither __defoldAppV1 nor __defoldComponentsV1");
    }
    if (application.isObject()) {
      app_ = std::make_unique<jsi::Object>(application.asObject(*runtime_));
    }
    loaded_ = true;
  }

  void init() { callOptional("init"); }

  void update(double dt) {
    const jsi::Value argument(dt);
    callOptional("update", &argument, 1);
  }

  void onMessage(const std::string& message) {
    const jsi::Value argument(jsi::String::createFromUtf8(*runtime_, message));
    callOptional("onMessage", &argument, 1);
  }

  void finalize() {
    std::exception_ptr firstFailure;
    try {
      finalizeComponents();
    } catch (...) {
      firstFailure = std::current_exception();
    }
    try {
      callOptional("final");
    } catch (...) {
      if (!firstFailure) firstFailure = std::current_exception();
    }
    app_.reset();
    loaded_ = false;
    if (firstFailure) std::rethrow_exception(firstFailure);
  }

  ComponentHandle attachComponent(const char* componentId, const char* schemaFingerprint,
      ComponentContext context) {
    if (!componentId || !schemaFingerprint) throw std::invalid_argument("Component identity is missing");
    // Scan from the last successful allocation so factory spawn bursts stay
    // amortised O(1) instead of rescanning the whole pool for every instance.
    size_t slotIndex = componentSlots_.size();
    for (size_t probe = 0; probe < componentSlots_.size(); ++probe) {
      const size_t index = (componentSlotCursor_ + probe) % componentSlots_.size();
      if (!componentSlots_[index].live) { slotIndex = index; break; }
    }
    if (slotIndex == componentSlots_.size()) {
      throw std::runtime_error(
          std::string("Component instance pool is exhausted: all ") +
          std::to_string(componentSlots_.size()) +
          " slots are live. Component '" + componentId +
          "' cannot attach. Every live TypeScript component instance, including "
          "each factory-spawned game object, occupies one slot.");
    }
    auto entryValue = runtime_->global().getProperty(*runtime_, "__defoldComponentsV1");
    if (!entryValue.isObject()) throw jsi::JSError(*runtime_, "Component registry is not installed");
    auto registry = entryValue.asObject(*runtime_);
    auto definitionValue = registry.getProperty(*runtime_, componentId);
    if (!definitionValue.isObject()) throw jsi::JSError(*runtime_, std::string("Component is not registered: ") + componentId);
    auto entry = definitionValue.asObject(*runtime_);
    auto schema = entry.getProperty(*runtime_, "schemaFingerprint");
    auto contextValue = entry.getProperty(*runtime_, "contextKind");
    auto definition = entry.getProperty(*runtime_, "definition");
    if (!schema.isString() || schema.getString(*runtime_).utf8(*runtime_) != schemaFingerprint)
      throw jsi::JSError(*runtime_, "Component schema fingerprint is stale");
    const char* expectedContext = context == ComponentContext::kGameObject ? "game-object" :
        context == ComponentContext::kGuiScene ? "gui-scene" : "render-instance+graphics";
    if (!contextValue.isString() || contextValue.getString(*runtime_).utf8(*runtime_) != expectedContext)
      throw jsi::JSError(*runtime_, "Component context does not match its registration");
    if (!definition.isObject()) throw jsi::JSError(*runtime_, "Component definition is not an object");
    ComponentSlot& slot = componentSlots_[slotIndex];
    slot.definition.emplace(definition.asObject(*runtime_));
    slot.self.emplace(*runtime_);
    slot.componentId = componentId;
    slot.schemaFingerprint = schemaFingerprint;
    slot.context = context;
    slot.live = true;
    componentSlotCursor_ = (slotIndex + 1) % componentSlots_.size();
    ++liveComponents_;
    return {static_cast<uint32_t>(slotIndex), slot.generation};
  }

  void setComponentProperty(ComponentHandle handle, const char* name, const ComponentValue& value) {
    ComponentSlot& slot = resolve(handle);
    if (!name) throw std::invalid_argument("Component property name is null");
    jsi::Value decoded = decodeComponentValue(value);
#if DEHERM_HERMES_DEBUGGER
    // Attach projects each declaration once. If a defensive repeated call
    // reaches an unretained (33rd+) name, do not count the same structural
    // omission twice and do not retain another unbounded name just to dedupe.
    jsi::Value previous;
    const bool previouslyOwn =
        ownDataProperty(*slot.self, name, &previous) != OwnPropertyResult::kMissing;
    int retainedIndex = -1;
    for (uint8_t index = 0; index < slot.propertyCount; ++index) {
      if (slot.propertyNames[index] == name) {
        retainedIndex = index;
        break;
      }
    }
    std::optional<jsi::Object> trustedObject;
    if (decoded.isObject() && !decoded.asObject(*runtime_).isFunction(*runtime_))
      trustedObject.emplace(decoded.asObject(*runtime_));
#endif
    slot.self->setProperty(*runtime_, name, std::move(decoded));
#if DEHERM_HERMES_DEBUGGER
    if (retainedIndex >= 0) {
      slot.trustedPropertyObjects[retainedIndex] = std::move(trustedObject);
    } else {
      if (slot.propertyCount < slot.propertyNames.size()) {
        const uint8_t index = slot.propertyCount++;
        slot.propertyNames[index] = name;
        slot.trustedPropertyObjects[index] = std::move(trustedObject);
      } else if (!previouslyOwn) {
        slot.omittedPropertyCount = saturatedAdd(slot.omittedPropertyCount, 1);
      }
    }
#endif
  }

  bool dispatchComponent(ComponentHandle handle, const char* lifecycle,
      const ComponentArgument* arguments, uint8_t argumentCount) {
    ComponentSlot& slot = resolve(handle);
    if (!lifecycle || argumentCount > 4 || (argumentCount && !arguments))
      throw std::invalid_argument("Component dispatch arguments are invalid");
    auto hookValue = slot.definition->getProperty(*runtime_, lifecycle);
    if (hookValue.isUndefined() || hookValue.isNull()) return false;
    if (!hookValue.isObject() || !hookValue.asObject(*runtime_).isFunction(*runtime_))
      throw jsi::JSError(*runtime_, std::string("Component hook is not a function: ") + lifecycle);
    std::array<jsi::Value, 5> values;
    values[0] = jsi::Value(*runtime_, *slot.self);
    for (uint8_t index = 0; index < argumentCount; ++index) values[index + 1] = decodeComponentArgument(arguments[index]);
    const jsi::Value* jsArguments = values.data();
    auto result = hookValue.asObject(*runtime_).asFunction(*runtime_).callWithThis(
        *runtime_, *slot.definition, jsArguments, static_cast<size_t>(argumentCount) + 1);
    if (std::strcmp(lifecycle, "onInput") == 0) {
      if (!result.isBool()) throw jsi::JSError(*runtime_, "Component onInput must return an exact boolean");
      return result.getBool();
    }
    return false;
  }

  void reloadComponent(ComponentHandle handle) {
    ComponentSlot& slot = resolve(handle);
    auto registryValue = runtime_->global().getProperty(*runtime_, "__defoldComponentsV1");
    if (!registryValue.isObject()) throw jsi::JSError(*runtime_, "Component registry is not installed during reload");
    auto entryValue = registryValue.asObject(*runtime_).getProperty(*runtime_, slot.componentId.c_str());
    if (!entryValue.isObject()) throw jsi::JSError(*runtime_, "Component disappeared during reload");
    auto definition = entryValue.asObject(*runtime_).getProperty(*runtime_, "definition");
    if (!definition.isObject()) throw jsi::JSError(*runtime_, "Reloaded component definition is invalid");
    slot.definition.emplace(definition.asObject(*runtime_));
    dispatchComponent(handle, "onReload", nullptr, 0);
  }

  void detachComponent(ComponentHandle handle) {
    if (handle.slot >= componentSlots_.size()) return;
    ComponentSlot& slot = componentSlots_[handle.slot];
    if (!slot.live || slot.generation != handle.generation) return;
    slot.definition.reset(); slot.self.reset(); slot.componentId.clear(); slot.schemaFingerprint.clear(); slot.live = false;
#if DEHERM_HERMES_DEBUGGER
    for (uint8_t index = 0; index < slot.propertyCount; ++index)
      slot.propertyNames[index].clear();
    for (auto& trusted : slot.trustedPropertyObjects)
      trusted.reset();
    slot.propertyCount = 0;
    slot.omittedPropertyCount = 0;
#endif
    if (++slot.generation == 0) ++slot.generation;
    --liveComponents_;
  }

  uint32_t liveComponents() const { return liveComponents_; }
  uint32_t identity() const noexcept { return identity_; }

  std::string bundleFingerprint() const {
    auto value = runtime_->global().getProperty(
        *runtime_, "__DEFOLD_HERMES_BUILD_FINGERPRINT__");
    if (!value.isString()) return {};
    std::string fingerprint = value.getString(*runtime_).utf8(*runtime_);
    if (fingerprint.size() != 64) return {};
    for (const unsigned char character : fingerprint) {
      if (!std::isxdigit(character)) return {};
    }
    return fingerprint;
  }

  Telemetry telemetry() const {
    Telemetry result;
    result.callbackRoots = liveCallbacks();
    result.componentInstances = liveComponents();
    const auto heap = runtime_->instrumentation().getHeapInfo(false);
    const auto read = [&heap](const char* key) -> uint64_t {
      const auto found = heap.find(key);
      return found == heap.end() || found->second < 0
          ? 0
          : static_cast<uint64_t>(found->second);
    };
    result.heapAllocatedBytes = read("hermes_allocatedBytes");
    result.heapSizeBytes = read("hermes_heapSize");
    result.peakAllocatedBytes = read("hermes_peakAllocatedBytes");
    result.heapAvailable = heap.find("hermes_allocatedBytes") != heap.end();
    return result;
  }

  bool inspectorAvailable() const noexcept {
#if DEHERM_HERMES_DEBUGGER
    return true;
#else
    return false;
#endif
  }

  bool openInspector(Runtime::InspectorMessageCallback outbound) {
#if DEHERM_HERMES_DEBUGGER
    if (!outbound || inspectorAgent_) return false;
    {
      std::lock_guard<std::mutex> lock(inspectorMutex_);
      inspectorOutbound_ = std::move(outbound);
    }
    inspectorDebugApi_ = facebook::hermes::cdp::CDPDebugAPI::create(*runtime_);
    inspectorAgent_ = facebook::hermes::cdp::CDPAgent::create(
        static_cast<int32_t>(identity_),
        *inspectorDebugApi_,
        [this](facebook::hermes::debugger::RuntimeTask task) {
          std::lock_guard<std::mutex> lock(inspectorMutex_);
          inspectorTasks_.push_back(std::move(task));
        },
        [this](const std::string& message) {
          // Paused JavaScript cannot return to the engine safe point. Deliver
          // protocol bytes on the producing thread so the transport can see a
          // paused event and send resume/step. The callback contract is
          // therefore thread-safe; runtime tasks remain engine-owned below.
          Runtime::InspectorMessageCallback outbound;
          {
            std::lock_guard<std::mutex> lock(inspectorMutex_);
            outbound = inspectorOutbound_;
          }
          if (outbound) outbound(message);
        });
    pumpInspector();
    return true;
#else
    (void)outbound;
    return false;
#endif
  }

  void closeInspector() {
#if DEHERM_HERMES_DEBUGGER
    inspectorAgent_.reset();
    // CDPAgent destruction schedules its domain cleanup through the same task
    // queue. Drain it while both CDPDebugAPI and HermesRuntime are alive.
    pumpInspector();
    inspectorDebugApi_.reset();
    {
      std::lock_guard<std::mutex> lock(inspectorMutex_);
      inspectorOutbound_ = {};
    }
#endif
  }

  bool inspectorCommand(const std::string& command) {
#if DEHERM_HERMES_DEBUGGER
    if (!inspectorAgent_) return false;
    inspectorAgent_->handleCommand(command);
    return true;
#else
    (void)command;
    return false;
#endif
  }

  void pumpInspector() {
#if DEHERM_HERMES_DEBUGGER
    for (;;) {
      facebook::hermes::debugger::RuntimeTask task;
      {
        std::lock_guard<std::mutex> lock(inspectorMutex_);
        if (!inspectorTasks_.empty()) {
          task = std::move(inspectorTasks_.front());
          inspectorTasks_.pop_front();
        } else {
          break;
        }
      }
      task(*runtime_);
    }
#endif
  }

  std::string sampleComponentSnapshot() {
#if DEHERM_HERMES_DEBUGGER
    uint32_t omittedProperties = 0;
    for (const ComponentSlot& slot : componentSlots_) {
      if (slot.live)
        omittedProperties = saturatedAdd(omittedProperties, slot.omittedPropertyCount);
    }

    std::string instances;
    instances.reserve(4096);
    uint32_t omittedInstances = 0;
    bool firstInstance = true;
    for (uint32_t slotIndex = 0; slotIndex < componentSlots_.size(); ++slotIndex) {
      ComponentSlot& slot = componentSlots_[slotIndex];
      if (!slot.live) continue;
      const size_t checkpoint = instances.size();
      if (!firstInstance) instances.push_back(',');
      appendSnapshotInstance(instances, slotIndex, slot);
      if (instances.size() > kSnapshotInstancesByteCapacity) {
        instances.resize(checkpoint);
        for (uint32_t remaining = slotIndex; remaining < componentSlots_.size(); ++remaining)
          if (componentSlots_[remaining].live) ++omittedInstances;
        break;
      }
      firstInstance = false;
    }

    if (++snapshotSequence_ > kMaximumSafeJsonInteger) snapshotSequence_ = 1;
    const auto sampledAt = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const bool complete = omittedInstances == 0 && omittedProperties == 0;

    std::string frame;
    frame.reserve(instances.size() + 512);
    frame.append(R"({"channel":"deherm-dev-v1","payload":{"schemaVersion":1,"type":"component-snapshot","runtimeId":)");
    appendUnsigned(frame, identity_);
    frame.append(R"(,"sequence":)");
    appendUnsigned(frame, snapshotSequence_);
    frame.append(R"(,"sampledAt":)");
    appendUnsigned(frame, sampledAt < 0 ? 0 : static_cast<uint64_t>(sampledAt));
    frame.append(R"(,"complete":)");
    frame.append(complete ? "true" : "false");
    frame.append(R"(,"omitted":{"instances":)");
    appendUnsigned(frame, omittedInstances);
    frame.append(R"(,"properties":)");
    appendUnsigned(frame, omittedProperties);
    frame.append(R"(},"instances":[)");
    frame.append(instances);
    frame.append("]}}");
    if (frame.size() > kSnapshotFrameByteCapacity) return {};
    return frame;
#else
    return {};
#endif
  }

 private:
  struct ComponentSlot {
    std::optional<jsi::Object> definition;
    std::optional<jsi::Object> self;
    std::string componentId;
    std::string schemaFingerprint;
    ComponentContext context = ComponentContext::kGameObject;
    uint32_t generation = 1;
    bool live = false;
#if DEHERM_HERMES_DEBUGGER
    std::array<std::string, kSnapshotPropertyCapacity> propertyNames{};
    std::array<std::optional<jsi::Object>, kSnapshotPropertyCapacity>
        trustedPropertyObjects{};
    uint8_t propertyCount = 0;
    uint32_t omittedPropertyCount = 0;
#endif
  };

#if DEHERM_HERMES_DEBUGGER
  enum class OwnPropertyResult : uint8_t { kData, kMissing, kAccessor, kFailed };

  OwnPropertyResult ownDataProperty(
      const jsi::Object& object, const std::string& name, jsi::Value* output) {
    try {
      auto descriptor = ownPropertyDescriptor_->call(
          *runtime_, object, jsi::String::createFromUtf8(*runtime_, name));
      if (descriptor.isUndefined()) return OwnPropertyResult::kMissing;
      if (!descriptor.isObject()) return OwnPropertyResult::kFailed;
      auto descriptorObject = descriptor.asObject(*runtime_);
      auto valueDescriptor = ownPropertyDescriptor_->call(
          *runtime_, descriptorObject,
          jsi::String::createFromAscii(*runtime_, "value"));
      if (valueDescriptor.isUndefined()) return OwnPropertyResult::kAccessor;
      if (!valueDescriptor.isObject()) return OwnPropertyResult::kFailed;
      *output = descriptorObject.getProperty(*runtime_, "value");
      return OwnPropertyResult::kData;
    } catch (...) {
      return OwnPropertyResult::kFailed;
    }
  }

  OwnPropertyResult ownDataProperty(
      const jsi::Object& object, const char* name, jsi::Value* output) {
    return ownDataProperty(object, std::string(name), output);
  }

  bool appendObjectLane(
      std::string& output, const jsi::Object& object, const char* name,
      bool comma) {
    jsi::Value lane;
    if (ownDataProperty(object, name, &lane) != OwnPropertyResult::kData ||
        !lane.isBigInt()) return false;
    auto bigint = lane.getBigInt(*runtime_);
    if (!bigint.isUint64(*runtime_)) return false;
    if (comma) output.push_back(',');
    appendJsonString(output, name, std::strlen(name));
    output.push_back(':');
    appendHex64(output, bigint.asUint64(*runtime_));
    return true;
  }

  bool appendVectorLanes(
      std::string& output, const jsi::Object& object, size_t count) {
    constexpr const char* names[] = {"x", "y", "z", "w"};
    std::array<double, 4> lanes{};
    for (size_t index = 0; index < count; ++index) {
      jsi::Value lane;
      if (ownDataProperty(object, names[index], &lane) != OwnPropertyResult::kData ||
          !lane.isNumber() || !std::isfinite(lane.asNumber())) return false;
      lanes[index] = lane.asNumber();
    }
    output.append(R"(,"value":[)");
    for (size_t index = 0; index < count; ++index) {
      if (index) output.push_back(',');
      appendFiniteNumber(output, lanes[index]);
    }
    output.push_back(']');
    return true;
  }

  void appendSnapshotValue(
      std::string& output, const jsi::Value& value,
      std::optional<jsi::Object>& trustedObject) {
    if (value.isNull()) { output.append(R"({"kind":"nil"})"); return; }
    if (value.isUndefined()) { appendUnavailable(output, "undefined"); return; }
    if (value.isBool()) {
      output.append(R"({"kind":"boolean","value":)");
      output.append(value.getBool() ? "true}" : "false}");
      return;
    }
    if (value.isNumber()) {
      if (!std::isfinite(value.asNumber())) {
        appendUnavailable(output, "non-finite-number");
        return;
      }
      output.append(R"({"kind":"number","value":)");
      appendFiniteNumber(output, value.asNumber());
      output.push_back('}');
      return;
    }
    if (value.isString()) {
      std::string string = value.getString(*runtime_).utf8(*runtime_);
      if (string.size() > kSnapshotStringByteCapacity) {
        appendUnavailable(output, "string-too-long");
        return;
      }
      output.append(R"({"kind":"string","value":)");
      appendJsonString(output, string);
      output.push_back('}');
      return;
    }
    if (value.isBigInt()) {
      auto bigint = value.getBigInt(*runtime_);
      if (!bigint.isUint64(*runtime_)) {
        appendUnavailable(output, "bigint-out-of-range");
        return;
      }
      output.append(R"({"kind":"hash","value":)");
      appendHex64(output, bigint.asUint64(*runtime_));
      output.push_back('}');
      return;
    }
    if (!value.isObject()) {
      appendUnavailable(output, "unsupported-type");
      return;
    }

    auto object = value.asObject(*runtime_);
    if (object.isFunction(*runtime_)) {
      appendUnavailable(output, "unsupported-type");
      return;
    }
    // Defold-decoded structured values are retained by identity when the
    // property crosses the engine boundary. A later authored replacement may
    // be a Proxy; never reflect on it because getOwnPropertyDescriptor would
    // execute the Proxy trap on the engine thread.
    if (!trustedObject ||
        !jsi::Object::strictEquals(*runtime_, object, *trustedObject)) {
      trustedObject.reset();
      appendUnavailable(output, "untrusted-structured-value");
      return;
    }
    jsi::Value marker;
    if (ownDataProperty(object, "__dehermUrlV1", &marker) == OwnPropertyResult::kData &&
        marker.isBool() && marker.getBool()) {
      const size_t checkpoint = output.size();
      output.append(R"({"kind":"url",)");
      if (!appendObjectLane(output, object, "socket", false) ||
          !appendObjectLane(output, object, "reserved", true) ||
          !appendObjectLane(output, object, "path", true) ||
          !appendObjectLane(output, object, "fragment", true)) {
        output.resize(checkpoint);
        appendUnavailable(output, "invalid-url");
        return;
      }
      output.push_back('}');
      return;
    }

    if (ownDataProperty(object, "__dehermValueKind", &marker) == OwnPropertyResult::kData &&
        marker.isString()) {
      const std::string kind = marker.getString(*runtime_).utf8(*runtime_);
      const size_t laneCount = kind == "vector3" ? 3 :
          (kind == "vector4" || kind == "quaternion" ? 4 : 0);
      if (laneCount) {
        const size_t checkpoint = output.size();
        output.append(R"({"kind":)");
        appendJsonString(output, kind);
        if (!appendVectorLanes(output, object, laneCount)) {
          output.resize(checkpoint);
          appendUnavailable(output, "invalid-vector");
          return;
        }
        output.push_back('}');
        return;
      }
    }
    appendUnavailable(output, "unsupported-object");
  }

  void appendSnapshotInstance(
      std::string& output, uint32_t slotIndex, ComponentSlot& slot) {
    output.append(R"({"instanceId":{"slot":)");
    appendUnsigned(output, slotIndex);
    output.append(R"(,"generation":)");
    appendUnsigned(output, slot.generation);
    output.append(R"(},"componentId":)");
    appendJsonString(output, slot.componentId);
    output.append(R"(,"schemaFingerprint":)");
    appendJsonString(output, slot.schemaFingerprint);
    output.append(R"(,"contextKind":)");
    const char* context = slot.context == ComponentContext::kGameObject ? "game-object" :
        slot.context == ComponentContext::kGuiScene ? "gui-scene" :
        "render-instance+graphics";
    appendJsonString(output, context, std::strlen(context));
    output.append(R"(,"properties":[)");
    for (uint8_t index = 0; index < slot.propertyCount; ++index) {
      if (index) output.push_back(',');
      output.append(R"({"name":)");
      appendJsonString(output, slot.propertyNames[index]);
      output.append(R"(,"value":)");
      jsi::Value property;
      const OwnPropertyResult result = ownDataProperty(
          *slot.self, slot.propertyNames[index], &property);
      if (result == OwnPropertyResult::kData) {
        const bool retainedObject = property.isObject() &&
            !property.asObject(*runtime_).isFunction(*runtime_) &&
            slot.trustedPropertyObjects[index] &&
            jsi::Object::strictEquals(
                *runtime_, property.asObject(*runtime_), *slot.trustedPropertyObjects[index]);
        if (!retainedObject) slot.trustedPropertyObjects[index].reset();
        try {
          appendSnapshotValue(output, property, slot.trustedPropertyObjects[index]);
        } catch (...) {
          slot.trustedPropertyObjects[index].reset();
          appendUnavailable(output, "inspection-failed");
        }
      } else if (result == OwnPropertyResult::kMissing) {
        slot.trustedPropertyObjects[index].reset();
        appendUnavailable(output, "missing-own-property");
      } else if (result == OwnPropertyResult::kAccessor) {
        slot.trustedPropertyObjects[index].reset();
        appendUnavailable(output, "accessor-property");
      } else {
        slot.trustedPropertyObjects[index].reset();
        appendUnavailable(output, "inspection-failed");
      }
      output.push_back('}');
    }
    output.append("]}");
  }
#endif

  ComponentSlot& resolve(ComponentHandle handle) {
    if (handle.slot >= componentSlots_.size()) throw std::runtime_error("Component handle is out of range");
    ComponentSlot& slot = componentSlots_[handle.slot];
    if (!slot.live || slot.generation != handle.generation) throw std::runtime_error("Component handle is stale");
    return slot;
  }

  jsi::Value decodeComponentValue(const ComponentValue& value) {
    switch (value.kind) {
      case ComponentValueKind::kNil: return jsi::Value(nullptr);
      case ComponentValueKind::kBoolean: return jsi::Value(value.boolean);
      case ComponentValueKind::kNumber: return jsi::Value(value.number);
      case ComponentValueKind::kString:
        return jsi::String::createFromUtf8(*runtime_, reinterpret_cast<const uint8_t*>(value.string), value.stringLength);
      case ComponentValueKind::kHash:
        return jsi::Value(*runtime_, jsi::BigInt::fromUint64(*runtime_, value.lanes64[0]));
      case ComponentValueKind::kUrl: {
        jsi::Object object(*runtime_); object.setProperty(*runtime_, "__dehermUrlV1", true);
        constexpr const char* names[] = {"socket", "reserved", "path", "fragment"};
        for (size_t index = 0; index < 4; ++index)
          object.setProperty(*runtime_, names[index], jsi::Value(*runtime_, jsi::BigInt::fromUint64(*runtime_, value.lanes64[index])));
        return object;
      }
      case ComponentValueKind::kVector3:
      case ComponentValueKind::kVector4:
      case ComponentValueKind::kQuaternion: {
        jsi::Object object(*runtime_);
        const char* kind = value.kind == ComponentValueKind::kVector3 ? "vector3" : value.kind == ComponentValueKind::kVector4 ? "vector4" : "quaternion";
        object.setProperty(*runtime_, "__dehermValueKind", jsi::String::createFromAscii(*runtime_, kind));
        constexpr const char* names[] = {"x", "y", "z", "w"};
        const size_t count = value.kind == ComponentValueKind::kVector3 ? 3 : 4;
        for (size_t index = 0; index < count; ++index) object.setProperty(*runtime_, names[index], value.lanes32[index]);
        return object;
      }
      case ComponentValueKind::kObject: {
        jsi::Object object(*runtime_);
        for (uint16_t index = 0; index < value.childCount; ++index) {
          if (!value.fields || !value.fields[index].name)
            throw std::invalid_argument("Component object field storage is invalid");
          object.setProperty(*runtime_, value.fields[index].name,
              decodeComponentValue(value.fields[index].value));
        }
        return object;
      }
      case ComponentValueKind::kArray: {
        if (value.childCount && !value.elements)
          throw std::invalid_argument("Component array element storage is invalid");
        jsi::Array array(*runtime_, value.childCount);
        for (uint16_t index = 0; index < value.childCount; ++index)
          array.setValueAtIndex(*runtime_, index, decodeComponentValue(value.elements[index]));
        return array;
      }
    }
    return jsi::Value::undefined();
  }

  jsi::Value decodeComponentArgument(const ComponentArgument& argument) {
    return decodeComponentValue(argument.value);
  }

  void finalizeComponents() {
    std::exception_ptr firstFailure;
    for (uint32_t index = 0; index < componentSlots_.size(); ++index) {
      ComponentSlot& slot = componentSlots_[index];
      if (!slot.live) continue;
      try {
        dispatchComponent({index, slot.generation}, "final", nullptr, 0);
      } catch (...) {
        if (!firstFailure) firstFailure = std::current_exception();
      }
      detachComponent({index, slot.generation});
    }
    if (firstFailure) std::rethrow_exception(firstFailure);
  }

  void installHost() {
    jsi::Object hostObject(*runtime_);
    hostObject.setProperty(*runtime_, "version", 1);
    hostObject.setProperty(
        *runtime_, "runtime", jsi::String::createFromAscii(*runtime_, "hermes"));

    auto log = jsi::Function::createFromHostFunction(
        *runtime_,
        jsi::PropNameID::forAscii(*runtime_, "log"),
        2,
        [this](jsi::Runtime& runtime,
               const jsi::Value&,
               const jsi::Value* args,
               size_t count) {
          if (count < 2) throw jsi::JSError(runtime, "log(level, message) requires two arguments");
          host_.log(asString(runtime, args[0]), asString(runtime, args[1]));
          return jsi::Value::undefined();
        });
    hostObject.setProperty(*runtime_, "log", std::move(log));

    auto now = jsi::Function::createFromHostFunction(
        *runtime_,
        jsi::PropNameID::forAscii(*runtime_, "now"),
        0,
        [this](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
          return jsi::Value(host_.now());
        });
    hostObject.setProperty(*runtime_, "now", std::move(now));

    auto request = jsi::Function::createFromHostFunction(
        *runtime_,
        jsi::PropNameID::forAscii(*runtime_, "request"),
        2,
        [this](jsi::Runtime& runtime,
               const jsi::Value&,
               const jsi::Value* args,
               size_t count) {
          if (count < 2) {
            throw jsi::JSError(runtime, "request(channel, payload) requires two arguments");
          }
          auto reply = host_.request(
              asString(runtime, args[0]), asString(runtime, args[1]));
          return jsi::String::createFromUtf8(runtime, reply);
        });
    hostObject.setProperty(*runtime_, "request", std::move(request));

    runtime_->global().setProperty(*runtime_, "__defoldHostV1", std::move(hostObject));

    jsi::Object modules(*runtime_);
    installGeneratedModules(*runtime_, modules, *callbacks_);
    runtime_->global().setProperty(
        *runtime_, "__defoldModulesV1", std::move(modules));
    scriptBridgeLifetime_ = installScriptJsiBridge(*runtime_);
  }

  void callOptional(
      const char* name,
      const jsi::Value* args = nullptr,
      size_t count = 0) {
    if (!loaded_) throw std::runtime_error("No Defold Hermes bundle is loaded");
    if (!app_) return;
    auto value = app_->getProperty(*runtime_, name);
    if (value.isUndefined() || value.isNull()) return;
    if (!value.isObject() || !value.asObject(*runtime_).isFunction(*runtime_)) {
      throw jsi::JSError(
          *runtime_, std::string("Application hook is not a function: ") + name);
    }
    auto function = value.asObject(*runtime_).asFunction(*runtime_);
    function.callWithThis(*runtime_, *app_, args, count);
  }

  Host& host_;
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime_;
  uint32_t identity_ = 0;
  std::unique_ptr<CallbackRegistry> callbacks_;
  std::shared_ptr<ScriptJsiBridgeLifetime> scriptBridgeLifetime_;
  std::unique_ptr<jsi::Object> app_;
  bool loaded_ = false;
  // One slot per live TypeScript component instance. Factory-spawned game
  // objects each attach one, so a game that spawns projectiles or units from a
  // factory reaches this bound quickly; 256 was below a single tutorial scene.
  static constexpr size_t kComponentSlotCapacity = 4096;
  std::array<ComponentSlot, kComponentSlotCapacity> componentSlots_{};
  size_t componentSlotCursor_ = 0;
  uint32_t liveComponents_ = 0;
#if DEHERM_HERMES_DEBUGGER
  std::optional<jsi::Function> ownPropertyDescriptor_;
  uint64_t snapshotSequence_ = 0;
  std::unique_ptr<facebook::hermes::cdp::CDPDebugAPI> inspectorDebugApi_;
  std::unique_ptr<facebook::hermes::cdp::CDPAgent> inspectorAgent_;
  Runtime::InspectorMessageCallback inspectorOutbound_;
  std::mutex inspectorMutex_;
  std::deque<facebook::hermes::debugger::RuntimeTask> inspectorTasks_;
#endif

 public:
  bool invokeCallback(lua_bridge::Handle callback, uint32_t timer, double elapsed) {
    return callbacks_->invoke(callback, timer, elapsed);
  }
  bool releaseCallback(lua_bridge::Handle callback) {
    return callbacks_->release(callback);
  }
  const char* callbackError() const { return callbacks_->lastError(); }
  uint32_t liveCallbacks() const { return callbacks_->stats().live; }
};

Runtime::Runtime(Host& host) : impl_(std::make_unique<Impl>(host)) {}
Runtime::~Runtime() = default;
void Runtime::load(const std::string& source, const std::string& sourceUrl) {
  impl_->pumpInspector();
  impl_->load(source, sourceUrl);
  impl_->pumpInspector();
}
void Runtime::evaluateStaticUnits(
    const StaticUnitCreator* unitCreators,
    size_t unitCount) {
  impl_->pumpInspector();
  impl_->evaluateStaticUnits(unitCreators, unitCount);
  impl_->pumpInspector();
}
void Runtime::loadStatic(
    const StaticUnitCreator* unitCreators,
    size_t unitCount,
    const std::string& sourceUrl) {
  impl_->pumpInspector();
  impl_->loadStatic(unitCreators, unitCount, sourceUrl);
  impl_->pumpInspector();
}
void Runtime::init() { impl_->pumpInspector(); impl_->init(); impl_->pumpInspector(); }
void Runtime::update(double dt) { impl_->pumpInspector(); impl_->update(dt); impl_->pumpInspector(); }
void Runtime::onMessage(const std::string& message) { impl_->pumpInspector(); impl_->onMessage(message); impl_->pumpInspector(); }
void Runtime::finalize() { impl_->pumpInspector(); impl_->finalize(); impl_->pumpInspector(); }
bool Runtime::invokeCallback(lua_bridge::Handle callback, uint32_t timer, double elapsed) {
  return impl_->invokeCallback(callback, timer, elapsed);
}
bool Runtime::releaseCallback(lua_bridge::Handle callback) {
  return impl_->releaseCallback(callback);
}
const char* Runtime::callbackError() const { return impl_->callbackError(); }
uint32_t Runtime::liveCallbacks() const { return impl_->liveCallbacks(); }
std::string Runtime::bundleFingerprint() const { return impl_->bundleFingerprint(); }
Runtime::Telemetry Runtime::telemetry() const { return impl_->telemetry(); }
bool Runtime::inspectorAvailable() const noexcept { return impl_->inspectorAvailable(); }
bool Runtime::openInspector(InspectorMessageCallback outbound) {
  return impl_->openInspector(std::move(outbound));
}
void Runtime::closeInspector() { impl_->closeInspector(); }
bool Runtime::inspectorCommand(const std::string& command) {
  return impl_->inspectorCommand(command);
}
void Runtime::pumpInspector() { impl_->pumpInspector(); }
std::string Runtime::sampleComponentSnapshot() { return impl_->sampleComponentSnapshot(); }
Runtime::ComponentHandle Runtime::attachComponent(const char* id, const char* schema, ComponentContext context) { return impl_->attachComponent(id, schema, context); }
void Runtime::setComponentProperty(ComponentHandle handle, const char* name, const ComponentValue& value) { impl_->setComponentProperty(handle, name, value); }
bool Runtime::dispatchComponent(ComponentHandle handle, const char* lifecycle, const ComponentArgument* arguments, uint8_t count) { return impl_->dispatchComponent(handle, lifecycle, arguments, count); }
void Runtime::reloadComponent(ComponentHandle handle) { impl_->reloadComponent(handle); }
void Runtime::detachComponent(ComponentHandle handle) { impl_->detachComponent(handle); }
uint32_t Runtime::liveComponents() const { return impl_->liveComponents(); }
uint32_t Runtime::identity() const noexcept { return impl_->identity(); }

}  // namespace defold_hermes

#endif  // !DM_PLATFORM_HTML5
