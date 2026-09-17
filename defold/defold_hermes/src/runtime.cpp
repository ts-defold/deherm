#include <defold_hermes/runtime.hpp>
#include <defold_hermes/callback_registry.hpp>
#include <defold_hermes/generated_jsi.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <memory>
#include <stdexcept>
#include <utility>

#include <hermes/hermes.h>
#include <jsi/jsi.h>

namespace jsi = facebook::jsi;

namespace defold_hermes {

namespace {

std::string asString(jsi::Runtime& runtime, const jsi::Value& value) {
  return value.toString(runtime).utf8(runtime);
}

}  // namespace

class Runtime::Impl {
 public:
  explicit Impl(Host& host)
      : host_(host), runtime_(facebook::hermes::makeHermesRuntime()) {
    callbacks_ = std::make_unique<CallbackRegistry>(*runtime_, 4096);
    installHost();
  }

  void load(const std::string& source, const std::string& sourceUrl) {
    if (app_) throw std::runtime_error("A Defold Hermes application is already loaded");

    auto buffer = std::make_shared<jsi::StringBuffer>(source);
    runtime_->evaluateJavaScript(buffer, sourceUrl);
    auto value = runtime_->global().getProperty(*runtime_, "__defoldAppV1");
    if (!value.isObject()) throw jsi::JSError(*runtime_, "Application did not register");
    app_ = std::make_unique<jsi::Object>(value.asObject(*runtime_));
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
    try {
      callOptional("final");
    } catch (...) {
      app_.reset();
      throw;
    }
    app_.reset();
  }

 private:
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
  }

  void callOptional(
      const char* name,
      const jsi::Value* args = nullptr,
      size_t count = 0) {
    if (!app_) throw std::runtime_error("No Defold Hermes application is loaded");
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
  std::unique_ptr<CallbackRegistry> callbacks_;
  std::unique_ptr<jsi::Object> app_;

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

}  // namespace defold_hermes

#endif  // !DM_PLATFORM_HTML5
