#include <defold_hermes/generated_script_dynamic_values.hpp>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
int luaopen_bit(lua_State* state);
}

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace dynamic = defold_hermes::dynamic_value;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace {
std::atomic<bool> gTrackCppAllocations{false};
std::atomic<uint64_t> gCppAllocations{0};

struct LuaAllocatorStats {
  bool tracking = false;
  uint64_t calls = 0;
  uint64_t allocations = 0;
  uint64_t frees = 0;
  size_t liveBytes = 0;
  size_t peakBytes = 0;
};

void* CountingLuaAllocator(void* user, void* pointer, size_t oldSize, size_t newSize) {
  auto& stats = *static_cast<LuaAllocatorStats*>(user);
  if (stats.tracking) {
    ++stats.calls;
    if (!pointer && newSize) ++stats.allocations;
    if (pointer && !newSize) ++stats.frees;
  }
  if (!newSize) {
    if (pointer) stats.liveBytes -= oldSize;
    std::free(pointer);
    return nullptr;
  }
  void* result = std::realloc(pointer, newSize);
  if (!result) return nullptr;
  if (pointer) stats.liveBytes -= oldSize;
  stats.liveBytes += newSize;
  if (stats.liveBytes > stats.peakBytes) stats.peakBytes = stats.liveBytes;
  return result;
}

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "script-dynamic-value:error:%s\n", message);
  std::exit(1);
}

void Expect(bool condition, const char* message) { if (!condition) Fail(message); }

enum class Kind : uint8_t { kHash, kMatrix4, kQuat, kUrl, kVector, kVector3, kVector4, kCount };
constexpr uint64_t kBorrowedVector = UINT64_C(0x766563746f720001);

const char* KindName(Kind kind) {
  constexpr const char* names[] = {"hash", "matrix4", "quat", "url", "vector", "vector3", "vector4"};
  return names[static_cast<size_t>(kind)];
}

bool UserdataIsKind(lua_State* state, int index, Kind kind) {
  if (!lua_isuserdata(state, index)) return false;
  lua_getfield(state, LUA_REGISTRYINDEX, KindName(kind));
  const bool equal = lua_rawequal(state, index, -1) != 0;
  lua_pop(state, 1);
  return equal;
}

int TypeIsHash(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kHash)); return 1; }
int TypeIsMatrix4(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kMatrix4)); return 1; }
int TypeIsQuat(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kQuat)); return 1; }
int TypeIsUrl(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kUrl)); return 1; }
int TypeIsVector(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kVector)); return 1; }
int TypeIsVector3(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kVector3)); return 1; }
int TypeIsVector4(lua_State* state) { lua_pushboolean(state, UserdataIsKind(state, 1, Kind::kVector4)); return 1; }

// Byte-for-byte behavior of the pinned LuaSocket global_skip implementation.
int SocketSkip(lua_State* state) {
  const int amount = luaL_checkint(state, 1);
  const int returned = lua_gettop(state) - amount - 1;
  return returned >= 0 ? returned : 0;
}

struct Backend {
  lua_State* state = nullptr;
  std::array<int, dynamic::kBindingCount> functionRefs{};
  std::array<int, static_cast<size_t>(Kind::kCount)> kindRefs{};
  const ScriptValue* activeArguments = nullptr;
  uint32_t activeArgumentCount = 0;

  bool initialize(lua_State* lua) {
    state = lua;
    functionRefs.fill(LUA_NOREF);
    kindRefs.fill(LUA_NOREF);
    for (size_t index = 0; index < kindRefs.size(); ++index) {
      static_cast<uint8_t*>(lua_newuserdata(state, 1))[0] = static_cast<uint8_t>(index);
      lua_pushvalue(state, -1);
      lua_setfield(state, LUA_REGISTRYINDEX, KindName(static_cast<Kind>(index)));
      kindRefs[index] = luaL_ref(state, LUA_REGISTRYINDEX);
    }
    luaopen_bit(state);
    lua_settop(state, 0);
    lua_newtable(state);
    lua_pushcfunction(state, SocketSkip);
    lua_setfield(state, -2, "skip");
    lua_setglobal(state, "socket");
    lua_newtable(state);
    const luaL_Reg methods[] = {
      {"is_hash", TypeIsHash}, {"is_matrix4", TypeIsMatrix4}, {"is_quat", TypeIsQuat},
      {"is_url", TypeIsUrl}, {"is_vector", TypeIsVector}, {"is_vector3", TypeIsVector3},
      {"is_vector4", TypeIsVector4}, {nullptr, nullptr}
    };
    luaL_register(state, nullptr, methods);
    lua_setglobal(state, "types");
    constexpr uint32_t ids[] = {
      UINT32_C(0x0892398e), UINT32_C(0x206a89ba), UINT32_C(0x7872f480),
      UINT32_C(0x948f508c), UINT32_C(0x9acd4145), UINT32_C(0x9b0d4932),
      UINT32_C(0xc6f91f35), UINT32_C(0xc8496cbd), UINT32_C(0xd495dbab),
      UINT32_C(0xd995e38a), UINT32_C(0xfaf3e587)
    };
    for (uint32_t id : ids) {
      const dynamic::Operation* operation = dynamic::find(id);
      if (!operation) return false;
      lua_getglobal(state, operation->modulePath);
      lua_getfield(state, -1, operation->member);
      lua_remove(state, -2);
      if (!lua_isfunction(state, -1)) return false;
      functionRefs[operation->index] = luaL_ref(state, LUA_REGISTRYINDEX);
    }
    return true;
  }

