#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace deherm::webtransport::detail {

inline constexpr std::size_t kLocalCloseReasonCapacity = 255;
inline constexpr std::uint64_t kLocalCloseCapsuleGraceMicroseconds = 2'000'000;
inline constexpr std::uint64_t kLocalCloseCapsuleAckGraceMicroseconds = 250'000;
inline constexpr std::uint64_t kLocalCloseFallbackGraceMicroseconds = 250'000;

enum class LocalClosePhase : std::uint8_t { inactive, capsule_queued, capsule_acknowledged, fallback_started };

// The packet loop outlives the command scratch buffer. Own the reason until
// the capsule has had a bounded delivery window and the containing HTTP/3
// connection's NO_ERROR close has had a send opportunity.
class LocalClose final {
 public:
  void begin(const std::uint32_t code, const std::string_view reason, const std::uint64_t now) noexcept {
    code_ = code;
    reason_size_ = std::min(reason.size(), reason_.size() - 1);
    std::copy_n(reason.data(), reason_size_, reason_.data());
    reason_[reason_size_] = '\0';
    deadline_ = now + kLocalCloseCapsuleGraceMicroseconds;
    backlog_observed_ = false;
    phase_ = LocalClosePhase::capsule_queued;
  }

  bool pending() const noexcept { return phase_ != LocalClosePhase::inactive; }
  bool capsuleQueued() const noexcept { return phase_ == LocalClosePhase::capsule_queued; }
  bool capsuleAcknowledged() const noexcept { return phase_ == LocalClosePhase::capsule_acknowledged; }
  bool fallbackStarted() const noexcept { return phase_ == LocalClosePhase::fallback_started; }
  bool deadlineReached(const std::uint64_t now) const noexcept { return pending() && now >= deadline_; }

  bool observeBacklog(const bool empty, const std::uint64_t now) noexcept {
    if (!capsuleQueued()) return false;
    if (!empty) backlog_observed_ = true;
    if (!empty || !backlog_observed_) return false;
    phase_ = LocalClosePhase::capsule_acknowledged;
    deadline_ = now + kLocalCloseCapsuleAckGraceMicroseconds;
    return true;
  }

  void beginFallback(const std::uint64_t now) noexcept {
    phase_ = LocalClosePhase::fallback_started;
    deadline_ = now + kLocalCloseFallbackGraceMicroseconds;
  }

  std::int64_t constrainDelay(const std::uint64_t now, const std::int64_t proposed) const noexcept {
    if (!pending() || deadline_ <= now) return pending() ? 0 : proposed;
    const auto remaining = deadline_ - now;
    const auto bounded = remaining > static_cast<std::uint64_t>(INT64_MAX)
                             ? INT64_MAX
                             : static_cast<std::int64_t>(remaining);
    return proposed < bounded ? proposed : bounded;
  }

  std::uint32_t code() const noexcept { return code_; }
  const char* reasonCString() const noexcept { return reason_.data(); }
  std::string_view reason() const noexcept { return {reason_.data(), reason_size_}; }

 private:
  LocalClosePhase phase_ = LocalClosePhase::inactive;
  std::uint32_t code_ = 0;
  std::uint64_t deadline_ = 0;
  std::array<char, kLocalCloseReasonCapacity + 1> reason_{};
  std::size_t reason_size_ = 0;
  bool backlog_observed_ = false;
};

}  // namespace deherm::webtransport::detail
