#include <defold_hermes/generated_lua_bridge.hpp>
#include <defold_hermes/lua_capi.hpp>
#include <defold_hermes/runtime.hpp>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace bridge = defold_hermes::lua_bridge;
namespace generated = defold_hermes::lua_bridge::generated;

namespace {

constexpr uint32_t kTimerCapacity = 64;
int gTimerCallbacks[kTimerCapacity];
bool gTimerRepeating[kTimerCapacity];
uint32_t gNextTimer = 1;
bridge::LuaBridge* gBridge = nullptr;
defold_hermes::Runtime* gRuntime = nullptr;

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "lua-hermes-e2e:error:%s\n", message);
  std::exit(1);
}

int TimerDelay(lua_State* state) {
  luaL_checknumber(state, 1);
  luaL_checktype(state, 2, LUA_TBOOLEAN);
  luaL_checktype(state, 3, LUA_TFUNCTION);
  if (gNextTimer >= kTimerCapacity) return luaL_error(state, "timer capacity exhausted");
  const uint32_t timer = gNextTimer++;
  lua_pushvalue(state, 3);
  gTimerCallbacks[timer] = luaL_ref(state, LUA_REGISTRYINDEX);
  gTimerRepeating[timer] = lua_toboolean(state, 2) != 0;
  lua_pushnumber(state, timer);
  return 1;
}

int TimerCancel(lua_State* state) {
  const uint32_t timer = static_cast<uint32_t>(luaL_checknumber(state, 1));
  const bool active = timer < kTimerCapacity && gTimerCallbacks[timer] != LUA_NOREF;
  if (active) {
    luaL_unref(state, LUA_REGISTRYINDEX, gTimerCallbacks[timer]);
    gTimerCallbacks[timer] = LUA_NOREF;
  }
  lua_pushboolean(state, active ? 1 : 0);
  return 1;
}

int TimerTrigger(lua_State* state) {
  const uint32_t timer = static_cast<uint32_t>(luaL_checknumber(state, 1));
  if (timer >= kTimerCapacity || gTimerCallbacks[timer] == LUA_NOREF) {
    lua_pushboolean(state, 0);
    return 1;
  }
  lua_rawgeti(state, LUA_REGISTRYINDEX, gTimerCallbacks[timer]);
  lua_pushnil(state);
  lua_pushnumber(state, timer);
  lua_pushnumber(state, 0.25);
  if (lua_pcall(state, 3, 0, 0) != 0) return lua_error(state);
  if (!gTimerRepeating[timer]) {
    luaL_unref(state, LUA_REGISTRYINDEX, gTimerCallbacks[timer]);
    gTimerCallbacks[timer] = LUA_NOREF;
  }
  lua_pushboolean(state, 1);
  return 1;
}

uint32_t BridgeDelay(double delay, bool repeating, bridge::Handle callback) {
  uint32_t timer = UINT32_MAX;
  return generated::timerDelay(*gBridge, delay, repeating, callback, &timer)
      ? timer
      : UINT32_MAX;
}

bool BridgeCancel(uint32_t timer, bool* out) {
  return generated::timerCancel(*gBridge, timer, out);
}

bool BridgeTrigger(uint32_t timer, bool* out) {
  return generated::timerTrigger(*gBridge, timer, out);
}

bool InvokeCallback(void*, bridge::Handle callback, uint32_t timer, double elapsed) {
  return gRuntime->invokeCallback(callback, timer, elapsed);
}

void ReleaseCallback(void*, bridge::Handle callback) {
  if (!gRuntime->releaseCallback(callback)) Fail("callback release failed");
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

int main() {
  for (auto& reference : gTimerCallbacks) reference = LUA_NOREF;
  lua_State* state = luaL_newstate();
  if (!state) Fail("unable to create Lua state");
  luaL_openlibs(state);
  const luaL_Reg timerFunctions[] = {
    {"delay", TimerDelay},
    {"cancel", TimerCancel},
    {"trigger", TimerTrigger},
    {nullptr, nullptr}
  };
  luaL_register(state, "timer", timerFunctions);
  lua_pop(state, 1);

  bridge::LuaBridge luaBridge(64 * 1024, 128, 128);
  if (!generated::initialize(luaBridge, state, bridge::LuaBridge::rawRegistryApi())) {
    Fail(luaBridge.lastError());
  }

  TestHost host;
  defold_hermes::Runtime runtime(host);
  gBridge = &luaBridge;
  gRuntime = &runtime;
  luaBridge.installCallbackApi({nullptr, InvokeCallback, ReleaseCallback});
  defold_hermes::installLuaTimerCapi(BridgeDelay, BridgeCancel, BridgeTrigger);

  const char* source = R"JS(
    globalThis.__defoldAppV1 = {
      init: function() {
        var timer = globalThis.__defoldModulesV1.Timer;
        var handle = timer.delay(0.1, false, function(timerHandle, elapsed) {
          globalThis.__defoldHostV1.log('info', 'callback:' + timerHandle + ':' + elapsed.toFixed(2));
        });
        if (!timer.trigger(handle)) throw new Error('timer.trigger failed');
      },
      final: function() {
        globalThis.__defoldHostV1.log('info', 'final');
      }
    };
  )JS";

  runtime.load(source, "defold-hermes://lua-e2e.js");
  runtime.init();
  if (host.transcript.size() != 1 || host.transcript[0] != "info:callback:1:0.25") {
    Fail("Hermes callback transcript is wrong");
  }
  if (runtime.liveCallbacks() != 0) Fail("one-shot Hermes callback leaked");
  if (luaBridge.timerCallbacks().stats().size != 0) Fail("one-shot timer association leaked");
  runtime.finalize();
  if (host.transcript.size() != 2 || host.transcript[1] != "info:final") {
    Fail("Hermes final transcript is wrong");
  }

  defold_hermes::Runtime failingRuntime(host);
  failingRuntime.load(R"JS(
    globalThis.__defoldAppV1 = {
      final: function() {
        globalThis.__defoldHostV1.log('info', 'failing-final');
        throw new Error('expected final failure');
      }
    };
  )JS", "defold-hermes://failing-final.js");
  try {
    failingRuntime.finalize();
    Fail("failing final hook did not throw");
  } catch (const std::exception&) {
  }
  try {
    failingRuntime.finalize();
    Fail("failed finalization retained the application root");
  } catch (const std::exception&) {
  }
  if (host.transcript.size() != 3 || host.transcript[2] != "info:failing-final") {
    Fail("failed finalization invoked the application hook more than once");
  }

  luaBridge.shutdown();
  defold_hermes::uninstallLuaTimerCapi();
  gRuntime = nullptr;
  gBridge = nullptr;
  lua_close(state);
  std::printf("lua-hermes-e2e:ok\n");
  return 0;
}
