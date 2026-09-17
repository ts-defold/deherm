#include <defold_hermes/scalar_lua_dispatch.hpp>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
#include <lua/lualib.h>
}

namespace scalar = defold_hermes::lua_bridge::scalar;
namespace generated = defold_hermes::lua_bridge::scalar::generated;

namespace {

std::atomic<bool> gTrackCppAllocations{false};
std::atomic<uint64_t> gCppAllocations{0};

struct LuaAllocatorStats {
  bool tracking = false;
  uint64_t calls = 0;
  uint64_t allocations = 0;
  uint64_t frees = 0;
  size_t liveBytes = 0;
  size_t peakBytes = 0;
};

void* CountingLuaAllocator(void* user, void* pointer, size_t oldSize, size_t newSize) {
  auto& stats = *static_cast<LuaAllocatorStats*>(user);
  if (stats.tracking) {
    ++stats.calls;
    if (!pointer && newSize != 0) ++stats.allocations;
    if (pointer && newSize == 0) ++stats.frees;
  }
  if (!newSize) {
    if (pointer) stats.liveBytes -= oldSize;
    std::free(pointer);
    return nullptr;
  }
  void* result = std::realloc(pointer, newSize);
  if (!result) return nullptr;
  if (pointer) stats.liveBytes -= oldSize;
  stats.liveBytes += newSize;
  if (stats.liveBytes > stats.peakBytes) stats.peakBytes = stats.liveBytes;
  return result;
}

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "scalar-lua-dispatch:error:%s\n", message);
  std::exit(1);
}

void Expect(bool condition, const char* message) {
  if (!condition) Fail(message);
}

int32_t gViewport[4]{};
uint64_t gViewportCalls = 0;

int MockSetViewport(lua_State* state) {
  for (int index = 0; index < 4; ++index) {
    gViewport[index] = static_cast<int32_t>(luaL_checkinteger(state, index + 1));
  }
  if (gViewport[0] == -999) return luaL_error(state, "synthetic viewport failure");
  ++gViewportCalls;
  return 0;
}

int MockGetConfigBoolean(lua_State* state) {
  size_t keySize = 0;
  const char* key = luaL_checklstring(state, 1, &keySize);
  bool fallback = false;
  if (!lua_isnone(state, 2)) {
    luaL_checktype(state, 2, LUA_TBOOLEAN);
    fallback = lua_toboolean(state, 2) != 0;
  }
  const bool configured = keySize == 13 && std::memcmp(key, "display.vsync", keySize) == 0;
  lua_pushboolean(state, configured ? 1 : (fallback ? 1 : 0));
  return 1;
}

int MockToHex(lua_State* state) {
  uint32_t bits = static_cast<uint32_t>(luaL_checknumber(state, 1));
  int digits = lua_isnone(state, 2) ? 8 : static_cast<int>(luaL_checknumber(state, 2));
  const char* alphabet = "0123456789abcdef";
  if (digits < 0) {
    digits = -digits;
    alphabet = "0123456789ABCDEF";
  }
  if (digits > 8) digits = 8;
  char output[8];
  for (int index = digits; --index >= 0;) {
    output[index] = alphabet[bits & 15u];
    bits >>= 4u;
  }
  lua_pushlstring(state, output, static_cast<size_t>(digits));
  return 1;
}

int MockGetHostname(lua_State* state) {
  lua_pushliteral(state, "mock-host");
  return 1;
}

void RegisterMocks(lua_State* state) {
  const luaL_Reg renderFunctions[] = {
    {"set_viewport", MockSetViewport},
    {nullptr, nullptr}
  };
  luaL_register(state, "render", renderFunctions);
  lua_pop(state, 1);

  const luaL_Reg sysFunctions[] = {
    {"get_config_boolean", MockGetConfigBoolean},
    {nullptr, nullptr}
  };
  luaL_register(state, "sys", sysFunctions);
  lua_pop(state, 1);

  const luaL_Reg bitFunctions[] = {
    {"tohex", MockToHex},
    {nullptr, nullptr}
  };
  luaL_register(state, "bit", bitFunctions);
  lua_pop(state, 1);

  lua_newtable(state);
  lua_newtable(state);
  lua_pushcfunction(state, MockGetHostname);
  lua_setfield(state, -2, "gethostname");
  lua_setfield(state, -2, "dns");
  lua_setglobal(state, "socket");
}

uint32_t Id(generated::BindingId id) {
  return static_cast<uint32_t>(id);
}

