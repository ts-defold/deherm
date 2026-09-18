#include <defold_hermes/lua_bridge.hpp>

#include <cstdio>
#include <cstring>
#include <limits>

namespace defold_hermes::lua_bridge {
namespace {

int RawRef(lua_State* state) {
  return luaL_ref(state, LUA_REGISTRYINDEX);
}

void RawUnref(lua_State* state, int reference) {
  luaL_unref(state, LUA_REGISTRYINDEX, reference);
}

int RawPCall(lua_State* state, int argumentCount, int resultCount) {
  return lua_pcall(state, argumentCount, resultCount, 0);
}

}  // namespace

LuaBridge::LuaBridge(size_t scratchCapacity, uint32_t handleCapacity, uint32_t timerCapacity)
    : scratch_(scratchCapacity),
      handles_(handleCapacity),
      timerCallbacks_(timerCapacity) {}

LuaBridge::~LuaBridge() {
  shutdown();
}

RegistryApi LuaBridge::rawRegistryApi() {
  return {RawRef, RawUnref, RawPCall};
}

bool LuaBridge::initialize(
    lua_State* state,
    const BindingDescriptor* bindings,
    uint32_t bindingCount,
    uint32_t stackReserve,
    RegistryApi registryApi,
    InstanceApi instanceApi) {
  shutdown();
  if (!state || !bindings || !registryApi.ref || !registryApi.unref || !registryApi.pcall) {
    setError("invalid Lua bridge initialization arguments");
    return false;
  }
  if (!lua_checkstack(state, static_cast<int>(stackReserve))) {
    setError("unable to reserve Lua stack capacity");
    return false;
  }

  state_ = state;
  registryApi_ = registryApi;
  instanceApi_ = instanceApi;
  functionRefs_.reset(bindingCount ? new int[bindingCount] : nullptr);
  functionCount_ = bindingCount;
  for (uint32_t index = 0; index < bindingCount; ++index) functionRefs_[index] = LUA_NOREF;

  const int top = lua_gettop(state_);
  for (uint32_t index = 0; index < bindingCount; ++index) {
    lua_getglobal(state_, bindings[index].module);
    if (!lua_istable(state_, -1)) {
      std::snprintf(error_, sizeof(error_), "Lua module is not registered: %s", bindings[index].module);
      lua_settop(state_, top);
      shutdown();
      return false;
    }
    lua_getfield(state_, -1, bindings[index].function);
    if (!lua_isfunction(state_, -1)) {
      std::snprintf(
          error_, sizeof(error_), "Lua function is not registered: %s.%s",
          bindings[index].module, bindings[index].function);
      lua_settop(state_, top);
      shutdown();
      return false;
    }
    functionRefs_[index] = registryApi_.ref(state_);
    lua_pop(state_, 1);
  }
  lua_settop(state_, top);
  stats_.cachedFunctions = bindingCount;
  stats_.reservedStackSlots = stackReserve;
  error_[0] = '\0';
  return true;
}

void LuaBridge::shutdown() {
  releaseAllTimerCallbacks();
  if (state_ && registryApi_.unref) {
    if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
      registryApi_.unref(state_, instanceRef_);
    }
    for (uint32_t index = 0; index < functionCount_; ++index) {
      const int reference = functionRefs_[index];
      if (reference != LUA_NOREF && reference != LUA_REFNIL) {
        registryApi_.unref(state_, reference);
      }
    }
  }
  instanceRef_ = LUA_NOREF;
  functionRefs_.reset();
  functionCount_ = 0;
  stats_.cachedFunctions = 0;
  state_ = nullptr;
  registryApi_ = {};
  instanceApi_ = {};
  callbackApi_ = {};
}

bool LuaBridge::captureInstance(int index) {
  if (!state_) {
    setError("Lua bridge is not initialized");
    return false;
  }
  if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    registryApi_.unref(state_, instanceRef_);
  }
  lua_pushvalue(state_, index);
  instanceRef_ = registryApi_.ref(state_);
  if (instanceRef_ == LUA_NOREF || instanceRef_ == LUA_REFNIL) {
    setError("unable to capture Defold script instance");
    return false;
  }
  return true;
}

