#include <defold_hermes/generated_lua_bridge.hpp>
#include <defold_hermes/generated_script_special_call_verification.h>
#include <defold_hermes/lua_bridge_core.hpp>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace bridge = defold_hermes::lua_bridge;
namespace generated = defold_hermes::lua_bridge::generated;

namespace {

constexpr uint32_t kMaxFakeTimers = 8192;
int gTimerCallbacks[kMaxFakeTimers];
bool gTimerRepeating[kMaxFakeTimers];
uint32_t gNextTimer = 1;
double gLastDelay = 0.0;
bool gLastRepeating = false;

struct AllocatorStats {
  bool tracking = false;
  uint64_t calls = 0;
  uint64_t allocations = 0;
  uint64_t frees = 0;
  uint64_t bytesRequested = 0;
};

void* CountingAllocator(void* user, void* pointer, size_t, size_t newSize) {
  auto* stats = static_cast<AllocatorStats*>(user);
  if (stats->tracking) {
    ++stats->calls;
    stats->bytesRequested += newSize;
    if (!pointer && newSize) ++stats->allocations;
    if (pointer && !newSize) ++stats->frees;
  }
  if (!newSize) {
    std::free(pointer);
    return nullptr;
  }
  return std::realloc(pointer, newSize);
}

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "lua-bridge-test:error:%s\n", message);
  std::exit(1);
}

void Expect(bool condition, const char* message) {
  if (!condition) Fail(message);
}

int TimerCancel(lua_State* state) {
  const auto handle = static_cast<uint32_t>(luaL_checknumber(state, 1));
  if (handle < kMaxFakeTimers && gTimerCallbacks[handle] != LUA_NOREF) {
    luaL_unref(state, LUA_REGISTRYINDEX, gTimerCallbacks[handle]);
    gTimerCallbacks[handle] = LUA_NOREF;
  }
  lua_pushboolean(state, handle != 0);
  return 1;
}

int TimerDelay(lua_State* state) {
  gLastDelay = luaL_checknumber(state, 1);
  luaL_checktype(state, 2, LUA_TBOOLEAN);
  luaL_checktype(state, 3, LUA_TFUNCTION);
  if (gNextTimer >= kMaxFakeTimers) return luaL_error(state, "fake timer capacity exhausted");
  const uint32_t handle = gNextTimer++;
  lua_pushvalue(state, 3);
  gTimerCallbacks[handle] = luaL_ref(state, LUA_REGISTRYINDEX);
  gTimerRepeating[handle] = lua_toboolean(state, 2) != 0;
  gLastRepeating = gTimerRepeating[handle];
  lua_pushnumber(state, handle);
  return 1;
}

int TimerTrigger(lua_State* state) {
  const auto handle = static_cast<uint32_t>(luaL_checknumber(state, 1));
  if (handle == UINT32_MAX) return luaL_error(state, "synthetic timer failure");
  if (handle == 0 || handle >= kMaxFakeTimers || gTimerCallbacks[handle] == LUA_NOREF) {
    lua_pushboolean(state, 0);
    return 1;
  }
  lua_rawgeti(state, LUA_REGISTRYINDEX, gTimerCallbacks[handle]);
  lua_pushnil(state);
  lua_pushnumber(state, handle);
  lua_pushnumber(state, DEHERM_VERIFY_TIMER_SCENARIO_ELAPSED);
  if (lua_pcall(state, 3, 0, 0) != 0) return lua_error(state);
  if (!gTimerRepeating[handle]) {
    luaL_unref(state, LUA_REGISTRYINDEX, gTimerCallbacks[handle]);
    gTimerCallbacks[handle] = LUA_NOREF;
  }
  lua_pushboolean(state, 1);
  return 1;
}

void RegisterTimer(lua_State* state) {
  const luaL_Reg functions[] = {
    {"delay", TimerDelay},
    {"cancel", TimerCancel},
    {"trigger", TimerTrigger},
    {nullptr, nullptr}
  };
  luaL_register(state, "timer", functions);
  lua_pop(state, 1);
}

struct CallbackStats {
  bridge::HandlePool* handles = nullptr;
  uint64_t invokes = 0;
  uint64_t releases = 0;
  uint32_t lastTimer = 0;
  double lastElapsed = 0;
};

bool InvokeCallback(
    void* context,
    bridge::Handle callback,
    uint32_t timer,
    double elapsed) {
  auto& stats = *static_cast<CallbackStats*>(context);
  bridge::HandleRecord record;
  if (!stats.handles->resolve(callback, &record)) return false;
  ++stats.invokes;
  stats.lastTimer = timer;
  stats.lastElapsed = elapsed;
  return true;
}

void ReleaseCallback(void* context, bridge::Handle callback) {
  auto& stats = *static_cast<CallbackStats*>(context);
  if (stats.handles->release(callback, [](const bridge::HandleRecord&) {})) ++stats.releases;
}

