#include <defold_hermes/generated_script_overload_dispatch.hpp>
#include <defold_hermes/generated_script_table_record_bindings.hpp>
#include <defold_hermes/generated_script_value_tail_bindings.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace overload = defold_hermes::overload_dispatch;
namespace records = defold_hermes::table_record;
namespace scalar = defold_hermes::lua_bridge::scalar;
namespace tail = defold_hermes::value_tail;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptMatrix4Arena;
using defold_hermes::ScriptResolvedUrl;
using defold_hermes::ScriptTableEntry;
using defold_hermes::ScriptUrlArena;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace {
std::atomic<bool> gTrackAllocations{false};
std::atomic<uint64_t> gAllocations{0};
int gInstanceKey = 0;
void* gExpectedInstance = nullptr;
scalar::ScriptAdapter* gAdapter = nullptr;
bool gRunReentrantCall = false;
uint64_t gTailCalls = 0;
uint64_t gOverloadCalls = 0;
uint64_t gRecordCalls = 0;
enum class RecordMode { kValid, kMissingField, kExtraField, kWrongType };
RecordMode gRecordMode = RecordMode::kValid;

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "script-captured-lua-router:error:%s\n", message);
  std::exit(1);
}
void expect(bool condition, const char* message) { if (!condition) fail(message); }

void GetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_rawget(state, LUA_REGISTRYINDEX);
}
void SetInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gInstanceKey);
  lua_insert(state, -2);
  lua_rawset(state, LUA_REGISTRYINDEX);
}
bool hasExpectedInstance(lua_State* state) {
  GetInstance(state);
  const bool result = lua_touserdata(state, -1) == gExpectedInstance;
  lua_pop(state, 1);
  return result;
}

dmVMath::Matrix4 identityMatrix() {
  return dmVMath::Matrix4(
      dmVMath::Vector4(1, 0, 0, 0), dmVMath::Vector4(0, 1, 0, 0),
      dmVMath::Vector4(0, 0, 1, 0), dmVMath::Vector4(0, 0, 0, 1));
}
}

void* operator new(std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) {
    gAllocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* result = std::malloc(size)) return result;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) {
    gAllocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* result = std::malloc(size)) return result;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