  void shutdown() {
    if (!state) return;
    for (int reference : functionRefs) if (reference != LUA_NOREF) luaL_unref(state, LUA_REGISTRYINDEX, reference);
    for (int reference : kindRefs) if (reference != LUA_NOREF) luaL_unref(state, LUA_REGISTRYINDEX, reference);
    state = nullptr;
  }

  void pushKind(Kind kind) { lua_rawgeti(state, LUA_REGISTRYINDEX, kindRefs[static_cast<size_t>(kind)]); }

  bool pushValue(const ScriptValue& value) {
    switch (value.tag) {
      case ScriptValueTag::kUndefined: case ScriptValueTag::kNull: lua_pushnil(state); return true;
      case ScriptValueTag::kBoolean: lua_pushboolean(state, value.number != 0.0); return true;
      case ScriptValueTag::kNumber: lua_pushnumber(state, value.number); return true;
      case ScriptValueTag::kString:
        if (value.length && !value.data) return false;
        lua_pushlstring(state, static_cast<const char*>(value.data), value.length); return true;
      case ScriptValueTag::kHandle:
        if (value.handleKind == ScriptHandleKind::kHash) { pushKind(Kind::kHash); return true; }
        if (value.handleKind == ScriptHandleKind::kUrl) { pushKind(Kind::kUrl); return true; }
        if (value.handleKind == ScriptHandleKind::kLuaUserdata && value.payload == kBorrowedVector) { pushKind(Kind::kVector); return true; }
        lua_pushlightuserdata(state, const_cast<ScriptValue*>(&value)); return true;
      case ScriptValueTag::kDefoldValue:
        if (value.defoldKind == ScriptDefoldValueKind::kMatrix4) { pushKind(Kind::kMatrix4); return true; }
        if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) { pushKind(Kind::kQuat); return true; }
        if (value.defoldKind == ScriptDefoldValueKind::kVector3) { pushKind(Kind::kVector3); return true; }
        if (value.defoldKind == ScriptDefoldValueKind::kVector4) { pushKind(Kind::kVector4); return true; }
        return false;
      case ScriptValueTag::kCallback: case ScriptValueTag::kTable:
        lua_pushlightuserdata(state, const_cast<ScriptValue*>(&value)); return true;
    }
    return false;
  }

  bool readValue(int index, ScriptCallFrame* frame, ScriptValue* output, char* error, size_t capacity) {
    *output = {};
    switch (lua_type(state, index)) {
      case LUA_TNIL: output->tag = ScriptValueTag::kNull; return true;
      case LUA_TBOOLEAN: output->tag = ScriptValueTag::kBoolean; output->number = lua_toboolean(state, index) ? 1.0 : 0.0; return true;
      case LUA_TNUMBER: output->tag = ScriptValueTag::kNumber; output->number = lua_tonumber(state, index); return true;
      case LUA_TSTRING: {
        size_t length = 0; const char* value = lua_tolstring(state, index, &length);
        if (!frame->stringScratch || length > frame->stringScratchCapacity - frame->stringScratchUsed) {
          std::snprintf(error, capacity, "%s", "Dynamic-value string scratch is exhausted"); return false;
        }
        char* destination = frame->stringScratch + frame->stringScratchUsed;
        if (length) std::memcpy(destination, value, length);
        output->tag = ScriptValueTag::kString; output->data = destination; output->length = static_cast<uint32_t>(length);
        frame->stringScratchUsed += static_cast<uint32_t>(length); return true;
      }
      case LUA_TLIGHTUSERDATA: {
        const void* pointer = lua_touserdata(state, index);
        for (uint32_t argument = 0; argument < activeArgumentCount; ++argument) {
          if (pointer == &activeArguments[argument]) { *output = activeArguments[argument]; return true; }
        }
        break;
      }
      default: break;
    }
    std::snprintf(error, capacity, "%s", "Dynamic-value native test backend cannot decode Lua result");
    return false;
  }

  dynamic::DispatchStatus invoke(const dynamic::Operation& operation, ScriptCallFrame* frame, char* error, size_t capacity) {
    const int base = lua_gettop(state);
    activeArguments = frame->arguments;
    activeArgumentCount = frame->argumentCount;
    lua_rawgeti(state, LUA_REGISTRYINDEX, functionRefs[operation.index]);
    for (uint32_t index = 0; index < frame->argumentCount; ++index) {
      if (!pushValue(frame->arguments[index])) {
        lua_settop(state, base); std::snprintf(error, capacity, "%s", "Dynamic-value argument cannot be represented in Lua");
        return dynamic::DispatchStatus::kError;
      }
    }
    if (lua_pcall(state, static_cast<int>(frame->argumentCount), LUA_MULTRET, 0) != 0) {
      const char* message = lua_tostring(state, -1);
      std::snprintf(error, capacity, "%s", message ? message : "Dynamic-value Lua call failed");
      lua_settop(state, base); return dynamic::DispatchStatus::kError;
    }
    const uint32_t count = static_cast<uint32_t>(lua_gettop(state) - base);
    if (count > frame->resultCapacity) {
      std::snprintf(error, capacity, "%s", "Dynamic-value result storage is exhausted");
      lua_settop(state, base); return dynamic::DispatchStatus::kError;
    }
    frame->stringScratchUsed = 0;
    for (uint32_t index = 0; index < count; ++index) {
      if (!readValue(base + 1 + static_cast<int>(index), frame, &frame->results[index], error, capacity)) {
        lua_settop(state, base); frame->resultCount = 0; return dynamic::DispatchStatus::kError;
      }
    }
    frame->resultCount = count;
    lua_settop(state, base);
    return dynamic::DispatchStatus::kSuccess;
  }

  static dynamic::DispatchStatus Invoke(void* context, const dynamic::Operation& operation,
      ScriptCallFrame* frame, char* error, size_t capacity) noexcept {
    return static_cast<Backend*>(context)->invoke(operation, frame, error, capacity);
  }
};

