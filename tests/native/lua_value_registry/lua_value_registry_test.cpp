#include <defold_hermes/lua_value_registry.hpp>

#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <dmsdk/lua/lua.h>
}

namespace {

std::atomic<uint64_t> g_cppAllocations{0};

struct LuaAllocatorStats {
  uint64_t nonzeroCalls = 0;
  uint64_t frees = 0;
};

void *CountedLuaAllocator(void *user, void *pointer, size_t, size_t newSize) {
  auto *stats = static_cast<LuaAllocatorStats *>(user);
  if (newSize == 0) {
    ++stats->frees;
    std::free(pointer);
    return nullptr;
  }
  ++stats->nonzeroCalls;
  return std::realloc(pointer, newSize);
}

struct LuaFixture {
  LuaAllocatorStats allocator;
  lua_State *state = nullptr;

  LuaFixture() : state(lua_newstate(CountedLuaAllocator, &allocator)) {}
  ~LuaFixture() {
    if (state)
      lua_close(state);
  }
};

int Noop(lua_State *) { return 0; }

#define CHECK(condition)                                                       \
  do {                                                                         \
    if (!(condition)) {                                                        \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__,  \
                   #condition);                                                \
      return false;                                                            \
    }                                                                          \
  } while (false)

using defold_hermes::lua_bridge::Handle;
using defold_hermes::lua_bridge::LuaValueDescriptor;
using defold_hermes::lua_bridge::LuaValueKind;
using defold_hermes::lua_bridge::LuaValuePolicy;
using defold_hermes::lua_bridge::LuaValueRecord;
using defold_hermes::lua_bridge::LuaValueRegistry;

constexpr LuaValueDescriptor Borrowed(LuaValueKind kind) {
  return {kind, LuaValuePolicy::kBorrowed};
}

constexpr LuaValueDescriptor Owned(LuaValueKind kind) {
  return {kind, LuaValuePolicy::kOwnedRoot};
}

bool PushesSameIdentity(LuaValueRegistry &registry, lua_State *state,
                        Handle handle, LuaValueDescriptor descriptor) {
  const int top = lua_gettop(state);
  CHECK(registry.push(handle, descriptor));
  CHECK(lua_gettop(state) == top + 1);
  CHECK(registry.push(handle, descriptor));
  CHECK(lua_gettop(state) == top + 2);
  CHECK(lua_rawequal(state, -1, -2) == 1);
  lua_settop(state, top);
  return true;
}

bool TestKindsIdentityAndStack() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  lua_State *state = fixture.state;
  CHECK(lua_checkstack(state, 64) != 0);
  LuaValueRegistry registry(state, 41, 5, 5);

  const int base = lua_gettop(state);
  lua_newtable(state);
  const int tableTop = lua_gettop(state);
  const Handle table = registry.capture(-1, Borrowed(LuaValueKind::kTable));
  CHECK(table);
  CHECK(lua_gettop(state) == tableTop);
  lua_settop(state, base);

  lua_pushcfunction(state, Noop);
  const int functionTop = lua_gettop(state);
  const Handle function = registry.capture(-1, Owned(LuaValueKind::kFunction));
  CHECK(function);
  CHECK(lua_gettop(state) == functionTop);
  lua_settop(state, base);

  lua_newuserdata(state, 16);
  const Handle userdata =
      registry.capture(-1, Borrowed(LuaValueKind::kUserdata));
  CHECK(userdata);
  CHECK(lua_gettop(state) == base + 1);
  lua_settop(state, base);

  lua_newuserdata(state, 32);
  const Handle defoldValue =
      registry.capture(-1, Owned(LuaValueKind::kDefoldValue));
  CHECK(defoldValue);
  CHECK(lua_gettop(state) == base + 1);
  lua_settop(state, base);

  lua_newtable(state);
  const Handle instance =
      registry.capture(-1, Borrowed(LuaValueKind::kInstance));
  CHECK(instance);
  CHECK(lua_gettop(state) == base + 1);
  lua_settop(state, base);

  lua_gc(state, LUA_GCCOLLECT, 0);
  CHECK(PushesSameIdentity(registry, state, table,
                           Borrowed(LuaValueKind::kTable)));
  CHECK(PushesSameIdentity(registry, state, function,
                           Owned(LuaValueKind::kFunction)));
  CHECK(PushesSameIdentity(registry, state, userdata,
                           Borrowed(LuaValueKind::kUserdata)));
  CHECK(PushesSameIdentity(registry, state, defoldValue,
                           Owned(LuaValueKind::kDefoldValue)));
  CHECK(PushesSameIdentity(registry, state, instance,
                           Borrowed(LuaValueKind::kInstance)));
  CHECK(lua_gettop(state) == base);

