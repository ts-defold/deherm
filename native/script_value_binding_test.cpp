#include <defold_hermes/generated_script_value_bindings.hpp>
#include <defold_hermes/active_game_object_context.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>

namespace value = defold_hermes::value_binding;
namespace game_object = defold_hermes::game_object;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptMatrix4Arena;
using defold_hermes::ScriptMatrix4ArenaMark;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;
using defold_hermes::ScriptTableEntry;
namespace scalar = defold_hermes::lua_bridge::scalar;

namespace dmScript {
void PushHash(lua_State* state, dmhash_t hash) {
  *static_cast<dmhash_t*>(lua_newuserdata(state, sizeof(dmhash_t))) = hash;
}
dmhash_t* ToHash(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmhash_t*>(lua_touserdata(state, index)) : nullptr;
}
void PushVector3(lua_State* state, const dmVMath::Vector3& value) {
  *static_cast<dmVMath::Vector3*>(lua_newuserdata(state, sizeof(dmVMath::Vector3))) = value;
}
void PushVector4(lua_State* state, const dmVMath::Vector4& value) {
  *static_cast<dmVMath::Vector4*>(lua_newuserdata(state, sizeof(dmVMath::Vector4))) = value;
}
void PushQuat(lua_State* state, const dmVMath::Quat& value) {
  *static_cast<dmVMath::Quat*>(lua_newuserdata(state, sizeof(dmVMath::Quat))) = value;
}
void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value) {
  *static_cast<dmVMath::Matrix4*>(lua_newuserdata(state, sizeof(dmVMath::Matrix4))) = value;
}
dmVMath::Vector3* ToVector3(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector3*>(lua_touserdata(state, index)) : nullptr;
}
dmVMath::Quat* ToQuat(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmVMath::Quat*>(lua_touserdata(state, index)) : nullptr;
}
dmVMath::Vector4* ToVector4(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmVMath::Vector4*>(lua_touserdata(state, index)) : nullptr;
}
dmVMath::Matrix4* ToMatrix4(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmVMath::Matrix4*>(lua_touserdata(state, index)) : nullptr;
}
void PushURL(lua_State* state, const dmMessage::URL& value) {
  *static_cast<dmMessage::URL*>(lua_newuserdata(state, sizeof(dmMessage::URL))) = value;
}
dmMessage::URL* ToURL(lua_State* state, int index) {
  return lua_isuserdata(state, index) ? static_cast<dmMessage::URL*>(lua_touserdata(state, index)) : nullptr;
}
}  // namespace dmScript

namespace {
std::atomic<bool> gTrackAllocations{false};
std::atomic<uint64_t> gAllocations{0};

struct FakeInstance {
  void* collection = nullptr;
  uint64_t identifier = 0;
  uint32_t generation = 0;
  float position[3]{};
  float rotation[4]{0, 0, 0, 1};
};

struct AttachmentTable {
  std::array<uint32_t, 4> generations{};
  std::array<bool, 4> live{};
};

struct TerminalCounters {
  uint64_t pointerReads = 0;
  uint64_t gets = 0;
  uint64_t positionSets = 0;
  uint64_t rotationSets = 0;
};

int gLuaInstanceKey = 0;
void* gExpectedLuaInstance = nullptr;
uint64_t gMsgCalls = 0;
uint64_t gFactoryCalls = 0;
uint64_t gDeleteCalls = 0;
uint64_t gGuiLookupCalls = 0;
uint64_t gGuiTextCalls = 0;
uint64_t gGuiSetterCalls = 0;
int gNodeToken = 0;
bool gTupleWrongArity = false;
bool gTupleWrongTag = false;

void GetLuaInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gLuaInstanceKey);
  lua_rawget(state, LUA_REGISTRYINDEX);
}

void SetLuaInstance(lua_State* state) {
  lua_pushlightuserdata(state, &gLuaInstanceKey);
  lua_insert(state, -2);
  lua_rawset(state, LUA_REGISTRYINDEX);
}

bool HasExpectedLuaInstance(lua_State* state) {
  GetLuaInstance(state);
  const bool matches = lua_touserdata(state, -1) == gExpectedLuaInstance;
  lua_pop(state, 1);
  return matches;
}

int MockMsgPost(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured msg instance");
  size_t addressLength = 0;
  size_t messageLength = 0;
  const char* address = luaL_checklstring(state, 1, &addressLength);
  const char* message = luaL_checklstring(state, 2, &messageLength);
  if (addressLength != 1 || address[0] != '.' || messageLength != 20 ||
      std::memcmp(message, "deherm_probe_message", 20) != 0) {
    return luaL_error(state, "msg arguments differ");
  }
  if (lua_gettop(state) == 3) {
    luaL_checktype(state, 3, LUA_TTABLE);
    lua_getfield(state, 3, "damage");
    if (lua_tonumber(state, -1) != 42) return luaL_error(state, "msg table was not marshalled");
    lua_pop(state, 1);
  }
  ++gMsgCalls;
  return 0;
}

int MockFactoryCreate(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured factory instance");
  luaL_checkstring(state, 1);
  if (lua_gettop(state) == 4) {
    if (!lua_isuserdata(state, 2) || !lua_isnil(state, 3) || !lua_istable(state, 4)) {
      return luaL_error(state, "factory structured arguments differ");
    }
  }
  ++gFactoryCalls;
  dmScript::PushHash(state, UINT64_C(0x1020304050607080));
  return 1;
}

int MockGoDelete(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured go instance");
  if (lua_gettop(state) == 1 && !lua_isuserdata(state, 1)) return luaL_error(state, "delete hash differs");
  ++gDeleteCalls;
  return 0;
}

int MockGuiGetNode(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  size_t length = 0;
  const char* name = luaL_checklstring(state, 1, &length);
  if (length == 0 || !name) return luaL_error(state, "node name differs");
  *static_cast<int*>(lua_newuserdata(state, sizeof(int))) = gNodeToken;
  ++gGuiLookupCalls;
  return 1;
}

int MockGuiNumberSetter(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  if (lua_gettop(state) != 2 || !lua_isuserdata(state, 1) || !lua_isnumber(state, 2)) {
    return luaL_error(state, "numeric GUI setter arguments differ");
  }
  ++gGuiSetterCalls;
  return 0;
}

int MockGuiBooleanSetter(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  if (lua_gettop(state) != 2 || !lua_isuserdata(state, 1) || !lua_isboolean(state, 2)) {
    return luaL_error(state, "boolean GUI setter arguments differ");
  }
  ++gGuiSetterCalls;
  return 0;
}

int MockGuiUserdataSetter(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  if (lua_gettop(state) != 2 || !lua_isuserdata(state, 1) || !lua_isuserdata(state, 2)) {
    return luaL_error(state, "userdata GUI setter arguments differ");
  }
  ++gGuiSetterCalls;
  return 0;
}

int MockGuiStringSetter(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  if (lua_gettop(state) != 2 || !lua_isuserdata(state, 1) || !lua_isstring(state, 2)) {
    return luaL_error(state, "string GUI setter arguments differ");
  }
  ++gGuiSetterCalls;
  return 0;
}

int MockGuiParentSetter(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  const int count = lua_gettop(state);
  if (count < 1 || count > 3 || !lua_isuserdata(state, 1) ||
      (count >= 2 && !lua_isnil(state, 2) && !lua_isuserdata(state, 2)) ||
      (count == 3 && !lua_isboolean(state, 3))) {
    return luaL_error(state, "parent GUI setter arguments differ");
  }
  ++gGuiSetterCalls;
  return 0;
}

int MockGuiSetText(lua_State* state) {
  if (!HasExpectedLuaInstance(state)) return luaL_error(state, "wrong captured gui instance");
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "node is not userdata");
  size_t length = 0;
  const char* text = luaL_checklstring(state, 2, &length);
  if (!((length == 5 && std::memcmp(text, "READY", 5) == 0) ||
        (length == 4 && std::memcmp(text, "12.5", 4) == 0))) {
    return luaL_error(state, "text differs");
  }
  ++gGuiTextCalls;
  return 0;
}

