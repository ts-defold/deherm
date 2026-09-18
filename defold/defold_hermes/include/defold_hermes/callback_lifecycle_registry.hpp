#pragma once

#include <defold_hermes/lua_bridge_core.hpp>

#include <cstdint>
#include <memory>

namespace defold_hermes::callback_lifecycle {

enum class Lifetime : uint8_t {
  kOneShot,
  kTerminalEvent,
  kPersistentReplaceable,
  kHigherOrderClosure,
};

struct Lease {
  uint32_t runtime = 0;
  uint32_t slot = UINT32_MAX;
  uint32_t generation = 0;

  explicit operator bool() const noexcept { return slot != UINT32_MAX; }
};

struct Stats {
  uint32_t capacity = 0;
  uint32_t live = 0;
  uint32_t highWater = 0;
  uint64_t retains = 0;
  uint64_t invocations = 0;
  uint64_t releases = 0;
  uint64_t staleAccesses = 0;
  uint64_t wrongThread = 0;
  uint64_t exhausted = 0;
};

using Invoke = bool (*)(void*, lua_bridge::Handle) noexcept;
using Release = void (*)(void*, lua_bridge::Handle) noexcept;

/**
 * Fixed-capacity ownership metadata for handles rooted by CallbackRegistry.
 *
 * This class never owns a JSI value. CallbackRegistry remains the root owner
 * and issues the generation-checked lua_bridge::Handle stored here. A lease
 * adds route, owner, runtime, thread, one-shot/terminal, and reentrancy policy.
 * Construction is the only allocating operation; retain/invoke/cancel/teardown
 * use fixed structure-of-arrays storage and have no heap fallback.
 */
class Registry {
 public:
  Registry(uint32_t capacity, uint32_t runtimeId, uint64_t ownerThreadToken);
  ~Registry();

  Registry(const Registry&) = delete;
  Registry& operator=(const Registry&) = delete;

  Lease retain(
      uint32_t stableId,
      uint64_t owner,
      lua_bridge::Handle callback,
      Lifetime lifetime,
      uint64_t threadToken) noexcept;

  bool invoke(
      Lease lease,
      bool terminal,
      void* invokeContext,
      Invoke invoke,
      void* releaseContext,
      Release release,
      uint64_t threadToken) noexcept;

  bool cancel(
      Lease lease,
      void* releaseContext,
      Release release,
      uint64_t threadToken) noexcept;

  uint32_t cancelOwner(
      uint64_t owner,
      void* releaseContext,
      Release release,
      uint64_t threadToken) noexcept;

  uint32_t teardown(
      void* releaseContext,
      Release release,
      uint64_t threadToken) noexcept;

  const Stats& stats() const noexcept { return stats_; }
  uint32_t runtimeId() const noexcept { return runtimeId_; }
  bool shuttingDown() const noexcept { return shuttingDown_; }

 private:
  enum SlotState : uint8_t { kFree = 0, kLive = 1 };

  bool onOwnerThread(uint64_t threadToken) noexcept;
  bool matches(Lease lease) noexcept;
  void finishRelease(uint32_t slot, void* context, Release release) noexcept;

  uint32_t capacity_ = 0;
  uint32_t runtimeId_ = 0;
  uint64_t ownerThreadToken_ = 0;
  uint32_t freeHead_ = UINT32_MAX;
  bool shuttingDown_ = false;
  std::unique_ptr<lua_bridge::Handle[]> callbacks_;
  std::unique_ptr<uint64_t[]> owners_;
  std::unique_ptr<uint32_t[]> stableIds_;
  std::unique_ptr<uint32_t[]> generations_;
  std::unique_ptr<uint32_t[]> nextFree_;
  std::unique_ptr<uint16_t[]> depths_;
  std::unique_ptr<uint8_t[]> lifetimes_;
  std::unique_ptr<uint8_t[]> cancelPending_;
  std::unique_ptr<uint8_t[]> completing_;
  std::unique_ptr<uint8_t[]> states_;
  Stats stats_;
};

}  // namespace defold_hermes::callback_lifecycle