  LuaValueRecord record;
  CHECK(registry.inspect(function, Owned(LuaValueKind::kFunction), &record));
  CHECK(record.state == state);
  CHECK(record.runtime == 41);
  CHECK(record.descriptor.kind == LuaValueKind::kFunction);
  CHECK(record.descriptor.policy == LuaValuePolicy::kOwnedRoot);

  CHECK(registry.release(table, Borrowed(LuaValueKind::kTable)));
  CHECK(registry.release(function, Owned(LuaValueKind::kFunction)));
  CHECK(registry.release(userdata, Borrowed(LuaValueKind::kUserdata)));
  CHECK(registry.release(defoldValue, Owned(LuaValueKind::kDefoldValue)));
  CHECK(registry.release(instance, Borrowed(LuaValueKind::kInstance)));
  CHECK(lua_gettop(state) == base);
  CHECK(registry.stats().live == 0);
  CHECK(registry.stats().highWater == 5);
  return true;
}

bool TestValidationAndStaleRejection() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  lua_State *state = fixture.state;
  LuaValueRegistry registry(state, 7, 1, 1);

  lua_newtable(state);
  const int top = lua_gettop(state);
  const Handle first = registry.capture(-1, Borrowed(LuaValueKind::kTable));
  CHECK(first);
  CHECK(lua_gettop(state) == top);

  CHECK(!registry.push(first, Borrowed(LuaValueKind::kFunction)));
  CHECK(lua_gettop(state) == top);
  CHECK(!registry.push(first, Owned(LuaValueKind::kTable)));
  CHECK(lua_gettop(state) == top);
  CHECK(!registry.push(first, {LuaValueKind::kTable, LuaValuePolicy::kBorrowed, 7}));
  CHECK(lua_gettop(state) == top);

  Handle wrongRuntime = first;
  ++wrongRuntime.runtime;
  CHECK(!registry.push(wrongRuntime));
  CHECK(lua_gettop(state) == top);

  Handle wrongType = first;
  wrongType.type = static_cast<uint32_t>(LuaValueKind::kFunction);
  CHECK(!registry.push(wrongType));
  CHECK(lua_gettop(state) == top);

  CHECK(registry.release(first));
  CHECK(!registry.release(first));
  CHECK(!registry.push(first));

  lua_newtable(state);
  const Handle second = registry.capture(-1, Borrowed(LuaValueKind::kTable));
  CHECK(second);
  CHECK(second.slot == first.slot);
  CHECK(second.generation != first.generation);
  CHECK(!registry.push(first));
  CHECK(registry.push(second));
  lua_pop(state, 1);
  CHECK(registry.release(second));

  CHECK(registry.stats().kindMismatchFailures == 2);
  CHECK(registry.stats().policyMismatchFailures == 1);
  CHECK(registry.stats().semanticKindMismatchFailures == 1);
  CHECK(registry.stats().runtimeMismatchFailures == 1);
  CHECK(registry.stats().doubleReleaseFailures == 1);
  CHECK(registry.stats().staleHandleFailures >= 2);
  lua_settop(state, 0);
  return true;
}

bool TestCapacityQueueAndShutdown() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  lua_State *state = fixture.state;
  LuaValueRegistry registry(state, 8, 2, 1);

  lua_newtable(state);
  const Handle first = registry.capture(-1, Borrowed(LuaValueKind::kTable));
  lua_pop(state, 1);
  lua_newuserdata(state, 8);
  const Handle second = registry.capture(-1, Owned(LuaValueKind::kUserdata));
  lua_pop(state, 1);
  CHECK(first && second);

  lua_pushcfunction(state, Noop);
  const int fullTop = lua_gettop(state);
  CHECK(!registry.capture(-1, Owned(LuaValueKind::kFunction)));
  CHECK(lua_gettop(state) == fullTop);
  lua_pop(state, 1);
  CHECK(registry.stats().capacityFailures == 1);

  CHECK(registry.queueRelease(first, Borrowed(LuaValueKind::kTable)));
  CHECK(!registry.queueRelease(second, Owned(LuaValueKind::kUserdata)));
  CHECK(registry.stats().queueOverflowFailures == 1);
  CHECK(registry.stats().queued == 1);
  CHECK(registry.stats().live == 1);
  CHECK(registry.stats().queueDepth == 1);
  CHECK(registry.push(second));
  lua_pop(state, 1);
  CHECK(registry.drainDeferred(0) == 0);
  CHECK(registry.drainDeferred(1) == 1);
  CHECK(registry.stats().queueDepth == 0);
  CHECK(registry.stats().deferredDrained == 1);

  CHECK(registry.shutdown() == 1);
  CHECK(registry.shutdown() == 0);
  CHECK(registry.stats().live == 0);
  CHECK(registry.stats().queued == 0);
  CHECK(registry.stats().shutdownReleases == 1);
  CHECK(!registry.initialized());
  return true;
}