int MockWindowGetSize(lua_State* state) {
  if (gTupleWrongTag) { lua_pushliteral(state, "wide"); lua_pushnumber(state, 720); return 2; }
  lua_pushnumber(state, 1280); if (gTupleWrongArity) return 1; lua_pushnumber(state, 720); return 2;
}
int MockQuatToEuler(lua_State* state) {
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "quat_to_euler argument differs");
  lua_pushnumber(state, 10); lua_pushnumber(state, 20); lua_pushnumber(state, 30); return 3;
}
int MockGuiGetType(lua_State* state) {
  if (!HasExpectedLuaInstance(state) || !lua_isuserdata(state, 1)) return luaL_error(state, "get_type context or node differs");
  lua_pushnumber(state, 4); lua_pushnil(state); return 2;
}
int MockBulletWorldTransform(lua_State* state) {
  if (!lua_isuserdata(state, 1)) return luaL_error(state, "bullet object differs");
  dmScript::PushVector3(state, dmVMath::Vector3(1, 2, 3));
  dmScript::PushQuat(state, dmVMath::Quat(0, 0, 0, 1));
  return 2;
}
int MockBullet6Dof(lua_State* state) {
  if (!lua_isuserdata(state, 1) || lua_tonumber(state, 2) != 2) return luaL_error(state, "6dof arguments differ");
  lua_pushboolean(state, 1); lua_pushnumber(state, 1.25); lua_pushnumber(state, 2.5); lua_pushnumber(state, 5); return 4;
}
int MockCollectionSet(lua_State* state) {
  if (!HasExpectedLuaInstance(state) || (lua_gettop(state) && !lua_isstring(state, 1) && !lua_isuserdata(state, 1)) ||
      (lua_gettop(state) > 1 && !lua_isnil(state, 2) && !lua_isstring(state, 2))) return luaL_error(state, "collection context differs");
  lua_pushboolean(state, 1); lua_pushnumber(state, 0); return 2;
}
int MockGuiNewTexture(lua_State* state) {
  if (!HasExpectedLuaInstance(state) || lua_gettop(state)!=6 || !lua_isuserdata(state,1) ||
      !lua_isnumber(state,2) || !lua_isnumber(state,3) || !lua_isstring(state,4) ||
      !lua_isstring(state,5) || !lua_isboolean(state,6)) return luaL_error(state,"new_texture arguments differ");
  lua_pushboolean(state,1); lua_pushnil(state); return 2;
}

void RegisterLuaFunction(lua_State* state, const char* module, const char* member, lua_CFunction function) {
  lua_getglobal(state, module);
  if (!lua_istable(state, -1)) {
    lua_pop(state, 1);
    lua_newtable(state);
  }
  lua_pushcfunction(state, function);
  lua_setfield(state, -2, member);
  lua_setglobal(state, module);
}

void RegisterNestedLuaFunction(lua_State* state, const char* root, const char* nested,
    const char* member, lua_CFunction function) {
  lua_getglobal(state, root);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); lua_newtable(state); }
  lua_getfield(state, -1, nested);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); lua_newtable(state); }
  lua_pushcfunction(state, function); lua_setfield(state, -2, member);
  lua_setfield(state, -2, nested); lua_setglobal(state, root);
}

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "script-value-binding:error:%s\n", message);
  std::exit(1);
}

void Expect(bool condition, const char* message) { if (!condition) Fail(message); }
bool Near(float left, float right, float epsilon = 0.00001f) { return std::fabs(left - right) <= epsilon; }

uint32_t GetGeneration(void* userData, void* instance) noexcept {
  ++static_cast<TerminalCounters*>(userData)->pointerReads;
  return static_cast<FakeInstance*>(instance)->generation;
}
void* GetCollection(void* userData, void* instance) noexcept {
  ++static_cast<TerminalCounters*>(userData)->pointerReads;
  return static_cast<FakeInstance*>(instance)->collection;
}
uint64_t GetIdentifier(void* userData, void* instance) noexcept {
  ++static_cast<TerminalCounters*>(userData)->pointerReads;
  return static_cast<FakeInstance*>(instance)->identifier;
}
void GetPosition(void* userData, void* instance, float* xyz) noexcept {
  auto* counters = static_cast<TerminalCounters*>(userData);
  ++counters->gets;
  const auto* value = static_cast<FakeInstance*>(instance);
  for (size_t index = 0; index < 3; ++index) xyz[index] = value->position[index];
}
void SetPosition(void* userData, void* instance, const float* xyz) noexcept {
  ++static_cast<TerminalCounters*>(userData)->positionSets;
  auto* value = static_cast<FakeInstance*>(instance);
  for (size_t index = 0; index < 3; ++index) value->position[index] = xyz[index];
}
void SetRotation(void* userData, void* instance, const float* xyzw) noexcept {
  ++static_cast<TerminalCounters*>(userData)->rotationSets;
  auto* value = static_cast<FakeInstance*>(instance);
  for (size_t index = 0; index < 4; ++index) value->rotation[index] = xyzw[index];
}
bool IsAttachmentLive(void* owner, uint32_t slot, uint32_t generation) noexcept {
  const auto* table = static_cast<const AttachmentTable*>(owner);
  return slot < table->live.size() && table->live[slot] && table->generations[slot] == generation;
}

game_object::ActiveContext Context(
    FakeInstance& instance,
    AttachmentTable& attachments,
    uint32_t slot) {
  game_object::ActiveContext context;
  context.instance = &instance;
  context.collection = instance.collection;
  context.identifier = instance.identifier;
  context.instanceGeneration = instance.generation;
  context.attachment = {&attachments, slot, attachments.generations[slot], IsAttachmentLive};
  return context;
}

ScriptValue Number(double number) {
  ScriptValue value;
  value.tag = ScriptValueTag::kNumber;
  value.number = number;
  return value;
}

ScriptValue Boolean(bool boolean) {
  ScriptValue value;
  value.tag = ScriptValueTag::kBoolean;
  value.number = boolean ? 1.0 : 0.0;
  return value;
}

ScriptValue Hash(uint64_t hash) {
  ScriptValue value;
  value.tag = ScriptValueTag::kHandle;
  value.handleKind = ScriptHandleKind::kHash;
  value.payload = hash;
  return value;
}

ScriptValue String(const char* text, uint32_t length) {
  ScriptValue value;
  value.tag = ScriptValueTag::kString;
  value.data = text;
  value.length = length;
  return value;
}

ScriptValue Value(ScriptDefoldValueKind kind, float x, float y, float z, float w = 0.0f) {
  ScriptValue value;
  value.tag = ScriptValueTag::kDefoldValue;
  value.defoldKind = kind;
  value.defoldValue[0] = x;
  value.defoldValue[1] = y;
  value.defoldValue[2] = z;
  value.defoldValue[3] = w;
  return value;
}

ScriptValue Nil() {
  ScriptValue value;
  value.tag = ScriptValueTag::kNull;
  return value;
}

ScriptValue Table(const ScriptTableEntry* entries, uint32_t count) {
  ScriptValue value;
  value.tag = ScriptValueTag::kTable;
  value.data = entries;
  value.length = count;
  return value;
}

bool AdapterDispatch(
    scalar::ScriptAdapter& adapter,
    value::BindingId id,
    const ScriptValue* arguments,
    uint32_t count,
    ScriptValue* result,
    uint32_t* resultCount = nullptr) {
  ScriptCallFrame frame;
  frame.stableId = static_cast<uint32_t>(id);
  frame.arguments = arguments;
  frame.argumentCount = count;
  frame.results = result;
  frame.resultCapacity = result ? 1 : 0;
  const bool ok = adapter.dispatch(&frame);
  if (resultCount) *resultCount = frame.resultCount;
  return ok;
}

bool AdapterDispatchTuple(scalar::ScriptAdapter& adapter, uint32_t stableId,
    const ScriptValue* arguments, uint32_t count, ScriptValue* results,
    uint32_t capacity, uint32_t* resultCount, char* scratch = nullptr,
    uint32_t scratchCapacity = 0) {
  ScriptCallFrame frame;
  frame.stableId=stableId; frame.arguments=arguments; frame.argumentCount=count;
  frame.results=results; frame.resultCapacity=capacity; frame.stringScratch=scratch;
  frame.stringScratchCapacity=scratchCapacity;
  const bool ok=adapter.dispatch(&frame); if(resultCount)*resultCount=frame.resultCount; return ok;
}

ScriptValue Call(value::BindingId id, const ScriptValue* arguments, uint32_t count) {
  ScriptValue result;
  ScriptCallFrame frame;
  frame.stableId = static_cast<uint32_t>(id);
  frame.arguments = arguments;
  frame.argumentCount = count;
  frame.results = &result;
  frame.resultCapacity = 1;
  char error[256]{};
  Expect(value::dispatch(&frame, error, sizeof(error)) == value::DispatchStatus::kSuccess, error);
  Expect(frame.resultCount == 1, "value call did not return exactly one result");
  return result;
}

ScriptValue MatrixCall(
    ScriptMatrix4Arena& arena,
    value::BindingId id,
    const ScriptValue* arguments,
    uint32_t count) {
  ScriptValue result;
  ScriptCallFrame frame;
  frame.stableId = static_cast<uint32_t>(id);
  frame.arguments = arguments;
  frame.argumentCount = count;
  frame.results = &result;
  frame.resultCapacity = 1;
  frame.matrix4Arena = &arena;
  char error[256]{};
  Expect(value::dispatch(&frame, error, sizeof(error)) == value::DispatchStatus::kSuccess, error);
  Expect(frame.resultCount == 1, "Matrix4 call did not return exactly one result");
  return result;
}

