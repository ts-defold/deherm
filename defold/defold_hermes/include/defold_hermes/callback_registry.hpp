#pragma once

#include <defold_hermes/lua_bridge_core.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <jsi/jsi.h>

#include <cstdint>
#include <memory>
#include <optional>

namespace defold_hermes {

class CallbackRegistry {
 public:
  CallbackRegistry(facebook::jsi::Runtime& runtime, uint32_t capacity);
  ~CallbackRegistry();

  lua_bridge::Handle acquire(facebook::jsi::Function function);
  bool invoke(lua_bridge::Handle callback, uint32_t timer, double elapsed);
  bool release(lua_bridge::Handle callback);
  uint32_t sweep();

  const char* lastError() const { return error_; }
  const lua_bridge::HandlePoolStats& stats() const { return handles_.stats(); }

 private:
  static constexpr uint32_t kRuntime = 1;
  static constexpr uint32_t kTimerCallbackType = 1;

  facebook::jsi::Runtime& runtime_;
  lua_bridge::HandlePool handles_;
  std::unique_ptr<std::optional<facebook::jsi::Function>[]> functions_;
  char error_[512]{};
};

}  // namespace defold_hermes

#endif