ScriptValue Number(double value) { ScriptValue result{}; result.tag = ScriptValueTag::kNumber; result.number = value; return result; }
ScriptValue Boolean(bool value) { ScriptValue result{}; result.tag = ScriptValueTag::kBoolean; result.number = value ? 1.0 : 0.0; return result; }
ScriptValue String(const char* value) { ScriptValue result{}; result.tag = ScriptValueTag::kString; result.data = value; result.length = static_cast<uint32_t>(std::strlen(value)); return result; }
ScriptValue KindValue(Kind kind) {
  ScriptValue result{};
  if (kind == Kind::kHash || kind == Kind::kUrl || kind == Kind::kVector) {
    result.tag = ScriptValueTag::kHandle;
    result.handleKind = kind == Kind::kHash ? ScriptHandleKind::kHash : kind == Kind::kUrl ? ScriptHandleKind::kUrl : ScriptHandleKind::kLuaUserdata;
    result.payload = kind == Kind::kVector ? kBorrowedVector : 1;
  } else {
    result.tag = ScriptValueTag::kDefoldValue;
    result.defoldKind = kind == Kind::kMatrix4 ? ScriptDefoldValueKind::kMatrix4 : kind == Kind::kQuat ? ScriptDefoldValueKind::kQuaternion : kind == Kind::kVector3 ? ScriptDefoldValueKind::kVector3 : ScriptDefoldValueKind::kVector4;
  }
  return result;
}

struct CallStorage {
  std::array<ScriptValue, dynamic::kMaximumArgumentCount> arguments{};
  std::array<ScriptValue, dynamic::kMaximumArgumentCount> results{};
  std::array<char, 256> strings{};
  std::array<char, 384> error{};
  ScriptCallFrame frame{};
  CallStorage(uint32_t stableId, uint32_t argumentCount) {
    frame.stableId = stableId; frame.arguments = arguments.data(); frame.argumentCount = argumentCount;
    frame.results = results.data(); frame.resultCapacity = static_cast<uint32_t>(results.size());
    frame.stringScratch = strings.data(); frame.stringScratchCapacity = static_cast<uint32_t>(strings.size());
  }
};

