#include <defold_hermes/generated_script_url_bindings.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace url = defold_hermes::url_binding;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptResolvedUrl;
using defold_hermes::ScriptUrlArena;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;
namespace scalar = defold_hermes::lua_bridge::scalar;

namespace {
std::atomic<bool> gTrackAllocations{false};
std::atomic<uint64_t> gAllocations{0};
int gInstanceKey = 0;
void* gExpectedInstance = nullptr;
uint64_t gCalls = 0;
constexpr ScriptResolvedUrl kExactUrl{
  UINT64_C(0xfedcba9876543210), UINT64_C(0x0123456789abcdef),
  UINT64_C(0x8899aabbccddeeff), UINT64_C(0x1020304050607080)
};

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::exit(1);
}

void expect(bool condition, const char* message) { if (!condition) fail(message); }

void GetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_rawget(state, LUA_REGISTRYINDEX);
}

void SetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_insert(state, -2);
  lua_rawset(state, LUA_REGISTRYINDEX);
}

bool hasExpectedInstance(lua_State* state) {
  GetInstance(state);
  const bool matches = lua_touserdata(state, -1) == gExpectedInstance;
  lua_pop(state, 1);
  return matches;
}
}

void* operator new(std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) gAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* result = std::malloc(size)) return result;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) gAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* result = std::malloc(size)) return result;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

