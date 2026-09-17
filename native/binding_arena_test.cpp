#include <defold_hermes/binding_arena.hpp>

#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <type_traits>

namespace {

std::atomic<size_t> gHeapAllocations{0};

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "binding-arena:error:%s\n", message);
  std::abort();
}

void Expect(bool condition, const char* message) {
  if (!condition) Fail(message);
}

struct Vec3 {
  float x;
  float y;
  float z;
};

struct alignas(32) MatrixRow {
  float lanes[8];
};

using Arena = defold_hermes::binding::BindingArena<512, 64, true>;

static_assert(!std::is_copy_constructible<Arena>::value, "arena must not copy");
static_assert(!std::is_move_constructible<Arena>::value, "arena must not move");
static_assert(Arena::kCapacity == 512, "capacity must be compile-time data");

void TestAlignmentAndPodWrites() {
  Arena arena;
  const size_t heapBefore = gHeapAllocations.load(std::memory_order_relaxed);

  const uint8_t tag = 7;
  auto* storedTag = arena.writePod(tag);
  auto rows = arena.allocateSpan<MatrixRow>(2);
  const Vec3 source[] = {{1.0f, 2.0f, 3.0f}, {4.0f, 5.0f, 6.0f}};
  auto vectors = arena.writePodSpan(source, 2);

  Expect(storedTag && *storedTag == tag, "single POD write failed");
  Expect(rows && rows.size == 2, "typed span allocation failed");
  Expect(
      reinterpret_cast<uintptr_t>(rows.data) % alignof(MatrixRow) == 0,
      "typed span alignment is wrong");
  Expect(vectors && vectors[1].z == 6.0f, "POD span copy failed");
  Expect(arena.stats().allocations == 3, "allocation accounting is wrong");
  Expect(arena.stats().highWater == arena.stats().used, "high-water accounting is wrong");
  Expect(arena.healthy(), "fresh arena canary is corrupt");
  Expect(
      gHeapAllocations.load(std::memory_order_relaxed) == heapBefore,
      "arena operation allocated from the heap");
}

void TestNestedFramesAndRewind() {
  Arena arena;
  auto* permanent = arena.writePod(uint32_t{42});
  const auto outerMark = arena.mark();
  void* firstTemporary = nullptr;

  {
    Arena::Frame outer(arena);
    firstTemporary = arena.allocateBytes(48, 16);
    Expect(firstTemporary != nullptr, "outer frame allocation failed");
    const size_t outerUsed = arena.stats().used;
    {
      Arena::Frame inner(arena);
      Expect(arena.allocateBytes(80, 32) != nullptr, "inner frame allocation failed");
    }
    Expect(arena.stats().used == outerUsed, "inner frame did not rewind");
  }

  Expect(arena.stats().used == outerMark.offset(), "outer frame did not rewind");
  Expect(*permanent == 42, "rewind damaged earlier frame data");
  Expect(
      arena.allocateBytes(48, 16) == firstTemporary,
      "rewound storage was not reused deterministically");
  Expect(arena.stats().rewinds == 2, "nested rewind accounting is wrong");
}

void TestFailureIsAtomic() {
  Arena arena;
  Expect(arena.allocateBytes(17, 1) != nullptr, "setup allocation failed");
  const auto before = arena.stats().used;

  Expect(arena.allocateBytes(512, 1) == nullptr, "overflow unexpectedly succeeded");
  Expect(arena.lastError() == defold_hermes::binding::ArenaError::kOverflow,
      "overflow reported the wrong error");
  Expect(arena.stats().used == before, "overflow advanced the arena");

  Expect(arena.allocateBytes(1, 3) == nullptr, "invalid alignment unexpectedly succeeded");
  Expect(arena.lastError() == defold_hermes::binding::ArenaError::kInvalidAlignment,
      "invalid alignment reported the wrong error");
  Expect(arena.stats().used == before, "invalid alignment advanced the arena");

  Expect(arena.allocateBytes(1, 128) == nullptr, "unsupported alignment unexpectedly succeeded");
  Expect(arena.lastError() == defold_hermes::binding::ArenaError::kUnsupportedAlignment,
      "unsupported alignment reported the wrong error");
  Expect(arena.stats().used == before, "unsupported alignment advanced the arena");

  Arena other;
  Expect(!arena.rewind(other.mark()), "foreign mark unexpectedly rewound");
  Expect(arena.lastError() == defold_hermes::binding::ArenaError::kInvalidMark,
      "foreign mark reported the wrong error");
  Expect(arena.stats().used == before, "invalid rewind changed arena state");
  Expect(arena.writePodSpan<uint32_t>(nullptr, 1).data == nullptr,
      "null POD source unexpectedly succeeded");
  Expect(arena.lastError() == defold_hermes::binding::ArenaError::kNullInput,
      "null POD source reported the wrong error");
  Expect(arena.stats().failures == 5, "failure accounting is wrong");
  Expect(arena.healthy(), "failed operations damaged canary");
}

void TestZeroCapacityAndZeroLength() {
  defold_hermes::binding::BindingArena<0, 16, true> empty;
  auto zero = empty.allocateSpan<uint32_t>(0);
  Expect(zero.size == 0, "zero-length span has the wrong size");
  Expect(empty.stats().used == 0, "zero-length span consumed capacity");
  Expect(empty.allocateBytes(1) == nullptr, "zero-capacity allocation succeeded");
  Expect(empty.healthy(), "zero-capacity canary is corrupt");
}

}  // namespace

void* operator new(std::size_t size) {
  gHeapAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* value = std::malloc(size)) return value;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  gHeapAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* value = std::malloc(size)) return value;
  throw std::bad_alloc();
}

void* operator new(std::size_t size, std::align_val_t alignment) {
  gHeapAllocations.fetch_add(1, std::memory_order_relaxed);
  void* value = nullptr;
  if (posix_memalign(&value, static_cast<std::size_t>(alignment), size) == 0) return value;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size, std::align_val_t alignment) {
  return ::operator new(size, alignment);
}

void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }
void operator delete(void* value, std::align_val_t) noexcept { std::free(value); }
void operator delete[](void* value, std::align_val_t) noexcept { std::free(value); }
void operator delete(void* value, std::size_t, std::align_val_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t, std::align_val_t) noexcept { std::free(value); }

int main() {
  TestAlignmentAndPodWrites();
  TestNestedFramesAndRewind();
  TestFailureIsAtomic();
  TestZeroCapacityAndZeroLength();
  std::printf("binding-arena:ok\n");
  std::printf("binding-arena:heap-allocations:%zu\n", gHeapAllocations.load());
  return 0;
}
