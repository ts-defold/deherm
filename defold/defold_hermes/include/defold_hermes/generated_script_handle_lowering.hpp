#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <defold_hermes/deherm_profile.hpp>
#include <defold_hermes/lua_value_registry.hpp>
#include <defold_hermes/scalar_lua_dispatch.hpp>
#include <defold_hermes/script_bridge_capi.hpp>

namespace defold_hermes::script_handle_lowering {

enum class SemanticHandleKind : uint16_t {
  kNone = 0,
  kBox2dBody = 1,
  kBox2dChain = 2,
  kBox2dJoint = 3,
  kBox2dShape = 4,
  kBox2dWorld = 5,
  kBufferData = 6,
  kBufferStream = 7,
  kBulletConstraint = 8,
  kBulletObject = 9,
  kBulletShape = 10,
  kBulletWorld = 11,
  kGraphicsRenderTarget = 12,
  kGraphicsTexture = 13,
  kGuiNode = 14,
  kRenderConstantBuffer = 15,
};

enum class OperationClass : uint8_t { kTerminal, kProducer, kSelfInvalidator, kChildInvalidator };
enum class Context : uint8_t { kExplicitPhysicsHandle, kRuntimeGlobal, kGameObjectInstance, kGuiScene, kRenderScriptAndGraphics };
enum class Invalidation : uint8_t { kNone, kSelfUnderlying, kChildIndex };
enum class Disposition : uint8_t { kCapturedLuaRouterHarnessProvenJsiUnverified, kStaticFfiUnimplemented, kBrowserHostUnimplemented, kGuiScriptAttachmentUnavailable, kRenderScriptAttachmentUnavailable, kProfileSymbolUnavailable };
enum class RuntimeProfileDetectionStatus : uint8_t { kMatched, kNoMatch, kAmbiguous, kLuaError, kInvalidArgument };

enum CodecMask : uint16_t {
  kNil = 1, kBoolean = 2, kInteger = 4,
  kNumber = 8, kString = 16, kHash = 32,
  kUrl = 64, kVector3 = 128, kVector4 = 256,
  kQuaternion = 512, kHandle = 1024
};

struct HandleKind {
  SemanticHandleKind kind;
  const char* id;
  const char* representation;
  const char* ownership;
  /**
   * Runtime profiles in which this kind is a rooted, generation-checked
   * identity. A kind whose backend representation differs by profile - Box2D
   * v2 pushes its world as a light userdata with no identity at all - is
   * capturable only in the profiles whose selected feature implements it as a
   * rooted userdata, and the router refuses a capture elsewhere by
   * declaration instead of by inspecting the Lua value.
   */
  uint8_t capturableProfileMask;
};

struct ValueCodec {
  uint16_t mask;
  SemanticHandleKind semanticKind;
};

struct Route {
  uint16_t index;
  uint32_t stableId;
  const char* canonicalId;
  const char* modulePath;
  const char* member;
  OperationClass operationClass;
  Context context;
  Invalidation invalidation;
  const char* ownershipToken;
  const char* lifetimeToken;
  const char* availabilityToken;
  bool runtimeAvailable;
  uint8_t runtimeProfileMask;
  Disposition nativeDynamicHermes;
  Disposition nativeStaticHermes;
  Disposition html5BrowserHost;
  uint16_t argumentOffset;
  uint16_t resultOffset;
  uint8_t argumentCount;
  uint8_t resultCount;
};

struct RuntimeProfile {
  uint8_t index;
  uint8_t mask;
  uint32_t capabilityBits;
  uint32_t sourceRouteCount;
  uint16_t adapterExecutableRouteCount;
  const char* id;
  const char* schema;
  const char* defoldRevision;
  const char* routeSetSha256;
  const char* catalogSha256;
};

struct RuntimeProfileHandshake {
  const char* schema;
  const char* profileId;
  const char* defoldRevision;
  uint32_t capabilityBits;
  uint32_t routeCount;
  const char* routeSetSha256;
  const char* catalogSha256;
};

struct RuntimeProfileDetection {
  RuntimeProfileDetectionStatus status;
  const RuntimeProfile* profile;
  uint16_t observedPresent;
  uint8_t matchingProfileMask;
  uint16_t mismatches[6];
};

inline constexpr uint16_t kHandleKindCount = 15;
inline constexpr uint16_t kRouteCount = 407;
inline constexpr uint16_t kRouterCandidateCount = 343;
inline constexpr uint16_t kBlockedCount = 64;
inline constexpr uint16_t kAdapterExecutableCount = 343;
inline constexpr uint8_t kRuntimeProfileCount = 6;

const HandleKind* handleKinds() noexcept;
const Route* routes() noexcept;
const ValueCodec* argumentCodecs() noexcept;
const ValueCodec* resultCodecs() noexcept;
const RuntimeProfile* runtimeProfiles() noexcept;
const RuntimeProfile* findRuntimeProfile(const char* id) noexcept;
const RuntimeProfile* validateRuntimeProfile(const RuntimeProfileHandshake& handshake) noexcept;
RuntimeProfileHandshake runtimeProfileHandshake(const RuntimeProfile& profile) noexcept;
bool routeAvailableInProfile(const Route& route, const RuntimeProfile& profile) noexcept;
RuntimeProfileDetectionStatus detectRuntimeProfile(lua_State* state, RuntimeProfileDetection* output,
    char* error, size_t errorCapacity) noexcept;
const Route* find(uint32_t stableId) noexcept;
/** Whether a semantic handle kind is a rooted identity in this runtime profile. */
bool handleKindCapturableInProfile(SemanticHandleKind kind, const RuntimeProfile& profile) noexcept;

#if DEHERM_PROFILE_ENABLED
/** Generated telemetry identity for the lua-stack transport. Declared only when
 *  DEHERM_PROFILE is on; with the switch off neither the declarations nor the
 *  tables behind them exist. */
inline constexpr uint16_t kContractShapeCount = 151;
/** Dense contract-shape id for a route, indexed by Route::index. */
uint16_t profileContractShape(uint16_t routeIndex) noexcept;
/** Cold dmProfile scope name for a route, indexed by Route::index. */
const char* profileRouteName(uint16_t routeIndex) noexcept;
/** Cold contract-shape token, indexed by the dense shape id. */
const char* profileContractShapeName(uint16_t shapeId) noexcept;
#endif

/** One fixed-capacity captured-Lua executor shared by every emitted handle route. */
class CapturedLuaRouter {
 public:
  CapturedLuaRouter(lua_State* state, lua_bridge::LuaValueRegistry& registry,
      const RuntimeProfile& activeProfile,
      lua_bridge::scalar::InstanceApi instanceApi = {}) noexcept;
  ~CapturedLuaRouter();
  CapturedLuaRouter(const CapturedLuaRouter&) = delete;
  CapturedLuaRouter& operator=(const CapturedLuaRouter&) = delete;
  bool captureInstance(int stackIndex) noexcept;
  void detachInstance() noexcept;
  bool captureHandle(int stackIndex, SemanticHandleKind kind, ScriptValue* output) noexcept;
  /** Whether this kind is a rooted identity in the profile this router is bound to. */
  bool capturableKind(SemanticHandleKind kind) const noexcept;
  bool dispatch(ScriptCallFrame* frame, char* error, size_t capacity) noexcept;
  bool queueRelease(const ScriptValue& value) noexcept;
  void drainReleased() noexcept;
 private:
  struct DispatchContext;
  struct InstanceContext;
  struct CaptureContext;
  static int ProtectedDispatch(lua_State* state);
  static int ProtectedCaptureCurrentInstance(lua_State* state);
  static int ProtectedRestoreCurrentInstance(lua_State* state);
  static int ProtectedInstallCaptureTrampolines(lua_State* state);
  static int ProtectedCaptureInstance(lua_State* state);
  static int ProtectedCaptureHandle(lua_State* state);
  bool captureHandleUnsafe(int stackIndex, SemanticHandleKind kind, ScriptValue* output) noexcept;
  bool dispatchUnsafe(DispatchContext& context) noexcept;
  bool bind(const Route& route, char* error, size_t capacity) noexcept;
  bool push(const ScriptValue& value, const ValueCodec& codec, ScriptCallFrame* frame,
      char* error, size_t capacity) noexcept;
  bool read(int stackIndex, const ValueCodec& codec, ScriptValue* output,
      ScriptCallFrame* frame, char* error, size_t capacity) noexcept;
  lua_State* state_ = nullptr;
  lua_bridge::LuaValueRegistry* registry_ = nullptr;
  const RuntimeProfile* activeProfile_ = nullptr;
  lua_bridge::scalar::InstanceApi instanceApi_{};
  int instanceRef_ = -2;
  int captureInstanceTrampolineRef_ = -2;
  int captureHandleTrampolineRef_ = -2;
  std::array<int, kRouteCount> functionRefs_{};
};

}  // namespace defold_hermes::script_handle_lowering
