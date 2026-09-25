#include <defold_webtransport/client.h>
#include <deherm/webtransport/extension_bridge.hpp>

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string_view>
#include <thread>

namespace {

int nibble(const char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

bool parseDigest(const std::string_view source, std::array<std::uint8_t, 32>& digest) {
  if (source.size() != digest.size() * 2) return false;
  for (std::size_t index = 0; index < digest.size(); ++index) {
    const int high = nibble(source[index * 2]);
    const int low = nibble(source[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    digest[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return true;
}

struct Probe {
  bool ready = false;
  bool stream = false;
  bool stale_stream_rejected = false;
  bool destroyed_reentrantly = false;
  bool failed = false;
};

void onEvent(void* raw, const DefoldWebTransportEvent* event) {
  auto* probe = static_cast<Probe*>(raw);
  if (event->type == DEFOLD_WEBTRANSPORT_EVENT_READY) {
    probe->ready = true;
    probe->failed = !defold_webtransport_create_bidirectional_stream(event->session);
  } else if (event->type == DEFOLD_WEBTRANSPORT_EVENT_STREAM) {
    probe->stream = event->stream != nullptr && event->bidirectional && !event->incoming;
    defold_webtransport_stream_release(event->stream);
    probe->stale_stream_rejected = !defold_webtransport_stream_write(event->stream, {nullptr, 0}, false);
    // This is the important lifetime assertion: public callers may release a
    // session from inside its own callback. The adapter defers deletion until
    // the pump has unwound rather than freeing the active callback frame.
    defold_webtransport_destroy(event->session);
    probe->destroyed_reentrantly = true;
  } else if (event->type == DEFOLD_WEBTRANSPORT_EVENT_CLOSE && event->code != 0) {
    probe->failed = true;
  }
}

}  // namespace

int main(const int argc, char** argv) {
  if (argc != 3) return 64;
  std::array<std::uint8_t, 32> digest{};
  if (!parseDigest(argv[2], digest)) return 64;
  DefoldWebTransportCertificateHash hash{"sha-256", {digest.data(), digest.size()}};
  Probe probe;
  DefoldWebTransportOptions options{};
  options.abi_version = DEFOLD_WEBTRANSPORT_CLIENT_ABI_VERSION;
  options.struct_size = sizeof(options);
  options.url = argv[1];
  options.certificate_hashes = &hash;
  options.certificate_hash_count = 1;
  options.anticipated_incoming_unidirectional_streams = 64;
  options.anticipated_incoming_bidirectional_streams = 8;
  options.callback = onEvent;
  options.user_data = &probe;
  auto* session = defold_webtransport_connect(&options);
  if (session == nullptr) return 1;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!probe.destroyed_reentrantly && !probe.failed && std::chrono::steady_clock::now() < deadline) {
    (void)defold_webtransport_pump_callbacks();
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (!probe.destroyed_reentrantly) defold_webtransport_destroy(session);
  if (!probe.ready || !probe.stream || !probe.stale_stream_rejected || !probe.destroyed_reentrantly || probe.failed) return 1;
  std::printf("native-webtransport-public-api: ready, stream, stale handle rejection, reentrant destroy verified\n");
  return 0;
}
