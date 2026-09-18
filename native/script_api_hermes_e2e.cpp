#include <defold_hermes/runtime.hpp>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

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
  const luaL_Reg sys[] = {{"get_config_int", GetConfigInt}, {"exists", Exists}, {nullptr, nullptr}};
  const luaL_Reg render[] = {{"get_width", GetWidth}, {nullptr, nullptr}};
  const luaL_Reg bit[] = {{"tohex", ToHex}, {nullptr, nullptr}};
  const luaL_Reg window[] = {{"set_title", SetTitle}, {nullptr, nullptr}};
  Register(state, "sys", sys);
  Register(state, "render", render);
  Register(state, "bit", bit);
  Register(state, "window", window);

  scalar::ScriptAdapter adapter;
  if (!adapter.initialize(state, {GetInstance, SetInstance})) Fail(adapter.lastError());
  lua_pushnumber(state, 42);
  if (!adapter.captureInstance(-1)) Fail(adapter.lastError());
  lua_pop(state, 1);
  const int baseTop = lua_gettop(state);
  defold_hermes::installScriptBridgeApi(adapter.api());

  TestHost host;
  defold_hermes::Runtime runtime(host);
  runtime.load(source.str(), "defold-hermes://script-api-e2e.js");
  runtime.init();

  if (host.transcript.size() != 7) Fail("unexpected TypeScript transcript size");
  if (host.transcript[0] != "info:values:42:128:00ff:true") Fail("scalar values did not cross the full bridge");
  if (host.transcript[1] != "info:vmath:3:5:0.600000:0.800000:1.000000:4") Fail("Defold values did not cross the full Hermes bridge");
  if (host.transcript[2] != "info:vmath-nan-rejected:true") Fail("NaN Defold value input was not rejected through Hermes");
  if (host.transcript[3] != "info:hash:bigint:true") Fail("hash POD handle did not cross the full Hermes bridge");
  if (host.transcript[4].find("not executable yet") == std::string::npos &&
      host.transcript[4].find("not in the executable scalar family") == std::string::npos &&
      host.transcript[4].find("handles, tables, and callbacks are not executable yet") == std::string::npos &&
      host.transcript[4].find("no generated kind tag") == std::string::npos) {
    Fail("unsupported family was not explicit");
  }
  if (host.transcript[5].find("forced config error") == std::string::npos) Fail("Lua error was not propagated");
  if (host.transcript[6] != "info:after-error:36") Fail("dispatch did not recover after Lua error");
  if (gCurrentInstance != 7) Fail("Defold script instance was not restored");
  if (lua_gettop(state) != baseTop) Fail("Lua stack was not restored");
  if (gObservedCalls != 7) Fail("unexpected number of Lua calls");
  if (gTitle != "deherm") Fail("void scalar call did not execute");

  runtime.finalize();
  defold_hermes::uninstallScriptBridgeApi();
  adapter.shutdown();
  lua_close(state);
  std::printf("script-api-hermes-e2e:ok\n");
  return 0;
}
