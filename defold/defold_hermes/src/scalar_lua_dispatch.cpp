#include <defold_hermes/scalar_lua_dispatch.hpp>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

namespace defold_hermes::lua_bridge::scalar {
namespace {

constexpr int64_t kMaxExactLuaInteger = 9007199254740991LL;

class StackRestore {
 public:
  StackRestore(lua_State* state, int baseTop) noexcept
      : state_(state), baseTop_(baseTop) {}

  ~StackRestore() {
    if (state_) lua_settop(state_, baseTop_);
  }

  void activateInstance(InstanceApi instanceApi) noexcept {
    instanceApi_ = instanceApi;
    instanceActive_ = true;
  }

  void restoreInstance() noexcept {
    if (!instanceActive_) return;
    lua_settop(state_, baseTop_ + 1);
    instanceApi_.set(state_);
    instanceActive_ = false;
    lua_settop(state_, baseTop_);
  }

 private:
  lua_State* state_;
  InstanceApi instanceApi_;
  int baseTop_;
  bool instanceActive_ = false;
};

bool tagMatches(ScalarCodec codec, ScalarTag tag) noexcept {
  switch (codec) {
    case ScalarCodec::kBoolean: return tag == ScalarTag::kBoolean;
    case ScalarCodec::kInteger: return tag == ScalarTag::kInteger;
    case ScalarCodec::kNumber: return tag == ScalarTag::kNumber;
    case ScalarCodec::kString: return tag == ScalarTag::kString;
    case ScalarCodec::kNone: return false;
  }
  return false;
}

}  // namespace

ScalarInput ScalarInput::booleanValue(bool value) noexcept {
  ScalarInput result;
  result.tag = ScalarTag::kBoolean;
  result.boolean = value;
  return result;
}

ScalarInput ScalarInput::integerValue(int64_t value) noexcept {
  ScalarInput result;
  result.tag = ScalarTag::kInteger;
  result.integer = value;
  return result;
}

ScalarInput ScalarInput::numberValue(double value) noexcept {
  ScalarInput result;
  result.tag = ScalarTag::kNumber;
  result.number = value;
  return result;
}

ScalarInput ScalarInput::stringValue(const char* data, uint32_t size) noexcept {
  ScalarInput result;
  result.tag = ScalarTag::kString;
  result.string = {data, size};
  return result;
}

Dispatcher::Dispatcher() noexcept {
  functionRefs_.fill(LUA_NOREF);
}

Dispatcher::~Dispatcher() {
  shutdown();
}

bool Dispatcher::initialize(lua_State* state, uint32_t stackReserve, InstanceApi instanceApi) noexcept {
  shutdown();
  if (!state) return fail("scalar Lua dispatcher requires a state");
  if ((instanceApi.get == nullptr) != (instanceApi.set == nullptr)) {
    return fail("scalar Lua dispatcher instance hooks must be installed as a pair");
  }
  if (stackReserve < generated::kMaxArgumentCount + 2) {
    return fail("scalar Lua dispatcher stack reserve is too small");
  }
  if (stackReserve > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
    return fail("scalar Lua dispatcher stack reserve exceeds Lua 5.1 limits");
  }
  if (!lua_checkstack(state, static_cast<int>(stackReserve))) {
    return fail("unable to reserve the scalar Lua dispatch stack");
  }
  state_ = state;
  instanceApi_ = instanceApi;
  stats_.reservedStackSlots = stackReserve;
  error_[0] = '\0';
  return true;
}

void Dispatcher::shutdown() noexcept {
  if (state_) {
    if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
      luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
    }
    for (int& reference : functionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) {
        luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      }
      reference = LUA_NOREF;
    }
  } else {
    functionRefs_.fill(LUA_NOREF);
  }
  detach();
}

void Dispatcher::detach() noexcept {
  state_ = nullptr;
  instanceApi_ = {};
  instanceRef_ = LUA_NOREF;
  functionRefs_.fill(LUA_NOREF);
  stats_.boundFunctions = 0;
  stats_.reservedStackSlots = 0;
}