void LuaBridge::detachInstance() {
  if (state_ && registryApi_.unref &&
      instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    registryApi_.unref(state_, instanceRef_);
  }
  instanceRef_ = LUA_NOREF;
}

void LuaBridge::setError(const char* message) {
  std::snprintf(error_, sizeof(error_), "%s", message ? message : "unknown Lua bridge error");
}

bool LuaBridge::pushFunction(uint32_t binding) {
  if (!state_ || binding >= functionCount_) {
    setError("invalid generated Lua binding id");
    return false;
  }
  const int reference = functionRefs_[binding];
  if (reference == LUA_NOREF || reference == LUA_REFNIL) {
    setError("generated Lua binding is not cached");
    return false;
  }
  lua_rawgeti(state_, LUA_REGISTRYINDEX, reference);
  return true;
}

bool LuaBridge::trackTimerCallback(uint32_t timer, Handle callback, bool repeating) {
  if (!callbackApi_.invoke || !callbackApi_.release) {
    setError("timer callback API is not installed");
    return false;
  }
  if (!timerCallbacks_.insert(timer, callback, repeating)) {
    setError("timer callback table is exhausted");
    return false;
  }
  return true;
}

bool LuaBridge::releaseTimerCallback(uint32_t timer) {
  TimerCallbackRecord record;
  if (!timerCallbacks_.erase(timer, &record)) return false;
  if (callbackApi_.release) callbackApi_.release(callbackApi_.context, record.callback);
  return true;
}

uint32_t LuaBridge::releaseAllTimerCallbacks() {
  return timerCallbacks_.sweep([this](const TimerCallbackRecord& record) {
    if (callbackApi_.release) callbackApi_.release(callbackApi_.context, record.callback);
  });
}

bool LuaBridge::dispatchTimerCallback(
    Handle callback,
    bool repeating,
    uint32_t timer,
    double elapsed) {
  const bool invoked = callbackApi_.invoke &&
      callbackApi_.invoke(callbackApi_.context, callback, timer, elapsed);
  // A one-shot callback owns no state after its first dispatch attempt, even
  // when user code throws. Releasing before propagating the Lua error prevents
  // a failed callback from pinning its Hermes function until shutdown.
  if (!repeating) releaseTimerCallback(timer);
  if (!invoked) {
    setError("JavaScript timer callback dispatch failed");
    return false;
  }
  return true;
}

int LuaBridge::timerCallbackThunk(lua_State* state) {
  auto* bridge = static_cast<LuaBridge*>(lua_touserdata(state, lua_upvalueindex(1)));
  Handle callback;
  callback.runtime = static_cast<uint32_t>(lua_tonumber(state, lua_upvalueindex(2)));
  callback.slot = static_cast<uint32_t>(lua_tonumber(state, lua_upvalueindex(3)));
  callback.generation = static_cast<uint32_t>(lua_tonumber(state, lua_upvalueindex(4)));
  callback.type = static_cast<uint32_t>(lua_tonumber(state, lua_upvalueindex(5)));
  const bool repeating = lua_toboolean(state, lua_upvalueindex(6)) != 0;
  const uint32_t timer = static_cast<uint32_t>(luaL_checknumber(state, 2));
  const double elapsed = static_cast<double>(luaL_checknumber(state, 3));
  if (!bridge || !bridge->dispatchTimerCallback(callback, repeating, timer, elapsed)) {
    return luaL_error(state, "%s", bridge ? bridge->lastError() : "Lua bridge is unavailable");
  }
  return 0;
}

