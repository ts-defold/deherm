#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace deherm::webtransport::detail {

inline constexpr std::uint64_t kCloseWebTransportSessionCapsule = 0x2843;
inline constexpr std::uint64_t kDrainWebTransportSessionCapsule = 0x78ae;
inline constexpr std::size_t kMaximumCloseReasonBytes = 255;

enum class ControlCapsuleKind : std::uint8_t { close, drain };

struct ControlCapsuleEvent {
  ControlCapsuleKind kind = ControlCapsuleKind::drain;
  std::uint32_t code = 0;
  std::array<std::uint8_t, kMaximumCloseReasonBytes> reason{};
  std::size_t reason_size = 0;
};

class ControlCapsuleParser final {
 public:
  template <typename Sink>
  bool feed(const std::uint8_t* bytes, const std::size_t size, const bool fin, Sink&& sink) noexcept {
    if ((size != 0 && bytes == nullptr) || malformed_) return false;
    for (std::size_t index = 0; index < size; ++index) {
      const auto byte = bytes[index];
      if (field_ != Field::payload) {
        if (!consumeVarint(byte)) return fail();
        if (pending_zero_length_event_ready_) {
          sink(pending_zero_length_event_);
          pending_zero_length_event_ready_ = false;
        }
        continue;
      }
      consumePayload(byte);
      if (payload_read_ == payload_length_) {
        ControlCapsuleEvent event;
        if (!complete(event)) return fail();
        if (event_ready_) sink(event);
        resetCapsule();
      }
    }
    if (fin && field_ != Field::type) return fail();
    return true;
  }

 private:
  enum class Field : std::uint8_t { type, length, payload };

  bool consumeVarint(const std::uint8_t byte) noexcept {
    if (header_read_ == 0) header_required_ = std::size_t{1} << (byte >> 6U);
    if (header_read_ >= header_.size() || header_required_ > header_.size()) return false;
    header_[header_read_++] = byte;
    if (header_read_ != header_required_) return true;
    std::uint64_t value = header_[0] & 0x3fU;
    for (std::size_t index = 1; index < header_required_; ++index) value = (value << 8U) | header_[index];
    header_read_ = 0;
    header_required_ = 0;
    if (field_ == Field::type) {
      capsule_type_ = value;
      field_ = Field::length;
    } else {
      payload_length_ = value;
      payload_read_ = 0;
      code_ = 0;
      reason_size_ = 0;
      field_ = Field::payload;
      if (payload_length_ == 0) {
        ControlCapsuleEvent event;
        if (!complete(event)) return false;
        if (event_ready_) {
          pending_zero_length_event_ = event;
          pending_zero_length_event_ready_ = true;
        }
        resetCapsule();
      }
    }
    return true;
  }

  void consumePayload(const std::uint8_t byte) noexcept {
    if (capsule_type_ == kCloseWebTransportSessionCapsule) {
      if (payload_read_ < 4) code_ = (code_ << 8U) | byte;
      else if (reason_size_ < reason_.size()) reason_[reason_size_++] = byte;
    }
    ++payload_read_;
  }

  bool complete(ControlCapsuleEvent& event) noexcept {
    event_ready_ = false;
    if (capsule_type_ == kCloseWebTransportSessionCapsule) {
      if (payload_length_ < 4) return false;
      event.kind = ControlCapsuleKind::close;
      event.code = code_;
      event.reason_size = reason_size_;
      std::copy_n(reason_.begin(), reason_size_, event.reason.begin());
      event_ready_ = true;
    } else if (capsule_type_ == kDrainWebTransportSessionCapsule) {
      if (payload_length_ != 0) return false;
      event.kind = ControlCapsuleKind::drain;
      event_ready_ = true;
    }
    return true;
  }

  void resetCapsule() noexcept {
    field_ = Field::type;
    capsule_type_ = 0;
    payload_length_ = 0;
    payload_read_ = 0;
    code_ = 0;
    reason_size_ = 0;
  }

  bool fail() noexcept {
    malformed_ = true;
    return false;
  }

  Field field_ = Field::type;
  std::array<std::uint8_t, 8> header_{};
  std::size_t header_read_ = 0;
  std::size_t header_required_ = 0;
  std::uint64_t capsule_type_ = 0;
  std::uint64_t payload_length_ = 0;
  std::uint64_t payload_read_ = 0;
  std::uint32_t code_ = 0;
  std::array<std::uint8_t, kMaximumCloseReasonBytes> reason_{};
  std::size_t reason_size_ = 0;
  bool event_ready_ = false;
  bool malformed_ = false;
  ControlCapsuleEvent pending_zero_length_event_{};
  bool pending_zero_length_event_ready_ = false;
};

enum class StreamCommandFailure : std::uint8_t { write, reset, stop_sending };

constexpr std::uint8_t streamFailureEventKind(const StreamCommandFailure failure) noexcept {
  // A failed write/reset terminates the local write half (STOP_SENDING-shaped
  // notification); a failed stop-sending terminates the read half
  // (RESET-shaped notification). Neither escalates to a session close.
  return failure == StreamCommandFailure::stop_sending ? 5U : 6U;
}

enum class ResetMode : std::uint8_t { plain, reliable };

constexpr ResetMode resetMode(const bool reset_stream_at_negotiated) noexcept {
  return reset_stream_at_negotiated ? ResetMode::reliable : ResetMode::plain;
}

}  // namespace deherm::webtransport::detail
