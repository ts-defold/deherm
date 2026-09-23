#include <defold_hermes/generated_script_universal_value_bindings.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include <lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace universal = defold_hermes::universal_value;
namespace handle = defold_hermes::script_handle_lowering;
namespace scalar = defold_hermes::lua_bridge::scalar;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace dmScript {
void PushHash(lua_State*, dmhash_t) {}
void PushVector3(lua_State*, const dmVMath::Vector3&) {}
void PushVector4(lua_State*, const dmVMath::Vector4&) {}
void PushQuat(lua_State*, const dmVMath::Quat&) {}
void PushURL(lua_State*, const dmMessage::URL&) {}
void PushMatrix4(lua_State*, const dmVMath::Matrix4&) {}
dmhash_t* ToHash(lua_State*, int) { return nullptr; }
dmVMath::Vector3* ToVector3(lua_State*, int) { return nullptr; }
dmVMath::Vector4* ToVector4(lua_State*, int) { return nullptr; }
dmVMath::Quat* ToQuat(lua_State*, int) { return nullptr; }
dmVMath::Matrix4* ToMatrix4(lua_State*, int) { return nullptr; }
dmMessage::URL* ToURL(lua_State*, int) { return nullptr; }
}  // namespace dmScript

namespace {

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "script-constant-lua-adapter:error:%s\n", message);
  std::exit(1);
}

void expect(bool condition, const char* message) {
  if (!condition) fail(message);
}

const universal::Operation* operation(const char* id) {
  for (size_t index = 0; index < universal::kOperationCount; ++index) {
    const auto& candidate = universal::operations()[index];
    if (std::strcmp(candidate.canonicalId, id) == 0) return &candidate;
  }
  return nullptr;
}

void installNumber(lua_State* state, const char* module, const char* member, lua_Number value) {
  lua_newtable(state);
  lua_pushnumber(state, value);
  lua_setfield(state, -2, member);
  lua_setglobal(state, module);
}

void installJsonNull(lua_State* state) {
  lua_newtable(state);
  lua_pushlightuserdata(state, nullptr);
  lua_setfield(state, -2, "null");
  lua_setglobal(state, "json");
}

bool dispatch(scalar::ScriptAdapter& adapter, const universal::Operation& route,
    uint32_t argumentCount, ScriptValue* result) {
  ScriptCallFrame frame{};
  frame.stableId = route.stableId;
  frame.argumentCount = argumentCount;
  frame.results = result;
  frame.resultCapacity = 1;
  return adapter.dispatch(&frame);
}

}  // namespace

int main() {
  lua_State* state = luaL_newstate();
  expect(state != nullptr, "could not create Lua state");
  installNumber(state, "b2d", "B2_DYNAMIC_BODY", 7.0);
  // The generated member path is b2d.body, not b2d, so install the exact nested shape.
  lua_getglobal(state, "b2d");
  lua_newtable(state);
  lua_pushnumber(state, 7.0);
  lua_setfield(state, -2, "B2_DYNAMIC_BODY");
  lua_setfield(state, -2, "body");
  lua_pop(state, 1);
  installJsonNull(state);

  scalar::ScriptAdapter adapter;
  const auto* profile = handle::findRuntimeProfile("default-legacy-bullet");
  expect(profile && adapter.initialize(state, {}, handle::runtimeProfileHandshake(*profile)),
      "adapter initialization failed");

  const auto* numberRoute = operation("script:constant.b2d.body.B2_DYNAMIC_BODY");
  const auto* nullRoute = operation("script:constant.json.null");
  const auto* absentRoute = operation("script:constant.liveupdate.LIVEUPDATE_OK");
  expect(numberRoute && numberRoute->constant && nullRoute && nullRoute->constant &&
      absentRoute && absentRoute->constant, "generated constant routes are incomplete");

  ScriptValue result{};
  expect(dispatch(adapter, *numberRoute, 0, &result), adapter.lastError());
  expect(result.tag == ScriptValueTag::kNumber && result.number == 7.0,
      "constant route did not return the exact Lua number");
  expect(lua_gettop(state) == 0, "constant route leaked the Lua stack");

  expect(!dispatch(adapter, *numberRoute, 1, &result), "constant route accepted an argument");
  expect(lua_gettop(state) == 0, "wrong-arity constant route leaked the Lua stack");

  expect(!dispatch(adapter, *absentRoute, 0, &result), "profile-unavailable constant unexpectedly executed");
  expect(lua_gettop(state) == 0, "absent-profile constant leaked the Lua stack");

  result = {};
  expect(dispatch(adapter, *nullRoute, 0, &result), adapter.lastError());
  expect(result.tag == ScriptValueTag::kHandle && result.handleKind == ScriptHandleKind::kLuaUserdata,
      "json.null sentinel collapsed into nil or another scalar");
  auto api = adapter.api();
  api.releaseHandle(api.context, result.handleKind, result.length, result.payload);
  expect(lua_gettop(state) == 0, "json.null constant route leaked the Lua stack");

  adapter.shutdown();
  lua_close(state);
  std::puts("script-constant-lua-adapter:constants:exact-lookup-stack-arity-profile-json-null:ok");
}
