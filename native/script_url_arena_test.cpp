#include <defold_hermes/script_url_arena.hpp>
#include <dmsdk/dlib/message.h>

#include <cstddef>
#include <new>
#include <cstdlib>
#include <iostream>

size_t allocationCount = 0;

void* operator new(std::size_t size) {
  ++allocationCount;
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  ++allocationCount;
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {

using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptAddressRepresentation;
using defold_hermes::ScriptResolvedUrl;
using defold_hermes::ScriptUrlArena;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

static_assert(sizeof(dmMessage::URL) == 32, "pinned Defold dmMessage::URL ABI changed");
static_assert(sizeof(dmMessage::HSocket) == sizeof(uint64_t));
static_assert(sizeof(dmhash_t) == sizeof(uint64_t));
static_assert(offsetof(dmMessage::URL, m_Socket) == offsetof(ScriptResolvedUrl, socket));
static_assert(offsetof(dmMessage::URL, _reserved) == offsetof(ScriptResolvedUrl, reserved));
static_assert(offsetof(dmMessage::URL, m_Path) == offsetof(ScriptResolvedUrl, path));
static_assert(offsetof(dmMessage::URL, m_Fragment) == offsetof(ScriptResolvedUrl, fragment));

void expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  {
    ScriptUrlArena<1> warm(1);
    ScriptValue token{};
    ScriptResolvedUrl resolved{};
    ScriptUrlArena<1>::Frame frame(warm);
    expect(warm.store(1, 2, 3, &token) && warm.resolve(token, 1, &resolved), "URL arena warmup failed");
  }
  const size_t allocationBaseline = allocationCount;
  for (uint32_t iteration = 0; iteration < 1024; ++iteration) {
    ScriptUrlArena<1> measured(99);
    ScriptValue token{};
    ScriptResolvedUrl resolved{};
    ScriptUrlArena<1>::Frame frame(measured);
    expect(measured.store(iteration, iteration + 1, iteration + 2, &token), "measured URL store failed");
    expect(measured.resolve(token, 99, &resolved), "measured URL resolve failed");
  }
  expect(allocationCount == allocationBaseline, "warmed URL arena loop allocated on the heap");
  ScriptUrlArena<2> arena(7);
  ScriptValue first{};
  expect(arena.store(0x1111111111111111ULL, 0x2222222222222222ULL,
    0x3333333333333333ULL, &first), "could not store exact URL");
  ScriptResolvedUrl decoded{};
  expect(arena.resolve(first, 7, &decoded), "could not resolve exact URL token");
  expect(decoded.socket == 0x1111111111111111ULL && decoded.path == 0x2222222222222222ULL &&
    decoded.fragment == 0x3333333333333333ULL, "URL component was narrowed or reordered");

  ScriptValue collapsed{};
  collapsed.tag = ScriptValueTag::kHandle;
  collapsed.handleKind = ScriptHandleKind::kUrl;
  collapsed.length = 7;
  collapsed.payload = 0x1111111111111111ULL;
  expect(ScriptUrlArena<2>::representation(collapsed) == ScriptAddressRepresentation::kInvalid,
    "legacy single-u64 URL was classified as a full URL");
  expect(!arena.resolve(collapsed, 7, &decoded), "legacy single-u64 URL did not fail closed");
  expect(!arena.resolve(first, 8, &decoded), "cross-runtime URL token was accepted");

  ScriptUrlArena<2> other(7);
  expect(!other.resolve(first, 7, &decoded), "cross-arena URL token was accepted");

  ScriptValue stale{};
  {
    ScriptUrlArena<2>::Frame outer(arena);
    expect(arena.store(4, 5, 6, &stale), "nested store failed");
    expect(arena.resolve(stale, 7, &decoded), "nested URL token was not live");
  }
  expect(!arena.resolve(stale, 7, &decoded), "rewound nested URL token remained live");
  expect(arena.resolve(first, 7, &decoded), "outer URL token was invalidated by nested rewind");

  ScriptValue second{};
  expect(arena.store(4, 5, 6, &second), "second URL store failed");
  ScriptValue exhausted{};
  expect(!arena.store(7, 8, 9, &exhausted), "URL arena unexpectedly fell back after exhaustion");
  expect(arena.exhaustionCount() == 1, "URL arena exhaustion was not deterministic/countable");

  dmMessage::URL luaResult;
  luaResult.m_Socket = 0xffffffffffffffffULL;
  luaResult._reserved = 0x13579bdf2468ace0ULL;
  luaResult.m_Path = 0x8000000000000001ULL;
  luaResult.m_Fragment = 0xabcdef0123456789ULL;
  ScriptUrlArena<2> resultArena(12);
  ScriptValue copied{};
  expect(resultArena.copyBeforeLuaPop(luaResult, &copied), "copy-before-pop capture failed");
  luaResult = dmMessage::URL{};
  dmMessage::URL pushed;
  expect(resultArena.copyForPushUrl(copied, 12, &pushed), "PushURL copy failed");
  expect(pushed.m_Socket == 0xffffffffffffffffULL && pushed._reserved == 0x13579bdf2468ace0ULL &&
    pushed.m_Path == 0x8000000000000001ULL &&
    pushed.m_Fragment == 0xabcdef0123456789ULL, "copy-before-pop did not own exact URL bits");

  expect(resultArena.resetRuntime(13), "runtime reset failed");
  expect(!resultArena.resolve(copied, 12, &decoded), "pre-reset URL token survived runtime reset");
  expect(!resultArena.resolve(copied, 13, &decoded), "stale URL token was rebound to new runtime");
  expect(!resultArena.resetRuntime(0), "zero runtime token was accepted");

  ScriptValue stringShorthand{};
  stringShorthand.tag = ScriptValueTag::kString;
  stringShorthand.data = "#sprite";
  stringShorthand.length = 7;
  expect(ScriptUrlArena<2>::representation(stringShorthand) ==
    ScriptAddressRepresentation::kStringShorthand, "string shorthand was collapsed into URL storage");
  ScriptValue hashShorthand{};
  hashShorthand.tag = ScriptValueTag::kHandle;
  hashShorthand.handleKind = ScriptHandleKind::kHash;
  hashShorthand.payload = 0xfedcba9876543210ULL;
  expect(ScriptUrlArena<2>::representation(hashShorthand) ==
    ScriptAddressRepresentation::kHashShorthand, "hash shorthand was collapsed into URL storage");
  expect(allocationCount == allocationBaseline, "URL arena operation allocated on the heap");

  std::cout << "script-url-arena:ok allocations:0\n";
  return 0;
}
