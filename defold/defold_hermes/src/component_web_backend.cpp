#include <defold_hermes/component_web_backend.hpp>

#if defined(DM_PLATFORM_HTML5)

#include <defold_hermes/active_game_object_context.hpp>
#include <defold_hermes/generated_script_universal_value_capi.h>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

#include <array>
#include <cstdio>
#include <cstring>
#include <optional>

namespace dmScript {
bool IsHash(lua_State*, int);
bool IsURL(lua_State*, int);
bool IsVector3(lua_State*, int);
bool IsVector4(lua_State*, int);
bool IsQuat(lua_State*, int);
dmhash_t* ToHash(lua_State*, int);
dmMessage::URL* ToURL(lua_State*, int);
dmVMath::Vector3* ToVector3(lua_State*, int);
dmVMath::Vector4* ToVector4(lua_State*, int);
dmVMath::Quat* ToQuat(lua_State*, int);
}

extern "C" {
uint32_t defoldHermesWebComponentRevision();
int defoldHermesWebComponentAttach(
    const char* componentId, const char* schema, uint32_t contextKind,
    uint32_t* outSlot, uint32_t* outGeneration, char* error, uint32_t errorCapacity);
int defoldHermesWebComponentSetProperty(
    uint32_t slot, uint32_t generation, const char* name,
    const DehermScriptUniversalValue* values, uint32_t valueCount,
    const DehermScriptUniversalEntry* entries, uint32_t entryCount,
    const char* strings, uint32_t stringBytes,
    const float* floats, uint32_t floatCount,
    const DehermScriptUniversalUrl* urls, uint32_t urlCount,
    const uint32_t* roots, uint32_t rootCount,
    char* error, uint32_t errorCapacity);
int defoldHermesWebComponentDispatch(
    uint32_t slot, uint32_t generation, const char* lifecycle,
    const DehermScriptUniversalValue* values, uint32_t valueCount,
    const DehermScriptUniversalEntry* entries, uint32_t entryCount,
    const char* strings, uint32_t stringBytes,
    const float* floats, uint32_t floatCount,
    const DehermScriptUniversalUrl* urls, uint32_t urlCount,
    const uint32_t* roots, uint32_t rootCount,
    uint8_t* consumed, char* error, uint32_t errorCapacity);
int defoldHermesWebComponentReload(
    uint32_t slot, uint32_t generation, char* error, uint32_t errorCapacity);
void defoldHermesWebComponentDetach(uint32_t slot, uint32_t generation);
}

namespace defold_hermes::component_proxy {
namespace {

constexpr uint8_t kTagNull = 1;
constexpr uint8_t kTagBoolean = 2;
constexpr uint8_t kTagNumber = 3;
constexpr uint8_t kTagString = 4;
constexpr uint8_t kTagHandle = 5;
constexpr uint8_t kTagTable = 7;
constexpr uint8_t kTagDefoldValue = 8;

constexpr uint8_t kHandleHash = 1;
constexpr uint8_t kHandleUrl = 2;

constexpr uint8_t kTableSequence = 1;
constexpr uint8_t kTableRecord = 2;

constexpr uint8_t kDefoldVector3 = 1;
constexpr uint8_t kDefoldVector4 = 2;
constexpr uint8_t kDefoldQuaternion = 3;

constexpr uint32_t kValueCapacity = 512;
constexpr uint32_t kEntryCapacity = 256;
constexpr uint32_t kStringCapacity = 16384;
constexpr uint32_t kUrlCapacity = 32;
constexpr uint32_t kRootCapacity = 4;
constexpr uint32_t kDepthCapacity = 8;
// Component dispatch is not recursive inside one hook, but a hook may call a
// generated script route whose Lua callback dispatches another component. The
// bounded arena stack keeps every such frame separate and fails closed instead
// of aliasing a live encoding.
constexpr uint32_t kFrameCapacity = 4;

struct WireArena {
  std::array<DehermScriptUniversalValue, kValueCapacity> values{};
  std::array<DehermScriptUniversalEntry, kEntryCapacity> entries{};
  std::array<char, kStringCapacity> strings{};
  std::array<DehermScriptUniversalUrl, kUrlCapacity> urls{};
  std::array<uint32_t, kRootCapacity> roots{};
  uint32_t valueUsed = 0;
  uint32_t entryUsed = 0;
  uint32_t stringUsed = 0;
  uint32_t urlUsed = 0;
  uint32_t rootUsed = 0;
  bool busy = false;

