#include <defold_hermes/component_hermes_backend.hpp>
#include <defold_hermes/component_proxy_lua_gate.hpp>
#include <defold_hermes/runtime.hpp>

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

namespace component = defold_hermes::component_proxy;
namespace {

int gCurrentInstance = LUA_NOREF;
defold_hermes::Runtime* gRuntime = nullptr;

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "component-runtime-hermes-e2e:error:%s\n", message);
  std::exit(1);
}

void GetInstance(lua_State* state) {
  if (gCurrentInstance == LUA_NOREF || gCurrentInstance == LUA_REFNIL) lua_pushnil(state);
  else lua_rawgeti(state, LUA_REGISTRYINDEX, gCurrentInstance);
}

void SetInstance(lua_State* state) {
  int replacement = LUA_NOREF;
  if (!lua_isnil(state, -1)) replacement = luaL_ref(state, LUA_REGISTRYINDEX);
  else lua_pop(state, 1);
  if (gCurrentInstance != LUA_NOREF && gCurrentInstance != LUA_REFNIL)
    luaL_unref(state, LUA_REGISTRYINDEX, gCurrentInstance);
  gCurrentInstance = replacement;
}

defold_hermes::Runtime* CurrentRuntime(void*) noexcept { return gRuntime; }

class TestHost final : public defold_hermes::Host {
 public:
  void log(const std::string& level, const std::string& message) override {
    transcript.push_back(level + ":" + message);
  }
  double now() override { return 1.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
  std::vector<std::string> transcript;
};

std::string Read(const char* path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) Fail("unable to open compiler-generated component bundle");
  std::ostringstream output;
  output << stream.rdbuf();
  return output.str();
}

void Run(lua_State* state, const std::string& source) {
  if (luaL_loadbuffer(state, source.data(), source.size(), "component-runtime-e2e.lua") != 0 ||
      lua_pcall(state, 0, 0, 0) != 0) {
    const char* message = lua_tostring(state, -1);
    Fail(message ? message : "Lua chunk failed without an error string");
  }
}

std::string LuaString(const char* value) {
  std::string output = "\"";
  for (const char* cursor = value; *cursor; ++cursor) {
    if (*cursor == '\\' || *cursor == '\"') output.push_back('\\');
    output.push_back(*cursor);
  }
  output.push_back('\"');
  return output;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 8) Fail("expected bundle plus game/gui/render component IDs and schema fingerprints");
  const std::string componentSource = Read(argv[1]);
  lua_State* state = luaL_newstate();
  if (!state) Fail("unable to create Lua state");
  luaL_openlibs(state);

  TestHost host;
  defold_hermes::Runtime runtime(host);
  gRuntime = &runtime;
  runtime.load(componentSource, "deherm://compiler-generated-components.js");
  runtime.init();

  component::HermesBackend backend(nullptr, CurrentRuntime);
  component::LuaRuntime luaRuntime(backend.api(), {GetInstance, SetInstance});
  luaRuntime.registerLuaApi(state);
  const int baseTop = lua_gettop(state);

  const std::string attachAll = std::string(R"LUA(
    local function attach(id, schema, context, speed)
      local self = { speed = speed }
      local properties = context == "game-object" and {{"speed", 1}} or {}
      assert(defold_hermes.attachComponent(self, id, schema, context, properties))
      defold_hermes.dispatchLifecycle(self, id, "init")
      defold_hermes.dispatchLifecycle(self, id, "update", 0.25)
      defold_hermes.dispatchMessage(self, id, "hit", {damage = 7}, "sender")
      defold_hermes.dispatchInput(self, id, "fire", {pressed = true})
      defold_hermes.dispatchReload(self, id)
      defold_hermes.dispatchLifecycle(self, id, "final")
      assert(defold_hermes.detachComponent(self, id))
      assert(defold_hermes.detachComponent(self, id))
    end
    attach()LUA") + LuaString(argv[2]) + "," + LuaString(argv[3]) + R"LUA(,"game-object",120)
    attach()LUA" + LuaString(argv[4]) + "," + LuaString(argv[5]) + R"LUA(,"gui-scene",0)
    attach()LUA" + LuaString(argv[6]) + "," + LuaString(argv[7]) + R"LUA(,"render-instance+graphics",0)
  )LUA";
  Run(state, attachAll);

  Run(state, std::string("rebindSelf={speed=42}; assert(defold_hermes.attachComponent(rebindSelf,") +
      LuaString(argv[2]) + "," + LuaString(argv[3]) +
      ",\"game-object\",{{\"speed\",1}})); defold_hermes.dispatchLifecycle(rebindSelf," +
      LuaString(argv[2]) + ",\"init\")");
  runtime.finalize();
  if (runtime.liveComponents() != 0 || luaRuntime.live() != 1)
    Fail("old Runtime finalization did not preserve only the Lua attachment");

  defold_hermes::Runtime replacement(host);
  replacement.load(componentSource, "deherm://compiler-generated-components-replacement.js");
  gRuntime = &replacement;
  Run(state, std::string("defold_hermes.dispatchReload(rebindSelf,") + LuaString(argv[2]) +
      "); defold_hermes.dispatchLifecycle(rebindSelf," + LuaString(argv[2]) +
      ",\"update\",0.5); defold_hermes.dispatchLifecycle(rebindSelf," + LuaString(argv[2]) +
      ",\"final\"); assert(defold_hermes.detachComponent(rebindSelf," + LuaString(argv[2]) + "))");

  if (gCurrentInstance != LUA_NOREF && gCurrentInstance != LUA_REFNIL) Fail("nil current instance was not restored");
  if (lua_gettop(state) != baseTop) Fail("Lua stack was not restored");
  if (luaRuntime.live() != 0 || replacement.liveComponents() != 0) Fail("component roots leaked");
  if (luaRuntime.attachments() != 4 || luaRuntime.dispatches() != 22) Fail("component event census drifted");
  if (host.transcript.size() != 21) Fail("Hermes callback transcript census drifted");
  if (host.transcript.front() != "info:game:init:120") Fail("editor property did not materialize into Hermes self");
  if (host.transcript[4] != "info:game:reload:1") Fail("reload did not preserve Hermes instance state");
  if (host.transcript[15] != "info:render:reload:1") Fail("render context did not execute through Hermes");
  if (host.transcript[18] != "info:game:reload:1" || host.transcript[19] != "info:game:update:0.50")
    Fail("Runtime-generation rebind did not restore properties and dispatch reload");

  replacement.finalize();
  luaRuntime.shutdown();
  gRuntime = nullptr;
  lua_close(state);
  std::puts("component-runtime-hermes-e2e:compiler-registry-component-only-bootstrap:ok");
  std::puts("component-runtime-hermes-e2e:contexts:3:ok");
  std::puts("component-runtime-hermes-e2e:properties-lifecycle-message-input-reload-detach:ok");
  std::puts("component-runtime-hermes-e2e:runtime-generation-rebind:ok");
  std::puts("component-runtime-hermes-e2e:packaged-defold-engine:unverified");
  return 0;
}
