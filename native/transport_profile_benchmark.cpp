// Transport benchmark for the generated binding boundaries.
//
// Answers one question with a measured number: what does the Lua bridge add
// over calling the same Lua function directly?
//
// It compares, per contract shape, the same route across:
//   raw-lua           lua_rawgeti(fn) + pushes + lua_call + result reads
//   raw-lua-protected the same call wrapped in lua_cpcall, isolating protection
//   lua-stack         CapturedLuaRouter::dispatch, the real generated transport
//   c-abi-native      deherm_dmsdk_borrowed_dispatch over a stub provider
//   typed-native      deherm_script_universal_dispatch over a stub backend
//
// The Lua target is the same mock C function in every Lua variant, so the
// difference between raw-lua and lua-stack is exactly the generated bridge.
//
// Builds and runs with DEHERM_PROFILE both off and on. With it on it also
// drains the telemetry ring and reports per-transport and per-contract-shape
// aggregates, which is the machine-readable path a headless-engine harness
// consumes. Running the same binary both ways measures the instrumentation
// cost itself.

#include <defold_hermes/deherm_profile.hpp>
#include <defold_hermes/generated_dmsdk_borrowed_handle.h>
#include <defold_hermes/generated_script_handle_lowering.hpp>
#include <defold_hermes/generated_script_universal_value_bindings.hpp>
#include <defold_hermes/generated_script_universal_value_capi.h>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace handle = defold_hermes::script_handle_lowering;
namespace scalar = defold_hermes::lua_bridge::scalar;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptUrlArena;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

// Defold value shims, declared here because the generated bridge and the Lua
// fixture both call them. Defined at the bottom of this file.
namespace dmScript {
void PushHash(lua_State*, dmhash_t);
void PushVector3(lua_State*, const dmVMath::Vector3&);
void PushVector4(lua_State*, const dmVMath::Vector4&);
void PushQuat(lua_State*, const dmVMath::Quat&);
}  // namespace dmScript

namespace {

constexpr size_t kWarmup = 20000;
constexpr size_t kIterations = 100000;
constexpr size_t kRepeats = 9;
constexpr size_t kMaxSampledShapes = 6;
// Typed-native shape sweep bound. Covers every arity the Lua-bridge table reports.
constexpr uint32_t kTypedNativeMaxArguments = 4;
#if DEHERM_PROFILE_ENABLED
// Sized so every sampled route and transport fits in one ring without drops.
constexpr size_t kRingSampleCalls = 200;
#endif

[[noreturn]] void die(const char* message) {
  std::fprintf(stderr, "transport-profile-benchmark:error:%s\n", message);
  std::exit(1);
}
void expect(bool condition, const char* message) { if (!condition) die(message); }

// ---------------------------------------------------------------------------
// Lua fixture. Mirrors native/script_handle_router_test.cpp so the Lua target
// is identical across every transport measured here.
// ---------------------------------------------------------------------------

int gInstanceKey = 0;
uint64_t gLuaCalls = 0;
uint64_t gScalarLuaCalls = 0;

void GetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_rawget(state, LUA_REGISTRYINDEX);
}
void SetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_insert(state, -2);
  lua_rawset(state, LUA_REGISTRYINDEX);
}

void ensureModule(lua_State* state, const char* path) {
  const char* segment = path;
  const char* dot = std::strchr(segment, '.');
  const size_t firstLength = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
  char first[64]{};
  expect(firstLength < sizeof(first), "module segment too long");
  std::memcpy(first, segment, firstLength);
  lua_getglobal(state, first);
  if (!lua_istable(state, -1)) {
    lua_pop(state, 1);
    lua_newtable(state);
    lua_pushvalue(state, -1);
    lua_setglobal(state, first);
  }
  while (dot) {
    segment = dot + 1;
    dot = std::strchr(segment, '.');
    const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    char name[64]{};
    expect(length < sizeof(name), "nested module segment too long");
    std::memcpy(name, segment, length);
    lua_getfield(state, -1, name);
    if (!lua_istable(state, -1)) {
      lua_pop(state, 1);
      lua_newtable(state);
      lua_pushvalue(state, -1);
      lua_setfield(state, -3, name);
    }
    lua_remove(state, -2);
  }
}

