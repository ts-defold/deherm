#pragma once

#include <cstdint>
#include <memory>

#include <defold_hermes/lua_bridge_core.hpp>

struct lua_State;

namespace defold_hermes::lua_bridge {

/** Identity-bearing Lua values supported by the universal handle lane. */
enum class LuaValueKind : uint8_t {
  kAny = 0,
  kUserdata,
  kTable,
  kFunction,
  kDefoldValue,
  kInstance,
};

/**
 * All entries are Lua-registry roots. This policy records ownership of the
 * native/engine value represented by that root, not whether Lua keeps it live.
 */
enum class LuaValuePolicy : uint8_t {
  kAny = 0,
  kBorrowed,
  kOwnedRoot,
};

struct LuaValueDescriptor {
  LuaValueKind kind = LuaValueKind::kAny;
  LuaValuePolicy policy = LuaValuePolicy::kAny;
  /** Generated semantic kind. Zero is wildcard/unspecified. */
  uint16_t semanticKind = 0;
};

struct LuaRegistryApi {
  int (*reference)(lua_State *state, int table) = nullptr;
  void (*unreference)(lua_State *state, int table, int reference) = nullptr;
};

struct LuaValueRecord {
  lua_State *state = nullptr;
  int reference = -2;
  uint32_t runtime = 0;
  LuaValueDescriptor descriptor{};
};

struct LuaValueRegistryStats {
  uint32_t capacity = 0;
  uint32_t queueCapacity = 0;
  uint32_t live = 0;
  uint32_t queued = 0;
  uint32_t queueDepth = 0;
  uint32_t highWater = 0;
  uint32_t queueHighWater = 0;
  uint64_t captures = 0;
  uint64_t pushes = 0;
  uint64_t releases = 0;
  uint64_t deferredQueued = 0;
  uint64_t deferredDrained = 0;
  uint64_t shutdownReleases = 0;
  uint64_t capacityFailures = 0;
  uint64_t queueOverflowFailures = 0;
  uint64_t staleHandleFailures = 0;
  uint64_t runtimeMismatchFailures = 0;
  uint64_t kindMismatchFailures = 0;
  uint64_t policyMismatchFailures = 0;
  uint64_t semanticKindMismatchFailures = 0;
  uint64_t luaTypeFailures = 0;
  uint64_t doubleReleaseFailures = 0;
  uint64_t invalidArgumentFailures = 0;
};

/**
 * Fixed-capacity storage for long-lived identity-bearing Lua values.
 *
 * Construction performs the only C++ heap allocations. capture() may cause
 * Lua's registry table to grow, and push() may grow an unreserved Lua stack,
 * so callers must prewarm/measure both before entering a hot path. With those
 * Lua structures warm, lookup and release use only preallocated native state.
 *
 * The registry and all methods are runtime-thread-affine. queueRelease() is a
 * deferred finalizer hook (it never touches Lua), not a cross-thread queue.
 */
class LuaValueRegistry {
public:
  LuaValueRegistry(lua_State *state, uint32_t runtime, uint32_t capacity,
                   uint32_t deferredCapacity, LuaRegistryApi api = {});
  ~LuaValueRegistry();

  LuaValueRegistry(const LuaValueRegistry &) = delete;
  LuaValueRegistry &operator=(const LuaValueRegistry &) = delete;

  Handle capture(int stackIndex, LuaValueDescriptor descriptor) noexcept;
  bool inspect(Handle handle, LuaValueDescriptor expected,
               LuaValueRecord *out) noexcept;

  /** On success, pushes exactly one value. On failure, restores the stack. */
  bool push(Handle handle, LuaValueDescriptor expected = {}) noexcept;
  bool release(Handle handle, LuaValueDescriptor expected = {}) noexcept;

  /** Marks a live handle for later Lua-thread unref without touching Lua. */
  bool queueRelease(Handle handle, LuaValueDescriptor expected = {}) noexcept;
  uint32_t drainDeferred(uint32_t maximum = UINT32_MAX) noexcept;

  /** Releases every root and reuses the existing storage for a new runtime generation. */
  bool rebind(lua_State *state, uint32_t runtime,
              LuaRegistryApi api = {}) noexcept;

  /** Unrefs every live/queued value. Must run before lua_close(). */
  uint32_t shutdown() noexcept;

  const LuaValueRegistryStats &stats() const noexcept { return stats_; }
  bool initialized() const noexcept { return state_ != nullptr; }

private:
  enum SlotState : uint8_t { kFree = 0, kLive = 1, kQueued = 2 };

  struct Slot {
    int reference = -2;
    uint32_t generation = 1;
    uint32_t releasedGeneration = 0;
    uint32_t nextFree = UINT32_MAX;
    LuaValueKind kind = LuaValueKind::kAny;
    LuaValuePolicy policy = LuaValuePolicy::kAny;
    uint16_t semanticKind = 0;
    SlotState state = kFree;
    uint8_t reserved = 0;
  };

  bool validateDescriptor(LuaValueDescriptor descriptor) noexcept;
  bool validateLuaType(int stackIndex, LuaValueKind kind) noexcept;
  bool validateHandle(Handle handle, LuaValueDescriptor expected,
                      SlotState state, LuaValueRecord *out,
                      bool forRelease) noexcept;
  bool unrefAndRecycle(uint32_t slot, bool shutdownRelease) noexcept;
  void recycle(uint32_t slot) noexcept;

  lua_State *state_ = nullptr;
  uint32_t runtime_ = 0;
  uint32_t capacity_ = 0;
  uint32_t freeHead_ = UINT32_MAX;
  std::unique_ptr<Slot[]> slots_;

  uint32_t queueCapacity_ = 0;
  uint32_t queueHead_ = 0;
  uint32_t queueTail_ = 0;
  uint32_t queueCount_ = 0;
  std::unique_ptr<Handle[]> queue_;

  LuaRegistryApi api_{};
  LuaValueRegistryStats stats_{};
};

} // namespace defold_hermes::lua_bridge
