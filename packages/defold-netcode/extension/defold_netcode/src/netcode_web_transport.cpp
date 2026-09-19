// The HTML5 half of the host datagram transport: move netcode's rings onto the
// WebTransport datagram channel in lib/web/library_defold_netcode.js.
//
// Extender compiles every file in an extension's `src/` for every target and an
// ext.manifest cannot exclude a platform, so the whole translation unit is
// behind DM_PLATFORM_HTML5. On any other target it compiles to nothing, which
// is the same fail-closed arrangement defold_hermes_typed_native uses - except
// that here the non-web case is genuinely empty rather than an error, because
// the extension is perfectly usable on native without this file.

#if defined(DM_PLATFORM_HTML5)

#include <emscripten.h>
#include <stdint.h>

#include "defold_netcode/defold_netcode.h"

extern "C" {

// Implemented in lib/web/library_defold_netcode.js.
extern int defoldNetcodeWebConnect(const char* url);
extern int defoldNetcodeWebIsOpen(void);
extern uint32_t defoldNetcodeWebMaxDatagramSize(void);
extern void defoldNetcodeWebClose(void);
extern int defoldNetcodeWebSend(const uint8_t* data, int byte_count);
extern int defoldNetcodeWebReceive(uint8_t* buffer, int max_bytes);
extern void defoldNetcodeWebStats(int32_t* out_six_counters);

int32_t deherm_netcode_web_connect(const char* url) {
  return defoldNetcodeWebConnect(url) ? DEHERM_NETCODE_OK : DEHERM_NETCODE_ERR_CREATE_FAILED;
}

int32_t deherm_netcode_web_is_open(void) {
  return defoldNetcodeWebIsOpen();
}

uint32_t deherm_netcode_web_max_datagram_size(void) {
  return defoldNetcodeWebMaxDatagramSize();
}

void deherm_netcode_web_close(void) {
  defoldNetcodeWebClose();
}

// One frame of the channel. Call after deherm_netcode_client_update: that is
// when netcode has finished writing whatever it wants sent, and when the
// packets pushed here will be read by the NEXT update. A frame of latency is
// the price of not re-entering netcode from a JS callback, and netcode is
// explicitly not thread safe, so that price is the right one to pay.
//
// Returns the number of datagrams moved, or a negative error.
int32_t deherm_netcode_web_pump(uint32_t client) {
  // Sized for netcode's largest packet - the connection request carrying a
  // 2048-byte connect token - not for its payload limit.
  uint8_t datagram[2560];
  int32_t moved = 0;

  for (;;) {
    int32_t bytes = deherm_netcode_client_pop_datagram(client, datagram, (int32_t)sizeof(datagram));
    if (bytes < 0) return bytes;
    if (bytes == 0) break;
    // A datagram the path cannot carry is dropped by the JS side and counted.
    // netcode retransmits, so this costs a retry rather than a wedged
    // handshake; see the note in library_defold_netcode.js.
    defoldNetcodeWebSend(datagram, (int)bytes);
    moved++;
  }

  for (;;) {
    int received = defoldNetcodeWebReceive(datagram, (int)sizeof(datagram));
    if (received == 0) break;
    if (received < 0) continue;  // did not fit; the JS side already dropped it
    int32_t result = deherm_netcode_client_push_datagram(client, datagram, (int32_t)received);
    // A full inbound ring is not an error to propagate: the channel is
    // unreliable by construction and netcode is built to tolerate loss.
    if (result == DEHERM_NETCODE_ERR_QUEUE_FULL) break;
    if (result < 0) return result;
    moved++;
  }

  return moved;
}

void deherm_netcode_web_stats(int32_t* out_six_counters) {
  defoldNetcodeWebStats(out_six_counters);
}

}  // extern "C"

#endif  // DM_PLATFORM_HTML5
