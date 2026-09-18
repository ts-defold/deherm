#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include <defold_hermes/generated_component_proxy_capability.hpp>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <dmsdk/lua/lua.h>
}

namespace defold_hermes::component_proxy {

enum class ContextKind : uint8_t { kGameObject, kGuiScene, kRender };
enum class EventKind : uint8_t { kLifecycle, kMessage, kInput, kReload };

struct ComponentHandle {
  uint32_t slot = UINT32_MAX;
  uint32_t generation = 0;
  explicit operator bool() const noexcept { return slot != UINT32_MAX; }
};

struct AttachRequest {
  lua_State* state = nullptr;
  const char* componentId = nullptr;
  const char* schemaFingerprint = nullptr;
  ContextKind context = ContextKind::kGameObject;
  int selfIndex = 0;
  int propertySpecializationsIndex = 0;
};

struct DispatchRequest {
  lua_State* state = nullptr;
  ComponentHandle handle{};
  const char* componentId = nullptr;
  ContextKind context = ContextKind::kGameObject;
  EventKind event = EventKind::kLifecycle;
  const char* lifecycle = nullptr;
  int argumentStart = 0;
  uint8_t argumentCount = 0;
};

struct BackendApi {
  void* context = nullptr;
  uint32_t (*revision)(void* context) noexcept = nullptr;
  bool (*attach)(void* context, const AttachRequest& request, ComponentHandle* output,
      char* error, size_t errorCapacity) noexcept = nullptr;
  bool (*dispatch)(void* context, const DispatchRequest& request, bool* inputConsumed,
      char* error, size_t errorCapacity) noexcept = nullptr;
  void (*detach)(void* context, ComponentHandle handle) noexcept = nullptr;
};

struct InstanceApi {
  void (*get)(lua_State* state) = nullptr;
  void (*set)(lua_State* state) = nullptr;
};

/** Fixed-capacity executable attachment provider for generated component proxies. */
class LuaRuntime {
 public:
  static constexpr uint32_t kCapacity = 256;
  static constexpr size_t kComponentIdCapacity = 128;
  static constexpr size_t kSchemaCapacity = 65;

  LuaRuntime(BackendApi backend, InstanceApi instanceApi) noexcept
      : backend_(backend), instanceApi_(instanceApi) { protectedRefs_.fill(LUA_NOREF); }
  ~LuaRuntime() { shutdown(); }
  LuaRuntime(const LuaRuntime&) = delete;
  LuaRuntime& operator=(const LuaRuntime&) = delete;

  bool valid() const noexcept {
    return backend_.revision && backend_.attach && backend_.dispatch && backend_.detach && instanceApi_.get && instanceApi_.set;
  }

  void registerLuaApi(lua_State* state) noexcept {
    if (!state) return;
    for (Slot& slot : slots_) {
      if (slot.rootReference != LUA_NOREF && slot.rootReference != LUA_REFNIL) continue;
      lua_createtable(state, 2, 0);
      lua_pushboolean(state, 0); lua_rawseti(state, -2, 1);
      lua_pushboolean(state, 0); lua_rawseti(state, -2, 2);
      slot.rootReference = luaL_ref(state, LUA_REGISTRYINDEX);
    }
    lua_getglobal(state, kLuaModuleName);
    if (!lua_istable(state, -1)) { lua_pop(state, 1); lua_newtable(state); }
    struct Method { const char* name; lua_CFunction function; lua_CFunction protectedFunction; uint8_t index; };
    const Method methods[] = {
      {"attachComponent", Attach, AttachProtected, 0},
      {"dispatchLifecycle", DispatchLifecycle, DispatchLifecycleProtected, 1},
      {"dispatchMessage", DispatchMessage, DispatchMessageProtected, 2},
      {"dispatchInput", DispatchInput, DispatchInputProtected, 3},
      {"dispatchReload", DispatchReload, DispatchReloadProtected, 4},
      {"detachComponent", Detach, DetachProtected, 5}
    };
    for (const Method& method : methods) {
      lua_pushlightuserdata(state, this);
      lua_pushcclosure(state, method.protectedFunction, 1);
      protectedRefs_[method.index] = luaL_ref(state, LUA_REGISTRYINDEX);
      lua_pushlightuserdata(state, this);
      lua_pushcclosure(state, method.function, 1);
      lua_setfield(state, -2, method.name);
    }
    lua_pushvalue(state, -1); lua_setglobal(state, kLuaModuleName); lua_pop(state, 1);
    state_ = state;
  }

