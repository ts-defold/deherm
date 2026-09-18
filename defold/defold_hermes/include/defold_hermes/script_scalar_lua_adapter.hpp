#pragma once

#include <defold_hermes/scalar_lua_dispatch.hpp>
#include <defold_hermes/generated_script_value_bindings.hpp>
#include <defold_hermes/generated_script_fixed_tuples.hpp>
#include <defold_hermes/lua_bridge_core.hpp>
#include <defold_hermes/script_bridge_capi.hpp>

#include <array>

namespace defold_hermes::lua_bridge::scalar {

/** First universal-script-ABI backend: the generated scalar Lua fast lane. */
class ScriptAdapter {
 public:
  ScriptAdapter() noexcept;
  bool initialize(lua_State* state, InstanceApi instanceApi) noexcept;
  void shutdown() noexcept;
  bool captureInstance(int stackIndex) noexcept;
  bool captureGuiInstance(int stackIndex) noexcept;
  bool captureLuaUserdata(int stackIndex, ScriptValue* output) noexcept;
  void detachInstance() noexcept;
  bool dispatch(ScriptCallFrame* frame) noexcept;

  const char* lastError() const noexcept;
  Dispatcher& dispatcher() noexcept { return dispatcher_; }

  ScriptBridgeApi api() noexcept;

 private:
  static bool DispatchThunk(void* context, ScriptCallFrame* frame) noexcept;
  static const char* ErrorThunk(void* context) noexcept;
  static void ReleaseHandleThunk(
      void* context,
      ScriptHandleKind kind,
      uint32_t runtime,
      uint64_t payload) noexcept;
  static value_binding::DispatchStatus StructuredInvokeThunk(
      void* context,
      const value_binding::StructuredLuaOperation& operation,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  static fixed_tuple::DispatchStatus FixedTupleInvokeThunk(
      void* context,
      const fixed_tuple::Operation& operation,
      const uint16_t* argumentCodecs,
      const uint16_t* resultCodecs,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  fixed_tuple::DispatchStatus invokeFixedTuple(
      const fixed_tuple::Operation& operation,
      const uint16_t* resultCodecs,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindFixedTuple(const fixed_tuple::Operation& operation) noexcept;
  bool readFixedTupleResult(uint16_t codecs, int stackIndex, ScriptValue* output,
      ScriptCallFrame* frame) noexcept;
  value_binding::DispatchStatus invokeStructured(
      const value_binding::StructuredLuaOperation& operation,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindStructured(const value_binding::StructuredLuaOperation& operation) noexcept;
  bool captureContext(int stackIndex, value_binding::StructuredLuaContext context) noexcept;
  bool pushStructuredValue(const ScriptValue& value, uint32_t depth = 0) noexcept;
  bool readStructuredResult(
      value_binding::StructuredLuaResultCodec codec,
      ScriptCallFrame* frame) noexcept;
  void drainReleasedHandles() noexcept;
  void releaseHandle(ScriptHandleKind kind, uint32_t runtime, uint64_t payload) noexcept;
  bool fail(const char* message) noexcept;

  static constexpr uint32_t kLuaHandleCapacity = 256;
  Dispatcher dispatcher_;
  lua_State* state_ = nullptr;
  InstanceApi instanceApi_{};
  int instanceRef_ = LUA_NOREF;
  uint32_t runtimeGeneration_ = 0;
  value_binding::StructuredLuaContext activeContext_ = value_binding::StructuredLuaContext::kScriptInstance;
  bool hasActiveContext_ = false;
  std::array<int, value_binding::kStructuredLuaOperationCount> structuredFunctionRefs_{};
  std::array<int, fixed_tuple::kBindingCount> fixedTupleFunctionRefs_{};
  ::defold_hermes::lua_bridge::HandlePool luaHandles_;
  value_binding::StructuredLuaApi structuredLuaApi_{};
  fixed_tuple::LuaApi fixedTupleLuaApi_{};
  char adapterError_[384]{};
};

}  // namespace defold_hermes::lua_bridge::scalar
