#include <deherm/webtransport/client.hpp>
#include <defold_webtransport/client.h>

#include "url.hpp"
#include "native_v1_internal.hpp"
#include "bounded_payload_ring.hpp"
#include "control_capsule_parser.hpp"
#include "local_close.hpp"
#include "transport_policy.hpp"

#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdint>
#include <string>

using deherm::webtransport::Client;
using deherm::webtransport::Options;
using deherm::webtransport::detail::ParsedUrl;
using deherm::webtransport::detail::parseHttpsUrl;
using deherm::webtransport::detail::NativeStreamRegistry;
using deherm::webtransport::detail::openedStreamFlags;

namespace {
void ignorePublicEvent(void*, const DefoldWebTransportEvent*) {}
}

int main() {
  static_assert(deherm::webtransport::kDescriptorCapacity == 256);
  static_assert(deherm::webtransport::kCommandByteCapacity == 256 * 1024);
  static_assert(deherm::webtransport::kEventByteCapacity == 256 * 1024);
  assert(Client::fixedStorageBytes() < 640 * 1024);
  std::printf("native-webtransport-fixed-session-bytes:%zu\n", Client::fixedStorageBytes());

  ParsedUrl url;
  assert(parseHttpsUrl("https://localhost", url));
  assert(url.host == "localhost");
  assert(url.authority == "localhost");
  assert(url.port == 443);
  assert(url.path == "/");

  assert(parseHttpsUrl("https://example.test:4433/war-battles?seat=1", url));
  assert(url.host == "example.test");
  assert(url.authority == "example.test:4433");
  assert(url.port == 4433);
  assert(url.path == "/war-battles?seat=1");

  assert(parseHttpsUrl("https://[::1]:9443/session", url));
  assert(url.host == "::1");
  assert(url.authority == "[::1]:9443");
  assert(url.port == 9443);
  assert(url.path == "/session");

  assert(!parseHttpsUrl("http://localhost:4433", url));
  assert(!parseHttpsUrl("https://", url));
  assert(!parseHttpsUrl("https://host:0", url));
  assert(!parseHttpsUrl("https://host:70000", url));
  assert(!parseHttpsUrl("https://user@host/", url));
  assert(!parseHttpsUrl("https://::1:443/", url));
  assert(!parseHttpsUrl("https://host/path#fragment", url));

  // CLOSE_WEBTRANSPORT_SESSION is control-plane data, including when capsule
  // headers and payloads are fragmented across network callbacks.
  deherm::webtransport::detail::ControlCapsuleParser capsules;
  const std::array<std::uint8_t, 10> close_capsule{
      0x68, 0x43, 0x07, 0x01, 0x02, 0x03, 0x04, 'b', 'y', 'e'};
  bool close_seen = false;
  auto on_capsule = [&](const deherm::webtransport::detail::ControlCapsuleEvent& event) {
    assert(event.kind == deherm::webtransport::detail::ControlCapsuleKind::close);
    assert(event.code == 0x01020304U);
    assert(event.reason_size == 3);
    assert(event.reason[0] == 'b' && event.reason[1] == 'y' && event.reason[2] == 'e');
    close_seen = true;
  };
  assert(capsules.feed(close_capsule.data(), 1, false, on_capsule));
  assert(capsules.feed(close_capsule.data() + 1, 3, false, on_capsule));
  assert(capsules.feed(close_capsule.data() + 4, close_capsule.size() - 4, true, on_capsule));
  assert(close_seen);

  // The packet loop must own the close reason beyond the command scratch
  // lifetime. The first deadline preserves a capsule delivery window; the
  // second bounds the HTTP/3 no-error fallback.
  deherm::webtransport::detail::LocalClose local_close;
  {
    std::string temporary_reason = "known-close-reason";
    local_close.begin(1, temporary_reason, 1'000);
    temporary_reason.assign(temporary_reason.size(), 'x');
  }
  assert(local_close.pending() && local_close.capsuleQueued());
  assert(local_close.code() == 1 && local_close.reason() == "known-close-reason");
  assert(local_close.constrainDelay(1'000, 9'000'000) ==
         static_cast<std::int64_t>(deherm::webtransport::detail::kLocalCloseCapsuleGraceMicroseconds));
  assert(!local_close.deadlineReached(1'000 + deherm::webtransport::detail::kLocalCloseCapsuleGraceMicroseconds - 1));
  assert(local_close.deadlineReached(1'000 + deherm::webtransport::detail::kLocalCloseCapsuleGraceMicroseconds));
  assert(!local_close.observeBacklog(true, 2'000));
  assert(!local_close.observeBacklog(false, 2'000));
  assert(local_close.observeBacklog(true, 2'000));
  assert(local_close.capsuleAcknowledged());
  assert(local_close.constrainDelay(2'000, 1'000'000) ==
         static_cast<std::int64_t>(deherm::webtransport::detail::kLocalCloseCapsuleAckGraceMicroseconds));
  local_close.beginFallback(3'000'000);
  assert(local_close.fallbackStarted());
  assert(local_close.constrainDelay(3'000'000, 1'000'000) ==
         static_cast<std::int64_t>(deherm::webtransport::detail::kLocalCloseFallbackGraceMicroseconds));

  deherm::webtransport::detail::ControlCapsuleParser malformed_capsule;
  const std::array<std::uint8_t, 6> short_close{0x68, 0x43, 0x03, 1, 2, 3};
  assert(!malformed_capsule.feed(short_close.data(), short_close.size(), true, on_capsule));

  struct RingRecord { std::size_t size = 0; std::uint32_t value = 0; };
  deherm::webtransport::detail::BoundedPayloadRing<RingRecord, 4, 16> saturated;
  const std::array<std::uint8_t, 4> payload{1, 2, 3, 4};
  for (std::uint32_t value = 1; value <= 3; ++value) {
    assert(saturated.push({payload.size(), value}, payload.data(), 1, payload.size()));
  }
  assert(!saturated.push({payload.size(), 4}, payload.data(), 1, payload.size()));
  // The reserved terminal descriptor and bytes remain deliverable.
  assert(saturated.push({payload.size(), 99}, payload.data()));
  RingRecord record;
  std::array<std::uint8_t, 4> copied{};
  for (std::uint32_t value = 1; value <= 3; ++value) {
    assert(saturated.pop(record, copied.data(), copied.size()));
    assert(record.value == value);
  }
  assert(saturated.pop(record, copied.data(), copied.size()) && record.value == 99);

  // Reserved-byte arithmetic must fail before subtracting. The previous
  // unsigned expression wrapped when existing bytes exceeded the post-reserve
  // capacity and admitted an entry that violated the terminal reservation.
  deherm::webtransport::detail::BoundedPayloadRing<RingRecord, 4, 16> accounting;
  const std::array<std::uint8_t, 12> twelve_bytes{};
  assert(accounting.push({twelve_bytes.size(), 1}, twelve_bytes.data()));
  assert(!accounting.push({0, 2}, nullptr, 0, 8));
  assert(!accounting.peek(record, nullptr, twelve_bytes.size()));

  // A normal 255-chunk burst fits without consuming the terminal slot.
  deherm::webtransport::detail::BoundedPayloadRing<RingRecord, 256, 256> burst;
  const std::array<std::uint8_t, 1> one_byte{7};
  for (std::uint32_t index = 0; index < 255; ++index) {
    assert(burst.push({1, index}, one_byte.data(), 1, 1));
  }
  assert(!burst.push({1, 255}, one_byte.data(), 1, 1));
  assert(burst.push({1, 999}, one_byte.data()));

  const auto baseline_credits = deherm::webtransport::detail::incomingStreamCredits(0, 0);
  assert(baseline_credits.valid && baseline_credits.unidirectional == 100 && baseline_credits.bidirectional == 100);
  const auto full_credits = deherm::webtransport::detail::incomingStreamCredits(128, 128);
  assert(full_credits.valid && full_credits.unidirectional + full_credits.bidirectional == 256);
  assert(!deherm::webtransport::detail::incomingStreamCredits(129, 128).valid);
  assert(!deherm::webtransport::detail::incomingStreamCredits(UINT16_MAX + 1U, 0).valid);

  std::uint64_t h3_error = 0;
  std::uint32_t application_error = 0;
  assert(deherm::webtransport::detail::webTransportApplicationErrorToH3(0, h3_error));
  assert(h3_error == deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst);
  assert(deherm::webtransport::detail::webTransportApplicationErrorToH3(29, h3_error));
  assert(h3_error == deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst + 29);
  assert(deherm::webtransport::detail::webTransportApplicationErrorToH3(30, h3_error));
  assert(h3_error == deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst + 31);
  assert(deherm::webtransport::detail::webTransportApplicationErrorToH3(UINT32_MAX, h3_error));
  assert(h3_error == deherm::webtransport::detail::kH3WebTransportApplicationErrorLast);
  assert(!deherm::webtransport::detail::webTransportApplicationErrorToH3(UINT64_C(1) << 32, h3_error));
  assert(deherm::webtransport::detail::h3ErrorToWebTransportApplicationError(
      deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst, application_error));
  assert(application_error == 0);
  assert(!deherm::webtransport::detail::h3ErrorToWebTransportApplicationError(
      deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst + 30, application_error));
  assert(!deherm::webtransport::detail::h3ErrorToWebTransportApplicationError(
      deherm::webtransport::detail::kH3WebTransportApplicationErrorFirst - 1, application_error));
  assert(deherm::webtransport::detail::h3ErrorToWebTransportApplicationError(
      deherm::webtransport::detail::kH3WebTransportApplicationErrorLast, application_error));
  assert(application_error == UINT32_MAX);

  std::atomic<deherm::webtransport::State> closing_state{deherm::webtransport::State::ready};
  assert(deherm::webtransport::detail::beginClosing(closing_state));
  assert(closing_state.load() == deherm::webtransport::State::closing);
  bool enqueued_before_terminal = false;
  assert(deherm::webtransport::detail::publishTerminalState(
      closing_state, deherm::webtransport::State::closed, [&] {
        enqueued_before_terminal = closing_state.load() == deherm::webtransport::State::closing;
        return true;
      }));
  assert(enqueued_before_terminal && closing_state.load() == deherm::webtransport::State::closed);
  assert(!deherm::webtransport::detail::beginClosing(closing_state));
  assert(closing_state.load() == deherm::webtransport::State::closed);
  std::atomic<deherm::webtransport::State> failed_state{deherm::webtransport::State::failed};
  assert(!deherm::webtransport::detail::beginClosing(failed_state));
  assert(failed_state.load() == deherm::webtransport::State::failed);
  std::atomic<deherm::webtransport::State> unpublished_state{deherm::webtransport::State::ready};
  assert(!deherm::webtransport::detail::publishTerminalState(
      unpublished_state, deherm::webtransport::State::failed, [] { return false; }));
  assert(unpublished_state.load() == deherm::webtransport::State::ready);

  using deherm::webtransport::detail::ResetMode;
  using deherm::webtransport::detail::StreamCommandFailure;
  assert(deherm::webtransport::detail::resetMode(false) == ResetMode::plain);
  assert(deherm::webtransport::detail::resetMode(true) == ResetMode::reliable);
  assert(deherm::webtransport::detail::streamFailureEventKind(StreamCommandFailure::write) == 6);
  assert(deherm::webtransport::detail::streamFailureEventKind(StreamCommandFailure::reset) == 6);
  assert(deherm::webtransport::detail::streamFailureEventKind(StreamCommandFailure::stop_sending) == 5);
  assert(!deherm::webtransport::detail::isPeerInitiatedStream(4));
  assert(deherm::webtransport::detail::isPeerInitiatedStream(5));
  assert(!deherm::webtransport::detail::shouldAcquireUnknownDataStream(4));
  assert(deherm::webtransport::detail::shouldAcquireUnknownDataStream(5));

  // The exact native_v1 stream-open mapping distinguishes correlated local
  // opens from both forms of remotely-created streams.
  assert(openedStreamFlags(77, true) == DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL);
  assert(openedStreamFlags(0, false) == DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_INCOMING);
  assert(openedStreamFlags(0, true) == (DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_INCOMING |
                                       DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL));

  // Slots bound concurrency, not lifetime. Sequential terminal streams reuse
  // storage while monotonic handles keep stale handles from aliasing.
  NativeStreamRegistry<256> registry;
  std::uint32_t previous_handle = 0;
  for (std::uint64_t index = 1; index <= 512; ++index) {
    auto* stream = registry.acquire(index, false, false);
    assert(stream != nullptr && stream->read_terminal && !stream->write_terminal);
    assert(stream->handle != previous_handle);
    previous_handle = stream->handle;
    stream->write_terminal = true;
    registry.retireIfTerminal(stream);
    assert(registry.byHandle(previous_handle) == nullptr);
  }
  NativeStreamRegistry<256> baseline_registry;
  for (std::uint64_t index = 1; index <= 100; ++index) {
    assert(baseline_registry.acquire(index * 4 + 1, true, true) != nullptr);
    assert(baseline_registry.acquire(index * 4 + 3, false, true) != nullptr);
  }

  // Poll poison must be consumed so a queued terminal close behind either
  // registry exhaustion or an oversized request id remains reachable.
  struct PollRecord { std::size_t size = 0; std::uint64_t stream_id = 0; std::uint64_t request_id = 0; };
  deherm::webtransport::detail::BoundedPayloadRing<PollRecord, 4, 4> poll_ring;
  NativeStreamRegistry<1> full_registry;
  assert(full_registry.acquire(1, true, true));
  assert(poll_ring.push({0, 5, 1}, nullptr));
  assert(poll_ring.push({0, 0, 0}, nullptr));
  PollRecord poll_head;
  std::array<std::uint8_t, 1> poll_bytes{};
  assert(poll_ring.peek(poll_head, poll_bytes.data(), poll_bytes.size()));
  assert(full_registry.acquire(poll_head.stream_id, true, true) == nullptr);
  assert(poll_ring.discard());
  assert(poll_ring.pop(poll_head, poll_bytes.data(), poll_bytes.size()));
  assert(poll_head.stream_id == 0);

  deherm::webtransport::detail::BoundedPayloadRing<PollRecord, 4, 4> request_ring;
  assert(request_ring.push({0, 9, UINT64_C(1) << 32}, nullptr));
  assert(request_ring.push({0, 0, 0}, nullptr));
  assert(request_ring.peek(poll_head, poll_bytes.data(), poll_bytes.size()));
  assert(poll_head.request_id > UINT32_MAX);
  assert(request_ring.discard());
  assert(request_ring.pop(poll_head, poll_bytes.data(), poll_bytes.size()));
  assert(poll_head.request_id == 0);

  Options no_trust{};
  no_trust.url = "https://localhost:4433";
  assert(Client::open(no_trust) == nullptr);

  Options bad_scheme{};
  bad_scheme.url = "ws://localhost:4433";
  bad_scheme.has_certificate_sha256 = true;
  assert(Client::open(bad_scheme) == nullptr);

  Options invalid_hint{};
  invalid_hint.url = "https://localhost:4433";
  invalid_hint.anticipated_incoming_unidirectional_streams = UINT16_MAX + 1U;
  invalid_hint.has_certificate_sha256 = true;
  assert(Client::open(invalid_hint) == nullptr);

  DefoldWebTransportOptions null_hashes{};
  null_hashes.abi_version = DEFOLD_WEBTRANSPORT_CLIENT_ABI_VERSION;
  null_hashes.struct_size = sizeof(null_hashes);
  null_hashes.url = "https://localhost:4433";
  null_hashes.certificate_hash_count = 1;
  null_hashes.certificate_hashes = nullptr;
  null_hashes.callback = ignorePublicEvent;
  assert(defold_webtransport_connect(&null_hashes) == nullptr);
  return 0;
}
