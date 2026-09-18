#define LIB_NAME "defold_hermes"
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN LIB_NAME
#endif

#include <dmsdk/dlib/configfile_gen.hpp>
#include <dmsdk/dlib/log.h>
#include <dmsdk/dlib/time.h>
#include <dmsdk/extension/extension.hpp>
#include <dmsdk/gameobject/gameobject.h>
#include <dmsdk/gamesys/script.h>
#include <dmsdk/resource/resource.hpp>
#include <dmsdk/script/script.h>

#include <defold_hermes/active_game_object_context.hpp>
#include <defold_hermes/component_proxy_lua_gate.hpp>
#include <defold_hermes/generated_lua_bridge.hpp>
#include <defold_hermes/bundle_resource.hpp>
#include <defold_hermes/lua_capi.hpp>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>

#if !defined(DM_PLATFORM_HTML5)
#include <defold_hermes/component_hermes_backend.hpp>
#include <defold_hermes/runtime.hpp>
#endif

extern "C" void DehermBundleResource();

namespace {

const char* kDefaultAppPath = "/deherm/app.dehermc";
uint64_t gBundleGeneration = 0;
uint64_t gRejectedBundleGeneration = 0;
uint64_t gPendingRejectedBundleGeneration = 0;
bool gApplicationInitialized = false;
bool gLoggedFirstExtensionUpdate = false;
uint64_t gTelemetryLastEmitMicros = 0;
uint64_t gTelemetryLastFrameMicros = 0;
dmResource::HFactory gResourceFactory = nullptr;
void* gBundleResource = nullptr;
std::string gBundlePath;
std::unique_ptr<defold_hermes::lua_bridge::LuaBridge> gLuaBridge;
std::unique_ptr<defold_hermes::lua_bridge::scalar::ScriptAdapter> gScriptBridge;
#if !defined(DM_PLATFORM_HTML5)
std::unique_ptr<defold_hermes::component_proxy::HermesBackend> gComponentHermesBackend;
#endif
std::unique_ptr<defold_hermes::component_proxy::LuaRuntime> gComponentLuaRuntime;

enum class ScriptBridgeState : uint8_t { kUninitialized, kProbing, kReady };
ScriptBridgeState gScriptBridgeState = ScriptBridgeState::kUninitialized;

void ScriptGetInstance(lua_State* state) {
  dmScript::GetInstance(state);
}

void ScriptSetInstance(lua_State* state) {
  if (gScriptBridge && gScriptBridge->componentContextActive()) {
    lua_pop(state, 1);
    return;
  }
  dmScript::SetInstance(state);
}

struct BootstrapAttachment {
  dmGameObject::HCollection collection = nullptr;
  dmhash_t identifier = 0;
  uint32_t instanceGeneration = 0;
  uint32_t attachmentGeneration = 0;
  bool live = false;
};

BootstrapAttachment gBootstrapAttachment;

bool IsBootstrapAttachmentLive(
    void* owner,
    uint32_t slot,
    uint32_t generation) noexcept {
  const auto* attachment = static_cast<const BootstrapAttachment*>(owner);
  return slot == 0 && attachment && attachment->live &&
      attachment->attachmentGeneration == generation;
}

bool BuildBootstrapContext(defold_hermes::game_object::ActiveContext* out) {
  if (!out || !gBootstrapAttachment.live || !gBootstrapAttachment.collection) return false;
  dmGameObject::HInstance instance = dmGameObject::GetInstanceFromIdentifier(
      gBootstrapAttachment.collection, gBootstrapAttachment.identifier);
  if (!instance || dmGameObject::GetGeneration(instance) != gBootstrapAttachment.instanceGeneration) {
    return false;
  }
  out->instance = instance;
  out->collection = gBootstrapAttachment.collection;
  out->identifier = gBootstrapAttachment.identifier;
  out->instanceGeneration = gBootstrapAttachment.instanceGeneration;
  out->attachment = {
    &gBootstrapAttachment,
    0,
    gBootstrapAttachment.attachmentGeneration,
    IsBootstrapAttachmentLive
  };
  return true;
}

uint32_t TerminalGetGeneration(void*, void* instance) noexcept {
  return dmGameObject::GetGeneration(static_cast<dmGameObject::HInstance>(instance));
}

void* TerminalGetCollection(void*, void* instance) noexcept {
  return dmGameObject::GetCollection(static_cast<dmGameObject::HInstance>(instance));
}

uint64_t TerminalGetIdentifier(void*, void* instance) noexcept {
  return dmGameObject::GetIdentifier(static_cast<dmGameObject::HInstance>(instance));
}

void TerminalGetPosition(void*, void* instance, float* xyz) noexcept {
  const dmVMath::Point3 value = dmGameObject::GetPosition(
      static_cast<dmGameObject::HInstance>(instance));
  xyz[0] = value.getX();
  xyz[1] = value.getY();
  xyz[2] = value.getZ();
}

void TerminalSetPosition(void*, void* instance, const float* xyz) noexcept {
  dmGameObject::SetPosition(
      static_cast<dmGameObject::HInstance>(instance),
      dmVMath::Point3(xyz[0], xyz[1], xyz[2]));
}

void TerminalSetRotation(void*, void* instance, const float* xyzw) noexcept {
  dmGameObject::SetRotation(
      static_cast<dmGameObject::HInstance>(instance),
      dmVMath::Quat(xyzw[0], xyzw[1], xyzw[2], xyzw[3]));
}

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

#if !defined(DM_PLATFORM_HTML5)
defold_hermes::Runtime* CurrentComponentRuntime(void*) noexcept { return gRuntime.get(); }
#endif

void InvalidateBootstrapAttachment() noexcept {
  gBootstrapAttachment.live = false;
  ++gBootstrapAttachment.attachmentGeneration;
  if (gBootstrapAttachment.attachmentGeneration == 0) ++gBootstrapAttachment.attachmentGeneration;
  gBootstrapAttachment.collection = nullptr;
  gBootstrapAttachment.identifier = 0;
  gBootstrapAttachment.instanceGeneration = 0;
}

void DetachCapturedLuaInstances() noexcept {
  if (gScriptBridge) gScriptBridge->detachInstance();
  if (gLuaBridge) gLuaBridge->detachInstance();
}

void FinalizeAttachedApplication(const char* phase) noexcept {
  if (!gApplicationInitialized) return;
#if !defined(DM_PLATFORM_HTML5)
  try {
#endif
    defold_hermes::game_object::ActiveContext context;
    if (!BuildBootstrapContext(&context)) {
      dmLogWarning("Skipping TypeScript finalization during %s because its attachment is stale", phase);
    } else {
      defold_hermes::game_object::Scope scope(context);
      if (!scope.entered()) {
        dmLogWarning("Skipping TypeScript finalization during %s because the context stack is exhausted", phase);
      } else {
#if defined(DM_PLATFORM_HTML5)
        defoldHermesWebFinalize();
#else
        if (gRuntime) gRuntime->finalize();
#endif
      }
    }
#if !defined(DM_PLATFORM_HTML5)
  } catch (const std::exception& error) {
    dmLogError("TypeScript finalization during %s failed: %s", phase, error.what());
  }
#endif
  gApplicationInitialized = false;
}

bool ReadBundle(defold_hermes::bundle_resource::View* view) {
  return gBundleResource && defold_hermes::bundle_resource::view(gBundleResource, view);
}

bool ActivateBundle(bool initial) {
  defold_hermes::bundle_resource::View bundle{};
  if (!ReadBundle(&bundle)) {
    dmLogError("Unable to read typed TypeScript bundle resource '%s'", gBundlePath.c_str());
    return false;
  }
  if (!initial && (bundle.generation == gBundleGeneration ||
                   bundle.generation == gRejectedBundleGeneration)) {
    return true;
  }

#if defined(DM_PLATFORM_HTML5)
  if (!initial) {
    gRejectedBundleGeneration = bundle.generation;
    dmLogWarning(
        "Browser bundle generation %llu is staged but browser-host activation is not implemented",
        static_cast<unsigned long long>(bundle.generation));
    return false;
  }
  defoldHermesWebLoad(bundle.data, bundle.size);
#else
  std::unique_ptr<defold_hermes::Runtime> candidate;
  bool candidateRejected = false;
  std::string candidateDiagnostic;
  std::string candidateFingerprint;
  uint32_t candidateRuntimeId = 0;
  try {
    candidate = std::make_unique<defold_hermes::Runtime>(gHost);
    candidateRuntimeId = candidate->identity();
    candidate->load(
        std::string(bundle.data, bundle.size),
        std::string("deherm://") + gBundlePath);
    candidateFingerprint = candidate->bundleFingerprint();
    if (gApplicationInitialized) {
      defold_hermes::game_object::ActiveContext context;
      if (!BuildBootstrapContext(&context)) {
        throw std::runtime_error("Bootstrap game-object attachment is stale during reload");
      }
      defold_hermes::game_object::Scope scope(context);
      if (!scope.entered()) throw std::runtime_error("Game-object context stack is exhausted during reload");
      candidate->init();
    }
  } catch (const std::exception& error) {
    // A jsi::JSError retains values owned by its Hermes runtime. Keep the
    // candidate alive until the exception object has been destroyed at the end
    // of this catch block, then discard the candidate below.
    candidateRejected = true;
    candidateDiagnostic = error.what();
  }
  if (candidateRejected) {
    candidate.reset();
    gRejectedBundleGeneration = bundle.generation;
    if (!initial && gRuntime && gApplicationInitialized) {
      gPendingRejectedBundleGeneration = bundle.generation;
    }
    dmLogError(
        "TypeScript bundle generation %llu was rejected: %s",
        static_cast<unsigned long long>(bundle.generation),
        candidateDiagnostic.c_str());
    dmLogInfo(
        "DEHERM_EVENT bundle-rejected fingerprint=%s resource_generation=%llu runtime_id=%u initial=%s",
        candidateFingerprint.empty() ? "unavailable" : candidateFingerprint.c_str(),
        static_cast<unsigned long long>(bundle.generation),
        candidateRuntimeId,
        initial ? "true" : "false");
    return false;
  }

  if (gRuntime && gApplicationInitialized) {
    try {
      defold_hermes::game_object::ActiveContext context;
      if (!BuildBootstrapContext(&context)) {
        throw std::runtime_error("Bootstrap game-object attachment is stale during reload finalization");
      }
      defold_hermes::game_object::Scope scope(context);
      if (!scope.entered()) throw std::runtime_error("Game-object context stack is exhausted during reload finalization");
      gRuntime->finalize();
    } catch (const std::exception& error) {
      dmLogWarning("Previous TypeScript generation finalizer failed: %s", error.what());
    }
  }
  gRuntime = std::move(candidate);
#endif

  gBundleGeneration = bundle.generation;
  gRejectedBundleGeneration = 0;
  dmLogInfo(
      "%s TypeScript bundle generation %llu from '%s'",
      initial ? "Loaded" : "Activated",
      static_cast<unsigned long long>(bundle.generation),
      gBundlePath.c_str());
#if !defined(DM_PLATFORM_HTML5)
  const std::string activeFingerprint = gRuntime
      ? gRuntime->bundleFingerprint()
      : std::string();
  dmLogInfo(
      "DEHERM_EVENT bundle-activated fingerprint=%s resource_generation=%llu runtime_id=%u initial=%s",
      !activeFingerprint.empty()
          ? activeFingerprint.c_str()
          : "unavailable",
      static_cast<unsigned long long>(bundle.generation),
      gRuntime ? gRuntime->identity() : 0,
      initial ? "true" : "false");
#endif
  return true;
}

bool EnsureBundleLoaded() {
  if (gBundleResource) return true;
  if (!gResourceFactory || gBundlePath.empty()) return false;
  const auto result = dmResource::Get(
      gResourceFactory, gBundlePath.c_str(), &gBundleResource);
  if (result != dmResource::RESULT_OK) {
    dmLogError(
        "Unable to load typed TypeScript bundle '%s' (resource error %d)",
        gBundlePath.c_str(), result);
    gBundleResource = nullptr;
    return false;
  }
  if (ActivateBundle(true)) return true;
  dmResource::Release(gResourceFactory, gBundleResource);
  gBundleResource = nullptr;
  return false;
}

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

bool EnsureScriptBridgeReady(lua_State* state) {
  if (gScriptBridgeState == ScriptBridgeState::kReady) return gScriptBridge != nullptr;
  if (gScriptBridgeState == ScriptBridgeState::kProbing) {
    dmLogError("Generated Defold script bridge initialization is already in progress");
    return false;
  }
  gScriptBridgeState = ScriptBridgeState::kProbing;
  defold_hermes::script_handle_lowering::RuntimeProfileDetection detection{};
  char detectionError[256]{};
  const auto status = defold_hermes::script_handle_lowering::detectRuntimeProfile(
      state, &detection, detectionError, sizeof(detectionError));
  if (status != defold_hermes::script_handle_lowering::RuntimeProfileDetectionStatus::kMatched ||
      !detection.profile) {
    dmLogError("Unable to detect exact Defold runtime profile: %s", detectionError);
    gScriptBridgeState = ScriptBridgeState::kUninitialized;
    return false;
  }

#if !defined(DM_PLATFORM_HTML5)
  try {
#endif
  auto candidate = std::make_unique<defold_hermes::lua_bridge::scalar::ScriptAdapter>();
  const defold_hermes::lua_bridge::scalar::InstanceApi instanceApi = {
    ScriptGetInstance,
    ScriptSetInstance
  };
  if (!candidate->initialize(
          state, instanceApi,
          defold_hermes::script_handle_lowering::runtimeProfileHandshake(*detection.profile))) {
    dmLogError("Unable to initialize generated Defold script bridge: %s", candidate->lastError());
    candidate->shutdown();
    gScriptBridgeState = ScriptBridgeState::kUninitialized;
    return false;
  }
  defold_hermes::installScriptBridgeApi(candidate->api());
  gScriptBridge = std::move(candidate);
  gScriptBridgeState = ScriptBridgeState::kReady;
  dmLogInfo(
      "Detected Defold runtime profile '%s' from %u generated Lua symbols",
      detection.profile->id,
      static_cast<unsigned>(detection.observedPresent));
  return true;
#if !defined(DM_PLATFORM_HTML5)
  } catch (const std::exception& error) {
    dmLogError("Generated Defold script bridge allocation failed: %s", error.what());
    gScriptBridgeState = ScriptBridgeState::kUninitialized;
    return false;
  }
#endif
}

bool StartApplication() {
  if (gApplicationInitialized) return true;
  // Extension Initialize runs before Defold registers custom resource types.
  // Script init/attachment runs after the factory is ready, so typed bundle
  // acquisition and the first Hermes generation belong here.
  if (!EnsureBundleLoaded()) return false;
#if defined(DM_PLATFORM_HTML5)
  defold_hermes::game_object::ActiveContext context;
  if (!BuildBootstrapContext(&context)) return false;
  defold_hermes::game_object::Scope scope(context);
  if (!scope.entered()) return false;
  defoldHermesWebInit();
#else
  try {
    if (!gRuntime) return false;
    defold_hermes::game_object::ActiveContext context;
    if (!BuildBootstrapContext(&context)) {
      throw std::runtime_error("Bootstrap game-object attachment is stale during init");
    }
    defold_hermes::game_object::Scope scope(context);
    if (!scope.entered()) throw std::runtime_error("Game-object context stack is exhausted during init");
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
  dmGameObject::HInstance instance = dmScript::CheckGOInstance(state);
  if (gBootstrapAttachment.live) {
    const bool sameAttachment =
        gBootstrapAttachment.collection == dmGameObject::GetCollection(instance) &&
        gBootstrapAttachment.identifier == dmGameObject::GetIdentifier(instance) &&
        gBootstrapAttachment.instanceGeneration == dmGameObject::GetGeneration(instance);
    if (!sameAttachment) {
      return luaL_error(state, "A different TypeScript bootstrap instance is already attached");
    }
    lua_pushboolean(state, 1);
    return 1;
  }
  if (!EnsureScriptBridgeReady(state)) {
    return luaL_error(state, "Unable to initialize generated Defold script bridge from the registered Lua API");
  }
  if (!gLuaBridge || !gLuaBridge->captureInstance(1)) {
    return luaL_error(
        state, "Unable to capture Defold instance: %s",
        gLuaBridge ? gLuaBridge->lastError() : "bridge unavailable");
  }
  if (!gScriptBridge || !gScriptBridge->captureInstance(1)) {
    return luaL_error(
        state, "Unable to capture Defold script bridge instance: %s",
        gScriptBridge ? gScriptBridge->lastError() : "bridge unavailable");
  }
  InvalidateBootstrapAttachment();
  gBootstrapAttachment.collection = dmGameObject::GetCollection(instance);
  gBootstrapAttachment.identifier = dmGameObject::GetIdentifier(instance);
  gBootstrapAttachment.instanceGeneration = dmGameObject::GetGeneration(instance);
  gBootstrapAttachment.live = true;
  if (!StartApplication()) {
    DetachCapturedLuaInstances();
    InvalidateBootstrapAttachment();
    return luaL_error(state, "Unable to initialize TypeScript application");
  }
  dmLogInfo("TypeScript application initialized after script instance attachment");
  lua_pushboolean(state, 1);
  return 1;
}

int DetachLuaInstance(lua_State* state) {
  dmGameObject::HInstance instance = dmScript::CheckGOInstance(state);
  if (gBootstrapAttachment.live &&
      gBootstrapAttachment.collection == dmGameObject::GetCollection(instance) &&
      gBootstrapAttachment.identifier == dmGameObject::GetIdentifier(instance) &&
      gBootstrapAttachment.instanceGeneration == dmGameObject::GetGeneration(instance)) {
    FinalizeAttachedApplication("script detach");
    DetachCapturedLuaInstances();
    InvalidateBootstrapAttachment();
  }
  return 0;
}

int UpdateLuaInstance(lua_State* state) {
  dmGameObject::HInstance instance = dmScript::CheckGOInstance(state);
  const double dt = luaL_checknumber(state, 2);
  if (!gApplicationInitialized || !gBootstrapAttachment.live ||
      gBootstrapAttachment.collection != dmGameObject::GetCollection(instance) ||
      gBootstrapAttachment.identifier != dmGameObject::GetIdentifier(instance) ||
      gBootstrapAttachment.instanceGeneration != dmGameObject::GetGeneration(instance)) {
    return luaL_error(state, "TypeScript update called without the active bootstrap attachment");
  }
  defold_hermes::game_object::ActiveContext context;
  if (!BuildBootstrapContext(&context)) {
    return luaL_error(state, "Bootstrap game-object attachment is stale during update");
  }
  defold_hermes::game_object::Scope scope(context);
  if (!scope.entered()) return luaL_error(state, "Game-object context stack is exhausted during update");
#if defined(DM_PLATFORM_HTML5)
  defoldHermesWebUpdate(dt);
#else
  try {
    if (gRuntime) gRuntime->update(dt);
  } catch (const std::exception& error) {
    return luaL_error(state, "TypeScript update failed: %s", error.what());
  }
#endif
  if (gPendingRejectedBundleGeneration != 0) {
    dmLogInfo(
        "TypeScript bundle generation %llu remained active after rejecting generation %llu",
        static_cast<unsigned long long>(gBundleGeneration),
        static_cast<unsigned long long>(gPendingRejectedBundleGeneration));
    gPendingRejectedBundleGeneration = 0;
  }
  return 0;
}

void RegisterLuaBootstrap(lua_State* state) {
  const luaL_Reg functions[] = {
    {"attach", AttachLuaInstance},
    {"detach", DetachLuaInstance},
    {"update", UpdateLuaInstance},
    {nullptr, nullptr}
  };
  luaL_register(state, defold_hermes::component_proxy::kLuaModuleName, functions);
  lua_pop(state, 1);
}

#if !defined(DM_PLATFORM_HTML5)
defold_hermes::lua_bridge::scalar::ScriptAdapter* CurrentComponentScriptAdapter(void*) noexcept {
  return gScriptBridge.get();
}

bool EnsureComponentRuntime(void*, lua_State* state) noexcept {
  // Loading a Hermes bundle evaluates its module body immediately. Generated
  // component modules may construct hashes/URLs at module scope, so the Lua
  // dispatch table must already be installed before evaluation starts.
  return EnsureScriptBridgeReady(state) && EnsureBundleLoaded();
}
#endif

dmExtension::Result InitializeExtension(dmExtension::Params* params) {
  const char* appPath = dmConfigFile::GetString(
      params->m_ConfigFile, "defold_hermes.app", kDefaultAppPath);

  gResourceFactory = params->m_ResourceFactory;
  gBundlePath = appPath;

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
    dmLogError("Unable to initialize Lua compatibility bridge: %s", gLuaBridge->lastError());
    gLuaBridge.reset();
    gResourceFactory = nullptr;
    gBundlePath.clear();
    return dmExtension::RESULT_INIT_ERROR;
  }
  gLuaBridge->installCallbackApi({nullptr, InvokeTypeScriptCallback, ReleaseTypeScriptCallback});
  const defold_hermes::game_object::TerminalApi gameObjectApi = {
    nullptr,
    TerminalGetGeneration,
    TerminalGetCollection,
    TerminalGetIdentifier,
    TerminalGetPosition,
    TerminalSetPosition,
    TerminalSetRotation
  };
  if (!defold_hermes::game_object::installTerminalApi(gameObjectApi)) {
    dmLogError("Unable to install generated game-object terminal API");
    gLuaBridge->shutdown();
    gLuaBridge.reset();
    gResourceFactory = nullptr;
    gBundlePath.clear();
    return dmExtension::RESULT_INIT_ERROR;
  }
  RegisterLuaBootstrap(params->m_L);
#if defined(DM_PLATFORM_HTML5)
  defold_hermes::component_proxy::registerUnavailableLuaApi(params->m_L);
#else
  gComponentHermesBackend = std::make_unique<defold_hermes::component_proxy::HermesBackend>(
      nullptr, CurrentComponentRuntime, CurrentComponentScriptAdapter, EnsureComponentRuntime);
  const defold_hermes::component_proxy::InstanceApi componentInstanceApi = {
    dmScript::GetInstance,
    dmScript::SetInstance
  };
  gComponentLuaRuntime = std::make_unique<defold_hermes::component_proxy::LuaRuntime>(
      gComponentHermesBackend->api(), componentInstanceApi);
  gComponentLuaRuntime->registerLuaApi(params->m_L);
#endif
  defold_hermes::installLuaTimerCapi(LuaTimerDelay, LuaTimerCancel, LuaTimerTrigger);

  dmLogInfo("TypeScript bundle is waiting for script instance attachment");
  return dmExtension::RESULT_OK;
}

#if !defined(DM_PLATFORM_HTML5)
// Telemetry is emitted from the engine-driven extension update rather than the
// bootstrap script's Lua update, because component-only projects never attach a
// bootstrap script and would otherwise report nothing. Wall-clock timing keeps
// this independent of whichever Defold context is currently driving TypeScript.
void EmitTelemetry() {
  if (!gRuntime) return;
  const uint64_t now = dmTime::GetTime();
  const uint64_t frameDeltaMicros =
      gTelemetryLastFrameMicros && now > gTelemetryLastFrameMicros
          ? now - gTelemetryLastFrameMicros
          : 0;
  gTelemetryLastFrameMicros = now;
  if (!gTelemetryLastEmitMicros) {
    gTelemetryLastEmitMicros = now;
    return;
  }
  if (now - gTelemetryLastEmitMicros < 1000000u) return;
  gTelemetryLastEmitMicros = now;

  const auto runtime = gRuntime->telemetry();
  // Report the adapter pool that GUI/userdata routes actually consume; the
  // generic lua_bridge pool stays near zero and would hide exhaustion.
  const auto handles = gScriptBridge
      ? gScriptBridge->handleStats()
      : (gLuaBridge ? gLuaBridge->handles().stats()
                    : defold_hermes::lua_bridge::HandlePoolStats{});
  const auto scratch = gLuaBridge
      ? gLuaBridge->scratch().stats()
      : defold_hermes::lua_bridge::ScratchArenaStats{};
  dmLogInfo(
      "DEHERM_EVENT telemetry runtime_id=%u frame_dt_us=%llu heap_available=%s heap_bytes=%llu heap_size_bytes=%llu heap_peak_bytes=%llu callback_roots=%u component_instances=%u lua_handles=%u lua_handle_capacity=%u arena_high_water_bytes=%llu",
      gRuntime->identity(),
      static_cast<unsigned long long>(frameDeltaMicros),
      runtime.heapAvailable ? "true" : "false",
      static_cast<unsigned long long>(runtime.heapAllocatedBytes),
      static_cast<unsigned long long>(runtime.heapSizeBytes),
      static_cast<unsigned long long>(runtime.peakAllocatedBytes),
      runtime.callbackRoots,
      runtime.componentInstances,
      handles.live + handles.queued,
      handles.capacity,
      static_cast<unsigned long long>(scratch.highWater));
}
#endif

dmExtension::Result UpdateExtension(dmExtension::Params*) {
  if (!gLoggedFirstExtensionUpdate) {
    dmLogInfo("Extension update entered (application initialized: %s)",
        gApplicationInitialized ? "true" : "false");
    gLoggedFirstExtensionUpdate = true;
  }
  if (gBundleResource) ActivateBundle(false);
#if !defined(DM_PLATFORM_HTML5)
  EmitTelemetry();
#endif
  return dmExtension::RESULT_OK;
}

void OnEventExtension(dmExtension::Params*, const dmExtension::Event* event) {
  if (event && event->m_Event == EXTENSION_EVENT_ID_ENGINE_DELETE) {
    FinalizeAttachedApplication("engine delete event");
    DetachCapturedLuaInstances();
    InvalidateBootstrapAttachment();
  }
}

dmExtension::Result FinalizeExtension(dmExtension::Params*) {
  FinalizeAttachedApplication("extension finalize");
  DetachCapturedLuaInstances();
  gLoggedFirstExtensionUpdate = false;
  gTelemetryLastEmitMicros = 0;
  gTelemetryLastFrameMicros = 0;
  InvalidateBootstrapAttachment();
  defold_hermes::game_object::uninstallTerminalApi();
  defold_hermes::uninstallLuaTimerCapi();
  defold_hermes::uninstallScriptBridgeApi();
  if (gComponentLuaRuntime) gComponentLuaRuntime->shutdown();
  gComponentLuaRuntime.reset();
#if !defined(DM_PLATFORM_HTML5)
  gComponentHermesBackend.reset();
#endif
  if (gScriptBridge) gScriptBridge->shutdown();
  gScriptBridge.reset();
  gScriptBridgeState = ScriptBridgeState::kUninitialized;
  if (gLuaBridge) gLuaBridge->shutdown();
  gLuaBridge.reset();
#if !defined(DM_PLATFORM_HTML5)
  gRuntime.reset();
#endif
  if (gResourceFactory && gBundleResource) {
    dmResource::Release(gResourceFactory, gBundleResource);
  }
  gBundleResource = nullptr;
  gResourceFactory = nullptr;
  gBundlePath.clear();
  gBundleGeneration = 0;
  gRejectedBundleGeneration = 0;
  gPendingRejectedBundleGeneration = 0;
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppInitializeExtension(dmExtension::AppParams*) {
  // Native extension resource descriptors are not retained by Defold's linker
  // merely because DM_DECLARE_RESOURCE_TYPE emitted a registration function.
  // Referencing it from the app lifecycle both retains the object and installs
  // the descriptor before the engine creates and populates its resource factory.
  // AppInitialize runs again when Defold reboots the engine in-process, while
  // the resource creator descriptor list is process-global and append-only.
  // Registering the same static descriptor twice links it to itself.
  static bool bundleResourceDescriptorRegistered = false;
  if (!bundleResourceDescriptorRegistered) {
    DehermBundleResource();
    bundleResourceDescriptorRegistered = true;
  }
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppFinalizeExtension(dmExtension::AppParams*) {
  return dmExtension::RESULT_OK;
}

}  // namespace

// Defold derives the required C registration symbol from the extension folder
// name. A C-linkage function declared in a namespace still exports the global
// `defold_hermes` symbol, while the scoped C++ identifier avoids colliding with
// our public `defold_hermes` namespace.
namespace deherm_registration {
DM_DECLARE_EXTENSION(
    defold_hermes,
    LIB_NAME,
    AppInitializeExtension,
    AppFinalizeExtension,
    InitializeExtension,
    UpdateExtension,
    OnEventExtension,
    FinalizeExtension)
}  // namespace deherm_registration