namespace dmScript {
void PushHash(lua_State* state, dmhash_t value) { *static_cast<dmhash_t*>(lua_newuserdata(state, sizeof(value))) = value; }
dmhash_t* ToHash(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmhash_t*>(lua_touserdata(state, index)) : nullptr; }
void PushVector3(lua_State* state, const dmVMath::Vector3& value) { *static_cast<dmVMath::Vector3*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushVector4(lua_State* state, const dmVMath::Vector4& value) { *static_cast<dmVMath::Vector4*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushQuat(lua_State* state, const dmVMath::Quat& value) { *static_cast<dmVMath::Quat*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value) { *static_cast<dmVMath::Matrix4*>(lua_newuserdata(state, sizeof(value))) = value; }
dmVMath::Vector3* ToVector3(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector3*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Vector4* ToVector4(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector4*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Quat* ToQuat(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Quat*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Matrix4* ToMatrix4(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Matrix4*>(lua_touserdata(state, index)) : nullptr; }
void PushURL(lua_State* state, const dmMessage::URL& value) { *static_cast<dmMessage::URL*>(lua_newuserdata(state, sizeof(value))) = value; }
dmMessage::URL* ToURL(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmMessage::URL*>(lua_touserdata(state, index)) : nullptr; }
}

namespace {
int MockGeneratedUrlRoute(lua_State* state) {
  if (!hasExpectedInstance(state)) return luaL_error(state, "captured instance differs");
  const uint16_t operationIndex = static_cast<uint16_t>(lua_tointeger(state, lua_upvalueindex(1)));
  const url::Operation& operation = url::operations()[operationIndex];
  const uint16_t* codecs = url::argumentCodecs() + operation.argumentOffset;
  if (lua_gettop(state) < operation.requiredArgumentCount || lua_gettop(state) > operation.maximumArgumentCount) {
    return luaL_error(state, "generated argument count differs");
  }
  for (int index = 1; index <= lua_gettop(state); ++index) {
    const uint16_t codec = codecs[index - 1];
    if ((codec & url::kUrl) && lua_isuserdata(state, index) &&
        lua_objlen(state, index) == sizeof(dmMessage::URL)) {
      auto* value = static_cast<dmMessage::URL*>(lua_touserdata(state, index));
      if (!value || value->m_Socket != kExactUrl.socket || value->_reserved != kExactUrl.reserved ||
          value->m_Path != kExactUrl.path || value->m_Fragment != kExactUrl.fragment) {
        return luaL_error(state, "exact four-lane URL differs");
      }
    }
  }
  ++gCalls;
  switch (operation.resultCodec) {
    case url::ResultCodec::kNone: return 0;
    case url::ResultCodec::kNil: lua_pushnil(state); return 1;
    case url::ResultCodec::kBoolean: lua_pushboolean(state, 1); return 1;
    case url::ResultCodec::kInteger: lua_pushinteger(state, 17); return 1;
    case url::ResultCodec::kNumber: lua_pushnumber(state, 3.25); return 1;
    case url::ResultCodec::kString: lua_pushliteral(state, "url-result"); return 1;
    case url::ResultCodec::kHash: dmScript::PushHash(state, UINT64_C(0x1122334455667788)); return 1;
    case url::ResultCodec::kHashOrNil: lua_pushnil(state); return 1;
    case url::ResultCodec::kUrl: {
      dmMessage::URL value{}; value.m_Socket=kExactUrl.socket; value._reserved=kExactUrl.reserved;
      value.m_Path=kExactUrl.path; value.m_Fragment=kExactUrl.fragment; dmScript::PushURL(state,value); return 1;
    }
    case url::ResultCodec::kVector3: dmScript::PushVector3(state, dmVMath::Vector3(1,2,3)); return 1;
    case url::ResultCodec::kVector4: dmScript::PushVector4(state, dmVMath::Vector4(1,2,3,4)); return 1;
    case url::ResultCodec::kQuaternion: dmScript::PushQuat(state, dmVMath::Quat(0,0,0,1)); return 1;
  }
  return luaL_error(state, "unknown generated result codec");
}

void installRoutes(lua_State* state) {
  const url::Operation* operations = url::operations();
  for (size_t index = 0; index < url::kBindingCount; ++index) {
    const auto& operation = operations[index];
    lua_getglobal(state, operation.module);
    if (!lua_istable(state, -1)) {
      lua_pop(state, 1);
      lua_newtable(state);
      lua_pushvalue(state, -1);
      lua_setglobal(state, operation.module);
    }
    lua_pushinteger(state, operation.index);
    lua_pushcclosure(state, MockGeneratedUrlRoute, 1);
    lua_setfield(state, -2, operation.member);
    lua_pop(state, 1);
  }
}

ScriptValue argumentFor(uint16_t codec, ScriptUrlArena<>& arena) {
  ScriptValue value{};
  if (codec & url::kUrl) {
    expect(arena.store(kExactUrl, &value), "URL arena exhausted while making generated arguments");
  } else if (codec & url::kString) {
    static constexpr char text[] = "generated";
    value.tag=ScriptValueTag::kString; value.data=text; value.length=sizeof(text)-1;
  } else if (codec & url::kHash) {
    value.tag=ScriptValueTag::kHandle; value.handleKind=ScriptHandleKind::kHash;
    value.payload=UINT64_C(0x8877665544332211);
  } else if (codec & url::kBoolean) {
    value.tag=ScriptValueTag::kBoolean; value.number=1;
  } else if (codec & (url::kInteger|url::kNumber)) {
    value.tag=ScriptValueTag::kNumber; value.number=7;
  } else if (codec & url::kVector3) {
    value.tag=ScriptValueTag::kDefoldValue; value.defoldKind=ScriptDefoldValueKind::kVector3;
    value.defoldValue[0]=1;value.defoldValue[1]=2;value.defoldValue[2]=3;
  } else if (codec & url::kVector4) {
    value.tag=ScriptValueTag::kDefoldValue; value.defoldKind=ScriptDefoldValueKind::kVector4;
    value.defoldValue[0]=1;value.defoldValue[1]=2;value.defoldValue[2]=3;value.defoldValue[3]=4;
  } else if (codec & url::kQuaternion) {
    value.tag=ScriptValueTag::kDefoldValue; value.defoldKind=ScriptDefoldValueKind::kQuaternion;
    value.defoldValue[3]=1;
  } else {
    value.tag=ScriptValueTag::kNull;
  }
  return value;
}

bool dispatch(
    scalar::ScriptAdapter& adapter,
    const url::Operation& operation,
    ScriptValue* arguments,
    uint32_t argumentCount,
    ScriptUrlArena<>* arena,
    ScriptValue* result,
    char* scratch) {
  ScriptCallFrame frame{};
  frame.stableId=operation.stableId; frame.arguments=arguments; frame.argumentCount=argumentCount;
  frame.results=result; frame.resultCapacity=1; frame.stringScratch=scratch;
  frame.stringScratchCapacity=64; frame.urlArena=arena;
  return adapter.dispatch(&frame);
}
}

int main() {
  lua_State* state = luaL_newstate();
  expect(state != nullptr, "could not create Lua state");
  installRoutes(state);
  int instanceToken = 0;
  gExpectedInstance = &instanceToken;
  lua_pushlightuserdata(state, gExpectedInstance);
  SetInstance(state);
  scalar::ScriptAdapter adapter;
  const auto* runtimeProfile = defold_hermes::script_handle_lowering::findRuntimeProfile("default-legacy-bullet");
  expect(runtimeProfile && adapter.initialize(state, {GetInstance, SetInstance},
      defold_hermes::script_handle_lowering::runtimeProfileHandshake(*runtimeProfile)), "adapter initialization failed");
  lua_pushlightuserdata(state, gExpectedInstance);
  expect(adapter.captureInstance(-1), "instance capture failed");
  lua_pop(state, 1);

  const url::Operation* operations = url::operations();
  for (size_t operationIndex = 0; operationIndex < url::kBindingCount; ++operationIndex) {
    const auto& operation = operations[operationIndex];
    ScriptUrlArena<> arena(77);
    ScriptUrlArena<>::Frame arenaFrame(arena);
    std::array<ScriptValue, 6> arguments{};
    const uint16_t* codecs = url::argumentCodecs() + operation.argumentOffset;
    for (uint32_t index = 0; index < operation.maximumArgumentCount; ++index) {
      arguments[index] = argumentFor(codecs[index], arena);
    }
    ScriptValue result{};
    char scratch[64]{};
    expect(dispatch(adapter, operation, arguments.data(), operation.maximumArgumentCount,
        &arena, &result, scratch), adapter.lastError());
  }
  expect(gCalls == url::kBindingCount, "not every generated URL route reached Lua");

  const url::Operation* representative = url::find(UINT32_C(0x6f4d6345));
  if (!representative) {
    for (size_t index=0;index<url::kBindingCount;++index) if (std::strcmp(operations[index].canonicalId,"script:physics.set_group")==0) representative=&operations[index];
  }
  expect(representative != nullptr, "representative URL route is absent");
  ScriptValue result{}; char scratch[64]{};
  {
    ScriptUrlArena<> arena(77);
    ScriptValue arguments[2]{};
    static constexpr char address[] = "#body"; static constexpr char group[] = "player";
    arguments[0].tag=ScriptValueTag::kString;arguments[0].data=address;arguments[0].length=sizeof(address)-1;
    arguments[1].tag=ScriptValueTag::kString;arguments[1].data=group;arguments[1].length=sizeof(group)-1;
    expect(dispatch(adapter,*representative,arguments,2,&arena,&result,scratch),"string shorthand failed");
    arguments[0]={};arguments[0].tag=ScriptValueTag::kHandle;arguments[0].handleKind=ScriptHandleKind::kHash;arguments[0].payload=9;
    expect(dispatch(adapter,*representative,arguments,2,&arena,&result,scratch),"hash shorthand failed");
  }
  {
    ScriptUrlArena<> owner(88), other(88);
    ScriptValue full{}; expect(owner.store(kExactUrl,&full),"cross-arena setup failed");
    ScriptValue arguments[2]{full,{}}; static constexpr char group[]="group";
    arguments[1].tag=ScriptValueTag::kString;arguments[1].data=group;arguments[1].length=sizeof(group)-1;
    expect(!dispatch(adapter,*representative,arguments,2,&other,&result,scratch),"cross-arena URL was accepted");
    expect(std::strstr(adapter.lastError(),"stale, collapsed, or belongs")!=nullptr,"cross-arena failure was not diagnostic");
    ScriptValue collapsed{};collapsed.tag=ScriptValueTag::kHandle;collapsed.handleKind=ScriptHandleKind::kUrl;collapsed.payload=1;
    arguments[0]=collapsed;
    expect(!dispatch(adapter,*representative,arguments,2,&owner,&result,scratch),"collapsed URL was accepted");
    arguments[0]=full;
    expect(!dispatch(adapter,*representative,arguments,2,nullptr,&result,scratch),"full URL without an arena was accepted");
  }
  {
    const url::Operation* hot=nullptr;
    for(size_t index=0;index<url::kBindingCount;++index) if(std::strcmp(operations[index].canonicalId,"script:sound.set_gain")==0) hot=&operations[index];
    expect(hot!=nullptr,"allocation route is absent");
    ScriptUrlArena<> arena(99); ScriptValue arguments[2]{};
    expect(arena.store(kExactUrl,&arguments[0]),"allocation URL setup failed");
    arguments[1].tag=ScriptValueTag::kNumber;arguments[1].number=0.5;
    expect(dispatch(adapter,*hot,arguments,2,&arena,&result,scratch),"allocation warmup failed");
    const uint64_t baseline=gAllocations.load(std::memory_order_relaxed);
    gTrackAllocations.store(true,std::memory_order_relaxed);
    for(int iteration=0;iteration<1024;++iteration) expect(dispatch(adapter,*hot,arguments,2,&arena,&result,scratch),"allocation loop failed");
    gTrackAllocations.store(false,std::memory_order_relaxed);
    expect(gAllocations.load(std::memory_order_relaxed)==baseline,"warmed URL bridge allocated through C++ new");
  }

  adapter.shutdown();
  lua_close(state);
  std::printf("script-url-binding:routes:%zu:ok\nscript-url-binding:shorthand-distinct:ok\nscript-url-binding:allocations:0\n", url::kBindingCount);
  return 0;
}
