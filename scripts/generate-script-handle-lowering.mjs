import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { semanticHandleKinds } from "./lib/semantic-handle-kinds.mjs";
import { expectReviewedCount } from "./lib/reviewed-revision.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export const inputPaths = Object.freeze({
  policy: "packages/bindings/overrides/script-handle-lowering-policy.json",
  projection: "packages/bindings/generated/defold-script-projection-ir.json",
  classification: "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  availability: "packages/bindings/generated/defold-script-route-availability-profiles.json"
});

export const outputPaths = Object.freeze({
  report: "packages/bindings/generated/defold-script-handle-lowering.json",
  kindHeader: "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp",
  header: "defold/defold_hermes/include/defold_hermes/generated_script_handle_lowering.hpp",
  source: "defold/defold_hermes/src/generated_script_handle_lowering.cpp",
  typescript: "packages/sdk/src/generated/script/handle-lowering.ts"
});

const codecBits = Object.freeze({
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
  handle: 1024
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function indexRows(rows, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!row?.id) throw new Error(`${label} contains a row without an id`);
    if (result.has(row.id)) throw new Error(`${label} contains duplicate route ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

function countBy(rows, select) {
  const counts = {};
  for (const row of rows) {
    const key = select(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareCodeUnits(left, right)));
}

// A reviewed count map. Fatal in an ordinary generation, reported in a declared
// derivation of another revision - see `expectReviewedCount`, which this defers
// to per key so the report names WHICH bucket moved rather than dumping two
// objects.
function compareCounts(actual, expected, label) {
  const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => compareCodeUnits(a, b)));
  if (JSON.stringify(actual) === JSON.stringify(sorted)) return;
  for (const key of [...new Set([...Object.keys(sorted), ...Object.keys(actual)])].sort(compareCodeUnits)) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-handle-lowering-policy.json", label: `${label}:${key}`,
      expected: sorted[key] ?? 0, observed: actual[key] ?? 0
    });
  }
}

function walkShape(shape, visit) {
  visit(shape);
  if (shape.kind === "optional") walkShape(shape.value, visit);
  else if (shape.kind === "union") shape.variants.forEach((variant) => walkShape(variant, visit));
  else if (shape.kind === "sequence") walkShape(shape.element, visit);
  else if (shape.kind === "map") {
    walkShape(shape.key, visit);
    walkShape(shape.value, visit);
  } else if (shape.kind === "record") shape.fields.forEach(({ value }) => walkShape(value, visit));
  else if (shape.kind === "callback") {
    for (const parameter of shape.parameters ?? []) walkShape(parameter.value, visit);
    for (const result of shape.returns ?? []) walkShape(result, visit);
  } else if (shape.kind === "variadic") walkShape(shape.value, visit);
}

function exactShapeMask(shape, semanticKind) {
  if (shape.kind === "optional") return codecBits.nil | exactShapeMask(shape.value, semanticKind);
  if (shape.kind === "union") return shape.variants.reduce((mask, variant) => {
    const identityVariant = variant.kind === "handle" || (variant.kind === "defold-value" &&
      ["node", "buffer_data", "buffer_stream", "constant_buffer", "render_target", "texture"].includes(variant.name));
    return mask | exactShapeMask(variant, identityVariant ? semanticKind : null);
  }, 0);
  if (semanticKind) return codecBits.handle;
  if (shape.kind === "enum") return codecBits.integer;
  if (shape.kind === "handle") return codecBits.handle;
  if (shape.kind === "scalar") {
    if (codecBits[shape.name] !== undefined) return codecBits[shape.name];
  }
  if (shape.kind === "defold-value") {
    const aliases = { "gui.PROP": "hash", node: "handle", buffer_data: "handle", buffer_stream: "handle", constant_buffer: "handle", render_target: "handle", texture: "handle" };
    const name = aliases[shape.name] ?? shape.name;
    if (codecBits[name] !== undefined) return codecBits[name];
  }
  throw new Error(`unsupported exact handle codec ${JSON.stringify(shape)}`);
}

function shapeKinds(shape) {
  const result = new Set();
  walkShape(shape, ({ kind }) => result.add(kind));
  return result;
}

function algebraicallySelected(row, classification, policy) {
  const selection = policy.selection;
  if (row.loweringFamily !== selection.loweringFamily) return false;
  if (!classification || selection.excludedOperationClasses.includes(classification.operationClass)) return false;
  if (row.signature.parameters.length > selection.maximumArguments || row.signature.returns.length > selection.maximumResults) return false;
  if (selection.requiresFixedArity && row.effects.variadic.token !== "fixed-arity") return false;
  if (selection.requiresAcyclicValues && row.effects.recursive.token !== "acyclic-value-shape") return false;
  const allowed = new Set(selection.allowedValueConstructors);
  return [...row.signature.parameters, ...row.signature.returns]
    .every(({ value }) => [...shapeKinds(value)].every((kind) => allowed.has(kind)));
}

function rawTypeTokens(rawType) {
  return String(rawType).match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
}

function semanticKindsForValue(value, rawType, rawTypeToKind) {
  const kinds = new Set();
  for (const token of rawTypeTokens(rawType)) {
    const kind = rawTypeToKind.get(token);
    if (kind) kinds.add(kind);
  }
  if (kinds.size > 1) throw new Error(`value ${rawType} maps to multiple semantic handle kinds: ${[...kinds].join(", ")}`);
  const [semanticKind = null] = kinds;
  const mask = exactShapeMask(value, semanticKind);
  return { mask, semanticKind };
}

function targetDisposition(row, target, policy) {
  if (row.availability.runtimeAvailable === false) return "profile-symbol-unavailable";
  const contextPolicy = policy.contexts[row.context.token];
  if (!contextPolicy) throw new Error(`unreviewed handle context ${row.context.token}`);
  if (contextPolicy.startsWith("blocked-")) return contextPolicy.slice("blocked-".length);
  return policy.targetBackends[target];
}

function pascal(value) {
  const result = String(value).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  return /^\d/.test(result) ? `N${result}` : result;
}

function cppString(value) {
  return JSON.stringify(String(value));
}

// Telemetry contract shapes. Cost has to be attributable per contract, not only
// per route, so every route interns the exact codec signature it crosses with.
// The token is derived from the same generated codecs the transport uses, so it
// cannot drift from the call it describes.
const codecBitNames = Object.freeze(Object.entries(codecBits)
  .sort(([, left], [, right]) => left - right)
  .map(([name, bit]) => [bit, name]));

function codecShapeToken(codec) {
  if (codec.semanticKind) return `handle:${codec.semanticKind}`;
  const names = codecBitNames.filter(([bit]) => (codec.mask & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join("|") : "none";
}

function contractShapeToken(arguments_, results) {
  const left = arguments_.map(codecShapeToken).join(",");
  const right = results.map(codecShapeToken).join(",");
  return `(${left})->(${right})`;
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
  kNil = ${codecBits.nil}, kBoolean = ${codecBits.boolean}, kInteger = ${codecBits.integer},
  kNumber = ${codecBits.number}, kString = ${codecBits.string}, kHash = ${codecBits.hash},
  kUrl = ${codecBits.url}, kVector3 = ${codecBits.vector3}, kVector4 = ${codecBits.vector4},
  kQuaternion = ${codecBits.quaternion}, kHandle = ${codecBits.handle}
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
  uint16_t mismatches[${report.runtimeProfiles.length}];
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
  "checked-child-engine-object-invalidate": "OperationClass::kChildInvalidator"
});

const contextCpp = Object.freeze({
  "explicit-physics-handle": "Context::kExplicitPhysicsHandle",
  "runtime-global": "Context::kRuntimeGlobal",
  "game-object-instance": "Context::kGameObjectInstance",
  "gui-scene": "Context::kGuiScene",
  "render-script-instance-and-graphics-context": "Context::kRenderScriptAndGraphics"
});

const dispositionCpp = Object.freeze({
  "captured-lua-router-harness-proven-jsi-unverified": "Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified",
  "static-ffi-unimplemented": "Disposition::kStaticFfiUnimplemented",
  "browser-host-unimplemented": "Disposition::kBrowserHostUnimplemented",
  "gui-script-attachment-unavailable": "Disposition::kGuiScriptAttachmentUnavailable",
  "render-script-attachment-unavailable": "Disposition::kRenderScriptAttachmentUnavailable",
  "profile-symbol-unavailable": "Disposition::kProfileSymbolUnavailable"
});

function renderSource(report) {
  const kinds = report.handleKinds.map((kind) =>
    `  {SemanticHandleKind::k${kind.enumName}, ${cppString(kind.id)}, ${cppString(kind.representation)}, ${cppString(kind.ownership)}, ${kind.capturableProfileMask}},`).join("\n");
  const arguments_ = report.argumentCodecs.map((codec) =>
    `  {${codec.mask}, SemanticHandleKind::k${codec.semanticKind ? report.kindById[codec.semanticKind].enumName : "None"}},`).join("\n");
  const results = report.resultCodecs.map((codec) =>
    `  {${codec.mask}, SemanticHandleKind::k${codec.semanticKind ? report.kindById[codec.semanticKind].enumName : "None"}},`).join("\n");
  const routes = report.routes.map((route) => `  {${route.index}, ${route.stableId}u, ${cppString(route.id)}, ${cppString(route.modulePath.join("."))}, ${cppString(route.member)}, ${operationCpp[route.operationClass]}, ${contextCpp[route.context]}, Invalidation::k${pascal(route.invalidation)}, ${cppString(route.ownership.projectionToken)}, ${cppString(route.lifetime.projectionToken)}, ${cppString(route.profiles.token)}, ${route.profiles.runtimeAvailable}, ${route.profiles.runtimeMask}, ${dispositionCpp[route.targets.nativeDynamicHermes]}, ${dispositionCpp[route.targets.nativeStaticHermes]}, ${dispositionCpp[route.targets.html5BrowserHost]}, ${route.argumentOffset}, ${route.resultOffset}, ${route.argumentCount}, ${route.resultCount}},`).join("\n");
  const runtimeProfiles = report.runtimeProfiles.map((profile) =>
    `  {${profile.index}, ${profile.mask}, ${profile.capabilityBits}u, ${profile.sourceRouteCount}u, ${profile.adapterExecutableRouteCount}, ${cppString(profile.id)}, ${cppString(profile.schema)}, ${cppString(profile.defoldRevision)}, ${cppString(profile.routeSetSha256)}, ${cppString(profile.catalogSha256)}},`).join("\n");
  const stableOrder = [...report.routes].sort((left, right) => left.stableId - right.stableId).map(({ index }) => index);
  const profileShapes = report.routes.map((route) => `  ${route.contractShapeIndex},`).join("\n");
  const profileNames = report.routes.map((route) =>
    `  ${cppString(`deherm.lua-stack.${route.modulePath.join(".")}.${route.member}`)},`).join("\n");
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
      if (value.handleKind == ScriptHandleKind::kLuaSemanticHandle) return kHandle;
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
    if (route.nativeDynamicHermes != Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified) continue;
    const bool present = rawFunctionPresent(state, route);
    if (present) ++output.observedPresent;
    for (uint8_t profileIndex = 0; profileIndex < kRuntimeProfileCount; ++profileIndex) {
      const bool expected = (route.runtimeProfileMask & kRuntimeProfiles[profileIndex].mask) != 0;
      if (present != expected) ++output.mismatches[profileIndex];
    }
  }
  uint8_t matches = 0;
  const RuntimeProfile* match = nullptr;
  for (uint8_t index = 0; index < kRuntimeProfileCount; ++index) {
    if (output.mismatches[index] != 0) continue;
    output.matchingProfileMask = static_cast<uint8_t>(output.matchingProfileMask | kRuntimeProfiles[index].mask);
    match = &kRuntimeProfiles[index];
    ++matches;
  }
  if (matches == 1) {
    output.profile = match;
    output.status = RuntimeProfileDetectionStatus::kMatched;
  } else {
    output.status = matches == 0 ? RuntimeProfileDetectionStatus::kNoMatch : RuntimeProfileDetectionStatus::kAmbiguous;
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
    const RuntimeProfile& activeProfile, lua_bridge::scalar::InstanceApi instanceApi) noexcept
    : state_(state), registry_(&registry), activeProfile_(&activeProfile), instanceApi_(instanceApi) {
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

bool CapturedLuaRouter::dispatchUnsafe(DispatchContext& context) noexcept {
  const Route& route = *context.route;
  ScriptCallFrame* frame = context.frame;
  if (!bind(route, context.error, context.errorCapacity)) return false;
  if (route.context == Context::kGameObjectInstance) {
    lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
    instanceApi_.set(state_);
  }
  const int callBase = lua_gettop(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, functionRefs_[route.index]);
  for (uint8_t index = 0; index < route.argumentCount; ++index) {
    if (!push(frame->arguments[index], kArguments[route.argumentOffset + index], frame,
        context.error, context.errorCapacity)) return false;
  }
  lua_call(state_, route.argumentCount, LUA_MULTRET);
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
  if(route->nativeDynamicHermes!=Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route is blocked for this context");return false;}
  if(!activeProfile_||!routeAvailableInProfile(*route,*activeProfile_)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route is unavailable in the active runtime profile");return false;}
  if(frame->argumentCount!=route->argumentCount||(frame->argumentCount&&!frame->arguments)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle argument count mismatch");return false;}
  if(route->resultCount&&(!frame->results||frame->resultCapacity<route->resultCount)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle result storage is exhausted");return false;}
  if(!state_||!registry_){DEHERM_PROFILE_SCOPE_FAILED();return false;}
  const bool scoped=route->context==Context::kGameObjectInstance;
  if(scoped&&(!instanceApi_.get||!instanceApi_.set||instanceRef_==LUA_NOREF||instanceRef_==LUA_REFNIL)){DEHERM_PROFILE_SCOPE_FAILED();fail(error,capacity,"handle route requires a captured game-object instance");return false;}
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
  const kindRows = report.handleKinds.map(({ id, numericId, representation, ownership }) =>
    `  ${JSON.stringify(id)}: { numericId: ${numericId}, representation: ${JSON.stringify(representation)}, ownership: ${JSON.stringify(ownership)} },`).join("\n");
  const routes = report.routes.map((route) => `  ${JSON.stringify(route.id)}: { stableId: ${route.stableId}, operationClass: ${JSON.stringify(route.operationClass)}, operationEffect: ${JSON.stringify(route.operationEffect)}, context: ${JSON.stringify(route.context)}, invalidation: ${JSON.stringify(route.invalidation)}, inputKinds: ${JSON.stringify(route.inputKinds)}, returnKinds: ${JSON.stringify(route.returnKinds)}, ownership: ${JSON.stringify(route.ownership)}, lifetime: ${JSON.stringify(route.lifetime)}, profiles: ${JSON.stringify(route.profiles)}, targets: ${JSON.stringify(route.targets)} },`).join("\n");
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

export function generateScriptHandleLowering(textInputs) {
  const parsed = Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, parseJson(text, name)]));
  const { policy, projection, classification, availability } = parsed;
  if (projection.defoldRevision !== classification.defoldRevision || projection.defoldRevision !== availability.defoldRevision) {
    throw new Error("handle lowering inputs do not share one pinned Defold revision");
  }
  for (const row of projection.rows) {
    if (row.availability.catalogSha256 && row.availability.catalogSha256 !== availability.catalogSha256) {
      throw new Error(`${row.id} references a stale availability catalog`);
    }
  }
  const classificationById = indexRows(classification.rows, "borrowed-handle classification");
  const selected = projection.rows
    .filter((row) => algebraicallySelected(row, classificationById.get(row.id), policy))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-handle-lowering-policy.json", label: "algebraic handle route census",
    expected: policy.selection.expectedRouteCount, observed: selected.length
  });

  const handleKinds = semanticHandleKinds(classification)
    .map((kind) => ({ ...kind, enumName: pascal(kind.id) }));
  const kindById = Object.fromEntries(handleKinds.map((kind) => [kind.id, kind]));
  const rawTypeToKind = new Map();
  for (const kind of handleKinds) for (const rawType of kind.rawTypes) {
    if (rawTypeToKind.has(rawType)) throw new Error(`semantic handle raw type ${rawType} is ambiguous`);
    rawTypeToKind.set(rawType, kind.id);
  }

  const runtimeProfiles = Object.entries(availability.profiles ?? {})
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([id, profile], index) => {
      const handshake = profile.runtimeHandshake;
      const sourceRouteSetSha256 = sha256(JSON.stringify((profile.availableRoutes ?? []).map(({ stableId }) => stableId)));
      if (!handshake || handshake.profileId !== id || handshake.schema !== availability.handshakeContract?.schema ||
          handshake.defoldRevision !== projection.defoldRevision || handshake.catalogSha256 !== availability.catalogSha256 ||
          handshake.routeCount !== profile.availableRouteCount || handshake.routeSetSha256 !== sourceRouteSetSha256) {
        throw new Error(`runtime profile ${id} has a stale or incomplete capability handshake`);
      }
      if (index >= 8) throw new Error("handle router supports at most eight runtime profiles");
      return {
        index,
        mask: 1 << index,
        id,
        schema: handshake.schema,
        defoldRevision: handshake.defoldRevision,
        capabilityBits: handshake.capabilityBits,
        sourceRouteCount: handshake.routeCount,
        routeSetSha256: handshake.routeSetSha256,
        catalogSha256: handshake.catalogSha256,
        adapterExecutableRouteCount: 0
      };
    });
  if (runtimeProfiles.length !== 6) throw new Error(`expected six pinned runtime profiles, got ${runtimeProfiles.length}`);
  const runtimeProfileById = new Map(runtimeProfiles.map((profile) => [profile.id, profile]));
  const availableRouteIdsByProfile = new Map(Object.entries(availability.profiles).map(([id, profile]) => [
    id,
    new Set((profile.availableRoutes ?? []).map(({ id: routeId }) => routeId))
  ]));

  // Which runtime profiles root a handle kind as a generation-checked
  // identity. A kind whose representation is the same in every backend is
  // capturable everywhere; one the classification scopes per feature -
  // `box2d-world`, which Box2D v2 pushes as a light userdata - is capturable
  // only in the profiles that select a feature implementing it as a rooted
  // userdata. Without this the router discovers the difference at the Lua
  // stack, and can only describe it as the shape of the value it found.
  for (const kind of handleKinds) {
    if (!kind.representationIsFeatureScoped) {
      kind.capturableProfiles = runtimeProfiles.map(({ id }) => id);
      kind.capturableProfileMask = runtimeProfiles.reduce((mask, { mask: bit }) => mask | bit, 0);
      continue;
    }
    const capturable = new Set(kind.capturableFeatures ?? []);
    const uncapturable = new Set(kind.uncapturableFeatures ?? []);
    const profiles = runtimeProfiles.filter(({ id }) => {
      const features = availability.profiles[id]?.features ?? [];
      return features.some((feature) => capturable.has(feature)) &&
        !features.some((feature) => uncapturable.has(feature));
    });
    kind.capturableProfiles = profiles.map(({ id }) => id);
    kind.capturableProfileMask = profiles.reduce((mask, { mask: bit }) => mask | bit, 0);
  }

  const argumentCodecs = [];
  const resultCodecs = [];
  const routes = selected.map((row, index) => {
    const classified = classificationById.get(row.id);
    const argumentOffset = argumentCodecs.length;
    const arguments_ = row.signature.parameters.map(({ value, sourceType }) => semanticKindsForValue(value, sourceType, rawTypeToKind));
    const results = row.signature.returns.map(({ value, sourceType }) => semanticKindsForValue(value, sourceType, rawTypeToKind));
    argumentCodecs.push(...arguments_);
    resultCodecs.push(...results);
    const discoveredInputKinds = [...new Set(arguments_.map(({ semanticKind }) => semanticKind).filter(Boolean))].sort();
    const discoveredReturnKinds = [...new Set(results.map(({ semanticKind }) => semanticKind).filter(Boolean))].sort();
    if (JSON.stringify(discoveredInputKinds) !== JSON.stringify([...classified.inputHandleKinds].sort())) {
      throw new Error(`${row.id} input semantic handle kinds drifted`);
    }
    if (JSON.stringify(discoveredReturnKinds) !== JSON.stringify([...classified.returnHandleKinds].sort())) {
      throw new Error(`${row.id} return semantic handle kinds drifted`);
    }
    const expectedInvalidation = {
      "checked-handle-input-terminal": null,
      "checked-handle-return-capture": null,
      "checked-self-engine-object-invalidate": "self-underlying",
      "checked-child-engine-object-invalidate": "child-index"
    }[classified.operationClass];
    if (expectedInvalidation === undefined || (classified.invalidatedIdentity ?? null) !== expectedInvalidation) {
      throw new Error(`${row.id} operation-class invalidation semantics drifted`);
    }
    if (expectedInvalidation && classified.hostHandleEffect !== "preserve") {
      throw new Error(`${row.id} invalidator must preserve the host wrapper`);
    }
    const targets = {
      nativeDynamicHermes: targetDisposition(row, "nativeDynamicHermes", policy),
      nativeStaticHermes: targetDisposition(row, "nativeStaticHermes", policy),
      html5BrowserHost: targetDisposition(row, "html5BrowserHost", policy)
    };
    const blocked = targets.nativeDynamicHermes.endsWith("unavailable");
    const runtimeProfileIds = [...(row.availability.runtimeProfiles ?? [])].sort();
    let runtimeMask = 0;
    for (const profileId of runtimeProfileIds) {
      const profile = runtimeProfileById.get(profileId);
      if (!profile) throw new Error(`${row.id} references unknown runtime profile ${profileId}`);
      if (!availableRouteIdsByProfile.get(profileId)?.has(row.id)) {
        throw new Error(`${row.id} runtime profile ${profileId} disagrees with the source-derived route set`);
      }
      runtimeMask |= profile.mask;
    }
    for (const profile of runtimeProfiles) {
      const catalogAvailable = availableRouteIdsByProfile.get(profile.id)?.has(row.id) === true;
      if (catalogAvailable !== runtimeProfileIds.includes(profile.id)) {
        throw new Error(`${row.id} source-derived runtime profile membership drifted for ${profile.id}`);
      }
    }
    return {
      index,
      id: row.id,
      stableId: row.stableId,
      contractShape: contractShapeToken(arguments_, results),
      modulePath: row.modulePath,
      member: row.member,
      operationClass: classified.operationClass,
      context: classified.requiredContext,
      inputKinds: discoveredInputKinds,
      returnKinds: discoveredReturnKinds,
      hostHandleEffect: classified.hostHandleEffect,
      operationEffect: policy.operationClasses[classified.operationClass],
      invalidation: classified.invalidatedIdentity ?? "none",
      ownership: {
        projectionToken: row.effects.ownership.token,
        hostWrapper: "generation-checked-lua-registry-root",
        underlying: "semantic-handle-kind-policy"
      },
      lifetime: {
        projectionToken: row.effects.lifetime.token,
        loweringToken: "semantic-handle-kind-policy"
      },
      callback: row.effects.callback,
      variadic: row.effects.variadic,
      recursive: row.effects.recursive,
      profiles: {
        token: row.availability.token,
        catalogSha256: row.availability.catalogSha256 ?? null,
        documentedFeatures: row.availability.documentedFeatures ?? row.availability.allOf ?? [],
        runtimeFeatures: row.availability.runtimeFeatures ?? row.availability.allOf ?? [],
        documented: row.availability.documentedProfiles ?? [],
        runtime: runtimeProfileIds,
        runtimeAvailable: row.availability.runtimeAvailable !== false,
        runtimeMask
      },
      argumentOffset,
      argumentCount: arguments_.length,
      resultOffset: resultCodecs.length - results.length,
      resultCount: results.length,
      targets,
      generation: {
        descriptor: "emitted",
        router: blocked ? "blocked" : "emitted"
      },
      evidence: {
        nativeAdapterHarness: blocked ? "blocked-disposition-covered" : "covered-by-all-route-descriptor-loop",
        defoldEngineBehavior: "unverified",
        nativeDynamicHermesJsi: "unverified",
        nativeStaticHermes: "unverified",
        html5BrowserHost: "unverified",
        allocationPerRoute: "unverified"
      }
    };
  });

  const contractShapes = [...new Set(routes.map(({ contractShape }) => contractShape))]
    .sort(compareCodeUnits);
  const contractShapeIndexByToken = new Map(contractShapes.map((token, index) => [token, index]));
  for (const route of routes) route.contractShapeIndex = contractShapeIndexByToken.get(route.contractShape);
  if (contractShapes.length > 0xFFFF) throw new Error("telemetry contract shape ids exceed the packed field");

  const operationClassCounts = countBy(routes, ({ operationClass }) => operationClass);
  const contextCounts = countBy(routes, ({ context }) => context);
  compareCounts(operationClassCounts, policy.expected.operationClassCounts, "handle operation classes");
  compareCounts(contextCounts, policy.expected.contextCounts, "handle contexts");
  const blocked = routes.filter(({ generation }) => generation.router === "blocked").length;
  const routerCandidates = routes.length - blocked;
  const runtimeUnavailable = routes.filter(({ profiles }) => !profiles.runtimeAvailable).length;
  for (const [label, expected, observed] of [
    ["handle lowering blocked", policy.expected.blockedCount, blocked],
    ["handle lowering router candidates", policy.expected.routerCandidateCount, routerCandidates],
    ["handle lowering runtime-unavailable", policy.expected.runtimeUnavailableCount, runtimeUnavailable]
  ]) expectReviewedCount({ input: "packages/bindings/overrides/script-handle-lowering-policy.json", label, expected, observed });
  for (const profile of runtimeProfiles) {
    profile.adapterExecutableRouteCount = routes.filter((route) =>
      route.generation.router === "emitted" && (route.profiles.runtimeMask & profile.mask) !== 0).length;
    const surface = routes
      .filter((route) => route.generation.router === "emitted")
      .map((route) => (route.profiles.runtimeMask & profile.mask) !== 0 ? "1" : "0")
      .join("");
    profile.adapterSurfaceSha256 = sha256(surface);
  }
  const executableSymbols = routes
    .filter((route) => route.generation.router === "emitted")
    .map((route) => `${route.modulePath.join(".")}.${route.member}`);
  if (new Set(executableSymbols).size !== executableSymbols.length) {
    throw new Error("runtime profile detection requires unique executable Lua symbols");
  }
  if (new Set(runtimeProfiles.map(({ adapterSurfaceSha256 }) => adapterSurfaceSha256)).size !== runtimeProfiles.length) {
    throw new Error("runtime profile Lua availability fingerprints are ambiguous");
  }

  const report = {
    schemaVersion: 2,
    defoldRevision: projection.defoldRevision,
    scope: "Algebra-selected borrowed-handle captured-Lua router. Generated dispositions describe code paths; per-route evidence remains separate and no Defold-engine semantic behavior is inferred from adapter tests.",
    selection: policy.selection,
    inputEvidence: {
      paths: inputPaths,
      hashes: Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, sha256(text)])),
      availabilityCatalogSha256: availability.catalogSha256
    },
    coverage: {
      selectedRoutes: routes.length,
      descriptorRowsEmitted: routes.length,
      routerCandidates,
      blocked,
      adapterExecutableRoutes: routerCandidates,
      nativeAdapterHarnessRoutes: routerCandidates,
      defoldEngineVerifiedRoutes: 0,
      nativeDynamicHermesJsiVerifiedRoutes: 0,
      nativeStaticHermesExecutableRoutes: 0,
      html5BrowserExecutableRoutes: 0,
      runtimeUnavailable,
      adapterExecutableRoutesByProfile: Object.fromEntries(runtimeProfiles.map((profile) => [profile.id, profile.adapterExecutableRouteCount]))
    },
    operationClassCounts,
    contextCounts,
    attachmentProviders: {
      "*.ts": { proxyExtension: null, context: "runtime-global", state: "context-free" },
      "*.script.ts": { proxyExtension: ".script", context: "game-object-instance", state: "generated-proxy-provider" },
      "*.gui.ts": { proxyExtension: ".gui_script", context: "gui-scene", state: "provider-required-unimplemented" },
      "*.render.ts": { proxyExtension: ".render_script", context: "render-script-instance-and-graphics-context", state: "provider-required-unimplemented" }
    },
    runtimeProfileDetection: {
      authority: "generated-lua-registration-surface",
      strategy: "exact-function-presence-vector",
      routeCount: routerCandidates,
      lookup: "protected-raw-table-traversal-no-metamethods",
      initialization: "lazy-first-bootstrap-attach",
      nativeLuaHarness: "six-exact-profiles-and-negative-vectors-covered",
      packagedDefoldEngine: "unverified",
      nativeDynamicHermesJsi: "unverified",
      nativeStaticHermes: "unverified",
      html5BrowserHost: "unverified"
    },
    operationEffects: policy.operationClasses,
    handleKindCount: handleKinds.length,
    handleKinds,
    kindById,
    contractShapeCount: contractShapes.length,
    contractShapes,
    argumentCodecCount: argumentCodecs.length,
    resultCodecCount: resultCodecs.length,
    argumentCodecs,
    resultCodecs,
    runtimeProfiles,
    routes
  };
  report.semanticPolicyHoles = {
    projectionLifetimePolicyUnresolved: routes.filter(({ lifetime }) => lifetime.projectionToken.endsWith("-unresolved")).length,
    executableAdapterUnimplemented: 0,
    guiAttachmentUnavailable: routes.filter(({ context }) => context === "gui-scene").length,
    renderAttachmentUnavailable: routes.filter(({ context }) => context === "render-script-instance-and-graphics-context").length,
    profileSymbolUnavailable: runtimeUnavailable
  };
  report.generated = {
    report: `${JSON.stringify({ routeCount: routes.length, hash: sha256(JSON.stringify(routes)) })}`,
    artifacts: Object.values(outputPaths)
  };
  return report;
}

export async function loadInputs(root = repositoryRoot) {
  return Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([name, path]) => [
    name,
    await readFile(resolve(root, path), "utf8")
  ])));
}

export function renderArtifacts(report) {
  const jsonReport = structuredClone(report);
  delete jsonReport.kindById;
  return {
    report: `${JSON.stringify(jsonReport, null, 2)}\n`,
    kindHeader: renderKindHeader(report),
    header: renderHeader(report),
    source: renderSource(report),
    typescript: renderTypescript(report)
  };
}

export async function run(argv = process.argv.slice(2), root = repositoryRoot) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const report = generateScriptHandleLowering(await loadInputs(root));
  const artifacts = renderArtifacts(report);
  for (const [name, content] of Object.entries(artifacts)) {
    const path = resolve(root, outputPaths[name]);
    if (check) {
      if (await readFile(path, "utf8") !== content) throw new Error(`${outputPaths[name]} is stale`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  process.stdout.write(`${check ? "Verified" : "Generated"} ${report.coverage.descriptorRowsEmitted} handle descriptors: ${report.coverage.adapterExecutableRoutes} adapter-executable/harness-covered, ${report.coverage.blocked} blocked; JSI/engine/Static/browser runtime evidence remains unverified.\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