void TestArena() {
  bridge::ScratchArena empty(0);
  Expect(empty.allocate(0, 1) == nullptr, "zero-capacity arena returned an invalid pointer");
  Expect(empty.allocate(1, 1) == nullptr, "zero-capacity arena unexpectedly allocated");

  bridge::ScratchArena arena(256);
  auto* bytes = arena.allocate<uint8_t>(3);
  auto* values = arena.allocate<uint64_t>(4);
  Expect(bytes != nullptr && values != nullptr, "scratch allocations failed");
  Expect(reinterpret_cast<uintptr_t>(values) % alignof(uint64_t) == 0, "scratch alignment is wrong");
  const size_t mark = arena.mark();
  {
    bridge::ScratchScope scope(arena);
    Expect(arena.allocate<uint32_t>(8) != nullptr, "scoped scratch allocation failed");
  }
  Expect(arena.mark() == mark, "scratch scope did not rewind");
  Expect(arena.allocate(1024, 16) == nullptr, "scratch arena unexpectedly fell back to heap");
  Expect(arena.stats().exhausted == 1, "scratch exhaustion was not counted");
}

void TestHandles() {
  bridge::HandlePool pool(4);
  int fakeState = 7;
  const bridge::Handle first = pool.acquire(2, 9, &fakeState, 42);
  Expect(static_cast<bool>(first), "handle acquisition failed");
  bridge::HandleRecord record;
  Expect(pool.resolve(first, &record), "live handle did not resolve");
  Expect(record.state == &fakeState && record.payload == 42, "handle payload is wrong");
  Expect(pool.queueRelease(first), "handle could not be queued");
  Expect(!pool.queueRelease(first), "duplicate handle release was queued twice");
  Expect(!pool.resolve(first, &record), "queued handle remained publicly resolvable");
  uint32_t released = pool.drain([](const bridge::HandleRecord&) {});
  Expect(released == 1, "deferred release did not drain");
  Expect(!pool.resolve(first, &record), "stale handle resolved after recycle");
  const bridge::Handle second = pool.acquire(2, 9, &fakeState, 84);
  Expect(second.slot == first.slot && second.generation != first.generation, "generation did not advance on slot reuse");
  Expect(pool.release(second, [](const bridge::HandleRecord&) {}), "explicit release failed");
  Expect(pool.stats().live == 0 && pool.stats().queued == 0, "handle pool leaked a live slot");
}

void TestTimerTable() {
  bridge::TimerCallbackTable table(4);
  const bridge::Handle first{1, 1, 1, 1};
  const bridge::Handle second{1, 2, 1, 1};
  const bridge::Handle third{1, 3, 1, 1};
  const bridge::Handle fourth{1, 4, 1, 1};
  const bridge::Handle fifth{1, 5, 1, 1};

  // These keys share low hash bits at a power-of-two capacity and exercise
  // linear probing plus tombstone reuse without allocating.
  Expect(table.insert(1, first, false), "first colliding timer insert failed");
  Expect(table.insert(5, second, true), "second colliding timer insert failed");
  Expect(table.insert(9, third, false), "third colliding timer insert failed");
  Expect(table.insert(13, fourth, true), "fourth colliding timer insert failed");
  Expect(!table.insert(17, fifth, false), "full timer table did not report exhaustion");

  bridge::TimerCallbackRecord record;
  Expect(table.find(9, &record) && record.callback.slot == third.slot,
      "colliding timer lookup returned the wrong callback");
  Expect(table.erase(5, &record) && record.repeating,
      "timer erase lost callback metadata");
  Expect(table.insert(17, fifth, false), "timer tombstone was not reused");
  Expect(table.stats().size == 4 && table.stats().exhausted == 1,
      "timer table capacity statistics are wrong");
  Expect(table.sweep([](const bridge::TimerCallbackRecord&) {}) == 4,
      "timer table sweep count is wrong");
  Expect(table.stats().size == 0, "timer table sweep leaked entries");
}

}  // namespace

