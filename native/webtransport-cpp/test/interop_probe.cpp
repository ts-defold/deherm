#include <deherm/webtransport/client.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <unordered_map>
#include <vector>
#include <string_view>
#include <thread>

namespace wt = deherm::webtransport;

namespace {

int nibble(const char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

bool parseDigest(const std::string_view source, std::array<std::uint8_t, wt::kCertificateSha256Bytes>& digest) {
  if (source.size() != digest.size() * 2) return false;
  for (std::size_t index = 0; index < digest.size(); ++index) {
    const int high = nibble(source[index * 2]);
    const int low = nibble(source[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    digest[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return true;
}

void write16(std::uint8_t* target, const std::uint16_t value) {
  target[0] = static_cast<std::uint8_t>(value);
  target[1] = static_cast<std::uint8_t>(value >> 8U);
}

void write32(std::uint8_t* target, const std::uint32_t value) {
  target[0] = static_cast<std::uint8_t>(value);
  target[1] = static_cast<std::uint8_t>(value >> 8U);
  target[2] = static_cast<std::uint8_t>(value >> 16U);
  target[3] = static_cast<std::uint8_t>(value >> 24U);
}

std::uint32_t read32(const std::uint8_t* source) {
  return static_cast<std::uint32_t>(source[0]) | (static_cast<std::uint32_t>(source[1]) << 8U) |
         (static_cast<std::uint32_t>(source[2]) << 16U) | (static_cast<std::uint32_t>(source[3]) << 24U);
}

std::uint16_t checksum(const std::uint8_t* bytes, const std::size_t size) {
  std::uint16_t first = 0xff;
  std::uint16_t second = 0xff;
  for (std::size_t index = 0; index < size; ++index) {
    first = static_cast<std::uint16_t>((first + bytes[index]) % 255);
    second = static_cast<std::uint16_t>((second + first) % 255);
  }
  return static_cast<std::uint16_t>((second << 8U) | first);
}

std::vector<std::uint8_t> reliableFrame(const std::uint8_t channel, const std::uint8_t kind,
                                        const std::size_t payload_size) {
  std::vector<std::uint8_t> frame(5 + payload_size);
  frame[0] = channel;
  write32(frame.data() + 1, static_cast<std::uint32_t>(payload_size));
  write16(frame.data() + 5, 0x5743);
  frame[7] = 8;
  frame[8] = kind;
  return frame;
}

}  // namespace

int main(const int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: %s https://host:port/path certificate-sha256-hex\n", argv[0]);
    return 64;
  }

  wt::Options options{.url = argv[1], .has_certificate_sha256 = true};
  if (!parseDigest(argv[2], options.certificate_sha256)) {
    std::fprintf(stderr, "certificate SHA-256 must be exactly 64 hexadecimal characters\n");
    return 64;
  }

  auto client = wt::Client::open(options);
  if (client == nullptr) {
    std::fprintf(stderr, "native-webtransport-probe:open-failed\n");
    return 1;
  }

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  wt::Event event;
  bool ready = false;
  while (std::chrono::steady_clock::now() < deadline && !ready) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::ready) ready = true;
      if (event.kind == wt::EventKind::close) {
        std::fprintf(stderr, "native-webtransport-probe:closed-before-ready:code=%llu:%.*s\n",
                     static_cast<unsigned long long>(event.code), static_cast<int>(event.size), event.bytes.data());
        return 1;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (!ready) {
    std::fprintf(stderr, "native-webtransport-probe:ready-timeout\n");
    return 1;
  }

  constexpr std::uint64_t kOpenRequest = 1;
  const auto open_result = client->openBidirectionalStream(kOpenRequest);
  std::uint64_t stream_id = 0;
  const auto stream_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < stream_deadline && stream_id == 0) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::stream_opened && event.request_id == kOpenRequest) {
        stream_id = event.stream_id;
      }
      if (event.kind == wt::EventKind::close) {
        std::fprintf(stderr, "native-webtransport-probe:closed-before-stream:code=%llu:%.*s\n",
                     static_cast<unsigned long long>(event.code), static_cast<int>(event.size), event.bytes.data());
        return 1;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (stream_id == 0) {
    std::fprintf(stderr, "native-webtransport-probe:stream-timeout:open=%u\n", static_cast<unsigned>(open_result));
    return 1;
  }

  // Interoperability fixture only: the transport stays protocol-agnostic, but
  // the probe performs the War Battles hello/ack so the authoritative server
  // can verify that subsequent QUIC datagrams reached the game receiver.
  auto hello = reliableFrame(1, 1, 68);
  write32(hello.data() + 9, 0xdecafbadU);
  constexpr std::string_view name = "native-picoquic";
  std::copy(name.begin(), name.end(), hello.begin() + 13);
  const auto reliable_result = client->writeStream(stream_id, hello.data(), hello.size(), true);

  std::unordered_map<std::uint64_t, std::vector<std::uint8_t>> incoming;
  std::vector<std::uint8_t> welcome;
  const auto welcome_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (std::chrono::steady_clock::now() < welcome_deadline && welcome.empty()) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::stream_data) {
        auto& bytes = incoming[event.stream_id];
        bytes.insert(bytes.end(), event.bytes.begin(), event.bytes.begin() + event.size);
        if (bytes.size() >= 9 && bytes.size() == 5 + read32(bytes.data() + 1) && bytes[0] == 1 && bytes[7] == 8 &&
            bytes[8] == 2) {
          welcome = bytes;
        }
      } else if (event.kind == wt::EventKind::close) {
        std::fprintf(stderr, "native-webtransport-probe:closed-before-welcome:code=%llu:%.*s\n",
                     static_cast<unsigned long long>(event.code), static_cast<int>(event.size), event.bytes.data());
        return 1;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (welcome.size() < 66) {
    std::fprintf(stderr, "native-webtransport-probe:welcome-timeout\n");
    return 1;
  }
  const std::uint32_t match_id = read32(welcome.data() + 9);
  const std::uint8_t player_id = welcome[13];
  const std::uint32_t server_tick = read32(welcome.data() + 21);

  constexpr std::uint64_t kAckRequest = 2;
  if (client->openBidirectionalStream(kAckRequest) != wt::SendResult::sent) return 1;
  std::uint64_t ack_stream_id = 0;
  const auto ack_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < ack_deadline && ack_stream_id == 0) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::stream_opened && event.request_id == kAckRequest) ack_stream_id = event.stream_id;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (ack_stream_id == 0) return 1;
  auto ack = reliableFrame(1, 8, 44);
  std::copy(welcome.begin() + 25, welcome.begin() + 65, ack.begin() + 9);
  if (client->writeStream(ack_stream_id, ack.data(), ack.size(), true) != wt::SendResult::sent) return 1;
  std::this_thread::sleep_for(std::chrono::milliseconds(30));

  // Invalid per-stream commands are isolated to their stream. They produce a
  // terminal half-stream event and must not tear down the WebTransport session.
  constexpr std::uint64_t kMissingWriteStream = 0x100000;
  constexpr std::uint64_t kMissingResetStream = 0x100004;
  constexpr std::uint64_t kMissingStopStream = 0x100008;
  if (client->writeStream(kMissingWriteStream, nullptr, 0, false) != wt::SendResult::sent ||
      client->resetStream(kMissingResetStream, 0x52) != wt::SendResult::sent ||
      client->stopSending(kMissingStopStream, 0x53) != wt::SendResult::sent) {
    return 1;
  }
  bool write_failure = false;
  bool reset_failure = false;
  bool stop_failure = false;
  const auto failure_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < failure_deadline &&
         !(write_failure && reset_failure && stop_failure)) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::close) return 1;
      write_failure |= event.kind == wt::EventKind::stream_stop_sending && event.stream_id == kMissingWriteStream;
      reset_failure |= event.kind == wt::EventKind::stream_stop_sending && event.stream_id == kMissingResetStream;
      stop_failure |= event.kind == wt::EventKind::stream_reset && event.stream_id == kMissingStopStream;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (!(write_failure && reset_failure && stop_failure) || client->state() != wt::State::ready) return 1;

  std::array<std::uint8_t, 32> datagram{};
  write16(datagram.data(), 0x5742);
  datagram[2] = 8;
  datagram[3] = 1;
  write32(datagram.data() + 4, match_id);
  datagram[8] = player_id;
  datagram[12] = 127;
  datagram[14] = 255;
  wt::SendResult datagram_result = wt::SendResult::closed;
  for (std::uint16_t sequence = 1; sequence <= 3; ++sequence) {
    // Leave enough headroom for the welcome/ack round trip while staying well
    // inside the authoritative world's bounded future-input window.
    write32(datagram.data() + 16, server_tick + 30U + sequence);
    write16(datagram.data() + 20, sequence);
    write16(datagram.data() + 30, checksum(datagram.data(), 30));
    do {
      datagram_result = client->trySendDatagram(datagram.data(), datagram.size());
      if (datagram_result == wt::SendResult::backpressured) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    } while (datagram_result == wt::SendResult::backpressured);
    if (datagram_result != wt::SendResult::sent) return 1;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }

  // Deno 2.9 does not negotiate RESET_STREAM_AT. The fallback must put a
  // plain RESET_STREAM on the wire. This game server deliberately closes a
  // player session when any gameplay stream is reset, providing real receiver
  // evidence that the plain fallback reached the peer. Deno currently closes
  // the QUIC session directly on this application error; the capsule parser is
  // therefore covered by the focused fragmented-input test, not this probe.
  constexpr std::uint64_t kResetRequest = 3;
  if (client->openBidirectionalStream(kResetRequest) != wt::SendResult::sent) return 1;
  std::uint64_t reset_stream_id = 0;
  const auto reset_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < reset_deadline && reset_stream_id == 0) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::stream_opened && event.request_id == kResetRequest) {
        reset_stream_id = event.stream_id;
      } else if (event.kind == wt::EventKind::close) {
        return 1;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (reset_stream_id == 0 || client->resetStream(reset_stream_id, 0x51) != wt::SendResult::sent) return 1;
  bool peer_close_seen = false;
  const auto close_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < close_deadline && !peer_close_seen) {
    while (client->poll(event)) {
      if (event.kind == wt::EventKind::close) {
        peer_close_seen = true;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (!peer_close_seen || client->state() != wt::State::closed) return 1;
  std::printf("native-webtransport-probe:ready:max-datagram=%zu:open=%u:stream=%llu:reliable=%u:isolated-errors=3:reset=plain:peer-close=graceful:datagram=%u:player=%u\n",
              client->maximumDatagramBytes(), static_cast<unsigned>(open_result),
              static_cast<unsigned long long>(stream_id), static_cast<unsigned>(reliable_result),
              static_cast<unsigned>(datagram_result), static_cast<unsigned>(player_id));
  return reliable_result == wt::SendResult::sent && datagram_result == wt::SendResult::sent ? 0 : 1;
}