  void shutdown() noexcept {
    if (state_) for (Slot& slot : slots_) release(slot);
    if (state_) for (int& reference : protectedRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    if (state_) for (Slot& slot : slots_) {
      if (slot.rootReference != LUA_NOREF && slot.rootReference != LUA_REFNIL)
        luaL_unref(state_, LUA_REGISTRYINDEX, slot.rootReference);
      slot.rootReference = LUA_NOREF;
    }
    state_ = nullptr;
  }

  uint32_t live() const noexcept { return live_; }
  uint64_t attachments() const noexcept { return attachments_; }
  uint64_t dispatches() const noexcept { return dispatches_; }
  uint64_t staleFailures() const noexcept { return staleFailures_; }

 private:
  struct Slot {
    int rootReference = LUA_NOREF;
    ComponentHandle backendHandle{};
    uint32_t backendRevision = 0;
    uint32_t generation = 1;
    ContextKind context = ContextKind::kGameObject;
    bool live = false;
    char componentId[kComponentIdCapacity]{};
    char schema[kSchemaCapacity]{};
  };

  static LuaRuntime* self(lua_State* state) noexcept {
    return static_cast<LuaRuntime*>(lua_touserdata(state, lua_upvalueindex(1)));
  }

  static int protectedInvoke(lua_State* state, uint8_t index) {
    const int argumentCount = lua_gettop(state);
    LuaRuntime* runtime = self(state);
    if (!runtime || index >= runtime->protectedRefs_.size() ||
        runtime->protectedRefs_[index] == LUA_NOREF || runtime->protectedRefs_[index] == LUA_REFNIL)
      return luaL_error(state, "component protected trampoline is unavailable");
    lua_rawgeti(state, LUA_REGISTRYINDEX, runtime->protectedRefs_[index]);
    for (int index = 1; index <= argumentCount; ++index) lua_pushvalue(state, index);
    if (lua_pcall(state, argumentCount, LUA_MULTRET, 0) != 0) return lua_error(state);
    return lua_gettop(state) - argumentCount;
  }

  static bool copy(char* target, size_t capacity, const char* source) noexcept {
    if (!target || capacity == 0 || !source) return false;
    const size_t length = std::strlen(source);
    if (length >= capacity) return false;
    std::memcpy(target, source, length + 1);
    return true;
  }

  static bool parseContext(const char* value, ContextKind* output) noexcept {
    if (!value || !output) return false;
    if (std::strcmp(value, "game-object") == 0) *output = ContextKind::kGameObject;
    else if (std::strcmp(value, "gui-scene") == 0) *output = ContextKind::kGuiScene;
    else if (std::strcmp(value, "render-instance+graphics") == 0) *output = ContextKind::kRender;
    else return false;
    return true;
  }

  Slot* find(lua_State* state, int selfIndex, const char* componentId) noexcept {
    const int absolute = selfIndex > 0 ? selfIndex : lua_gettop(state) + selfIndex + 1;
    for (Slot& slot : slots_) {
      if (!slot.live || std::strcmp(slot.componentId, componentId) != 0) continue;
      lua_rawgeti(state, LUA_REGISTRYINDEX, slot.rootReference);
      lua_rawgeti(state, -1, 1);
      const bool equal = lua_rawequal(state, absolute, -1) != 0;
      lua_pop(state, 2);
      if (equal) return &slot;
    }
    return nullptr;
  }

  Slot* acquire() noexcept { for (Slot& slot : slots_) if (!slot.live) return &slot; return nullptr; }

  bool scopedDispatch(Slot& slot, DispatchRequest& request, bool* consumed,
      char* error, size_t errorCapacity) noexcept {
    if (!state_ || !slot.live || !request.handle || request.handle.slot != slot.backendHandle.slot ||
        request.handle.generation != slot.backendHandle.generation) {
      ++staleFailures_; std::snprintf(error, errorCapacity, "component attachment is stale"); return false;
    }
    const uint32_t revision = backend_.revision(backend_.context);
    if (revision == 0) {
      std::snprintf(error, errorCapacity, "component backend runtime is unavailable");
      return false;
    }
    if (revision != slot.backendRevision) {
      const int rebindTop = lua_gettop(state_);
      lua_rawgeti(state_, LUA_REGISTRYINDEX, slot.rootReference);
      lua_rawgeti(state_, -1, 1);
      const int selfIndex = lua_gettop(state_);
      lua_rawgeti(state_, -2, 2);
      AttachRequest attachRequest{state_, slot.componentId, slot.schema, slot.context,
          selfIndex, lua_gettop(state_)};
      ComponentHandle replacement{};
      const bool rebound = backend_.attach(
          backend_.context, attachRequest, &replacement, error, errorCapacity);
      lua_settop(state_, rebindTop);
      if (!rebound || !replacement) return false;
      // A Hermes generation owns its component `self` objects. Reattaching to
      // a replacement runtime therefore creates a fresh JS instance even
      // though Defold's Lua-side instance remains live. Initialize that fresh
      // instance before delivering the reload hook; otherwise the first
      // update after HMR observes only editor properties and loses every field
      // established by init().
      DispatchRequest initRequest{state_, replacement, slot.componentId, slot.context,
          EventKind::kLifecycle, "init", 0, 0};
      if (!dispatchWithInstance(slot, initRequest, nullptr, error, errorCapacity)) {
        backend_.detach(backend_.context, replacement);
        return false;
      }
      DispatchRequest reloadRequest{state_, replacement, slot.componentId, slot.context,
          EventKind::kReload, "onReload", 0, 0};
      if (!dispatchWithInstance(slot, reloadRequest, nullptr, error, errorCapacity)) {
        backend_.detach(backend_.context, replacement);
        return false;
      }
      slot.backendHandle = replacement;
      slot.backendRevision = revision;
      request.handle = replacement;
      if (request.event == EventKind::kReload) return true;
    }
    return dispatchWithInstance(slot, request, consumed, error, errorCapacity);
  }

  bool dispatchWithInstance(Slot& slot, DispatchRequest& request, bool* consumed,
      char* error, size_t errorCapacity) noexcept {
    const int top = lua_gettop(state_);
    instanceApi_.get(state_); // Nil is a valid previous instance.
    const int previous = lua_gettop(state_);
    lua_rawgeti(state_, LUA_REGISTRYINDEX, slot.rootReference);
    lua_rawgeti(state_, -1, 1);
    instanceApi_.set(state_);
    const bool ok = backend_.dispatch(backend_.context, request, consumed, error, errorCapacity);
    lua_pushvalue(state_, previous);
    instanceApi_.set(state_);
    lua_settop(state_, top);
    if (ok) ++dispatches_;
    return ok;
  }

  void release(Slot& slot) noexcept {
    if (!slot.live) return;
    if (backend_.revision(backend_.context) == slot.backendRevision)
      backend_.detach(backend_.context, slot.backendHandle);
    if (state_ && slot.rootReference != LUA_NOREF && slot.rootReference != LUA_REFNIL) {
      lua_rawgeti(state_, LUA_REGISTRYINDEX, slot.rootReference);
      lua_pushboolean(state_, 0); lua_rawseti(state_, -2, 1);
      lua_pushboolean(state_, 0); lua_rawseti(state_, -2, 2);
      lua_pop(state_, 1);
    }
    slot.backendHandle = {}; slot.backendRevision = 0; slot.live = false;
    slot.componentId[0] = slot.schema[0] = '\0';
    if (++slot.generation == 0) ++slot.generation;
    if (live_) --live_;
  }

  static int Attach(lua_State* state) { return protectedInvoke(state, 0); }

  static int AttachProtected(lua_State* state) {
    LuaRuntime* runtime = self(state);
    if (!runtime || !runtime->valid()) return luaL_error(state, "component runtime is unavailable");
    luaL_checkany(state, 1);
    const char* componentId = luaL_checkstring(state, 2);
    const char* schema = luaL_checkstring(state, 3);
    const char* contextText = luaL_checkstring(state, 4);
    luaL_checktype(state, 5, LUA_TTABLE);
    ContextKind context;
    if (!parseContext(contextText, &context)) return luaL_error(state, "unknown component context %s", contextText);
    if (Slot* existing = runtime->find(state, 1, componentId)) {
      if (std::strcmp(existing->schema, schema) != 0 || existing->context != context)
        return luaL_error(state, "component attachment schema or context changed");
      lua_pushboolean(state, 1); return 1;
    }
    Slot* slot = runtime->acquire();
    if (!slot) return luaL_error(state, "component attachment pool is exhausted");
    if (!copy(slot->componentId, sizeof(slot->componentId), componentId) ||
        !copy(slot->schema, sizeof(slot->schema), schema))
      return luaL_error(state, "component identity exceeds fixed storage");
    const int top = lua_gettop(state);
    lua_rawgeti(state, LUA_REGISTRYINDEX, slot->rootReference);
    lua_pushvalue(state, 1); lua_rawseti(state, -2, 1);
    lua_pushvalue(state, 5); lua_rawseti(state, -2, 2);
    lua_pop(state, 1);
    AttachRequest request{state, slot->componentId, slot->schema, context, 1, 5};
    char error[256]{}; ComponentHandle handle{};
    if (!runtime->backend_.attach(runtime->backend_.context, request, &handle, error, sizeof(error)) || !handle) {
      lua_rawgeti(state, LUA_REGISTRYINDEX, slot->rootReference);
      lua_pushboolean(state, 0); lua_rawseti(state, -2, 1);
      lua_pushboolean(state, 0); lua_rawseti(state, -2, 2);
      lua_pop(state, 1);
      slot->componentId[0] = slot->schema[0] = '\0'; lua_settop(state, top);
      return luaL_error(state, "%s", error[0] ? error : "component backend rejected attachment");
    }
    slot->backendHandle = handle; slot->backendRevision = runtime->backend_.revision(runtime->backend_.context);
    slot->context = context; slot->live = true;
    ++runtime->live_; ++runtime->attachments_; lua_pushboolean(state, 1); return 1;
  }

  static int dispatch(lua_State* state, EventKind event, const char* lifecycle,
      int argumentStart, uint8_t argumentCount, bool returnsBoolean) {
    LuaRuntime* runtime = self(state);
    if (!runtime || !runtime->valid()) return luaL_error(state, "component runtime is unavailable");
    luaL_checkany(state, 1); const char* componentId = luaL_checkstring(state, 2);
    Slot* slot = runtime->find(state, 1, componentId);
    if (!slot) return luaL_error(state, "component is not attached");
    DispatchRequest request{state, slot->backendHandle, slot->componentId, slot->context,
        event, lifecycle, argumentStart, argumentCount};
    char error[256]{}; bool consumed = false;
    if (!runtime->scopedDispatch(*slot, request, &consumed, error, sizeof(error)))
      return luaL_error(state, "%s", error[0] ? error : "component dispatch failed");
    if (returnsBoolean) { lua_pushboolean(state, consumed ? 1 : 0); return 1; }
    return 0;
  }

  static int DispatchLifecycle(lua_State* state) { return protectedInvoke(state, 1); }
  static int DispatchLifecycleProtected(lua_State* state) {
    const char* lifecycle = luaL_checkstring(state, 3);
    const uint8_t count = lua_gettop(state) > 3 ? static_cast<uint8_t>(lua_gettop(state) - 3) : 0;
    return dispatch(state, EventKind::kLifecycle, lifecycle, 4, count, false);
  }
  static int DispatchMessage(lua_State* state) { return protectedInvoke(state, 2); }
  static int DispatchMessageProtected(lua_State* state) { luaL_checkany(state, 3); luaL_checkany(state, 4); luaL_checkany(state, 5); return dispatch(state, EventKind::kMessage, "onMessage", 3, 3, false); }
  static int DispatchInput(lua_State* state) { return protectedInvoke(state, 3); }
  static int DispatchInputProtected(lua_State* state) { luaL_checkany(state, 3); luaL_checkany(state, 4); return dispatch(state, EventKind::kInput, "onInput", 3, 2, true); }
  static int DispatchReload(lua_State* state) { return protectedInvoke(state, 4); }
  static int DispatchReloadProtected(lua_State* state) { return dispatch(state, EventKind::kReload, "onReload", 3, 0, false); }
  static int Detach(lua_State* state) { return protectedInvoke(state, 5); }
  static int DetachProtected(lua_State* state) {
    LuaRuntime* runtime = self(state);
    if (!runtime || !runtime->valid()) return luaL_error(state, "component runtime is unavailable");
    luaL_checkany(state, 1); const char* componentId = luaL_checkstring(state, 2);
    if (Slot* slot = runtime->find(state, 1, componentId)) runtime->release(*slot);
    lua_pushboolean(state, 1); return 1;
  }

  lua_State* state_ = nullptr;
  BackendApi backend_{};
  InstanceApi instanceApi_{};
  std::array<int, 6> protectedRefs_{};
  std::array<Slot, kCapacity> slots_{};
  uint32_t live_ = 0;
  uint64_t attachments_ = 0;
  uint64_t dispatches_ = 0;
  uint64_t staleFailures_ = 0;
};

inline int rejectUnavailable(lua_State* state) { return luaL_error(state, "%s", kDiagnostic.data()); }
inline void registerUnavailableLuaApi(lua_State* state) {
  lua_getglobal(state, kLuaModuleName);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); lua_newtable(state); }
  for (const char* method : kRequiredLuaMethods) { lua_pushcfunction(state, rejectUnavailable); lua_setfield(state, -2, method); }
  lua_pushvalue(state, -1); lua_setglobal(state, kLuaModuleName); lua_pop(state, 1);
}

}  // namespace defold_hermes::component_proxy