int MockRoute(lua_State* state) {
  const auto& route = handle::routes()[static_cast<size_t>(lua_tointeger(state, lua_upvalueindex(1)))];
  ++gLuaCalls;
  if (!route.resultCount) return 0;
  const auto& codec = handle::resultCodecs()[route.resultOffset];
  if (codec.semanticKind != handle::SemanticHandleKind::kNone) { lua_newuserdata(state, 16); return 1; }
  if (codec.mask & handle::kBoolean) lua_pushboolean(state, 1);
  else if (codec.mask & (handle::kInteger | handle::kNumber)) lua_pushnumber(state, 7);
  else if (codec.mask & handle::kString) lua_pushliteral(state, "handle-result");
  else if (codec.mask & handle::kHash) dmScript::PushHash(state, UINT64_C(0x123456789abcdef0));
  else if (codec.mask & handle::kVector3) dmScript::PushVector3(state, dmVMath::Vector3(1, 2, 3));
  else if (codec.mask & handle::kVector4) dmScript::PushVector4(state, dmVMath::Vector4(1, 2, 3, 4));
  else if (codec.mask & handle::kQuaternion) dmScript::PushQuat(state, dmVMath::Quat(0, 0, 0, 1));
  else return luaL_error(state, "no mock result codec");
  return 1;
}

int MockScalarSetViewport(lua_State* state) {
  for (int index = 1; index <= 4; ++index) (void)luaL_checknumber(state, index);
  ++gScalarLuaCalls;
  return 0;
}

void installScalarRoute(lua_State* state) {
  ensureModule(state, "render");
  lua_pushcfunction(state, MockScalarSetViewport);
  lua_setfield(state, -2, "set_viewport");
  lua_pop(state, 1);
}

