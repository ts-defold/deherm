#include <defold_hermes/lua_value_registry.hpp>

#include <algorithm>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <dmsdk/lua/lua.h>
}

namespace defold_hermes::lua_bridge {
namespace {

int RawReference(lua_State *state, int table) { return luaL_ref(state, table); }

void RawUnreference(lua_State *state, int table, int reference) {
  luaL_unref(state, table, reference);
}

uint32_t NextGeneration(uint32_t generation) {
  ++generation;
  return generation == 0 ? 1 : generation;
}

uint32_t KindType(LuaValueKind kind) { return static_cast<uint32_t>(kind); }

bool IsIdentityType(int luaType, LuaValueKind kind) {
  switch (kind) {
  case LuaValueKind::kUserdata:
  case LuaValueKind::kDefoldValue:
    return luaType == LUA_TUSERDATA;
  case LuaValueKind::kTable:
    return luaType == LUA_TTABLE;
  case LuaValueKind::kFunction:
    return luaType == LUA_TFUNCTION;
  case LuaValueKind::kInstance:
    return luaType == LUA_TTABLE || luaType == LUA_TUSERDATA;
  case LuaValueKind::kAny:
    return false;
  }
  return false;
}

} // namespace

LuaValueRegistry::LuaValueRegistry(lua_State *state, uint32_t runtime,
                                   uint32_t capacity, uint32_t deferredCapacity,
                                   LuaRegistryApi api)
    : state_(state), runtime_(runtime), capacity_(capacity),
      slots_(capacity ? new Slot[capacity] : nullptr),
      queueCapacity_(deferredCapacity),
      queue_(deferredCapacity ? new Handle[deferredCapacity] : nullptr),
      api_(api) {
  if (!api_.reference)
    api_.reference = RawReference;
  if (!api_.unreference)
    api_.unreference = RawUnreference;
  stats_.capacity = capacity;
  stats_.queueCapacity = deferredCapacity;
  if (capacity == 0)
    return;
  for (uint32_t slot = 0; slot < capacity; ++slot) {
    slots_[slot].nextFree = slot + 1 < capacity ? slot + 1 : UINT32_MAX;
  }
  freeHead_ = 0;
}

LuaValueRegistry::~LuaValueRegistry() { shutdown(); }

bool LuaValueRegistry::validateDescriptor(
    LuaValueDescriptor descriptor) noexcept {
  const bool kindValid = descriptor.kind != LuaValueKind::kAny &&
                         descriptor.kind <= LuaValueKind::kInstance;
  const bool policyValid = descriptor.policy == LuaValuePolicy::kBorrowed ||
                           descriptor.policy == LuaValuePolicy::kOwnedRoot;
  if (kindValid && policyValid)
    return true;
  ++stats_.invalidArgumentFailures;
  return false;
}

bool LuaValueRegistry::validateLuaType(int stackIndex,
                                       LuaValueKind kind) noexcept {
  if (state_ && IsIdentityType(lua_type(state_, stackIndex), kind))
    return true;
  ++stats_.luaTypeFailures;
  return false;
}

Handle LuaValueRegistry::capture(int stackIndex,
                                 LuaValueDescriptor descriptor) noexcept {
  if (!state_ || !validateDescriptor(descriptor))
    return {};
  const int top = lua_gettop(state_);
  if (!validateLuaType(stackIndex, descriptor.kind)) {
    lua_settop(state_, top);
    return {};
  }
  if (freeHead_ == UINT32_MAX) {
    ++stats_.capacityFailures;
    lua_settop(state_, top);
    return {};
  }
  if (!lua_checkstack(state_, 1)) {
    ++stats_.invalidArgumentFailures;
    lua_settop(state_, top);
    return {};
  }

  const uint32_t slotIndex = freeHead_;
  Slot &slot = slots_[slotIndex];
  lua_pushvalue(state_, stackIndex);
  const int reference = api_.reference(state_, LUA_REGISTRYINDEX);
  lua_settop(state_, top);
  if (reference == LUA_NOREF || reference == LUA_REFNIL) {
    ++stats_.invalidArgumentFailures;
    return {};
  }

  freeHead_ = slot.nextFree;
  slot.reference = reference;
  slot.kind = descriptor.kind;
  slot.policy = descriptor.policy;
  slot.state = kLive;
  slot.nextFree = UINT32_MAX;
  ++stats_.live;
  stats_.highWater = std::max(stats_.highWater, stats_.live + stats_.queued);
  ++stats_.captures;
  return {runtime_, slotIndex, slot.generation, KindType(slot.kind)};
}

bool LuaValueRegistry::validateHandle(Handle handle,
                                      LuaValueDescriptor expected,
                                      SlotState state, LuaValueRecord *out,
                                      bool forRelease) noexcept {
  if (!state_ || handle.slot >= capacity_) {
    ++stats_.staleHandleFailures;
    return false;
  }
  Slot &slot = slots_[handle.slot];
  if (handle.runtime != runtime_) {
    ++stats_.runtimeMismatchFailures;
    return false;
  }
  if (slot.state != state || slot.generation != handle.generation) {
    if (forRelease && slot.releasedGeneration == handle.generation) {
      ++stats_.doubleReleaseFailures;
    } else {
      ++stats_.staleHandleFailures;
    }
    return false;
  }
  if (handle.type != KindType(slot.kind) ||
      (expected.kind != LuaValueKind::kAny && expected.kind != slot.kind)) {
    ++stats_.kindMismatchFailures;
    return false;
  }
  if (expected.policy != LuaValuePolicy::kAny &&
      expected.policy != slot.policy) {
    ++stats_.policyMismatchFailures;
    return false;
  }
  if (out) {
    *out = {state_, slot.reference, runtime_, {slot.kind, slot.policy}};
  }
  return true;
}

bool LuaValueRegistry::inspect(Handle handle, LuaValueDescriptor expected,
                               LuaValueRecord *out) noexcept {
  if (!out) {
    ++stats_.invalidArgumentFailures;
    return false;
  }
  return validateHandle(handle, expected, kLive, out, false);
}

bool LuaValueRegistry::push(Handle handle,
                            LuaValueDescriptor expected) noexcept {
  LuaValueRecord record;
  if (!validateHandle(handle, expected, kLive, &record, false))
    return false;
  const int top = lua_gettop(state_);
  if (!lua_checkstack(state_, 1)) {
    ++stats_.invalidArgumentFailures;
    lua_settop(state_, top);
    return false;
  }
  lua_rawgeti(state_, LUA_REGISTRYINDEX, record.reference);
  if (lua_gettop(state_) != top + 1 ||
      !IsIdentityType(lua_type(state_, -1), record.descriptor.kind)) {
    ++stats_.luaTypeFailures;
    lua_settop(state_, top);
    return false;
  }
  ++stats_.pushes;
  return true;
}

bool LuaValueRegistry::unrefAndRecycle(uint32_t slotIndex,
                                       bool shutdownRelease) noexcept {
  if (!state_ || slotIndex >= capacity_)
    return false;
  Slot &slot = slots_[slotIndex];
  const int top = lua_gettop(state_);
  api_.unreference(state_, LUA_REGISTRYINDEX, slot.reference);
  lua_settop(state_, top);
  recycle(slotIndex);
  if (shutdownRelease)
    ++stats_.shutdownReleases;
  return true;
}

bool LuaValueRegistry::release(Handle handle,
                               LuaValueDescriptor expected) noexcept {
  if (!validateHandle(handle, expected, kLive, nullptr, true))
    return false;
  return unrefAndRecycle(handle.slot, false);
}

bool LuaValueRegistry::queueRelease(Handle handle,
                                    LuaValueDescriptor expected) noexcept {
  if (!validateHandle(handle, expected, kLive, nullptr, true))
    return false;
  if (queueCount_ == queueCapacity_) {
    ++stats_.queueOverflowFailures;
    return false;
  }
  Slot &slot = slots_[handle.slot];
  slot.state = kQueued;
  --stats_.live;
  ++stats_.queued;
  queue_[queueTail_] = handle;
  queueTail_ = (queueTail_ + 1) % queueCapacity_;
  ++queueCount_;
  stats_.queueDepth = queueCount_;
  stats_.queueHighWater = std::max(stats_.queueHighWater, queueCount_);
  ++stats_.deferredQueued;
  return true;
}

uint32_t LuaValueRegistry::drainDeferred(uint32_t maximum) noexcept {
  uint32_t drained = 0;
  while (queueCount_ != 0 && drained < maximum) {
    const Handle handle = queue_[queueHead_];
    queueHead_ = (queueHead_ + 1) % queueCapacity_;
    --queueCount_;
    stats_.queueDepth = queueCount_;
    if (!validateHandle(handle, {}, kQueued, nullptr, false))
      continue;
    unrefAndRecycle(handle.slot, false);
    ++stats_.deferredDrained;
    ++drained;
  }
  return drained;
}

void LuaValueRegistry::recycle(uint32_t slotIndex) noexcept {
  Slot &slot = slots_[slotIndex];
  if (slot.state == kLive)
    --stats_.live;
  if (slot.state == kQueued)
    --stats_.queued;
  slot.releasedGeneration = slot.generation;
  slot.generation = NextGeneration(slot.generation);
  slot.reference = LUA_NOREF;
  slot.kind = LuaValueKind::kAny;
  slot.policy = LuaValuePolicy::kAny;
  slot.state = kFree;
  slot.nextFree = freeHead_;
  freeHead_ = slotIndex;
  ++stats_.releases;
}

uint32_t LuaValueRegistry::shutdown() noexcept {
  if (!state_)
    return 0;
  queueHead_ = queueTail_ = queueCount_ = 0;
  stats_.queueDepth = 0;
  uint32_t released = 0;
  for (uint32_t slot = 0; slot < capacity_; ++slot) {
    if (slots_[slot].state == kFree)
      continue;
    unrefAndRecycle(slot, true);
    ++released;
  }
  state_ = nullptr;
  return released;
}

} // namespace defold_hermes::lua_bridge
