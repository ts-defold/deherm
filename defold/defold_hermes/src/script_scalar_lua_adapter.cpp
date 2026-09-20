#include <defold_hermes/script_scalar_lua_adapter.hpp>
#include <defold_hermes/generated_script_callback_lifecycle.hpp>
#include <defold_hermes/generated_script_value_bindings.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <array>
#include <atomic>
#include <new>

namespace dmScript {
void PushHash(lua_State* state, dmhash_t hash);
dmhash_t* ToHash(lua_State* state, int index);
void PushVector3(lua_State* state, const dmVMath::Vector3& value);
void PushVector4(lua_State* state, const dmVMath::Vector4& value);
void PushQuat(lua_State* state, const dmVMath::Quat& value);
void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value);
void PushURL(lua_State* state, const dmMessage::URL& value);
dmVMath::Vector3* ToVector3(lua_State* state, int index);
dmVMath::Vector4* ToVector4(lua_State* state, int index);
dmVMath::Quat* ToQuat(lua_State* state, int index);
dmVMath::Matrix4* ToMatrix4(lua_State* state, int index);
dmMessage::URL* ToURL(lua_State* state, int index);
}  // namespace dmScript

namespace defold_hermes::lua_bridge::scalar {

struct LuaClosureRoot {
  std::atomic<uint32_t> references{1};
  ScriptAdapter* adapter = nullptr;
  lua_State* state = nullptr;
  int reference = LUA_NOREF;
  std::shared_ptr<LuaClosureLifetime> lifetime;
  ScriptCallback callback{};
};

struct LuaClosureLifetime {
  static constexpr size_t kMaximumRoots = 256;

  explicit LuaClosureLifetime(lua_State* input) noexcept : state(input) {}

  bool attach(LuaClosureRoot* root) noexcept {
    if (!active || !root) return false;
    for (auto*& slot : roots) {
      if (slot) continue;
      slot = root;
      return true;
    }
    return false;
  }

  void detach(LuaClosureRoot* root) noexcept {
    for (auto*& slot : roots) {
      if (slot != root) continue;
      slot = nullptr;
      return;
    }
  }

  void shutdown() noexcept {
    if (!active) return;
    active = false;
    for (auto*& slot : roots) {
      LuaClosureRoot* root = slot;
      slot = nullptr;
      if (!root) continue;
      if (root->state && root->reference != LUA_NOREF && root->reference != LUA_REFNIL) {
        luaL_unref(root->state, LUA_REGISTRYINDEX, root->reference);
      }
      root->reference = LUA_NOREF;
      root->state = nullptr;
      root->adapter = nullptr;
    }
    state = nullptr;
  }

  ~LuaClosureLifetime() { shutdown(); }