void installRoutes(lua_State* state, const handle::RuntimeProfile& profile) {
  for (size_t index = 0; index < handle::kRouteCount; ++index) {
    const auto& route = handle::routes()[index];
    if (route.nativeDynamicHermes != handle::Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified ||
        !handle::routeAvailableInProfile(route, profile)) continue;
    ensureModule(state, route.modulePath);
    lua_pushinteger(state, route.index);
    lua_pushcclosure(state, MockRoute, 1);
    lua_setfield(state, -2, route.member);
    lua_pop(state, 1);
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/// Best-of-`kRepeats` mean nanoseconds per call. Best-of removes scheduler and
/// thermal noise without hiding the distribution: the spread across repeats is
/// reported alongside it.
struct Timing {
  double bestNs = 0;
  double worstNs = 0;
};

template <typename Body>
Timing measure(Body&& body) {
  for (size_t index = 0; index < kWarmup; ++index) body();
  Timing timing{};
  for (size_t repeat = 0; repeat < kRepeats; ++repeat) {
    const auto start = std::chrono::steady_clock::now();
    for (size_t index = 0; index < kIterations; ++index) body();
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - start).count();
    const double perCall = static_cast<double>(elapsed) / static_cast<double>(kIterations);
    if (repeat == 0 || perCall < timing.bestNs) timing.bestNs = perCall;
    if (perCall > timing.worstNs) timing.worstNs = perCall;
  }
  return timing;
}

// ---------------------------------------------------------------------------
// Route sampling. One route per distinct generated contract shape, restricted
// to shapes the raw-Lua baseline can reproduce exactly: scalar arguments and a
// scalar-or-absent result, outside the game-object instance context.
// ---------------------------------------------------------------------------

struct Sample {
  const handle::Route* route = nullptr;
  int functionRef = LUA_NOREF;
  std::string shape;
};

bool scalarCodec(const handle::ValueCodec& codec) {
  return codec.semanticKind == handle::SemanticHandleKind::kNone &&
      (codec.mask & (handle::kBoolean | handle::kInteger | handle::kNumber)) != 0 &&
      (codec.mask & (handle::kString | handle::kHash | handle::kUrl | handle::kVector3 |
                     handle::kVector4 | handle::kQuaternion | handle::kHandle)) == 0;
}

bool reproducibleByBaseline(const handle::Route& route) {
  if (route.context == handle::Context::kGameObjectInstance) return false;
  if (route.resultCount > 1) return false;
  for (uint8_t index = 0; index < route.argumentCount; ++index) {
    const auto& codec = handle::argumentCodecs()[route.argumentOffset + index];
    if (codec.semanticKind == handle::SemanticHandleKind::kNone && !scalarCodec(codec)) return false;
  }
  if (route.resultCount && !scalarCodec(handle::resultCodecs()[route.resultOffset])) return false;
  return true;
}

int referenceFor(lua_State* state, const handle::Route& route) {
  ensureModule(state, route.modulePath);
  lua_getfield(state, -1, route.member);
  expect(lua_isfunction(state, -1), "sampled Lua target is missing");
  const int reference = luaL_ref(state, LUA_REGISTRYINDEX);
  lua_pop(state, 1);
  return reference;
}

/// Owns everything a dispatch frame points at, so a frame stays valid after the
/// scope that built it has exited.
struct FrameState {
  std::array<ScriptValue, 8> arguments{};
  std::array<ScriptValue, 4> results{};
  std::array<char, 128> strings{};
  ScriptUrlArena<> urls{4242};
  ScriptCallFrame frame{};
};

struct BaselineCall {
  lua_State* state = nullptr;
  const handle::Route* route = nullptr;
  int functionRef = LUA_NOREF;
  std::array<int, 8> handleRefs{};

  void push() const {
    lua_rawgeti(state, LUA_REGISTRYINDEX, functionRef);
    for (uint8_t index = 0; index < route->argumentCount; ++index) {
      const auto& codec = handle::argumentCodecs()[route->argumentOffset + index];
      if (codec.semanticKind != handle::SemanticHandleKind::kNone) {
        lua_rawgeti(state, LUA_REGISTRYINDEX, handleRefs[static_cast<size_t>(codec.semanticKind)]);
      } else if (codec.mask & handle::kBoolean) {
        lua_pushboolean(state, 1);
      } else {
        lua_pushnumber(state, 3);
      }
    }
  }

  void readResults(int base) const {
    for (uint8_t index = 0; index < route->resultCount; ++index) {
      const auto& codec = handle::resultCodecs()[route->resultOffset + index];
      if (codec.mask & handle::kBoolean) (void)lua_toboolean(state, base + 1 + index);
      else (void)lua_tonumber(state, base + 1 + index);
    }
  }
};

int ProtectedBaseline(lua_State* state) {
  const auto* call = static_cast<const BaselineCall*>(lua_touserdata(state, 1));
  const int base = lua_gettop(state);
  call->push();
  lua_call(state, call->route->argumentCount, LUA_MULTRET);
  call->readResults(base);
  return 0;
}

// ---------------------------------------------------------------------------
// c-abi-native stub provider (transport b)
// ---------------------------------------------------------------------------

uint8_t StubCurrentThread(void*) { return 1; }
uint8_t StubValidateHandle(void*, uint16_t, uint64_t) { return 1; }
DehermDmSdkBorrowedStatus StubInvoke(void*, uint16_t, const uint64_t*, uint32_t, uint64_t* out) {
  *out = UINT64_C(7);
  return DEHERM_DMSDK_BORROWED_OK;
}

// ---------------------------------------------------------------------------
// typed-native stub backend (transport c)
// ---------------------------------------------------------------------------

bool TypedNativeDispatch(void*, ScriptCallFrame* frame) {
  const auto* operation = defold_hermes::universal_value::find(frame->stableId);
  if (!operation) return false;
  for (uint8_t index = 0; index < operation->resultCount; ++index) {
    frame->results[index] = {};
    frame->results[index].tag = ScriptValueTag::kNumber;
    frame->results[index].number = 7;
  }
  frame->resultCount = operation->resultCount;
  return true;
}
const char* TypedNativeLastError(void*) { return "typed-native stub"; }
void TypedNativeRelease(void*, ScriptHandleKind, uint32_t, uint64_t) noexcept {}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

void report(const char* transport, const char* shape, const char* route, const Timing& timing) {
  std::printf("transport-profile:%s:%s:%s:best_ns=%.1f:worst_ns=%.1f\n",
      transport, shape, route, timing.bestNs, timing.worstNs);
}

#if DEHERM_PROFILE_ENABLED
const char* transportName(uint32_t id) {
  switch (id) {
    case DEHERM_PROFILE_TRANSPORT_LUA_STACK: return "lua-stack";
    case DEHERM_PROFILE_TRANSPORT_C_ABI_NATIVE: return "c-abi-native";
    case DEHERM_PROFILE_TRANSPORT_TYPED_NATIVE: return "typed-native";
    case DEHERM_PROFILE_TRANSPORT_JSI: return "jsi";
    case DEHERM_PROFILE_TRANSPORT_DIRECT_MEMORY: return "direct-memory";
    default: return "unknown";
  }
}

struct Aggregate {
  uint64_t count = 0;
  uint64_t totalNs = 0;
  uint64_t minNs = UINT64_MAX;
  uint64_t maxNs = 0;
};

void drainAndReport() {
  std::map<std::pair<uint32_t, uint32_t>, Aggregate> byTransportShape;
  std::array<defold_hermes::profile::Record, 1024> batch{};
  uint64_t drained = 0;
  for (;;) {
    const uint32_t count = defold_hermes::profile::drain(batch.data(), batch.size());
    if (!count) break;
    drained += count;
    for (uint32_t index = 0; index < count; ++index) {
      const auto& record = batch[index];
      if (record.kind != DEHERM_PROFILE_KIND_TRANSPORT_SPAN) continue;
      const uint32_t transport = static_cast<uint32_t>(record.value_b & 0xFFu);
      const uint32_t shape = static_cast<uint32_t>((record.value_b >> 8) & 0xFFFFu);
      auto& aggregate = byTransportShape[{transport, shape}];
      ++aggregate.count;
      aggregate.totalNs += record.value_a;
      aggregate.minNs = std::min(aggregate.minNs, record.value_a);
      aggregate.maxNs = std::max(aggregate.maxNs, record.value_a);
    }
  }
  const auto& ring = defold_hermes::profile::ring();
  std::printf("transport-profile:ring:capacity=%u:produced=%llu:dropped=%llu:drained=%llu\n",
      defold_hermes::profile::Ring::kCapacity,
      static_cast<unsigned long long>(ring.produced),
      static_cast<unsigned long long>(ring.dropped),
      static_cast<unsigned long long>(drained));
  for (const auto& [key, aggregate] : byTransportShape) {
    std::printf("transport-profile:span:%s:shape=%u:count=%llu:mean_ns=%.1f:min_ns=%llu:max_ns=%llu\n",
        transportName(key.first), key.second,
        static_cast<unsigned long long>(aggregate.count),
        static_cast<double>(aggregate.totalNs) / static_cast<double>(aggregate.count),
        static_cast<unsigned long long>(aggregate.minNs),
        static_cast<unsigned long long>(aggregate.maxNs));
  }
}
#endif

}  // namespace

