#include <defold_hermes/lua_bridge_core.hpp>

#include <algorithm>
#include <cstring>

namespace defold_hermes::lua_bridge {

HandlePool::HandlePool(uint32_t capacity)
    : capacity_(capacity),
      luaStates_(capacity ? new void*[capacity] : nullptr),
      payloads_(capacity ? new uintptr_t[capacity] : nullptr),
      runtimes_(capacity ? new uint32_t[capacity] : nullptr),
      types_(capacity ? new uint32_t[capacity] : nullptr),
      generations_(capacity ? new uint32_t[capacity] : nullptr),
      nextFree_(capacity ? new uint32_t[capacity] : nullptr),
      states_(capacity ? new uint8_t[capacity] : nullptr),
      queueCapacity_(capacity + 1),
      queue_(new Handle[queueCapacity_]) {
  stats_.capacity = capacity;
  if (capacity == 0) return;
  std::memset(luaStates_.get(), 0, sizeof(void*) * capacity);
  std::memset(payloads_.get(), 0, sizeof(uintptr_t) * capacity);
  std::memset(runtimes_.get(), 0, sizeof(uint32_t) * capacity);
  std::memset(types_.get(), 0, sizeof(uint32_t) * capacity);
  std::memset(states_.get(), kFree, sizeof(uint8_t) * capacity);
  for (uint32_t slot = 0; slot < capacity; ++slot) {
    generations_[slot] = 1;
    nextFree_[slot] = slot + 1 < capacity ? slot + 1 : UINT32_MAX;
  }
  freeHead_ = 0;
}

HandlePool::~HandlePool() = default;

Handle HandlePool::acquire(
    uint32_t runtime,
    uint32_t type,
    void* state,
    uintptr_t payload) {
  if (freeHead_ == UINT32_MAX) {
    ++stats_.exhausted;
    return {};
  }
  const uint32_t slot = freeHead_;
  freeHead_ = nextFree_[slot];
  luaStates_[slot] = state;
  payloads_[slot] = payload;
  runtimes_[slot] = runtime;
  types_[slot] = type;
  states_[slot] = kLive;
  ++stats_.live;
  stats_.highWater = std::max(stats_.highWater, stats_.live + stats_.queued);
  ++stats_.acquisitions;
  return {runtime, slot, generations_[slot], type};
}

bool HandlePool::matches(Handle handle, SlotState expected) const {
  return handle.slot < capacity_ &&
      states_[handle.slot] == expected &&
      generations_[handle.slot] == handle.generation &&
      runtimes_[handle.slot] == handle.runtime &&
      types_[handle.slot] == handle.type;
}

bool HandlePool::resolve(Handle handle, HandleRecord* out) {
  if (!out || !matches(handle, kLive)) {
    ++stats_.staleAccesses;
    return false;
  }
  *out = recordAt(handle.slot);
  return true;
}

bool HandlePool::resolveForRelease(Handle handle, HandleRecord* out) {
  if (!out || (!matches(handle, kLive) && !matches(handle, kQueued))) {
    ++stats_.staleAccesses;
    return false;
  }
  *out = recordAt(handle.slot);
  return true;
}

bool HandlePool::resolveQueued(Handle handle, HandleRecord* out) {
  if (!out || !matches(handle, kQueued)) return false;
  *out = recordAt(handle.slot);
  return true;
}

bool HandlePool::queueRelease(Handle handle) {
  if (!matches(handle, kLive)) {
    ++stats_.staleAccesses;
    return false;
  }
  const uint32_t next = (queueTail_ + 1) % queueCapacity_;
  if (next == queueHead_) return false;
  states_[handle.slot] = kQueued;
  --stats_.live;
  ++stats_.queued;
  queue_[queueTail_] = handle;
  queueTail_ = next;
  return true;
}

HandleRecord HandlePool::recordAt(uint32_t slot) const {
  return {luaStates_[slot], payloads_[slot], runtimes_[slot], types_[slot]};
}

void HandlePool::recycle(uint32_t slot) {
  if (states_[slot] == kLive) --stats_.live;
  if (states_[slot] == kQueued) --stats_.queued;
  states_[slot] = kFree;
  luaStates_[slot] = nullptr;
  payloads_[slot] = 0;
  runtimes_[slot] = 0;
  types_[slot] = 0;
  uint32_t generation = generations_[slot] + 1;
  generations_[slot] = generation == 0 ? 1 : generation;
  nextFree_[slot] = freeHead_;
  freeHead_ = slot;
  ++stats_.releases;
}

TimerCallbackTable::TimerCallbackTable(uint32_t requestedCapacity) {
  capacity_ = 1;
  while (capacity_ < requestedCapacity && capacity_ <= UINT32_MAX / 2) capacity_ <<= 1;
  if (capacity_ < 2) capacity_ = 2;
  mask_ = capacity_ - 1;
  timers_.reset(new uint32_t[capacity_]);
  callbacks_.reset(new Handle[capacity_]);
  repeating_.reset(new uint8_t[capacity_]);
  states_.reset(new uint8_t[capacity_]);
  std::memset(states_.get(), kEmpty, capacity_ * sizeof(uint8_t));
  stats_.capacity = capacity_;
}

uint32_t TimerCallbackTable::firstIndex(uint32_t timer) const {
  return (timer * 2654435761u) & mask_;
}

bool TimerCallbackTable::insert(uint32_t timer, Handle callback, bool repeating) {
  uint32_t index = firstIndex(timer);
  uint32_t tombstone = UINT32_MAX;
  for (uint32_t probe = 0; probe < capacity_; ++probe) {
    ++stats_.probes;
    if (states_[index] == kOccupied && timers_[index] == timer) {
      callbacks_[index] = callback;
      repeating_[index] = repeating ? 1 : 0;
      return true;
    }
    if (states_[index] == kTombstone && tombstone == UINT32_MAX) tombstone = index;
    if (states_[index] == kEmpty) {
      const uint32_t target = tombstone == UINT32_MAX ? index : tombstone;
      timers_[target] = timer;
      callbacks_[target] = callback;
      repeating_[target] = repeating ? 1 : 0;
      states_[target] = kOccupied;
      ++stats_.size;
      ++stats_.inserts;
      stats_.highWater = std::max(stats_.highWater, stats_.size);
      return true;
    }
    index = (index + 1) & mask_;
  }
  if (tombstone != UINT32_MAX) {
    timers_[tombstone] = timer;
    callbacks_[tombstone] = callback;
    repeating_[tombstone] = repeating ? 1 : 0;
    states_[tombstone] = kOccupied;
    ++stats_.size;
    ++stats_.inserts;
    stats_.highWater = std::max(stats_.highWater, stats_.size);
    return true;
  }
  ++stats_.exhausted;
  return false;
}

bool TimerCallbackTable::find(uint32_t timer, TimerCallbackRecord* out) {
  uint32_t index = firstIndex(timer);
  for (uint32_t probe = 0; probe < capacity_; ++probe) {
    ++stats_.probes;
    if (states_[index] == kEmpty) return false;
    if (states_[index] == kOccupied && timers_[index] == timer) {
      if (out) *out = {callbacks_[index], repeating_[index] != 0};
      return true;
    }
    index = (index + 1) & mask_;
  }
  return false;
}

bool TimerCallbackTable::erase(uint32_t timer, TimerCallbackRecord* out) {
  uint32_t index = firstIndex(timer);
  for (uint32_t probe = 0; probe < capacity_; ++probe) {
    ++stats_.probes;
    if (states_[index] == kEmpty) return false;
    if (states_[index] == kOccupied && timers_[index] == timer) {
      if (out) *out = {callbacks_[index], repeating_[index] != 0};
      states_[index] = kTombstone;
      --stats_.size;
      ++stats_.erases;
      return true;
    }
    index = (index + 1) & mask_;
  }
  return false;
}

ScratchArena::ScratchArena(size_t capacity)
    : storage_(capacity ? new std::byte[capacity] : nullptr) {
  stats_.capacity = capacity;
}

void* ScratchArena::allocate(size_t size, size_t alignment) {
  if (size == 0) {
    return storage_ ? static_cast<void*>(storage_.get() + stats_.used) : nullptr;
  }
  if (alignment == 0 || (alignment & (alignment - 1)) != 0) {
    ++stats_.exhausted;
    return nullptr;
  }
  const uintptr_t base = reinterpret_cast<uintptr_t>(storage_.get());
  const uintptr_t current = base + stats_.used;
  const uintptr_t aligned = (current + alignment - 1) & ~(alignment - 1);
  const size_t padding = static_cast<size_t>(aligned - current);
  if (padding > stats_.capacity - stats_.used ||
      size > stats_.capacity - stats_.used - padding) {
    ++stats_.exhausted;
    return nullptr;
  }
  stats_.used += padding + size;
  stats_.highWater = std::max(stats_.highWater, stats_.used);
  ++stats_.allocations;
  return reinterpret_cast<void*>(aligned);
}

void ScratchArena::reset(size_t mark) {
  stats_.used = mark <= stats_.used ? mark : 0;
}

}  // namespace defold_hermes::lua_bridge
