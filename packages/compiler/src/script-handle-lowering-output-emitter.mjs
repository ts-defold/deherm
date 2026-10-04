// Package-owned renderer for the script handle-lowering family.
// Selection remains source-derived; this module projects its authenticated
// semantic report into byte-stable SDK and native artifacts.

export const handleCodecBits = Object.freeze({
  nil: 1,
  boolean: 2,
  integer: 4,
  number: 8,
  string: 16,
  hash: 32,
  url: 64,
  vector3: 128,
  vector4: 256,
  quaternion: 512,
  handle: 1024,
});

export function handlePascalIdentifier(value) {
  const result = String(value)
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
  return /^\d/u.test(result) ? `N${result}` : result;
}
function cppString(value) {
  return JSON.stringify(String(value));
}
function renderHeader(report) {
  const kindCases = report.handleKinds.map(({ enumName, numericId }) => `  k${enumName} = ${numericId},`).join("\n");
  return `#pragma once

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
${kindCases}
};

enum class OperationClass : uint8_t { kTerminal, kProducer, kSelfInvalidator, kChildInvalidator };
enum class Context : uint8_t { kExplicitPhysicsHandle, kRuntimeGlobal, kGameObjectInstance, kGuiScene, kRenderScriptAndGraphics };
enum class Invalidation : uint8_t { kNone, kSelfUnderlying, kChildIndex };
enum class Disposition : uint8_t { kCapturedLuaRouterHarnessProvenJsiUnverified, kStaticFfiUnimplemented, kBrowserHostUnimplemented, kGuiScriptAttachmentUnavailable, kRenderScriptAttachmentUnavailable, kProfileSymbolUnavailable };
enum class RuntimeProfileDetectionStatus : uint8_t { kMatched, kNoMatch, kAmbiguous, kLuaError, kInvalidArgument };

enum CodecMask : uint16_t {
  kNil = ${handleCodecBits.nil}, kBoolean = ${handleCodecBits.boolean}, kInteger = ${handleCodecBits.integer},
  kNumber = ${handleCodecBits.number}, kString = ${handleCodecBits.string}, kHash = ${handleCodecBits.hash},
  kUrl = ${handleCodecBits.url}, kVector3 = ${handleCodecBits.vector3}, kVector4 = ${handleCodecBits.vector4},
  kQuaternion = ${handleCodecBits.quaternion}, kHandle = ${handleCodecBits.handle}
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
  uint8_t registrationProfileMask;
  uint8_t runtimeProfileMask;
  bool nativeAdapterHarness;
  Disposition nativeDynamicHermes;
  Disposition nativeStaticHermes;
  Disposition html5BrowserHost;
  uint16_t argumentOffset;
  uint16_t resultOffset;
  uint8_t requiredArgumentCount;
  uint8_t argumentCount;
  uint8_t resultCount;
};

struct RuntimeProfile {
  uint8_t index;
  uint8_t mask;
  uint8_t detectionCanonicalProfileIndex;
  uint8_t equivalentProfileMask;
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

inline constexpr uint8_t kRuntimeProfileMismatchSampleCapacity = 4;

struct RuntimeProfileDetection {
  RuntimeProfileDetectionStatus status;
  const RuntimeProfile* profile;
  uint16_t observedPresent;
  uint8_t matchingProfileMask;
  uint16_t mismatches[${report.runtimeProfiles.length}];
  uint32_t mismatchStableIds[${report.runtimeProfiles.length}][kRuntimeProfileMismatchSampleCapacity];
  uint8_t mismatchObserved[${report.runtimeProfiles.length}][kRuntimeProfileMismatchSampleCapacity];
};

inline constexpr uint16_t kHandleKindCount = ${report.handleKindCount};
inline constexpr uint16_t kRouteCount = ${report.coverage.selectedRoutes};
inline constexpr uint16_t kRouterCandidateCount = ${report.coverage.routerCandidates};
inline constexpr uint16_t kBlockedCount = ${report.coverage.blocked};
inline constexpr uint16_t kAdapterExecutableCount = ${report.coverage.adapterExecutableRoutes};
inline constexpr uint8_t kRuntimeProfileCount = ${report.runtimeProfiles.length};

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
inline constexpr uint16_t kContractShapeCount = ${report.contractShapeCount};
/** Dense contract-shape id for a route, indexed by Route::index. */
uint16_t profileContractShape(uint16_t routeIndex) noexcept;
/** Cold dmProfile scope name for a route, indexed by Route::index. */
const char* profileRouteName(uint16_t routeIndex) noexcept;
/** Cold contract-shape token, indexed by the dense shape id. */
const char* profileContractShapeName(uint16_t shapeId) noexcept;
#endif

/** The owning adapter resolves legacy GUI tokens in its separate handle pool. */
struct LegacyHandleApi {
  void* context = nullptr;
  bool (*pushGuiNode)(void*, const ScriptValue&, char*, size_t) noexcept = nullptr;
};

/** One fixed-capacity captured-Lua executor shared by every emitted handle route. */
class CapturedLuaRouter {
 public:
  CapturedLuaRouter(lua_State* state, lua_bridge::LuaValueRegistry& registry,
      const RuntimeProfile& activeProfile,
      lua_bridge::scalar::InstanceApi instanceApi = {},
      LegacyHandleApi legacyHandles = {}) noexcept;
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
  // LuaJIT implements Lua errors with an unwind on native targets. This body is
  // entered by lua_cpcall, so it must allow that unwind to reach the protector.
  bool dispatchUnsafe(DispatchContext& context);
  bool bind(const Route& route, char* error, size_t capacity) noexcept;
  bool push(const ScriptValue& value, const ValueCodec& codec, ScriptCallFrame* frame,
      char* error, size_t capacity) noexcept;
  bool read(int stackIndex, const ValueCodec& codec, ScriptValue* output,
      ScriptCallFrame* frame, char* error, size_t capacity) noexcept;
  lua_State* state_ = nullptr;
  lua_bridge::LuaValueRegistry* registry_ = nullptr;
  const RuntimeProfile* activeProfile_ = nullptr;
  lua_bridge::scalar::InstanceApi instanceApi_{};
  LegacyHandleApi legacyHandles_{};
  int instanceRef_ = -2;
  int captureInstanceTrampolineRef_ = -2;
  int captureHandleTrampolineRef_ = -2;
  std::array<int, kRouteCount> functionRefs_{};
};

}  // namespace defold_hermes::script_handle_lowering
`;
}

