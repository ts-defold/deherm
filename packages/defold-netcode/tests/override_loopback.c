// The conformance test for the whole premise of this package.
//
// A netcode client and a netcode server are created on the HOST_DATAGRAM
// transport - no socket, either end - and driven through a real connect
// handshake to CONNECTED, then through payload packets in both directions. The
// only thing carrying bytes between them is this file pumping pop_datagram into
// push_datagram, which is exactly what the WebTransport bridge in
// lib/web/library_defold_netcode.js does with a datagram channel instead of a
// function call.
//
// Linked against tests/socket_poison.c, this also proves the negative: no
// socket syscall is reached. tests/poison_selftest.c proves that poison can
// actually fail, so a pass here is a result and not an artefact.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "defold_netcode/defold_netcode.h"

#define PROTOCOL_ID 0x1122334455667788ULL
#define CLIENT_ID 0xdeadbeefULL
#define SERVER_ADDRESS "127.0.0.1:40000"
#define CLIENT_ADDRESS "127.0.0.1:50000"

static uint8_t private_key[DEHERM_NETCODE_KEY_BYTES] = {
    0x60, 0x6a, 0xbe, 0x6e, 0xc9, 0x19, 0x10, 0xea, 0x9a, 0x65, 0x62, 0xf6, 0x6f, 0x2b, 0x30, 0xe4,
    0x43, 0x71, 0xd6, 0x2c, 0xd1, 0x99, 0x27, 0x26, 0x6b, 0x3c, 0x60, 0xf4, 0xb7, 0x15, 0xab, 0xa1};

static int failures = 0;

#define CHECK(condition)                                                    \
  do {                                                                      \
    if (!(condition)) {                                                     \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);           \
      failures++;                                                           \
    }                                                                       \
  } while (0)

#define REQUIRE(condition)                                                  \
  do {                                                                      \
    CHECK(condition);                                                       \
    if (failures) return 1;                                                 \
  } while (0)

// Per-direction drop counters. They are two, not one, and that is the point:
// an earlier version of this test shared a single counter across both
// directions and silently nulled one of them. In steady state the client put
// exactly one datagram per frame on the wire and the server put two, so the
// counter advanced by three per frame and `n % 3 == 0` landed on the client's
// only datagram every single time. 100% loss client-to-server, 0% the other
// way, reported as "the transport does not work under loss".
//
// A shared counter over a fixed per-frame pattern is not a loss model, it is a
// comb filter. Counting each direction separately gives each one a real 1-in-N
// and keeps the run deterministic, which is what a conformance test needs.
struct channel_loss_t {
  int drop_every;
  int client_to_server;
  int server_to_client;
};

static int should_drop(struct channel_loss_t* loss, int* counter) {
  if (loss->drop_every <= 0) return 0;
  (*counter)++;
  return (*counter % loss->drop_every) == 0;
}

// One tick of the host channel: drain everything each end wants to send and
// hand it to the other. An unreliable channel that never drops proves nothing
// about a protocol designed to tolerate loss, so the lossy pass matters more
// than the clean one.
static int pump(uint32_t client, uint32_t server, struct channel_loss_t* loss) {
  uint8_t datagram[2560];
  int moved = 0;
  int bytes;

  while ((bytes = deherm_netcode_client_pop_datagram(client, datagram, (int32_t)sizeof(datagram))) > 0) {
    if (should_drop(loss, &loss->client_to_server)) continue;
    CHECK(deherm_netcode_server_push_datagram(server, datagram, bytes) == DEHERM_NETCODE_OK);
    moved++;
  }
  CHECK(bytes == 0);

  while ((bytes = deherm_netcode_server_pop_datagram(server, datagram, (int32_t)sizeof(datagram))) > 0) {
    if (should_drop(loss, &loss->server_to_client)) continue;
    CHECK(deherm_netcode_client_push_datagram(client, datagram, bytes) == DEHERM_NETCODE_OK);
    moved++;
  }
  CHECK(bytes == 0);

  return moved;
}