bool Dispatcher::captureInstance(int stackIndex) noexcept {
  if (!state_ || !instanceApi_.get) return fail("instance capture is not configured");
  if (!reserveStack(1)) return false;
  if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
  }
  lua_pushvalue(state_, stackIndex);
  instanceRef_ = luaL_ref(state_, LUA_REGISTRYINDEX);
  if (instanceRef_ == LUA_NOREF || instanceRef_ == LUA_REFNIL) {
    return fail("unable to capture the Defold script instance");
  }
  error_[0] = '\0';
  return true;
}

void Dispatcher::detachInstance() noexcept {
  if (state_ && instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
  }
  instanceRef_ = LUA_NOREF;
}

bool findDenseIndex(uint32_t stableId, size_t* outDenseIndex) noexcept {
  if (!outDenseIndex) return false;
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

bool Dispatcher::pushModulePath(const char* path) noexcept {
  constexpr size_t kSegmentCapacity = 64;
  const char* cursor = path;
  bool first = true;
  while (*cursor) {
    const char* dot = std::strchr(cursor, '.');
    const size_t length = dot ? static_cast<size_t>(dot - cursor) : std::strlen(cursor);
    if (length == 0 || length >= kSegmentCapacity) return fail("generated Lua module segment is invalid");
    char segment[kSegmentCapacity];
    std::memcpy(segment, cursor, length);
    segment[length] = '\0';
    if (first) {
      lua_getglobal(state_, segment);
      first = false;
    } else {
      if (!lua_istable(state_, -1)) return fail("Lua module path is not a table");
      lua_getfield(state_, -1, segment);
      lua_remove(state_, -2);
    }
    cursor = dot ? dot + 1 : cursor + length;
  }
  return !first && lua_istable(state_, -1);
}

bool Dispatcher::bind(uint32_t stableId) noexcept {
  if (!state_) return fail("scalar Lua dispatcher is not initialized");
  size_t denseIndex = 0;
  if (!findDenseIndex(stableId, &denseIndex)) return fail("unknown stable scalar binding id");
  return bindDense(denseIndex);
}

bool Dispatcher::bindDense(size_t denseIndex) noexcept {
  if (!state_) return fail("scalar Lua dispatcher is not initialized");
  const auto& table = generated::tables();
  if (denseIndex >= table.bindingCount || denseIndex >= functionRefs_.size()) {
    return fail("unknown dense scalar binding index");
  }
  if (functionRefs_[denseIndex] != LUA_NOREF && functionRefs_[denseIndex] != LUA_REFNIL) {
    error_[0] = '\0';
    return true;
  }
  if (!reserveStack(2)) return false;

  error_[0] = '\0';
  const int baseTop = lua_gettop(state_);
  StackRestore restore(state_, baseTop);
  if (!pushModulePath(table.modulePaths[denseIndex])) {
    if (error_[0] == '\0') fail("Lua module is unavailable for scalar binding");
    return false;
  }
  lua_getfield(state_, -1, table.members[denseIndex]);
  if (!lua_isfunction(state_, -1)) return fail("Lua function is unavailable for scalar binding");
  functionRefs_[denseIndex] = luaL_ref(state_, LUA_REGISTRYINDEX);
  ++stats_.boundFunctions;
  error_[0] = '\0';
  return true;
}

bool Dispatcher::isBound(uint32_t stableId) const noexcept {
  size_t denseIndex = 0;
  return findDenseIndex(stableId, &denseIndex) && isBoundDense(denseIndex);
}

bool Dispatcher::isBoundDense(size_t denseIndex) const noexcept {
  return denseIndex < generated::tables().bindingCount && denseIndex < functionRefs_.size() &&
      functionRefs_[denseIndex] != LUA_NOREF && functionRefs_[denseIndex] != LUA_REFNIL;
}

bool Dispatcher::reserveStack(size_t slots) noexcept {
  if (slots > static_cast<size_t>(std::numeric_limits<int>::max()) ||
      !lua_checkstack(state_, static_cast<int>(slots))) {
    return fail("unable to reserve the scalar Lua dispatch stack");
  }
  return true;
}

bool Dispatcher::validateArguments(
    size_t denseIndex,
    binding::Span<const ScalarInput> arguments) noexcept {
  const auto& table = generated::tables();
  const size_t count = arguments.size;
  if (count < table.requiredArgumentCounts[denseIndex] ||
      count > table.maximumArgumentCounts[denseIndex]) {
    return fail("scalar Lua binding argument count does not match its descriptor");
  }
  if (count != 0 && !arguments.data) return fail("scalar Lua binding arguments are null");
  const size_t offset = table.argumentOffsets[denseIndex];
  for (size_t index = 0; index < count; ++index) {
    if (!tagMatches(table.argumentCodecs[offset + index], arguments[index].tag)) {
      return fail("scalar Lua binding argument tag does not match its descriptor");
    }
    if (arguments[index].tag == ScalarTag::kString &&
        arguments[index].string.size != 0 && !arguments[index].string.data) {
      return fail("scalar Lua binding string data is null");
    }
  }
  return true;
}

bool Dispatcher::pushArgument(ScalarCodec codec, const ScalarInput& input) noexcept {
  switch (codec) {
    case ScalarCodec::kBoolean:
      lua_pushboolean(state_, input.boolean ? 1 : 0);
      return true;
    case ScalarCodec::kInteger:
      if (input.integer < -kMaxExactLuaInteger || input.integer > kMaxExactLuaInteger) {
        return fail("integer argument is not exactly representable by Defold Lua 5.1");
      }
      lua_pushnumber(state_, static_cast<lua_Number>(input.integer));
      return true;
    case ScalarCodec::kNumber:
      lua_pushnumber(state_, static_cast<lua_Number>(input.number));
      return true;
    case ScalarCodec::kString:
      lua_pushlstring(state_, input.string.data ? input.string.data : "", input.string.size);
      return true;
    case ScalarCodec::kNone:
      return fail("void is not a valid scalar Lua argument codec");
  }
  return fail("unknown scalar Lua argument codec");
}

bool Dispatcher::readResult(size_t denseIndex, ScalarOutput* output) noexcept {
  const auto& table = generated::tables();
  const ScalarCodec codec = table.resultCodecs[denseIndex];
  if (codec == ScalarCodec::kNone) return true;
  if (!output) return fail("scalar Lua binding requires result storage");
  if (lua_isnil(state_, -1)) {
    if (!table.resultNullable[denseIndex]) return fail("scalar Lua binding returned unexpected nil");
    output->tag = ScalarTag::kNil;
    output->stringSize = 0;
    return true;
  }

  switch (codec) {
    case ScalarCodec::kBoolean:
      if (lua_type(state_, -1) != LUA_TBOOLEAN) return fail("scalar Lua result is not a boolean");
      output->tag = ScalarTag::kBoolean;
      output->boolean = lua_toboolean(state_, -1) != 0;
      return true;
    case ScalarCodec::kInteger: {
      if (lua_type(state_, -1) != LUA_TNUMBER) return fail("scalar Lua result is not an integer");
      const double value = static_cast<double>(lua_tonumber(state_, -1));
      if (!std::isfinite(value) || std::trunc(value) != value ||
          value < -static_cast<double>(kMaxExactLuaInteger) ||
          value > static_cast<double>(kMaxExactLuaInteger)) {
        return fail("scalar Lua result is not an exactly representable integer");
      }
      output->tag = ScalarTag::kInteger;
      output->integer = static_cast<int64_t>(value);
      return true;
    }
    case ScalarCodec::kNumber:
      if (lua_type(state_, -1) != LUA_TNUMBER) return fail("scalar Lua result is not a number");
      output->tag = ScalarTag::kNumber;
      output->number = static_cast<double>(lua_tonumber(state_, -1));
      return true;
    case ScalarCodec::kString: {
      if (lua_type(state_, -1) != LUA_TSTRING) return fail("scalar Lua result is not a string");
      size_t size = 0;
      const char* data = lua_tolstring(state_, -1, &size);
      if (size > std::numeric_limits<uint32_t>::max()) return fail("scalar Lua string result exceeds ABI size");
      output->stringSize = static_cast<uint32_t>(size);
      if (size > output->stringCapacity || (size != 0 && !output->stringData)) {
        output->tag = ScalarTag::kNil;
        return fail("scalar Lua string result buffer is too small");
      }
      if (size != 0) std::memcpy(output->stringData, data, size);
      output->tag = ScalarTag::kString;
      return true;
    }
    case ScalarCodec::kNone:
      return true;
  }
  return fail("unknown scalar Lua result codec");
}

bool Dispatcher::dispatch(
    uint32_t stableId,
    binding::Span<const ScalarInput> arguments,
    ScalarOutput* output) noexcept {
  if (!state_) return fail("scalar Lua dispatcher is not initialized");
  size_t denseIndex = 0;
  if (!findDenseIndex(stableId, &denseIndex)) return fail("unknown stable scalar binding id");
  return dispatchDense(denseIndex, arguments, output);
}

bool Dispatcher::dispatchDense(
    size_t denseIndex,
    binding::Span<const ScalarInput> arguments,
    ScalarOutput* output) noexcept {
  if (!state_) return fail("scalar Lua dispatcher is not initialized");
  const auto& table = generated::tables();
  if (denseIndex >= table.bindingCount || denseIndex >= functionRefs_.size()) {
    return fail("unknown dense scalar binding index");
  }
  if (!reserveStack(arguments.size + 3)) return false;
  const int reference = functionRefs_[denseIndex];
  if (reference == LUA_NOREF || reference == LUA_REFNIL) {
    return fail("scalar Lua binding was not bound during initialization");
  }
  if (!validateArguments(denseIndex, arguments)) return false;
  const ScalarCodec resultCodec = table.resultCodecs[denseIndex];
  if (resultCodec != ScalarCodec::kNone && !output) {
    return fail("scalar Lua binding requires result storage");
  }

  const int baseTop = lua_gettop(state_);
  StackRestore restore(state_, baseTop);
  if (instanceApi_.get) {
    if (instanceRef_ == LUA_NOREF || instanceRef_ == LUA_REFNIL) {
      return fail("Defold instance hooks are configured but no instance is captured");
    }
    instanceApi_.get(state_);
    lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
    instanceApi_.set(state_);
    restore.activateInstance(instanceApi_);
  }

  lua_rawgeti(state_, LUA_REGISTRYINDEX, reference);
  const size_t argumentOffset = table.argumentOffsets[denseIndex];
  bool succeeded = true;
  for (size_t index = 0; index < arguments.size; ++index) {
    if (!pushArgument(table.argumentCodecs[argumentOffset + index], arguments[index])) {
      succeeded = false;
      break;
    }
  }
  if (succeeded) {
    ++stats_.calls;
    const int resultCount = resultCodec == ScalarCodec::kNone ? 0 : 1;
    if (lua_pcall(state_, static_cast<int>(arguments.size), resultCount, 0) != 0) {
      const char* message = lua_tostring(state_, -1);
      succeeded = fail(message ? message : "Lua scalar binding failed without an error string");
    } else {
      succeeded = readResult(denseIndex, output);
    }
  }
  restore.restoreInstance();
  if (succeeded) error_[0] = '\0';
  return succeeded;
}

bool Dispatcher::fail(const char* message) noexcept {
  setError(message);
  ++stats_.failures;
  return false;
}

void Dispatcher::setError(const char* message) noexcept {
  std::snprintf(error_, sizeof(error_), "%s", message ? message : "unknown scalar Lua dispatch error");
}

}  // namespace defold_hermes::lua_bridge::scalar