  void reset() noexcept {
    valueUsed = entryUsed = stringUsed = urlUsed = rootUsed = 0;
  }
};

std::array<WireArena, kFrameCapacity> gArenas{};

WireArena* acquireArena() noexcept {
  for (WireArena& arena : gArenas) {
    if (arena.busy) continue;
    arena.busy = true;
    arena.reset();
    return &arena;
  }
  return nullptr;
}

void releaseArena(WireArena* arena) noexcept {
  if (arena) arena->busy = false;
}

struct ArenaLease {
  WireArena* arena = nullptr;
  explicit ArenaLease() noexcept : arena(acquireArena()) {}
  ~ArenaLease() noexcept { releaseArena(arena); }
  ArenaLease(const ArenaLease&) = delete;
  ArenaLease& operator=(const ArenaLease&) = delete;
};

void fail(char* error, size_t capacity, const char* message) noexcept {
  if (error && capacity) std::snprintf(error, capacity, "%s", message ? message : "browser component backend failed");
}

bool reserveValue(WireArena& arena, uint32_t* index) noexcept {
  if (arena.valueUsed >= kValueCapacity) return false;
  *index = arena.valueUsed++;
  arena.values[*index] = {};
  return true;
}

bool storeString(WireArena& arena, const char* data, size_t length, DehermScriptUniversalValue* wire) noexcept {
  if (length > kStringCapacity || arena.stringUsed > kStringCapacity - length) return false;
  if (length) std::memcpy(arena.strings.data() + arena.stringUsed, data, length);
  wire->tag = kTagString;
  wire->length = static_cast<uint32_t>(length);
  wire->data_offset = arena.stringUsed;
  arena.stringUsed += static_cast<uint32_t>(length);
  return true;
}

bool storeUrl(WireArena& arena, const dmMessage::URL& url, DehermScriptUniversalValue* wire) noexcept {
  if (arena.urlUsed >= kUrlCapacity) return false;
  arena.urls[arena.urlUsed] = {url.m_Socket, url._reserved, url.m_Path, url.m_Fragment};
  wire->tag = kTagHandle;
  wire->handle_kind = kHandleUrl;
  wire->data_offset = arena.urlUsed++;
  return true;
}

/**
 * Encode one Lua leaf. `codec` mirrors the generated component property codec
 * identifiers; zero means "classify from the live Lua value", which is what
 * lifecycle arguments use.
 */
bool encodeLeaf(lua_State* state, int index, uint8_t codec, WireArena& arena,
    DehermScriptUniversalValue* wire) noexcept {
  *wire = {};
  if (lua_isnil(state, index)) { wire->tag = kTagNull; return true; }
  if (codec == 1 || (codec == 0 && lua_isnumber(state, index))) {
    if (!lua_isnumber(state, index)) return false;
    wire->tag = kTagNumber;
    wire->number = lua_tonumber(state, index);
    return true;
  }
  if (codec == 2 || (codec == 0 && lua_isboolean(state, index))) {
    if (!lua_isboolean(state, index)) return false;
    wire->tag = kTagBoolean;
    wire->number = lua_toboolean(state, index) != 0 ? 1.0 : 0.0;
    return true;
  }
  if (codec == 3 || (codec == 0 && lua_isstring(state, index))) {
    if (!lua_isstring(state, index)) return false;
    size_t length = 0;
    const char* text = lua_tolstring(state, index, &length);
    return storeString(arena, text, length, wire);
  }
  if (codec == 0 || codec == 4 || codec == 9) {
    if (dmScript::IsHash(state, index)) {
      auto* hash = dmScript::ToHash(state, index);
      if (!hash) return false;
      wire->tag = kTagHandle;
      wire->handle_kind = kHandleHash;
      wire->payload = *hash;
      return true;
    }
    if ((codec == 4 || codec == 9) && lua_isstring(state, index)) {
      size_t length = 0;
      const char* text = lua_tolstring(state, index, &length);
      return storeString(arena, text, length, wire);
    }
  }
  if ((codec == 0 && dmScript::IsURL(state, index)) || codec == 5) {
    auto* url = dmScript::ToURL(state, index);
    if (!url) return false;
    return storeUrl(arena, *url, wire);
  }
  if ((codec == 0 && dmScript::IsVector3(state, index)) || codec == 6) {
    auto* value = dmScript::ToVector3(state, index);
    if (!value) return false;
    wire->tag = kTagDefoldValue;
    wire->defold_kind = kDefoldVector3;
    wire->lanes[0] = value->getX();
    wire->lanes[1] = value->getY();
    wire->lanes[2] = value->getZ();
    return true;
  }
  if ((codec == 0 && dmScript::IsVector4(state, index)) || codec == 7) {
    auto* value = dmScript::ToVector4(state, index);
    if (!value) return false;
    wire->tag = kTagDefoldValue;
    wire->defold_kind = kDefoldVector4;
    for (int lane = 0; lane < 4; ++lane) wire->lanes[lane] = (*value)[lane];
    return true;
  }
  if ((codec == 0 && dmScript::IsQuat(state, index)) || codec == 8) {
    auto* value = dmScript::ToQuat(state, index);
    if (!value) return false;
    wire->tag = kTagDefoldValue;
    wire->defold_kind = kDefoldQuaternion;
    for (int lane = 0; lane < 4; ++lane) wire->lanes[lane] = (*value)[lane];
    return true;
  }
  return false;
}

bool encodeValue(lua_State* state, int index, WireArena& arena, uint32_t* outIndex, uint32_t depth) noexcept;

bool encodeTable(lua_State* state, int absolute, WireArena& arena, uint32_t valueIndex, uint32_t depth) noexcept {
  if (depth >= kDepthCapacity) return false;
  size_t count = 0;
  bool stringKeys = true;
  bool arrayKeys = true;
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    ++count;
    stringKeys = stringKeys && lua_type(state, -2) == LUA_TSTRING;
    if (lua_type(state, -2) != LUA_TNUMBER) {
      arrayKeys = false;
    } else {
      const lua_Number numeric = lua_tonumber(state, -2);
      const lua_Integer integer = lua_tointeger(state, -2);
      if (numeric != static_cast<lua_Number>(integer) || integer < 1) arrayKeys = false;
    }
    lua_pop(state, 1);
  }
  if (count > kEntryCapacity || (!stringKeys && !arrayKeys)) return false;
  if (arena.entryUsed > kEntryCapacity || count > kEntryCapacity - arena.entryUsed) return false;

