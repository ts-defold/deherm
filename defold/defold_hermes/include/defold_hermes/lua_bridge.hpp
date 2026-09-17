#pragma once

#include <defold_hermes/lua_bridge_core.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <dmsdk/lua/lua.h>
}

namespace defold_hermes::lua_bridge {

struct BindingDescriptor {
  const char* module;
  const char* function;
};

struct RegistryApi {
  int (*ref)(lua_State* state);
  void (*unref)(lua_State* state, int reference);
  int (*pcall)(lua_State* state, int argumentCount, int resultCount);
};

struct InstanceApi {
  void (*get)(lua_State* state);
  void (*set)(lua_State* state);
};

struct CallbackApi {
  void* context = nullptr;
  bool (*invoke)(void* context, Handle callback, uint32_t timer, double elapsed) = nullptr;
  void (*release)(void* context, Handle callback) = nullptr;
};

struct BridgeStats {
  uint64_t calls = 0;
  uint64_t failures = 0;
  uint32_t cachedFunctions = 0;
  uint32_t reservedStackSlots = 0;
};

class LuaBridge;

/** Restores the Lua stack and current Defold instance on every exit path. */
class LuaCall {
 public:
  LuaCall(LuaBridge& bridge, uint32_t binding);
  ~LuaCall();

  LuaCall(const LuaCall&) = delete;
  LuaCall& operator=(const LuaCall&) = delete;

  explicit operator bool() const { return ready_; }
  lua_State* state() const { return state_; }

  void pushBoolean(bool value);
  void pushU32(uint32_t value);
  void pushF64(double value);
  void pushString(const char* data, size_t size);
  void pushTimerCallback(Handle callback, bool repeating);

  bool invoke(int argumentCount, int resultCount);
  bool readBoolean(int resultIndex, bool* out);
  bool readU32(int resultIndex, uint32_t* out);
  bool readF64(int resultIndex, double* out);

 private:
  int absoluteResultIndex(int resultIndex) const;

  LuaBridge& bridge_;
  lua_State* state_ = nullptr;
  int baseTop_ = 0;
  int resultBase_ = 0;
  int resultCount_ = 0;
  bool instanceActive_ = false;
  bool ready_ = false;
  bool invoked_ = false;
};

class LuaBridge {
 public:
  LuaBridge(size_t scratchCapacity, uint32_t handleCapacity, uint32_t timerCapacity = 4096);
  ~LuaBridge();

  LuaBridge(const LuaBridge&) = delete;
  LuaBridge& operator=(const LuaBridge&) = delete;

  bool initialize(
      lua_State* state,
      const BindingDescriptor* bindings,
      uint32_t bindingCount,
      uint32_t stackReserve,
      RegistryApi registryApi,
      InstanceApi instanceApi = {});
  void shutdown();

  bool captureInstance(int index);
  void installCallbackApi(CallbackApi api) { callbackApi_ = api; }
  bool trackTimerCallback(uint32_t timer, Handle callback, bool repeating);
  bool releaseTimerCallback(uint32_t timer);
  uint32_t releaseAllTimerCallbacks();
  LuaCall beginCall(uint32_t binding) { return LuaCall(*this, binding); }

  const char* lastError() const { return error_; }
  const BridgeStats& stats() const { return stats_; }
  ScratchArena& scratch() { return scratch_; }
  HandlePool& handles() { return handles_; }
  TimerCallbackTable& timerCallbacks() { return timerCallbacks_; }

  static RegistryApi rawRegistryApi();

 private:
  friend class LuaCall;

  void setError(const char* message);
  bool pushFunction(uint32_t binding);
  static int timerCallbackThunk(lua_State* state);
  bool dispatchTimerCallback(Handle callback, bool repeating, uint32_t timer, double elapsed);

  lua_State* state_ = nullptr;
  RegistryApi registryApi_{};
  InstanceApi instanceApi_{};
  std::unique_ptr<int[]> functionRefs_;
  uint32_t functionCount_ = 0;
  int instanceRef_ = LUA_NOREF;
  char error_[512]{};
  BridgeStats stats_;
  CallbackApi callbackApi_{};
  ScratchArena scratch_;
  HandlePool handles_;
  TimerCallbackTable timerCallbacks_;
};

}  // namespace defold_hermes::lua_bridge