// ---------------------------------------------------------------------------
// Defold value shims. The bridge calls these; the benchmark links no engine.
// ---------------------------------------------------------------------------
namespace dmScript {
void PushHash(lua_State* s, dmhash_t v) { *static_cast<dmhash_t*>(lua_newuserdata(s, sizeof(v))) = v; }
dmhash_t* ToHash(lua_State* s, int i) { return lua_isuserdata(s, i) ? static_cast<dmhash_t*>(lua_touserdata(s, i)) : nullptr; }
void PushVector3(lua_State* s, const dmVMath::Vector3& v) { *static_cast<dmVMath::Vector3*>(lua_newuserdata(s, sizeof(v))) = v; }
dmVMath::Vector3* ToVector3(lua_State* s, int i) { return lua_isuserdata(s, i) ? static_cast<dmVMath::Vector3*>(lua_touserdata(s, i)) : nullptr; }
void PushVector4(lua_State* s, const dmVMath::Vector4& v) { *static_cast<dmVMath::Vector4*>(lua_newuserdata(s, sizeof(v))) = v; }
dmVMath::Vector4* ToVector4(lua_State* s, int i) { return lua_isuserdata(s, i) ? static_cast<dmVMath::Vector4*>(lua_touserdata(s, i)) : nullptr; }
void PushQuat(lua_State* s, const dmVMath::Quat& v) { *static_cast<dmVMath::Quat*>(lua_newuserdata(s, sizeof(v))) = v; }
dmVMath::Quat* ToQuat(lua_State* s, int i) { return lua_isuserdata(s, i) ? static_cast<dmVMath::Quat*>(lua_touserdata(s, i)) : nullptr; }
void PushURL(lua_State* s, const dmMessage::URL& v) { *static_cast<dmMessage::URL*>(lua_newuserdata(s, sizeof(v))) = v; }
dmVMath::Matrix4* ToMatrix4(lua_State*, int) { return nullptr; }
dmMessage::URL* ToURL(lua_State*, int) { return nullptr; }
void PushMatrix4(lua_State*, const dmVMath::Matrix4&) {}
}  // namespace dmScript

