#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

namespace defold_hermes::lua_bridge {

struct Handle {
  uint32_t runtime = 0;
  uint32_t slot = UINT32_MAX;
  uint32_t generation = 0;
  uint32_t type = 0;

  explicit operator bool() const { return slot != UINT32_MAX; }
};

struct HandleRecord {
  void* state = nullptr;
  uintptr_t payload = 0;
  uint32_t runtime = 0;
  uint32_t type = 0;
};

struct HandlePoolStats {
  uint32_t capacity = 0;
  uint32_t live = 0;
  uint32_t queued = 0;
  uint32_t highWater = 0;
  uint64_t acquisitions = 0;
  uint64_t releases = 0;
  uint64_t staleAccesses = 0;
  uint64_t exhausted = 0;
};

/**
 * Fixed-capacity, structure-of-arrays handle storage. All backing memory is
 * allocated in the constructor; acquire/release/queue/drain never allocate.
 */
class HandlePool {
 public:
  explicit HandlePool(uint32_t capacity);
  ~HandlePool();

  HandlePool(const HandlePool&) = delete;
  HandlePool& operator=(const HandlePool&) = delete;

  Handle acquire(uint32_t runtime, uint32_t type, void* state, uintptr_t payload);
  bool resolve(Handle handle, HandleRecord* out);
  bool queueRelease(Handle handle);

  template <typename Release>
  bool release(Handle handle, Release&& releaseRecord) {
    HandleRecord record;
    if (!resolveForRelease(handle, &record)) return false;
    releaseRecord(record);
    recycle(handle.slot);
    return true;
  }

  template <typename Release>
  uint32_t drain(Release&& releaseRecord) {
    uint32_t count = 0;
    while (queueHead_ != queueTail_) {
      const Handle handle = queue_[queueHead_];
      queueHead_ = (queueHead_ + 1) % queueCapacity_;
      HandleRecord record;
      if (resolveQueued(handle, &record)) {
        releaseRecord(record);
        recycle(handle.slot);
        ++count;
      }
    }
    return count;
  }

  template <typename Release>
  uint32_t sweep(Release&& releaseRecord) {
    uint32_t count = 0;
    queueHead_ = queueTail_ = 0;
    for (uint32_t slot = 0; slot < capacity_; ++slot) {
      if (states_[slot] == kFree) continue;
      releaseRecord(recordAt(slot));
      recycle(slot);
      ++count;
    }
    return count;
  }

  const HandlePoolStats& stats() const { return stats_; }

 private:
  enum SlotState : uint8_t { kFree = 0, kLive = 1, kQueued = 2 };

  bool matches(Handle handle, SlotState expected) const;
  bool resolveForRelease(Handle handle, HandleRecord* out);
  bool resolveQueued(Handle handle, HandleRecord* out);
  HandleRecord recordAt(uint32_t slot) const;
  void recycle(uint32_t slot);

  uint32_t capacity_ = 0;
  uint32_t freeHead_ = UINT32_MAX;
  std::unique_ptr<void*[]> luaStates_;
  std::unique_ptr<uintptr_t[]> payloads_;
  std::unique_ptr<uint32_t[]> runtimes_;
  std::unique_ptr<uint32_t[]> types_;
  std::unique_ptr<uint32_t[]> generations_;
  std::unique_ptr<uint32_t[]> nextFree_;
  std::unique_ptr<uint8_t[]> states_;

  // One queue slot is reserved to distinguish full from empty. Capacity is
  // pool capacity + 1, so every live handle can be queued exactly once.
  uint32_t queueCapacity_ = 0;
  uint32_t queueHead_ = 0;
  uint32_t queueTail_ = 0;
  std::unique_ptr<Handle[]> queue_;
  HandlePoolStats stats_;
};

struct TimerCallbackRecord {
  Handle callback;
  bool repeating = false;
};

struct TimerCallbackTableStats {
  uint32_t capacity = 0;
  uint32_t size = 0;
  uint32_t highWater = 0;
  uint64_t inserts = 0;
  uint64_t erases = 0;
  uint64_t probes = 0;
  uint64_t exhausted = 0;
};

/** Fixed-capacity open-addressed timer-to-callback index. */
class TimerCallbackTable {
 public:
  explicit TimerCallbackTable(uint32_t requestedCapacity);

  bool insert(uint32_t timer, Handle callback, bool repeating);
  bool find(uint32_t timer, TimerCallbackRecord* out);
  bool erase(uint32_t timer, TimerCallbackRecord* out);

  template <typename Release>
  uint32_t sweep(Release&& releaseRecord) {
    uint32_t count = 0;
    for (uint32_t index = 0; index < capacity_; ++index) {
      if (states_[index] != kOccupied) continue;
      releaseRecord(TimerCallbackRecord{callbacks_[index], repeating_[index] != 0});
      states_[index] = kEmpty;
      ++count;
    }
    stats_.size = 0;
    stats_.erases += count;
    return count;
  }

  const TimerCallbackTableStats& stats() const { return stats_; }

 private:
  enum EntryState : uint8_t { kEmpty = 0, kOccupied = 1, kTombstone = 2 };
  uint32_t firstIndex(uint32_t timer) const;

  uint32_t capacity_ = 0;
  uint32_t mask_ = 0;
  std::unique_ptr<uint32_t[]> timers_;
  std::unique_ptr<Handle[]> callbacks_;
  std::unique_ptr<uint8_t[]> repeating_;
  std::unique_ptr<uint8_t[]> states_;
  TimerCallbackTableStats stats_;
};

struct ScratchArenaStats {
  size_t capacity = 0;
  size_t used = 0;
  size_t highWater = 0;
  uint64_t allocations = 0;
  uint64_t exhausted = 0;
};

/** A fixed-capacity bump allocator with no heap fallback. */
class ScratchArena {
 public:
  explicit ScratchArena(size_t capacity);

  ScratchArena(const ScratchArena&) = delete;
  ScratchArena& operator=(const ScratchArena&) = delete;

  void* allocate(size_t size, size_t alignment);

  template <typename T>
  T* allocate(size_t count = 1) {
    if (count > SIZE_MAX / sizeof(T)) return nullptr;
    return static_cast<T*>(allocate(sizeof(T) * count, alignof(T)));
  }

  size_t mark() const { return stats_.used; }
  void reset(size_t mark = 0);
  const ScratchArenaStats& stats() const { return stats_; }

 private:
  std::unique_ptr<std::byte[]> storage_;
  ScratchArenaStats stats_;
};

class ScratchScope {
 public:
  explicit ScratchScope(ScratchArena& arena) : arena_(arena), mark_(arena.mark()) {}
  ~ScratchScope() { arena_.reset(mark_); }

  ScratchScope(const ScratchScope&) = delete;
  ScratchScope& operator=(const ScratchScope&) = delete;

 private:
  ScratchArena& arena_;
  size_t mark_;
};

}  // namespace defold_hermes::lua_bridge
