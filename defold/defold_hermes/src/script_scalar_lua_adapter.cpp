#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/generated_script_value_bindings.hpp>

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/vmath.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

namespace dmScript {
void PushHash(lua_State* state, dmhash_t hash);
dmhash_t* ToHash(lua_State* state, int index);
void PushVector3(lua_State* state, const dmVMath::Vector3& value);
void PushVector4(lua_State* state, const dmVMath::Vector4& value);
void PushQuat(lua_State* state, const dmVMath::Quat& value);
dmVMath::Vector3* ToVector3(lua_State* state, int index);
dmVMath::Quat* ToQuat(lua_State* state, int index);
}  // namespace dmScript

namespace defold_hermes::lua_bridge::scalar {
namespace {
constexpr int64_t kMaxExactInteger = 9007199254740991LL;
constexpr uint32_t kNodeHandleType = 1;
constexpr uint32_t kLuaUserdataHandleType = 2;

uint64_t packHandle(Handle handle) noexcept {
  return static_cast<uint64_t>(handle.slot) |
      (static_cast<uint64_t>(handle.generation) << 32u);
}

Handle unpackHandle(uint32_t runtime, uint64_t payload, uint32_t type) noexcept {
  return {
    runtime,
    static_cast<uint32_t>(payload),
    static_cast<uint32_t>(payload >> 32u),
    type
  };
}

void writeError(char* error, size_t capacity, const char* message) noexcept {
  if (error == message) return;
  if (error && capacity) std::snprintf(error, capacity, "%s", message ? message : "Structured Lua call failed");
}

bool findDenseIndex(uint32_t stableId, size_t* outDenseIndex) noexcept {
  const auto& table = generated::tables();
  size_t first = 0;
  size_t count = table.bindingCount;
  while (count != 0) {
    const size_t step = count / 2;
    const size_t index = first + step;
    if (table.stableIds[index] < stableId) {
      first = index + 1;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  if (first >= table.bindingCount || table.stableIds[first] != stableId) return false;
  *outDenseIndex = first;
  return true;
}
}

ScriptAdapter::ScriptAdapter() noexcept : luaHandles_(kLuaHandleCapacity) {
  structuredFunctionRefs_.fill(LUA_NOREF);
  fixedTupleFunctionRefs_.fill(LUA_NOREF);
  structuredLuaApi_ = {this, StructuredInvokeThunk};
  fixedTupleLuaApi_ = {this, FixedTupleInvokeThunk};
}

bool ScriptAdapter::initialize(lua_State* state, InstanceApi instanceApi) noexcept {
  shutdown();
  adapterError_[0] = '\0';
  if (!dispatcher_.initialize(state, 32, instanceApi)) return false;
  state_ = state;
  instanceApi_ = instanceApi;
  if (++runtimeGeneration_ == 0) ++runtimeGeneration_;
  structuredFunctionRefs_.fill(LUA_NOREF);
  fixedTupleFunctionRefs_.fill(LUA_NOREF);
  return true;
}

void ScriptAdapter::shutdown() noexcept {
  if (state_) {
    drainReleasedHandles();
    luaHandles_.sweep([this](const HandleRecord& record) {
      if (record.state == state_) luaL_unref(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
    });
    for (int& reference : structuredFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    for (int& reference : fixedTupleFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
      luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
    }
  }
  instanceRef_ = LUA_NOREF;
  hasActiveContext_ = false;
  state_ = nullptr;
  instanceApi_ = {};
  dispatcher_.shutdown();
}

bool ScriptAdapter::captureInstance(int stackIndex) noexcept {
  return captureContext(stackIndex, value_binding::StructuredLuaContext::kScriptInstance);
}

bool ScriptAdapter::captureGuiInstance(int stackIndex) noexcept {
  return captureContext(stackIndex, value_binding::StructuredLuaContext::kGuiScriptInstance);
}

bool ScriptAdapter::captureLuaUserdata(int stackIndex, ScriptValue* output) noexcept {
  adapterError_[0] = '\0';
  if (!state_ || !output || !lua_isuserdata(state_, stackIndex)) return fail("Lua userdata capture requires an active runtime and userdata value");
  lua_pushvalue(state_, stackIndex);
  const int reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  const auto handle = luaHandles_.acquire(runtimeGeneration_, kLuaUserdataHandleType,
      state_, static_cast<uintptr_t>(reference));
  if (!handle) { luaL_unref(state_, LUA_REGISTRYINDEX, reference); return fail("Lua userdata handle pool is exhausted"); }
  *output = {};
  output->tag = ScriptValueTag::kHandle;
  output->handleKind = ScriptHandleKind::kLuaUserdata;
  output->length = handle.runtime;
  output->payload = packHandle(handle);
  return true;
}

bool ScriptAdapter::captureContext(
    int stackIndex,
    value_binding::StructuredLuaContext context) noexcept {
  adapterError_[0] = '\0';
  if (!state_ || !instanceApi_.get || !instanceApi_.set) return fail("instance capture is not configured");
  detachInstance();
  if (!dispatcher_.captureInstance(stackIndex)) return false;
  lua_pushvalue(state_, stackIndex);
  instanceRef_ = luaL_ref(state_, LUA_REGISTRYINDEX);
  if (instanceRef_ == LUA_NOREF || instanceRef_ == LUA_REFNIL) {
    dispatcher_.detachInstance();
    return fail("unable to capture the structured Lua instance");
  }
  activeContext_ = context;
  hasActiveContext_ = true;
  return true;
}

void ScriptAdapter::detachInstance() noexcept {
  dispatcher_.detachInstance();
  if (!state_) {
    instanceRef_ = LUA_NOREF;
    hasActiveContext_ = false;
    return;
  }
  drainReleasedHandles();
  luaHandles_.sweep([this](const HandleRecord& record) {
    if (record.state == state_) luaL_unref(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
  });
  if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
  }
  instanceRef_ = LUA_NOREF;
  hasActiveContext_ = false;
  if (++runtimeGeneration_ == 0) ++runtimeGeneration_;
}

bool ScriptAdapter::dispatch(ScriptCallFrame* frame) noexcept {
  if (!frame) return fail("Defold script call frame is null");
  adapterError_[0] = '\0';
  frame->resultCount = 0;
  frame->stringScratchUsed = 0;

  drainReleasedHandles();
  const auto valueStatus = value_binding::dispatch(
      frame, adapterError_, sizeof(adapterError_), &structuredLuaApi_);
  if (valueStatus == value_binding::DispatchStatus::kSuccess) return true;
  if (valueStatus == value_binding::DispatchStatus::kError) return false;

  const auto tupleStatus = fixed_tuple::dispatch(
      frame, adapterError_, sizeof(adapterError_), &fixedTupleLuaApi_);
  if (tupleStatus == fixed_tuple::DispatchStatus::kSuccess) return true;
  if (tupleStatus == fixed_tuple::DispatchStatus::kError) return false;

  size_t denseIndex = 0;
  if (!findDenseIndex(frame->stableId, &denseIndex)) {
    return fail("Defold script binding is not in the executable scalar family");
  }
  const auto& table = generated::tables();
  if (frame->argumentCount < table.requiredArgumentCounts[denseIndex] ||
      frame->argumentCount > table.maximumArgumentCounts[denseIndex] ||
      (frame->argumentCount != 0 && !frame->arguments)) {
    return fail("Defold script scalar argument count does not match its descriptor");
  }

  ScalarCallArena arena;
  ScalarCallArena::Frame arenaFrame(arena);
  auto arguments = arena.allocateSpan<ScalarInput>(frame->argumentCount);
  if (frame->argumentCount != 0 && !arguments.data) {
    return fail("Defold script scalar call-local arena is exhausted");
  }
  const size_t argumentOffset = table.argumentOffsets[denseIndex];
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    const ScriptValue& input = frame->arguments[index];
    switch (table.argumentCodecs[argumentOffset + index]) {
      case ScalarCodec::kBoolean:
        if (input.tag != ScriptValueTag::kBoolean) return fail("Defold script argument must be boolean");
        arguments[index] = ScalarInput::booleanValue(input.number != 0.0);
        break;
      case ScalarCodec::kInteger:
        if (input.tag != ScriptValueTag::kNumber || !std::isfinite(input.number) ||
            std::trunc(input.number) != input.number ||
            input.number < -static_cast<double>(kMaxExactInteger) ||
            input.number > static_cast<double>(kMaxExactInteger)) {
          return fail("Defold script argument must be an exactly representable integer");
        }
        arguments[index] = ScalarInput::integerValue(static_cast<int64_t>(input.number));
        break;
      case ScalarCodec::kNumber:
        if (input.tag != ScriptValueTag::kNumber) return fail("Defold script argument must be number");
        arguments[index] = ScalarInput::numberValue(input.number);
        break;
      case ScalarCodec::kString:
        if (input.tag != ScriptValueTag::kString || (input.length != 0 && !input.data)) {
          return fail("Defold script argument must be string");
        }
        arguments[index] = ScalarInput::stringValue(
            static_cast<const char*>(input.data), input.length);
        break;
      case ScalarCodec::kNone:
        return fail("Generated scalar descriptor contains a void argument");
    }
  }

  if (!dispatcher_.isBound(frame->stableId) && !dispatcher_.bind(frame->stableId)) return false;
  const ScalarCodec resultCodec = table.resultCodecs[denseIndex];
  ScalarOutput output;
  if (resultCodec == ScalarCodec::kString) {
    output.stringData = frame->stringScratch;
    output.stringCapacity = frame->stringScratchCapacity;
  }
  if (!dispatcher_.dispatch(
          frame->stableId,
          {arguments.data, arguments.size},
          resultCodec == ScalarCodec::kNone ? nullptr : &output)) {
    return false;
  }
  if (resultCodec == ScalarCodec::kNone) {
    adapterError_[0] = '\0';
    return true;
  }
  if (!frame->results || frame->resultCapacity < 1) return fail("Defold script result storage is exhausted");
  ScriptValue& result = frame->results[0];
  result = {};
  switch (output.tag) {
    case ScalarTag::kNil:
      result.tag = ScriptValueTag::kNull;
      break;
    case ScalarTag::kBoolean:
      result.tag = ScriptValueTag::kBoolean;
      result.number = output.boolean ? 1.0 : 0.0;
      break;
    case ScalarTag::kInteger:
      result.tag = ScriptValueTag::kNumber;
      result.number = static_cast<double>(output.integer);
      break;
    case ScalarTag::kNumber:
      result.tag = ScriptValueTag::kNumber;
      result.number = output.number;
      break;
    case ScalarTag::kString:
      result.tag = ScriptValueTag::kString;
      result.data = frame->stringScratch;
      result.length = output.stringSize;
      frame->stringScratchUsed = output.stringSize;
      break;
  }
  frame->resultCount = 1;
  adapterError_[0] = '\0';
  return true;
}

const char* ScriptAdapter::lastError() const noexcept {
  return adapterError_[0] ? adapterError_ : dispatcher_.lastError();
}

ScriptBridgeApi ScriptAdapter::api() noexcept {
  return {this, DispatchThunk, ErrorThunk, ReleaseHandleThunk};
}

bool ScriptAdapter::DispatchThunk(void* context, ScriptCallFrame* frame) noexcept {
  return static_cast<ScriptAdapter*>(context)->dispatch(frame);
}

const char* ScriptAdapter::ErrorThunk(void* context) noexcept {
  return static_cast<ScriptAdapter*>(context)->lastError();
}

void ScriptAdapter::ReleaseHandleThunk(
    void* context,
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept {
  static_cast<ScriptAdapter*>(context)->releaseHandle(kind, runtime, payload);
}

value_binding::DispatchStatus ScriptAdapter::StructuredInvokeThunk(
    void* context,
    const value_binding::StructuredLuaOperation& operation,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeStructured(
      operation, frame, error, errorCapacity);
}

bool ScriptAdapter::bindStructured(
    const value_binding::StructuredLuaOperation& operation) noexcept {
  if (!state_ || operation.index >= structuredFunctionRefs_.size()) {
    return fail("Structured Lua operation index is invalid");
  }
  int& reference = structuredFunctionRefs_[operation.index];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  lua_getglobal(state_, operation.module);
  if (!lua_istable(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Structured Lua module is unavailable");
  }
  lua_getfield(state_, -1, operation.member);
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Structured Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::pushStructuredValue(const ScriptValue& value, uint32_t depth) noexcept {
  switch (value.tag) {
    case ScriptValueTag::kUndefined:
    case ScriptValueTag::kNull:
      lua_pushnil(state_);
      return true;
    case ScriptValueTag::kBoolean:
      lua_pushboolean(state_, value.number != 0.0 ? 1 : 0);
      return true;
    case ScriptValueTag::kNumber:
      lua_pushnumber(state_, value.number);
      return true;
    case ScriptValueTag::kString:
      if (value.length != 0 && !value.data) {
        return fail("Structured Lua string data is null for a non-empty value");
      }
      lua_pushlstring(state_,
          value.data ? static_cast<const char*>(value.data) : "",
          value.length);
      return true;
    case ScriptValueTag::kHandle:
      if (value.handleKind == ScriptHandleKind::kHash) {
        dmScript::PushHash(state_, value.payload);
        return true;
      }
      if (value.handleKind == ScriptHandleKind::kGuiNode || value.handleKind == ScriptHandleKind::kLuaUserdata) {
        const uint32_t type = value.handleKind == ScriptHandleKind::kGuiNode
            ? kNodeHandleType : kLuaUserdataHandleType;
        HandleRecord record;
        if (!luaHandles_.resolve(unpackHandle(value.length, value.payload, type), &record) ||
            record.state != state_) {
          return fail("Lua registry handle is stale or belongs to another runtime");
        }
        lua_rawgeti(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
        return true;
      }
      return fail("Structured Lua handle kind is unsupported");
    case ScriptValueTag::kDefoldValue:
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) {
        dmScript::PushVector3(state_, dmVMath::Vector3(
            value.defoldValue[0], value.defoldValue[1], value.defoldValue[2]));
        return true;
      }
      if (value.defoldKind == ScriptDefoldValueKind::kVector4) {
        dmScript::PushVector4(state_, dmVMath::Vector4(
            value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]));
        return true;
      }
      if (value.defoldKind == ScriptDefoldValueKind::kQuaternion) {
        dmScript::PushQuat(state_, dmVMath::Quat(
            value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]));
        return true;
      }
      return fail("Structured Lua Defold value kind is unsupported");
    case ScriptValueTag::kTable: {
      if (depth != 0) return fail("Structured Lua tables must be flat");
      if (value.length > 16 || (value.length != 0 && !value.data)) {
        return fail("Structured Lua table exceeds the fixed 16-entry bound");
      }
      lua_createtable(state_, 0, static_cast<int>(value.length));
      const auto* entries = static_cast<const ScriptTableEntry*>(value.data);
      for (uint32_t index = 0; index < value.length; ++index) {
        if (!pushStructuredValue(entries[index].key, depth + 1) ||
            !pushStructuredValue(entries[index].value, depth + 1)) return false;
        lua_settable(state_, -3);
      }
      return true;
    }
    case ScriptValueTag::kCallback:
      return fail("Structured Lua callbacks are unsupported");
  }
  return fail("Structured Lua value tag is unsupported");
}

bool ScriptAdapter::readStructuredResult(
    value_binding::StructuredLuaResultCodec codec,
    ScriptCallFrame* frame) noexcept {
  if (codec == value_binding::StructuredLuaResultCodec::kNone) return true;
  if (!frame->results || frame->resultCapacity < 1) return fail("Structured Lua result storage is exhausted");
  ScriptValue& output = frame->results[0];
  output = {};
  if (codec == value_binding::StructuredLuaResultCodec::kHashOrUndefined && lua_isnil(state_, -1)) {
    output.tag = ScriptValueTag::kUndefined;
  } else if (codec == value_binding::StructuredLuaResultCodec::kHash ||
             codec == value_binding::StructuredLuaResultCodec::kHashOrUndefined) {
    dmhash_t* hash = dmScript::ToHash(state_, -1);
    if (!hash) return fail("Structured Lua result is not a hash");
    output.tag = ScriptValueTag::kHandle;
    output.handleKind = ScriptHandleKind::kHash;
    output.payload = *hash;
  } else if (codec == value_binding::StructuredLuaResultCodec::kNode) {
    if (!lua_isuserdata(state_, -1)) return fail("Structured Lua result is not a GUI node userdata");
    lua_pushvalue(state_, -1);
    const int reference = luaL_ref(state_, LUA_REGISTRYINDEX);
    const auto handle = luaHandles_.acquire(
        runtimeGeneration_, kNodeHandleType, state_, static_cast<uintptr_t>(reference));
    if (!handle) {
      luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      return fail("GUI node handle pool is exhausted");
    }
    output.tag = ScriptValueTag::kHandle;
    output.handleKind = ScriptHandleKind::kGuiNode;
    output.length = handle.runtime;
    output.payload = packHandle(handle);
  } else {
    return fail("Structured Lua result codec is unsupported");
  }
  frame->resultCount = 1;
  return true;
}

fixed_tuple::DispatchStatus ScriptAdapter::FixedTupleInvokeThunk(
    void* context, const fixed_tuple::Operation& operation,
    const uint16_t*, const uint16_t* resultCodecs, ScriptCallFrame* frame,
    char* error, size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeFixedTuple(
      operation, resultCodecs, frame, error, errorCapacity);
}

bool ScriptAdapter::bindFixedTuple(const fixed_tuple::Operation& operation) noexcept {
  if (!state_ || operation.index >= fixedTupleFunctionRefs_.size()) return fail("Fixed tuple operation index is invalid");
  int& reference = fixedTupleFunctionRefs_[operation.index];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  const char* segment = operation.modulePath;
  const char* dot = std::strchr(segment, '.');
  if (dot) {
    const size_t length = static_cast<size_t>(dot - segment);
    if (length >= 64) return fail("Fixed tuple Lua module segment exceeds fixed stack scratch");
    char first[64]{}; std::memcpy(first, segment, length); lua_getglobal(state_, first);
  } else lua_getglobal(state_, segment);
  while (dot && lua_istable(state_, -1)) {
    segment = dot + 1; dot = std::strchr(segment, '.');
    const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    lua_pushlstring(state_, segment, length); lua_gettable(state_, -2); lua_remove(state_, -2);
  }
  if (!lua_istable(state_, -1)) { lua_settop(state_, baseTop); return fail("Fixed tuple Lua module is unavailable"); }
  lua_getfield(state_, -1, operation.member);
  if (!lua_isfunction(state_, -1)) { lua_settop(state_, baseTop); return fail("Fixed tuple Lua function is unavailable"); }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX); lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readFixedTupleResult(uint16_t codecs, int stackIndex,
    ScriptValue* output, ScriptCallFrame* frame) noexcept {
  *output = {};
  if (lua_isnil(state_, stackIndex)) {
    if (!(codecs & fixed_tuple::kNil)) return fail("Fixed tuple result is nil but positional codec is non-nullable");
    output->tag = ScriptValueTag::kNull; return true;
  }
  if ((codecs & fixed_tuple::kBoolean) && lua_type(state_, stackIndex) == LUA_TBOOLEAN) {
    output->tag=ScriptValueTag::kBoolean; output->number=lua_toboolean(state_,stackIndex)?1.0:0.0; return true;
  }
  if ((codecs & (fixed_tuple::kInteger|fixed_tuple::kNumber)) && lua_type(state_, stackIndex)==LUA_TNUMBER) {
    const double value=lua_tonumber(state_,stackIndex);
    if ((codecs & fixed_tuple::kInteger) && !(codecs & fixed_tuple::kNumber) && (!std::isfinite(value)||std::trunc(value)!=value)) return fail("Fixed tuple integer result is not exact");
    output->tag=ScriptValueTag::kNumber; output->number=value; return true;
  }
  if ((codecs & fixed_tuple::kString) && lua_type(state_, stackIndex)==LUA_TSTRING) {
    size_t length=0; const char* data=lua_tolstring(state_,stackIndex,&length);
    if (!frame->stringScratch || length > frame->stringScratchCapacity-frame->stringScratchUsed) return fail("Fixed tuple string scratch is exhausted");
    char* destination=frame->stringScratch+frame->stringScratchUsed; if(length) std::memcpy(destination,data,length);
    output->tag=ScriptValueTag::kString; output->data=destination; output->length=static_cast<uint32_t>(length); frame->stringScratchUsed+=static_cast<uint32_t>(length); return true;
  }
  if (codecs & fixed_tuple::kHash) { if (dmhash_t* hash=dmScript::ToHash(state_,stackIndex)) { output->tag=ScriptValueTag::kHandle; output->handleKind=ScriptHandleKind::kHash; output->payload=*hash; return true; } }
  if (codecs & fixed_tuple::kVector3) { if (auto* value=dmScript::ToVector3(state_,stackIndex)) { output->tag=ScriptValueTag::kDefoldValue; output->defoldKind=ScriptDefoldValueKind::kVector3; output->defoldValue[0]=value->getX();output->defoldValue[1]=value->getY();output->defoldValue[2]=value->getZ(); return true; } }
  if (codecs & fixed_tuple::kQuaternion) { if (auto* value=dmScript::ToQuat(state_,stackIndex)) { output->tag=ScriptValueTag::kDefoldValue; output->defoldKind=ScriptDefoldValueKind::kQuaternion; output->defoldValue[0]=value->getX();output->defoldValue[1]=value->getY();output->defoldValue[2]=value->getZ();output->defoldValue[3]=value->getW(); return true; } }
  return fail("Fixed tuple result tag does not match positional codec");
}

fixed_tuple::DispatchStatus ScriptAdapter::invokeFixedTuple(
    const fixed_tuple::Operation& operation, const uint16_t* resultCodecs,
    ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept {
  if (!state_ || !frame || !bindFixedTuple(operation)) { writeError(error,errorCapacity,lastError()); return fixed_tuple::DispatchStatus::kError; }
  const bool scoped=operation.context!=fixed_tuple::Context::kGlobal;
  if (scoped && (!instanceApi_.get||!instanceApi_.set||instanceRef_==LUA_NOREF||instanceRef_==LUA_REFNIL)) { writeError(error,errorCapacity,"Fixed tuple call has no captured Defold instance"); return fixed_tuple::DispatchStatus::kError; }
  if (operation.context==fixed_tuple::Context::kScriptInstance && (!hasActiveContext_||activeContext_!=value_binding::StructuredLuaContext::kScriptInstance)) { writeError(error,errorCapacity,"Fixed tuple call requires an active game-object script instance"); return fixed_tuple::DispatchStatus::kError; }
  if (operation.context==fixed_tuple::Context::kGuiScriptInstance && (!hasActiveContext_||activeContext_!=value_binding::StructuredLuaContext::kGuiScriptInstance)) { writeError(error,errorCapacity,"Fixed tuple call requires an active GUI script instance"); return fixed_tuple::DispatchStatus::kError; }
  const int baseTop=lua_gettop(state_);
  if(scoped){instanceApi_.get(state_);lua_rawgeti(state_,LUA_REGISTRYINDEX,instanceRef_);instanceApi_.set(state_);}
  const int callBase=lua_gettop(state_); lua_rawgeti(state_,LUA_REGISTRYINDEX,fixedTupleFunctionRefs_[operation.index]);
  bool ok=true; for(uint32_t index=0;index<frame->argumentCount;++index) if(!pushStructuredValue(frame->arguments[index])){ok=false;break;}
  if(ok&&lua_pcall(state_,static_cast<int>(frame->argumentCount),LUA_MULTRET,0)!=0){const char* message=lua_tostring(state_,-1);ok=fail(message?message:"Fixed tuple Lua call failed without an error string");}
  const int actual=ok?lua_gettop(state_)-callBase:0;
  if(ok&&actual!=operation.resultCount) ok=fail("Fixed tuple Lua result count does not match exact descriptor");
  if(ok) for(uint8_t index=0;index<operation.resultCount;++index) if(!readFixedTupleResult(resultCodecs[operation.resultOffset+index],callBase+1+index,&frame->results[index],frame)){ok=false;break;}
  if(ok) frame->resultCount=operation.resultCount;
  if(scoped){lua_settop(state_,baseTop+1);instanceApi_.set(state_);} lua_settop(state_,baseTop);
  if(!ok){writeError(error,errorCapacity,lastError());return fixed_tuple::DispatchStatus::kError;}
  adapterError_[0]='\0';return fixed_tuple::DispatchStatus::kSuccess;
}

value_binding::DispatchStatus ScriptAdapter::invokeStructured(
    const value_binding::StructuredLuaOperation& operation,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  if (!state_ || !frame) {
    writeError(error, errorCapacity, "Structured Lua backend is not initialized");
    return value_binding::DispatchStatus::kError;
  }
  if (!bindStructured(operation)) {
    writeError(error, errorCapacity, lastError());
    return value_binding::DispatchStatus::kError;
  }
  if (!instanceApi_.get || !instanceApi_.set || instanceRef_ == LUA_NOREF || instanceRef_ == LUA_REFNIL) {
    writeError(error, errorCapacity, "Structured Lua call has no captured Defold instance");
    return value_binding::DispatchStatus::kError;
  }
  if (!hasActiveContext_ || activeContext_ != operation.context) {
    writeError(error, errorCapacity,
        operation.context == value_binding::StructuredLuaContext::kGuiScriptInstance
          ? "Structured Lua call requires an active GUI script instance"
          : "Structured Lua call requires an active game-object script instance");
    return value_binding::DispatchStatus::kError;
  }
  const int baseTop = lua_gettop(state_);
  instanceApi_.get(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
  instanceApi_.set(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, structuredFunctionRefs_[operation.index]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index])) { ok = false; break; }
  }
  const int resultCount = operation.resultCodec == value_binding::StructuredLuaResultCodec::kNone ? 0 : 1;
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), resultCount, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "Structured Lua call failed without an error string");
  }
  if (ok) ok = readStructuredResult(operation.resultCodec, frame);
  lua_settop(state_, baseTop + 1);
  instanceApi_.set(state_);
  lua_settop(state_, baseTop);
  if (!ok) {
    writeError(error, errorCapacity, lastError());
    return value_binding::DispatchStatus::kError;
  }
  adapterError_[0] = '\0';
  return value_binding::DispatchStatus::kSuccess;
}

void ScriptAdapter::drainReleasedHandles() noexcept {
  if (!state_) return;
  luaHandles_.drain([this](const HandleRecord& record) {
    if (record.state == state_) luaL_unref(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
  });
}

void ScriptAdapter::releaseHandle(
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept {
  if (kind != ScriptHandleKind::kGuiNode && kind != ScriptHandleKind::kLuaUserdata) return;
  const uint32_t type = kind == ScriptHandleKind::kGuiNode ? kNodeHandleType : kLuaUserdataHandleType;
  luaHandles_.queueRelease(unpackHandle(runtime, payload, type));
}

bool ScriptAdapter::fail(const char* message) noexcept {
  std::snprintf(adapterError_, sizeof(adapterError_), "%s", message);
  return false;
}

}  // namespace defold_hermes::lua_bridge::scalar
