#include <defold_hermes/runtime.hpp>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/generated_script_callback_lifecycle.hpp>

#include <dmsdk/dlib/vmath.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include <cstring>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace scalar = defold_hermes::lua_bridge::scalar;
namespace {

int gCurrentInstance = 7;
int gObservedCalls = 0;
int gCallbackArgumentGc = 0;
std::string gTitle;

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "script-api-hermes-e2e:error:%s\n", message);
  std::exit(1);
}

void CheckInstance(lua_State* state) {
  if (gCurrentInstance != 42) luaL_error(state, "wrong Defold script instance");
  ++gObservedCalls;
}

void GetInstance(lua_State* state) { lua_pushnumber(state, gCurrentInstance); }

void SetInstance(lua_State* state) {
  gCurrentInstance = static_cast<int>(luaL_checknumber(state, -1));
  lua_pop(state, 1);
}

int GetConfigInt(lua_State* state) {
  CheckInstance(state);
  const char* key = luaL_checkstring(state, 1);
  if (std::string(key) == "explode") return luaL_error(state, "forced config error");
  const double fallback = lua_gettop(state) >= 2 ? luaL_checknumber(state, 2) : 0;
  lua_pushnumber(state, fallback + 35);
  return 1;
}

int Exists(lua_State* state) {
  CheckInstance(state);
  lua_pushboolean(state, std::string(luaL_checkstring(state, 1)) == "/known");
  return 1;
}

int Save(lua_State* state) {
  CheckInstance(state);
  const std::string path = luaL_checkstring(state, 1);
  if (path == "callback" || path == "callback-error") {
    lua_getfield(state, 2, "nested");
    lua_getfield(state, -1, "callback");
    luaL_checktype(state, -1, LUA_TFUNCTION);
    lua_setglobal(state, path == "callback" ? "__dehermGenericCallback" : "__dehermFailedJsCallback");
    if (path == "callback-error") return luaL_error(state, "retained callback before Lua failure");
    return 0;
  }
  if (path != "state") return luaL_error(state, "wrong save path");
  if (!lua_istable(state, 2)) return luaL_error(state, "save payload is not a table");
  lua_getfield(state, 2, "score");
  if (lua_tonumber(state, -1) != 42) return luaL_error(state, "save score mismatch");
  lua_pop(state, 1);
  lua_getfield(state, 2, "nested");
  if (!lua_istable(state, -1)) return luaL_error(state, "save nested payload missing");
  lua_getfield(state, -1, "values");
  if (!lua_istable(state, -1)) return luaL_error(state, "save sequence missing");
  lua_rawgeti(state, -1, 3);
  if (lua_tonumber(state, -1) != 3) return luaL_error(state, "save sequence mismatch");
  lua_pop(state, 3);
  return 0;
}

int Load(lua_State* state) {
  CheckInstance(state);
  const std::string path = luaL_checkstring(state, 1);
  if (path == "cycle") {
    lua_createtable(state, 0, 1);
    lua_pushvalue(state, -1);
    lua_setfield(state, -2, "self");
    return 1;
  }
  if (path != "state") return luaL_error(state, "wrong load path");
  lua_createtable(state, 0, 2);
  lua_pushnumber(state, 42);
  lua_setfield(state, -2, "score");
  lua_createtable(state, 0, 2);
  lua_pushstring(state, "ok");
  lua_setfield(state, -2, "label");
  lua_createtable(state, 3, 0);
  for (int index = 1; index <= 3; ++index) {
    lua_pushnumber(state, index);
    lua_rawseti(state, -2, index);
  }
  lua_setfield(state, -2, "values");
  lua_setfield(state, -2, "nested");
  return 1;
}

int LoadResource(lua_State* state) {
  CheckInstance(state);
  const std::string path = luaL_checkstring(state, 1);
  if (path == "/exists") {
    lua_pushstring(state, "resource-data");
    return 1;
  }
  lua_pushnil(state);
  lua_pushstring(state, "resource-missing");
  return 2;
}

