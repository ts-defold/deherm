#include <defold_hermes/runtime.hpp>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

#include <dmsdk/dlib/vmath.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace scalar = defold_hermes::lua_bridge::scalar;
namespace {

int gCurrentInstance = 7;
int gObservedCalls = 0;
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
  if (std::string(luaL_checkstring(state, 1)) != "state") return luaL_error(state, "wrong save path");
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
    {"save", Save}, {"load", Load}, {nullptr, nullptr}
  };
  const luaL_Reg render[] = {{"get_width", GetWidth}, {nullptr, nullptr}};
  const luaL_Reg bit[] = {{"tohex", ToHex}, {nullptr, nullptr}};
  const luaL_Reg window[] = {{"set_title", SetTitle}, {nullptr, nullptr}};
  const luaL_Reg sound[] = {{"get_group_gain", GetGroupGain}, {nullptr, nullptr}};
  const luaL_Reg vmath[] = {{"dot", Dot}, {nullptr, nullptr}};
  const luaL_Reg b2d[] = {{"get_body", GetBody}, {nullptr, nullptr}};
  Register(state, "sys", sys);
  Register(state, "render", render);
  Register(state, "bit", bit);
  Register(state, "window", window);
  Register(state, "sound", sound);
  Register(state, "vmath", vmath);
  Register(state, "b2d", b2d);
  lua_getglobal(state, "b2d");
  lua_newtable(state);
  lua_pushcfunction(state, DumpBody);
  lua_setfield(state, -2, "dump");
  lua_setfield(state, -2, "body");
  lua_pop(state, 1);

  scalar::ScriptAdapter adapter;
  const auto* runtimeProfile = defold_hermes::script_handle_lowering::findRuntimeProfile("default-legacy-bullet");
  if (!runtimeProfile || !adapter.initialize(state, {GetInstance, SetInstance},
      defold_hermes::script_handle_lowering::runtimeProfileHandshake(*runtimeProfile))) Fail(adapter.lastError());
  lua_pushnumber(state, 42);
  if (!adapter.captureInstance(-1)) Fail(adapter.lastError());
  lua_pop(state, 1);
  const int baseTop = lua_gettop(state);
  defold_hermes::installScriptBridgeApi(adapter.api());

  TestHost host;
  defold_hermes::Runtime runtime(host);
  runtime.load(source.str(), "defold-hermes://script-api-e2e.js");
  runtime.init();

  if (host.transcript.size() != 14) Fail("unexpected TypeScript transcript size");
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
  if (host.transcript[7] != "info:handle-disposed:true") Fail("explicit handle dispose was not enforced");
  if (host.transcript[8] != "info:universal:42:ok:3") Fail("recursive universal value graph did not cross Hermes and Lua");
  if (host.transcript[9] != "info:universal-cycle:true") Fail("recursive universal value graph did not reject a JS cycle");
  if (host.transcript[10] != "info:universal-lua-cycle:true") Fail("recursive universal value graph did not reject a Lua cycle");
  if (host.transcript[11].find("not executable yet") == std::string::npos &&
      host.transcript[11].find("not in the executable scalar family") == std::string::npos &&
      host.transcript[11].find("handles, tables, and callbacks are not executable yet") == std::string::npos &&
      host.transcript[11].find("no generated kind tag") == std::string::npos &&
      host.transcript[11].find("Universal-value Lua function is unavailable") == std::string::npos) {
    Fail("unsupported family was not explicit");
  }
  if (host.transcript[12].find("forced config error") == std::string::npos) Fail("Lua error was not propagated");
  if (host.transcript[13] != "info:after-error:36") Fail("dispatch did not recover after Lua error");
  if (gCurrentInstance != 7) Fail("Defold script instance was not restored");
  if (lua_gettop(state) != baseTop) Fail("Lua stack was not restored");
  if (gObservedCalls != 14) Fail("unexpected number of Lua calls");
  if (gTitle != "deherm") Fail("void scalar call did not execute");

  runtime.finalize();
  defold_hermes::uninstallScriptBridgeApi();
  adapter.shutdown();
  lua_close(state);
  std::printf("script-api-hermes-e2e:ok\n");
  return 0;
}