const float* MatrixElements(const ScriptMatrix4Arena& arena, const ScriptValue& value) {
  const float* elements = arena.resolve(value);
  Expect(elements != nullptr, "Matrix4 result token did not resolve in its frame arena");
  return elements;
}

void ExpectMatrix(
    const ScriptMatrix4Arena& arena,
    const ScriptValue& value,
    const float (&expected)[16],
    const char* message,
    float epsilon = 0.00001f) {
  const float* elements = MatrixElements(arena, value);
  for (size_t index = 0; index < 16; ++index) {
    if (!Near(elements[index], expected[index], epsilon)) Fail(message);
  }
}

value::DispatchStatus Dispatch(
    value::BindingId id,
    const ScriptValue* arguments,
    uint32_t count,
    ScriptValue* result,
    uint32_t* resultCount,
    char* error,
    size_t errorCapacity) {
  ScriptCallFrame frame;
  frame.stableId = static_cast<uint32_t>(id);
  frame.arguments = arguments;
  frame.argumentCount = count;
  frame.results = result;
  frame.resultCapacity = result ? 1 : 0;
  const auto status = value::dispatch(&frame, error, errorCapacity);
  if (resultCount) *resultCount = frame.resultCount;
  return status;
}

void CallVoid(value::BindingId id, const ScriptValue* arguments, uint32_t count) {
  uint32_t resultCount = UINT32_MAX;
  char error[256]{};
  Expect(Dispatch(id, arguments, count, nullptr, &resultCount, error, sizeof(error)) ==
      value::DispatchStatus::kSuccess, error);
  Expect(resultCount == 0, "void GO call returned a value");
}

void ProveBoundedDepth(const game_object::ActiveContext& context, uint32_t remaining) {
  game_object::Scope scope(context);
  Expect(scope.entered(), "GO context stack rejected a frame below its fixed bound");
  if (remaining > 1) {
    ProveBoundedDepth(context, remaining - 1);
    return;
  }
  Expect(game_object::activeDepth() == game_object::kMaximumContextDepth,
      "GO context stack did not reach its declared bound");
  game_object::Scope overflow(context);
  Expect(!overflow.entered(), "GO context stack accepted a frame beyond its fixed bound");
  Expect(game_object::activeDepth() == game_object::kMaximumContextDepth,
      "rejected GO context frame changed stack depth");
}
}

