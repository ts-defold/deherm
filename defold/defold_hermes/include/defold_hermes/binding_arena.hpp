#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <type_traits>

namespace defold_hermes::binding {

/** Minimal C++17 span used at the generated binding boundary. */
template <typename T>
struct Span {
  T* data = nullptr;
  size_t size = 0;

  T* begin() const { return data; }
  T* end() const { return data ? data + size : nullptr; }
  T& operator[](size_t index) const { return data[index]; }
  explicit operator bool() const { return data != nullptr; }
};

enum class ArenaError : uint8_t {
  kNone = 0,
  kOverflow,
  kInvalidAlignment,
  kUnsupportedAlignment,
  kInvalidMark,
  kNullInput,
  kCanaryCorrupt,
};

struct ArenaStats {
  size_t capacity = 0;
  size_t used = 0;
  size_t highWater = 0;
  uint64_t allocations = 0;
  uint64_t rewinds = 0;
  uint64_t failures = 0;
};

#if defined(NDEBUG)
inline constexpr bool kDefaultArenaDebugChecks = false;
#else
inline constexpr bool kDefaultArenaDebugChecks = true;
#endif

/**
 * Fixed-capacity, inline-storage arena for one generated binding call.
 *
 * The arena never allocates and never falls back to the heap. Typed APIs are
 * deliberately limited to trivial, standard-layout values: generated glue can
 * pack ABI records and arrays contiguously without owning destructor work.
 * StorageAlignment is the largest alignment the arena promises to satisfy.
 */
template <
    size_t Capacity,
    size_t StorageAlignment = alignof(std::max_align_t),
    bool DebugChecks = kDefaultArenaDebugChecks>
class BindingArena {
 public:
  static_assert(StorageAlignment != 0, "arena alignment must be non-zero");
  static_assert(
      (StorageAlignment & (StorageAlignment - 1)) == 0,
      "arena alignment must be a power of two");
  static_assert(
      Capacity <= std::numeric_limits<size_t>::max() - (DebugChecks ? 16 : 0),
      "arena storage size overflows size_t");

  static constexpr size_t kCapacity = Capacity;
  static constexpr size_t kStorageAlignment = StorageAlignment;
  static constexpr size_t kCanaryBytes = DebugChecks ? 16 : 0;

  class Mark {
   public:
    size_t offset() const noexcept { return offset_; }

   private:
    friend class BindingArena;
    Mark(size_t offset, const BindingArena* owner) noexcept
        : offset_(offset), owner_(owner) {}

    size_t offset_ = 0;
    const BindingArena* owner_ = nullptr;
  };

  class Frame {
   public:
    explicit Frame(BindingArena& arena) noexcept
        : arena_(&arena), mark_(arena.mark()) {}

    ~Frame() {
      if (arena_) arena_->rewind(mark_);
    }

    Frame(const Frame&) = delete;
    Frame& operator=(const Frame&) = delete;
    Frame(Frame&&) = delete;
    Frame& operator=(Frame&&) = delete;

    Mark mark() const { return mark_; }

   private:
    BindingArena* arena_;
    Mark mark_;
  };

  BindingArena() noexcept {
    stats_.capacity = Capacity;
    if constexpr (DebugChecks) {
      poison(0, Capacity, kUnusedPoison);
      writeCanary();
    }
  }

  BindingArena(const BindingArena&) = delete;
  BindingArena& operator=(const BindingArena&) = delete;
  BindingArena(BindingArena&&) = delete;
  BindingArena& operator=(BindingArena&&) = delete;

  Mark mark() const noexcept { return Mark(stats_.used, this); }

  /** Rewinds to a mark from this arena's current active prefix. */
  bool rewind(Mark target) noexcept {
    if (!checkCanary()) return fail(ArenaError::kCanaryCorrupt);
    if (target.owner_ != this || target.offset_ > stats_.used) {
      return fail(ArenaError::kInvalidMark);
    }
    if constexpr (DebugChecks) {
      poison(target.offset_, stats_.used - target.offset_, kRewoundPoison);
    }
    stats_.used = target.offset_;
    ++stats_.rewinds;
    lastError_ = ArenaError::kNone;
    return true;
  }

  bool reset() noexcept { return rewind(Mark(0, this)); }

