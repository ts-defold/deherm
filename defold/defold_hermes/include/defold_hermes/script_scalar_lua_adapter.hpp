#pragma once

#include <defold_hermes/scalar_lua_dispatch.hpp>
#include <defold_hermes/generated_script_value_bindings.hpp>
#include <defold_hermes/generated_script_fixed_tuples.hpp>
#include <defold_hermes/generated_script_overload_dispatch.hpp>
#include <defold_hermes/generated_script_table_record_bindings.hpp>
#include <defold_hermes/generated_script_url_bindings.hpp>
#include <defold_hermes/generated_script_value_tail_bindings.hpp>
#include <defold_hermes/generated_script_handle_lowering.hpp>
#include <defold_hermes/generated_script_universal_value_bindings.hpp>
#include <defold_hermes/lua_bridge_core.hpp>
#include <defold_hermes/lua_value_registry.hpp>
#include <defold_hermes/script_bridge_capi.hpp>

#include <array>
#include <memory>

namespace defold_hermes::lua_bridge::scalar {

struct LuaClosureLifetime;
struct LuaClosureRoot;

/** First universal-script-ABI backend: the generated scalar Lua fast lane. */
class ScriptAdapter {
 public:
  enum class ComponentContext : uint8_t { kGameObject, kGui, kRender };
  static constexpr uint8_t kComponentContextDepth = 16;
  ScriptAdapter();
  bool initialize(lua_State* state, InstanceApi instanceApi,
      const ::defold_hermes::script_handle_lowering::RuntimeProfileHandshake& profileHandshake,
      ::defold_hermes::lua_bridge::LuaRegistryApi semanticRegistryApi = {});
  void shutdown() noexcept;
  bool captureInstance(int stackIndex) noexcept;
  bool captureGuiInstance(int stackIndex) noexcept;
  bool captureRenderInstance(int stackIndex) noexcept;
  bool captureLuaUserdata(int stackIndex, ScriptValue* output) noexcept;
  bool captureSemanticHandle(int stackIndex,
      ::defold_hermes::script_handle_lowering::SemanticHandleKind kind,
      ScriptValue* output) noexcept;
  bool ensureComponentFallbackInstance(int stackIndex, ComponentContext context) noexcept;
  bool pushComponentContext(ComponentContext context) noexcept;
  void popComponentContext() noexcept;
  bool componentContextActive() const noexcept { return componentContextDepth_ != 0; }
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
  static int LuaCallbackThunk(lua_State* state);
  static int LuaCallbackGc(lua_State* state);
  static bool ConsumeCallbackResults(
      void* context,
      const ScriptCallFrame* results) noexcept;
  static bool InvokeLuaClosure(
      void* context,
      const ScriptCallFrame* arguments,
      void* consumeContext,
      ScriptCallbackConsume consume,
      char* error,
      size_t errorCapacity) noexcept;
  static void RetainLuaClosure(void* context) noexcept;
  static void ReleaseLuaClosure(void* context) noexcept;
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
  static url_binding::DispatchStatus UrlInvokeThunk(
      void* context,
      const url_binding::Operation& operation,
      const uint16_t* argumentCodecs,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  static value_tail::DispatchStatus ValueTailInvokeThunk(
      void* context,
      const value_tail::Route& route,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  static overload_dispatch::DispatchStatus OverloadInvokeThunk(
      void* context,
      const overload_dispatch::Operation& operation,
      const overload_dispatch::Shape& shape,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  static table_record::DispatchStatus TableRecordInvokeThunk(
      void* context,
      const table_record::Operation& operation,
      const table_record::Codec* argumentCodecs,
      const table_record::Field* fields,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  static universal_value::DispatchStatus UniversalValueInvokeThunk(
      void* context,
      const universal_value::Operation& operation,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  universal_value::DispatchStatus invokeUniversalValue(
      const universal_value::Operation& operation,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindUniversalValue(const universal_value::Operation& operation) noexcept;
  bool readUniversalValue(
      int stackIndex,
      ScriptValue* output,
      ScriptCallFrame* frame,
      uint32_t depth,
      const void* const* ancestors,
      uint32_t ancestorCount,
      ScriptValue* borrowedHandles = nullptr,
      uint32_t borrowedHandleCapacity = 0,
      uint32_t* borrowedHandleCount = nullptr) noexcept;
  bool captureLuaClosure(int stackIndex, ScriptValue* output) noexcept;
  url_binding::DispatchStatus invokeUrl(
      const url_binding::Operation& operation,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindUrl(const url_binding::Operation& operation) noexcept;
  bool readUrlResult(url_binding::ResultCodec codec, ScriptCallFrame* frame) noexcept;
  value_tail::DispatchStatus invokeValueTail(
      const value_tail::Route& route,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindValueTail(const value_tail::Route& route) noexcept;
  bool readValueTailResult(value_tail::Codec codec, ScriptCallFrame* frame) noexcept;
  overload_dispatch::DispatchStatus invokeOverload(
      const overload_dispatch::Operation& operation,
      const overload_dispatch::Shape& shape,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindOverload(const overload_dispatch::Operation& operation) noexcept;
  bool readOverloadResult(uint16_t codec, ScriptCallFrame* frame) noexcept;
  table_record::DispatchStatus invokeTableRecord(
      const table_record::Operation& operation,
      const table_record::Field* fields,
      ScriptCallFrame* frame,
      char* error,
      size_t errorCapacity) noexcept;
  bool bindTableRecord(const table_record::Operation& operation) noexcept;
  bool readTableRecord(
      const table_record::Operation& operation,
      const table_record::Field* fields,
      int stackIndex,
      ScriptCallFrame* frame) noexcept;
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
  enum class ActiveContext : uint8_t { kGameObject, kGui, kRender };
  bool captureContext(int stackIndex, ActiveContext context) noexcept;
  bool hasSelectedContext() const noexcept;
  ActiveContext selectedContext() const noexcept;
  bool pushStructuredValue(
      const ScriptValue& value,
      ScriptCallFrame* frame = nullptr,
      uint32_t depth = 0) noexcept;
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
  ActiveContext activeContext_ = ActiveContext::kGameObject;
  bool hasActiveContext_ = false;
  std::array<ActiveContext, kComponentContextDepth> componentContexts_{};
  uint8_t componentContextDepth_ = 0;
  std::array<int, value_binding::kStructuredLuaOperationCount> structuredFunctionRefs_{};
  std::array<int, fixed_tuple::kBindingCount> fixedTupleFunctionRefs_{};
  std::array<int, url_binding::kBindingCount> urlFunctionRefs_{};
  std::array<int, value_tail::kCandidateCount> valueTailFunctionRefs_{};
  std::array<int, overload_dispatch::kBindingCount> overloadFunctionRefs_{};
  std::array<int, table_record::kCandidateCount> tableRecordFunctionRefs_{};
  std::array<int, universal_value::kOperationCount> universalValueFunctionRefs_{};
  ::defold_hermes::lua_bridge::HandlePool luaHandles_;
  value_binding::StructuredLuaApi structuredLuaApi_{};
  fixed_tuple::LuaApi fixedTupleLuaApi_{};
  url_binding::LuaApi urlLuaApi_{};
  value_tail::LuaApi valueTailLuaApi_{};
  overload_dispatch::LuaApi overloadLuaApi_{};
  table_record::LuaApi tableRecordLuaApi_{};
  universal_value::LuaApi universalValueLuaApi_{};
  std::unique_ptr<::defold_hermes::lua_bridge::LuaValueRegistry> semanticHandleRegistry_;
  std::unique_ptr<::defold_hermes::script_handle_lowering::CapturedLuaRouter> handleRouter_;
  std::shared_ptr<LuaClosureLifetime> luaClosureLifetime_;
  const ::defold_hermes::script_handle_lowering::RuntimeProfile* runtimeProfile_ = nullptr;
  ::defold_hermes::lua_bridge::LuaRegistryApi semanticRegistryApi_{};
  char adapterError_[384]{};
};

}  // namespace defold_hermes::lua_bridge::scalar