  std::array<LuaClosureRoot*, kMaximumRoots> roots{};
  lua_State* state = nullptr;
  bool active = true;
};

namespace {
constexpr int64_t kMaxExactInteger = 9007199254740991LL;
constexpr uint32_t kNodeHandleType = 1;
constexpr uint32_t kLuaUserdataHandleType = 2;
constexpr const char* kCallbackMetatable = "_deherm_.retained_callback";
constexpr const char* kLuaErrorTablePrefix = "__deherm_lua_error_table_v1__:";

struct CallbackLuaRoot {
  ScriptCallback* callback = nullptr;
};

struct CallbackConsumeContext {
  ScriptAdapter* adapter = nullptr;
  lua_State* state = nullptr;
  int baseTop = 0;
  int resultCount = 0;
};

bool containsCallback(const ScriptValue& value, uint32_t depth = 0) noexcept {
  if (value.tag == ScriptValueTag::kCallback) return true;
  if (value.tag != ScriptValueTag::kTable || !value.data ||
      depth >= universal_value::kMaximumDepth) return false;
  const auto* entries = static_cast<const ScriptTableEntry*>(value.data);
  for (uint32_t index = 0; index < value.length; ++index) {
    if (containsCallback(entries[index].key, depth + 1) ||
        containsCallback(entries[index].value, depth + 1)) return true;
  }
  return false;
}

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

}

ScriptAdapter::ScriptAdapter() : luaHandles_(kLuaHandleCapacity) {
  structuredFunctionRefs_.fill(LUA_NOREF);
  fixedTupleFunctionRefs_.fill(LUA_NOREF);
  structuredLuaApi_ = {this, StructuredInvokeThunk};
  fixedTupleLuaApi_ = {this, FixedTupleInvokeThunk};
  urlLuaApi_ = {this, UrlInvokeThunk};
  valueTailLuaApi_ = {this, ValueTailInvokeThunk};
  overloadLuaApi_ = {this, OverloadInvokeThunk};
  tableRecordLuaApi_ = {this, TableRecordInvokeThunk};
  universalValueLuaApi_ = {this, UniversalValueInvokeThunk};
}

bool ScriptAdapter::initialize(lua_State* state, InstanceApi instanceApi,
    const ::defold_hermes::script_handle_lowering::RuntimeProfileHandshake& profileHandshake,
    ::defold_hermes::lua_bridge::LuaRegistryApi semanticRegistryApi) {
  shutdown();
  adapterError_[0] = '\0';
  runtimeProfile_ = ::defold_hermes::script_handle_lowering::validateRuntimeProfile(profileHandshake);
  if (!runtimeProfile_) return fail("Defold runtime profile capability handshake is missing or stale");
  if (!dispatcher_.initialize(state, 32, instanceApi)) return false;
  state_ = state;
  instanceApi_ = instanceApi;
  semanticRegistryApi_ = semanticRegistryApi;
  luaClosureLifetime_ = std::make_shared<LuaClosureLifetime>(state_);
  if (++runtimeGeneration_ == 0) ++runtimeGeneration_;
  semanticHandleRegistry_ = std::make_unique<::defold_hermes::lua_bridge::LuaValueRegistry>(
      state_, runtimeGeneration_, kLuaHandleCapacity, kLuaHandleCapacity, semanticRegistryApi_);
  handleRouter_ = std::make_unique<::defold_hermes::script_handle_lowering::CapturedLuaRouter>(
      state_, *semanticHandleRegistry_, *runtimeProfile_, instanceApi_);
  structuredFunctionRefs_.fill(LUA_NOREF);
  fixedTupleFunctionRefs_.fill(LUA_NOREF);
  urlFunctionRefs_.fill(LUA_NOREF);
  valueTailFunctionRefs_.fill(LUA_NOREF);
  overloadFunctionRefs_.fill(LUA_NOREF);
  tableRecordFunctionRefs_.fill(LUA_NOREF);
  universalValueFunctionRefs_.fill(LUA_NOREF);
  return true;
}

void ScriptAdapter::shutdown() noexcept {
  if (state_) {
    // Returned Lua closures may outlive the adapter's Lua registry. Unroot and
    // inert them while the state is unquestionably valid; later JSI finalizers
    // only release the native descriptor.
    if (luaClosureLifetime_) luaClosureLifetime_->shutdown();
    handleRouter_.reset();
    semanticHandleRegistry_.reset();
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
    for (int& reference : urlFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    for (int& reference : valueTailFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    for (int& reference : overloadFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    for (int& reference : tableRecordFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    for (int& reference : universalValueFunctionRefs_) {
      if (reference != LUA_NOREF && reference != LUA_REFNIL) luaL_unref(state_, LUA_REGISTRYINDEX, reference);
      reference = LUA_NOREF;
    }
    if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
      luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
    }
  }
  instanceRef_ = LUA_NOREF;
  handleRouter_.reset();
  semanticHandleRegistry_.reset();
  luaClosureLifetime_.reset();
  hasActiveContext_ = false;
  componentContextDepth_ = 0;
  state_ = nullptr;
  instanceApi_ = {};
  runtimeProfile_ = nullptr;
  semanticRegistryApi_ = {};
  dispatcher_.shutdown();
}

bool ScriptAdapter::captureInstance(int stackIndex) noexcept {
  return captureContext(stackIndex, ActiveContext::kGameObject);
}

bool ScriptAdapter::captureGuiInstance(int stackIndex) noexcept {
  return captureContext(stackIndex, ActiveContext::kGui);
}

bool ScriptAdapter::captureRenderInstance(int stackIndex) noexcept {
  return captureContext(stackIndex, ActiveContext::kRender);
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

bool ScriptAdapter::captureLuaClosure(int stackIndex, ScriptValue* output) noexcept {
  if (!state_ || !output || !lua_isfunction(state_, stackIndex) ||
      !luaClosureLifetime_ || !luaClosureLifetime_->active) {
    return fail("Lua closure capture requires an active generated closure lifetime");
  }
  lua_pushvalue(state_, stackIndex);
  const int reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  auto* root = new (std::nothrow) LuaClosureRoot{};
  if (!root) {
    luaL_unref(state_, LUA_REGISTRYINDEX, reference);
    return fail("Lua closure root allocation failed");
  }
  root->adapter = this;
  root->state = state_;
  root->reference = reference;
  root->lifetime = luaClosureLifetime_;
  root->callback = {
    root, InvokeLuaClosure, RetainLuaClosure, ReleaseLuaClosure
  };
  if (!luaClosureLifetime_->attach(root)) {
    luaL_unref(state_, LUA_REGISTRYINDEX, reference);
    delete root;
    return fail("Lua closure root arena is exhausted");
  }
  *output = {};
  output->tag = ScriptValueTag::kCallback;
  output->data = &root->callback;
  return true;
}

bool ScriptAdapter::captureSemanticHandle(
    int stackIndex,
    ::defold_hermes::script_handle_lowering::SemanticHandleKind kind,
    ScriptValue* output) noexcept {
  adapterError_[0] = '\0';
  if (!handleRouter_ || !handleRouter_->captureHandle(stackIndex, kind, output)) {
    return fail("Semantic Lua handle capture failed or the fixed registry is exhausted");
  }
  return true;
}

bool ScriptAdapter::ensureComponentFallbackInstance(
    int stackIndex,
    ComponentContext context) noexcept {
  if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) return true;
  const ActiveContext selected = context == ComponentContext::kGameObject
      ? ActiveContext::kGameObject
      : context == ComponentContext::kGui ? ActiveContext::kGui : ActiveContext::kRender;
  return captureContext(stackIndex, selected);
}

bool ScriptAdapter::pushComponentContext(ComponentContext context) noexcept {
  if (componentContextDepth_ >= componentContexts_.size()) {
    return fail("component script context stack is exhausted");
  }
  componentContexts_[componentContextDepth_++] = context == ComponentContext::kGameObject
      ? ActiveContext::kGameObject
      : context == ComponentContext::kGui ? ActiveContext::kGui : ActiveContext::kRender;
  return true;
}

void ScriptAdapter::popComponentContext() noexcept {
  if (componentContextDepth_ != 0) --componentContextDepth_;
}

bool ScriptAdapter::hasSelectedContext() const noexcept {
  return componentContextDepth_ != 0 || hasActiveContext_;
}

ScriptAdapter::ActiveContext ScriptAdapter::selectedContext() const noexcept {
  return componentContextDepth_ != 0
      ? componentContexts_[componentContextDepth_ - 1]
      : activeContext_;
}

bool ScriptAdapter::captureContext(
    int stackIndex,
    ActiveContext context) noexcept {
  adapterError_[0] = '\0';
  if (!state_ || !instanceApi_.get || !instanceApi_.set) return fail("instance capture is not configured");
  detachInstance();
  if (!dispatcher_.captureInstance(stackIndex)) return false;
  if (!handleRouter_ || !handleRouter_->captureInstance(stackIndex)) {
    dispatcher_.detachInstance();
    return fail("unable to capture the handle-router script instance");
  }
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
  if (handleRouter_) handleRouter_->detachInstance();
  luaHandles_.sweep([this](const HandleRecord& record) {
    if (record.state == state_) luaL_unref(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
  });
  if (instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL) {
    luaL_unref(state_, LUA_REGISTRYINDEX, instanceRef_);
  }
  instanceRef_ = LUA_NOREF;
  hasActiveContext_ = false;
  if (++runtimeGeneration_ == 0) ++runtimeGeneration_;
  if (semanticHandleRegistry_) {
    semanticHandleRegistry_->rebind(state_, runtimeGeneration_, semanticRegistryApi_);
  }
}

bool ScriptAdapter::dispatch(ScriptCallFrame* frame) noexcept {
  if (!frame) return fail("Defold script call frame is null");
  adapterError_[0] = '\0';
  frame->resultCount = 0;
  frame->stringScratchUsed = 0;
  frame->tableScratchUsed = 0;

  drainReleasedHandles();
  const auto valueStatus = value_binding::dispatch(
      frame, adapterError_, sizeof(adapterError_), &structuredLuaApi_);
  if (valueStatus == value_binding::DispatchStatus::kSuccess) return true;
  if (valueStatus == value_binding::DispatchStatus::kError) return false;

  const auto tupleStatus = fixed_tuple::dispatch(
      frame, adapterError_, sizeof(adapterError_), &fixedTupleLuaApi_);
  if (tupleStatus == fixed_tuple::DispatchStatus::kSuccess) return true;
  if (tupleStatus == fixed_tuple::DispatchStatus::kError) return false;

  const auto urlStatus = url_binding::dispatch(
      frame, adapterError_, sizeof(adapterError_), &urlLuaApi_);
  if (urlStatus == url_binding::DispatchStatus::kSuccess) return true;
  if (urlStatus == url_binding::DispatchStatus::kError) return false;

  const auto valueTailStatus = value_tail::dispatch(
      frame, adapterError_, sizeof(adapterError_), &valueTailLuaApi_);
  if (valueTailStatus == value_tail::DispatchStatus::kSuccess) return true;
  if (valueTailStatus == value_tail::DispatchStatus::kError) return false;

  const auto overloadStatus = overload_dispatch::dispatch(
      frame, adapterError_, sizeof(adapterError_), &overloadLuaApi_);
  if (overloadStatus == overload_dispatch::DispatchStatus::kSuccess) return true;
  if (overloadStatus == overload_dispatch::DispatchStatus::kError) return false;

  const auto tableRecordStatus = table_record::dispatch(
      frame, adapterError_, sizeof(adapterError_), &tableRecordLuaApi_);
  if (tableRecordStatus == table_record::DispatchStatus::kSuccess) return true;
  if (tableRecordStatus == table_record::DispatchStatus::kError) return false;

  if (const auto* handleRoute = script_handle_lowering::find(frame->stableId)) {
    (void)handleRoute;
    if (!handleRouter_) return fail("Defold semantic handle router is unavailable");
    return handleRouter_->dispatch(frame, adapterError_, sizeof(adapterError_));
  }

  size_t denseIndex = 0;
  if (!findDenseIndex(frame->stableId, &denseIndex)) {
    const auto universalStatus = universal_value::dispatch(
        frame, adapterError_, sizeof(adapterError_), &universalValueLuaApi_);
    if (universalStatus == universal_value::DispatchStatus::kSuccess) return true;
    if (universalStatus == universal_value::DispatchStatus::kError) return false;
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

  if (!dispatcher_.isBoundDense(denseIndex) && !dispatcher_.bindDense(denseIndex)) return false;
  const ScalarCodec resultCodec = table.resultCodecs[denseIndex];
  ScalarOutput output;
  if (resultCodec == ScalarCodec::kString) {
    output.stringData = frame->stringScratch;
    output.stringCapacity = frame->stringScratchCapacity;
  }
  if (!dispatcher_.dispatchDense(
          denseIndex,
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

int ScriptAdapter::LuaCallbackGc(lua_State* state) {
  auto* root = static_cast<CallbackLuaRoot*>(lua_touserdata(state, 1));
  if (root && root->callback) {
    ScriptCallback* callback = root->callback;
    root->callback = nullptr;
    callback->release(callback->context);
  }
  return 0;
}

bool ScriptAdapter::ConsumeCallbackResults(
    void* opaque,
    const ScriptCallFrame* results) noexcept {
  auto* context = static_cast<CallbackConsumeContext*>(opaque);
  if (!context || !context->adapter || !context->state || !results ||
      results->resultCount > results->resultCapacity ||
      (results->resultCount && !results->results)) return false;
  lua_settop(context->state, context->baseTop);
  for (uint32_t index = 0; index < results->resultCount; ++index) {
    if (!context->adapter->pushStructuredValue(results->results[index],
            const_cast<ScriptCallFrame*>(results))) {
      lua_settop(context->state, context->baseTop);
      return false;
    }
  }
  context->resultCount = static_cast<int>(results->resultCount);
  return true;
}

int ScriptAdapter::LuaCallbackThunk(lua_State* state) {
  auto* adapter = static_cast<ScriptAdapter*>(lua_touserdata(state, lua_upvalueindex(1)));
  auto* root = static_cast<CallbackLuaRoot*>(lua_touserdata(state, lua_upvalueindex(2)));
  if (!adapter || !root || !root->callback || !root->callback->invoke) {
    return luaL_error(state, "deherm callback is unavailable");
  }
  const int argumentCount = lua_gettop(state);
  if (argumentCount < 0 || static_cast<size_t>(argumentCount) > universal_value::kMaximumArgumentCount) {
    return luaL_error(state, "deherm callback argument count exceeds the generated bound");
  }
  constexpr int kCallbackStackReserve =
      static_cast<int>(universal_value::kMaximumArgumentCount +
          universal_value::kMaximumDepth * 2 + 16);
  if (!lua_checkstack(state, kCallbackStackReserve)) {
    return luaL_error(state, "deherm callback cannot reserve its bounded Lua stack frame");
  }
  std::array<ScriptValue, universal_value::kMaximumArgumentCount> arguments{};
  std::array<ScriptValue, universal_value::kMaximumResultCount> results{};
  std::array<ScriptTableEntry, universal_value::kMaximumEntries> tableScratch{};
  std::array<ScriptValue,
      universal_value::kMaximumArgumentCount + universal_value::kMaximumEntries * 2>
      borrowedHandles{};
  uint32_t borrowedHandleCount = 0;
  std::array<char, universal_value::kMaximumStringBytes> stringScratch{};
  ScriptMatrix4Arena matrix4Arena{};
  ScriptUrlArena<> urlArena{};
  urlArena.resetRuntime(adapter->runtimeGeneration_);
  ScriptCallFrame frame{};
  frame.arguments = arguments.data();
  frame.argumentCount = static_cast<uint32_t>(argumentCount);
  frame.results = results.data();
  frame.resultCapacity = static_cast<uint32_t>(results.size());
  frame.tableScratch = tableScratch.data();
  frame.tableScratchCapacity = static_cast<uint32_t>(tableScratch.size());
  frame.stringScratch = stringScratch.data();
  frame.stringScratchCapacity = static_cast<uint32_t>(stringScratch.size());
  frame.matrix4Arena = &matrix4Arena;
  frame.urlArena = &urlArena;
  const void* ancestors[universal_value::kMaximumDepth]{};
  auto releaseBorrowedHandles = [&]() noexcept {
    for (uint32_t index = 0; index < borrowedHandleCount; ++index) {
      const ScriptValue& value = borrowedHandles[index];
      adapter->releaseHandle(value.handleKind, value.length, value.payload);
    }
    borrowedHandleCount = 0;
    adapter->drainReleasedHandles();
  };
  for (int index = 0; index < argumentCount; ++index) {
    if (!adapter->readUniversalValue(index + 1, &arguments[static_cast<size_t>(index)],
            &frame, 0, ancestors, 0, borrowedHandles.data(),
            static_cast<uint32_t>(borrowedHandles.size()), &borrowedHandleCount)) {
      releaseBorrowedHandles();
      return luaL_error(state, "%s", adapter->lastError());
    }
  }
  CallbackConsumeContext consume{adapter, state, argumentCount, 0};
  char error[384]{};
  const bool invoked = root->callback->invoke(root->callback->context, &frame, &consume,
      ConsumeCallbackResults, error, sizeof(error));
  releaseBorrowedHandles();
  if (!invoked) {
    lua_settop(state, argumentCount);
    if (std::strncmp(error, kLuaErrorTablePrefix,
            std::strlen(kLuaErrorTablePrefix)) == 0) {
      lua_createtable(state, 1, 0);
      const char* payload = error + std::strlen(kLuaErrorTablePrefix);
      const char* newline = std::strchr(payload, '\n');
      lua_pushlstring(state, payload,
          newline ? static_cast<size_t>(newline - payload) : std::strlen(payload));
      lua_rawseti(state, -2, 1);
      return lua_error(state);
    }
    return luaL_error(state, "%s", error[0] ? error : "JavaScript callback failed");
  }
  return consume.resultCount;
}

void ScriptAdapter::RetainLuaClosure(void* opaque) noexcept {
  if (auto* root = static_cast<LuaClosureRoot*>(opaque)) {
    root->references.fetch_add(1, std::memory_order_relaxed);
  }
}

void ScriptAdapter::ReleaseLuaClosure(void* opaque) noexcept {
  auto* root = static_cast<LuaClosureRoot*>(opaque);
  if (!root || root->references.fetch_sub(1, std::memory_order_acq_rel) != 1) return;
  const auto lifetime = root->lifetime;
  if (lifetime) lifetime->detach(root);
  if (root->state && root->reference != LUA_NOREF && root->reference != LUA_REFNIL) {
    luaL_unref(root->state, LUA_REGISTRYINDEX, root->reference);
  }
  root->reference = LUA_NOREF;
  root->state = nullptr;
  root->adapter = nullptr;
  delete root;
}

bool ScriptAdapter::InvokeLuaClosure(
    void* opaque,
    const ScriptCallFrame* arguments,
    void* consumeContext,
    ScriptCallbackConsume consume,
    char* error,
    size_t errorCapacity) noexcept {
  auto* root = static_cast<LuaClosureRoot*>(opaque);
  auto reject = [&](const char* message) noexcept {
    writeError(error, errorCapacity, message);
    return false;
  };
  if (!root || !root->adapter || !root->state || root->reference == LUA_NOREF ||
      root->reference == LUA_REFNIL || !root->lifetime || !root->lifetime->active) {
    return reject("Lua closure belongs to a destroyed Defold script runtime");
  }
  if (!arguments || !consume ||
      arguments->argumentCount > universal_value::kMaximumArgumentCount ||
      (arguments->argumentCount && !arguments->arguments)) {
    return reject("Lua closure received an invalid bounded argument frame");
  }
  auto* adapter = root->adapter;
  lua_State* state = root->state;
  constexpr int kStackReserve = static_cast<int>(
      universal_value::kMaximumArgumentCount +
      universal_value::kMaximumResultCount +
      universal_value::kMaximumDepth * 2 + 16);
  if (!lua_checkstack(state, kStackReserve)) {
    return reject("Lua closure cannot reserve its bounded stack frame");
  }

  std::array<ScriptValue, universal_value::kMaximumResultCount> results{};
  std::array<ScriptTableEntry, universal_value::kMaximumEntries> tableScratch{};
  std::array<char, universal_value::kMaximumStringBytes> stringScratch{};
  ScriptMatrix4Arena matrix4Arena{};
  ScriptUrlArena<> urlArena{};
  urlArena.resetRuntime(adapter->runtimeGeneration_);
  ScriptCallFrame output{};
  output.results = results.data();
  output.resultCapacity = static_cast<uint32_t>(results.size());
  output.tableScratch = tableScratch.data();
  output.tableScratchCapacity = static_cast<uint32_t>(tableScratch.size());
  output.stringScratch = stringScratch.data();
  output.stringScratchCapacity = static_cast<uint32_t>(stringScratch.size());
  output.matrix4Arena = &matrix4Arena;
  output.urlArena = &urlArena;

  const int baseTop = lua_gettop(state);
  const bool scoped = adapter->hasSelectedContext() && adapter->instanceApi_.get &&
      adapter->instanceApi_.set && adapter->instanceRef_ != LUA_NOREF &&
      adapter->instanceRef_ != LUA_REFNIL;
  if (scoped) {
    adapter->instanceApi_.get(state);
    lua_rawgeti(state, LUA_REGISTRYINDEX, adapter->instanceRef_);
    adapter->instanceApi_.set(state);
  }
  const int callBase = lua_gettop(state);
  lua_rawgeti(state, LUA_REGISTRYINDEX, root->reference);
  bool ok = lua_isfunction(state, -1);
  if (!ok) adapter->fail("Lua closure registry reference is stale");
  for (uint32_t index = 0; ok && index < arguments->argumentCount; ++index) {
    if (!adapter->pushStructuredValue(arguments->arguments[index],
            const_cast<ScriptCallFrame*>(arguments))) ok = false;
  }
  if (ok && lua_pcall(state, static_cast<int>(arguments->argumentCount), LUA_MULTRET, 0) != 0) {
    const char* message = lua_tostring(state, -1);
    bool tableError = false;
    if (!message && lua_istable(state, -1)) {
      lua_rawgeti(state, -1, 1);
      message = lua_tostring(state, -1);
      tableError = message != nullptr;
    }
    if (tableError) {
      char tagged[sizeof(adapter->adapterError_)]{};
      std::snprintf(tagged, sizeof(tagged), "%s%s", kLuaErrorTablePrefix, message);
      adapter->fail(tagged);
    } else {
      adapter->fail(message ? message : "Lua closure failed with a non-string error");
    }
    ok = false;
  }
  const int actualResultCount = ok ? lua_gettop(state) - callBase : 0;
  if (ok && (actualResultCount < 0 ||
      static_cast<size_t>(actualResultCount) > results.size())) {
    adapter->fail("Lua closure result count exceeds the generated bound");
    ok = false;
  }
  const void* ancestors[universal_value::kMaximumDepth]{};
  for (int index = 0; ok && index < actualResultCount; ++index) {
    if (!adapter->readUniversalValue(callBase + 1 + index,
            &results[static_cast<size_t>(index)], &output, 0, ancestors, 0)) ok = false;
  }
  if (ok) {
    output.resultCount = static_cast<uint32_t>(actualResultCount);
    ok = consume(consumeContext, &output);
    if (!ok && !adapter->lastError()[0]) {
      adapter->fail("JavaScript rejected Lua closure results");
    }
  }
  if (scoped) {
    lua_settop(state, baseTop + 1);
    adapter->instanceApi_.set(state);
  }
  lua_settop(state, baseTop);
  if (!ok) return reject(adapter->lastError());
  adapter->adapterError_[0] = '\0';
  return true;
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

bool ScriptAdapter::pushStructuredValue(
    const ScriptValue& value,
    ScriptCallFrame* frame,
    uint32_t depth) noexcept {
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
      if (value.handleKind == ScriptHandleKind::kUrl) {
        dmMessage::URL url{};
        if (!frame || !frame->urlArena || !frame->urlArena->copyForPushUrl(
                value, frame->urlArena->runtimeToken(), &url)) {
          return fail("Structured Lua URL token is stale or belongs to another frame arena");
        }
        dmScript::PushURL(state_, url);
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
      if (value.handleKind == ScriptHandleKind::kLuaSemanticHandle && semanticHandleRegistry_) {
        const ::defold_hermes::lua_bridge::Handle handle{
          value.length,
          static_cast<uint32_t>(value.payload),
          static_cast<uint32_t>(value.payload >> 32u),
          static_cast<uint32_t>(::defold_hermes::lua_bridge::LuaValueKind::kUserdata)
        };
        if (semanticHandleRegistry_->push(handle, {
              ::defold_hermes::lua_bridge::LuaValueKind::kUserdata,
              ::defold_hermes::lua_bridge::LuaValuePolicy::kBorrowed,
              value.reserved})) return true;
        return fail("Semantic Lua handle is stale, cross-runtime, or wrong-kind");
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
      if (value.defoldKind == ScriptDefoldValueKind::kMatrix4) {
        if (!frame || !frame->matrix4Arena) {
          return fail("Matrix4 frame arena is unavailable");
        }
        const float* elements = frame->matrix4Arena->resolve(value);
        if (!elements) {
          return fail("Matrix4 token is stale or belongs to another frame arena");
        }
        for (size_t index = 0; index < 16; ++index) {
          if (std::isnan(elements[index])) return fail("Matrix4 input rejects NaN components");
        }
        dmScript::PushMatrix4(state_, dmVMath::Matrix4(
            dmVMath::Vector4(elements[0], elements[1], elements[2], elements[3]),
            dmVMath::Vector4(elements[4], elements[5], elements[6], elements[7]),
            dmVMath::Vector4(elements[8], elements[9], elements[10], elements[11]),
            dmVMath::Vector4(elements[12], elements[13], elements[14], elements[15])));
        return true;
      }
      return fail("Structured Lua Defold value kind is unsupported");
    case ScriptValueTag::kTable: {
      if (depth >= universal_value::kMaximumDepth) return fail("Structured Lua table exceeds the generated depth bound");
      if (value.length > universal_value::kMaximumEntries || (value.length != 0 && !value.data)) {
        return fail("Structured Lua table exceeds the generated entry bound");
      }
      const bool sequence = value.reserved == static_cast<uint8_t>(ScriptTableKind::kSequence);
      const auto* entries = static_cast<const ScriptTableEntry*>(value.data);
      for (uint32_t index = 0; index < value.length; ++index) {
        const ScriptValue& key = entries[index].key;
        if (key.tag == ScriptValueTag::kNull || key.tag == ScriptValueTag::kUndefined) {
          return fail("Structured Lua table key cannot be null or undefined");
        }
        if (key.tag == ScriptValueTag::kNumber && !std::isfinite(key.number)) {
          return fail("Structured Lua numeric table key must be finite");
        }
      }
      lua_createtable(state_, sequence ? static_cast<int>(value.length) : 0,
          sequence ? 0 : static_cast<int>(value.length));
      for (uint32_t index = 0; index < value.length; ++index) {
        if (!pushStructuredValue(entries[index].key, frame, depth + 1) ||
            !pushStructuredValue(entries[index].value, frame, depth + 1)) return false;
        lua_settable(state_, -3);
      }
      return true;
    }
    case ScriptValueTag::kCallback:
      if (!value.data) return fail("Structured Lua callback descriptor is null");
      {
        auto* callback = const_cast<ScriptCallback*>(static_cast<const ScriptCallback*>(value.data));
        if (!callback->invoke || !callback->retain || !callback->release) {
          return fail("Structured Lua callback descriptor is incomplete");
        }
        auto* root = static_cast<CallbackLuaRoot*>(lua_newuserdata(state_, sizeof(CallbackLuaRoot)));
        root->callback = callback;
        callback->retain(callback->context);
        if (luaL_newmetatable(state_, kCallbackMetatable)) {
          lua_pushcfunction(state_, LuaCallbackGc);
          lua_setfield(state_, -2, "__gc");
        }
        lua_setmetatable(state_, -2);
        lua_pushlightuserdata(state_, this);
        lua_pushvalue(state_, -2);
        lua_pushcclosure(state_, LuaCallbackThunk, 2);
        lua_remove(state_, -2);
        return true;
      }
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
  } else if (codec == value_binding::StructuredLuaResultCodec::kVector3) {
    dmVMath::Vector3* value = dmScript::ToVector3(state_, -1);
    if (!value) return fail("Structured Lua result is not vector3");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector3;
    output.defoldValue[0] = value->getX();
    output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ();
  } else if (codec == value_binding::StructuredLuaResultCodec::kQuaternion) {
    dmVMath::Quat* value = dmScript::ToQuat(state_, -1);
    if (!value) return fail("Structured Lua result is not quaternion");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kQuaternion;
    output.defoldValue[0] = value->getX();
    output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ();
    output.defoldValue[3] = value->getW();
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
  if (operation.context==fixed_tuple::Context::kScriptInstance && (!hasSelectedContext()||selectedContext()!=ActiveContext::kGameObject)) { writeError(error,errorCapacity,"Fixed tuple call requires an active game-object script instance"); return fixed_tuple::DispatchStatus::kError; }
  if (operation.context==fixed_tuple::Context::kGuiScriptInstance && (!hasSelectedContext()||selectedContext()!=ActiveContext::kGui)) { writeError(error,errorCapacity,"Fixed tuple call requires an active GUI script instance"); return fixed_tuple::DispatchStatus::kError; }
  const int baseTop=lua_gettop(state_);
  if(scoped){instanceApi_.get(state_);lua_rawgeti(state_,LUA_REGISTRYINDEX,instanceRef_);instanceApi_.set(state_);}
  const int callBase=lua_gettop(state_); lua_rawgeti(state_,LUA_REGISTRYINDEX,fixedTupleFunctionRefs_[operation.index]);
  bool ok=true; for(uint32_t index=0;index<frame->argumentCount;++index) if(!pushStructuredValue(frame->arguments[index],frame)){ok=false;break;}
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
  const bool currentContext = operation.context == value_binding::StructuredLuaContext::kCurrentScriptInstance;
  const ActiveContext requiredContext = operation.context == value_binding::StructuredLuaContext::kGuiScriptInstance
      ? ActiveContext::kGui : ActiveContext::kGameObject;
  if (!hasSelectedContext() || (!currentContext && selectedContext() != requiredContext)) {
    writeError(error, errorCapacity,
        currentContext
          ? "Structured Lua call requires an active script instance"
          : operation.context == value_binding::StructuredLuaContext::kGuiScriptInstance
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
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
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

url_binding::DispatchStatus ScriptAdapter::UrlInvokeThunk(
    void* context,
    const url_binding::Operation& operation,
    const uint16_t*,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeUrl(
      operation, frame, error, errorCapacity);
}

bool ScriptAdapter::bindUrl(const url_binding::Operation& operation) noexcept {
  if (!state_ || operation.index >= urlFunctionRefs_.size()) {
    return fail("URL Lua operation index is invalid");
  }
  int& reference = urlFunctionRefs_[operation.index];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  lua_getglobal(state_, operation.module);
  if (!lua_istable(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("URL Lua module is unavailable");
  }
  lua_getfield(state_, -1, operation.member);
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("URL Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readUrlResult(
    url_binding::ResultCodec codec,
    ScriptCallFrame* frame) noexcept {
  using Codec = url_binding::ResultCodec;
  if (codec == Codec::kNone) return true;
  if (!frame->results || frame->resultCapacity < 1) {
    return fail("URL Lua result storage is exhausted");
  }
  ScriptValue& output = frame->results[0];
  output = {};
  if (codec == Codec::kHashOrNil && lua_isnil(state_, -1)) {
    output.tag = ScriptValueTag::kNull;
  } else if (codec == Codec::kNil) {
    if (!lua_isnil(state_, -1)) return fail("URL Lua result is not nil");
    output.tag = ScriptValueTag::kNull;
  } else if (codec == Codec::kBoolean) {
    if (lua_type(state_, -1) != LUA_TBOOLEAN) return fail("URL Lua result is not boolean");
    output.tag = ScriptValueTag::kBoolean;
    output.number = lua_toboolean(state_, -1) ? 1.0 : 0.0;
  } else if (codec == Codec::kInteger || codec == Codec::kNumber) {
    if (lua_type(state_, -1) != LUA_TNUMBER) return fail("URL Lua result is not numeric");
    const double number = lua_tonumber(state_, -1);
    if (codec == Codec::kInteger && (!std::isfinite(number) || std::trunc(number) != number)) {
      return fail("URL Lua integer result is not exact");
    }
    output.tag = ScriptValueTag::kNumber;
    output.number = number;
  } else if (codec == Codec::kString) {
    if (lua_type(state_, -1) != LUA_TSTRING) return fail("URL Lua result is not a string");
    size_t length = 0;
    const char* data = lua_tolstring(state_, -1, &length);
    if (!frame->stringScratch || length > frame->stringScratchCapacity - frame->stringScratchUsed) {
      return fail("URL Lua string scratch is exhausted");
    }
    char* destination = frame->stringScratch + frame->stringScratchUsed;
    if (length) std::memcpy(destination, data, length);
    output.tag = ScriptValueTag::kString;
    output.data = destination;
    output.length = static_cast<uint32_t>(length);
    frame->stringScratchUsed += static_cast<uint32_t>(length);
  } else if (codec == Codec::kHash || codec == Codec::kHashOrNil) {
    dmhash_t* hash = dmScript::ToHash(state_, -1);
    if (!hash) return fail("URL Lua result is not a hash");
    output.tag = ScriptValueTag::kHandle;
    output.handleKind = ScriptHandleKind::kHash;
    output.payload = *hash;
  } else if (codec == Codec::kUrl) {
    dmMessage::URL* url = dmScript::ToURL(state_, -1);
    if (!url || !frame->urlArena || !frame->urlArena->copyBeforeLuaPop(*url, &output)) {
      return fail("URL Lua result cannot be copied into the frame arena");
    }
  } else if (codec == Codec::kVector3) {
    dmVMath::Vector3* value = dmScript::ToVector3(state_, -1);
    if (!value) return fail("URL Lua result is not vector3");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector3;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ();
  } else if (codec == Codec::kVector4) {
    dmVMath::Vector4* value = dmScript::ToVector4(state_, -1);
    if (!value) return fail("URL Lua result is not vector4");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector4;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ(); output.defoldValue[3] = value->getW();
  } else if (codec == Codec::kQuaternion) {
    dmVMath::Quat* value = dmScript::ToQuat(state_, -1);
    if (!value) return fail("URL Lua result is not quaternion");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kQuaternion;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ(); output.defoldValue[3] = value->getW();
  } else {
    return fail("URL Lua result codec is unsupported");
  }
  frame->resultCount = 1;
  return true;
}

url_binding::DispatchStatus ScriptAdapter::invokeUrl(
    const url_binding::Operation& operation,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  using Status = url_binding::DispatchStatus;
  if (!state_ || !frame || !bindUrl(operation)) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  constexpr int kUniversalStackReserve =
      static_cast<int>(universal_value::kMaximumArgumentCount +
          universal_value::kMaximumDepth * 2 + 16);
  if (!lua_checkstack(state_, kUniversalStackReserve)) {
    writeError(error, errorCapacity,
        "Universal-value Lua backend cannot reserve its bounded stack frame");
    return Status::kError;
  }
  if (!instanceApi_.get || !instanceApi_.set || instanceRef_ == LUA_NOREF ||
      instanceRef_ == LUA_REFNIL || !hasSelectedContext() ||
      selectedContext() != ActiveContext::kGameObject) {
    writeError(error, errorCapacity, "URL Lua call requires a captured game-object script instance");
    return Status::kError;
  }
  const int baseTop = lua_gettop(state_);
  instanceApi_.get(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
  instanceApi_.set(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, urlFunctionRefs_[operation.index]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
  }
  const int resultCount = operation.resultCodec == url_binding::ResultCodec::kNone ? 0 : 1;
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), resultCount, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "URL Lua call failed without an error string");
  }
  if (ok) ok = readUrlResult(operation.resultCodec, frame);
  lua_settop(state_, baseTop + 1);
  instanceApi_.set(state_);
  lua_settop(state_, baseTop);
  if (!ok) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  adapterError_[0] = '\0';
  return Status::kSuccess;
}

value_tail::DispatchStatus ScriptAdapter::ValueTailInvokeThunk(
    void* context,
    const value_tail::Route& route,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeValueTail(
      route, frame, error, errorCapacity);
}

bool ScriptAdapter::bindValueTail(const value_tail::Route& route) noexcept {
  if (!state_ || route.candidateIndex >= valueTailFunctionRefs_.size()) {
    return fail("Defold value-tail operation index is invalid");
  }
  int& reference = valueTailFunctionRefs_[route.candidateIndex];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  if (std::strcmp(route.modulePath, "builtins") == 0) {
    lua_getglobal(state_, route.member);
  } else {
    lua_getglobal(state_, route.modulePath);
    if (lua_istable(state_, -1)) {
      lua_getfield(state_, -1, route.member);
      lua_remove(state_, -2);
    }
  }
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Defold value-tail Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readValueTailResult(
    value_tail::Codec codec,
    ScriptCallFrame* frame) noexcept {
  using Codec = value_tail::Codec;
  if (codec == Codec::kNone) return true;
  if (!frame->results || frame->resultCapacity < 1) {
    return fail("Defold value-tail result storage is exhausted");
  }
  ScriptValue& output = frame->results[0];
  output = {};
  if (codec == Codec::kBoolean) {
    if (lua_type(state_, -1) != LUA_TBOOLEAN) return fail("Defold value-tail result is not boolean");
    output.tag = ScriptValueTag::kBoolean;
    output.number = lua_toboolean(state_, -1) ? 1.0 : 0.0;
  } else if (codec == Codec::kNumber) {
    if (lua_type(state_, -1) != LUA_TNUMBER) return fail("Defold value-tail result is not numeric");
    output.tag = ScriptValueTag::kNumber;
    output.number = lua_tonumber(state_, -1);
  } else if (codec == Codec::kString) {
    if (lua_type(state_, -1) != LUA_TSTRING) return fail("Defold value-tail result is not a string");
    size_t length = 0;
    const char* data = lua_tolstring(state_, -1, &length);
    if (!frame->stringScratch || length > frame->stringScratchCapacity - frame->stringScratchUsed) {
      return fail("Defold value-tail string scratch is exhausted");
    }
    char* destination = frame->stringScratch + frame->stringScratchUsed;
    if (length) std::memcpy(destination, data, length);
    output.tag = ScriptValueTag::kString;
    output.data = destination;
    output.length = static_cast<uint32_t>(length);
    frame->stringScratchUsed += static_cast<uint32_t>(length);
  } else if (codec == Codec::kHash) {
    dmhash_t* hash = dmScript::ToHash(state_, -1);
    if (!hash) return fail("Defold value-tail result is not a hash");
    output.tag = ScriptValueTag::kHandle;
    output.handleKind = ScriptHandleKind::kHash;
    output.payload = *hash;
  } else if (codec == Codec::kVector3) {
    dmVMath::Vector3* value = dmScript::ToVector3(state_, -1);
    if (!value) return fail("Defold value-tail result is not vector3");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector3;
    output.defoldValue[0] = value->getX();
    output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ();
  } else if (codec == Codec::kMatrix4) {
    dmVMath::Matrix4* value = dmScript::ToMatrix4(state_, -1);
    if (!value || !frame->matrix4Arena) {
      return fail("Defold value-tail Matrix4 result has no frame arena");
    }
    alignas(16) float elements[16];
    for (size_t column = 0; column < 4; ++column) {
      for (size_t row = 0; row < 4; ++row) {
        elements[column * 4 + row] = value->getElem(column, row);
      }
    }
    if (!frame->matrix4Arena->store(elements, &output)) {
      return fail("Defold value-tail Matrix4 frame arena is exhausted");
    }
  } else {
    return fail("Defold value-tail result codec is unsupported");
  }
  frame->resultCount = 1;
  return true;
}

value_tail::DispatchStatus ScriptAdapter::invokeValueTail(
    const value_tail::Route& route,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  using Status = value_tail::DispatchStatus;
  if (!state_ || !frame || !bindValueTail(route)) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  if (!instanceApi_.get || !instanceApi_.set || instanceRef_ == LUA_NOREF ||
      instanceRef_ == LUA_REFNIL || !hasSelectedContext() ||
      selectedContext() != ActiveContext::kGameObject) {
    writeError(error, errorCapacity, "Defold value-tail call requires a captured game-object script instance");
    return Status::kError;
  }
  const int baseTop = lua_gettop(state_);
  instanceApi_.get(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
  instanceApi_.set(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, valueTailFunctionRefs_[route.candidateIndex]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
  }
  const int resultCount = route.resultCodec == value_tail::Codec::kNone ? 0 : 1;
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), resultCount, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "Defold value-tail Lua call failed without an error string");
  }
  if (ok) ok = readValueTailResult(route.resultCodec, frame);
  lua_settop(state_, baseTop + 1);
  instanceApi_.set(state_);
  lua_settop(state_, baseTop);
  if (!ok) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  adapterError_[0] = '\0';
  return Status::kSuccess;
}

overload_dispatch::DispatchStatus ScriptAdapter::OverloadInvokeThunk(
    void* context,
    const overload_dispatch::Operation& operation,
    const overload_dispatch::Shape& shape,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeOverload(
      operation, shape, frame, error, errorCapacity);
}

bool ScriptAdapter::bindOverload(
    const overload_dispatch::Operation& operation) noexcept {
  if (!state_ || operation.index >= overloadFunctionRefs_.size()) {
    return fail("Overload-dispatch operation index is invalid");
  }
  int& reference = overloadFunctionRefs_[operation.index];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  lua_getglobal(state_, operation.modulePath);
  if (lua_istable(state_, -1)) {
    lua_getfield(state_, -1, operation.member);
    lua_remove(state_, -2);
  }
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Overload-dispatch Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readOverloadResult(
    uint16_t codec,
    ScriptCallFrame* frame) noexcept {
  if (!frame->results || frame->resultCapacity < 1) {
    return fail("Overload-dispatch result storage is exhausted");
  }
  ScriptValue& output = frame->results[0];
  output = {};
  if (codec == overload_dispatch::kNumber) {
    if (lua_type(state_, -1) != LUA_TNUMBER) return fail("Overload-dispatch result is not numeric");
    output.tag = ScriptValueTag::kNumber;
    output.number = lua_tonumber(state_, -1);
  } else if (codec == overload_dispatch::kVector3) {
    dmVMath::Vector3* value = dmScript::ToVector3(state_, -1);
    if (!value) return fail("Overload-dispatch result is not vector3");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector3;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ();
  } else if (codec == overload_dispatch::kVector4) {
    dmVMath::Vector4* value = dmScript::ToVector4(state_, -1);
    if (!value) return fail("Overload-dispatch result is not vector4");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kVector4;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ(); output.defoldValue[3] = value->getW();
  } else if (codec == overload_dispatch::kQuaternion) {
    dmVMath::Quat* value = dmScript::ToQuat(state_, -1);
    if (!value) return fail("Overload-dispatch result is not quaternion");
    output.tag = ScriptValueTag::kDefoldValue;
    output.defoldKind = ScriptDefoldValueKind::kQuaternion;
    output.defoldValue[0] = value->getX(); output.defoldValue[1] = value->getY();
    output.defoldValue[2] = value->getZ(); output.defoldValue[3] = value->getW();
  } else if (codec == overload_dispatch::kMatrix4) {
    dmVMath::Matrix4* value = dmScript::ToMatrix4(state_, -1);
    if (!value || !frame->matrix4Arena) return fail("Overload-dispatch Matrix4 result has no frame arena");
    alignas(16) float elements[16];
    for (size_t column = 0; column < 4; ++column) {
      for (size_t row = 0; row < 4; ++row) elements[column * 4 + row] = value->getElem(column, row);
    }
    if (!frame->matrix4Arena->store(elements, &output)) {
      return fail("Overload-dispatch Matrix4 frame arena is exhausted");
    }
  } else {
    return fail("Overload-dispatch result codec is unsupported");
  }
  frame->resultCount = 1;
  return true;
}

overload_dispatch::DispatchStatus ScriptAdapter::invokeOverload(
    const overload_dispatch::Operation& operation,
    const overload_dispatch::Shape& shape,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  using Status = overload_dispatch::DispatchStatus;
  if (!state_ || !frame || !bindOverload(operation)) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  if (!instanceApi_.get || !instanceApi_.set || instanceRef_ == LUA_NOREF ||
      instanceRef_ == LUA_REFNIL || !hasSelectedContext()) {
    writeError(error, errorCapacity, "Overload-dispatch call requires a captured script instance");
    return Status::kError;
  }
  const int baseTop = lua_gettop(state_);
  instanceApi_.get(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
  instanceApi_.set(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, overloadFunctionRefs_[operation.index]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
  }
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), 1, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "Overload-dispatch Lua call failed without an error string");
  }
  if (ok) ok = readOverloadResult(shape.resultMask, frame);
  lua_settop(state_, baseTop + 1);
  instanceApi_.set(state_);
  lua_settop(state_, baseTop);
  if (!ok) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  adapterError_[0] = '\0';
  return Status::kSuccess;
}

table_record::DispatchStatus ScriptAdapter::TableRecordInvokeThunk(
    void* context,
    const table_record::Operation& operation,
    const table_record::Codec*,
    const table_record::Field* fields,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeTableRecord(
      operation, fields, frame, error, errorCapacity);
}

bool ScriptAdapter::bindTableRecord(
    const table_record::Operation& operation) noexcept {
  if (!state_ || operation.index >= tableRecordFunctionRefs_.size()) {
    return fail("Table-record operation index is invalid");
  }
  int& reference = tableRecordFunctionRefs_[operation.index];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  const char* segment = operation.modulePath;
  const char* dot = std::strchr(segment, '.');
  if (dot) {
    const size_t length = static_cast<size_t>(dot - segment);
    if (length >= 64) return fail("Table-record Lua module segment exceeds fixed stack scratch");
    char first[64]{};
    std::memcpy(first, segment, length);
    lua_getglobal(state_, first);
  } else {
    lua_getglobal(state_, segment);
  }
  while (dot && lua_istable(state_, -1)) {
    segment = dot + 1;
    dot = std::strchr(segment, '.');
    const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    lua_pushlstring(state_, segment, length);
    lua_gettable(state_, -2);
    lua_remove(state_, -2);
  }
  if (!lua_istable(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Table-record Lua module is unavailable");
  }
  lua_getfield(state_, -1, operation.member);
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Table-record Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readTableRecord(
    const table_record::Operation& operation,
    const table_record::Field* fields,
    int stackIndex,
    ScriptCallFrame* frame) noexcept {
  if (!lua_istable(state_, stackIndex)) return fail("Table-record Lua result is not a table");
  if (!frame->results || frame->resultCapacity < 1 || !frame->tableScratch ||
      frame->tableScratchUsed > frame->tableScratchCapacity ||
      operation.fieldCount > frame->tableScratchCapacity - frame->tableScratchUsed) {
    return fail("Table-record caller-owned scratch is exhausted");
  }
  const int tableIndex = stackIndex < 0 ? lua_gettop(state_) + stackIndex + 1 : stackIndex;
  std::array<bool, table_record::kMaximumFieldCount> seen{};
  ScriptTableEntry* entries = frame->tableScratch + frame->tableScratchUsed;
  uint8_t entryCount = 0;
  lua_pushnil(state_);
  while (lua_next(state_, tableIndex) != 0) {
    if (lua_type(state_, -2) != LUA_TSTRING) return fail("Table-record Lua result has a non-string field");
    size_t keyLength = 0;
    const char* key = lua_tolstring(state_, -2, &keyLength);
    uint8_t fieldIndex = operation.fieldCount;
    for (uint8_t index = 0; index < operation.fieldCount; ++index) {
      const char* expected = fields[operation.fieldOffset + index].name;
      if (keyLength == std::strlen(expected) && std::memcmp(key, expected, keyLength) == 0) {
        fieldIndex = index;
        break;
      }
    }
    if (fieldIndex == operation.fieldCount || seen[fieldIndex]) {
      return fail("Table-record Lua result has an unknown or duplicate field");
    }
    seen[fieldIndex] = true;
    ++entryCount;
    const table_record::Field& field = fields[operation.fieldOffset + fieldIndex];
    ScriptTableEntry& entry = entries[fieldIndex];
    entry = {};
    entry.key.tag = ScriptValueTag::kString;
    entry.key.data = field.name;
    entry.key.length = static_cast<uint32_t>(std::strlen(field.name));
    if (field.codec == table_record::Codec::kBoolean) {
      if (lua_type(state_, -1) != LUA_TBOOLEAN) return fail("Table-record boolean field has the wrong Lua type");
      entry.value.tag = ScriptValueTag::kBoolean;
      entry.value.number = lua_toboolean(state_, -1) ? 1.0 : 0.0;
    } else if (field.codec == table_record::Codec::kString) {
      if (lua_type(state_, -1) != LUA_TSTRING) return fail("Table-record string field has the wrong Lua type");
      size_t length = 0;
      const char* value = lua_tolstring(state_, -1, &length);
      if (!frame->stringScratch || frame->stringScratchUsed > frame->stringScratchCapacity ||
          length > frame->stringScratchCapacity - frame->stringScratchUsed) {
        return fail("Table-record string scratch is exhausted");
      }
      char* destination = frame->stringScratch + frame->stringScratchUsed;
      if (length) std::memcpy(destination, value, length);
      entry.value.tag = ScriptValueTag::kString;
      entry.value.data = destination;
      entry.value.length = static_cast<uint32_t>(length);
      frame->stringScratchUsed += static_cast<uint32_t>(length);
    } else {
      if (lua_type(state_, -1) != LUA_TNUMBER) return fail("Table-record numeric field has the wrong Lua type");
      const double value = lua_tonumber(state_, -1);
      if (!std::isfinite(value) ||
          (field.codec == table_record::Codec::kInteger &&
           (std::trunc(value) != value || value < -static_cast<double>(kMaxExactInteger) ||
            value > static_cast<double>(kMaxExactInteger)))) {
        return fail("Table-record numeric field is not an exact finite value");
      }
      entry.value.tag = ScriptValueTag::kNumber;
      entry.value.number = value;
    }
    lua_pop(state_, 1);
  }
  if (entryCount != operation.fieldCount) return fail("Table-record Lua result is missing a required field");
  ScriptValue& output = frame->results[0];
  output = {};
  output.tag = ScriptValueTag::kTable;
  output.data = entries;
  output.length = operation.fieldCount;
  frame->tableScratchUsed += operation.fieldCount;
  frame->resultCount = 1;
  return true;
}

table_record::DispatchStatus ScriptAdapter::invokeTableRecord(
    const table_record::Operation& operation,
    const table_record::Field* fields,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  using Status = table_record::DispatchStatus;
  if (!state_ || !frame || !bindTableRecord(operation)) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  const bool scoped = operation.context != table_record::Context::kGlobal;
  if (scoped && (!instanceApi_.get || !instanceApi_.set || instanceRef_ == LUA_NOREF ||
      instanceRef_ == LUA_REFNIL || !hasSelectedContext())) {
    writeError(error, errorCapacity, "Table-record call has no captured Defold instance");
    return Status::kError;
  }
  if (operation.context == table_record::Context::kScriptInstance &&
      selectedContext() != ActiveContext::kGameObject) {
    writeError(error, errorCapacity, "Table-record call requires an active game-object script instance");
    return Status::kError;
  }
  if (operation.context == table_record::Context::kGuiScriptInstance &&
      selectedContext() != ActiveContext::kGui) {
    writeError(error, errorCapacity, "Table-record call requires an active GUI script instance");
    return Status::kError;
  }
  const uint32_t tableMark = frame->tableScratchUsed;
  const uint32_t stringMark = frame->stringScratchUsed;
  const int baseTop = lua_gettop(state_);
  if (scoped) {
    instanceApi_.get(state_);
    lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
    instanceApi_.set(state_);
  }
  const int callBase = lua_gettop(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX, tableRecordFunctionRefs_[operation.index]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
  }
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), 1, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "Table-record Lua call failed without an error string");
  }
  if (ok && lua_gettop(state_) - callBase != 1) {
    ok = fail("Table-record Lua result count does not match exact descriptor");
  }
  if (ok) ok = readTableRecord(operation, fields, -1, frame);
  if (scoped) {
    lua_settop(state_, baseTop + 1);
    instanceApi_.set(state_);
  }
  lua_settop(state_, baseTop);
  if (!ok) {
    frame->tableScratchUsed = tableMark;
    frame->stringScratchUsed = stringMark;
    frame->resultCount = 0;
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  adapterError_[0] = '\0';
  return Status::kSuccess;
}

universal_value::DispatchStatus ScriptAdapter::UniversalValueInvokeThunk(
    void* context,
    const universal_value::Operation& operation,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  return static_cast<ScriptAdapter*>(context)->invokeUniversalValue(
      operation, frame, error, errorCapacity);
}

bool ScriptAdapter::bindUniversalValue(
    const universal_value::Operation& operation) noexcept {
  if (!state_) return fail("Universal-value Lua backend is not initialized");
  const ptrdiff_t denseIndex = &operation - universal_value::operations();
  if (denseIndex < 0 || static_cast<size_t>(denseIndex) >= universalValueFunctionRefs_.size()) {
    return fail("Universal-value operation index is invalid");
  }
  int& reference = universalValueFunctionRefs_[static_cast<size_t>(denseIndex)];
  if (reference != LUA_NOREF && reference != LUA_REFNIL) return true;
  const int baseTop = lua_gettop(state_);
  if (!operation.modulePath[0]) {
    lua_getglobal(state_, operation.member);
  } else {
    const char* segment = operation.modulePath;
    const char* dot = std::strchr(segment, '.');
    const size_t firstLength = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
    if (firstLength == 0 || firstLength >= 96) {
      lua_settop(state_, baseTop);
      return fail("Universal-value module segment exceeds fixed scratch");
    }
    char first[96]{};
    std::memcpy(first, segment, firstLength);
    lua_getglobal(state_, first);
    while (dot && lua_istable(state_, -1)) {
      segment = dot + 1;
      dot = std::strchr(segment, '.');
      const size_t length = dot ? static_cast<size_t>(dot - segment) : std::strlen(segment);
      if (length == 0 || length >= 96) {
        lua_settop(state_, baseTop);
        return fail("Universal-value module segment exceeds fixed scratch");
      }
      lua_pushlstring(state_, segment, length);
      lua_gettable(state_, -2);
      lua_remove(state_, -2);
    }
    if (!lua_istable(state_, -1)) {
      lua_settop(state_, baseTop);
      return fail("Universal-value Lua module is unavailable");
    }
    lua_getfield(state_, -1, operation.member);
  }
  if (!lua_isfunction(state_, -1)) {
    lua_settop(state_, baseTop);
    return fail("Universal-value Lua function is unavailable");
  }
  reference = luaL_ref(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, baseTop);
  return reference != LUA_NOREF && reference != LUA_REFNIL;
}

bool ScriptAdapter::readUniversalValue(
    int stackIndex,
    ScriptValue* output,
    ScriptCallFrame* frame,
    uint32_t depth,
    const void* const* ancestors,
    uint32_t ancestorCount,
    ScriptValue* borrowedHandles,
    uint32_t borrowedHandleCapacity,
    uint32_t* borrowedHandleCount) noexcept {
  if (!state_ || !output || !frame) return fail("Universal-value result reader is not initialized");
  const int absoluteIndex = stackIndex < 0 ? lua_gettop(state_) + stackIndex + 1 : stackIndex;
  *output = {};
  switch (lua_type(state_, absoluteIndex)) {
    case LUA_TNIL:
      output->tag = ScriptValueTag::kNull;
      return true;
    case LUA_TBOOLEAN:
      output->tag = ScriptValueTag::kBoolean;
      output->number = lua_toboolean(state_, absoluteIndex) ? 1.0 : 0.0;
      return true;
    case LUA_TNUMBER:
      output->tag = ScriptValueTag::kNumber;
      output->number = lua_tonumber(state_, absoluteIndex);
      return true;
    case LUA_TSTRING: {
      size_t length = 0;
      const char* source = lua_tolstring(state_, absoluteIndex, &length);
      if (!frame->stringScratch || frame->stringScratchUsed > frame->stringScratchCapacity ||
          length > frame->stringScratchCapacity - frame->stringScratchUsed) {
        return fail("Universal-value string scratch is exhausted");
      }
      char* destination = frame->stringScratch + frame->stringScratchUsed;
      if (length) std::memcpy(destination, source, length);
      output->tag = ScriptValueTag::kString;
      output->data = destination;
      output->length = static_cast<uint32_t>(length);
      frame->stringScratchUsed += static_cast<uint32_t>(length);
      return true;
    }
    case LUA_TFUNCTION:
      return captureLuaClosure(absoluteIndex, output);
    case LUA_TUSERDATA: {
      if (auto* value = dmScript::ToVector3(state_, absoluteIndex)) {
        output->tag = ScriptValueTag::kDefoldValue;
        output->defoldKind = ScriptDefoldValueKind::kVector3;
        output->defoldValue[0] = value->getX();
        output->defoldValue[1] = value->getY();
        output->defoldValue[2] = value->getZ();
        return true;
      }
      if (auto* value = dmScript::ToVector4(state_, absoluteIndex)) {
        output->tag = ScriptValueTag::kDefoldValue;
        output->defoldKind = ScriptDefoldValueKind::kVector4;
        output->defoldValue[0] = value->getX();
        output->defoldValue[1] = value->getY();
        output->defoldValue[2] = value->getZ();
        output->defoldValue[3] = value->getW();
        return true;
      }
      if (auto* value = dmScript::ToQuat(state_, absoluteIndex)) {
        output->tag = ScriptValueTag::kDefoldValue;
        output->defoldKind = ScriptDefoldValueKind::kQuaternion;
        output->defoldValue[0] = value->getX();
        output->defoldValue[1] = value->getY();
        output->defoldValue[2] = value->getZ();
        output->defoldValue[3] = value->getW();
        return true;
      }
      if (auto* value = dmScript::ToMatrix4(state_, absoluteIndex)) {
        float elements[16]{};
        for (uint32_t column = 0; column < 4; ++column) {
          for (uint32_t row = 0; row < 4; ++row) {
            elements[column * 4 + row] = value->getElem(column, row);
          }
        }
        if (!frame->matrix4Arena || !frame->matrix4Arena->store(elements, output)) {
          return fail("Universal-value Matrix4 arena is exhausted");
        }
        return true;
      }
      if (auto* value = dmScript::ToHash(state_, absoluteIndex)) {
        output->tag = ScriptValueTag::kHandle;
        output->handleKind = ScriptHandleKind::kHash;
        output->payload = *value;
        return true;
      }
      if (auto* value = dmScript::ToURL(state_, absoluteIndex)) {
        if (!frame->urlArena || !frame->urlArena->store({
              value->m_Socket, value->_reserved, value->m_Path, value->m_Fragment}, output)) {
          return fail("Universal-value URL arena is exhausted");
        }
        return true;
      }
      if (!captureLuaUserdata(absoluteIndex, output)) return false;
      if (borrowedHandleCount) {
        if (!borrowedHandles || *borrowedHandleCount >= borrowedHandleCapacity) {
          releaseHandle(output->handleKind, output->length, output->payload);
          drainReleasedHandles();
          *output = {};
          return fail("Universal-value callback borrowed-handle ledger is exhausted");
        }
        borrowedHandles[(*borrowedHandleCount)++] = *output;
      }
      return true;
    }
    case LUA_TTABLE: {
      if (depth >= universal_value::kMaximumDepth) {
        return fail("Universal-value Lua table exceeds the generated depth bound");
      }
      const void* identity = lua_topointer(state_, absoluteIndex);
      for (uint32_t index = 0; index < ancestorCount; ++index) {
        if (ancestors[index] == identity) return fail("Universal-value Lua table contains a cycle");
      }
      uint32_t count = 0;
      bool allStrings = true;
      bool denseSequence = true;
      std::array<bool, universal_value::kMaximumEntries> sequenceKeys{};
      lua_pushnil(state_);
      while (lua_next(state_, absoluteIndex) != 0) {
        if (++count > universal_value::kMaximumEntries) {
          lua_pop(state_, 2);
          return fail("Universal-value Lua table exceeds the generated entry bound");
        }
        const int keyType = lua_type(state_, -2);
        allStrings = allStrings && keyType == LUA_TSTRING;
        if (keyType == LUA_TNUMBER) {
          const double key = lua_tonumber(state_, -2);
          if (!std::isfinite(key) || std::trunc(key) != key || key < 1.0 ||
              key > static_cast<double>(universal_value::kMaximumEntries)) {
            denseSequence = false;
          } else {
            const size_t position = static_cast<size_t>(key - 1.0);
            if (sequenceKeys[position]) denseSequence = false;
            sequenceKeys[position] = true;
          }
        } else {
          denseSequence = false;
        }
        lua_pop(state_, 1);
      }
      if (denseSequence) {
        for (uint32_t index = 0; index < count; ++index) denseSequence = denseSequence && sequenceKeys[index];
      }
      if (!frame->tableScratch || frame->tableScratchUsed > frame->tableScratchCapacity ||
          count > frame->tableScratchCapacity - frame->tableScratchUsed) {
        return fail("Universal-value table scratch is exhausted");
      }
      ScriptTableEntry* entries = frame->tableScratch + frame->tableScratchUsed;
      frame->tableScratchUsed += count;
      std::array<const void*, universal_value::kMaximumDepth> nextAncestors{};
      for (uint32_t index = 0; index < ancestorCount; ++index) nextAncestors[index] = ancestors[index];
      nextAncestors[ancestorCount] = identity;
      uint32_t entry = 0;
      lua_pushnil(state_);
      while (lua_next(state_, absoluteIndex) != 0) {
        if (!readUniversalValue(-2, &entries[entry].key, frame, depth + 1,
                nextAncestors.data(), ancestorCount + 1, borrowedHandles,
                borrowedHandleCapacity, borrowedHandleCount) ||
            !readUniversalValue(-1, &entries[entry].value, frame, depth + 1,
                nextAncestors.data(), ancestorCount + 1, borrowedHandles,
                borrowedHandleCapacity, borrowedHandleCount)) {
          lua_pop(state_, 2);
          return false;
        }
        ++entry;
        lua_pop(state_, 1);
      }
      output->tag = ScriptValueTag::kTable;
      output->reserved = static_cast<uint8_t>(denseSequence
          ? ScriptTableKind::kSequence
          : allStrings ? ScriptTableKind::kRecord : ScriptTableKind::kMap);
      output->length = count;
      output->data = entries;
      return true;
    }
    default:
      return fail("Universal-value Lua result has an unsupported type");
  }
}

// Capture a declared borrowed-handle result into the generation-checked
// semantic registry, so a handle this transport produced is the same rooted
// identity the handle-lowering table's consumers accept.
//
// Which routes reach here is not an accident of naming. A route's lowering
// family is a single-winner precedence in which a table-shaped parameter
// outranks a handle, so every constructor that takes a definition record -
// `b2d.joint.create_*`, `bullet3d.constraint.create_*` - is marshalled by this
// transport even though its declared result is a live engine object. Before
// this, that result crossed as an anonymous Lua userdata and every
// handle-lowered consumer of the kind refused it with a codec mismatch.
//
// Returns true when it decided the result; `*ok` is false when it decided it
// as a failure. Returning false means the generic reader still owns the value.
bool ScriptAdapter::readUniversalSemanticHandleResult(
    const universal_value::Operation& operation,
    int stackIndex,
    int resultCount,
    ScriptValue* output,
    bool* ok) noexcept {
  if (operation.resultSemanticKind == 0 || resultCount != 1 || !handleRouter_) return false;
  const auto kind = static_cast<::defold_hermes::script_handle_lowering::SemanticHandleKind>(
      operation.resultSemanticKind);
  // Representation is a property of the backend the active runtime profile
  // selects, not of the kind: Box2D v2 pushes its world as a light userdata
  // with no identity at all. Refuse by declaration rather than by inspecting
  // what happens to be on the stack.
  if (!handleRouter_->capturableKind(kind)) {
    *ok = fail("Universal-value semantic handle kind is not a rooted identity in the active runtime profile");
    return true;
  }
  const int type = lua_type(state_, stackIndex);
  // A declared-optional handle result legitimately comes back absent; that is
  // a value, not a representation failure, so the generic reader owns it.
  if (type == LUA_TNIL) return false;
  if (type == LUA_TLIGHTUSERDATA) {
    *ok = fail("Universal-value semantic handle result is a light userdata with no rooted identity");
    return true;
  }
  if (type != LUA_TUSERDATA) {
    *ok = fail("Universal-value semantic handle result is not a userdata");
    return true;
  }
  if (!handleRouter_->captureHandle(stackIndex, kind, output)) {
    *ok = fail("Universal-value semantic handle registry is exhausted");
    return true;
  }
  *ok = true;
  return true;
}

universal_value::DispatchStatus ScriptAdapter::invokeUniversalValue(
    const universal_value::Operation& operation,
    ScriptCallFrame* frame,
    char* error,
    size_t errorCapacity) noexcept {
  using Status = universal_value::DispatchStatus;
  if (!state_ || !frame) {
    writeError(error, errorCapacity, "Universal-value Lua backend is not initialized");
    return Status::kError;
  }
  bool hasCallback = false;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    hasCallback = hasCallback || containsCallback(frame->arguments[index]);
  }
  if (hasCallback) {
    const auto* lifecycle = callback_lifecycle::find(operation.stableId);
    if (!lifecycle || (!lifecycle->registryEligible &&
        lifecycle->lifetime != callback_lifecycle::Lifetime::kHigherOrderClosure)) {
      writeError(error, errorCapacity,
          "Universal-value callback route is absent from the generated executable lifecycle ledger");
      return Status::kError;
    }
  }
  if (!bindUniversalValue(operation)) {
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  const ptrdiff_t denseIndex = &operation - universal_value::operations();
  if (denseIndex < 0 || static_cast<size_t>(denseIndex) >= universalValueFunctionRefs_.size()) {
    writeError(error, errorCapacity, "Universal-value operation index is invalid");
    return Status::kError;
  }
  const bool scoped = hasSelectedContext() && instanceApi_.get && instanceApi_.set &&
      instanceRef_ != LUA_NOREF && instanceRef_ != LUA_REFNIL;
  const uint32_t tableMark = frame->tableScratchUsed;
  const uint32_t stringMark = frame->stringScratchUsed;
  const int baseTop = lua_gettop(state_);
  if (scoped) {
    instanceApi_.get(state_);
    lua_rawgeti(state_, LUA_REGISTRYINDEX, instanceRef_);
    instanceApi_.set(state_);
  }
  const int callBase = lua_gettop(state_);
  lua_rawgeti(state_, LUA_REGISTRYINDEX,
      universalValueFunctionRefs_[static_cast<size_t>(denseIndex)]);
  bool ok = true;
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    if (!pushStructuredValue(frame->arguments[index], frame)) { ok = false; break; }
  }
  if (ok && lua_pcall(state_, static_cast<int>(frame->argumentCount), LUA_MULTRET, 0) != 0) {
    const char* message = lua_tostring(state_, -1);
    ok = fail(message ? message : "Universal-value Lua call failed without an error string");
  }
  const int actualResultCount = ok ? lua_gettop(state_) - callBase : 0;
  if (ok && (actualResultCount < operation.minimumResultCount ||
             actualResultCount > operation.maximumResultCount)) {
    ok = fail("Universal-value Lua result count is outside the generated range");
  }
  const void* ancestors[universal_value::kMaximumDepth]{};
  if (ok) {
    for (int index = 0; index < actualResultCount; ++index) {
      if (!readUniversalSemanticHandleResult(operation, callBase + 1 + index,
              actualResultCount, &frame->results[index], &ok)) {
        if (!ok) break;
        if (!readUniversalValue(callBase + 1 + index, &frame->results[index], frame,
                0, ancestors, 0)) {
          ok = false;
          break;
        }
      }
    }
  }
  if (ok) frame->resultCount = static_cast<uint32_t>(actualResultCount);
  if (scoped) {
    lua_settop(state_, baseTop + 1);
    instanceApi_.set(state_);
  }
  lua_settop(state_, baseTop);
  if (!ok) {
    frame->tableScratchUsed = tableMark;
    frame->stringScratchUsed = stringMark;
    frame->resultCount = 0;
    writeError(error, errorCapacity, lastError());
    return Status::kError;
  }
  adapterError_[0] = '\0';
  return Status::kSuccess;
}

void ScriptAdapter::drainReleasedHandles() noexcept {
  if (!state_) return;
  if (handleRouter_) handleRouter_->drainReleased();
  luaHandles_.drain([this](const HandleRecord& record) {
    if (record.state == state_) luaL_unref(state_, LUA_REGISTRYINDEX, static_cast<int>(record.payload));
  });
}

void ScriptAdapter::releaseHandle(
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept {
  if (kind == ScriptHandleKind::kLuaSemanticHandle) {
    if (handleRouter_) {
      ScriptValue value{}; value.tag=ScriptValueTag::kHandle; value.handleKind=kind;
      value.length=runtime; value.payload=payload; handleRouter_->queueRelease(value);
    }
    return;
  }
  if (kind != ScriptHandleKind::kGuiNode && kind != ScriptHandleKind::kLuaUserdata) return;
  const uint32_t type = kind == ScriptHandleKind::kGuiNode ? kNodeHandleType : kLuaUserdataHandleType;
  luaHandles_.queueRelease(unpackHandle(runtime, payload, type));
}

bool ScriptAdapter::fail(const char* message) noexcept {
  std::snprintf(adapterError_, sizeof(adapterError_), "%s", message);
  return false;
}

}  // namespace defold_hermes::lua_bridge::scalar