void TestDescriptors() {
  const auto& tables = scalar::generated::tables();
  Expect(tables.bindingCount == 90, "scalar descriptor count changed unexpectedly");
  Expect(tables.argumentCodecCount == 102, "scalar argument codec count changed unexpectedly");
  for (size_t index = 1; index < tables.bindingCount; ++index) {
    Expect(tables.stableIds[index - 1] < tables.stableIds[index], "stable IDs are not sorted or unique");
  }
}

}  // namespace

void* operator new(std::size_t size) {
  if (gTrackCppAllocations.load(std::memory_order_relaxed)) {
    gCppAllocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* pointer = std::malloc(size)) return pointer;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  return ::operator new(size);
}

void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete[](void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { std::free(pointer); }

int main() {
  TestDescriptors();

  LuaAllocatorStats luaAllocator;
  lua_State* state = lua_newstate(CountingLuaAllocator, &luaAllocator);
  Expect(state != nullptr, "unable to create pinned Defold Lua state");
  luaL_openlibs(state);
  RegisterMocks(state);
  const int baseTop = lua_gettop(state);

  scalar::Dispatcher dispatcher;
  Expect(dispatcher.initialize(state), dispatcher.lastError());
  Expect(dispatcher.bind(Id(generated::BindingId::RenderSetViewport)), dispatcher.lastError());
  Expect(dispatcher.bind(Id(generated::BindingId::SysGetConfigBoolean)), dispatcher.lastError());
  Expect(dispatcher.bind(Id(generated::BindingId::BitTohex)), dispatcher.lastError());
  Expect(dispatcher.bind(Id(generated::BindingId::SocketDnsGethostname)), dispatcher.lastError());
  Expect(dispatcher.stats().boundFunctions == 4, "bound function count is wrong");

  scalar::ScalarCallArena arena;
  {
    scalar::ScalarCallArena::Frame frame(arena);
    auto arguments = arena.allocateSpan<scalar::ScalarInput>(1);
    Expect(arguments.data != nullptr, "call arena could not stage config arguments");
    arguments[0] = scalar::ScalarInput::stringValue("display.vsync", 13);
    scalar::ScalarOutput result;
    Expect(dispatcher.dispatch(
        Id(generated::BindingId::SysGetConfigBoolean),
        {arguments.data, arguments.size}, &result), dispatcher.lastError());
    Expect(result.tag == scalar::ScalarTag::kBoolean && result.boolean, "boolean result was decoded incorrectly");
  }
  Expect(arena.stats().used == 0, "call arena frame did not rewind");

  {
    char text[8];
    scalar::ScalarOutput result;
    result.stringData = text;
    result.stringCapacity = sizeof(text);
    scalar::ScalarInput argument = scalar::ScalarInput::numberValue(0x21);
    Expect(dispatcher.dispatch(
        Id(generated::BindingId::BitTohex), {&argument, 1}, &result), dispatcher.lastError());
    Expect(result.tag == scalar::ScalarTag::kString && result.stringSize == 8,
        "optional bit.tohex call did not produce the source-validated default width");
    Expect(std::memcmp(text, "00000021", 8) == 0, "string result bytes are wrong");

    char tooSmall[2];
    result.stringData = tooSmall;
    result.stringCapacity = sizeof(tooSmall);
    Expect(!dispatcher.dispatch(Id(generated::BindingId::BitTohex), {&argument, 1}, &result),
        "undersized string buffer unexpectedly succeeded");
    Expect(result.stringSize == 8, "undersized string buffer did not report required bytes");
    Expect(lua_gettop(state) == baseTop, "string decode failure leaked Lua stack slots");
  }

  {
    char text[16];
    scalar::ScalarOutput result;
    result.stringData = text;
    result.stringCapacity = sizeof(text);
    Expect(dispatcher.dispatch(Id(generated::BindingId::SocketDnsGethostname), {}, &result),
        dispatcher.lastError());
    Expect(result.stringSize == 9 && std::memcmp(text, "mock-host", 9) == 0,
        "nested module function was not resolved correctly");
  }

  // Warm every value and Lua stack path before turning on allocation counters.
  for (uint32_t index = 0; index < 1000; ++index) {
    scalar::ScalarCallArena::Frame frame(arena);
    auto arguments = arena.allocateSpan<scalar::ScalarInput>(4);
    Expect(arguments.data != nullptr, "call arena was exhausted during warmup");
    arguments[0] = scalar::ScalarInput::integerValue(index & 127u);
    arguments[1] = scalar::ScalarInput::integerValue(2);
    arguments[2] = scalar::ScalarInput::integerValue(640);
    arguments[3] = scalar::ScalarInput::integerValue(480);
    Expect(dispatcher.dispatch(
        Id(generated::BindingId::RenderSetViewport), {arguments.data, arguments.size}),
        dispatcher.lastError());
  }

  luaAllocator.calls = luaAllocator.allocations = luaAllocator.frees = 0;
  gCppAllocations.store(0, std::memory_order_relaxed);
  luaAllocator.tracking = true;
  gTrackCppAllocations.store(true, std::memory_order_relaxed);
  constexpr uint32_t kIterations = 500'000;
  const auto start = std::chrono::steady_clock::now();
  for (uint32_t index = 0; index < kIterations; ++index) {
    scalar::ScalarCallArena::Frame frame(arena);
    auto arguments = arena.allocateSpan<scalar::ScalarInput>(4);
    if (!arguments.data) Fail("call arena exhausted on the hot path");
    arguments[0] = scalar::ScalarInput::integerValue(index & 127u);
    arguments[1] = scalar::ScalarInput::integerValue(2);
    arguments[2] = scalar::ScalarInput::integerValue(640);
    arguments[3] = scalar::ScalarInput::integerValue(480);
    if (!dispatcher.dispatch(
        Id(generated::BindingId::RenderSetViewport), {arguments.data, arguments.size})) {
      Fail(dispatcher.lastError());
    }
  }
  const double elapsedNs = std::chrono::duration<double, std::nano>(
      std::chrono::steady_clock::now() - start).count();
  gTrackCppAllocations.store(false, std::memory_order_relaxed);
  luaAllocator.tracking = false;

  Expect(luaAllocator.calls == 0, "warmed numeric dispatch invoked the Lua allocator");
  Expect(gCppAllocations.load(std::memory_order_relaxed) == 0,
      "warmed numeric dispatch invoked C++ operator new");
  Expect(arena.stats().used == 0, "hot call frames leaked arena bytes");
  Expect(lua_gettop(state) == baseTop, "hot dispatch leaked Lua stack slots");

  {
    scalar::ScalarInput wrong = scalar::ScalarInput::numberValue(1.0);
    Expect(!dispatcher.dispatch(Id(generated::BindingId::RenderSetViewport), {&wrong, 1}),
        "wrong arity/tag unexpectedly reached Lua");
    Expect(lua_gettop(state) == baseTop, "preflight failure changed the Lua stack");
  }
  {
    scalar::ScalarInput arguments[] = {
      scalar::ScalarInput::integerValue(-999),
      scalar::ScalarInput::integerValue(0),
      scalar::ScalarInput::integerValue(1),
      scalar::ScalarInput::integerValue(1)
    };
    Expect(!dispatcher.dispatch(Id(generated::BindingId::RenderSetViewport), {arguments, 4}),
        "synthetic Lua error unexpectedly succeeded");
    Expect(std::strstr(dispatcher.lastError(), "synthetic viewport failure") != nullptr,
        "Lua error text was not preserved");
    Expect(lua_gettop(state) == baseTop, "failed Lua dispatch leaked stack slots");
  }

  const uint64_t expectedCalls = kIterations + 1000;
  Expect(gViewportCalls == expectedCalls, "mock viewport call accounting is wrong");
  Expect(dispatcher.stats().calls >= expectedCalls, "dispatcher call accounting is wrong");

  std::printf("scalar-lua-dispatch:bindings:%zu\n", scalar::generated::tables().bindingCount);
  std::printf("scalar-lua-dispatch:iterations:%u\n", kIterations);
  std::printf("scalar-lua-dispatch:ns-per-call:%.1f\n", elapsedNs / kIterations);
  std::printf("scalar-lua-dispatch:lua-allocator-calls:%llu\n",
      static_cast<unsigned long long>(luaAllocator.calls));
  std::printf("scalar-lua-dispatch:cpp-allocations:%llu\n",
      static_cast<unsigned long long>(gCppAllocations.load(std::memory_order_relaxed)));

  dispatcher.shutdown();
  lua_close(state);
  Expect(luaAllocator.liveBytes == 0, "pinned Defold Lua state leaked allocator bytes");
  std::printf("scalar-lua-dispatch:ok\n");
  return 0;
}
