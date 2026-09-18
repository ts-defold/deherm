#include <defold_hermes/runtime.hpp>
#include <defold_hermes/callback_registry.hpp>
#include <defold_hermes/generated_jsi.hpp>
#include <defold_hermes/script_jsi_bridge.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <memory>
#include <atomic>
#include <array>
#include <exception>
#include <optional>
#include <stdexcept>
#include <utility>

#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <jsi/hermes-interfaces.h>

namespace jsi = facebook::jsi;

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

}  // namespace

class Runtime::Impl {
 public:
  explicit Impl(Host& host)
      : host_(host), runtime_(facebook::hermes::makeHermesRuntime()), identity_(acquireRuntimeId()) {
    callbacks_ = std::make_unique<CallbackRegistry>(
        *runtime_, 4096, identity_);
    installHost();
  }

  void load(const std::string& source, const std::string& sourceUrl) {
    if (loaded_) throw std::runtime_error("A Defold Hermes application is already loaded");

    auto buffer = std::make_shared<jsi::StringBuffer>(source);
    runtime_->evaluateJavaScript(buffer, sourceUrl);
    captureEntrypoints();
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
    size_t slotIndex = componentSlots_.size();
    for (size_t index = 0; index < componentSlots_.size(); ++index) if (!componentSlots_[index].live) { slotIndex = index; break; }
    if (slotIndex == componentSlots_.size()) throw std::runtime_error("Component instance pool is exhausted");
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
    ++liveComponents_;
    return {static_cast<uint32_t>(slotIndex), slot.generation};
  }

  void setComponentProperty(ComponentHandle handle, const char* name, const ComponentValue& value) {
    ComponentSlot& slot = resolve(handle);
    if (!name) throw std::invalid_argument("Component property name is null");
    slot.self->setProperty(*runtime_, name, decodeComponentValue(value));
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
    if (++slot.generation == 0) ++slot.generation;
    --liveComponents_;
  }

  uint32_t liveComponents() const { return liveComponents_; }
  uint32_t identity() const noexcept { return identity_; }

 private:
  struct ComponentSlot {
    std::optional<jsi::Object> definition;
    std::optional<jsi::Object> self;
    std::string componentId;
    std::string schemaFingerprint;
    ComponentContext context = ComponentContext::kGameObject;
    uint32_t generation = 1;
    bool live = false;
  };

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
    }
    return jsi::Value::undefined();
  }

  jsi::Value decodeComponentArgument(const ComponentArgument& argument) {
    if (!argument.fields) return decodeComponentValue(argument.value);
    jsi::Object object(*runtime_);
    for (uint8_t index = 0; index < argument.fieldCount; ++index) {
      if (!argument.fields[index].name) throw std::invalid_argument("Component table field has no name");
      object.setProperty(*runtime_, argument.fields[index].name, decodeComponentValue(argument.fields[index].value));
    }
    return object;
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
    installScriptJsiBridge(*runtime_);
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
  std::unique_ptr<jsi::Runtime> runtime_;
  uint32_t identity_ = 0;
  std::unique_ptr<CallbackRegistry> callbacks_;
  std::unique_ptr<jsi::Object> app_;
  bool loaded_ = false;
  std::array<ComponentSlot, 256> componentSlots_{};
  uint32_t liveComponents_ = 0;

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
  impl_->load(source, sourceUrl);
}
void Runtime::loadStatic(
    const StaticUnitCreator* unitCreators,
    size_t unitCount,
    const std::string& sourceUrl) {
  impl_->loadStatic(unitCreators, unitCount, sourceUrl);
}
void Runtime::init() { impl_->init(); }
void Runtime::update(double dt) { impl_->update(dt); }
void Runtime::onMessage(const std::string& message) { impl_->onMessage(message); }
void Runtime::finalize() { impl_->finalize(); }
bool Runtime::invokeCallback(lua_bridge::Handle callback, uint32_t timer, double elapsed) {
  return impl_->invokeCallback(callback, timer, elapsed);
}
bool Runtime::releaseCallback(lua_bridge::Handle callback) {
  return impl_->releaseCallback(callback);
}
const char* Runtime::callbackError() const { return impl_->callbackError(); }
uint32_t Runtime::liveCallbacks() const { return impl_->liveCallbacks(); }
Runtime::ComponentHandle Runtime::attachComponent(const char* id, const char* schema, ComponentContext context) { return impl_->attachComponent(id, schema, context); }
void Runtime::setComponentProperty(ComponentHandle handle, const char* name, const ComponentValue& value) { impl_->setComponentProperty(handle, name, value); }
bool Runtime::dispatchComponent(ComponentHandle handle, const char* lifecycle, const ComponentArgument* arguments, uint8_t count) { return impl_->dispatchComponent(handle, lifecycle, arguments, count); }
void Runtime::reloadComponent(ComponentHandle handle) { impl_->reloadComponent(handle); }
void Runtime::detachComponent(ComponentHandle handle) { impl_->detachComponent(handle); }
uint32_t Runtime::liveComponents() const { return impl_->liveComponents(); }
uint32_t Runtime::identity() const noexcept { return impl_->identity(); }

}  // namespace defold_hermes

#endif  // !DM_PLATFORM_HTML5