int main() {
  std::printf("transport-profile:build:deherm_profile=%d:iterations=%zu:warmup=%zu:repeats=%zu\n",
      DEHERM_PROFILE_ENABLED, kIterations, kWarmup, kRepeats);

  const auto* profile = handle::findRuntimeProfile("default-legacy-bullet");
  expect(profile != nullptr, "benchmark runtime profile is missing");

  lua_State* state = luaL_newstate();
  expect(state != nullptr, "Lua state creation failed");
  installRoutes(state, *profile);
  installScalarRoute(state);
  int instance = 0;
  lua_pushlightuserdata(state, &instance);
  SetInstance(state);

  scalar::ScriptAdapter adapter;
  expect(adapter.initialize(state, {GetInstance, SetInstance}, handle::runtimeProfileHandshake(*profile)),
      adapter.lastError());
  lua_pushlightuserdata(state, &instance);
  expect(adapter.captureInstance(-1), adapter.lastError());
  lua_pop(state, 1);

  // The scalar ScriptAdapter lane is measured separately because the generic
  // handle-route sweep below does not enter it. This is the production chain:
  // family selection, stable-id lookup, ScriptValue conversion, Dispatcher,
  // protected Lua call, and result restoration.
  FrameState scalarFrame{};
  scalarFrame.frame.stableId = static_cast<uint32_t>(scalar::generated::BindingId::RenderSetViewport);
  scalarFrame.frame.arguments = scalarFrame.arguments.data();
  scalarFrame.frame.argumentCount = 4;
  for (uint32_t index = 0; index < scalarFrame.frame.argumentCount; ++index) {
    scalarFrame.arguments[index].tag = ScriptValueTag::kNumber;
    scalarFrame.arguments[index].number = static_cast<double>(index + 1);
  }
  expect(adapter.dispatch(&scalarFrame.frame), adapter.lastError());
  const Timing scalarLua = measure([&] {
    (void)adapter.dispatch(&scalarFrame.frame);
  });
  report("lua-scalar", "4arg-0res", "script:render.set_viewport", scalarLua);

  size_t scalarDenseIndex = 0;
  expect(scalar::findDenseIndex(scalarFrame.frame.stableId, &scalarDenseIndex),
      "scalar benchmark route did not resolve to a dense index");
  std::array<scalar::ScalarInput, 4> scalarInputs{};
  for (size_t index = 0; index < scalarInputs.size(); ++index) {
    scalarInputs[index] = scalar::ScalarInput::integerValue(static_cast<int64_t>(index + 1));
  }
  const Timing scalarDense = measure([&] {
    (void)adapter.dispatcher().dispatchDense(
        scalarDenseIndex, {scalarInputs.data(), scalarInputs.size()});
  });
  report("lua-scalar-dense", "4arg-0res", "script:render.set_viewport", scalarDense);
  constexpr uint64_t kCallsPerMeasurement = kWarmup + kRepeats * kIterations;
  expect(gScalarLuaCalls == 1 + 2 * kCallsPerMeasurement,
      "scalar benchmark dispatch did not reach its Lua target on every call");

  const auto& scalarTables = scalar::generated::tables();
  size_t lookupCursor = 0;
  volatile size_t lookupSink = 0;
  const Timing scalarLookup = measure([&] {
    size_t resolved = 0;
    (void)scalar::findDenseIndex(scalarTables.stableIds[lookupCursor], &resolved);
    lookupSink = resolved;
    if (++lookupCursor == scalarTables.bindingCount) lookupCursor = 0;
  });
  (void)lookupSink;
  report("scalar-id-lookup", "90-entry-table", "generated:scalar", scalarLookup);

  // One captured semantic handle per kind, plus a raw registry reference to the
  // same userdata so the baseline can push it without touching the registry.
  std::array<ScriptValue, handle::kHandleKindCount + 1> handles{};
  std::array<int, 8> handleRefs{};
  handleRefs.fill(LUA_NOREF);
  for (uint16_t kind = 1; kind <= handle::kHandleKindCount; ++kind) {
    lua_newuserdata(state, 16);
    expect(adapter.captureSemanticHandle(-1, static_cast<handle::SemanticHandleKind>(kind), &handles[kind]),
        adapter.lastError());
    if (kind < handleRefs.size()) {
      lua_pushvalue(state, -1);
      handleRefs[kind] = luaL_ref(state, LUA_REGISTRYINDEX);
    }
    lua_pop(state, 1);
  }

  // Sample one route per distinct generated contract shape.
  // Frame state outlives the timing loop so the bounded ring pass can replay it.
  std::vector<std::unique_ptr<FrameState>> frames;

  std::vector<Sample> samples;
  std::vector<std::string> seenShapes;
  for (size_t index = 0; index < handle::kRouteCount && samples.size() < kMaxSampledShapes; ++index) {
    const auto& route = handle::routes()[index];
    if (route.nativeDynamicHermes != handle::Disposition::kCapturedLuaRouterHarnessProvenJsiUnverified ||
        !handle::routeAvailableInProfile(route, *profile) || !reproducibleByBaseline(route)) continue;
    bool handleArgumentOutOfRange = false;
    for (uint8_t argument = 0; argument < route.argumentCount; ++argument) {
      const auto kind = handle::argumentCodecs()[route.argumentOffset + argument].semanticKind;
      if (kind != handle::SemanticHandleKind::kNone && static_cast<size_t>(kind) >= handleRefs.size()) {
        handleArgumentOutOfRange = true;
      }
    }
    if (handleArgumentOutOfRange) continue;
    std::string shape = std::to_string(route.argumentCount) + "arg-" + std::to_string(route.resultCount) + "res";
    if (std::find(seenShapes.begin(), seenShapes.end(), shape) != seenShapes.end()) continue;
    seenShapes.push_back(shape);
    samples.push_back({&route, referenceFor(state, route), shape});
  }
  expect(!samples.empty(), "no route contract shape is reproducible by the raw-Lua baseline");

  for (const auto& sample : samples) {
    const auto& route = *sample.route;
    BaselineCall baseline{state, &route, sample.functionRef, handleRefs};

    // (d) raw Lua: the floor. Exactly what a hand-written C function that calls
    // this Lua function would do.
    const Timing rawLua = measure([&] {
      const int base = lua_gettop(state);
      baseline.push();
      lua_call(state, route.argumentCount, LUA_MULTRET);
      baseline.readResults(base);
      lua_settop(state, base);
    });

    // (d') the same call under lua_cpcall, isolating the protection the bridge
    // must pay to keep a Lua error from unwinding through C++.
    const Timing rawLuaProtected = measure([&] {
      const int base = lua_gettop(state);
      lua_cpcall(state, ProtectedBaseline, &baseline);
      lua_settop(state, base);
    });

    // (a) the generated lua-stack transport. The frame state is heap-owned so
    // the bounded ring pass below can replay it after this loop has exited.
    auto owned = std::make_unique<FrameState>();
    for (uint8_t index = 0; index < route.argumentCount; ++index) {
      const auto& codec = handle::argumentCodecs()[route.argumentOffset + index];
      if (codec.semanticKind != handle::SemanticHandleKind::kNone) {
        owned->arguments[index] = handles[static_cast<size_t>(codec.semanticKind)];
      } else if (codec.mask & handle::kBoolean) {
        owned->arguments[index].tag = ScriptValueTag::kBoolean; owned->arguments[index].number = 1;
      } else {
        owned->arguments[index].tag = ScriptValueTag::kNumber; owned->arguments[index].number = 3;
      }
    }
    ScriptCallFrame& frame = owned->frame;
    frame.stableId = route.stableId;
    frame.arguments = owned->arguments.data();
    frame.argumentCount = route.argumentCount;
    frame.results = owned->results.data();
    frame.resultCapacity = static_cast<uint8_t>(owned->results.size());
    frame.stringScratch = owned->strings.data();
    frame.stringScratchCapacity = static_cast<uint32_t>(owned->strings.size());
    frame.urlArena = &owned->urls;
    expect(adapter.dispatch(&frame), adapter.lastError());
    const Timing luaStack = measure([&] {
      frame.stringScratchUsed = 0;
      (void)adapter.dispatch(&frame);
    });
    frames.push_back(std::move(owned));

    report("raw-lua", sample.shape.c_str(), route.canonicalId, rawLua);
    report("raw-lua-protected", sample.shape.c_str(), route.canonicalId, rawLuaProtected);
    report("lua-stack", sample.shape.c_str(), route.canonicalId, luaStack);
    std::printf("transport-profile:delta:%s:%s:bridge_over_raw_ns=%.1f:bridge_over_protected_ns=%.1f\n",
        sample.shape.c_str(), route.canonicalId,
        luaStack.bestNs - rawLua.bestNs, luaStack.bestNs - rawLuaProtected.bestNs);
  }

  // (b) c-abi-native over a stub provider. Measures the generated C ABI framing
  // and validation, not the Defold call behind it.
  {
    const DehermDmSdkBorrowedProvider provider{
        DEHERM_DMSDK_BORROWED_PROVIDER_ABI, nullptr, StubCurrentThread, StubValidateHandle, StubInvoke};
    expect(deherm_dmsdk_borrowed_set_provider(&provider) == DEHERM_DMSDK_BORROWED_OK,
        "borrowed-handle provider was rejected");
    for (uint16_t id = 0; id < 2 && id < deherm_dmsdk_borrowed_count(); ++id) {
      const auto& descriptor = deherm_dmsdk_borrowed_descriptors()[id];
      uint64_t arguments[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS] = {1, 1};
      uint64_t result = 0;
      const Timing timing = measure([&] {
        (void)deherm_dmsdk_borrowed_dispatch(id, arguments, descriptor.argument_count, &result);
      });
      const std::string shape = std::to_string(descriptor.argument_count) + "arg-1res";
      report("c-abi-native", shape.c_str(), descriptor.declaration_id, timing);
    }
  }

  // (c) typed-native extern_c over a stub backend. The generated dispatcher for
  // this transport decodes the wire frame, calls the backend, and encodes back.
  //
  // One route per distinct "Narg-Mres" contract shape, in stable-id order, so
  // the same route is selected before and after a dispatcher change and the
  // figures stay comparable. Arguments are wire numbers: this layer validates
  // arity, not parameter types, and the stub backend ignores the values.
  {
    int backend = 0;
    defold_hermes::installScriptBridgeApi(
        {&backend, TypedNativeDispatch, TypedNativeLastError, TypedNativeRelease});
    const auto* operations = defold_hermes::universal_value::operations();
    std::vector<std::string> seenTypedShapes;
    for (size_t index = 0; index < defold_hermes::universal_value::kOperationCount; ++index) {
      const auto& operation = operations[index];
      const uint32_t argumentCount = operation.maximumArgumentCount;
      if (argumentCount > kTypedNativeMaxArguments) continue;
      const std::string shape =
          std::to_string(argumentCount) + "arg-" + std::to_string(operation.resultCount) + "res";
      if (std::find(seenTypedShapes.begin(), seenTypedShapes.end(), shape) != seenTypedShapes.end()) continue;
      std::array<DehermScriptUniversalValue, kTypedNativeMaxArguments> inputValues{};
      std::array<uint32_t, kTypedNativeMaxArguments> argumentRoots{};
      for (uint32_t argument = 0; argument < argumentCount; ++argument) {
        inputValues[argument].tag = 3;  // number
        inputValues[argument].number = 3;
        argumentRoots[argument] = argument;
      }
      std::array<DehermScriptUniversalValue, 8> outputValues{};
      std::array<DehermScriptUniversalEntry, 8> outputEntries{};
      std::array<char, 256> outputStrings{};
      std::array<float, 16> outputFloats{};
      std::array<DehermScriptUniversalUrl, 4> outputUrls{};
      std::array<uint32_t, DEHERM_SCRIPT_UNIVERSAL_MAX_RESULTS> roots{};
      uint32_t valueCount = 0, entryCount = 0, stringBytes = 0, floatCount = 0, urlCount = 0, resultCount = 0;
      char error[128]{};
      const auto call = [&] {
        return deherm_script_universal_dispatch(operation.stableId,
            argumentCount ? inputValues.data() : nullptr, argumentCount,
            nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0,
            argumentCount ? argumentRoots.data() : nullptr, argumentCount,
            outputValues.data(), outputValues.size(), &valueCount,
            outputEntries.data(), outputEntries.size(), &entryCount,
            outputStrings.data(), outputStrings.size(), &stringBytes,
            outputFloats.data(), outputFloats.size(), &floatCount,
            outputUrls.data(), outputUrls.size(), &urlCount,
            roots.data(), roots.size(), &resultCount, error, sizeof(error));
      };
      if (call() != DEHERM_SCRIPT_UNIVERSAL_OK) continue;
      seenTypedShapes.push_back(shape);
      const Timing timing = measure([&] { (void)call(); });
      report("typed-native", shape.c_str(), operation.canonicalId, timing);
    }
    if (seenTypedShapes.empty()) std::puts("transport-profile:typed-native:no-route-dispatched");
  }

#if DEHERM_PROFILE_ENABLED
  // Discard everything the timing loops produced, then replay a bounded sample
  // so the reported aggregates come from a ring that never dropped a record.
  defold_hermes::profile::reset();
  defold_hermes::profile::ring().produced = 0;
  defold_hermes::profile::ring().dropped = 0;
  for (auto& owned : frames) {
    for (size_t index = 0; index < kRingSampleCalls; ++index) {
      owned->frame.stringScratchUsed = 0;
      (void)adapter.dispatch(&owned->frame);
    }
  }
  {
    const DehermDmSdkBorrowedProvider provider{
        DEHERM_DMSDK_BORROWED_PROVIDER_ABI, nullptr, StubCurrentThread, StubValidateHandle, StubInvoke};
    (void)deherm_dmsdk_borrowed_set_provider(&provider);
    uint64_t arguments[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS] = {1, 1};
    uint64_t result = 0;
    for (uint16_t id = 0; id < 2 && id < deherm_dmsdk_borrowed_count(); ++id) {
      const auto& descriptor = deherm_dmsdk_borrowed_descriptors()[id];
      for (size_t index = 0; index < kRingSampleCalls; ++index) {
        (void)deherm_dmsdk_borrowed_dispatch(id, arguments, descriptor.argument_count, &result);
      }
    }
  }
  drainAndReport();
#endif

  std::printf("transport-profile:lua-target-calls=%llu\n", static_cast<unsigned long long>(gLuaCalls));
  std::printf("transport-profile:scalar-lua-target-calls=%llu\n",
      static_cast<unsigned long long>(gScalarLuaCalls));
  adapter.shutdown();
  lua_close(state);
  std::puts("transport-profile:ok");
  return 0;
}