int main() {
  TestArena();
  TestHandles();
  TestTimerTable();

  AllocatorStats allocator;
  lua_State* state = lua_newstate(CountingAllocator, &allocator);
  Expect(state != nullptr, "unable to create Defold Lua state");
  luaL_openlibs(state);
  RegisterTimer(state);

  for (auto& reference : gTimerCallbacks) reference = LUA_NOREF;

  bridge::LuaBridge bridge(64 * 1024, 4096);
  CallbackStats callbackStats{&bridge.handles()};
  Expect(
      generated::initialize(bridge, state, bridge::LuaBridge::rawRegistryApi()),
      bridge.lastError());
  bridge.installCallbackApi({&callbackStats, InvokeCallback, ReleaseCallback});
  const int baseTop = lua_gettop(state);

  const bridge::Handle oneShot = bridge.handles().acquire(1, 1, state, 101);
  uint32_t oneShotTimer = 0;
  Expect(generated::timerDelay(
      bridge, DEHERM_VERIFY_TIMER_SCENARIO_DELAY, false, oneShot, &oneShotTimer), bridge.lastError());
  Expect(gLastDelay == DEHERM_VERIFY_TIMER_SCENARIO_DELAY && !gLastRepeating,
      "timer.delay reordered or changed its one-shot inputs");
  bool result = false;
  Expect(generated::timerTrigger(bridge, oneShotTimer, &result) && result, bridge.lastError());
  bridge::HandleRecord callbackRecord;
  Expect(!bridge.handles().resolve(oneShot, &callbackRecord), "one-shot callback was not released");
  Expect(callbackStats.invokes == 1 && callbackStats.releases == 1, "one-shot callback accounting is wrong");
  Expect(callbackStats.lastTimer == oneShotTimer &&
      callbackStats.lastElapsed == DEHERM_VERIFY_TIMER_SCENARIO_ELAPSED,
      "callback arguments are wrong");

  const bridge::Handle repeating = bridge.handles().acquire(1, 1, state, 202);
  uint32_t repeatingTimer = 0;
  Expect(generated::timerDelay(
      bridge, DEHERM_VERIFY_TIMER_SCENARIO_DELAY, true, repeating, &repeatingTimer), bridge.lastError());
  Expect(gLastDelay == DEHERM_VERIFY_TIMER_SCENARIO_DELAY && gLastRepeating,
      "timer.delay reordered or changed its repeating inputs");
  for (uint32_t index = 0; index < 1000; ++index) {
    Expect(generated::timerTrigger(bridge, repeatingTimer, &result) && result, bridge.lastError());
  }
  Expect(bridge.handles().resolve(repeating, &callbackRecord), "repeating callback was released too early");

  allocator.calls = allocator.allocations = allocator.frees = allocator.bytesRequested = 0;
  allocator.tracking = true;
  constexpr uint32_t kCallbackIterations = 100'000;
  const auto callbackStart = std::chrono::steady_clock::now();
  for (uint32_t index = 0; index < kCallbackIterations; ++index) {
    if (!generated::timerTrigger(bridge, repeatingTimer, &result) || !result) Fail(bridge.lastError());
  }
  const auto callbackElapsed = std::chrono::duration<double, std::nano>(
      std::chrono::steady_clock::now() - callbackStart).count();
  allocator.tracking = false;
  Expect(allocator.calls == 0, "steady-state callback bridge invoked the Lua allocator");
  Expect(generated::timerCancel(bridge, repeatingTimer, &result) && result, bridge.lastError());
  Expect(!bridge.handles().resolve(repeating, &callbackRecord), "cancel did not release repeating callback");

  for (uint32_t index = 0; index < 1000; ++index) {
    Expect(generated::timerCancel(bridge, index + 1, &result), bridge.lastError());
    Expect(result, "warm timer.cancel returned false");
  }
  Expect(lua_gettop(state) == baseTop, "warm calls leaked Lua stack slots");

  allocator.calls = allocator.allocations = allocator.frees = allocator.bytesRequested = 0;
  allocator.tracking = true;
  constexpr uint32_t kIterations = 1'000'000;
  const auto start = std::chrono::steady_clock::now();
  for (uint32_t index = 0; index < kIterations; ++index) {
    if (!generated::timerCancel(bridge, index + 1, &result) || !result) Fail(bridge.lastError());
  }
  const auto elapsed = std::chrono::duration<double, std::nano>(
      std::chrono::steady_clock::now() - start).count();
  allocator.tracking = false;

  Expect(lua_gettop(state) == baseTop, "hot calls leaked Lua stack slots");
  Expect(allocator.calls == 0, "steady-state primitive bridge invoked the Lua allocator");

  Expect(!generated::timerTrigger(bridge, UINT32_MAX, &result), "Lua error unexpectedly succeeded");
  Expect(std::strstr(bridge.lastError(), "synthetic timer failure") != nullptr, "Lua error text was not preserved");
  Expect(lua_gettop(state) == baseTop, "failed call leaked Lua stack slots");

  std::printf("lua-bridge:iterations:%u\n", kIterations);
  std::printf("lua-bridge:ns-per-call:%.1f\n", elapsed / kIterations);
  std::printf("lua-bridge:lua-allocator-calls:%llu\n", static_cast<unsigned long long>(allocator.calls));
  std::printf("lua-bridge:callback-iterations:%u\n", kCallbackIterations);
  std::printf("lua-bridge:callback-ns-per-call:%.1f\n", callbackElapsed / kCallbackIterations);
  std::printf("lua-bridge:ok\n");

  bridge.shutdown();
  lua_close(state);
  return 0;
}
