#include <defold_hermes/component_hermes_backend.hpp>
#include <defold_hermes/component_proxy_lua_gate.hpp>
#include <defold_hermes/active_game_object_context.hpp>
#include <defold_hermes/runtime.hpp>

#include <dmsdk/dlib/hash.h>

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
namespace dmScript { void PushHash(lua_State*, dmhash_t); }
namespace {

int gCurrentInstance = LUA_NOREF;
defold_hermes::Runtime* gRuntime = nullptr;

struct TestGameObject {
  uint32_t generation = 7;
  uint64_t identifier = 0x1234u;
  float position[3]{};
};

TestGameObject gGameObject;
int gCollection = 0;

bool IsGameObjectAttachmentLive(
    void* owner,
    uint32_t slot,
    uint32_t generation) noexcept {
  return owner == &gGameObject && slot == 0 && generation == gGameObject.generation;
}

bool BuildCurrentGameObject(
    void*,
    void* luaState,
    defold_hermes::game_object::ActiveContext* out) noexcept {
  if (!luaState || !out) return false;
  *out = {
    &gGameObject,
    &gCollection,
    gGameObject.identifier,
    gGameObject.generation,
    {&gGameObject, 0, gGameObject.generation, IsGameObjectAttachmentLive}
  };
  return true;
}

uint32_t GameObjectGeneration(void*, void* instance) noexcept {
  return static_cast<TestGameObject*>(instance)->generation;
}

void* GameObjectCollection(void*, void*) noexcept { return &gCollection; }

uint64_t GameObjectIdentifier(void*, void* instance) noexcept {
  return static_cast<TestGameObject*>(instance)->identifier;
}

void GameObjectPosition(void*, void* instance, float* xyz) noexcept {
  auto* object = static_cast<TestGameObject*>(instance);
  for (size_t lane = 0; lane < 3; ++lane) xyz[lane] = object->position[lane];
}

void SetGameObjectPosition(void*, void* instance, const float* xyz) noexcept {
  auto* object = static_cast<TestGameObject*>(instance);
  for (size_t lane = 0; lane < 3; ++lane) object->position[lane] = xyz[lane];
}

void SetGameObjectRotation(void*, void*, const float*) noexcept {}

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

  if (!defold_hermes::game_object::installTerminalApi({
          nullptr,
          GameObjectGeneration,
          GameObjectCollection,
          GameObjectIdentifier,
          GameObjectPosition,
          SetGameObjectPosition,
          SetGameObjectRotation
      }) ||
      !defold_hermes::game_object::installCurrentInstanceApi({nullptr, BuildCurrentGameObject})) {
    Fail("unable to install the test game-object context provider");
  }

  TestHost host;
  defold_hermes::Runtime runtime(host);
  if (!runtime.inspectorAvailable() && !runtime.sampleComponentSnapshot().empty())
    Fail("non-debug runtime exposed private component telemetry");
  gRuntime = &runtime;
  runtime.load(componentSource, "deherm://compiler-generated-components.js");
  runtime.init();
  if (runtime.bundleFingerprint().size() != 64)
    Fail("compiler bundle fingerprint was not observable through the runtime");
  // Hermes derives peakAllocatedBytes from cumulative collection statistics
  // (GCBase::cumStats_.usedBefore.max()), so it is legitimately zero until the
  // first collection runs and must never be compared against live bytes.
  const auto initialTelemetry = runtime.telemetry();
  if (!initialTelemetry.heapAvailable || initialTelemetry.heapAllocatedBytes == 0 ||
      initialTelemetry.heapSizeBytes < initialTelemetry.heapAllocatedBytes ||
      initialTelemetry.callbackRoots != 0 || initialTelemetry.componentInstances != 0) {
    std::fprintf(stderr,
        "component-runtime-hermes-e2e:telemetry:available=%d allocated=%llu size=%llu peak=%llu "
        "callbackRoots=%u componentInstances=%u\n",
        initialTelemetry.heapAvailable ? 1 : 0,
        static_cast<unsigned long long>(initialTelemetry.heapAllocatedBytes),
        static_cast<unsigned long long>(initialTelemetry.heapSizeBytes),
        static_cast<unsigned long long>(initialTelemetry.peakAllocatedBytes),
        initialTelemetry.callbackRoots, initialTelemetry.componentInstances);
    Fail("initial Hermes telemetry snapshot is inconsistent");
  }

  component::HermesBackend backend(nullptr, CurrentRuntime);
  component::LuaRuntime luaRuntime(backend.api(), {GetInstance, SetInstance});
  luaRuntime.registerLuaApi(state);
  dmScript::PushHash(state, 0x1234u);
  lua_setglobal(state, "complexActionId");
  const int baseTop = lua_gettop(state);