int SocketTry(lua_State* state) {
  CheckInstance(state);
  if (lua_toboolean(state, 1)) return lua_gettop(state);
  lua_pushvalue(state, lua_upvalueindex(1));
  if (lua_pcall(state, 0, 0, 0) != 0) lua_pop(state, 1);
  lua_settop(state, 2);
  lua_createtable(state, 1, 0);
  lua_pushvalue(state, 2);
  lua_rawseti(state, -2, 1);
  return lua_error(state);
}

int SocketNewTry(lua_State* state) {
  CheckInstance(state);
  luaL_checktype(state, 1, LUA_TFUNCTION);
  lua_settop(state, 1);
  lua_pushcclosure(state, SocketTry, 1);
  return 1;
}

int SocketProtected(lua_State* state) {
  CheckInstance(state);
  lua_pushvalue(state, lua_upvalueindex(1));
  lua_insert(state, 1);
  if (lua_pcall(state, lua_gettop(state) - 1, LUA_MULTRET, 0) == 0) {
    return lua_gettop(state);
  }
  if (!lua_istable(state, -1)) return lua_error(state);
  lua_rawgeti(state, -1, 1);
  lua_pushnil(state);
  lua_insert(state, -2);
  return 2;
}

int SocketProtect(lua_State* state) {
  CheckInstance(state);
  luaL_checktype(state, 1, LUA_TFUNCTION);
  lua_settop(state, 1);
  lua_pushcclosure(state, SocketProtected, 1);
  return 1;
}

int GetWidth(lua_State* state) {
  CheckInstance(state);
  lua_pushnumber(state, 128);
  return 1;
}

int ToHex(lua_State* state) {
  CheckInstance(state);
  const unsigned value = static_cast<unsigned>(luaL_checknumber(state, 1));
  const int width = lua_gettop(state) >= 2 ? static_cast<int>(luaL_checknumber(state, 2)) : 8;
  char output[32];
  std::snprintf(output, sizeof(output), "%0*x", width, value);
  lua_pushstring(state, output);
  return 1;
}

int SetTitle(lua_State* state) {
  CheckInstance(state);
  gTitle = luaL_checkstring(state, 1);
  return 0;
}

int SetWindowListener(lua_State* state) {
  CheckInstance(state);
  luaL_checktype(state, 1, LUA_TFUNCTION);
  lua_pushvalue(state, 1);
  lua_setglobal(state, "__dehermRetainedJsCallback");
  lua_pushvalue(state, 1);
  lua_pushnumber(state, 42);
  lua_pushnumber(state, 1);
  lua_createtable(state, 0, 2);
  lua_pushnumber(state, 1920);
  lua_setfield(state, -2, "width");
  lua_pushnumber(state, 1080);
  lua_setfield(state, -2, "height");
  lua_newuserdata(state, 8);
  if (luaL_newmetatable(state, "deherm.callback_argument_test")) {
    lua_pushcfunction(state, [](lua_State*) -> int { ++gCallbackArgumentGc; return 0; });
    lua_setfield(state, -2, "__gc");
  }
  lua_setmetatable(state, -2);
  if (lua_pcall(state, 4, 0, 0) != 0) return lua_error(state);
  return 0;
}

int GetGroupGain(lua_State* state) {
  CheckInstance(state);
  if (std::string(luaL_checkstring(state, 1)) != "music") return luaL_error(state, "wrong sound group");
  lua_pushnumber(state, 0.75);
  return 1;
}

int Dot(lua_State* state) {
  CheckInstance(state);
  auto* left = static_cast<dmVMath::Vector3*>(lua_touserdata(state, 1));
  auto* right = static_cast<dmVMath::Vector3*>(lua_touserdata(state, 2));
  if (!left || !right) return luaL_error(state, "dot expected vector3 userdata");
  lua_pushnumber(state, left->getX() * right->getX() + left->getY() * right->getY() + left->getZ() * right->getZ());
  return 1;
}

