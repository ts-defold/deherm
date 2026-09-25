#include <defold_hermes/native_module_provider.h>
#include <defold_hermes/runtime.hpp>
#include <defold_webtransport/native_v1.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_webtransport_facade_exact();
extern "C" int32_t deherm_register_native_web_transport_provider_v1(void);

namespace {
struct Recording {
  uint32_t poll_count = 0;
  uint32_t request = 0;
  bool datagram_written = false;
  bool stream_written = false;
  bool stream_opened_delivered = false;
  bool close_delivered = false;
  uint32_t destroys = 0;
};
Recording* g_recording = nullptr;
uint32_t g_stage = 0;
uint32_t g_mismatches = UINT32_MAX;

void u32le(uint8_t* output, uint32_t value) {
  output[0] = static_cast<uint8_t>(value);
  output[1] = static_cast<uint8_t>(value >> 8);
  output[2] = static_cast<uint8_t>(value >> 16);
  output[3] = static_cast<uint8_t>(value >> 24);
}
void event(uint8_t* output, uint32_t kind, uint32_t flags = 0, int32_t code = 0,
           uint32_t request = 0, uint32_t stream = 0,
           const uint8_t* payload = nullptr, uint32_t payload_length = 0) {
  std::memset(output, 0, DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES + payload_length);
  u32le(output, kind); u32le(output + 4, flags); u32le(output + 8, static_cast<uint32_t>(code));
  u32le(output + 12, request); u32le(output + 16, stream); u32le(output + 20, payload_length);
  u32le(output + 28, DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_VERSION);
  if (payload_length) std::memcpy(output + DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES, payload, payload_length);
}
class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string& message) override {
    constexpr char prefix[] = "static-webtransport-facade-evidence:";
    if (message.rfind(prefix, 0) == 0) {
      g_stage = 5;
      g_mismatches = static_cast<uint32_t>(std::stoul(message.substr(sizeof(prefix) - 1)));
    }
  }
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};
}  // namespace

extern "C" uint32_t defold_webtransport_native_v1_open(
    const char* url, uint32_t url_length, const uint8_t* certificate, uint32_t certificate_length,
    uint32_t anticipated_unidirectional, uint32_t anticipated_bidirectional) {
  const char expected[] = "https://host/game/\xe2\x9c\x93";
  if (!url || url_length != sizeof(expected) - 1 || std::memcmp(url, expected, sizeof(expected) - 1) != 0 ||
      !certificate || certificate_length != 32 || anticipated_unidirectional != 64 || anticipated_bidirectional != 8) return 0;
  for (uint32_t index = 0; index < 32; ++index) if (certificate[index] != index) return 0;
  return 73;
}
extern "C" uint32_t defold_webtransport_native_v1_state(uint32_t handle) {
  return handle == 73 ? (g_recording->close_delivered ? DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CLOSED
                                                      : DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CONNECTED)
                      : DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_FAILED;
}
extern "C" uint32_t defold_webtransport_native_v1_max_datagram_bytes(uint32_t handle) { return handle == 73 ? 1200 : 0; }
extern "C" int32_t defold_webtransport_native_v1_open_bidirectional_stream(uint32_t handle, uint32_t request) {
  if (handle != 73 || request == 0) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  g_recording->request = request; return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" int32_t defold_webtransport_native_v1_open_unidirectional_stream(uint32_t, uint32_t) { return -100; }
extern "C" int32_t defold_webtransport_native_v1_write_stream(
    uint32_t handle, uint32_t stream, const uint8_t* bytes, uint32_t length, bool fin) {
  if (handle != 73 || stream != 91 || !bytes || length != 2 || bytes[0] != 4 || bytes[1] != 3 || fin)
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  g_recording->stream_written = true; return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" int32_t defold_webtransport_native_v1_reset_stream(uint32_t, uint32_t, uint32_t) { return -101; }
extern "C" int32_t defold_webtransport_native_v1_stop_sending(uint32_t, uint32_t, uint32_t) { return -102; }
extern "C" int32_t defold_webtransport_native_v1_try_send_datagram(uint32_t handle, const uint8_t* bytes, uint32_t length) {
  if (handle != 73 || !bytes || length != 3 || bytes[0] != 9 || bytes[1] != 8 || bytes[2] != 7)
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  g_recording->datagram_written = true; return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" int32_t defold_webtransport_native_v1_poll(uint32_t handle, uint8_t* output, uint32_t length) {
  if (handle != 73 || !output || length < DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES)
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  ++g_recording->poll_count;
  if (g_recording->poll_count == 1) {
    event(output, DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_READY); return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
  }
  if (g_recording->poll_count == 2) {
    const uint8_t payload[] = {5, 6, 7}; event(output, DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_DATAGRAM, 0, 0, 0, 0, payload, 3);
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
  }
  if (g_recording->request && !g_recording->stream_opened_delivered) {
    g_recording->stream_opened_delivered = true;
    event(output, DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_OPENED,
          DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL, 0, g_recording->request, 91);
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
  }
  if (g_recording->datagram_written && g_recording->stream_written && !g_recording->close_delivered) {
    const uint8_t reason[] = {'d', 'o', 'n', 'e'}; g_recording->close_delivered = true;
    event(output, DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_CLOSE, 0, 44, 0, 0, reason, 4);
    return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
  }
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_NO_EVENT;
}
extern "C" int32_t defold_webtransport_native_v1_close(uint32_t, uint32_t, const char*, uint32_t) { return 0; }
extern "C" int32_t defold_webtransport_native_v1_destroy(uint32_t handle) {
  if (handle != 73) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  ++g_recording->destroys; return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
int main() {
  try {
    Recording recording; g_recording = &recording;
    if (deherm_register_native_web_transport_provider_v1() != DEHERM_NATIVE_MODULE_REGISTRY_OK)
      throw std::runtime_error("provider registration failed");
    Host host; defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_webtransport_facade_exact,
    };
    runtime.loadStatic(units, 1, "defold-hermes://static-webtransport-facade-exact");
    runtime.init();
    for (uint32_t frame = 0; frame < 16 && g_stage != 5; ++frame) {
      runtime.pumpNativeModules(1.0 / 60.0);
      runtime.update(1.0 / 60.0);
    }
    if (g_stage != 5 || g_mismatches != 0 || !recording.datagram_written || !recording.stream_written ||
        !recording.close_delivered || recording.destroys != 1)
      throw std::runtime_error("high-level Static WebTransport facade evidence mismatch: stage=" +
        std::to_string(g_stage) + " mismatches=" + std::to_string(g_mismatches) +
        " poll=" + std::to_string(recording.poll_count) + " request=" + std::to_string(recording.request) +
        " datagram=" + std::to_string(recording.datagram_written) + " stream=" + std::to_string(recording.stream_written) +
        " close=" + std::to_string(recording.close_delivered) + " destroy=" + std::to_string(recording.destroys));
    if (deherm_native_module_unregister_v1("NativeWebTransport") != 0)
      throw std::runtime_error("provider unregister failed");
    std::puts("static-webtransport-facade:ready,closed,datagram-read-write,bidi-write:ok");
    return 0;
  } catch (const std::exception& error) {
    deherm_native_module_unregister_v1("NativeWebTransport");
    std::fprintf(stderr, "static-webtransport-facade:error:%s\n", error.what());
    return 1;
  }
}