  const std::string attachAll = std::string(R"LUA(
    local function attach(id, schema, context, speed)
      local self = { speed = speed }
      local properties = context == "game-object" and {{"speed", 1}} or {}
      assert(_deherm_.attachComponent(self, id, schema, context, properties))
      _deherm_.dispatchLifecycle(self, id, "init")
      _deherm_.dispatchLifecycle(self, id, "update", 0.25)
      _deherm_.dispatchMessage(self, id, "hit", {damage = 7}, "sender")
      _deherm_.dispatchInput(self, id, "fire", {pressed = true})
      if context == "game-object" then
        assert(_deherm_.dispatchInput(self, id, complexActionId, {
          pressed = true,
          f01 = 1, f02 = 2, f03 = 3, f04 = 4, f05 = 5,
          f06 = 6, f07 = 7, f08 = 8, f09 = 9, f10 = 10,
          f11 = 11, f12 = 12, f13 = 13, f14 = 14, f15 = 15,
          f16 = 16, f17 = 17, f18 = 18, f19 = 19, f20 = 20,
          nested = { label = "deep" },
          samples = { 3, 5, 8 }
        }))
      end
      _deherm_.dispatchReload(self, id)
      _deherm_.dispatchLifecycle(self, id, "final")
      assert(_deherm_.detachComponent(self, id))
      assert(_deherm_.detachComponent(self, id))
    end
    attach()LUA") + LuaString(argv[2]) + "," + LuaString(argv[3]) + R"LUA(,"game-object",120)
    attach()LUA" + LuaString(argv[4]) + "," + LuaString(argv[5]) + R"LUA(,"gui-scene",0)
    attach()LUA" + LuaString(argv[6]) + "," + LuaString(argv[7]) + R"LUA(,"render-instance+graphics",0)
  )LUA";
  Run(state, attachAll);

  Run(state, std::string("rebindSelf={speed=42}; assert(_deherm_.attachComponent(rebindSelf,") +
      LuaString(argv[2]) + "," + LuaString(argv[3]) +
      ",\"game-object\",{{\"speed\",1}})); _deherm_.dispatchLifecycle(rebindSelf," +
      LuaString(argv[2]) + ",\"init\")");
  const auto attachedTelemetry = runtime.telemetry();
  if (attachedTelemetry.componentInstances != 1 ||
      attachedTelemetry.heapAllocatedBytes < initialTelemetry.heapAllocatedBytes)
    Fail("attached component was not reflected in runtime telemetry");
  runtime.finalize();
  if (runtime.liveComponents() != 0 || luaRuntime.live() != 1)
    Fail("old Runtime finalization did not preserve only the Lua attachment");

  defold_hermes::Runtime replacement(host);
  replacement.load(componentSource, "deherm://compiler-generated-components-replacement.js");
  gRuntime = &replacement;
  Run(state, std::string("_deherm_.dispatchReload(rebindSelf,") + LuaString(argv[2]) +
      "); _deherm_.dispatchLifecycle(rebindSelf," + LuaString(argv[2]) +
      ",\"update\",0.5); _deherm_.dispatchLifecycle(rebindSelf," + LuaString(argv[2]) +
      ",\"final\"); assert(_deherm_.detachComponent(rebindSelf," + LuaString(argv[2]) + "))");

  if (gCurrentInstance != LUA_NOREF && gCurrentInstance != LUA_REFNIL) Fail("nil current instance was not restored");
  if (lua_gettop(state) != baseTop) Fail("Lua stack was not restored");
  if (luaRuntime.live() != 0 || replacement.liveComponents() != 0) Fail("component roots leaked");
  if (luaRuntime.attachments() != 4 || luaRuntime.dispatches() != 24) Fail("component event census drifted");
  if (host.transcript.size() != 24) Fail("Hermes callback transcript census drifted");
  if (host.transcript.front() != "info:game:init:120") Fail("editor property did not materialize into Hermes self");
  if (host.transcript[4] != "info:game:complex:deep:5" || host.transcript[5] != "info:game:input:4660:true")
    Fail("bounded recursive component codec did not preserve wide nested input");
  if (host.transcript[6] != "info:game:reload:1") Fail("reload did not preserve Hermes instance state");
  if (host.transcript[17] != "info:render:reload:1") Fail("render context did not execute through Hermes");
  if (host.transcript[20] != "info:game:init:42" || host.transcript[21] != "info:game:reload:1" ||
      host.transcript[22] != "info:game:update:0.50")
    Fail("Runtime-generation rebind did not initialize replacement state and dispatch reload");

  replacement.finalize();
  luaRuntime.shutdown();
  defold_hermes::game_object::uninstallCurrentInstanceApi();
  defold_hermes::game_object::uninstallTerminalApi();
  gRuntime = nullptr;
  lua_close(state);
  std::puts("component-runtime-hermes-e2e:compiler-registry-component-only-bootstrap:ok");
  std::puts("component-runtime-hermes-e2e:contexts:3:ok");
  std::puts("component-runtime-hermes-e2e:properties-lifecycle-message-input-reload-detach:ok");
  std::puts("component-runtime-hermes-e2e:bounded-recursive-event-codec:ok");
  std::puts("component-runtime-hermes-e2e:runtime-generation-rebind:ok");
  std::puts("component-runtime-hermes-e2e:fingerprint-and-heap-telemetry:ok");
  std::puts("component-runtime-hermes-e2e:packaged-defold-engine:unverified");
  return 0;
}
