#pragma once

#include <defold_webtransport/native_v1.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace deherm::webtransport::detail {

struct NativeStream {
  std::uint64_t id = 0;
  std::uint32_t handle = 0;
  bool occupied = false;
  bool announced = false;
  bool read_terminal = false;
  bool write_terminal = false;
};

template <std::size_t Capacity>
class NativeStreamRegistry final {
 public:
  NativeStream* byHandle(const std::uint32_t handle) noexcept {
    if (handle == 0) return nullptr;
    for (auto& stream : streams_) if (stream.occupied && stream.handle == handle) return &stream;
    return nullptr;
  }

  NativeStream* byId(const std::uint64_t id) noexcept {
    for (auto& stream : streams_) if (stream.occupied && stream.id == id) return &stream;
    return nullptr;
  }

  NativeStream* acquire(const std::uint64_t id, const bool bidirectional, const bool incoming) noexcept {
    if (auto* existing = byId(id)) return existing;
    for (auto& stream : streams_) {
      if (!stream.occupied) {
        std::uint32_t candidate = next_handle_;
        for (;;) {
          if (++next_handle_ == 0) next_handle_ = 1;
          if (!byHandle(candidate)) break;
          candidate = next_handle_;
        }
        stream = {};
        stream.id = id;
        stream.handle = candidate;
        stream.occupied = true;
        stream.read_terminal = !bidirectional && !incoming;
        stream.write_terminal = !bidirectional && incoming;
        return &stream;
      }
    }
    return nullptr;
  }

  void retireIfTerminal(NativeStream* stream) noexcept {
    if (stream && stream->read_terminal && stream->write_terminal) *stream = {};
  }

  void clear() noexcept {
    streams_ = {};
    next_handle_ = 1;
  }

 private:
  std::array<NativeStream, Capacity> streams_{};
  std::uint32_t next_handle_ = 1;
};

constexpr std::uint32_t openedStreamFlags(const std::uint64_t request_id, const bool bidirectional) noexcept {
  return (bidirectional ? DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL : 0U) |
         (request_id == 0 ? DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_INCOMING : 0U);
}

constexpr bool isPeerInitiatedStream(const std::uint64_t stream_id) noexcept {
  return (stream_id & 1U) != 0;
}

constexpr bool shouldAcquireUnknownDataStream(const std::uint64_t stream_id) noexcept {
  // Only a peer-initiated stream can first appear as data. A locally-initiated
  // stream whose registry entry is gone is a late callback for a retired
  // handle; consuming it is safer than resurrecting a stale public stream.
  return isPeerInitiatedStream(stream_id);
}

}  // namespace deherm::webtransport::detail