void* operator new(std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) gAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* pointer = std::malloc(size)) return pointer;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete[](void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { std::free(pointer); }

int main() {
  const char hashText[] = "my_hash";
  ScriptValue hashArgument = String(hashText, 7);
  ScriptValue hash = Call(value::BindingId::Hash, &hashArgument, 1);
  Expect(hash.tag == ScriptValueTag::kHandle && hash.handleKind == ScriptHandleKind::kHash,
      "hash did not return an exact handle value");
  Expect(hash.payload == UINT64_C(0xa2bc06d97f580aab), "hash payload differs from pinned Defold semantics");

  ScriptValue zero = Call(value::BindingId::VmathVector3, nullptr, 0);
  Expect(zero.defoldKind == ScriptDefoldValueKind::kVector3 && Near(zero.defoldValue[0], 0), "vector3 zero overload failed");

  ScriptValue splatArgument = Number(2.5);
  ScriptValue splat = Call(value::BindingId::VmathVector3, &splatArgument, 1);
  Expect(Near(splat.defoldValue[0], 2.5f) && Near(splat.defoldValue[1], 2.5f) && Near(splat.defoldValue[2], 2.5f), "vector3 splat overload failed");

  ScriptValue components[] = {Number(3), Number(4), Number(0)};
  ScriptValue vector = Call(value::BindingId::VmathVector3, components, 3);
  ScriptValue copy = Call(value::BindingId::VmathVector3, &vector, 1);
  Expect(Near(copy.defoldValue[0], 3) && Near(copy.defoldValue[1], 4), "vector3 copy overload failed");
  ScriptValue length = Call(value::BindingId::VmathLength, &vector, 1);
  Expect(length.tag == ScriptValueTag::kNumber && Near(static_cast<float>(length.number), 5), "vector3 length failed");
  ScriptValue normalized = Call(value::BindingId::VmathNormalize, &vector, 1);
  Expect(normalized.defoldKind == ScriptDefoldValueKind::kVector3 && Near(normalized.defoldValue[0], 0.6f) && Near(normalized.defoldValue[1], 0.8f), "vector3 normalize failed");
  ScriptValue normalizedZero = Call(value::BindingId::VmathNormalize, &zero, 1);
  Expect(std::isnan(normalizedZero.defoldValue[0]), "zero-vector normalize did not preserve Defold NaN semantics");
  ScriptValue rejectedNaNResult;
  uint32_t rejectedNaNCount = UINT32_MAX;
  char rejectedNaNError[256]{};
  Expect(Dispatch(value::BindingId::VmathLength, &normalizedZero, 1, &rejectedNaNResult,
      &rejectedNaNCount, rejectedNaNError, sizeof(rejectedNaNError)) == value::DispatchStatus::kError,
      "vmath.length accepted a NaN Defold-value component");
  Expect(Dispatch(value::BindingId::VmathVector3, &normalizedZero, 1, &rejectedNaNResult,
      &rejectedNaNCount, rejectedNaNError, sizeof(rejectedNaNError)) == value::DispatchStatus::kError,
      "vmath.vector3 copy accepted a NaN Defold-value component");

  ScriptValue vector4 = Value(ScriptDefoldValueKind::kVector4, 1, 2, 2, 1);
  ScriptValue vector4Length = Call(value::BindingId::VmathLength, &vector4, 1);
  Expect(Near(static_cast<float>(vector4Length.number), std::sqrt(10.0f)), "vector4 length failed");
  ScriptValue vector4Normalized = Call(value::BindingId::VmathNormalize, &vector4, 1);
  Expect(vector4Normalized.defoldKind == ScriptDefoldValueKind::kVector4 &&
      Near(vector4Normalized.defoldValue[0], 1.0f / std::sqrt(10.0f)), "vector4 normalize failed");

  ScriptValue quatIdentity = Call(value::BindingId::VmathQuat, nullptr, 0);
  Expect(quatIdentity.defoldKind == ScriptDefoldValueKind::kQuaternion && Near(quatIdentity.defoldValue[3], 1), "quat identity overload failed");
  ScriptValue quatComponents[] = {Number(1), Number(2), Number(3), Number(4)};
  ScriptValue quat = Call(value::BindingId::VmathQuat, quatComponents, 4);
  ScriptValue quatCopy = Call(value::BindingId::VmathQuat, &quat, 1);
  Expect(Near(quatCopy.defoldValue[0], 1) && Near(quatCopy.defoldValue[3], 4), "quat copy overload failed");
  ScriptValue quatLength = Call(value::BindingId::VmathLength, &quat, 1);
  Expect(Near(static_cast<float>(quatLength.number), std::sqrt(30.0f)), "quaternion length failed");
  ScriptValue quatNormalized = Call(value::BindingId::VmathNormalize, &quat, 1);
  Expect(quatNormalized.defoldKind == ScriptDefoldValueKind::kQuaternion &&
      Near(quatNormalized.defoldValue[3], 4.0f / std::sqrt(30.0f)), "quaternion normalize failed");
  ScriptValue angle = Number(3.141592653589793);
  ScriptValue rotation = Call(value::BindingId::VmathQuatRotationZ, &angle, 1);
  Expect(rotation.defoldKind == ScriptDefoldValueKind::kQuaternion && Near(rotation.defoldValue[2], 1) && Near(rotation.defoldValue[3], 0, 0.000001f), "quat_rotation_z failed");

  ScriptValue conjugated = Call(value::BindingId::VmathConj, &quat, 1);
  Expect(Near(conjugated.defoldValue[0], -1) && Near(conjugated.defoldValue[1], -2) &&
      Near(conjugated.defoldValue[2], -3) && Near(conjugated.defoldValue[3], 4),
      "generated quaternion conjugate failed");
  ScriptValue unitX = Value(ScriptDefoldValueKind::kVector3, 1, 0, 0);
  ScriptValue unitY = Value(ScriptDefoldValueKind::kVector3, 0, 1, 0);
  ScriptValue unitZ = Value(ScriptDefoldValueKind::kVector3, 0, 0, 1);
  ScriptValue crossArguments[] = {unitX, unitY};
  ScriptValue crossed = Call(value::BindingId::VmathCross, crossArguments, 2);
  Expect(Near(crossed.defoldValue[0], 0) && Near(crossed.defoldValue[1], 0) &&
      Near(crossed.defoldValue[2], 1), "generated vector3 cross failed");

  ScriptValue eulerVector = Value(ScriptDefoldValueKind::kVector3, 0, 0, 90);
  ScriptValue eulerFromVector = Call(value::BindingId::VmathEulerToQuat, &eulerVector, 1);
  ScriptValue eulerNumbers[] = {Number(0), Number(0), Number(90)};
  ScriptValue eulerFromNumbers = Call(value::BindingId::VmathEulerToQuat, eulerNumbers, 3);
  for (size_t index = 0; index < 4; ++index) {
    Expect(Near(eulerFromVector.defoldValue[index], eulerFromNumbers.defoldValue[index], 0.000001f),
        "euler_to_quat overloads diverged");
  }

  ScriptValue vectorLengthSquared = Call(value::BindingId::VmathLengthSqr, &vector, 1);
  ScriptValue vector4LengthSquared = Call(value::BindingId::VmathLengthSqr, &vector4, 1);
  ScriptValue quatLengthSquared = Call(value::BindingId::VmathLengthSqr, &quat, 1);
  Expect(Near(static_cast<float>(vectorLengthSquared.number), 25) &&
      Near(static_cast<float>(vector4LengthSquared.number), 10) &&
      Near(static_cast<float>(quatLengthSquared.number), 30),
      "generated length_sqr union failed");

  ScriptValue projectArguments[] = {
    Value(ScriptDefoldValueKind::kVector3, 1, 1, 0),
    Value(ScriptDefoldValueKind::kVector3, 2, 0, 0)
  };
  ScriptValue projected = Call(value::BindingId::VmathProject, projectArguments, 2);
  Expect(Near(static_cast<float>(projected.number), 0.5f), "generated vector3 project failed");

  ScriptValue axisArguments[] = {unitZ, angle};
  ScriptValue axisRotation = Call(value::BindingId::VmathQuatAxisAngle, axisArguments, 2);
  Expect(Near(axisRotation.defoldValue[2], 1) && Near(axisRotation.defoldValue[3], 0, 0.000001f),
      "generated quaternion axis-angle failed");
  ScriptValue nonUnitAxisArguments[] = {
    Value(ScriptDefoldValueKind::kVector3, 0, 0, 2), angle
  };
  ScriptValue nonNormalizedAxis = Call(value::BindingId::VmathQuatAxisAngle, nonUnitAxisArguments, 2);
  Expect(Near(nonNormalizedAxis.defoldValue[2], 2),
      "quaternion axis-angle unexpectedly normalized the caller's axis");

  ScriptValue basisArguments[] = {unitX, unitY, unitZ};
  ScriptValue basisRotation = Call(value::BindingId::VmathQuatBasis, basisArguments, 3);
  Expect(Near(basisRotation.defoldValue[0], 0) && Near(basisRotation.defoldValue[1], 0) &&
      Near(basisRotation.defoldValue[2], 0) && Near(basisRotation.defoldValue[3], 1),
      "generated quaternion basis failed");
  ScriptValue fromTo = Call(value::BindingId::VmathQuatFromTo, crossArguments, 2);
  Expect(Near(fromTo.defoldValue[2], 0.70710677f, 0.000001f) &&
      Near(fromTo.defoldValue[3], 0.70710677f, 0.000001f),
      "generated quaternion from-to failed");
  ScriptValue rotationX = Call(value::BindingId::VmathQuatRotationX, &angle, 1);
  ScriptValue rotationY = Call(value::BindingId::VmathQuatRotationY, &angle, 1);
  Expect(Near(rotationX.defoldValue[0], 1) && Near(rotationX.defoldValue[3], 0, 0.000001f) &&
      Near(rotationY.defoldValue[1], 1) && Near(rotationY.defoldValue[3], 0, 0.000001f),
      "generated quaternion axis rotations failed");
  ScriptValue preciseAngle = Number(16777217.0);
  ScriptValue narrowedRotation = Call(value::BindingId::VmathQuatRotationX, &preciseAngle, 1);
  const dmVMath::Quat expectedNarrowedRotation = dmVMath::Quat::rotationX(static_cast<float>(preciseAngle.number));
  Expect(Near(narrowedRotation.defoldValue[0], expectedNarrowedRotation.getX(), 0.000001f) &&
      Near(narrowedRotation.defoldValue[3], expectedNarrowedRotation.getW(), 0.000001f),
      "generated vmath scalar input did not preserve Lua-number to float32 narrowing");
  ScriptValue rotateArguments[] = {rotation, projectArguments[0]};
  ScriptValue rotatedVector = Call(value::BindingId::VmathRotate, rotateArguments, 2);
  Expect(Near(rotatedVector.defoldValue[0], -1, 0.000001f) &&
      Near(rotatedVector.defoldValue[1], -1, 0.000001f),
      "generated quaternion vector rotation failed");

  ScriptValue semanticFailureResult;
  uint32_t semanticFailureCount = UINT32_MAX;
  char semanticFailureError[256]{};
  ScriptValue invalidEulerArguments[] = {Number(0), Number(45)};
  Expect(Dispatch(value::BindingId::VmathEulerToQuat, invalidEulerArguments, 2, &semanticFailureResult,
      &semanticFailureCount, semanticFailureError, sizeof(semanticFailureError)) == value::DispatchStatus::kError,
      "euler_to_quat accepted the IR's misleading two-number optional shape");
  ScriptValue zeroProjectionArguments[] = {unitX, zero};
  Expect(Dispatch(value::BindingId::VmathProject, zeroProjectionArguments, 2, &semanticFailureResult,
      &semanticFailureCount, semanticFailureError, sizeof(semanticFailureError)) == value::DispatchStatus::kError,
      "vmath.project accepted a zero-length second vector");
  Expect(std::strstr(semanticFailureError, "length bigger than 0") != nullptr,
      "vmath.project zero-length failure was not diagnostic");
  ScriptValue nanCrossArguments[] = {normalizedZero, unitY};
  Expect(Dispatch(value::BindingId::VmathCross, nanCrossArguments, 2, &semanticFailureResult,
      &semanticFailureCount, semanticFailureError, sizeof(semanticFailureError)) == value::DispatchStatus::kError,
      "generated vmath fixed-POD family accepted a NaN Defold-value component");

  const float identityElements[16] = {
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  };
  const float translatedElements[16] = {
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 2, 3, 1
  };
  ScriptMatrix4Arena matrixArena;
  ScriptValue identityMatrix;
  Expect(matrixArena.store(identityElements, &identityMatrix), "Matrix4 arena rejected its first value");
  Expect(reinterpret_cast<uintptr_t>(MatrixElements(matrixArena, identityMatrix)) % 16 == 0,
      "Matrix4 arena storage is not 16-byte aligned");

  ScriptValue inverse = MatrixCall(matrixArena, value::BindingId::VmathInv, &identityMatrix, 1);
  ExpectMatrix(matrixArena, inverse, identityElements, "vmath.inv identity result differs");

  ScriptValue zeroAngle = Number(0);
  ScriptValue matrixAxisArguments[] = {unitZ, zeroAngle};
  ScriptValue matrixAxis = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4AxisAngle, matrixAxisArguments, 2);
  ExpectMatrix(matrixArena, matrixAxis, identityElements, "matrix4_axis_angle zero result differs");

  ScriptValue unitScale = Value(ScriptDefoldValueKind::kVector3, 1, 1, 1);
  ScriptValue zeroTranslation = Value(ScriptDefoldValueKind::kVector3, 0, 0, 0);
  ScriptValue composeVector3Arguments[] = {zeroTranslation, quatIdentity, unitScale};
  ScriptValue composedVector3 = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Compose, composeVector3Arguments, 3);
  ExpectMatrix(matrixArena, composedVector3, identityElements, "matrix4_compose Vector3 result differs");
  ScriptValue translationVector4 = Value(ScriptDefoldValueKind::kVector4, 1, 2, 3, 999);
  ScriptValue composeVector4Arguments[] = {translationVector4, quatIdentity, unitScale};
  ScriptValue composedVector4 = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Compose, composeVector4Arguments, 3);
  ExpectMatrix(matrixArena, composedVector4, translatedElements,
      "matrix4_compose Vector4 did not ignore w or preserve column-major translation");

  ScriptValue frustumArguments[] = {
    Number(-1), Number(1), Number(-1), Number(1), Number(1), Number(10)
  };
  const float projectionElements[16] = {
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -11.0f / 9.0f, -1,
    0, 0, -20.0f / 9.0f, 0
  };
  ScriptValue frustum = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Frustum, frustumArguments, 6);
  ExpectMatrix(matrixArena, frustum, projectionElements, "matrix4_frustum result differs");

  ScriptValue lookAtArguments[] = {
    Value(ScriptDefoldValueKind::kVector3, 0, 0, 1), zeroTranslation, unitY
  };
  const float lookAtElements[16] = {
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -1, 1
  };
  ScriptValue lookAt = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4LookAt, lookAtArguments, 3);
  ExpectMatrix(matrixArena, lookAt, lookAtElements, "matrix4_look_at result differs");

  ScriptValue orthographicArguments[] = {
    Number(-1), Number(1), Number(-1), Number(1), Number(-1), Number(1)
  };
  const float orthographicElements[16] = {
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1, 0,
    0, 0, 0, 1
  };
  ScriptValue orthographic = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Orthographic, orthographicArguments, 6);
  ExpectMatrix(matrixArena, orthographic, orthographicElements, "matrix4_orthographic result differs");

  ScriptValue perspectiveArguments[] = {
    Number(3.141592653589793 / 2.0), Number(1), Number(1), Number(10)
  };
  ScriptValue perspective = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Perspective, perspectiveArguments, 4);
  ExpectMatrix(matrixArena, perspective, projectionElements, "matrix4_perspective result differs", 0.000001f);
  ScriptValue matrixQuat = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Quat, &quatIdentity, 1);
  ExpectMatrix(matrixArena, matrixQuat, identityElements, "matrix4_quat identity result differs");
  ScriptValue matrixRotationX = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4RotationX, &zeroAngle, 1);
  ScriptValue matrixRotationY = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4RotationY, &zeroAngle, 1);
  ScriptValue matrixRotationZ = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4RotationZ, &zeroAngle, 1);
  ExpectMatrix(matrixArena, matrixRotationX, identityElements, "matrix4_rotation_x zero result differs");
  ExpectMatrix(matrixArena, matrixRotationY, identityElements, "matrix4_rotation_y zero result differs");
  ExpectMatrix(matrixArena, matrixRotationZ, identityElements, "matrix4_rotation_z zero result differs");

  ScriptValue translationVector3 = Value(ScriptDefoldValueKind::kVector3, 1, 2, 3);
  ScriptValue matrixTranslationVector3 = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Translation, &translationVector3, 1);
  ScriptValue matrixTranslationVector4 = MatrixCall(
      matrixArena, value::BindingId::VmathMatrix4Translation, &translationVector4, 1);
  ExpectMatrix(matrixArena, matrixTranslationVector3, translatedElements,
      "matrix4_translation Vector3 result differs");
  ExpectMatrix(matrixArena, matrixTranslationVector4, translatedElements,
      "matrix4_translation Vector4 did not ignore w");
  const float* asymmetricTranslation = MatrixElements(matrixArena, matrixTranslationVector4);
  Expect(asymmetricTranslation[12] == 1 && asymmetricTranslation[13] == 2 && asymmetricTranslation[14] == 3 &&
      asymmetricTranslation[3] == 0 && asymmetricTranslation[7] == 0 && asymmetricTranslation[11] == 0,
      "Matrix4 ABI is not canonical column-major order");

  ScriptValue orthoInverse = MatrixCall(
      matrixArena, value::BindingId::VmathOrthoInv, &identityMatrix, 1);
  ExpectMatrix(matrixArena, orthoInverse, identityElements, "ortho_inv identity result differs");
  ScriptValue matrixQuaternion = MatrixCall(
      matrixArena, value::BindingId::VmathQuatMatrix4, &identityMatrix, 1);
  Expect(matrixQuaternion.defoldKind == ScriptDefoldValueKind::kQuaternion &&
      Near(matrixQuaternion.defoldValue[0], 0) && Near(matrixQuaternion.defoldValue[1], 0) &&
      Near(matrixQuaternion.defoldValue[2], 0) && Near(matrixQuaternion.defoldValue[3], 1),
      "quat_matrix4 identity result differs");

  ScriptValue exhaustedResult;
  ScriptCallFrame exhaustedFrame;
  exhaustedFrame.stableId = static_cast<uint32_t>(value::BindingId::VmathMatrix4RotationX);
  exhaustedFrame.arguments = &zeroAngle;
  exhaustedFrame.argumentCount = 1;
  exhaustedFrame.results = &exhaustedResult;
  exhaustedFrame.resultCapacity = 1;
  exhaustedFrame.matrix4Arena = &matrixArena;
  char matrixError[256]{};
  Expect(matrixArena.used == ScriptMatrix4Arena::kCapacity,
      "Matrix4 all-route test did not fill the arena to its deterministic bound");
  Expect(value::dispatch(&exhaustedFrame, matrixError, sizeof(matrixError)) == value::DispatchStatus::kError,
      "Matrix4 arena accepted a value beyond its fixed capacity");
  Expect(exhaustedFrame.resultCount == 0, "Matrix4 exhaustion exposed a partial result");
  Expect(std::strstr(matrixError, "exhausted") != nullptr,
      "Matrix4 arena exhaustion was not diagnostic");

  ScriptCallFrame noArenaFrame = exhaustedFrame;
  noArenaFrame.matrix4Arena = nullptr;
  matrixError[0] = '\0';
  Expect(value::dispatch(&noArenaFrame, matrixError, sizeof(matrixError)) == value::DispatchStatus::kError,
      "Matrix4 output without a frame arena unexpectedly succeeded");
  Expect(std::strstr(matrixError, "unavailable") != nullptr,
      "missing Matrix4 arena failure was not diagnostic");

  ScriptMatrix4Arena arenaA;
  ScriptMatrix4Arena arenaB;
  ScriptValue outerToken;
  ScriptValue staleToken;
  float copiedBeforeRewind[16]{};
  {
    ScriptMatrix4ArenaMark outerMark(arenaA);
    Expect(arenaA.store(identityElements, &outerToken), "outer Matrix4 mark allocation failed");
    {
      ScriptMatrix4ArenaMark innerMark(arenaA);
      Expect(arenaA.store(translatedElements, &staleToken), "inner Matrix4 mark allocation failed");
      std::memcpy(copiedBeforeRewind, MatrixElements(arenaA, staleToken), sizeof(copiedBeforeRewind));
      Expect(arenaA.resolve(outerToken) != nullptr, "nested Matrix4 mark invalidated its parent token");
      Expect(arenaB.resolve(staleToken) == nullptr, "cross-frame Matrix4 token resolved in another arena");
    }
    Expect(arenaA.resolve(staleToken) == nullptr, "inner Matrix4 token remained live after RAII rewind");
    Expect(arenaA.resolve(outerToken) != nullptr, "inner Matrix4 rewind invalidated its parent token");
    Expect(copiedBeforeRewind[12] == 1 && copiedBeforeRewind[14] == 3,
        "Matrix4 result was not safely copied before scratch rewind");
  }
  Expect(arenaA.resolve(outerToken) == nullptr, "outer Matrix4 token remained live after RAII rewind");

  ScriptCallFrame staleFrame;
  staleFrame.stableId = static_cast<uint32_t>(value::BindingId::VmathInv);
  staleFrame.arguments = &staleToken;
  staleFrame.argumentCount = 1;
  staleFrame.results = &exhaustedResult;
  staleFrame.resultCapacity = 1;
  staleFrame.matrix4Arena = &arenaA;
  matrixError[0] = '\0';
  Expect(value::dispatch(&staleFrame, matrixError, sizeof(matrixError)) == value::DispatchStatus::kError,
      "stale Matrix4 input token unexpectedly dispatched");
  Expect(std::strstr(matrixError, "stale") != nullptr,
      "stale Matrix4 input failure was not diagnostic");
  ScriptValue crossArenaToken;
  Expect(arenaB.store(identityElements, &crossArenaToken), "cross-arena Matrix4 fixture allocation failed");
  staleFrame.arguments = &crossArenaToken;
  Expect(value::dispatch(&staleFrame, matrixError, sizeof(matrixError)) == value::DispatchStatus::kError,
      "cross-arena Matrix4 input token unexpectedly dispatched");

  ScriptMatrix4Arena nanArena;
  float nanMatrixElements[16];
  std::memcpy(nanMatrixElements, identityElements, sizeof(nanMatrixElements));
  nanMatrixElements[9] = std::numeric_limits<float>::quiet_NaN();
  ScriptValue nanMatrix;
  Expect(nanArena.store(nanMatrixElements, &nanMatrix), "NaN Matrix4 fixture allocation failed");
  staleFrame.arguments = &nanMatrix;
  staleFrame.matrix4Arena = &nanArena;
  Expect(value::dispatch(&staleFrame, matrixError, sizeof(matrixError)) == value::DispatchStatus::kError,
      "Matrix4 input accepted a NaN component");
  Expect(std::strstr(matrixError, "NaN") != nullptr, "Matrix4 NaN failure was not diagnostic");

  ScriptMatrix4Arena edgeArena;
  ScriptValue singularMatrix;
  const float zeroMatrixElements[16]{};
  Expect(edgeArena.store(zeroMatrixElements, &singularMatrix), "singular Matrix4 fixture allocation failed");
  ScriptValue singularInverse = MatrixCall(edgeArena, value::BindingId::VmathInv, &singularMatrix, 1);
  const float* singularResult = MatrixElements(edgeArena, singularInverse);
  const dmVMath::Matrix4 expectedSingular = dmVMath::Inverse(dmVMath::Matrix4(
      dmVMath::Vector4(0), dmVMath::Vector4(0), dmVMath::Vector4(0), dmVMath::Vector4(0)));
  for (size_t column = 0; column < 4; ++column) for (size_t row = 0; row < 4; ++row) {
    const float expected = expectedSingular.getElem(column, row);
    const float observed = singularResult[column * 4 + row];
    Expect((std::isnan(expected) && std::isnan(observed)) || expected == observed,
        "vmath.inv changed Defold's singular-matrix outcome");
  }

  ScriptValue zeroNearFrustum[] = {
    Number(-1), Number(1), Number(-1), Number(1), Number(0), Number(10)
  };
  ScriptValue warnedFrustum = MatrixCall(
      edgeArena, value::BindingId::VmathMatrix4Frustum, zeroNearFrustum, 6);
  Expect(warnedFrustum.defoldKind == ScriptDefoldValueKind::kMatrix4,
      "matrix4_frustum near_z == 0 became an error instead of warning-only");

  ScriptMatrix4Arena narrowingArena;
  ScriptValue preciseMatrixAngle = Number(16777217.0);
  ScriptValue narrowedMatrixRotation = MatrixCall(
      narrowingArena, value::BindingId::VmathMatrix4RotationX, &preciseMatrixAngle, 1);
  const float* narrowedMatrixElements = MatrixElements(narrowingArena, narrowedMatrixRotation);
  const dmVMath::Matrix4 expectedNarrowedMatrix =
      dmVMath::Matrix4::rotationX(static_cast<float>(preciseMatrixAngle.number));
  for (size_t column = 0; column < 4; ++column) for (size_t row = 0; row < 4; ++row) {
    Expect(narrowedMatrixElements[column * 4 + row] == expectedNarrowedMatrix.getElem(column, row),
        "Matrix4 scalar input did not preserve Lua-number to float32 narrowing");
  }
  ScriptMatrix4Arena nonNormalizedArena;
  ScriptValue nonUnitMatrixAxisArguments[] = {
    Value(ScriptDefoldValueKind::kVector3, 0, 0, 2), angle
  };
  ScriptValue nonNormalizedMatrixRotation = MatrixCall(
      nonNormalizedArena, value::BindingId::VmathMatrix4AxisAngle, nonUnitMatrixAxisArguments, 2);
  const float* nonNormalizedMatrixElements = MatrixElements(
      nonNormalizedArena, nonNormalizedMatrixRotation);
  const dmVMath::Matrix4 expectedNonNormalizedMatrix =
      dmVMath::Matrix4::rotation(static_cast<float>(angle.number), dmVMath::Vector3(0, 0, 2));
  for (size_t column = 0; column < 4; ++column) for (size_t row = 0; row < 4; ++row) {
    Expect(nonNormalizedMatrixElements[column * 4 + row] == expectedNonNormalizedMatrix.getElem(column, row),
        "matrix4_axis_angle unexpectedly normalized the caller's axis");
  }

  ScriptValue wrong = Value(ScriptDefoldValueKind::kQuaternion, 0, 0, 0, 1);
  ScriptValue result;
  ScriptCallFrame bad;
  bad.stableId = static_cast<uint32_t>(value::BindingId::VmathVector3);
  bad.arguments = &wrong;
  bad.argumentCount = 1;
  bad.results = &result;
  bad.resultCapacity = 1;
  char error[256]{};
  Expect(value::dispatch(&bad, error, sizeof(error)) == value::DispatchStatus::kError, "wrong value kind unexpectedly matched vector3 copy overload");

  TerminalCounters terminalCounters;
  const game_object::TerminalApi terminalApi = {
    &terminalCounters,
    GetGeneration,
    GetCollection,
    GetIdentifier,
    GetPosition,
    SetPosition,
    SetRotation
  };
  Expect(game_object::installTerminalApi(terminalApi), "GO terminal API installation failed");

  uint32_t goResultCount = UINT32_MAX;
  char goError[256]{};
  Expect(Dispatch(value::BindingId::GoGetPosition, nullptr, 0, &result,
      &goResultCount, goError, sizeof(goError)) == value::DispatchStatus::kError,
      "GO call without active context unexpectedly succeeded");
  Expect(std::strstr(goError, "No active") != nullptr, "GO no-context failure was not diagnostic");

  AttachmentTable attachments;
  attachments.live = {true, true, false, false};
  attachments.generations = {11, 17, 0, 0};
  int collection = 0;
  FakeInstance instanceA{&collection, UINT64_C(0x1111), 3, {1, 2, 3}, {0, 0, 0, 1}};
  FakeInstance instanceB{&collection, UINT64_C(0x2222), 9, {10, 20, 30}, {0, 0, 1, 0}};
  const auto contextA = Context(instanceA, attachments, 0);
  const auto contextB = Context(instanceB, attachments, 1);

  {
    game_object::Scope outer(contextA);
    Expect(outer.entered() && game_object::activeDepth() == 1, "outer GO context was not entered");
    ScriptValue observedA = Call(value::BindingId::GoGetPosition, nullptr, 0);
    Expect(Near(observedA.defoldValue[0], 1) && Near(observedA.defoldValue[2], 3),
        "outer GO context selected the wrong instance");
    {
      game_object::Scope inner(contextB);
      Expect(inner.entered() && game_object::activeDepth() == 2, "nested GO context was not entered");
      ScriptValue observedB = Call(value::BindingId::GoGetPosition, nullptr, 0);
      Expect(Near(observedB.defoldValue[0], 10) && Near(observedB.defoldValue[2], 30),
          "nested GO context selected the wrong instance");
      ScriptValue nextB = Value(ScriptDefoldValueKind::kVector3, 40, 50, 60);
      CallVoid(value::BindingId::GoSetPosition, &nextB, 1);
      ScriptValue rotationB = Value(ScriptDefoldValueKind::kQuaternion, 1, 2, 3, 4);
      CallVoid(value::BindingId::GoSetRotation, &rotationB, 1);
    }
    Expect(game_object::activeDepth() == 1, "nested GO context did not restore its parent");
    ScriptValue restoredA = Call(value::BindingId::GoGetPosition, nullptr, 0);
    Expect(Near(restoredA.defoldValue[0], 1), "outer GO context was not restored after nested dispatch");
    ScriptValue nextA = Value(ScriptDefoldValueKind::kVector3, 4, 5, 6);
    CallVoid(value::BindingId::GoSetPosition, &nextA, 1);
  }
  Expect(game_object::activeDepth() == 0, "GO context leaked after nested dispatch");
  Expect(Near(instanceA.position[0], 4) && Near(instanceB.position[0], 40),
      "nested GO mutation crossed component instances");
  Expect(Near(instanceB.rotation[0], 1) && Near(instanceB.rotation[3], 4),
      "GO rotation setter changed or normalized caller components");

  ProveBoundedDepth(contextA, static_cast<uint32_t>(game_object::kMaximumContextDepth));
  Expect(game_object::activeDepth() == 0, "bounded GO context proof did not fully unwind");

  const uint64_t pointerReadsBeforeStaleAttachment = terminalCounters.pointerReads;
  attachments.live[0] = false;
  {
    game_object::Scope stale(contextA);
    goError[0] = '\0';
    Expect(Dispatch(value::BindingId::GoGetPosition, nullptr, 0, &result,
        &goResultCount, goError, sizeof(goError)) == value::DispatchStatus::kError,
        "stale GO attachment unexpectedly succeeded");
  }
  Expect(terminalCounters.pointerReads == pointerReadsBeforeStaleAttachment,
      "stale attachment dereferenced an engine instance before generation rejection");
  Expect(std::strstr(goError, "attachment is stale") != nullptr,
      "stale attachment failure was not diagnostic");
  attachments.live[0] = true;

  {
    game_object::Scope staleInstance(contextA);
    ++instanceA.generation;
    goError[0] = '\0';
    Expect(Dispatch(value::BindingId::GoGetPosition, nullptr, 0, &result,
        &goResultCount, goError, sizeof(goError)) == value::DispatchStatus::kError,
        "stale GO instance generation unexpectedly succeeded");
    --instanceA.generation;
  }
  Expect(std::strstr(goError, "instance is stale") != nullptr,
      "stale instance failure was not diagnostic");

  {
    game_object::Scope outer(contextA);
    ScriptValue nanPosition = Value(
        ScriptDefoldValueKind::kVector3,
        std::numeric_limits<float>::quiet_NaN(), 0, 0);
    goError[0] = '\0';
    Expect(Dispatch(value::BindingId::GoSetPosition, &nanPosition, 1, nullptr,
        &goResultCount, goError, sizeof(goError)) == value::DispatchStatus::kError,
        "GO position accepted a NaN component");
    ScriptValue addressed = String("other", 5);
    Expect(Dispatch(value::BindingId::GoGetPosition, &addressed, 1, &result,
        &goResultCount, goError, sizeof(goError)) == value::DispatchStatus::kError,
        "current-instance-only GO wave accepted an addressed call");
  }

  lua_State* lua = luaL_newstate();
  Expect(lua != nullptr, "structured Lua test state creation failed");
  luaL_openlibs(lua);
  RegisterLuaFunction(lua, "msg", "post", MockMsgPost);
  RegisterLuaFunction(lua, "factory", "create", MockFactoryCreate);
  RegisterLuaFunction(lua, "go", "delete", MockGoDelete);
  RegisterLuaFunction(lua, "gui", "get_node", MockGuiGetNode);
  RegisterLuaFunction(lua, "gui", "set_text", MockGuiSetText);
  RegisterLuaFunction(lua, "gui", "set_alpha", MockGuiNumberSetter);
  RegisterLuaFunction(lua, "gui", "set_enabled", MockGuiBooleanSetter);
  RegisterLuaFunction(lua, "gui", "set_position", MockGuiUserdataSetter);
  RegisterLuaFunction(lua, "gui", "set_rotation", MockGuiUserdataSetter);
  RegisterLuaFunction(lua, "gui", "set_font", MockGuiStringSetter);
  RegisterLuaFunction(lua, "gui", "set_id", MockGuiUserdataSetter);
  RegisterLuaFunction(lua, "gui", "set_parent", MockGuiParentSetter);
  RegisterLuaFunction(lua, "window", "get_size", MockWindowGetSize);
  RegisterLuaFunction(lua, "vmath", "quat_to_euler", MockQuatToEuler);
  RegisterLuaFunction(lua, "gui", "get_type", MockGuiGetType);
  RegisterLuaFunction(lua, "gui", "new_texture", MockGuiNewTexture);
  RegisterLuaFunction(lua, "collectionproxy", "set_collection", MockCollectionSet);
  RegisterNestedLuaFunction(lua, "bullet3d", "collision_object", "get_world_transform", MockBulletWorldTransform);
  RegisterNestedLuaFunction(lua, "bullet3d", "constraint", "get_6dof_motor", MockBullet6Dof);

  scalar::ScriptAdapter adapter;
  const scalar::InstanceApi luaInstanceApi{GetLuaInstance, SetLuaInstance};
  Expect(adapter.initialize(lua, luaInstanceApi), adapter.lastError());
  int capturedLuaInstance = 0;
  gExpectedLuaInstance = &capturedLuaInstance;
  lua_pushlightuserdata(lua, gExpectedLuaInstance);
  Expect(adapter.captureInstance(-1), adapter.lastError());
  lua_pop(lua, 1);

  ScriptValue tupleResults[4]{};
  uint32_t tupleCount = UINT32_MAX;
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0xeb7b27de), nullptr, 0,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 2 && tupleResults[0].number == 1280 && tupleResults[1].number == 720,
      "window.get_size fixed tuple positions differ");
  gTupleWrongArity=true; tupleCount=UINT32_MAX;
  Expect(!AdapterDispatchTuple(adapter, UINT32_C(0xeb7b27de), nullptr, 0,
      tupleResults, 4, &tupleCount), "fixed tuple accepted a short Lua return list");
  Expect(tupleCount==0, "arity failure exposed partial fixed tuple results"); gTupleWrongArity=false;
  gTupleWrongTag=true;
  Expect(!AdapterDispatchTuple(adapter, UINT32_C(0xeb7b27de), nullptr, 0,
      tupleResults, 4, &tupleCount), "fixed tuple accepted a wrong positional result tag");
  Expect(tupleCount==0, "tag failure exposed partial fixed tuple results"); gTupleWrongTag=false;
  ScriptValue tupleQuat = Value(ScriptDefoldValueKind::kQuaternion, 0, 0, 0, 1);
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x9d6efd31), &tupleQuat, 1,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 3 && tupleResults[0].number == 10 && tupleResults[2].number == 30,
      "vmath.quat_to_euler fixed tuple arity differs");
  const char collectionPath[] = "/next.collectionc";
  ScriptValue collectionArgument = String(collectionPath, sizeof(collectionPath)-1);
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x2fe0fffb), &collectionArgument, 1,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 2 && tupleResults[0].tag == ScriptValueTag::kBoolean,
      "collectionproxy.set_collection tuple differs");
  ScriptValue collectionHashArguments[] = {Hash(UINT64_C(0x12345678)), Nil()};
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x2fe0fffb), collectionHashArguments, 2,
      tupleResults, 4, &tupleCount), adapter.lastError());
  ScriptValue unsupportedUrl; unsupportedUrl.tag=ScriptValueTag::kHandle;
  unsupportedUrl.handleKind=ScriptHandleKind::kUrl;
  tupleCount=UINT32_MAX;
  Expect(!AdapterDispatchTuple(adapter, UINT32_C(0x2fe0fffb), &unsupportedUrl, 1,
      tupleResults, 4, &tupleCount), "fixed tuple URL codec unexpectedly bypassed fail-closed lowering");
  Expect(tupleCount == 0, "failed URL tuple call exposed partial resultCount");

  lua_newuserdata(lua, 8);
  ScriptValue bulletHandle;
  Expect(adapter.captureLuaUserdata(-1, &bulletHandle), adapter.lastError());
  lua_pop(lua, 1);
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x8abce1d3), &bulletHandle, 1,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 2 && tupleResults[0].defoldKind == ScriptDefoldValueKind::kVector3 &&
      tupleResults[0].defoldValue[1] == 2 && tupleResults[1].defoldKind == ScriptDefoldValueKind::kQuaternion,
      "bullet world transform was not copied before Lua stack restoration");
  ScriptValue motorArguments[] = {bulletHandle, Number(2)};
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x797d3f36), motorArguments, 2,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 4 && tupleResults[0].tag == ScriptValueTag::kBoolean && tupleResults[3].number == 5,
      "bullet 6dof four-result tuple differs");
  tupleCount=UINT32_MAX;
  Expect(!AdapterDispatchTuple(adapter, UINT32_C(0x797d3f36), motorArguments, 2,
      tupleResults, 3, &tupleCount), "fixed tuple accepted undersized result capacity");
  Expect(tupleCount == 0, "capacity failure exposed partial fixed tuple results");

  const char currentAddress[] = ".";
  const char messageName[] = "deherm_probe_message";
  ScriptValue msgArguments[] = {
    String(currentAddress, 1),
    String(messageName, sizeof(messageName) - 1)
  };
  uint32_t structuredResultCount = UINT32_MAX;
  Expect(AdapterDispatch(adapter, value::BindingId::MsgPost, msgArguments, 2, nullptr,
      &structuredResultCount), adapter.lastError());
  Expect(structuredResultCount == 0 && gMsgCalls == 1, "msg.post did not execute through captured Lua");

  const char damageKey[] = "damage";
  ScriptTableEntry msgEntries[1];
  msgEntries[0].key = String(damageKey, sizeof(damageKey) - 1);
  msgEntries[0].value = Number(42);
  ScriptValue msgWithPayload[] = {msgArguments[0], msgArguments[1], Table(msgEntries, 1)};
  Expect(AdapterDispatch(adapter, value::BindingId::MsgPost, msgWithPayload, 3, nullptr),
      adapter.lastError());
  Expect(gMsgCalls == 2, "msg.post table payload did not execute");

  const char factoryAddress[] = "#probe_factory";
  ScriptValue factoryAddressValue = String(factoryAddress, sizeof(factoryAddress) - 1);
  ScriptValue created;
  Expect(AdapterDispatch(adapter, value::BindingId::FactoryCreate, &factoryAddressValue, 1, &created),
      adapter.lastError());
  Expect(created.tag == ScriptValueTag::kHandle && created.handleKind == ScriptHandleKind::kHash &&
      created.payload == UINT64_C(0x1020304050607080), "factory.create hash result was not preserved");

  const char healthKey[] = "health";
  ScriptTableEntry properties[1];
  properties[0].key = String(healthKey, sizeof(healthKey) - 1);
  properties[0].value = Number(100);
  ScriptValue factoryArguments[] = {
    factoryAddressValue,
    Value(ScriptDefoldValueKind::kVector3, 3, 4, 5),
    Nil(),
    Table(properties, 1)
  };
  Expect(AdapterDispatch(adapter, value::BindingId::FactoryCreate, factoryArguments, 4, &created),
      adapter.lastError());
  Expect(gFactoryCalls == 2, "factory.create generated overloads did not both execute");

  Expect(AdapterDispatch(adapter, value::BindingId::GoDelete, &created, 1, nullptr), adapter.lastError());
  Expect(AdapterDispatch(adapter, value::BindingId::GoDelete, nullptr, 0, nullptr), adapter.lastError());
  Expect(gDeleteCalls == 2, "go.delete generated overloads did not both execute");

  lua_pushlightuserdata(lua, gExpectedLuaInstance);
  Expect(adapter.captureGuiInstance(-1), adapter.lastError());
  lua_pop(lua, 1);
  tupleCount=UINT32_MAX;
  Expect(!AdapterDispatchTuple(adapter, UINT32_C(0x2fe0fffb), &collectionArgument, 1,
      tupleResults, 4, &tupleCount), "script tuple accepted a GUI context");
  Expect(tupleCount==0, "context failure exposed partial fixed tuple results");
  const char statusName[] = "status";
  ScriptValue statusArgument = String(statusName, sizeof(statusName) - 1);
  ScriptValue node;
  Expect(AdapterDispatch(adapter, value::BindingId::GuiGetNode, &statusArgument, 1, &node), adapter.lastError());
  Expect(node.tag == ScriptValueTag::kHandle && node.handleKind == ScriptHandleKind::kGuiNode,
      "gui.get_node did not return a generational node handle");
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0x55520562), &node, 1,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount == 2 && tupleResults[0].number == 4 && tupleResults[1].tag == ScriptValueTag::kNull,
      "gui.get_type did not preserve the interior/trailing nil tuple position");
  const char textureFormat[]="rgba"; const char textureBytes[]={'\0','\1','\2','\3'};
  ScriptValue textureArguments[] = {
    Hash(UINT64_C(0x55)), Number(1), Number(1),
    String(textureFormat,4), String(textureBytes,4), Boolean(false)
  };
  Expect(AdapterDispatchTuple(adapter, UINT32_C(0xa8cda9fb), textureArguments, 6,
      tupleResults, 4, &tupleCount), adapter.lastError());
  Expect(tupleCount==2 && tupleResults[0].tag==ScriptValueTag::kBoolean &&
      tupleResults[1].tag==ScriptValueTag::kNull,"gui.new_texture tuple codecs differ");
  const char readyText[] = "READY";
  ScriptValue setTextArguments[] = {node, String(readyText, sizeof(readyText) - 1)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetText, setTextArguments, 2, nullptr), adapter.lastError());
  setTextArguments[1] = Number(12.5);
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetText, setTextArguments, 2, nullptr), adapter.lastError());
  Expect(gGuiLookupCalls == 1 && gGuiTextCalls == 2,
      "GUI node lookup/text routes did not preserve Lua userdata identity and number formatting");

  ScriptValue numberSetter[] = {node, Number(0.75)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetAlpha, numberSetter, 2, nullptr), adapter.lastError());
  ScriptValue booleanSetter[] = {node, Boolean(true)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetEnabled, booleanSetter, 2, nullptr), adapter.lastError());
  ScriptValue positionSetter[] = {node, Value(ScriptDefoldValueKind::kVector3, 8, 13, 21)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetPosition, positionSetter, 2, nullptr), adapter.lastError());
  ScriptValue rotationSetter[] = {node, Value(ScriptDefoldValueKind::kQuaternion, 0, 0, 0, 1)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetRotation, rotationSetter, 2, nullptr), adapter.lastError());
  const char fontName[] = "system_font";
  ScriptValue fontSetter[] = {node, String(fontName, sizeof(fontName) - 1)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetFont, fontSetter, 2, nullptr), adapter.lastError());
  ScriptValue idSetter[] = {node, Hash(UINT64_C(0xf00dcafe12345678))};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetId, idSetter, 2, nullptr), adapter.lastError());

  ScriptValue invalidStringSetter[] = {node, String(nullptr, 1)};
  Expect(!AdapterDispatch(adapter, value::BindingId::GuiSetFont, invalidStringSetter, 2, nullptr),
      "structured GUI setter accepted a non-empty null string");
  Expect(std::strstr(adapter.lastError(), "arguments do not match") != nullptr,
      "malformed structured string failure was not diagnostic");

  const char parentName[] = "parent";
  ScriptValue parentArgument = String(parentName, sizeof(parentName) - 1);
  ScriptValue parentNode;
  Expect(AdapterDispatch(adapter, value::BindingId::GuiGetNode, &parentArgument, 1, &parentNode), adapter.lastError());
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetParent, &node, 1, nullptr), adapter.lastError());
  ScriptValue parentSetter[] = {node, parentNode, Boolean(false)};
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetParent, parentSetter, 2, nullptr), adapter.lastError());
  Expect(AdapterDispatch(adapter, value::BindingId::GuiSetParent, parentSetter, 3, nullptr), adapter.lastError());
  Expect(gGuiSetterCalls == 9, "generated GUI setter family did not preserve representative codec shapes");

  adapter.api().releaseHandle(
      adapter.api().context, node.handleKind, node.length, node.payload);
  Expect(!AdapterDispatch(adapter, value::BindingId::GuiSetText, setTextArguments, 2, nullptr),
      "released GUI node handle unexpectedly remained live");
  Expect(std::strstr(adapter.lastError(), "stale") != nullptr, "stale GUI node failure was not diagnostic");

  ScriptValue detachedNode;
  Expect(AdapterDispatch(adapter, value::BindingId::GuiGetNode, &statusArgument, 1, &detachedNode),
      adapter.lastError());
  adapter.detachInstance();
  ScriptValue detachedText[] = {detachedNode, String(readyText, sizeof(readyText) - 1)};
  Expect(!AdapterDispatch(adapter, value::BindingId::GuiSetText, detachedText, 2, nullptr),
      "detached ScriptAdapter unexpectedly retained its captured instance");
  Expect(std::strstr(adapter.lastError(), "no captured") != nullptr,
      "detached ScriptAdapter failure was not diagnostic");
  adapter.shutdown();
  lua_close(lua);

  dmHashEnableReverseHash(true);
  const char reverseText[] = "deherm_reverse_hash_probe_7f31";
  ScriptValue reverseArgument = String(reverseText, sizeof(reverseText) - 1);
  ScriptValue reversibleHash = Call(value::BindingId::Hash, &reverseArgument, 1);
  Expect(std::strcmp(dmHashReverseSafe64(reversibleHash.payload), reverseText) == 0,
      "generated hash route did not preserve Defold debug reverse-hash registration");
  dmHashEnableReverseHash(false);

  ScriptValue hotPosition = Value(ScriptDefoldValueKind::kVector3, 4, 5, 6);
  ScriptMatrix4Arena hotMatrixArena;
  gAllocations.store(0, std::memory_order_relaxed);
  gTrackAllocations.store(true, std::memory_order_relaxed);
  {
    game_object::Scope allocationContext(contextA);
    for (uint32_t index = 0; index < 500000; ++index) {
      result = Call(value::BindingId::Hash, &hashArgument, 1);
      result = Call(value::BindingId::VmathVector3, components, 3);
      result = Call(value::BindingId::VmathLength, &vector, 1);
      result = Call(value::BindingId::VmathNormalize, &vector, 1);
      result = Call(value::BindingId::VmathLengthSqr, &vector, 1);
      result = Call(value::BindingId::VmathCross, crossArguments, 2);
      result = Call(value::BindingId::VmathConj, &quat, 1);
      result = Call(value::BindingId::VmathQuatAxisAngle, axisArguments, 2);
      result = Call(value::BindingId::VmathRotate, rotateArguments, 2);
      result = Call(value::BindingId::VmathQuatRotationZ, &angle, 1);
      result = Call(value::BindingId::VmathQuat, quatComponents, 4);
      {
        ScriptMatrix4ArenaMark hotMatrixMark(hotMatrixArena);
        ScriptValue hotIdentity;
        Expect(hotMatrixArena.store(identityElements, &hotIdentity), "hot Matrix4 arena allocation failed");
        result = MatrixCall(hotMatrixArena, value::BindingId::VmathInv, &hotIdentity, 1);
        Expect(MatrixElements(hotMatrixArena, result)[0] == 1.0f,
            "warmed Matrix4 dispatch changed identity");
        result = MatrixCall(hotMatrixArena, value::BindingId::VmathMatrix4RotationZ, &zeroAngle, 1);
      }
      result = Call(value::BindingId::GoGetPosition, nullptr, 0);
      CallVoid(value::BindingId::GoSetPosition, &hotPosition, 1);
      CallVoid(value::BindingId::GoSetRotation, &quatIdentity, 1);
    }
  }
  gTrackAllocations.store(false, std::memory_order_relaxed);
  Expect(gAllocations.load(std::memory_order_relaxed) == 0, "generated value or handle dispatch allocated on the hot path");
  game_object::uninstallTerminalApi();
  std::printf("script-value-binding:go-context-reentrant:ok\n");
  std::printf("script-value-binding:go-context-stale-safe:ok\n");
  std::printf("script-value-binding:matrix4-arena:ok\n");
  std::printf("script-value-binding:matrix4-routes:14:ok\n");
  std::printf("script-value-binding:fixed-tuple-codecs:ok\n");
  std::printf("script-value-binding:allocations:0\nscript-value-binding:ok\n");
  return 0;
}
