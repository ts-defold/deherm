#pragma once

#if !defined(DM_PLATFORM_HTML5)

#include <defold_hermes/component_proxy_lua_gate.hpp>
#include <defold_hermes/runtime.hpp>

namespace defold_hermes::lua_bridge::scalar { class ScriptAdapter; }

namespace defold_hermes::component_proxy {

class HermesBackend {
 public:
  using RuntimeProvider = Runtime* (*)(void* context) noexcept;
  using AdapterProvider = lua_bridge::scalar::ScriptAdapter* (*)(void* context) noexcept;
  using EnsureRuntime = bool (*)(void* context, lua_State* state) noexcept;
  HermesBackend(void* context, RuntimeProvider provider,
      AdapterProvider adapterProvider = nullptr,
      EnsureRuntime ensureRuntime = nullptr) noexcept
      : context_(context), provider_(provider), adapterProvider_(adapterProvider), ensureRuntime_(ensureRuntime) {}
  BackendApi api() noexcept;

 private:
  static uint32_t Revision(void*) noexcept;
  static bool Attach(void*, const AttachRequest&, ComponentHandle*, char*, size_t) noexcept;
  static bool Dispatch(void*, const DispatchRequest&, bool*, char*, size_t) noexcept;
  static void Detach(void*, ComponentHandle) noexcept;
  Runtime* runtime() const noexcept { return provider_ ? provider_(context_) : nullptr; }
  lua_bridge::scalar::ScriptAdapter* adapter() const noexcept {
    return adapterProvider_ ? adapterProvider_(context_) : nullptr;
  }
  void* context_ = nullptr;
  RuntimeProvider provider_ = nullptr;
  AdapterProvider adapterProvider_ = nullptr;
  EnsureRuntime ensureRuntime_ = nullptr;
};

}  // namespace defold_hermes::component_proxy
#endif
