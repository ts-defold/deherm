#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace deherm::webtransport::detail {

template <typename T, std::size_t EntryCapacity, std::size_t ByteCapacity>
class BoundedPayloadRing final {
 public:
  static_assert(EntryCapacity > 0);
  static_assert(ByteCapacity > 0);

  bool push(const T& source, const std::uint8_t* bytes,
            const std::size_t reserved_entries = 0,
            const std::size_t reserved_bytes = 0) noexcept {
    std::lock_guard lock(mutex_);
    if (reserved_entries > EntryCapacity || reserved_bytes > ByteCapacity ||
        entry_size_ >= EntryCapacity - reserved_entries ||
        byte_size_ > ByteCapacity - reserved_bytes ||
        source.size > ByteCapacity - reserved_bytes - byte_size_ ||
        (source.size != 0 && bytes == nullptr)) {
      return false;
    }
    slots_[entry_tail_] = source;
    entry_tail_ = (entry_tail_ + 1) % EntryCapacity;
    ++entry_size_;
    copyInto(bytes, source.size);
    return true;
  }

  bool pop(T& target, std::uint8_t* bytes, const std::size_t capacity) noexcept {
    std::lock_guard lock(mutex_);
    if (entry_size_ == 0 || slots_[entry_head_].size > capacity ||
        (slots_[entry_head_].size != 0 && bytes == nullptr)) return false;
    target = slots_[entry_head_];
    entry_head_ = (entry_head_ + 1) % EntryCapacity;
    --entry_size_;
    copyOut(bytes, target.size);
    return true;
  }

  bool peek(T& target, std::uint8_t* bytes, const std::size_t capacity) noexcept {
    std::lock_guard lock(mutex_);
    if (entry_size_ == 0 || slots_[entry_head_].size > capacity ||
        (slots_[entry_head_].size != 0 && bytes == nullptr)) return false;
    target = slots_[entry_head_];
    copyPeek(bytes, target.size);
    return true;
  }

  bool discard() noexcept {
    std::lock_guard lock(mutex_);
    if (entry_size_ == 0) return false;
    const std::size_t size = slots_[entry_head_].size;
    entry_head_ = (entry_head_ + 1) % EntryCapacity;
    --entry_size_;
    byte_head_ = (byte_head_ + size) % ByteCapacity;
    byte_size_ -= size;
    return true;
  }

 private:
  void copyInto(const std::uint8_t* source, const std::size_t size) noexcept {
    if (size == 0) return;
    const auto first = std::min(size, ByteCapacity - byte_tail_);
    std::memcpy(bytes_.data() + byte_tail_, source, first);
    if (size > first) std::memcpy(bytes_.data(), source + first, size - first);
    byte_tail_ = (byte_tail_ + size) % ByteCapacity;
    byte_size_ += size;
  }

  void copyOut(std::uint8_t* target, const std::size_t size) noexcept {
    if (size == 0) return;
    const auto first = std::min(size, ByteCapacity - byte_head_);
    std::memcpy(target, bytes_.data() + byte_head_, first);
    if (size > first) std::memcpy(target + first, bytes_.data(), size - first);
    byte_head_ = (byte_head_ + size) % ByteCapacity;
    byte_size_ -= size;
  }

  void copyPeek(std::uint8_t* target, const std::size_t size) const noexcept {
    if (size == 0) return;
    const auto first = std::min(size, ByteCapacity - byte_head_);
    std::memcpy(target, bytes_.data() + byte_head_, first);
    if (size > first) std::memcpy(target + first, bytes_.data(), size - first);
  }

  std::array<T, EntryCapacity> slots_{};
  std::array<std::uint8_t, ByteCapacity> bytes_{};
  std::size_t entry_head_ = 0;
  std::size_t entry_tail_ = 0;
  std::size_t entry_size_ = 0;
  std::size_t byte_head_ = 0;
  std::size_t byte_tail_ = 0;
  std::size_t byte_size_ = 0;
  std::mutex mutex_;
};

}  // namespace deherm::webtransport::detail