int GetBody(lua_State* state) {
  CheckInstance(state);
  lua_newuserdata(state, 8);
  return 1;
}

int GetJoints(lua_State* state) {
  CheckInstance(state);
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "body userdata missing");
  lua_createtable(state, 1, 0);
  lua_newuserdata(state, 16);
  lua_rawseti(state, -2, 1);
  return 1;
}

int GetBodyA(lua_State* state) {
  ++gObservedCalls;
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "joint userdata missing");
  lua_newuserdata(state, 8);
  return 1;
}

int DumpBody(lua_State* state) {
  ++gObservedCalls;
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "body userdata missing");
  return 0;
}

void Register(lua_State* state, const char* module, const luaL_Reg* functions) {
  luaL_register(state, module, functions);
  lua_pop(state, 1);
}

class TestHost final : public defold_hermes::Host {
 public:
  void log(const std::string& level, const std::string& message) override {
    transcript.push_back(level + ":" + message);
  }
  double now() override { return 1; }
  std::string request(const std::string&, const std::string&) override { return {}; }
  std::vector<std::string> transcript;
};

bool NeverInvoke(void*, const defold_hermes::ScriptCallFrame*, void*,
    defold_hermes::ScriptCallbackConsume, char*, size_t) noexcept { return false; }
void NoopReference(void*) noexcept {}

struct BridgeHarness {
  defold_hermes::ScriptBridgeApi delegate{};
  uint32_t byteCalls = 0;
  std::string error;
};

bool DispatchHarness(void* raw, defold_hermes::ScriptCallFrame* frame) {
  auto* harness = static_cast<BridgeHarness*>(raw);
  if (frame && frame->stableId == UINT32_C(0xf6c4cfba)) {
    static constexpr unsigned char expected[] = {0x00, 0x80, 0xff, 0x41};
    if (frame->argumentCount != 6 || !frame->arguments ||
        frame->arguments[4].tag != defold_hermes::ScriptValueTag::kBytes ||
        frame->arguments[4].length != sizeof(expected) ||
        !frame->arguments[4].data ||
        std::memcmp(frame->arguments[4].data, expected, sizeof(expected)) != 0) {
      harness->error = "texture payload did not cross JSI as exact bytes";
      return false;
    }
    ++harness->byteCalls;
    if (!frame->results || frame->resultCapacity == 0) {
      harness->error = "texture result storage is unavailable";
      return false;
    }
    frame->results[0] = {};
    frame->results[0].tag = defold_hermes::ScriptValueTag::kBoolean;
    frame->results[0].number = 1;
    frame->resultCount = 1;
    return true;
  }
  return harness->delegate.dispatch(harness->delegate.context, frame);
}

const char* LastHarnessError(void* raw) {
  auto* harness = static_cast<BridgeHarness*>(raw);
  return harness->error.empty() ? harness->delegate.lastError(harness->delegate.context) : harness->error.c_str();
}