static int run_session(int drop_every) {
  uint32_t server = deherm_netcode_server_create(SERVER_ADDRESS, PROTOCOL_ID, private_key,
                                                 DEHERM_NETCODE_KEY_BYTES,
                                                 DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM);
  REQUIRE(server != DEHERM_NETCODE_INVALID_HANDLE);
  REQUIRE(deherm_netcode_server_set_peer_address(server, CLIENT_ADDRESS) == DEHERM_NETCODE_OK);
  REQUIRE(deherm_netcode_server_start(server, 4) == DEHERM_NETCODE_OK);
  REQUIRE(deherm_netcode_server_running(server) == 1);

  uint32_t client =
      deherm_netcode_client_create(CLIENT_ADDRESS, DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM);
  REQUIRE(client != DEHERM_NETCODE_INVALID_HANDLE);

  uint8_t user_data[DEHERM_NETCODE_USER_DATA_BYTES];
  memset(user_data, 0x5a, sizeof(user_data));
  uint8_t token[DEHERM_NETCODE_CONNECT_TOKEN_BYTES];
  REQUIRE(deherm_netcode_generate_connect_token(SERVER_ADDRESS, CLIENT_ID, PROTOCOL_ID, private_key,
                                                DEHERM_NETCODE_KEY_BYTES, 30, 5, user_data,
                                                (int32_t)sizeof(user_data), token,
                                                (int32_t)sizeof(token)) == DEHERM_NETCODE_OK);

  REQUIRE(deherm_netcode_client_connect(client, token, (int32_t)sizeof(token)) == DEHERM_NETCODE_OK);

  double time = 0.0;
  const double delta = 1.0 / 60.0;
  struct channel_loss_t loss = {drop_every, 0, 0};
  int ticks = 0;

  while (deherm_netcode_client_state(client) != DEHERM_NETCODE_STATE_CONNECTED) {
    REQUIRE(deherm_netcode_client_state(client) > DEHERM_NETCODE_STATE_DISCONNECTED);
    REQUIRE(ticks++ < 4000);
    CHECK(deherm_netcode_client_update(client, time) == DEHERM_NETCODE_OK);
    CHECK(deherm_netcode_server_update(server, time) == DEHERM_NETCODE_OK);
    pump(client, server, &loss);
    time += delta;
  }

  const int client_index = deherm_netcode_client_index(client);
  printf("  connected after %d ticks (drop_every=%d), client_index=%d\n", ticks, drop_every, client_index);
  CHECK(client_index >= 0);
  CHECK(deherm_netcode_server_num_connected_clients(server) == 1);
  CHECK(deherm_netcode_server_client_id(server, client_index) == CLIENT_ID);

  uint8_t payload[DEHERM_NETCODE_MAX_PACKET_BYTES];
  for (int i = 0; i < DEHERM_NETCODE_MAX_PACKET_BYTES; i++) payload[i] = (uint8_t)(i & 0xff);

  uint8_t received[DEHERM_NETCODE_MAX_PACKET_BYTES];
  int server_received = 0;
  int client_received = 0;

  // A fixed number of frames, not "until one arrives". Stopping at the first
  // delivery would pass even if the channel delivered exactly one packet and
  // then wedged; a rate over a fixed window will not.
  const int frames = 240;
  for (int frame = 0; frame < frames; frame++) {
    CHECK(deherm_netcode_client_send(client, payload, DEHERM_NETCODE_MAX_PACKET_BYTES) == DEHERM_NETCODE_OK);
    CHECK(deherm_netcode_server_send(server, client_index, payload, DEHERM_NETCODE_MAX_PACKET_BYTES) ==
          DEHERM_NETCODE_OK);

    CHECK(deherm_netcode_client_update(client, time) == DEHERM_NETCODE_OK);
    CHECK(deherm_netcode_server_update(server, time) == DEHERM_NETCODE_OK);
    pump(client, server, &loss);
    time += delta;

    int bytes;
    uint64_t sequence = 0;
    while ((bytes = deherm_netcode_server_receive(server, client_index, received, (int32_t)sizeof(received),
                                                  &sequence)) > 0) {
      CHECK(bytes == DEHERM_NETCODE_MAX_PACKET_BYTES);
      CHECK(memcmp(received, payload, (size_t)bytes) == 0);
      server_received++;
    }
    CHECK(bytes == 0);

    while ((bytes = deherm_netcode_client_receive(client, received, (int32_t)sizeof(received), &sequence)) > 0) {
      CHECK(bytes == DEHERM_NETCODE_MAX_PACKET_BYTES);
      CHECK(memcmp(received, payload, (size_t)bytes) == 0);
      client_received++;
    }
    CHECK(bytes == 0);
  }

  // One packet per direction per frame is offered. With a 1-in-N drop and a
  // frame of scheduling lag, a correct channel delivers most of them; the floor
  // is deliberately loose because this asserts "the channel carries traffic",
  // not a throughput figure.
  const int floor = (drop_every > 0) ? (frames / 2) : (frames - 4);
  printf("  payloads over %d frames: server received %d, client received %d (floor %d)\n", frames,
         server_received, client_received, floor);
  CHECK(server_received >= floor);
  CHECK(client_received >= floor);

  // Nothing should have been dropped for want of queue space at this rate. If
  // this ever trips, the ring is too small for the traffic, and that is a real
  // defect rather than the unreliable-channel loss the protocol expects.
  CHECK(deherm_netcode_client_dropped_outbound(client) == 0);

  deherm_netcode_client_destroy(client);
  deherm_netcode_server_destroy(server);
  return failures ? 1 : 0;
}