  const uint32_t start = arena.entryUsed;
  arena.entryUsed += static_cast<uint32_t>(count);
  const bool sequence = arrayKeys && count != 0;

  if (sequence) {
    for (size_t child = 0; child < count; ++child) {
      uint32_t keyIndex = 0;
      if (!reserveValue(arena, &keyIndex)) return false;
      arena.values[keyIndex].tag = kTagNumber;
      arena.values[keyIndex].number = static_cast<double>(child + 1);
      lua_rawgeti(state, absolute, static_cast<int>(child + 1));
      uint32_t childIndex = 0;
      const bool encoded = !lua_isnil(state, -1) && encodeValue(state, -1, arena, &childIndex, depth + 1);
      lua_pop(state, 1);
      if (!encoded) return false;
      arena.entries[start + child] = {keyIndex, childIndex};
    }
  } else {
    size_t child = 0;
    lua_pushnil(state);
    while (lua_next(state, absolute) != 0) {
      size_t length = 0;
      const char* name = lua_tolstring(state, -2, &length);
      uint32_t keyIndex = 0;
      if (!name || !reserveValue(arena, &keyIndex) ||
          !storeString(arena, name, length, &arena.values[keyIndex])) {
        lua_pop(state, 2);
        return false;
      }
      uint32_t childIndex = 0;
      if (!encodeValue(state, -1, arena, &childIndex, depth + 1)) {
        lua_pop(state, 2);
        return false;
      }
      arena.entries[start + child] = {keyIndex, childIndex};
      ++child;
      lua_pop(state, 1);
    }
  }