function renderKindHeader(report) {
  const names = report.handleKinds.map(({ id }) => `  ${cppString(id)},`).join("\n");
  return `#pragma once
#include <cstdint>

namespace defold_hermes::script_handle_lowering {
inline constexpr const char* kSemanticHandleKindNames[] = {
  nullptr,
${names}
};
inline constexpr uint8_t kSemanticHandleKindNameCount = ${report.handleKindCount};
inline const char* semanticHandleKindName(uint8_t kind) noexcept {
  return kind > 0 && kind <= kSemanticHandleKindNameCount ? kSemanticHandleKindNames[kind] : nullptr;
}
}  // namespace defold_hermes::script_handle_lowering
`;
}

const operationCpp = Object.freeze({
  "checked-handle-input-terminal": "OperationClass::kTerminal",
  "checked-handle-return-capture": "OperationClass::kProducer",
  "checked-self-engine-object-invalidate": "OperationClass::kSelfInvalidator",
  "checked-child-engine-object-invalidate": "OperationClass::kChildInvalidator",
});

const contextCpp = Object.freeze({
  "explicit-physics-handle": "Context::kExplicitPhysicsHandle",
  "runtime-global": "Context::kRuntimeGlobal",
  "game-object-instance": "Context::kGameObjectInstance",
  "gui-scene": "Context::kGuiScene",
  "render-script-instance-and-graphics-context": "Context::kRenderScriptAndGraphics",
});

const dispositionCpp = Object.freeze({
  "captured-lua-router-harness-proven-jsi-unverified": "Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified",
  "static-ffi-unimplemented": "Disposition::kStaticFfiUnimplemented",
  "browser-host-unimplemented": "Disposition::kBrowserHostUnimplemented",
  "gui-script-attachment-unavailable": "Disposition::kGuiScriptAttachmentUnavailable",
  "render-script-attachment-unavailable": "Disposition::kRenderScriptAttachmentUnavailable",
  "profile-symbol-unavailable": "Disposition::kProfileSymbolUnavailable",
});

