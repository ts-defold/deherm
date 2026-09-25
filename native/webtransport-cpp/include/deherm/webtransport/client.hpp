#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>

namespace deherm::webtransport {

inline constexpr std::size_t kCertificateSha256Bytes = 32;
inline constexpr std::size_t kMaximumReliableBytes = 64 * 1024;
inline constexpr std::size_t kMaximumDatagramBytes = 64 * 1024;
inline constexpr std::size_t kDescriptorCapacity = 256;
inline constexpr std::size_t kCommandByteCapacity = 256 * 1024;
inline constexpr std::size_t kEventByteCapacity = 256 * 1024;
// WebTransport user agents must initially permit at least 100 incoming streams
// in each direction. 256 slots preserve that baseline with bounded storage.
inline constexpr std::size_t kMaximumConcurrentStreams = 256;

enum class State : std::uint8_t {
  opening,
  ready,
  closing,
  closed,
  failed,
};

enum class SendResult : std::uint8_t {
  sent,
  backpressured,
  too_large,
  closed,
};

enum class EventKind : std::uint8_t {
  ready = 1,
  stream_opened = 2,
  stream_data = 3,
  datagram = 4,
  stream_reset = 5,
  stream_stop_sending = 6,
  close = 7,
};

struct Options {
  std::string_view url;
  std::uint32_t anticipated_incoming_unidirectional_streams = 0;
  std::uint32_t anticipated_incoming_bidirectional_streams = 0;
  std::array<std::uint8_t, kCertificateSha256Bytes> certificate_sha256{};
  bool has_certificate_sha256 = false;
  // A PEM trust file is the production alternative to a development pin.
  // One of the two trust mechanisms is mandatory; verification never fails open.
  std::string_view root_trust_file;
};

struct Event {
  EventKind kind = EventKind::close;
  // request_id correlates an asynchronous local stream-open event with the
  // caller request.  Remote streams have request_id == 0.
  std::uint64_t request_id = 0;
  std::uint64_t stream_id = 0;
  bool bidirectional = false;
  bool fin = false;
  std::uint64_t code = 0;
  std::size_t size = 0;
  std::array<std::uint8_t, kMaximumReliableBytes> bytes{};
};

class Client final {
 public:
  static std::unique_ptr<Client> open(const Options& options);
  static std::size_t fixedStorageBytes() noexcept;

  ~Client();
  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;

  State state() const noexcept;
  std::size_t maximumDatagramBytes() const noexcept;

  SendResult openBidirectionalStream(std::uint64_t request_id) noexcept;
  SendResult openUnidirectionalStream(std::uint64_t request_id) noexcept;
  SendResult writeStream(std::uint64_t stream_id, const std::uint8_t* bytes, std::size_t size,
                         bool fin) noexcept;
  SendResult resetStream(std::uint64_t stream_id, std::uint64_t code) noexcept;
  SendResult stopSending(std::uint64_t stream_id, std::uint64_t code) noexcept;
  SendResult trySendDatagram(const std::uint8_t* bytes, std::size_t size) noexcept;
  bool peek(Event& event) noexcept;
  bool consume() noexcept;
  bool poll(Event& event) noexcept;
  void close(std::uint32_t code, std::string_view reason) noexcept;
  void fail(std::string_view reason) noexcept;

 private:
  class Impl;
  explicit Client(std::unique_ptr<Impl> impl) noexcept;
  std::unique_ptr<Impl> impl_;
};

}  // namespace deherm::webtransport