void ExpectSuccess(CallStorage& call, const dynamic::LuaApi& api) {
  if (dynamic::dispatch(&call.frame, call.error.data(), call.error.size(), &api) != dynamic::DispatchStatus::kSuccess) Fail(call.error.data());
}
}

void* operator new(std::size_t size) {
  if (gTrackCppAllocations.load(std::memory_order_relaxed)) gCppAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* pointer = std::malloc(size)) return pointer;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete[](void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { std::free(pointer); }

int main() {
  LuaAllocatorStats allocatorStats;
  lua_State* state = lua_newstate(CountingLuaAllocator, &allocatorStats);
  Expect(state != nullptr, "unable to create Lua 5.1 state");
  luaL_openlibs(state);
  Backend backend;
  Expect(backend.initialize(state), "unable to initialize exact Lua backend");
  const dynamic::LuaApi api{&backend, Backend::Invoke};

  {
    CallStorage call(UINT32_C(0x7872f480), 4);
    call.arguments[0] = Number(0x12345678); call.arguments[1] = Number(0xff);
    call.arguments[2] = Number(-1); call.arguments[3] = Number(0x7f);
    ExpectSuccess(call, api);
    Expect(call.frame.resultCount == 1 && call.results[0].number == 0x78, "bit.band differs from pinned Lua BitOp");
  }
  {
    CallStorage call(UINT32_C(0x0892398e), 4);
    call.arguments[0] = Number(1); call.arguments[1] = Number(2); call.arguments[2] = Number(4); call.arguments[3] = Number(8);
    ExpectSuccess(call, api);
    Expect(call.results[0].number == 15, "bit.bor varargs differ");
  }
  {
    CallStorage call(UINT32_C(0x948f508c), 2);
    call.arguments[0] = Number(0xa5a5f0f0); call.arguments[1] = Number(0xaa55ff00);
    ExpectSuccess(call, api);
    Expect(call.results[0].number == 267390960, "bit.bxor signed 32-bit result differs");
  }
  {
    CallStorage call(UINT32_C(0x9b0d4932), 4);
    call.arguments[0] = Number(1); call.arguments[1] = String("first"); call.arguments[2] = Boolean(true); call.arguments[3] = Number(3);
    ExpectSuccess(call, api);
    Expect(call.frame.resultCount == 2, "socket.skip result count differs");
    Expect(call.results[0].tag == ScriptValueTag::kBoolean && call.results[0].number == 1.0, "socket.skip boolean differs");
    Expect(call.results[1].tag == ScriptValueTag::kNumber && call.results[1].number == 3.0, "socket.skip number differs");
  }
  {
    CallStorage call(UINT32_C(0x9b0d4932), 3);
    call.arguments[0] = Number(-1); call.arguments[1] = Number(7); call.arguments[2] = Number(8);
    ExpectSuccess(call, api);
    Expect(call.frame.resultCount == 3 && call.results[0].number == -1, "socket.skip negative drop must preserve LuaSocket behavior");
  }

  constexpr uint32_t typeIds[] = {
    UINT32_C(0x206a89ba), UINT32_C(0x9acd4145), UINT32_C(0xc6f91f35), UINT32_C(0xfaf3e587),
    UINT32_C(0xc8496cbd), UINT32_C(0xd995e38a), UINT32_C(0xd495dbab)
  };
  constexpr Kind typeKinds[] = {Kind::kHash, Kind::kMatrix4, Kind::kQuat, Kind::kUrl, Kind::kVector, Kind::kVector3, Kind::kVector4};
  for (size_t index = 0; index < std::size(typeIds); ++index) {
    CallStorage yes(typeIds[index], 1); yes.arguments[0] = KindValue(typeKinds[index]); ExpectSuccess(yes, api);
    Expect(yes.results[0].tag == ScriptValueTag::kBoolean && yes.results[0].number == 1.0, "types positive query differs");
    CallStorage no(typeIds[index], 1); no.arguments[0] = Number(1); ExpectSuccess(no, api);
    Expect(no.results[0].number == 0.0, "types negative query differs");
    CallStorage missing(typeIds[index], 0); ExpectSuccess(missing, api);
    Expect(missing.results[0].number == 0.0, "types missing argument must return false");
  }

  {
    CallStorage missing(UINT32_C(0x7872f480), 0);
    Expect(dynamic::dispatch(&missing.frame, missing.error.data(), missing.error.size(), &api) == dynamic::DispatchStatus::kError,
      "missing bit argument must fail before Lua");
    Expect(std::strcmp(missing.error.data(), "Dynamic-value argument count is outside the generated fixed capacity") == 0,
      "generated argument-count error drifted");
    Expect(missing.frame.resultCount == 0, "failed dispatch exposed partial results");
  }
  {
    char directError[384]{};
    lua_getglobal(state, "bit");
    lua_getfield(state, -1, "band");
    lua_remove(state, -2);
    lua_pushliteral(state, "not-a-number");
    Expect(lua_pcall(state, 1, LUA_MULTRET, 0) != 0, "direct Lua BitOp wrong type unexpectedly succeeded");
    std::snprintf(directError, sizeof(directError), "%s", lua_tostring(state, -1));
    lua_pop(state, 1);
    CallStorage wrong(UINT32_C(0x7872f480), 1); wrong.arguments[0] = String("not-a-number");
    Expect(dynamic::dispatch(&wrong.frame, wrong.error.data(), wrong.error.size(), &api) == dynamic::DispatchStatus::kError,
      "Lua BitOp wrong type must fail");
    Expect(std::strcmp(wrong.error.data(), directError) == 0, "exact Lua BitOp error was not propagated byte-for-byte");
    Expect(wrong.frame.resultCount == 0, "Lua error exposed partial results");
  }
  {
    CallStorage exhausted(UINT32_C(0x9b0d4932), 3);
    exhausted.arguments[0] = Number(-1); exhausted.arguments[1] = Number(1); exhausted.arguments[2] = Number(2);
    exhausted.frame.resultCapacity = 2;
    Expect(dynamic::dispatch(&exhausted.frame, exhausted.error.data(), exhausted.error.size(), &api) == dynamic::DispatchStatus::kError,
      "variable result overflow must fail closed");
    Expect(std::strcmp(exhausted.error.data(), "Dynamic-value result storage is exhausted") == 0,
      "result-capacity error drifted");
    Expect(exhausted.frame.resultCount == 0, "capacity failure exposed partial results");
  }

  // Warm every executable strategy before observing allocator traffic.
  for (int iteration = 0; iteration < 64; ++iteration) {
    CallStorage bit(UINT32_C(0x0892398e), 3); bit.arguments[0] = Number(1); bit.arguments[1] = Number(2); bit.arguments[2] = Number(4); ExpectSuccess(bit, api);
    CallStorage type(UINT32_C(0xd995e38a), 1); type.arguments[0] = KindValue(Kind::kVector3); ExpectSuccess(type, api);
    CallStorage skip(UINT32_C(0x9b0d4932), 3); skip.arguments[0] = Number(1); skip.arguments[1] = Number(2); skip.arguments[2] = Number(3); ExpectSuccess(skip, api);
  }
  const size_t liveBefore = allocatorStats.liveBytes;
  gCppAllocations.store(0); gTrackCppAllocations.store(true); allocatorStats.calls = allocatorStats.allocations = allocatorStats.frees = 0; allocatorStats.tracking = true;
  for (int iteration = 0; iteration < 10000; ++iteration) {
    CallStorage bit(UINT32_C(0x948f508c), 3); bit.arguments[0] = Number(iteration); bit.arguments[1] = Number(0xff); bit.arguments[2] = Number(0x55); ExpectSuccess(bit, api);
    CallStorage type(UINT32_C(0xc6f91f35), 1); type.arguments[0] = KindValue(Kind::kQuat); ExpectSuccess(type, api);
    CallStorage skip(UINT32_C(0x9b0d4932), 3); skip.arguments[0] = Number(1); skip.arguments[1] = Number(2); skip.arguments[2] = Number(3); ExpectSuccess(skip, api);
  }
  allocatorStats.tracking = false; gTrackCppAllocations.store(false);
  Expect(gCppAllocations.load() == 0, "warmed generated/Lua path allocated through C++ new");
  Expect(allocatorStats.allocations == 0 && allocatorStats.liveBytes == liveBefore,
    "warmed generated/Lua path allocated or leaked Lua heap storage");

  backend.shutdown();
  lua_close(state);
  Expect(allocatorStats.liveBytes == 0, "Lua state leaked allocator-tracked bytes");
  std::puts("script-dynamic-value:routes:11:ok");
  std::puts("script-dynamic-value:exact-bitop:ok");
  std::puts("script-dynamic-value:allocations:0");
  return 0;
}
