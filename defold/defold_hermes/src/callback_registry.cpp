#include <defold_hermes/callback_registry.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <cstdio>
#include <exception>
#include <utility>

namespace defold_hermes {

CallbackRegistry::CallbackRegistry(facebook::jsi::Runtime& runtime, uint32_t capacity)
    : runtime_(runtime),
      handles_(capacity),
      functions_(capacity ? new std::optional<facebook::jsi::Function>[capacity] : nullptr) {}

CallbackRegistry::~CallbackRegistry() {
  sweep();
}

lua_bridge::Handle CallbackRegistry::acquire(facebook::jsi::Function function) {
  const lua_bridge::Handle handle = handles_.acquire(
      kRuntime, kTimerCallbackType, this, 0);
  if (!handle) {
    std::snprintf(error_, sizeof(error_), "Hermes callback pool is exhausted");
    return {};
  }
  functions_[handle.slot].emplace(std::move(function));
  return handle;
}

bool CallbackRegistry::invoke(
    lua_bridge::Handle callback,
    uint32_t timer,
    double elapsed) {
  lua_bridge::HandleRecord record;
  if (!handles_.resolve(callback, &record) || !functions_[callback.slot]) {
    std::snprintf(error_, sizeof(error_), "Hermes callback handle is stale");
    return false;
  }
  try {
    functions_[callback.slot]->call(
        runtime_,
        facebook::jsi::Value(static_cast<double>(timer)),
        facebook::jsi::Value(elapsed));
    return true;
  } catch (const std::exception& error) {
    std::snprintf(error_, sizeof(error_), "%s", error.what());
    return false;
  }
}

bool CallbackRegistry::release(lua_bridge::Handle callback) {
  return handles_.release(callback, [this, callback](const lua_bridge::HandleRecord&) {
    functions_[callback.slot].reset();
  });
}

uint32_t CallbackRegistry::sweep() {
  for (uint32_t slot = 0; slot < handles_.stats().capacity; ++slot) {
    functions_[slot].reset();
  }
  return handles_.sweep([](const lua_bridge::HandleRecord&) {});
}

}  // namespace defold_hermes

#endif
