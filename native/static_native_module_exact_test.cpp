#include <defold_hermes/native_module_provider.h>
#include <defold_hermes/runtime.hpp>
#include <defold_webtransport/deherm_provider.h>
#include <defold_webtransport/native_v1.h>

#include "deherm_static_native_web_transport.h"
#include "static_native_module_exact_fixture.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_native_module_exact();
extern "C" int32_t deherm_register_native_web_transport_provider_v1(void);

namespace {
struct Recording {
  std::array<uint32_t, 13> calls{};
  bool reentrant_failed_closed = false;
  bool poll_event_retained = false;
};
uint32_t g_planned = 0;
uint32_t g_executed = 0;
uint32_t g_mismatches = UINT32_MAX;
Recording* g_recording = nullptr;

bool bytes(const uint8_t* actual, uint32_t actual_length,
           const uint8_t* expected, size_t expected_length) {
  return actual && actual_length == expected_length &&
         std::memcmp(actual, expected, expected_length) == 0;
}
void u32le(uint8_t* output, uint32_t value) {
  for (uint32_t shift = 0; shift < 32; shift += 8)
    output[shift / 8] = static_cast<uint8_t>(value >> shift);
}
constexpr uint8_t kUrl[] = "https://host/game/\xe2\x9c\x93";
constexpr uint8_t kCertificate[] = {
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31};
constexpr uint8_t kWrite[] = {9,8,7,6};
constexpr uint8_t kDatagram[] = {5,4,3};
constexpr uint8_t kReason[] = "done\xe2\x9c\x93";

class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};
}  // namespace

extern "C" uint32_t defold_webtransport_native_v1_open(
    const char* url, uint32_t url_length, const uint8_t* certificate, uint32_t certificate_length,
    uint32_t anticipated_unidirectional, uint32_t anticipated_bidirectional) {
  ++g_recording->calls[1];
  g_recording->reentrant_failed_closed = deherm_static_native_web_transport_frame_acquire() == nullptr;
  return bytes(reinterpret_cast<const uint8_t*>(url), url_length, kUrl, sizeof(kUrl) - 1) &&
    bytes(certificate, certificate_length, kCertificate, sizeof(kCertificate)) &&
    anticipated_unidirectional == 64 && anticipated_bidirectional == 8 ? 73 : 0;
}
extern "C" uint32_t defold_webtransport_native_v1_state(uint32_t handle) {
  ++g_recording->calls[2]; return handle == 73 ? 2 : 0;
}
extern "C" uint32_t defold_webtransport_native_v1_max_datagram_bytes(uint32_t handle) {
  ++g_recording->calls[3]; return handle == 73 ? 1200 : 0;
}
extern "C" int32_t defold_webtransport_native_v1_open_bidirectional_stream(uint32_t handle, uint32_t request) {
  ++g_recording->calls[4]; return handle == 73 && request == 11 ? 0 : -104;
}
extern "C" int32_t defold_webtransport_native_v1_open_unidirectional_stream(uint32_t handle, uint32_t request) {
  ++g_recording->calls[5]; return handle == 73 && request == 12 ? 0 : -105;
}
extern "C" int32_t defold_webtransport_native_v1_write_stream(uint32_t handle, uint32_t stream,
    const uint8_t* value, uint32_t length, bool fin) {
  ++g_recording->calls[6]; return handle == 73 && stream == 91 && fin &&
    bytes(value, length, kWrite, sizeof(kWrite)) ? 0 : -106;
}
extern "C" int32_t defold_webtransport_native_v1_reset_stream(uint32_t handle, uint32_t stream, uint32_t code) {
  ++g_recording->calls[7]; return handle == 73 && stream == 91 && code == 41 ? 0 : -107;
}
extern "C" int32_t defold_webtransport_native_v1_stop_sending(uint32_t handle, uint32_t stream, uint32_t code) {
  ++g_recording->calls[8]; return handle == 73 && stream == 91 && code == 42 ? 0 : -108;
}
extern "C" int32_t defold_webtransport_native_v1_try_send_datagram(uint32_t handle,
    const uint8_t* value, uint32_t length) {
  ++g_recording->calls[9]; return handle == 73 && bytes(value, length, kDatagram, sizeof(kDatagram)) ? 1 : -109;
}
extern "C" int32_t defold_webtransport_native_v1_poll(uint32_t handle, uint8_t* output, uint32_t length) {
  ++g_recording->calls[10];
  if (handle != 73 || !output || length < 32) return -110;
  u32le(output, 3); u32le(output + 4, 1); u32le(output + 12, 11);
  u32le(output + 16, 91); u32le(output + 20, 3); u32le(output + 28, 1);
  if (g_recording->calls[10] == 1) { if (length > 40) output[40] = 0x99; return -4; }
  if (length < 35) return -4;
  g_recording->poll_event_retained = g_recording->calls[10] == 2;
  output[32] = 0xaa; output[33] = 0xbb; output[34] = 0xcc; return 0;
}
extern "C" int32_t defold_webtransport_native_v1_close(uint32_t handle, uint32_t code,
    const char* reason, uint32_t length) {
  ++g_recording->calls[11]; return handle == 73 && code == 43 &&
    bytes(reinterpret_cast<const uint8_t*>(reason), length, kReason, sizeof(kReason) - 1) ? 0 : -111;
}
extern "C" int32_t defold_webtransport_native_v1_destroy(uint32_t handle) {
  ++g_recording->calls[12]; return handle == 73 ? 0 : -112;
}

extern "C" void deherm_static_native_module_exact_report(
    uint32_t planned, uint32_t executed, uint32_t mismatches) {
  g_planned = planned; g_executed = executed; g_mismatches = mismatches;
}

int main() {
  try {
    static_assert(DEHERM_STATIC_NATIVE_WEB_TRANSPORT_FRAME_BYTES == UINT32_C(1048608));
    auto* absent = deherm_static_native_web_transport_frame_acquire();
    if (!absent || deherm_static_native_web_transport_state(absent, 73) != -7)
      throw std::runtime_error("absent Static provider did not fail closed");
    deherm_static_native_web_transport_frame_release(absent);

    Recording recording; g_recording = &recording;
    if (deherm_register_native_web_transport_provider_v1() != DEHERM_NATIVE_MODULE_REGISTRY_OK)
      throw std::runtime_error("provider registration failed");
    Host host;
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_native_module_exact,
    };
    runtime.loadStatic(units, 1, "defold-hermes://static-native-module-exact");
    if (g_planned != 12 || g_executed != 12 || g_mismatches != 0)
      throw std::runtime_error("Static Hermes method report mismatch");
    for (uint32_t method = 1; method <= 12; ++method) {
      const uint32_t expected = method == DEHERM_NATIVE_WEB_TRANSPORT_METHOD_POLL ? 2 : 1;
      if (recording.calls[method] != expected)
        throw std::runtime_error("Static Hermes did not reach every exact provider method");
    }
    if (!recording.reentrant_failed_closed || !recording.poll_event_retained)
      throw std::runtime_error("Static bridge lifetime invariant failed");
    if (deherm_native_module_unregister_v1("NativeWebTransport") != 0)
      throw std::runtime_error("provider unregister failed");
    std::puts("static-native-module-exact:12-methods:direct-extern-c:ok");
    return 0;
  } catch (const std::exception& error) {
    deherm_native_module_unregister_v1("NativeWebTransport");
    std::fprintf(stderr, "static-native-module-exact:error:%s\n", error.what());
    return 1;
  }
}