// Creating a UDP client opens a real socket, which is exactly what the poisoned
// link of this same file forbids. That is not a conflict to work around - it is
// the poison doing its job - so the UDP-only checks are compiled out of the
// poisoned binary rather than weakened for both.
#ifndef DEHERM_NETCODE_TEST_NO_SOCKETS
static int run_udp_transport_checks(void) {
  // A UDP-transport client must refuse the host pump rather than quietly doing
  // nothing, or a host that drives the wrong kind of client never finds out.
  uint32_t udp_client = deherm_netcode_client_create(CLIENT_ADDRESS, DEHERM_NETCODE_TRANSPORT_UDP);
  REQUIRE(udp_client != DEHERM_NETCODE_INVALID_HANDLE);
  uint8_t scratch[16];
  CHECK(deherm_netcode_client_push_datagram(udp_client, scratch, (int32_t)sizeof(scratch)) ==
        DEHERM_NETCODE_ERR_WRONG_TRANSPORT);
  CHECK(deherm_netcode_client_pop_datagram(udp_client, scratch, (int32_t)sizeof(scratch)) ==
        DEHERM_NETCODE_ERR_WRONG_TRANSPORT);
  deherm_netcode_client_destroy(udp_client);
  return failures ? 1 : 0;
}
#endif

static int run_argument_checks(void) {
  CHECK(deherm_netcode_client_state(DEHERM_NETCODE_INVALID_HANDLE) == DEHERM_NETCODE_ERR_INVALID_HANDLE);
  CHECK(deherm_netcode_client_state(9999u) == DEHERM_NETCODE_ERR_INVALID_HANDLE);

  uint8_t token[DEHERM_NETCODE_CONNECT_TOKEN_BYTES];
  CHECK(deherm_netcode_generate_connect_token(SERVER_ADDRESS, CLIENT_ID, PROTOCOL_ID, private_key, 31, 30, 5,
                                              NULL, 0, token, (int32_t)sizeof(token)) ==
        DEHERM_NETCODE_ERR_BAD_ARGUMENT);
  return failures ? 1 : 0;
}

int main(void) {
  if (deherm_netcode_init() != DEHERM_NETCODE_OK) {
    printf("FAIL: deherm_netcode_init\n");
    return 1;
  }

  printf("argument checks\n");
  run_argument_checks();

#ifndef DEHERM_NETCODE_TEST_NO_SOCKETS
  printf("udp transport-kind checks\n");
  run_udp_transport_checks();
#endif

  printf("clean host channel\n");
  run_session(0);

  printf("lossy host channel (every 3rd datagram dropped)\n");
  run_session(3);

  deherm_netcode_term();

  if (failures) {
    printf("FAILED (%d checks)\n", failures);
    return 1;
  }
  printf("PASS: netcode handshake and payload exchange over a host datagram channel, no socket created\n");
  return 0;
}
