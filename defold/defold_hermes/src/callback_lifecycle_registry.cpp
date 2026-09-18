#include <defold_hermes/callback_lifecycle_registry.hpp>

#include <algorithm>
#include <cstring>

namespace defold_hermes::callback_lifecycle {

Registry::Registry(
    uint32_t capacity,
    uint32_t runtimeId,
    uint64_t ownerThreadToken)
    : capacity_(capacity),
      runtimeId_(runtimeId),
      ownerThreadToken_(ownerThreadToken),
      callbacks_(capacity ? new lua_bridge::Handle[capacity] : nullptr),
      owners_(capacity ? new uint64_t[capacity] : nullptr),
      stableIds_(capacity ? new uint32_t[capacity] : nullptr),
      generations_(capacity ? new uint32_t[capacity] : nullptr),
      nextFree_(capacity ? new uint32_t[capacity] : nullptr),
      depths_(capacity ? new uint16_t[capacity] : nullptr),
      lifetimes_(capacity ? new uint8_t[capacity] : nullptr),
      cancelPending_(capacity ? new uint8_t[capacity] : nullptr),
      completing_(capacity ? new uint8_t[capacity] : nullptr),
      states_(capacity ? new uint8_t[capacity] : nullptr) {
  stats_.capacity = capacity;
  if (!capacity) return;
  std::memset(callbacks_.get(), 0, sizeof(lua_bridge::Handle) * capacity);
  std::memset(owners_.get(), 0, sizeof(uint64_t) * capacity);
  std::memset(stableIds_.get(), 0, sizeof(uint32_t) * capacity);
  std::memset(depths_.get(), 0, sizeof(uint16_t) * capacity);
  std::memset(lifetimes_.get(), 0, sizeof(uint8_t) * capacity);
  std::memset(cancelPending_.get(), 0, sizeof(uint8_t) * capacity);
  std::memset(completing_.get(), 0, sizeof(uint8_t) * capacity);
  std::memset(states_.get(), kFree, sizeof(uint8_t) * capacity);
  for (uint32_t slot = 0; slot < capacity; ++slot) {
    generations_[slot] = 1;
    nextFree_[slot] = slot + 1 < capacity ? slot + 1 : UINT32_MAX;
  }
  freeHead_ = 0;
}

Registry::~Registry() = default;

bool Registry::onOwnerThread(uint64_t threadToken) noexcept {
  if (threadToken == ownerThreadToken_) return true;
  ++stats_.wrongThread;
  return false;
}

bool Registry::matches(Lease lease) noexcept {
  const bool valid = lease.runtime == runtimeId_ &&
      lease.slot < capacity_ &&
      states_[lease.slot] == kLive &&
      generations_[lease.slot] == lease.generation;
  if (!valid) ++stats_.staleAccesses;
  return valid;
}

Lease Registry::retain(
    uint32_t stableId,
    uint64_t owner,
    lua_bridge::Handle callback,
    Lifetime lifetime,
    uint64_t threadToken) noexcept {
  if (!onOwnerThread(threadToken) || shuttingDown_ || !callback ||
      callback.runtime != runtimeId_ ||
      lifetime == Lifetime::kHigherOrderClosure) {
    ++stats_.staleAccesses;
    return {};
  }
  if (freeHead_ == UINT32_MAX) {
    ++stats_.exhausted;
    return {};
  }
  const uint32_t slot = freeHead_;
  freeHead_ = nextFree_[slot];
  callbacks_[slot] = callback;
  owners_[slot] = owner;
  stableIds_[slot] = stableId;
  depths_[slot] = 0;
  lifetimes_[slot] = static_cast<uint8_t>(lifetime);
  cancelPending_[slot] = 0;
  completing_[slot] = 0;
  states_[slot] = kLive;
  ++stats_.live;
  ++stats_.retains;
  stats_.highWater = std::max(stats_.highWater, stats_.live);
  return {runtimeId_, slot, generations_[slot]};
}

void Registry::finishRelease(
    uint32_t slot,
    void* context,
    Release release) noexcept {
  const lua_bridge::Handle callback = callbacks_[slot];
  states_[slot] = kFree;
  callbacks_[slot] = {};
  owners_[slot] = 0;
  stableIds_[slot] = 0;
  depths_[slot] = 0;
  lifetimes_[slot] = 0;
  cancelPending_[slot] = 0;
  completing_[slot] = 0;
  uint32_t nextGeneration = generations_[slot] + 1;
  generations_[slot] = nextGeneration ? nextGeneration : 1;
  nextFree_[slot] = freeHead_;
  freeHead_ = slot;
  --stats_.live;
  ++stats_.releases;
  if (release) release(context, callback);
}

bool Registry::invoke(
    Lease lease,
    bool terminal,
    void* invokeContext,
    Invoke invokeCallback,
    void* releaseContext,
    Release release,
    uint64_t threadToken) noexcept {
  if (!onOwnerThread(threadToken) || !matches(lease)) return false;
  const uint32_t slot = lease.slot;
  const Lifetime lifetime = static_cast<Lifetime>(lifetimes_[slot]);
  if (lifetime == Lifetime::kOneShot && completing_[slot]) {
    ++stats_.staleAccesses;
    return false;
  }
  if (depths_[slot] == UINT16_MAX) {
    ++stats_.staleAccesses;
    return false;
  }
  if (lifetime == Lifetime::kOneShot) completing_[slot] = 1;
  ++depths_[slot];
  ++stats_.invocations;
  const lua_bridge::Handle callback = callbacks_[slot];
  const bool invoked = invokeCallback && invokeCallback(invokeContext, callback);
  --depths_[slot];

  const bool releaseAfterAttempt = lifetime == Lifetime::kOneShot;
  const bool releaseAtTerminal = lifetime == Lifetime::kTerminalEvent && terminal;
  if (releaseAfterAttempt || releaseAtTerminal) cancelPending_[slot] = 1;
  if (depths_[slot] == 0 && cancelPending_[slot]) {
    finishRelease(slot, releaseContext, release);
  }
  return invoked;
}

bool Registry::cancel(
    Lease lease,
    void* releaseContext,
    Release release,
    uint64_t threadToken) noexcept {
  if (!onOwnerThread(threadToken) || !matches(lease)) return false;
  const uint32_t slot = lease.slot;
  if (depths_[slot]) {
    cancelPending_[slot] = 1;
  } else {
    finishRelease(slot, releaseContext, release);
  }
  return true;
}

uint32_t Registry::cancelOwner(
    uint64_t owner,
    void* releaseContext,
    Release release,
    uint64_t threadToken) noexcept {
  if (!onOwnerThread(threadToken)) return 0;
  uint32_t count = 0;
  for (uint32_t slot = 0; slot < capacity_; ++slot) {
    if (states_[slot] != kLive || owners_[slot] != owner) continue;
    ++count;
    if (depths_[slot]) cancelPending_[slot] = 1;
    else finishRelease(slot, releaseContext, release);
  }
  return count;
}

uint32_t Registry::teardown(
    void* releaseContext,
    Release release,
    uint64_t threadToken) noexcept {
  if (!onOwnerThread(threadToken)) return 0;
  shuttingDown_ = true;
  uint32_t count = 0;
  for (uint32_t slot = 0; slot < capacity_; ++slot) {
    if (states_[slot] != kLive) continue;
    ++count;
    if (depths_[slot]) cancelPending_[slot] = 1;
    else finishRelease(slot, releaseContext, release);
  }
  return count;
}

}  // namespace defold_hermes::callback_lifecycle