  auto& wire = arena.values[valueIndex];
  wire.tag = kTagTable;
  wire.auxiliary = sequence ? kTableSequence : kTableRecord;
  wire.length = static_cast<uint32_t>(count);
  wire.data_offset = start;
  return true;
}

bool encodeValue(lua_State* state, int index, WireArena& arena, uint32_t* outIndex, uint32_t depth) noexcept {
  const int absolute = index > 0 ? index : lua_gettop(state) + index + 1;
  if (!reserveValue(arena, outIndex)) return false;
  if (!lua_istable(state, absolute)) {
    return encodeLeaf(state, absolute, 0, arena, &arena.values[*outIndex]);
  }
  return encodeTable(state, absolute, arena, *outIndex, depth);
}

uint32_t contextKind(ContextKind value) noexcept {
  return value == ContextKind::kGameObject ? 0u : value == ContextKind::kGuiScene ? 1u : 2u;
}

lua_bridge::scalar::ScriptAdapter::ComponentContext adapterContext(ContextKind value) noexcept {
  using AdapterContext = lua_bridge::scalar::ScriptAdapter::ComponentContext;
  return value == ContextKind::kGameObject ? AdapterContext::kGameObject :
      value == ContextKind::kGuiScene ? AdapterContext::kGui : AdapterContext::kRender;
}

}  // namespace

BackendApi WebBackend::api() noexcept { return {this, Revision, Attach, Dispatch, Detach}; }

uint32_t WebBackend::Revision(void*) noexcept { return defoldHermesWebComponentRevision(); }

bool WebBackend::Attach(void* opaque, const AttachRequest& request, ComponentHandle* output,
    char* error, size_t capacity) noexcept {
  auto* backend = static_cast<WebBackend*>(opaque);
  if (backend->ensureRuntime_ && !backend->ensureRuntime_(backend->context_, request.state)) {
    fail(error, capacity, "Browser component runtime or script bridge initialization failed");
    return false;
  }
  if (!output) { fail(error, capacity, "Component attachment has no output handle"); return false; }
  if (backend->adapterProvider_) {
    auto* adapter = backend->adapter();
    if (!adapter || !adapter->ensureComponentFallbackInstance(
            request.selfIndex, adapterContext(request.context))) {
      fail(error, capacity, "Component could not establish a bounded script-API context");
      return false;
    }
  }

  uint32_t slot = 0;
  uint32_t generation = 0;
  char browserError[256]{};
  if (!defoldHermesWebComponentAttach(
          request.componentId, request.schemaFingerprint, contextKind(request.context),
          &slot, &generation, browserError, sizeof(browserError))) {
    fail(error, capacity, browserError[0] ? browserError : "Browser component attachment failed");
    return false;
  }

  const size_t count = lua_objlen(request.state, request.propertySpecializationsIndex);
  if (count > 32) {
    defoldHermesWebComponentDetach(slot, generation);
    fail(error, capacity, "Component has more than 32 specialized properties");
    return false;
  }
  for (size_t property = 1; property <= count; ++property) {
    ArenaLease lease;
    if (!lease.arena) {
      defoldHermesWebComponentDetach(slot, generation);
      fail(error, capacity, "Browser component encoding arenas are exhausted");
      return false;
    }
    const int top = lua_gettop(request.state);
    lua_rawgeti(request.state, request.propertySpecializationsIndex, static_cast<int>(property));
    if (!lua_istable(request.state, -1)) {
      lua_settop(request.state, top);
      defoldHermesWebComponentDetach(slot, generation);
      fail(error, capacity, "Component property specialization is not a tuple");
      return false;
    }
    lua_rawgeti(request.state, -1, 1);
    const char* name = lua_tostring(request.state, -1);
    lua_rawgeti(request.state, -2, 2);
    const uint8_t codec = static_cast<uint8_t>(lua_tointeger(request.state, -1));
    lua_pop(request.state, 1);
    // Defold hands a script/GUI component its `self` as userdata whose
    // metatable resolves editor properties, so a raw table read both misses
    // every declared property and is undefined for a non-table value.
    lua_pushvalue(request.state, -1);
    lua_gettable(request.state, request.selfIndex);
    uint32_t valueIndex = 0;
    const bool encoded = name && reserveValue(*lease.arena, &valueIndex) &&
        encodeLeaf(request.state, -1, codec, *lease.arena, &lease.arena->values[valueIndex]);
    bool applied = false;
    if (encoded) {
      lease.arena->roots[0] = valueIndex;
      applied = defoldHermesWebComponentSetProperty(
          slot, generation, name,
          lease.arena->values.data(), lease.arena->valueUsed,
          lease.arena->entries.data(), lease.arena->entryUsed,
          lease.arena->strings.data(), lease.arena->stringUsed,
          nullptr, 0,
          lease.arena->urls.data(), lease.arena->urlUsed,
          lease.arena->roots.data(), 1,
          browserError, sizeof(browserError)) != 0;
    }
    lua_settop(request.state, top);
    if (!encoded) {
      defoldHermesWebComponentDetach(slot, generation);
      fail(error, capacity, "Component editor property does not match its generated codec");
      return false;
    }
    if (!applied) {
      defoldHermesWebComponentDetach(slot, generation);
      fail(error, capacity, browserError[0] ? browserError : "Browser component property assignment failed");
      return false;
    }
  }

  *output = {slot, generation};
  return true;
}

