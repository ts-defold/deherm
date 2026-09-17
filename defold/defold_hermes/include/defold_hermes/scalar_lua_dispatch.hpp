#pragma once

#include <defold_hermes/binding_arena.hpp>
#include <defold_hermes/generated_scalar_lua_ids.hpp>

#include <array>
#include <cstddef>
#include <cstdint>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <dmsdk/lua/lua.h>
}

namespace defold_hermes::lua_bridge::scalar {

enum class ScalarCodec : uint8_t {
  kNone = 0,
  kBoolean,
  kInteger,
  kNumber,
  kString,
};

enum class ScalarTag : uint8_t {
  kNil = 0,
  kBoolean,
  kInteger,
  kNumber,
  kString,
};

struct StringView {
  const char* data;
  uint32_t size;
};

/** Trivially-copyable input cell suitable for call-local BindingArena storage. */
struct ScalarInput {
  ScalarTag tag;
  bool boolean;
  int64_t integer;
  double number;
  StringView string;

  static ScalarInput booleanValue(bool value) noexcept;
  static ScalarInput integerValue(int64_t value) noexcept;
  static ScalarInput numberValue(double value) noexcept;
  static ScalarInput stringValue(const char* data, uint32_t size) noexcept;
};

/**
 * Caller-owned result cell. String results are copied before the Lua stack is
 * restored. Set stringData/stringCapacity before dispatch; stringSize reports
 * the bytes written, or the required size when capacity is insufficient.
 */
struct ScalarOutput {
  ScalarTag tag = ScalarTag::kNil;
  bool boolean = false;
  int64_t integer = 0;
  double number = 0.0;
  char* stringData = nullptr;
  uint32_t stringCapacity = 0;
  uint32_t stringSize = 0;
};

struct ScalarBindingTables {
  size_t bindingCount;
  size_t argumentCodecCount;
  const uint32_t* stableIds;
  const char* const* canonicalIds;
  const char* const* modulePaths;
  const char* const* members;
  const uint16_t* argumentOffsets;
  const ScalarCodec* argumentCodecs;
  const uint8_t* argumentOptional;
  const uint8_t* requiredArgumentCounts;
  const uint8_t* maximumArgumentCounts;
  const ScalarCodec* resultCodecs;
  const uint8_t* resultNullable;
};

namespace generated {
const ScalarBindingTables& tables() noexcept;
}

struct InstanceApi {
  // get pushes the current instance. set consumes the instance at stack top.
  void (*get)(lua_State* state) = nullptr;
  void (*set)(lua_State* state) = nullptr;
};

struct DispatchStats {
  uint64_t calls = 0;
  uint64_t failures = 0;
  uint32_t boundFunctions = 0;
  uint32_t reservedStackSlots = 0;
};

/**
 * Stable-id scalar dispatcher with exact-size fixed function-ref storage.
 * Initialization and bind may allocate inside Lua; dispatch itself owns no
 * heap storage and never falls back when call-local scratch is exhausted.
 */
class Dispatcher {
 public:
  Dispatcher() noexcept;
  ~Dispatcher();

  Dispatcher(const Dispatcher&) = delete;
  Dispatcher& operator=(const Dispatcher&) = delete;

  bool initialize(lua_State* state, uint32_t stackReserve = 16, InstanceApi instanceApi = {}) noexcept;
  void shutdown() noexcept;
  /** Clears references without touching Lua after the owner has already closed the state. */
  void detach() noexcept;
  bool captureInstance(int stackIndex) noexcept;
  bool bind(uint32_t stableId) noexcept;
  bool isBound(uint32_t stableId) const noexcept;

  bool dispatch(
      uint32_t stableId,
      binding::Span<const ScalarInput> arguments,
      ScalarOutput* output = nullptr) noexcept;

  const char* lastError() const noexcept { return error_; }
  const DispatchStats& stats() const noexcept { return stats_; }

 private:
  size_t findDenseIndex(uint32_t stableId) const noexcept;
  bool pushModulePath(const char* path) noexcept;
  bool reserveStack(size_t slots) noexcept;
  bool validateArguments(size_t denseIndex, binding::Span<const ScalarInput> arguments) noexcept;
  bool pushArgument(ScalarCodec codec, const ScalarInput& input) noexcept;
  bool readResult(size_t denseIndex, ScalarOutput* output) noexcept;
  bool fail(const char* message) noexcept;
  void setError(const char* message) noexcept;

  lua_State* state_ = nullptr;
  InstanceApi instanceApi_{};
  int instanceRef_ = LUA_NOREF;
  std::array<int, generated::kBindingCount> functionRefs_{};
  char error_[384]{};
  DispatchStats stats_{};
};

// Six is the current generated maximum. A Hermes/Static Hermes adapter can
// stage one complete scalar call in 240 bytes (plus debug canary) and rewind it
// with BindingArena::Frame after dispatch.
using ScalarCallArena = binding::BindingArena<
    sizeof(ScalarInput) * generated::kMaxArgumentCount,
    alignof(ScalarInput)>;

}  // namespace defold_hermes::lua_bridge::scalar