bool TestInvalidTypes() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  LuaValueRegistry registry(fixture.state, 9, 1, 1);
  lua_pushnumber(fixture.state, 3.0);
  const int top = lua_gettop(fixture.state);
  CHECK(!registry.capture(-1, Borrowed(LuaValueKind::kTable)));
  CHECK(lua_gettop(fixture.state) == top);
  CHECK(!registry.capture(-1, {}));
  CHECK(lua_gettop(fixture.state) == top);
  CHECK(registry.stats().luaTypeFailures == 1);
  CHECK(registry.stats().invalidArgumentFailures == 1);
  lua_pop(fixture.state, 1);
  return true;
}

bool TestWarmedHotPathsDoNotAllocate() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  lua_State *state = fixture.state;
  CHECK(lua_checkstack(state, 128) != 0);
  LuaValueRegistry registry(state, 10, 2, 2);

  // Creating/rooting identities is deliberately cold. It may grow Lua's
  // registry table; the assertion begins only after that work is complete.
  lua_newtable(state);
  const Handle table = registry.capture(-1, Owned(LuaValueKind::kTable));
  lua_pop(state, 1);
  lua_newtable(state);
  const Handle second = registry.capture(-1, Borrowed(LuaValueKind::kTable));
  lua_pop(state, 1);
  CHECK(table && second);

  const uint64_t cppBefore = g_cppAllocations.load();
  const uint64_t luaBefore = fixture.allocator.nonzeroCalls;
  for (uint32_t iteration = 0; iteration < 100000; ++iteration) {
    CHECK(registry.push(table, Owned(LuaValueKind::kTable)));
    lua_pop(state, 1);
  }
  CHECK(registry.queueRelease(table, Owned(LuaValueKind::kTable)));
  CHECK(registry.drainDeferred() == 1);
  CHECK(registry.release(second, Borrowed(LuaValueKind::kTable)));
  CHECK(g_cppAllocations.load() == cppBefore);
  CHECK(fixture.allocator.nonzeroCalls == luaBefore);
  CHECK(lua_gettop(state) == 0);
  return true;
}

bool TestDestructorCleansLiveAndQueuedRoots() {
  LuaFixture fixture;
  CHECK(fixture.state != nullptr);
  lua_State *state = fixture.state;
  const int top = lua_gettop(state);
  {
    LuaValueRegistry registry(state, 11, 2, 2);
    lua_newtable(state);
    const Handle live = registry.capture(-1, Owned(LuaValueKind::kTable));
    lua_pop(state, 1);
    lua_pushcfunction(state, Noop);
    const Handle queued = registry.capture(-1, Owned(LuaValueKind::kFunction));
    lua_pop(state, 1);
    CHECK(live && queued);
    CHECK(registry.queueRelease(queued));
    // Deliberately leave both roots to the destructor. It must unref both
    // while the Lua state is still valid and preserve the exact stack top.
  }
  CHECK(lua_gettop(state) == top);
  lua_gc(state, LUA_GCCOLLECT, 0);
  CHECK(lua_gettop(state) == top);
  return true;
}

} // namespace

void *operator new(std::size_t size) {
  ++g_cppAllocations;
  if (void *memory = std::malloc(size))
    return memory;
  throw std::bad_alloc();
}

void *operator new[](std::size_t size) {
  ++g_cppAllocations;
  if (void *memory = std::malloc(size))
    return memory;
  throw std::bad_alloc();
}

void operator delete(void *pointer) noexcept { std::free(pointer); }

void operator delete[](void *pointer) noexcept { std::free(pointer); }

void operator delete(void *pointer, std::size_t) noexcept {
  std::free(pointer);
}

void operator delete[](void *pointer, std::size_t) noexcept {
  std::free(pointer);
}

int main() {
  if (!TestKindsIdentityAndStack())
    return 1;
  if (!TestValidationAndStaleRejection())
    return 1;
  if (!TestCapacityQueueAndShutdown())
    return 1;
  if (!TestInvalidTypes())
    return 1;
  if (!TestWarmedHotPathsDoNotAllocate())
    return 1;
  if (!TestDestructorCleansLiveAndQueuedRoots())
    return 1;
  std::puts("lua value registry: all tests passed");
  return 0;
}