bool WebBackend::Dispatch(void* opaque, const DispatchRequest& request, bool* consumed,
    char* error, size_t capacity) noexcept {
  auto* backend = static_cast<WebBackend*>(opaque);
  char browserError[256]{};
  if (request.event == EventKind::kReload) {
    if (!defoldHermesWebComponentReload(
            request.handle.slot, request.handle.generation, browserError, sizeof(browserError))) {
      fail(error, capacity, browserError[0] ? browserError : "Browser component reload failed");
      return false;
    }
    return true;
  }

  // Generated current-instance thunks (`go.get_position` and friends) resolve
  // against the innermost active game-object context. A dispatching script
  // component must therefore publish its own instance for the whole callback,
  // otherwise every current-instance call fails closed with no active context.
  std::optional<game_object::Scope> instanceScope;
  if (request.context == ContextKind::kGameObject) {
    game_object::ActiveContext instanceContext{};
    if (!game_object::buildCurrentInstanceContext(request.state, &instanceContext)) {
      fail(error, capacity, "Component dispatch could not resolve its current game object");
      return false;
    }
    instanceScope.emplace(instanceContext);
    if (!instanceScope->entered()) {
      fail(error, capacity, "Game-object context stack is exhausted during component dispatch");
      return false;
    }
  }

  auto* adapter = backend->adapter();
  if (backend->adapterProvider_ &&
      (!adapter || !adapter->pushComponentContext(adapterContext(request.context)))) {
    fail(error, capacity, adapter ? adapter->lastError() : "Component script adapter is unavailable");
    return false;
  }

  ArenaLease lease;
  if (!lease.arena) {
    if (adapter) adapter->popComponentContext();
    fail(error, capacity, "Browser component encoding arenas are exhausted");
    return false;
  }
  if (request.argumentCount > kRootCapacity) {
    if (adapter) adapter->popComponentContext();
    fail(error, capacity, "Component event has too many arguments");
    return false;
  }
  for (uint8_t index = 0; index < request.argumentCount; ++index) {
    uint32_t root = 0;
    if (!encodeValue(request.state, request.argumentStart + index, *lease.arena, &root, 0)) {
      if (adapter) adapter->popComponentContext();
      fail(error, capacity,
          "Component event value exceeds the bounded recursive codec (256 entries, 512 values, depth 8)");
      return false;
    }
    lease.arena->roots[index] = root;
  }

  uint8_t consumedFlag = 0;
  const int ok = defoldHermesWebComponentDispatch(
      request.handle.slot, request.handle.generation, request.lifecycle,
      lease.arena->values.data(), lease.arena->valueUsed,
      lease.arena->entries.data(), lease.arena->entryUsed,
      lease.arena->strings.data(), lease.arena->stringUsed,
      nullptr, 0,
      lease.arena->urls.data(), lease.arena->urlUsed,
      lease.arena->roots.data(), request.argumentCount,
      &consumedFlag, browserError, sizeof(browserError));
  if (adapter) adapter->popComponentContext();
  if (!ok) {
    fail(error, capacity, browserError[0] ? browserError : "Browser component dispatch failed");
    return false;
  }
  if (consumed) *consumed = consumedFlag != 0;
  return true;
}

void WebBackend::Detach(void*, ComponentHandle handle) noexcept {
  defoldHermesWebComponentDetach(handle.slot, handle.generation);
}

}  // namespace defold_hermes::component_proxy

#endif  // DM_PLATFORM_HTML5
