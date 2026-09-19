// Proves tests/socket_poison.c can fail.
//
// Same API, same link line, but a UDP-transport server - which must open a
// socket. This program is expected to ABORT. If it exits zero, the poison is
// not being linked over libc's symbols on this platform, and the pass reported
// by override_loopback means nothing. scripts/build-and-test.sh asserts the
// abort rather than the exit code zero.

#include <stdio.h>

#include "defold_netcode/defold_netcode.h"

static uint8_t private_key[DEHERM_NETCODE_KEY_BYTES] = {
    0x60, 0x6a, 0xbe, 0x6e, 0xc9, 0x19, 0x10, 0xea, 0x9a, 0x65, 0x62, 0xf6, 0x6f, 0x2b, 0x30, 0xe4,
    0x43, 0x71, 0xd6, 0x2c, 0xd1, 0x99, 0x27, 0x26, 0x6b, 0x3c, 0x60, 0xf4, 0xb7, 0x15, 0xab, 0xa1};

int main(void) {
  deherm_netcode_init();
  uint32_t server = deherm_netcode_server_create("127.0.0.1:40001", 0x1122334455667788ULL, private_key,
                                                 DEHERM_NETCODE_KEY_BYTES, DEHERM_NETCODE_TRANSPORT_UDP);
  printf("UNEXPECTED: a UDP server was created without reaching socket(): handle=%u\n", server);
  return 0;
}