function renderSource(report) {
  const kindById = Object.fromEntries(report.handleKinds.map((kind) => [kind.id, kind]));
  const kinds = report.handleKinds
    .map(
      (kind) =>
        `  {SemanticHandleKind::k${kind.enumName}, ${cppString(kind.id)}, ${cppString(kind.representation)}, ${cppString(kind.ownership)}, ${kind.capturableProfileMask}},`,
    )
    .join("\n");
  const arguments_ = report.argumentCodecs
    .map(
      (codec) =>
        `  {${codec.mask}, SemanticHandleKind::k${codec.semanticKind ? kindById[codec.semanticKind].enumName : "None"}},`,
    )
    .join("\n");
  const results = report.resultCodecs
    .map(
      (codec) =>
        `  {${codec.mask}, SemanticHandleKind::k${codec.semanticKind ? kindById[codec.semanticKind].enumName : "None"}},`,
    )
    .join("\n");
  const routes = report.routes
    .map(
      (route) =>
        `  {${route.index}, ${route.stableId}u, ${cppString(route.id)}, ${cppString(route.modulePath.join("."))}, ${cppString(route.member)}, ${operationCpp[route.operationClass]}, ${contextCpp[route.context]}, Invalidation::k${handlePascalIdentifier(route.invalidation)}, ${cppString(route.ownership.projectionToken)}, ${cppString(route.lifetime.projectionToken)}, ${cppString(route.profiles.token)}, ${route.profiles.runtimeAvailable}, ${route.profiles.registrationMask}, ${route.profiles.runtimeMask}, ${route.generation.router === "emitted"}, ${dispositionCpp[route.targets.nativeDynamicHermes]}, ${dispositionCpp[route.targets.nativeStaticHermes]}, ${dispositionCpp[route.targets.html5BrowserHost]}, ${route.argumentOffset}, ${route.resultOffset}, ${route.requiredArgumentCount}, ${route.argumentCount}, ${route.resultCount}},`,
    )
    .join("\n");
  const runtimeProfiles = report.runtimeProfiles
    .map(
      (profile) =>
        `  {${profile.index}, ${profile.mask}, ${profile.detectionCanonicalProfileIndex}, ${profile.equivalentProfileMask}, ${profile.capabilityBits}u, ${profile.sourceRouteCount}u, ${profile.adapterExecutableRouteCount}, ${cppString(profile.id)}, ${cppString(profile.schema)}, ${cppString(profile.defoldRevision)}, ${cppString(profile.routeSetSha256)}, ${cppString(profile.catalogSha256)}},`,
    )
    .join("\n");
  const stableOrder = [...report.routes]
    .sort((left, right) => left.stableId - right.stableId)
    .map(({ index }) => index);
  const profileShapes = report.routes.map((route) => `  ${route.contractShapeIndex},`).join("\n");
  const profileNames = report.routes
    .map((route) => `  ${cppString(`deherm.lua-stack.${route.modulePath.join(".")}.${route.member}`)},`)
    .join("\n");
  const profileShapeNames = report.contractShapes.map((token) => `  ${cppString(token)},`).join("\n");
  return `#include <defold_hermes/generated_script_handle_lowering.hpp>
#include <defold_hermes/script_url_arena.hpp>
#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace dmScript {
void PushHash(lua_State*, dmhash_t); dmhash_t* ToHash(lua_State*, int);
void PushVector3(lua_State*, const dmVMath::Vector3&); dmVMath::Vector3* ToVector3(lua_State*, int);
void PushVector4(lua_State*, const dmVMath::Vector4&); dmVMath::Vector4* ToVector4(lua_State*, int);
void PushQuat(lua_State*, const dmVMath::Quat&); dmVMath::Quat* ToQuat(lua_State*, int);
void PushURL(lua_State*, const dmMessage::URL&);
}

namespace defold_hermes::script_handle_lowering {
namespace {
constexpr int64_t kMaxExactInteger = 9007199254740991LL;

constexpr HandleKind kKinds[] = {
${kinds}
};

constexpr ValueCodec kArguments[] = {
${arguments_}
};

constexpr ValueCodec kResults[] = {
${results}
};

constexpr Route kRoutes[] = {
${routes}
};

constexpr RuntimeProfile kRuntimeProfiles[] = {
${runtimeProfiles}
};

constexpr uint16_t kStableOrder[] = { ${stableOrder.join(", ")} };

struct RuntimeProfileDetectionContext {
  RuntimeProfileDetection* output;
};

void fail(char* error, size_t capacity, const char* message) noexcept {
  if (error && capacity) std::snprintf(error, capacity, "%s", message ? message : "captured Lua handle call failed");
}

uint64_t pack(lua_bridge::Handle handle) noexcept {
  return static_cast<uint64_t>(handle.slot) | (static_cast<uint64_t>(handle.generation) << 32u);
}

lua_bridge::Handle unpack(const ScriptValue& value) noexcept {
  return {value.length, static_cast<uint32_t>(value.payload), static_cast<uint32_t>(value.payload >> 32u),
      static_cast<uint32_t>(lua_bridge::LuaValueKind::kUserdata)};
}

uint16_t valueMask(const ScriptValue& value) noexcept {
  switch (value.tag) {
    case ScriptValueTag::kUndefined: case ScriptValueTag::kNull: return kNil;
    case ScriptValueTag::kBoolean: return kBoolean;
    case ScriptValueTag::kNumber: return kInteger | kNumber;
    case ScriptValueTag::kString: return kString;
    case ScriptValueTag::kHandle:
      if (value.handleKind == ScriptHandleKind::kHash) return kHash;
      if (value.handleKind == ScriptHandleKind::kUrl) return kUrl;
      if (value.handleKind == ScriptHandleKind::kLuaSemanticHandle || value.handleKind == ScriptHandleKind::kGuiNode) return kHandle;
      return 0;
    case ScriptValueTag::kDefoldValue:
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) return kVector3;
      if (value.defoldKind == ScriptDefoldValueKind::kVector4) return kVector4;
      if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) return kQuaternion;
      return 0;
    default: return 0;
  }
}

bool rawFunctionPresent(lua_State* state, const Route& route) {
  const int top = lua_gettop(state);
  const char* segment = route.modulePath;
  const char* dot = std::strchr(segment, '.');
  const size_t firstLength = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
  lua_pushlstring(state, segment, firstLength);
  lua_rawget(state, LUA_GLOBALSINDEX);
  while (dot && lua_istable(state, -1)) {
    segment = dot + 1;
    dot = std::strchr(segment, '.');
    const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    lua_pushlstring(state, segment, length);
    lua_rawget(state, -2);
    lua_remove(state, -2);
  }
  bool present = false;
  if (!dot && lua_istable(state, -1)) {
    lua_pushstring(state, route.member);
    lua_rawget(state, -2);
    present = lua_isfunction(state, -1) != 0;
  }
  lua_settop(state, top);
  return present;
}

int protectedDetectRuntimeProfile(lua_State* state) {
  auto* context = static_cast<RuntimeProfileDetectionContext*>(lua_touserdata(state, 1));
  RuntimeProfileDetection& output = *context->output;
  for (uint16_t index = 0; index < kRouteCount; ++index) {
    const Route& route = kRoutes[index];
    if (!route.nativeAdapterHarness) continue;
    const bool present = rawFunctionPresent(state, route);
    if (present) ++output.observedPresent;
    for (uint8_t profileIndex = 0; profileIndex < kRuntimeProfileCount; ++profileIndex) {
      const bool expected = (route.registrationProfileMask & kRuntimeProfiles[profileIndex].mask) != 0;
      if (present != expected) {
        const uint16_t mismatchIndex = output.mismatches[profileIndex]++;
        if (mismatchIndex < kRuntimeProfileMismatchSampleCapacity) {
          output.mismatchStableIds[profileIndex][mismatchIndex] = route.stableId;
          output.mismatchObserved[profileIndex][mismatchIndex] = present ? 1u : 0u;
        }
      }
    }
  }
  uint8_t matches = 0;
  const RuntimeProfile* match = nullptr;
  for (uint8_t index = 0; index < kRuntimeProfileCount; ++index) {
    if (output.mismatches[index] != 0) continue;
    output.matchingProfileMask = static_cast<uint8_t>(output.matchingProfileMask | kRuntimeProfiles[index].mask);
    if (!match) match = &kRuntimeProfiles[index];
    ++matches;
  }
  if (matches == 1) {
    output.profile = match;
    output.status = RuntimeProfileDetectionStatus::kMatched;
  } else if (matches > 1) {
    const uint8_t canonical = match->detectionCanonicalProfileIndex;
    bool equivalent = true;
    for (uint8_t index = 0; index < kRuntimeProfileCount; ++index) {
      if (output.mismatches[index] == 0 && kRuntimeProfiles[index].detectionCanonicalProfileIndex != canonical) {
        equivalent = false;
        break;
      }
    }
    output.profile = equivalent ? &kRuntimeProfiles[canonical] : nullptr;
    output.status = equivalent ? RuntimeProfileDetectionStatus::kMatched : RuntimeProfileDetectionStatus::kAmbiguous;
  } else {
    output.status = RuntimeProfileDetectionStatus::kNoMatch;
  }
  return 0;
}

static_assert(sizeof(kKinds) / sizeof(kKinds[0]) == kHandleKindCount);
static_assert(sizeof(kRoutes) / sizeof(kRoutes[0]) == kRouteCount);
static_assert(sizeof(kRuntimeProfiles) / sizeof(kRuntimeProfiles[0]) == kRuntimeProfileCount);

#if DEHERM_PROFILE_ENABLED
// Generated telemetry identity for the lua-stack transport. These tables exist
// only when DEHERM_PROFILE is on; with the switch off the preprocessor removes
// them, so no storage and no cold strings reach the object file.
constexpr uint16_t kRouteContractShapes[] = {
${profileShapes}
};

constexpr const char* kRouteProfileNames[] = {
${profileNames}
};

constexpr const char* kContractShapeNames[] = {
${profileShapeNames}
};

static_assert(sizeof(kRouteContractShapes) / sizeof(kRouteContractShapes[0]) == kRouteCount);
static_assert(sizeof(kRouteProfileNames) / sizeof(kRouteProfileNames[0]) == kRouteCount);
static_assert(sizeof(kContractShapeNames) / sizeof(kContractShapeNames[0]) == kContractShapeCount);
#endif

}  // namespace

const HandleKind* handleKinds() noexcept { return kKinds; }
const Route* routes() noexcept { return kRoutes; }
const ValueCodec* argumentCodecs() noexcept { return kArguments; }
const ValueCodec* resultCodecs() noexcept { return kResults; }
const RuntimeProfile* runtimeProfiles() noexcept { return kRuntimeProfiles; }

const RuntimeProfile* findRuntimeProfile(const char* id) noexcept {
  if (!id) return nullptr;
  for (const RuntimeProfile& profile : kRuntimeProfiles) if (std::strcmp(profile.id, id) == 0) return &profile;
  return nullptr;
}

const RuntimeProfile* validateRuntimeProfile(const RuntimeProfileHandshake& handshake) noexcept {
  const RuntimeProfile* profile = findRuntimeProfile(handshake.profileId);
  if (!profile || !handshake.schema || !handshake.defoldRevision || !handshake.routeSetSha256 || !handshake.catalogSha256) return nullptr;
  return std::strcmp(profile->schema, handshake.schema) == 0 &&
      std::strcmp(profile->defoldRevision, handshake.defoldRevision) == 0 &&
      profile->capabilityBits == handshake.capabilityBits && profile->sourceRouteCount == handshake.routeCount &&
      std::strcmp(profile->routeSetSha256, handshake.routeSetSha256) == 0 &&
      std::strcmp(profile->catalogSha256, handshake.catalogSha256) == 0 ? profile : nullptr;
}

RuntimeProfileHandshake runtimeProfileHandshake(const RuntimeProfile& profile) noexcept {
  return {profile.schema, profile.id, profile.defoldRevision, profile.capabilityBits, profile.sourceRouteCount,
      profile.routeSetSha256, profile.catalogSha256};
}

bool routeAvailableInProfile(const Route& route, const RuntimeProfile& profile) noexcept {
  return profile.index < kRuntimeProfileCount && profile.mask == static_cast<uint8_t>(1u << profile.index) &&
      (route.runtimeProfileMask & profile.mask) != 0;
}

RuntimeProfileDetectionStatus detectRuntimeProfile(lua_State* state, RuntimeProfileDetection* output,
    char* error, size_t errorCapacity) noexcept {
  if (!state || !output) {
    fail(error, errorCapacity, "runtime profile detection requires a Lua state and output");
    return RuntimeProfileDetectionStatus::kInvalidArgument;
  }
  *output = {};
  output->status = RuntimeProfileDetectionStatus::kNoMatch;
  const int top = lua_gettop(state);
  RuntimeProfileDetectionContext context{output};
  const int status = lua_cpcall(state, protectedDetectRuntimeProfile, &context);
  if (status != 0) {
    fail(error, errorCapacity, lua_tostring(state, -1));
    lua_settop(state, top);
    *output = {};
    output->status = RuntimeProfileDetectionStatus::kLuaError;
    return output->status;
  }
  lua_settop(state, top);
  if (output->status == RuntimeProfileDetectionStatus::kNoMatch) {
    fail(error, errorCapacity, "Lua registration surface does not exactly match a generated runtime profile");
  } else if (output->status == RuntimeProfileDetectionStatus::kAmbiguous) {
    fail(error, errorCapacity, "Lua registration surface ambiguously matches multiple generated runtime profiles");
  } else if (error && errorCapacity) {
    error[0] = '\\0';
  }
  return output->status;
}

bool handleKindCapturableInProfile(SemanticHandleKind kind, const RuntimeProfile& profile) noexcept {
  const auto index = static_cast<uint16_t>(kind);
  if (index == 0 || index > kHandleKindCount) return false;
  return (kKinds[index - 1].capturableProfileMask & profile.mask) != 0;
}

const Route* find(uint32_t stableId) noexcept {
  size_t first = 0, count = kRouteCount;
  while (count) { const size_t step = count / 2, position = first + step; const Route& route = kRoutes[kStableOrder[position]];
    if (route.stableId < stableId) { first = position + 1; count -= step + 1; } else count = step; }
  return first < kRouteCount && kRoutes[kStableOrder[first]].stableId == stableId ? &kRoutes[kStableOrder[first]] : nullptr;
}

#if DEHERM_PROFILE_ENABLED
uint16_t profileContractShape(uint16_t routeIndex) noexcept {
  return routeIndex < kRouteCount ? kRouteContractShapes[routeIndex] : UINT16_C(0);
}

const char* profileRouteName(uint16_t routeIndex) noexcept {
  return routeIndex < kRouteCount ? kRouteProfileNames[routeIndex] : "deherm.lua-stack.unknown";
}

const char* profileContractShapeName(uint16_t shapeId) noexcept {
  return shapeId < kContractShapeCount ? kContractShapeNames[shapeId] : "unknown";
}
#endif

struct CapturedLuaRouter::DispatchContext {
  CapturedLuaRouter* router;
  const Route* route;
  ScriptCallFrame* frame;
  char* error;
  size_t errorCapacity;
  bool ok;
};

struct CapturedLuaRouter::InstanceContext {
  CapturedLuaRouter* router;
  int reference;
  bool ok;
};

struct CapturedLuaRouter::CaptureContext {
  CapturedLuaRouter* router;
  int stackIndex;
  SemanticHandleKind kind;
  ScriptValue* output;
  int reference;
  bool ok;
};

CapturedLuaRouter::CapturedLuaRouter(lua_State* state, lua_bridge::LuaValueRegistry& registry,
    const RuntimeProfile& activeProfile, lua_bridge::scalar::InstanceApi instanceApi,
    LegacyHandleApi legacyHandles) noexcept
    : state_(state), registry_(&registry), activeProfile_(&activeProfile), instanceApi_(instanceApi), legacyHandles_(legacyHandles) {
  functionRefs_.fill(LUA_NOREF);
  if (state_) {
    const int top = lua_gettop(state_);
    if (lua_cpcall(state_, ProtectedInstallCaptureTrampolines, this) != 0) {
      captureInstanceTrampolineRef_ = captureHandleTrampolineRef_ = LUA_NOREF;
    }
    lua_settop(state_, top);
  }
}

int CapturedLuaRouter::ProtectedInstallCaptureTrampolines(lua_State* state) {
  auto* router = static_cast<CapturedLuaRouter*>(lua_touserdata(state, 1));
  lua_pushcfunction(state, ProtectedCaptureInstance);
  router->captureInstanceTrampolineRef_ = luaL_ref(state, LUA_REGISTRYINDEX);
  lua_pushcfunction(state, ProtectedCaptureHandle);
  router->captureHandleTrampolineRef_ = luaL_ref(state, LUA_REGISTRYINDEX);
  return 0;
}

CapturedLuaRouter::~CapturedLuaRouter() {
  detachInstance();
  if (state_) for (int& reference : functionRefs_) {
    if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
    reference = LUA_NOREF;
  }
  if (state_ && captureInstanceTrampolineRef_ != LUA_NOREF && captureInstanceTrampolineRef_ != LUA_REFNIL)
    luaL_unref(state_, LUA_REGISTRYINDEX, captureInstanceTrampolineRef_);
  if (state_ && captureHandleTrampolineRef_ != LUA_NOREF && captureHandleTrampolineRef_ != LUA_REFNIL)
    luaL_unref(state_, LUA_REGISTRYINDEX, captureHandleTrampolineRef_);
}

bool CapturedLuaRouter::captureInstance(int stackIndex) noexcept {
  if (!state_ || !instanceApi_.get || !instanceApi_.set ||
      captureInstanceTrampolineRef_ == LUA_NOREF || captureInstanceTrampolineRef_ == LUA_REFNIL) return false;
  const int top = lua_gettop(state_);
  const int absoluteIndex = stackIndex > 0 ? stackIndex : top + stackIndex + 1;
  if (absoluteIndex <= 0 || absoluteIndex > top) return false;
  CaptureContext context{this, absoluteIndex, SemanticHandleKind::kNone, nullptr, LUA_NOREF, false};
  lua_rawgeti(state_, LUA_REGISTRYINDEX, captureInstanceTrampolineRef_);
  lua_pushvalue(state_, absoluteIndex);
  lua_pushlightuserdata(state_, &context);
  const int status = lua_pcall(state_, 2, 0, 0);
  lua_settop(state_, top);
  if (status != 0 || !context.ok || context.reference == LUA_NOREF || context.reference == LUA_REFNIL) return false;
  detachInstance();
  instanceRef_ = context.reference;
  return true;
}

int CapturedLuaRouter::ProtectedCaptureInstance(lua_State* state) {
  auto* context = static_cast<CaptureContext*>(lua_touserdata(state, 2));
  lua_pushvalue(state, 1);
  context->reference = luaL_ref(state, LUA_REGISTRYINDEX);
  context->ok = context->reference != LUA_NOREF && context->reference != LUA_REFNIL;
  return 0;
}

void CapturedLuaRouter::detachInstance() noexcept {
  if (state_ && instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
  instanceRef_ = LUA_NOREF;
}

bool CapturedLuaRouter::capturableKind(SemanticHandleKind kind) const noexcept {
  return activeProfile_ != nullptr && handleKindCapturableInProfile(kind, *activeProfile_);
}

bool CapturedLuaRouter::captureHandle(int stackIndex, SemanticHandleKind kind, ScriptValue* output) noexcept {
  if (!state_ || !registry_ || !output || kind == SemanticHandleKind::kNone ||
      captureHandleTrampolineRef_ == LUA_NOREF || captureHandleTrampolineRef_ == LUA_REFNIL) return false;
  const int top = lua_gettop(state_);
  const int absoluteIndex = stackIndex > 0 ? stackIndex : top + stackIndex + 1;
  if (absoluteIndex <= 0 || absoluteIndex > top) return false;
  CaptureContext context{this, absoluteIndex, kind, output, LUA_NOREF, false};
  lua_rawgeti(state_, LUA_REGISTRYINDEX, captureHandleTrampolineRef_);
  lua_pushvalue(state_, absoluteIndex);
  lua_pushlightuserdata(state_, &context);
  const int status = lua_pcall(state_, 2, 0, 0);
  lua_settop(state_, top);
  return status == 0 && context.ok;
}

int CapturedLuaRouter::ProtectedCaptureHandle(lua_State* state) {
  auto* context = static_cast<CaptureContext*>(lua_touserdata(state, 2));
  context->ok = context->router->captureHandleUnsafe(1, context->kind, context->output);
  return 0;
}

bool CapturedLuaRouter::captureHandleUnsafe(int stackIndex, SemanticHandleKind kind, ScriptValue* output) noexcept {
  const auto handle = registry_->capture(stackIndex, {lua_bridge::LuaValueKind::kUserdata,
      lua_bridge::LuaValuePolicy::kBorrowed, static_cast<uint16_t>(kind)});
  if (!handle) return false;
  *output = {}; output->tag = ScriptValueTag::kHandle; output->handleKind = ScriptHandleKind::kLuaSemanticHandle;
  output->reserved = static_cast<uint8_t>(kind); output->length = handle.runtime; output->payload = pack(handle); return true;
}

bool CapturedLuaRouter::queueRelease(const ScriptValue& value) noexcept {
  return registry_ && value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kLuaSemanticHandle &&
      registry_->queueRelease(unpack(value), {lua_bridge::LuaValueKind::kUserdata, lua_bridge::LuaValuePolicy::kBorrowed, 0});
}

void CapturedLuaRouter::drainReleased() noexcept { if (registry_) registry_->drainDeferred(); }

bool CapturedLuaRouter::bind(const Route& route, char* error, size_t capacity) noexcept {
  int& reference = functionRefs_[route.index]; if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int top = lua_gettop(state_); const char* segment = route.modulePath; const char* dot = std::strchr(segment, '.');
  if (dot) { const size_t length = static_cast<size_t>(dot - segment); if (length >= 64) { fail(error, capacity, "handle module segment exceeds scratch"); return false; }
    char name[64]{}; std::memcpy(name, segment, length); lua_getglobal(state_, name); } else lua_getglobal(state_, segment);
  while (dot && lua_istable(state_, -1)) { segment = dot + 1; dot = std::strchr(segment, '.'); const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    lua_pushlstring(state_, segment, length); lua_gettable(state_, -2); lua_remove(state_, -2); }
  if (!lua_istable(state_, -1)) { lua_settop(state_, top); fail(error, capacity, "handle Lua module is unavailable"); return false; }
  lua_getfield(state_, -1, route.member); if (!lua_isfunction(state_, -1)) { lua_settop(state_, top); fail(error, capacity, "handle Lua function is unavailable"); return false; }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX); lua_settop(state_, top); return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool CapturedLuaRouter::push(const ScriptValue& value, const ValueCodec& codec, ScriptCallFrame* frame,
    char* error, size_t capacity) noexcept {
  const uint16_t mask = valueMask(value); if (!(mask & codec.mask)) { fail(error, capacity, "handle argument codec mismatch"); return false; }
  if (value.tag == ScriptValueTag::kNumber && (codec.mask & kInteger) && !(codec.mask & kNumber) &&
      (!std::isfinite(value.number) || std::trunc(value.number) != value.number || value.number < -static_cast<double>(kMaxExactInteger) || value.number > static_cast<double>(kMaxExactInteger))) {
    fail(error, capacity, "handle integer argument is not exact"); return false;
  }
  switch (value.tag) {
    case ScriptValueTag::kUndefined: case ScriptValueTag::kNull: lua_pushnil(state_); return true;
    case ScriptValueTag::kBoolean: lua_pushboolean(state_, value.number != 0); return true;
    case ScriptValueTag::kNumber: lua_pushnumber(state_, value.number); return true;
    case ScriptValueTag::kString: if (value.length && !value.data) { fail(error, capacity, "handle string data is null"); return false; } lua_pushlstring(state_, value.data ? static_cast<const char*>(value.data) : "", value.length); return true;
    case ScriptValueTag::kHandle:
      if (value.handleKind == ScriptHandleKind::kHash) { dmScript::PushHash(state_, value.payload); return true; }
      if (value.handleKind == ScriptHandleKind::kUrl) { dmMessage::URL url{}; if (!frame || !frame->urlArena || !frame->urlArena->copyForPushUrl(value, frame->urlArena->runtimeToken(), &url)) { fail(error, capacity, "handle URL is stale"); return false; } dmScript::PushURL(state_, url); return true; }
      if (value.handleKind == ScriptHandleKind::kGuiNode && codec.semanticKind == SemanticHandleKind::kGuiNode && legacyHandles_.pushGuiNode) {
        return legacyHandles_.pushGuiNode(legacyHandles_.context, value, error, capacity);
      }
      if (value.handleKind == ScriptHandleKind::kLuaSemanticHandle && codec.semanticKind != SemanticHandleKind::kNone && registry_->push(unpack(value),
          {lua_bridge::LuaValueKind::kUserdata, lua_bridge::LuaValuePolicy::kBorrowed, static_cast<uint16_t>(codec.semanticKind)})) return true;
      fail(error, capacity, "semantic handle is stale, cross-runtime, or wrong-kind"); return false;
    case ScriptValueTag::kDefoldValue:
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) { dmScript::PushVector3(state_, dmVMath::Vector3(value.defoldValue[0], value.defoldValue[1], value.defoldValue[2])); return true; }
      if (value.defoldKind == ScriptDefoldValueKind::kVector4) { dmScript::PushVector4(state_, dmVMath::Vector4(value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3])); return true; }
      if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) { dmScript::PushQuat(state_, dmVMath::Quat(value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3])); return true; }
      break;
    default: break;
  }
  fail(error, capacity, "handle argument tag is unsupported"); return false;
}

bool CapturedLuaRouter::read(int index, const ValueCodec& codec, ScriptValue* output, ScriptCallFrame* frame,
    char* error, size_t capacity) noexcept {
  *output = {};
  if (lua_isnil(state_, index) && (codec.mask & kNil)) { output->tag = ScriptValueTag::kNull; return true; }
  if (codec.semanticKind != SemanticHandleKind::kNone) {
    // Representation is a property of the backend, not of the kind: Box2D v2
    // pushes its world as a light userdata with no identity at all, while v3
    // pushes a rooted one. The classification states that per feature and the
    // generated table carries it per runtime profile, so the refusal is a
    // declaration rather than a discovery about the value on the stack.
    if (activeProfile_ && !handleKindCapturableInProfile(codec.semanticKind, *activeProfile_)) {
      fail(error, capacity, "semantic handle kind is not a rooted identity in the active runtime profile");
      return false;
    }
    // lua_isuserdata is true for a light userdata, which carries no
    // metatable and therefore no rooted identity the semantic-handle registry
    // can generation-check. Refuse it by name so the failure is attributable
    // instead of being reported as an exhausted registry.
    const int handleType = lua_type(state_, index);
    if (handleType == LUA_TLIGHTUSERDATA) { fail(error, capacity, "semantic handle result is a light userdata with no rooted identity"); return false; }
    if (handleType != LUA_TUSERDATA) { fail(error, capacity, "semantic handle result is not a userdata"); return false; }
    if (!captureHandleUnsafe(index, codec.semanticKind, output)) { fail(error, capacity, "semantic handle registry is exhausted"); return false; }
    return true;
  }
  const int type = lua_type(state_, index);
  if ((codec.mask & kBoolean) && type == LUA_TBOOLEAN) { output->tag=ScriptValueTag::kBoolean; output->number=lua_toboolean(state_,index)?1:0; return true; }
  if ((codec.mask & (kInteger|kNumber)) && type == LUA_TNUMBER) { const double number=lua_tonumber(state_,index); if ((codec.mask&kInteger)&&!(codec.mask&kNumber)&&(!std::isfinite(number)||std::trunc(number)!=number)) { fail(error,capacity,"handle integer result is not exact");return false;} output->tag=ScriptValueTag::kNumber;output->number=number;return true; }
  if ((codec.mask & kString) && type == LUA_TSTRING) { size_t length=0;const char* data=lua_tolstring(state_,index,&length);if(!frame->stringScratch||frame->stringScratchUsed>frame->stringScratchCapacity||length>frame->stringScratchCapacity-frame->stringScratchUsed){fail(error,capacity,"handle result string scratch is exhausted");return false;}char* destination=frame->stringScratch+frame->stringScratchUsed;if(length)std::memcpy(destination,data,length);output->tag=ScriptValueTag::kString;output->data=destination;output->length=static_cast<uint32_t>(length);frame->stringScratchUsed+=static_cast<uint32_t>(length);return true; }
  if (codec.mask & kHash) { if (dmhash_t* hash=dmScript::ToHash(state_,index)) { output->tag=ScriptValueTag::kHandle;output->handleKind=ScriptHandleKind::kHash;output->payload=*hash;return true; } }
  if (codec.mask & kVector3) { if (auto* value=dmScript::ToVector3(state_,index)) { output->tag=ScriptValueTag::kDefoldValue;output->defoldKind=ScriptDefoldValueKind::kVector3;output->defoldValue[0]=value->getX();output->defoldValue[1]=value->getY();output->defoldValue[2]=value->getZ();return true; } }
  if (codec.mask & kVector4) { if (auto* value=dmScript::ToVector4(state_,index)) { output->tag=ScriptValueTag::kDefoldValue;output->defoldKind=ScriptDefoldValueKind::kVector4;output->defoldValue[0]=value->getX();output->defoldValue[1]=value->getY();output->defoldValue[2]=value->getZ();output->defoldValue[3]=value->getW();return true; } }
  if (codec.mask & kQuaternion) { if (auto* value=dmScript::ToQuat(state_,index)) { output->tag=ScriptValueTag::kDefoldValue;output->defoldKind=ScriptDefoldValueKind::kQuaternion;output->defoldValue[0]=value->getX();output->defoldValue[1]=value->getY();output->defoldValue[2]=value->getZ();output->defoldValue[3]=value->getW();return true; } }
  fail(error, capacity, "handle Lua result codec mismatch"); return false;
}

int CapturedLuaRouter::ProtectedCaptureCurrentInstance(lua_State* state) {
  auto* context = static_cast<InstanceContext*>(lua_touserdata(state, 1));
  context->router->instanceApi_.get(state);
  context->reference = luaL_ref(state, LUA_REGISTRYINDEX);
  context->ok = context->reference != LUA_NOREF && context->reference != LUA_REFNIL;
  return 0;
}

int CapturedLuaRouter::ProtectedRestoreCurrentInstance(lua_State* state) {
  auto* context = static_cast<InstanceContext*>(lua_touserdata(state, 1));
  lua_rawgeti(state, LUA_REGISTRYINDEX, context->reference);
  context->router->instanceApi_.set(state);
  luaL_unref(state, LUA_REGISTRYINDEX, context->reference);
  context->reference = LUA_NOREF;
  context->ok = true;
  return 0;
}

int CapturedLuaRouter::ProtectedDispatch(lua_State* state) {
  auto* context = static_cast<DispatchContext*>(lua_touserdata(state, 1));
  context->ok = context->router->dispatchUnsafe(*context);
  return 0;
}

bool CapturedLuaRouter::dispatchUnsafe(DispatchContext& context) {
  const Route& route = *context.route;
  ScriptCallFrame* frame = context.frame;
  if (!bind(route, context.error, context.errorCapacity)) return false;
  if (route.context == Context::kGameObjectInstance || route.context == Context::kGuiScene || route.context == Context::kRenderScriptAndGraphics) {
    lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
    instanceApi_.set(state_);
  }
  const int callBase = lua_gettop(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, functionRefs_[route.index]);
  for (uint8_t index = 0; index < frame->argumentCount; ++index) {
    if (!push(frame->arguments[index], kArguments[route.argumentOffset + index], frame,
        context.error, context.errorCapacity)) return false;
  }
  lua_call(state_, frame->argumentCount, LUA_MULTRET);
  const int actual = lua_gettop(state_) - callBase;
  if (actual != route.resultCount) { fail(context.error, context.errorCapacity, "handle Lua result count mismatch"); return false; }
  for (uint8_t index = 0; index < route.resultCount; ++index) {
    if (!read(callBase + 1 + index, kResults[route.resultOffset + index], &frame->results[index], frame,
        context.error, context.errorCapacity)) return false;
  }
  frame->resultCount = route.resultCount;
  return true;
}

bool CapturedLuaRouter::dispatch(ScriptCallFrame* frame, char* error, size_t capacity) noexcept {
  if (!frame) { fail(error,capacity,"handle call frame is null"); return false; } frame->resultCount=0;
  const Route* route=find(frame->stableId); if(!route) { fail(error,capacity,"handle route is missing");return false; }
  // Transport boundary for JS -> JSI -> C ABI -> Lua -> engine. The span covers
  // every crossing cost: argument codecs, the protected instance save/restore,
  // lua_call, and result codecs. It deliberately excludes the null-frame check
  // and the O(log n) route lookup above it, which precede the crossing.
  DEHERM_PROFILE_TRANSPORT_SCOPE(DEHERM_PROFILE_TRANSPORT_LUA_STACK, route->stableId,
      kRouteContractShapes[route->index], kRouteProfileNames[route->index]);
  if(!route->nativeAdapterHarness){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route is blocked in the native adapter harness");return false;}
  if(!activeProfile_||!routeAvailableInProfile(*route,*activeProfile_)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route is unavailable in the active runtime profile");return false;}
  if(frame->argumentCount<route->requiredArgumentCount||frame->argumentCount>route->argumentCount||(frame->argumentCount&&!frame->arguments)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle argument count mismatch");return false;}
  if(route->resultCount&&(!frame->results||frame->resultCapacity<route->resultCount)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle result storage is exhausted");return false;}
  if(!state_||!registry_){DEHERM_PROFILE_SCOPE_FAILED();return false;}
  const bool scoped=route->context==Context::kGameObjectInstance||route->context==Context::kGuiScene||route->context==Context::kRenderScriptAndGraphics;
  if(scoped&&(!instanceApi_.get||!instanceApi_.set||instanceRef_==LUA_NOREF||instanceRef_==LUA_REFNIL)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route requires a captured component script instance");return false;}
  const int top=lua_gettop(state_); const uint32_t stringMark=frame->stringScratchUsed; const uint32_t tableMark=frame->tableScratchUsed;
  InstanceContext instanceContext{this,LUA_NOREF,false}; bool ok=true;
  if(scoped){const int captureStatus=lua_cpcall(state_,ProtectedCaptureCurrentInstance,&instanceContext);if(captureStatus!=0){fail(error,capacity,lua_type(state_,-1)==LUA_TSTRING?lua_tostring(state_,-1):"capturing current Lua instance failed");ok=false;}lua_settop(state_,top);if(ok&&!instanceContext.ok){fail(error,capacity,"capturing current Lua instance failed");ok=false;}}
  DispatchContext dispatchContext{this,route,frame,error,capacity,false};
  if(ok){const int dispatchStatus=lua_cpcall(state_,ProtectedDispatch,&dispatchContext);if(dispatchStatus!=0){fail(error,capacity,lua_type(state_,-1)==LUA_TSTRING?lua_tostring(state_,-1):"protected handle dispatch failed");ok=false;}else ok=dispatchContext.ok;lua_settop(state_,top);}
  if(scoped&&instanceContext.reference!=LUA_NOREF&&instanceContext.reference!=LUA_REFNIL){instanceContext.ok=false;const int restoreStatus=lua_cpcall(state_,ProtectedRestoreCurrentInstance,&instanceContext);if(restoreStatus!=0||!instanceContext.ok){fail(error,capacity,lua_type(state_,-1)==LUA_TSTRING?lua_tostring(state_,-1):"restoring current Lua instance failed");ok=false;}lua_settop(state_,top);}
  lua_settop(state_,top);if(!ok){DEHERM_PROFILE_SCOPE_FAILED();frame->resultCount=0;frame->stringScratchUsed=stringMark;frame->tableScratchUsed=tableMark;}return ok;
}

}  // namespace defold_hermes::script_handle_lowering
`;
}