void ReleaseHarnessHandle(
    void* raw,
    defold_hermes::ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept {
  auto* harness = static_cast<BridgeHarness*>(raw);
  if (harness->delegate.releaseHandle) {
    harness->delegate.releaseHandle(harness->delegate.context, kind, runtime, payload);
  }
}

defold_hermes::ScriptBridgeApi HarnessApi(BridgeHarness& harness) {
  return {&harness, DispatchHarness, LastHarnessError, ReleaseHarnessHandle};
}

struct CallbackProbe {
  uint32_t retained = 0;
  uint32_t released = 0;
  uint32_t invoked = 0;
  uint32_t finalized = 0;
};

bool InvokeProbe(void* raw, const defold_hermes::ScriptCallFrame*, void* context,
    defold_hermes::ScriptCallbackConsume consume, char*, size_t) noexcept {
  ++static_cast<CallbackProbe*>(raw)->invoked;
  const defold_hermes::ScriptCallFrame results{};
  return consume(context, &results);
}

void RetainProbe(void* raw) noexcept { ++static_cast<CallbackProbe*>(raw)->retained; }
void ReleaseProbe(void* raw) noexcept { ++static_cast<CallbackProbe*>(raw)->released; }

void InvokeRetained(lua_State* state, const char* name, const char* expectedError = nullptr) {
  const int base = lua_gettop(state);
  lua_getglobal(state, name);
  if (!lua_isfunction(state, -1)) Fail("generic nested callback was not retained");
  const int status = lua_pcall(state, 0, 0, 0);
  if (expectedError) {
    const char* error = lua_tostring(state, -1);
    if (status == 0 || !error || !std::strstr(error, expectedError)) {
      Fail("retained callback did not fail with the expected lifetime error");
    }
    lua_pop(state, 1);
  } else if (status != 0) {
    Fail(lua_tostring(state, -1));
  }
  if (lua_gettop(state) != base) Fail("retained callback leaked Lua stack");
}

void CheckGenericCallbackOwnership() {
  constexpr uint32_t stableId = UINT32_C(798578280);  // sys.save accepts a generic record.
  if (defold_hermes::callback_lifecycle::find(stableId)) Fail("generic probe acquired reviewed callback metadata");
  lua_State* state = luaL_newstate();
  if (!state) Fail("unable to create callback ownership Lua state");
  const luaL_Reg sys[] = {{"save", Save}, {nullptr, nullptr}};
  Register(state, "sys", sys);
  CallbackProbe probe;
  defold_hermes::ScriptCallback callback{&probe, InvokeProbe, RetainProbe, ReleaseProbe};
  auto adapter = std::make_unique<scalar::ScriptAdapter>();
  const auto* profile = defold_hermes::script_handle_lowering::findRuntimeProfile("default-legacy-bullet");
  auto initialize = [&]() {
    if (!profile || !adapter->initialize(state, {GetInstance, SetInstance},
            defold_hermes::script_handle_lowering::runtimeProfileHandshake(*profile))) Fail("callback adapter initialization failed");
    lua_pushnumber(state, 42);
    if (!adapter->captureInstance(-1)) Fail(adapter->lastError());
    lua_pop(state, 1);
  };
  auto dispatch = [&](const char* path) {
    defold_hermes::ScriptTableEntry inner{};
    inner.key.tag = defold_hermes::ScriptValueTag::kString;
    inner.key.data = "callback";
    inner.key.length = 8;
    inner.value.tag = defold_hermes::ScriptValueTag::kCallback;
    inner.value.data = &callback;
    defold_hermes::ScriptTableEntry outer{};
    outer.key.tag = defold_hermes::ScriptValueTag::kString;
    outer.key.data = "nested";
    outer.key.length = 6;
    outer.value.tag = defold_hermes::ScriptValueTag::kTable;
    outer.value.data = &inner;
    outer.value.length = 1;
    defold_hermes::ScriptValue arguments[2]{};
    arguments[0].tag = defold_hermes::ScriptValueTag::kString;
    arguments[0].data = path;
    arguments[0].length = static_cast<uint32_t>(std::strlen(path));
    arguments[1].tag = defold_hermes::ScriptValueTag::kTable;
    arguments[1].data = &outer;
    arguments[1].length = 1;
    defold_hermes::ScriptCallFrame frame{};
    frame.stableId = stableId;
    frame.arguments = arguments;
    frame.argumentCount = 2;
    return adapter->api().dispatch(adapter->api().context, &frame);
  };
  initialize();
  callback.release = nullptr;
  if (dispatch("callback") || probe.retained != 0) Fail("incomplete callback descriptor was retained");
  callback.release = ReleaseProbe;
  if (!dispatch("callback")) Fail(adapter->lastError());
  InvokeRetained(state, "__dehermGenericCallback");
  InvokeRetained(state, "__dehermGenericCallback");
  if (dispatch("callback-error")) Fail("retaining Lua failure unexpectedly succeeded");
  InvokeRetained(state, "__dehermFailedJsCallback");
  if (probe.retained != 2 || probe.released != 0 || probe.invoked != 3) Fail("generic ownership counts before GC are wrong");
  lua_pushnil(state);
  lua_setglobal(state, "__dehermFailedJsCallback");
  lua_gc(state, LUA_GCCOLLECT, 0);
  lua_gc(state, LUA_GCCOLLECT, 0);
  if (probe.released != 1) Fail("Lua failure callback was not released by GC");
  initialize();
  InvokeRetained(state, "__dehermGenericCallback", "destroyed Defold script adapter");
  if (!dispatch("callback")) Fail(adapter->lastError());
  lua_gc(state, LUA_GCCOLLECT, 0);
  lua_gc(state, LUA_GCCOLLECT, 0);
  if (probe.retained != 3 || probe.released != 2) Fail("reinitialization callback ownership counts are wrong");
  InvokeRetained(state, "__dehermGenericCallback");
  // This finalizer is created after the callback root, matching Lua's reachable
  // extension-finalize -> adapter destruction -> lua_close teardown order.
  lua_newuserdata(state, 1);
  lua_newtable(state);
  lua_pushlightuserdata(state, &probe);
  lua_pushcclosure(state, [](lua_State* closing) -> int {
    InvokeRetained(closing, "__dehermGenericCallback", "destroyed Defold script adapter");
    ++static_cast<CallbackProbe*>(lua_touserdata(closing, lua_upvalueindex(1)))->finalized;
    return 0;
  }, 1);
  lua_setfield(state, -2, "__gc");
  lua_setmetatable(state, -2);
  lua_setglobal(state, "__dehermCallbackFinalizer");
  adapter->shutdown();
  adapter.reset();
  InvokeRetained(state, "__dehermGenericCallback", "destroyed Defold script adapter");
  lua_close(state);
  if (probe.invoked != 4 || probe.finalized != 1 || probe.released != 3) Fail("post-adapter Lua finalization ownership counts are wrong");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) Fail("expected bundled TypeScript fixture path");
  std::ifstream stream(argv[1]);
  if (!stream) Fail("unable to read bundled TypeScript fixture");
  std::ostringstream source;
  source << stream.rdbuf();

  lua_State* state = luaL_newstate();
  if (!state) Fail("unable to create Lua state");
  luaL_openlibs(state);
  const luaL_Reg sys[] = {
    {"get_config_int", GetConfigInt}, {"exists", Exists},
    {"save", Save}, {"load", Load}, {"load_resource", LoadResource},
    {nullptr, nullptr}
  };
  const luaL_Reg render[] = {{"get_width", GetWidth}, {nullptr, nullptr}};
  const luaL_Reg bit[] = {{"tohex", ToHex}, {nullptr, nullptr}};
  const luaL_Reg window[] = {
    {"set_title", SetTitle}, {"set_listener", SetWindowListener}, {nullptr, nullptr}
  };
  const luaL_Reg sound[] = {{"get_group_gain", GetGroupGain}, {nullptr, nullptr}};
  const luaL_Reg vmath[] = {{"dot", Dot}, {nullptr, nullptr}};
  const luaL_Reg b2d[] = {{"get_body", GetBody}, {nullptr, nullptr}};
  const luaL_Reg b2dBody[] = {{"dump", DumpBody}, {"get_joints", GetJoints}, {nullptr, nullptr}};
  const luaL_Reg b2dJoint[] = {{"get_body_a", GetBodyA}, {nullptr, nullptr}};
  const luaL_Reg socket[] = {
    {"newtry", SocketNewTry}, {"protect", SocketProtect}, {nullptr, nullptr}
  };
  Register(state, "sys", sys);
  Register(state, "render", render);
  Register(state, "bit", bit);
  Register(state, "window", window);
  Register(state, "sound", sound);
  Register(state, "vmath", vmath);
  Register(state, "b2d", b2d);
  Register(state, "b2d.body", b2dBody);
  Register(state, "b2d.joint", b2dJoint);
  Register(state, "socket", socket);

  scalar::ScriptAdapter adapter;
  const auto* runtimeProfile = defold_hermes::script_handle_lowering::findRuntimeProfile("default-legacy-bullet");
  if (!runtimeProfile || !adapter.initialize(state, {GetInstance, SetInstance},
      defold_hermes::script_handle_lowering::runtimeProfileHandshake(*runtimeProfile))) Fail(adapter.lastError());
  lua_pushnumber(state, 42);
  if (!adapter.captureInstance(-1)) Fail(adapter.lastError());
  lua_pop(state, 1);
  const int baseTop = lua_gettop(state);
  BridgeHarness bridgeHarness{adapter.api()};
  defold_hermes::installScriptBridgeApi(HarnessApi(bridgeHarness));

  defold_hermes::ScriptCallback ineligibleCallback{
    nullptr, NeverInvoke, NoopReference, NoopReference};
  defold_hermes::ScriptValue ineligibleValue{};
  ineligibleValue.tag = defold_hermes::ScriptValueTag::kCallback;
  ineligibleValue.data = &ineligibleCallback;
  defold_hermes::ScriptCallFrame ineligibleFrame{};
  ineligibleFrame.stableId = UINT32_C(407150266);
  ineligibleFrame.arguments = &ineligibleValue;
  ineligibleFrame.argumentCount = 1;
  defold_hermes::ScriptValue ineligibleResult{};
  ineligibleFrame.results = &ineligibleResult;
  ineligibleFrame.resultCapacity = 1;
  if (!adapter.api().dispatch(adapter.api().context, &ineligibleFrame)) {
    Fail(adapter.lastError());
  }
  if (ineligibleFrame.resultCount != 1 ||
      ineligibleResult.tag != defold_hermes::ScriptValueTag::kCallback ||
      !ineligibleResult.data) {
    Fail("higher-order Lua closure was not returned through the universal ABI");
  }
  auto* returnedClosure = const_cast<defold_hermes::ScriptCallback*>(
      static_cast<const defold_hermes::ScriptCallback*>(ineligibleResult.data));
  adapter.shutdown();
  defold_hermes::ScriptCallFrame destroyedLuaClosureFrame{};
  char destroyedLuaClosureError[256]{};
  if (returnedClosure->invoke(returnedClosure->context, &destroyedLuaClosureFrame,
          nullptr, nullptr, destroyedLuaClosureError, sizeof(destroyedLuaClosureError)) ||
      std::string(destroyedLuaClosureError).find("destroyed Defold script runtime") == std::string::npos) {
    Fail("returned Lua closure did not fail closed after adapter shutdown");
  }
  returnedClosure->release(returnedClosure->context);
  if (!adapter.initialize(state, {GetInstance, SetInstance},
      defold_hermes::script_handle_lowering::runtimeProfileHandshake(*runtimeProfile))) Fail(adapter.lastError());
  lua_pushnumber(state, 42);
  if (!adapter.captureInstance(-1)) Fail(adapter.lastError());
  lua_pop(state, 1);
  bridgeHarness.delegate = adapter.api();
  defold_hermes::installScriptBridgeApi(HarnessApi(bridgeHarness));

  const char savePath[] = "state";
  defold_hermes::ScriptTableEntry invalidMapEntry{};
  invalidMapEntry.key.tag = defold_hermes::ScriptValueTag::kNumber;
  invalidMapEntry.key.number = std::numeric_limits<double>::quiet_NaN();
  invalidMapEntry.value.tag = defold_hermes::ScriptValueTag::kNumber;
  invalidMapEntry.value.number = 1;
  defold_hermes::ScriptValue invalidMapArguments[2]{};
  invalidMapArguments[0].tag = defold_hermes::ScriptValueTag::kString;
  invalidMapArguments[0].data = savePath;
  invalidMapArguments[0].length = 5;
  invalidMapArguments[1].tag = defold_hermes::ScriptValueTag::kTable;
  invalidMapArguments[1].reserved = static_cast<uint8_t>(defold_hermes::ScriptTableKind::kMap);
  invalidMapArguments[1].data = &invalidMapEntry;
  invalidMapArguments[1].length = 1;
  defold_hermes::ScriptCallFrame invalidMapFrame{};
  invalidMapFrame.stableId = UINT32_C(798578280);
  invalidMapFrame.arguments = invalidMapArguments;
  invalidMapFrame.argumentCount = 2;
  if (adapter.api().dispatch(adapter.api().context, &invalidMapFrame)) {
    Fail("non-finite map key reached unprotected lua_settable");
  }
  if (std::string(adapter.lastError()).find("table key must be finite") == std::string::npos) {
    Fail("non-finite map key rejection was not explicit");
  }

  TestHost host;
  {
    defold_hermes::Runtime runtime(host);
    runtime.load(source.str(), "defold-hermes://script-api-e2e.js");
    runtime.init();
    lua_gc(state, LUA_GCCOLLECT, 0);
    if (gCallbackArgumentGc != 1) Fail("successful callback argument userdata root was not released");

  if (host.transcript.size() != 21) Fail("unexpected TypeScript transcript size");
  if (host.transcript[0] != "info:values:42:128:00ff:true") Fail("scalar values did not cross the full bridge");
  if (host.transcript[1] != "info:vmath:3:5:0.600000:0.800000:1.000000:4") Fail("Defold values did not cross the full Hermes bridge");
  if (host.transcript[2] != "info:overload-dot:25") Fail("overload route did not cross dynamic Hermes and Lua");
  if (host.transcript[3] != "info:value-tail-gain:0.75") Fail("value-tail route did not cross dynamic Hermes and Lua");
  if (host.transcript[4] != "info:vmath-nan-rejected:true") Fail("NaN Defold value input was not rejected through Hermes");
  if (host.transcript[5] != "info:hash:bigint:true") Fail("hash POD handle did not cross the full Hermes bridge");
  if (host.transcript[6].find("info:handle:box2d-body:") != 0 ||
      host.transcript[6].find(":dispose,generation,kind,runtime,slot:true:function") == std::string::npos) {
    Fail("semantic HostObject properties were not exposed");
  }
  if (host.transcript[7] != "info:nested-handle:box2d-joint:true:true") Fail("nested universal handle did not share branded identity and stale checks");
  if (host.transcript[8] != "info:handle-disposed:true") Fail("explicit handle dispose was not enforced");
  if (host.transcript[9] != "info:universal:42:ok:3") Fail("recursive universal value graph did not cross Hermes and Lua");
  if (host.transcript[10] != "info:universal-cycle:true") Fail("recursive universal value graph did not reject a JS cycle");
  if (host.transcript[11] != "info:universal-lua-cycle:true") Fail("recursive universal value graph did not reject a Lua cycle");
  if (host.transcript[12] != "info:callback:42:1:1920:1080") Fail("retained JavaScript callback did not cross Lua");
  if (host.transcript[13] != "info:closure-success:true:payload") Fail("returned Lua closure lost multi-results");
  if (host.transcript[14] != "info:closure-error:true:1") Fail("returned Lua closure lost error/finalizer semantics");
  if (host.transcript[15] != "info:protect-success:ok:7") Fail("protected Lua closure lost callback multi-results");
  if (host.transcript[16] != "info:protect-error:true:protected-boom:2") Fail("protected Lua closure lost tagged error semantics");
  if (host.transcript[17] != "info:load-resource:resource-data:true:resource-missing") Fail("variable Lua result arity was not normalized for the SDK tuple");
  if (host.transcript[18].find("not executable yet") == std::string::npos &&
      host.transcript[18].find("not in the executable scalar family") == std::string::npos &&
      host.transcript[18].find("handles, tables, and callbacks are not executable yet") == std::string::npos &&
      host.transcript[18].find("no generated kind tag") == std::string::npos &&
      host.transcript[18].find("Universal-value Lua function is unavailable") == std::string::npos) {
    Fail("unsupported family was not explicit");
  }
  if (host.transcript[19].find("forced config error") == std::string::npos) Fail("Lua error was not propagated");
  if (host.transcript[20] != "info:after-error:36") Fail("dispatch did not recover after Lua error");
  if (gCurrentInstance != 7) Fail("Defold script instance was not restored");
  if (lua_gettop(state) != baseTop) Fail("Lua stack was not restored");
  if (gObservedCalls != 31) Fail("unexpected number of Lua calls");
  if (gTitle != "deherm") Fail("void scalar call did not execute");
  if (bridgeHarness.byteCalls != 2) Fail("Uint8Array and ArrayBuffer did not both cross the JSI byte carrier");

    auto invokeDeferred = [&](double argument, double expected, bool throws = false) {
      lua_getglobal(state, "__dehermGenericCallback");
      if (!lua_isfunction(state, -1)) Fail("JSI nested callback did not survive dispatch return");
      lua_pushnumber(state, argument);
      const int status = lua_pcall(state, 1, 1, 0);
      if (throws) {
        const char* error = lua_tostring(state, -1);
        if (status == 0 || !error || !std::strstr(error, "deferred generic callback failure")) {
          Fail("deferred JSI callback error did not cross Lua");
        }
      } else if (status != 0 || !lua_isnumber(state, -1) || lua_tonumber(state, -1) != expected) {
        Fail("deferred JSI callback lost repeated invocation or nested bridge reentry");
      }
      lua_pop(state, 1);
      if (lua_gettop(state) != baseTop || gCurrentInstance != 7) Fail("deferred callback leaked stack or script context");
    };
    invokeDeferred(10, 11);
    invokeDeferred(20, 22);
    invokeDeferred(-1, 0, true);
    invokeDeferred(2, 39);
    InvokeRetained(state, "__dehermFailedJsCallback");
    lua_pushnil(state);
    lua_setglobal(state, "__dehermFailedJsCallback");
    lua_gc(state, LUA_GCCOLLECT, 0);
    runtime.finalize();
  }

  // The Lua closure deliberately outlives Hermes. Invocation must fail from
  // the invalidated native root without touching the destroyed JSI runtime,
  // and its later __gc release must remain safe.
  lua_getglobal(state, "__dehermRetainedJsCallback");
  if (!lua_isfunction(state, -1)) Fail("retained JavaScript callback was not rooted in Lua");
  lua_pushnumber(state, 42);
  lua_pushnumber(state, 1);
  lua_newtable(state);
  lua_newuserdata(state, 8);
  luaL_getmetatable(state, "deherm.callback_argument_test");
  lua_setmetatable(state, -2);
  if (lua_pcall(state, 4, 0, 0) == 0) Fail("destroyed-runtime callback invocation did not fail closed");
  const char* destroyedRuntimeError = lua_tostring(state, -1);
  if (!destroyedRuntimeError ||
      std::string(destroyedRuntimeError).find("destroyed Hermes runtime") == std::string::npos) {
    Fail("destroyed-runtime callback failure was not explicit");
  }
  lua_pop(state, 1);
  InvokeRetained(state, "__dehermGenericCallback", "destroyed Hermes runtime");
  lua_pushnil(state);
  lua_setglobal(state, "__dehermGenericCallback");
  lua_pushnil(state);
  lua_setglobal(state, "__dehermRetainedJsCallback");
  lua_gc(state, LUA_GCCOLLECT, 0);
  lua_gc(state, LUA_GCCOLLECT, 0);
  if (gCallbackArgumentGc != 2) Fail("failed callback argument userdata root was not released");
  if (lua_gettop(state) != baseTop) Fail("destroyed-runtime callback cleanup leaked Lua stack");
  defold_hermes::uninstallScriptBridgeApi();
  adapter.shutdown();
  lua_close(state);
  CheckGenericCallbackOwnership();
  std::printf("script-api-hermes-e2e:ok\n");
  return 0;
}
