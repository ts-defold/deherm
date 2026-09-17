#define EXTENSION_NAME DefoldHermesExt
#define LIB_NAME "defold_hermes"
#define DLIB_LOG_DOMAIN LIB_NAME

#include <dmsdk/dlib/configfile_gen.hpp>
#include <dmsdk/dlib/log.h>
#include <dmsdk/dlib/time.h>
#include <dmsdk/extension/extension.hpp>
#include <dmsdk/resource/resource.hpp>
#include <dmsdk/script/script.h>

#include <defold_hermes/generated_lua_bridge.hpp>
#include <defold_hermes/lua_capi.hpp>

#include <cstdlib>
#include <memory>
#include <string>

#if !defined(DM_PLATFORM_HTML5)
#include <defold_hermes/runtime.hpp>
#endif

namespace {

const char* kDefaultAppPath = "/defold_hermes_app/app.js";
uint64_t gPreviousFrameTime = 0;
bool gApplicationInitialized = false;
std::unique_ptr<defold_hermes::lua_bridge::LuaBridge> gLuaBridge;

#if defined(DM_PLATFORM_HTML5)

extern "C" void defoldHermesWebLoad(const char* source, uint32_t sourceSize);
extern "C" void defoldHermesWebInit();
extern "C" void defoldHermesWebUpdate(double dt);
extern "C" void defoldHermesWebFinalize();
extern "C" int defoldHermesWebInvokeCallback(
    uint32_t runtime,
    uint32_t slot,
    uint32_t generation,
    uint32_t type,
    uint32_t timer,
    double elapsed);
extern "C" void defoldHermesWebReleaseCallback(
    uint32_t runtime,
    uint32_t slot,
    uint32_t generation,
    uint32_t type);

#else

class DefoldHost final : public defold_hermes::Host {
 public:
  void log(const std::string& level, const std::string& message) override {
    if (level == "error") {
      dmLogError("%s", message.c_str());
    } else if (level == "warn") {
      dmLogWarning("%s", message.c_str());
    } else if (level == "debug") {
      dmLogDebug("%s", message.c_str());
    } else {
      dmLogInfo("%s", message.c_str());
    }
  }

  double now() override {
    return static_cast<double>(dmTime::GetMonotonicTime()) / 1000.0;
  }

