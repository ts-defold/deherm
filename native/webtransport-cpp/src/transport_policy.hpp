#pragma once

#include <deherm/webtransport/client.hpp>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <limits>
#include <utility>

namespace deherm::webtransport::detail {

inline constexpr std::uint32_t kMinimumIncomingStreamsPerDirection = 100;
inline constexpr std::uint64_t kH3WebTransportApplicationErrorFirst = 0x52e4a40fa8dbULL;
inline constexpr std::uint64_t kH3WebTransportApplicationErrorLast = 0x52e5ac983162ULL;

struct IncomingStreamCredits {
  std::uint32_t unidirectional = 0;
  std::uint32_t bidirectional = 0;
  bool valid = false;
};

constexpr IncomingStreamCredits incomingStreamCredits(const std::uint32_t requested_unidirectional,
                                                       const std::uint32_t requested_bidirectional) noexcept {
  if (requested_unidirectional > std::numeric_limits<std::uint16_t>::max() ||
      requested_bidirectional > std::numeric_limits<std::uint16_t>::max()) {
    return {};
  }
  const auto unidirectional = std::max(kMinimumIncomingStreamsPerDirection, requested_unidirectional);
  const auto bidirectional = std::max(kMinimumIncomingStreamsPerDirection, requested_bidirectional);
  if (static_cast<std::uint64_t>(unidirectional) + bidirectional > kMaximumConcurrentStreams) return {};
  return {unidirectional, bidirectional, true};
}

constexpr bool webTransportApplicationErrorToH3(const std::uint64_t application_error,
                                                std::uint64_t& h3_error) noexcept {
  if (application_error > std::numeric_limits<std::uint32_t>::max()) return false;
  h3_error = kH3WebTransportApplicationErrorFirst + application_error + application_error / 0x1eULL;
  return h3_error <= kH3WebTransportApplicationErrorLast;
}

constexpr bool h3ErrorToWebTransportApplicationError(const std::uint64_t h3_error,
                                                      std::uint32_t& application_error) noexcept {
  if (h3_error < kH3WebTransportApplicationErrorFirst || h3_error > kH3WebTransportApplicationErrorLast) {
    return false;
  }
  const auto shifted = h3_error - kH3WebTransportApplicationErrorFirst;
  // Every 31st HTTP/3 code is deliberately left as a grease/reserved gap.
  if (shifted % 0x1fULL == 0x1eULL) return false;
  const auto decoded = shifted - shifted / 0x1fULL;
  if (decoded > std::numeric_limits<std::uint32_t>::max()) return false;
  application_error = static_cast<std::uint32_t>(decoded);
  return true;
}

inline bool beginClosing(std::atomic<State>& state) noexcept {
  State observed = state.load(std::memory_order_acquire);
  while (observed != State::closing && observed != State::closed && observed != State::failed) {
    if (state.compare_exchange_weak(observed, State::closing, std::memory_order_acq_rel,
                                    std::memory_order_acquire)) {
      return true;
    }
  }
  return false;
}

template <typename Enqueue>
bool publishTerminalState(std::atomic<State>& state, const State terminal, Enqueue&& enqueue) noexcept {
  if (!std::forward<Enqueue>(enqueue)()) return false;
  state.store(terminal, std::memory_order_release);
  return true;
}

}  // namespace deherm::webtransport::detail