function renderTypescript(report) {
  const kinds = report.handleKinds.map(({ id }) => JSON.stringify(id)).join(" | ");
  const kindRows = report.handleKinds
    .map(
      ({ id, numericId, representation, ownership }) =>
        `  ${JSON.stringify(id)}: { numericId: ${numericId}, representation: ${JSON.stringify(representation)}, ownership: ${JSON.stringify(ownership)} },`,
    )
    .join("\n");
  const routes = report.routes
    .map(
      (route) =>
        `  ${JSON.stringify(route.id)}: { stableId: ${route.stableId}, operationClass: ${JSON.stringify(route.operationClass)}, operationEffect: ${JSON.stringify(route.operationEffect)}, context: ${JSON.stringify(route.context)}, invalidation: ${JSON.stringify(route.invalidation)}, inputKinds: ${JSON.stringify(route.inputKinds)}, returnKinds: ${JSON.stringify(route.returnKinds)}, ownership: ${JSON.stringify(route.ownership)}, lifetime: ${JSON.stringify(route.lifetime)}, profiles: ${JSON.stringify(route.profiles)}, targets: ${JSON.stringify(route.targets)} },`,
    )
    .join("\n");
  return `/** Generated semantic brands for identity-bearing Defold script values. */
export type SemanticHandleKind = ${kinds};

declare const semanticHandleBrand: unique symbol;

/** A generation-checked Lua registry root. Disposing it never destroys the engine object. */
export interface DefoldHandle<K extends SemanticHandleKind> {
  readonly runtime: number;
  readonly slot: number;
  readonly generation: number;
  readonly kind: K;
  readonly [semanticHandleBrand]: K;
  dispose(): void;
}

export const handleKinds = {
${kindRows}
} as const;

export const handleLoweringRoutes = {
${routes}
} as const;

export const handleLoweringCoverage = ${JSON.stringify(report.coverage)} as const;

/** Source-file convention for generated Defold attachment/context providers. */
export const attachmentProviders = ${JSON.stringify(report.attachmentProviders, null, 2)} as const;
`;
}

export function renderScriptHandleLoweringArtifacts(report) {
  return {
    kindHeader: renderKindHeader(report),
    header: renderHeader(report),
    source: renderSource(report),
    typescript: renderTypescript(report),
  };
}