  std::string request(
      const std::string& channel,
      const std::string& payload) override {
    return "hermes:" + channel + ':' + payload;
  }
};

DefoldHost gHost;
std::unique_ptr<defold_hermes::Runtime> gRuntime;

#endif

int DefoldRegistryRef(lua_State* state) {
  return dmScript::Ref(state, LUA_REGISTRYINDEX);
}

void DefoldRegistryUnref(lua_State* state, int reference) {
  dmScript::Unref(state, LUA_REGISTRYINDEX, reference);
}

int DefoldProtectedCall(lua_State* state, int argumentCount, int resultCount) {
  // Use raw pcall here so the bridge can preserve the error string for the JS
  // exception adapter. A cached traceback handler will be added with callbacks.
  return lua_pcall(state, argumentCount, resultCount, 0);
}

bool InvokeTypeScriptCallback(
    void*,
    defold_hermes::lua_bridge::Handle callback,
    uint32_t timer,
    double elapsed) {
#if defined(DM_PLATFORM_HTML5)
  return defoldHermesWebInvokeCallback(
      callback.runtime, callback.slot, callback.generation, callback.type,
      timer, elapsed) != 0;
#else
  if (!gRuntime || !gRuntime->invokeCallback(callback, timer, elapsed)) {
    dmLogError("Hermes callback failed: %s", gRuntime ? gRuntime->callbackError() : "runtime unavailable");
    return false;
  }
  return true;
#endif
}

void ReleaseTypeScriptCallback(void*, defold_hermes::lua_bridge::Handle callback) {
#if defined(DM_PLATFORM_HTML5)
  defoldHermesWebReleaseCallback(
      callback.runtime, callback.slot, callback.generation, callback.type);
#else
  if (gRuntime) gRuntime->releaseCallback(callback);
#endif
}

uint32_t LuaTimerDelay(
    double delay,
    bool repeating,
    defold_hermes::lua_bridge::Handle callback) {
  uint32_t timer = UINT32_MAX;
  if (!gLuaBridge ||
      !defold_hermes::lua_bridge::generated::timerDelay(
          *gLuaBridge, delay, repeating, callback, &timer)) {
    if (gLuaBridge && timer != UINT32_MAX) {
      bool ignored = false;
      defold_hermes::lua_bridge::generated::timerCancel(*gLuaBridge, timer, &ignored);
    }
    dmLogError("timer.delay bridge failed: %s", gLuaBridge ? gLuaBridge->lastError() : "bridge unavailable");
    return UINT32_MAX;
  }
  return timer;
}

bool LuaTimerCancel(uint32_t handle, bool* out) {
  if (!gLuaBridge ||
      !defold_hermes::lua_bridge::generated::timerCancel(*gLuaBridge, handle, out)) {
    dmLogError("timer.cancel bridge failed: %s", gLuaBridge ? gLuaBridge->lastError() : "bridge unavailable");
    return false;
  }
  return true;
}

bool LuaTimerTrigger(uint32_t handle, bool* out) {
  if (!gLuaBridge ||
      !defold_hermes::lua_bridge::generated::timerTrigger(*gLuaBridge, handle, out)) {
    dmLogError("timer.trigger bridge failed: %s", gLuaBridge ? gLuaBridge->lastError() : "bridge unavailable");
    return false;
  }
  return true;
}

bool StartApplication() {
  if (gApplicationInitialized) return true;
#if defined(DM_PLATFORM_HTML5)
  defoldHermesWebInit();
#else
  try {
    if (!gRuntime) return false;
    gRuntime->init();
  } catch (const std::exception& error) {
    dmLogError("TypeScript application initialization failed: %s", error.what());
    return false;
  }
#endif
  gApplicationInitialized = true;
  return true;
}

int AttachLuaInstance(lua_State* state) {
  luaL_checkany(state, 1);
  if (!gLuaBridge || !gLuaBridge->captureInstance(1)) {
    return luaL_error(
        state, "Unable to capture Defold instance: %s",
        gLuaBridge ? gLuaBridge->lastError() : "bridge unavailable");
  }
  if (!StartApplication()) return luaL_error(state, "Unable to initialize TypeScript application");
  lua_pushboolean(state, 1);
  return 1;
}

void RegisterLuaBootstrap(lua_State* state) {
  const luaL_Reg functions[] = {
    {"attach", AttachLuaInstance},
    {nullptr, nullptr}
  };
  luaL_register(state, "defold_hermes", functions);
  lua_pop(state, 1);
}

dmExtension::Result InitializeExtension(dmExtension::Params* params) {
  const char* appPath = dmConfigFile::GetString(
      params->m_ConfigFile, "defold_hermes.app", kDefaultAppPath);

  void* bytes = nullptr;
  uint32_t size = 0;
  const auto result = dmResource::GetRaw(
      params->m_ResourceFactory, appPath, &bytes, &size);
  if (result != dmResource::RESULT_OK) {
    dmLogError("Unable to load TypeScript bundle '%s' (resource error %d)", appPath, result);
    return dmExtension::RESULT_INIT_ERROR;
  }

  gLuaBridge = std::make_unique<defold_hermes::lua_bridge::LuaBridge>(64 * 1024, 4096);
  const defold_hermes::lua_bridge::RegistryApi registryApi = {
    DefoldRegistryRef,
    DefoldRegistryUnref,
    DefoldProtectedCall
  };
  const defold_hermes::lua_bridge::InstanceApi instanceApi = {
    dmScript::GetInstance,
    dmScript::SetInstance
  };
  if (!defold_hermes::lua_bridge::generated::initialize(
          *gLuaBridge, params->m_L, registryApi, instanceApi)) {
    free(bytes);
    dmLogError("Unable to initialize Lua compatibility bridge: %s", gLuaBridge->lastError());
    gLuaBridge.reset();
    return dmExtension::RESULT_INIT_ERROR;
  }
  gLuaBridge->installCallbackApi({nullptr, InvokeTypeScriptCallback, ReleaseTypeScriptCallback});
  RegisterLuaBootstrap(params->m_L);
  defold_hermes::installLuaTimerCapi(LuaTimerDelay, LuaTimerCancel, LuaTimerTrigger);

#if defined(DM_PLATFORM_HTML5)
  defoldHermesWebLoad(static_cast<const char*>(bytes), size);
#else
  try {
    gRuntime = std::make_unique<defold_hermes::Runtime>(gHost);
    gRuntime->load(
        std::string(static_cast<const char*>(bytes), size),
        std::string("defold-hermes://") + appPath);
  } catch (const std::exception& error) {
    free(bytes);
    dmLogError("TypeScript application initialization failed: %s", error.what());
    defold_hermes::uninstallLuaTimerCapi();
    if (gLuaBridge) gLuaBridge->shutdown();
    gLuaBridge.reset();
    gRuntime.reset();
    return dmExtension::RESULT_INIT_ERROR;
  }
#endif

  free(bytes);
  gPreviousFrameTime = dmTime::GetMonotonicTime();
  dmLogInfo("Loaded TypeScript application '%s'; waiting for script instance attachment", appPath);
  return dmExtension::RESULT_OK;
}

dmExtension::Result UpdateExtension(dmExtension::Params*) {
  const uint64_t now = dmTime::GetMonotonicTime();
  const double dt = static_cast<double>(now - gPreviousFrameTime) / 1000000.0;
  gPreviousFrameTime = now;
#if defined(DM_PLATFORM_HTML5)
  if (gApplicationInitialized) defoldHermesWebUpdate(dt);
#else
  try {
    if (gRuntime && gApplicationInitialized) gRuntime->update(dt);
  } catch (const std::exception& error) {
    dmLogError("TypeScript update failed: %s", error.what());
    return dmExtension::RESULT_INIT_ERROR;
  }
#endif
  return dmExtension::RESULT_OK;
}

dmExtension::Result FinalizeExtension(dmExtension::Params*) {
#if defined(DM_PLATFORM_HTML5)
  if (gApplicationInitialized) defoldHermesWebFinalize();
#else
  try {
    if (gRuntime && gApplicationInitialized) gRuntime->finalize();
  } catch (const std::exception& error) {
    dmLogError("TypeScript finalization failed: %s", error.what());
  }
#endif
  gApplicationInitialized = false;
  defold_hermes::uninstallLuaTimerCapi();
  if (gLuaBridge) gLuaBridge->shutdown();
  gLuaBridge.reset();
#if !defined(DM_PLATFORM_HTML5)
  gRuntime.reset();
#endif
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppInitializeExtension(dmExtension::AppParams*) {
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppFinalizeExtension(dmExtension::AppParams*) {
  return dmExtension::RESULT_OK;
}

}  // namespace

DM_DECLARE_EXTENSION(
    EXTENSION_NAME,
    LIB_NAME,
    AppInitializeExtension,
    AppFinalizeExtension,
    InitializeExtension,
    UpdateExtension,
    0,
    FinalizeExtension)
