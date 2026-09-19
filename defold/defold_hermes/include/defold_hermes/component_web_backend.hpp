#pragma once

#if defined(DM_PLATFORM_HTML5)

#include <defold_hermes/component_proxy_lua_gate.hpp>

namespace defold_hermes::lua_bridge::scalar { class ScriptAdapter; }

namespace defold_hermes::component_proxy {

/**
 * Browser-host implementation of the generated component attachment contract.
 *
 * The Lua proxies execute inside the Defold Wasm module; the TypeScript
 * component definitions execute in the browser's own JavaScript engine. This
 * backend encodes the Lua-side attachment and lifecycle values into the
 * generated universal wire format and hands them to the browser component
 * provider, which owns the slot pool and `self` objects exactly the way
 * `runtime.cpp` owns them for dynamic Hermes.
 */
class WebBackend {
 public:
  using AdapterProvider = lua_bridge::scalar::ScriptAdapter* (*)(void* context) noexcept;
  using EnsureRuntime = bool (*)(void* context, lua_State* state) noexcept;

  WebBackend(void* context, AdapterProvider adapterProvider, EnsureRuntime ensureRuntime) noexcept
      : context_(context), adapterProvider_(adapterProvider), ensureRuntime_(ensureRuntime) {}

  BackendApi api() noexcept;

 private:
  static uint32_t Revision(void*) noexcept;
  static bool Attach(void*, const AttachRequest&, ComponentHandle*, char*, size_t) noexcept;
  static bool Dispatch(void*, const DispatchRequest&, bool*, char*, size_t) noexcept;
  static void Detach(void*, ComponentHandle) noexcept;

  lua_bridge::scalar::ScriptAdapter* adapter() const noexcept {
    return adapterProvider_ ? adapterProvider_(context_) : nullptr;
  }

  void* context_ = nullptr;
  AdapterProvider adapterProvider_ = nullptr;
  EnsureRuntime ensureRuntime_ = nullptr;
};

}  // namespace defold_hermes::component_proxy

#endif  // DM_PLATFORM_HTML5