namespace dmScript {
void PushHash(lua_State* state, dmhash_t value) { *static_cast<dmhash_t*>(lua_newuserdata(state, sizeof(value))) = value; }
dmhash_t* ToHash(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmhash_t*>(lua_touserdata(state, index)) : nullptr; }
void PushVector3(lua_State* state, const dmVMath::Vector3& value) { *static_cast<dmVMath::Vector3*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushVector4(lua_State* state, const dmVMath::Vector4& value) { *static_cast<dmVMath::Vector4*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushQuat(lua_State* state, const dmVMath::Quat& value) { *static_cast<dmVMath::Quat*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value) { *static_cast<dmVMath::Matrix4*>(lua_newuserdata(state, sizeof(value))) = value; }
void PushURL(lua_State* state, const dmMessage::URL& value) { *static_cast<dmMessage::URL*>(lua_newuserdata(state, sizeof(value))) = value; }
dmVMath::Vector3* ToVector3(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector3*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Vector4* ToVector4(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector4*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Quat* ToQuat(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Quat*>(lua_touserdata(state, index)) : nullptr; }
dmVMath::Matrix4* ToMatrix4(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmVMath::Matrix4*>(lua_touserdata(state, index)) : nullptr; }
dmMessage::URL* ToURL(lua_State* state, int index) { return lua_isuserdata(state, index) ? static_cast<dmMessage::URL*>(lua_touserdata(state, index)) : nullptr; }
}

namespace {
int MockOverload(lua_State* state) {
  const auto& operation = overload::operations()[static_cast<size_t>(lua_tointeger(state, lua_upvalueindex(1)))];
  const overload::Shape* selected = nullptr;
  for (uint8_t index = 0; index < operation.shapeCount; ++index) {
    const auto& shape = overload::shapes()[operation.shapeOffset + index];
    if (shape.argumentCount == lua_gettop(state)) { selected = &shape; break; }
  }
  if (!selected) return luaL_error(state, "no generated overload shape for Lua call");
  ++gOverloadCalls;
  switch (selected->resultMask) {
    case overload::kNumber: lua_pushnumber(state, 7.5); break;
    case overload::kVector3: dmScript::PushVector3(state, dmVMath::Vector3(1, 2, 3)); break;
    case overload::kVector4: dmScript::PushVector4(state, dmVMath::Vector4(1, 2, 3, 4)); break;
    case overload::kQuaternion: dmScript::PushQuat(state, dmVMath::Quat(0, 0, 0, 1)); break;
    case overload::kMatrix4: dmScript::PushMatrix4(state, identityMatrix()); break;
    default: return luaL_error(state, "unknown overload result codec");
  }
  return 1;
}

int MockTail(lua_State* state) {
  if (!hasExpectedInstance(state)) return luaL_error(state, "captured instance differs");
  const auto& route = tail::routes()[static_cast<size_t>(lua_tointeger(state, lua_upvalueindex(1)))];
  ++gTailCalls;
  if (gRunReentrantCall) {
    gRunReentrantCall = false;
    const overload::Operation& nested = overload::operations()[0];
    ScriptValue result{};
    ScriptMatrix4Arena arena{};
    ScriptCallFrame frame{};
    frame.stableId = nested.stableId;
    frame.results = &result;
    frame.resultCapacity = 1;
    frame.matrix4Arena = &arena;
    if (!gAdapter->dispatch(&frame)) return luaL_error(state, "%s", gAdapter->lastError());
  }
  switch (route.resultCodec) {
    case tail::Codec::kNone: return 0;
    case tail::Codec::kBoolean: lua_pushboolean(state, 1); return 1;
    case tail::Codec::kNumber: lua_pushnumber(state, 2.5); return 1;
    case tail::Codec::kString: lua_pushliteral(state, "generated-tail"); return 1;
    case tail::Codec::kHash: dmScript::PushHash(state, UINT64_C(0x123456789abcdef0)); return 1;
    case tail::Codec::kVector3: dmScript::PushVector3(state, dmVMath::Vector3(1, 2, 3)); return 1;
    case tail::Codec::kMatrix4: dmScript::PushMatrix4(state, identityMatrix()); return 1;
    default: return luaL_error(state, "unknown value-tail result codec");
  }
}

int MockRecord(lua_State* state) {
  const uint32_t stableId = static_cast<uint32_t>(lua_tonumber(state, lua_upvalueindex(1)));
  const records::Operation* operation = records::find(stableId);
  if (!operation) return luaL_error(state, "unknown generated table-record route");
  if (operation->stableId == UINT32_C(0xea93e5f3) &&
      (lua_gettop(state) != 1 || lua_type(state, 1) != LUA_TSTRING)) {
    return luaL_error(state, "ASTC table-record route expected one byte string");
  }
  ++gRecordCalls;
  lua_newtable(state);
  const uint8_t count = gRecordMode == RecordMode::kMissingField
      ? static_cast<uint8_t>(operation->fieldCount - 1) : operation->fieldCount;
  for (uint8_t offset = 0; offset < count; ++offset) {
    const uint8_t index = static_cast<uint8_t>(operation->fieldCount - 1 - offset);
    const auto& field = records::fields()[operation->fieldOffset + index];
    if (gRecordMode == RecordMode::kWrongType && index == 0) lua_pushboolean(state, 1);
    else if (field.codec == records::Codec::kString) lua_pushliteral(state, "3.1.4");
    else lua_pushinteger(state, static_cast<lua_Integer>(index + 1));
    lua_setfield(state, -2, field.name);
  }
  if (gRecordMode == RecordMode::kExtraField) {
    lua_pushinteger(state, 1);
    lua_setfield(state, -2, "unexpected");
  }
  return 1;
}

void installGeneratedRoutes(lua_State* state) {
  lua_newtable(state);
  for (size_t index = 0; index < overload::kBindingCount; ++index) {
    const auto& operation = overload::operations()[index];
    lua_pushinteger(state, operation.index);
    lua_pushcclosure(state, MockOverload, 1);
    lua_setfield(state, -2, operation.member);
  }
  lua_setglobal(state, "vmath");

  for (size_t index = 0; index < tail::kRouteCount; ++index) {
    const auto& route = tail::routes()[index];
    if (route.disposition != tail::Disposition::kCandidate) continue;
    lua_pushinteger(state, route.index);
    lua_pushcclosure(state, MockTail, 1);
    if (std::strcmp(route.modulePath, "builtins") == 0) {
      lua_setglobal(state, route.member);
      continue;
    }
    lua_getglobal(state, route.modulePath);
    if (!lua_istable(state, -1)) {
      lua_pop(state, 1);
      lua_newtable(state);
      lua_pushvalue(state, -1);
      lua_setglobal(state, route.modulePath);
    }
    lua_insert(state, -2);
    lua_setfield(state, -2, route.member);
    lua_pop(state, 1);
  }

  constexpr uint32_t recordIds[] = {
    UINT32_C(0x3aac69fd), UINT32_C(0xea93e5f3), UINT32_C(0xf808b822)
  };
  for (uint32_t stableId : recordIds) {
    const records::Operation* operation = records::find(stableId);
    expect(operation != nullptr, "generated table-record operation is absent");
    lua_getglobal(state, operation->modulePath);
    if (!lua_istable(state, -1)) {
      lua_pop(state, 1);
      lua_newtable(state);
      lua_pushvalue(state, -1);
      lua_setglobal(state, operation->modulePath);
    }
    lua_pushnumber(state, static_cast<lua_Number>(stableId));
    lua_pushcclosure(state, MockRecord, 1);
    lua_setfield(state, -2, operation->member);
    lua_pop(state, 1);
  }
}

ScriptValue tailArgument(tail::Codec codec, ScriptMatrix4Arena& matrices, ScriptUrlArena<>& urls) {
  ScriptValue value{};
  static constexpr char text[] = "generated";
  alignas(16) static constexpr float identity[16] = {
    1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
  };
  switch (codec) {
    case tail::Codec::kNil: value.tag = ScriptValueTag::kNull; break;
    case tail::Codec::kBoolean: value.tag = ScriptValueTag::kBoolean; value.number = 1; break;
    case tail::Codec::kNumber: value.tag = ScriptValueTag::kNumber; value.number = 3; break;
    case tail::Codec::kString: value.tag = ScriptValueTag::kString; value.data = text; value.length = sizeof(text) - 1; break;
    case tail::Codec::kHash: value.tag = ScriptValueTag::kHandle; value.handleKind = ScriptHandleKind::kHash; value.payload = 17; break;
    case tail::Codec::kUrl: expect(urls.store({1,2,3,4}, &value), "URL arena setup failed"); break;
    case tail::Codec::kVector3: value.tag = ScriptValueTag::kDefoldValue; value.defoldKind = ScriptDefoldValueKind::kVector3; value.defoldValue[0]=1; value.defoldValue[1]=2; value.defoldValue[2]=3; break;
    case tail::Codec::kMatrix4: expect(matrices.store(identity, &value), "Matrix4 arena setup failed"); break;
    default: fail("invalid tail argument codec");
  }
  return value;
}

ScriptValue overloadArgument(uint16_t codec, ScriptMatrix4Arena& matrices) {
  ScriptValue value{};
  alignas(16) static constexpr float identity[16] = {
    1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
  };
  if (codec == overload::kNumber) { value.tag=ScriptValueTag::kNumber; value.number=0.5; }
  else if (codec == overload::kMatrix4) expect(matrices.store(identity, &value), "overload Matrix4 setup failed");
  else {
    value.tag = ScriptValueTag::kDefoldValue;
    value.defoldKind = codec == overload::kVector3 ? ScriptDefoldValueKind::kVector3 :
        codec == overload::kVector4 ? ScriptDefoldValueKind::kVector4 : ScriptDefoldValueKind::kQuaternion;
    value.defoldValue[3] = 1;
  }
  return value;
}

bool dispatchTail(scalar::ScriptAdapter& adapter, const tail::Route& route, size_t shapeIndex,
    ScriptMatrix4Arena& matrices, ScriptUrlArena<>& urls, ScriptValue* result) {
  std::array<ScriptValue, 6> arguments{};
  const uint8_t count = tail::shapeArgumentCounts()[shapeIndex];
  const uint16_t offset = tail::shapeArgumentOffsets()[shapeIndex];
  for (uint8_t index = 0; index < count; ++index) {
    arguments[index] = tailArgument(tail::argumentCodecs()[offset + index], matrices, urls);
  }
  char scratch[128]{};
  ScriptCallFrame frame{};
  frame.stableId=route.stableId; frame.arguments=arguments.data(); frame.argumentCount=count;
  frame.results=result; frame.resultCapacity=1; frame.stringScratch=scratch;
  frame.stringScratchCapacity=sizeof(scratch); frame.matrix4Arena=&matrices; frame.urlArena=&urls;
  return adapter.dispatch(&frame);
}

bool dispatchRecord(
    scalar::ScriptAdapter& adapter,
    const records::Operation& operation,
    ScriptTableEntry* tableScratch,
    uint32_t tableCapacity,
    char* stringScratch,
    uint32_t stringCapacity,
    ScriptValue* result,
    const ScriptValue* argument = nullptr) {
  ScriptCallFrame frame{};
  frame.stableId = operation.stableId;
  frame.arguments = argument;
  frame.argumentCount = argument ? 1 : 0;
  frame.results = result;
  frame.resultCapacity = 1;
  frame.stringScratch = stringScratch;
  frame.stringScratchCapacity = stringCapacity;
  frame.tableScratch = tableScratch;
  frame.tableScratchCapacity = tableCapacity;
  return adapter.dispatch(&frame);
}
}

int main() {
  lua_State* state = luaL_newstate();
  expect(state != nullptr, "could not create Lua state");
  installGeneratedRoutes(state);
  int instanceToken = 0;
  gExpectedInstance = &instanceToken;
  lua_pushlightuserdata(state, gExpectedInstance);
  SetInstance(state);
  scalar::ScriptAdapter adapter;
  gAdapter = &adapter;
  expect(adapter.initialize(state, {GetInstance, SetInstance}), "adapter initialization failed");

  constexpr uint32_t recordIds[] = {
    UINT32_C(0x3aac69fd), UINT32_C(0xea93e5f3), UINT32_C(0xf808b822)
  };
  for (uint32_t stableId : recordIds) {
    const records::Operation* operation = records::find(stableId);
    expect(operation && operation->context == records::Context::kGlobal,
        "table-record route does not have exact global context");
    std::array<ScriptTableEntry, records::kMaximumFieldCount> table{};
    std::array<char, 128> strings{};
    ScriptValue result{};
    static constexpr char astcBytes[] = "astc-bytes";
    ScriptValue argument{};
    const ScriptValue* arguments = nullptr;
    if (operation->argumentCount) {
      argument.tag = ScriptValueTag::kString;
      argument.data = astcBytes;
      argument.length = sizeof(astcBytes) - 1;
      arguments = &argument;
    }
    expect(dispatchRecord(adapter, *operation, table.data(), table.size(),
        strings.data(), strings.size(), &result, arguments), adapter.lastError());
    expect(result.tag == ScriptValueTag::kTable && result.data == table.data() &&
        result.length == operation->fieldCount,
    "table-record result did not use caller-owned bounded storage");
    for (uint8_t index = 0; index < operation->fieldCount; ++index) {
      const auto& field = records::fields()[operation->fieldOffset + index];
      expect(table[index].key.tag == ScriptValueTag::kString &&
          table[index].key.length == std::strlen(field.name) &&
          std::memcmp(table[index].key.data, field.name, table[index].key.length) == 0,
      "table-record fields were not normalized to descriptor order");
      expect(table[index].value.tag == (field.codec == records::Codec::kString
          ? ScriptValueTag::kString : ScriptValueTag::kNumber),
      "table-record field codec was not preserved");
    }
  }
  expect(gRecordCalls == records::kCandidateCount,
      "not every table-record candidate crossed the real Lua stack");

  const records::Operation* astcRecord = records::find(UINT32_C(0xea93e5f3));
  expect(astcRecord != nullptr, "ASTC table-record route is absent");
  static constexpr char astcBytes[] = "astc-bytes";
  ScriptValue astcArgument{};
  astcArgument.tag = ScriptValueTag::kString;
  astcArgument.data = astcBytes;
  astcArgument.length = sizeof(astcBytes) - 1;
  for (RecordMode mode : {RecordMode::kMissingField, RecordMode::kExtraField, RecordMode::kWrongType}) {
    gRecordMode = mode;
    std::array<ScriptTableEntry, records::kMaximumFieldCount> table{};
    std::array<char, 128> strings{};
    ScriptValue result{};
    expect(!dispatchRecord(adapter, *astcRecord, table.data(), table.size(),
        strings.data(), strings.size(), &result, &astcArgument),
    "malformed Lua fixed record was accepted");
    expect(result.tag == ScriptValueTag::kUndefined,
        "malformed Lua fixed record exposed a partial result");
  }
  gRecordMode = RecordMode::kValid;
  {
    std::array<ScriptTableEntry, records::kMaximumFieldCount - 1> table{};
    std::array<char, 128> strings{};
    ScriptValue result{};
    const uint64_t calls = gRecordCalls;
    expect(!dispatchRecord(adapter, *astcRecord, table.data(), table.size(),
        strings.data(), strings.size(), &result, &astcArgument),
    "exhausted caller-owned table scratch was accepted");
    expect(gRecordCalls == calls && std::strstr(adapter.lastError(), "scratch is exhausted"),
        "table scratch exhaustion was not rejected before Lua dispatch");
  }

  lua_pushlightuserdata(state, gExpectedInstance);
  expect(adapter.captureInstance(-1), "instance capture failed");
  lua_pop(state, 1);

  size_t tailRouteCount = 0;
  for (size_t index = 0; index < tail::kRouteCount; ++index) {
    const auto& route = tail::routes()[index];
    if (route.disposition != tail::Disposition::kCandidate) continue;
    ScriptMatrix4Arena matrices{};
    ScriptUrlArena<> urls(91);
    ScriptValue result{};
    const size_t shape = tail::candidateRouteOffsets()[route.candidateIndex];
    expect(dispatchTail(adapter, route, shape, matrices, urls, &result), adapter.lastError());
    ++tailRouteCount;
  }
  expect(tailRouteCount == tail::kCandidateCount && gTailCalls == tail::kCandidateCount,
      "not every value-tail candidate crossed the real Lua stack");

  for (size_t index = 0; index < overload::kBindingCount; ++index) {
    const auto& operation = overload::operations()[index];
    const auto& shape = overload::shapes()[operation.shapeOffset];
    ScriptMatrix4Arena matrices{};
    std::array<ScriptValue, 6> arguments{};
    for (uint8_t argument = 0; argument < shape.argumentCount; ++argument) {
      arguments[argument] = overloadArgument(overload::argumentCodecs()[shape.argumentOffset + argument], matrices);
    }
    ScriptValue result{};
    ScriptCallFrame frame{};
    frame.stableId=operation.stableId; frame.arguments=arguments.data(); frame.argumentCount=shape.argumentCount;
    frame.results=&result; frame.resultCapacity=1; frame.matrix4Arena=&matrices;
    expect(adapter.dispatch(&frame), adapter.lastError());
  }
  expect(gOverloadCalls == overload::kBindingCount,
      "not every overload-dispatch candidate crossed the real Lua stack");

  const tail::Route* reentrant = tail::find(UINT32_C(0x15d12427));
  expect(reentrant != nullptr, "reentrant route is absent");
  ScriptMatrix4Arena reentrantMatrices{};
  ScriptUrlArena<> reentrantUrls(92);
  ScriptValue reentrantResult{};
  gRunReentrantCall = true;
  expect(dispatchTail(adapter, *reentrant, tail::candidateRouteOffsets()[reentrant->candidateIndex],
      reentrantMatrices, reentrantUrls, &reentrantResult), adapter.lastError());
  expect(!gRunReentrantCall && hasExpectedInstance(state), "reentrant dispatch did not restore the Lua instance");

  const tail::Route* matrixResult = tail::find(UINT32_C(0x3ac6e427));
  expect(matrixResult != nullptr, "Matrix4 result route is absent");
  ScriptMatrix4Arena exhausted{};
  exhausted.used = ScriptMatrix4Arena::kCapacity;
  ScriptUrlArena<> resultUrls(93);
  ScriptValue result{};
  expect(!dispatchTail(adapter, *matrixResult,
      tail::candidateRouteOffsets()[matrixResult->candidateIndex], exhausted, resultUrls, &result),
      "exhausted Matrix4 result arena was accepted");
  expect(std::strstr(adapter.lastError(), "exhausted") != nullptr, "Matrix4 exhaustion was not diagnostic");

  const tail::Route* matrixInput = tail::find(UINT32_C(0x870d05d3));
  expect(matrixInput != nullptr, "Matrix4 input route is absent");
  ScriptMatrix4Arena staleMatrices{};
  ScriptValue stale{};
  alignas(16) const float identity[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
  expect(staleMatrices.store(identity, &stale), "stale Matrix4 setup failed");
  staleMatrices.rewind(0);
  static constexpr char target[] = "generated";
  std::array<ScriptValue, 2> staleArguments{};
  staleArguments[0] = stale;
  staleArguments[1].tag = ScriptValueTag::kString;
  staleArguments[1].data = target;
  staleArguments[1].length = sizeof(target) - 1;
  ScriptCallFrame staleFrame{};
  staleFrame.stableId=matrixInput->stableId; staleFrame.arguments=staleArguments.data(); staleFrame.argumentCount=staleArguments.size();
  staleFrame.results=&result; staleFrame.resultCapacity=1; staleFrame.matrix4Arena=&staleMatrices;
  expect(!adapter.dispatch(&staleFrame), "stale Matrix4 token was accepted");
  expect(std::strstr(adapter.lastError(), "stale") != nullptr, "stale Matrix4 failure was not diagnostic");

  const tail::Route* hot = tail::find(UINT32_C(0xc4aec785));
  expect(hot != nullptr, "allocation route is absent");
  ScriptMatrix4Arena hotMatrices{};
  ScriptUrlArena<> hotUrls(94);
  expect(dispatchTail(adapter, *hot, tail::candidateRouteOffsets()[hot->candidateIndex],
      hotMatrices, hotUrls, &result), "allocation warmup failed");
  const uint64_t baseline = gAllocations.load(std::memory_order_relaxed);
  gTrackAllocations.store(true, std::memory_order_relaxed);
  for (size_t iteration = 0; iteration < 1024; ++iteration) {
    expect(dispatchTail(adapter, *hot, tail::candidateRouteOffsets()[hot->candidateIndex],
        hotMatrices, hotUrls, &result), "allocation loop failed");
  }
  for (size_t iteration = 0; iteration < 1024; ++iteration) {
    std::array<ScriptTableEntry, records::kMaximumFieldCount> table{};
    std::array<char, 128> strings{};
    expect(dispatchRecord(adapter, *astcRecord, table.data(), table.size(),
        strings.data(), strings.size(), &result, &astcArgument),
    "table-record allocation loop failed");
  }
  gTrackAllocations.store(false, std::memory_order_relaxed);
  expect(gAllocations.load(std::memory_order_relaxed) == baseline,
      "warmed captured-Lua router allocated through C++ new");

  expect(lua_gettop(state) == 0 && hasExpectedInstance(state), "Lua stack or instance leaked across router calls");
  adapter.shutdown();
  lua_close(state);
  std::printf("script-captured-lua-router:tail:%zu:ok\n", tailRouteCount);
  std::printf("script-captured-lua-router:overload:%zu:ok\n", overload::kBindingCount);
  std::printf("script-captured-lua-router:table-record:%zu:ok\n", records::kCandidateCount);
  std::puts("script-captured-lua-router:reentrant-stale-exhaustion:ok");
  std::puts("script-captured-lua-router:allocations:0");
}