  /** Allocates raw bytes at an explicit power-of-two alignment. */
  void* allocateBytes(size_t size, size_t alignment = 1) noexcept {
    if (!checkCanary()) {
      fail(ArenaError::kCanaryCorrupt);
      return nullptr;
    }
    if (alignment == 0 || (alignment & (alignment - 1)) != 0) {
      fail(ArenaError::kInvalidAlignment);
      return nullptr;
    }
    if (alignment > StorageAlignment) {
      fail(ArenaError::kUnsupportedAlignment);
      return nullptr;
    }

    const size_t mask = alignment - 1;
    if (stats_.used > std::numeric_limits<size_t>::max() - mask) {
      fail(ArenaError::kOverflow);
      return nullptr;
    }
    const size_t aligned = (stats_.used + mask) & ~mask;
    if (aligned > Capacity || size > Capacity - aligned) {
      fail(ArenaError::kOverflow);
      return nullptr;
    }

    std::byte* result = storage_.data();
    if (aligned != 0) result += aligned;
    stats_.used = aligned + size;
    if (stats_.used > stats_.highWater) stats_.highWater = stats_.used;
    ++stats_.allocations;
    lastError_ = ArenaError::kNone;
    return result;
  }

  /** Allocates and begins the lifetime of count uninitialized POD values. */
  template <typename T>
  Span<T> allocateSpan(size_t count) noexcept {
    requirePod<T>();
    static_assert(
        alignof(T) <= StorageAlignment,
        "increase BindingArena StorageAlignment for this type");
    if (count > std::numeric_limits<size_t>::max() / sizeof(T)) {
      fail(ArenaError::kOverflow);
      return {};
    }
    if (count == 0) return {};
    void* bytes = allocateBytes(sizeof(T) * count, alignof(T));
    if (!bytes) return {};
    T* values = static_cast<T*>(bytes);
    for (size_t index = 0; index < count; ++index) {
      ::new (static_cast<void*>(values + index)) T;
    }
    return {values, count};
  }

  /** Copies one POD value into the arena and returns its stable call-frame address. */
  template <typename T>
  T* writePod(const T& value) noexcept {
    requirePod<T>();
    auto destination = allocateSpan<T>(1);
    if (!destination.data) return nullptr;
    std::memcpy(destination.data, &value, sizeof(T));
    return destination.data;
  }

  /** Copies a POD array into one contiguous arena span. */
  template <typename T>
  Span<T> writePodSpan(const T* values, size_t count) noexcept {
    requirePod<T>();
    if (!values && count != 0) {
      fail(ArenaError::kNullInput);
      return {};
    }
    auto destination = allocateSpan<T>(count);
    if (!destination.data && count != 0) return {};
    if (count != 0) {
      std::memcpy(destination.data, values, sizeof(T) * count);
    }
    return destination;
  }

  const ArenaStats& stats() const noexcept { return stats_; }
  ArenaError lastError() const noexcept { return lastError_; }
  size_t remaining() const noexcept { return Capacity - stats_.used; }
  bool healthy() const noexcept { return checkCanary(); }

 private:
  template <typename T>
  static constexpr void requirePod() {
    static_assert(std::is_trivial<T>::value, "binding arena values must be trivial");
    static_assert(
        std::is_standard_layout<T>::value,
        "binding arena values must have standard layout");
  }

  bool fail(ArenaError error) noexcept {
    lastError_ = error;
    ++stats_.failures;
    return false;
  }

  void poison(size_t begin, size_t count, uint8_t value) noexcept {
    if (count != 0) std::memset(storage_.data() + begin, value, count);
  }

  void writeCanary() noexcept {
    if constexpr (DebugChecks) {
      for (size_t index = 0; index < kCanaryBytes; ++index) {
        storage_[Capacity + index] = static_cast<std::byte>(
            kCanarySeed ^ static_cast<uint8_t>(index * 29u));
      }
    }
  }

  bool checkCanary() const noexcept {
    if constexpr (DebugChecks) {
      for (size_t index = 0; index < kCanaryBytes; ++index) {
        const auto expected = static_cast<std::byte>(
            kCanarySeed ^ static_cast<uint8_t>(index * 29u));
        if (storage_[Capacity + index] != expected) return false;
      }
    }
    return true;
  }

  static constexpr uint8_t kUnusedPoison = 0xCD;
  static constexpr uint8_t kRewoundPoison = 0xDD;
  static constexpr uint8_t kCanarySeed = 0xA7;

  alignas(StorageAlignment)
      std::array<std::byte, Capacity + kCanaryBytes> storage_{};
  ArenaStats stats_{};
  ArenaError lastError_ = ArenaError::kNone;
};

}  // namespace defold_hermes::binding