LuaCall::LuaCall(LuaBridge& bridge, uint32_t binding)
    : bridge_(bridge), state_(bridge.state_) {
  if (!state_) {
    bridge_.setError("Lua bridge is not initialized");
    return;
  }
  baseTop_ = lua_gettop(state_);
  if (bridge_.instanceApi_.get || bridge_.instanceApi_.set) {
    if (!bridge_.instanceApi_.get || !bridge_.instanceApi_.set ||
        bridge_.instanceRef_ == LUA_NOREF || bridge_.instanceRef_ == LUA_REFNIL) {
      bridge_.setError("Defold instance bridge is configured but no instance is captured");
      return;
    }
    bridge_.instanceApi_.get(state_);
    lua_rawgeti(state_, LUA_REGISTRYINDEX, bridge_.instanceRef_);
    bridge_.instanceApi_.set(state_);
    instanceActive_ = true;
  }
  ready_ = bridge_.pushFunction(binding);
}

LuaCall::~LuaCall() {
  if (!state_) return;
  if (instanceActive_) {
    lua_settop(state_, baseTop_ + 1);
    bridge_.instanceApi_.set(state_);
  }
  lua_settop(state_, baseTop_);
}

void LuaCall::pushBoolean(bool value) {
  lua_pushboolean(state_, value ? 1 : 0);
}

void LuaCall::pushU32(uint32_t value) {
  lua_pushnumber(state_, static_cast<lua_Number>(value));
}

void LuaCall::pushF64(double value) {
  lua_pushnumber(state_, static_cast<lua_Number>(value));
}

void LuaCall::pushString(const char* data, size_t size) {
  lua_pushlstring(state_, data, size);
}

void LuaCall::pushTimerCallback(Handle callback, bool repeating) {
  lua_pushlightuserdata(state_, &bridge_);
  lua_pushnumber(state_, callback.runtime);
  lua_pushnumber(state_, callback.slot);
  lua_pushnumber(state_, callback.generation);
  lua_pushnumber(state_, callback.type);
  lua_pushboolean(state_, repeating ? 1 : 0);
  lua_pushcclosure(state_, LuaBridge::timerCallbackThunk, 6);
}

bool LuaCall::invoke(int argumentCount, int resultCount) {
  if (!ready_ || invoked_) return false;
  ++bridge_.stats_.calls;
  const int status = bridge_.registryApi_.pcall(state_, argumentCount, resultCount);
  invoked_ = true;
  if (status != 0) {
    const char* message = lua_tostring(state_, -1);
    bridge_.setError(message ? message : "Lua call failed without an error string");
    ++bridge_.stats_.failures;
    return false;
  }
  resultCount_ = resultCount;
  resultBase_ = lua_gettop(state_) - resultCount + 1;
  return true;
}

int LuaCall::absoluteResultIndex(int resultIndex) const {
  if (!invoked_ || resultIndex < 0 || resultIndex >= resultCount_) return 0;
  return resultBase_ + resultIndex;
}

bool LuaCall::readBoolean(int resultIndex, bool* out) {
  const int index = absoluteResultIndex(resultIndex);
  if (!out || index == 0 || !lua_isboolean(state_, index)) {
    bridge_.setError("Lua result is not a boolean");
    return false;
  }
  *out = lua_toboolean(state_, index) != 0;
  return true;
}

bool LuaCall::readU32(int resultIndex, uint32_t* out) {
  const int index = absoluteResultIndex(resultIndex);
  if (!out || index == 0 || !lua_isnumber(state_, index)) {
    bridge_.setError("Lua result is not an unsigned integer");
    return false;
  }
  const lua_Number value = lua_tonumber(state_, index);
  if (value < 0 || value > std::numeric_limits<uint32_t>::max() || value != static_cast<uint32_t>(value)) {
    bridge_.setError("Lua result is outside the u32 range");
    return false;
  }
  *out = static_cast<uint32_t>(value);
  return true;
}

bool LuaCall::readF64(int resultIndex, double* out) {
  const int index = absoluteResultIndex(resultIndex);
  if (!out || index == 0 || !lua_isnumber(state_, index)) {
    bridge_.setError("Lua result is not a number");
    return false;
  }
  *out = static_cast<double>(lua_tonumber(state_, index));
  return true;
}

}  // namespace defold_hermes::lua_bridge
