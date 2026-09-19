// Implementation of the defold_netcode C API.
//
// The only interesting thing in here is the HOST_DATAGRAM transport. netcode
// exposes `override_send_and_receive` plus a send/receive callback pair; when
// that flag is set, `netcode_client_socket_create` and
// `netcode_server_socket_create` return without calling `netcode_socket_create`
// at all, `netcode_send_packet_to_address` dispatches to the send override
// instead of a socket, and the update loop calls the receive override instead
// of `netcode_socket_receive_packet`. Those four facts are what make an HTML5
// build possible, and they are verified in tests/override_loopback.c rather
// than assumed.
//
// The overrides here are queues, not direct calls into the peer. A WebTransport
// reader hands us datagrams whenever they arrive, which is not when netcode
// asks for them, so the inbound side has to buffer; and the outbound side has
// to buffer because a JS writer is asynchronous. Modelling both as rings means
// the same code path serves the browser and the loopback test.

#include "defold_netcode/defold_netcode.h"

#include <string.h>

#include "vendor/netcode.h"

// The header restates netcode's constants so that callers do not need
// netcode.h. If a version bump moves one, this fails the build rather than
// silently truncating a packet or a token.
typedef char deherm_netcode_static_assert_packet_bytes
    [(DEHERM_NETCODE_MAX_PACKET_BYTES == NETCODE_MAX_PACKET_SIZE) ? 1 : -1];
typedef char deherm_netcode_static_assert_token_bytes
    [(DEHERM_NETCODE_CONNECT_TOKEN_BYTES == NETCODE_CONNECT_TOKEN_BYTES) ? 1 : -1];
typedef char deherm_netcode_static_assert_key_bytes
    [(DEHERM_NETCODE_KEY_BYTES == NETCODE_KEY_BYTES) ? 1 : -1];
typedef char deherm_netcode_static_assert_user_data_bytes
    [(DEHERM_NETCODE_USER_DATA_BYTES == NETCODE_USER_DATA_BYTES) ? 1 : -1];
typedef char deherm_netcode_static_assert_connected
    [(DEHERM_NETCODE_STATE_CONNECTED == NETCODE_CLIENT_STATE_CONNECTED) ? 1 : -1];
typedef char deherm_netcode_static_assert_disconnected
    [(DEHERM_NETCODE_STATE_DISCONNECTED == NETCODE_CLIENT_STATE_DISCONNECTED) ? 1 : -1];

// A netcode packet is at most NETCODE_MAX_PACKET_SIZE of payload, but the
// connection-request packet carries a 2048-byte connect token and is much
// larger. netcode's own internal buffers are NETCODE_MAX_PACKET_BYTES; the ring
// has to hold the largest thing netcode will hand the send override, so it is
// sized from that and not from the payload limit.
#define DEHERM_NETCODE_RING_SLOT_BYTES 2560
#define DEHERM_NETCODE_RING_SLOTS 64

struct deherm_ring_t {
  int head;
  int count;
  int bytes[DEHERM_NETCODE_RING_SLOTS];
  uint8_t data[DEHERM_NETCODE_RING_SLOTS][DEHERM_NETCODE_RING_SLOT_BYTES];
};

static int deherm_ring_push(struct deherm_ring_t* ring, const uint8_t* data, int bytes) {
  if (bytes <= 0 || bytes > DEHERM_NETCODE_RING_SLOT_BYTES) return 0;
  if (ring->count >= DEHERM_NETCODE_RING_SLOTS) return 0;
  int slot = (ring->head + ring->count) % DEHERM_NETCODE_RING_SLOTS;
  memcpy(ring->data[slot], data, (size_t)bytes);
  ring->bytes[slot] = bytes;
  ring->count++;
  return 1;
}

static int deherm_ring_pop(struct deherm_ring_t* ring, uint8_t* out, int max_bytes) {
  if (ring->count == 0) return 0;
  int bytes = ring->bytes[ring->head];
  if (bytes > max_bytes) return DEHERM_NETCODE_ERR_BUFFER_TOO_SMALL;
  memcpy(out, ring->data[ring->head], (size_t)bytes);
  ring->head = (ring->head + 1) % DEHERM_NETCODE_RING_SLOTS;
  ring->count--;
  return bytes;
}

struct deherm_client_slot_t {
  struct netcode_client_t* client;
  struct deherm_ring_t inbound;
  struct deherm_ring_t outbound;
  struct netcode_address_t peer;
  uint32_t dropped_outbound;
  int32_t transport;
  int in_use;
};

struct deherm_server_slot_t {
  struct netcode_server_t* server;
  struct deherm_ring_t inbound;
  struct deherm_ring_t outbound;
  struct netcode_address_t peer;
  uint32_t dropped_outbound;
  int32_t transport;
  int in_use;
};

static struct deherm_client_slot_t g_clients[DEHERM_NETCODE_MAX_CLIENTS];
static struct deherm_server_slot_t g_servers[DEHERM_NETCODE_MAX_SERVERS];
static int32_t g_client_create_error = DEHERM_NETCODE_OK;
static int32_t g_server_create_error = DEHERM_NETCODE_OK;
static int g_initialized = 0;

// Handles are 1-based so that zero is always invalid, and are the slot index
// plus one rather than a generation counter: the table is fixed and small, and
// a stale handle into a reused slot is a bug the loopback test would surface
// rather than a security boundary.
static struct deherm_client_slot_t* client_slot(uint32_t handle) {
  if (handle == DEHERM_NETCODE_INVALID_HANDLE || handle > DEHERM_NETCODE_MAX_CLIENTS) return NULL;
  struct deherm_client_slot_t* slot = &g_clients[handle - 1];
  return slot->in_use ? slot : NULL;
}

static struct deherm_server_slot_t* server_slot(uint32_t handle) {
  if (handle == DEHERM_NETCODE_INVALID_HANDLE || handle > DEHERM_NETCODE_MAX_SERVERS) return NULL;
  struct deherm_server_slot_t* slot = &g_servers[handle - 1];
  return slot->in_use ? slot : NULL;
}

// --- the transport overrides ------------------------------------------------

static void client_send_override(void* context, struct netcode_address_t* to, NETCODE_CONST uint8_t* data,
                                 int bytes) {
  struct deherm_client_slot_t* slot = (struct deherm_client_slot_t*)context;
  (void)to;
  if (!deherm_ring_push(&slot->outbound, data, bytes)) slot->dropped_outbound++;
}

static int client_receive_override(void* context, struct netcode_address_t* from, uint8_t* data, int max_bytes) {
  struct deherm_client_slot_t* slot = (struct deherm_client_slot_t*)context;
  // Every datagram on the host channel came from the server this client is
  // talking to. The host channel is point-to-point - a WebTransport session has
  // exactly one peer - so there is no other address it could have come from,
  // and netcode still needs one to match the packet against its connection.
  *from = slot->peer;
  int bytes = deherm_ring_pop(&slot->inbound, data, max_bytes);
  return bytes > 0 ? bytes : 0;
}

static void server_send_override(void* context, struct netcode_address_t* to, NETCODE_CONST uint8_t* data,
                                 int bytes) {
  struct deherm_server_slot_t* slot = (struct deherm_server_slot_t*)context;
  (void)to;
  if (!deherm_ring_push(&slot->outbound, data, bytes)) slot->dropped_outbound++;
}

static int server_receive_override(void* context, struct netcode_address_t* from, uint8_t* data, int max_bytes) {
  struct deherm_server_slot_t* slot = (struct deherm_server_slot_t*)context;
  *from = slot->peer;
  int bytes = deherm_ring_pop(&slot->inbound, data, max_bytes);
  return bytes > 0 ? bytes : 0;
}

// --- library lifetime -------------------------------------------------------

int32_t deherm_netcode_init(void) {
  if (netcode_init() != NETCODE_OK) return DEHERM_NETCODE_ERR_CREATE_FAILED;
  g_initialized = 1;
  netcode_log_level(NETCODE_LOG_LEVEL_ERROR);
  return DEHERM_NETCODE_OK;
}

void deherm_netcode_term(void) {
  netcode_term();
}

void deherm_netcode_set_log_level(int32_t level) {
  netcode_log_level((int)level);
}

double deherm_netcode_time(void) {
  return netcode_time();
}

// --- client -----------------------------------------------------------------

uint32_t deherm_netcode_client_create(const char* bind_address, int32_t transport) {
  g_client_create_error = DEHERM_NETCODE_OK;
  if (!g_initialized) {
    g_client_create_error = DEHERM_NETCODE_ERR_NOT_INITIALIZED;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }
  if (!bind_address) {
    g_client_create_error = DEHERM_NETCODE_ERR_BAD_ARGUMENT;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  int index = -1;
  for (int i = 0; i < DEHERM_NETCODE_MAX_CLIENTS; i++) {
    if (!g_clients[i].in_use) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    g_client_create_error = DEHERM_NETCODE_ERR_NO_SLOT;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  struct deherm_client_slot_t* slot = &g_clients[index];
  memset(slot, 0, sizeof(*slot));
  slot->transport = transport;

  struct netcode_client_config_t config;
  netcode_default_client_config(&config);
  if (transport == DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) {
    config.callback_context = slot;
    config.override_send_and_receive = 1;
    config.send_packet_override = client_send_override;
    config.receive_packet_override = client_receive_override;
  }

  slot->client = netcode_client_create(bind_address, &config, netcode_time());
  if (!slot->client) {
    // netcode's own create error is more specific than ours. Keep it, shifted
    // clear of the DEHERM_NETCODE_ERR_* range, so a caller can tell "port in
    // use" from "bad address" instead of getting one opaque failure.
    g_client_create_error = -100 - netcode_client_create_error();
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  slot->in_use = 1;
  return (uint32_t)(index + 1);
}

int32_t deherm_netcode_client_create_error(void) {
  return g_client_create_error;
}

void deherm_netcode_client_destroy(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return;
  netcode_client_destroy(slot->client);
  memset(slot, 0, sizeof(*slot));
}

int32_t deherm_netcode_client_connect(uint32_t client, const uint8_t* token, int32_t token_bytes) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!token || token_bytes != DEHERM_NETCODE_CONNECT_TOKEN_BYTES) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;

  netcode_client_connect(slot->client, (uint8_t*)token);

  // Under HOST_DATAGRAM the peer address is whatever the connect token names.
  // It is read after `connect` because that is when the client resolves which
  // of the token's server addresses it is using.
  if (slot->transport == DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) {
    struct netcode_address_t* server = netcode_client_server_address(slot->client);
    if (server) slot->peer = *server;
  }
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_client_update(uint32_t client, double time) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  netcode_client_update(slot->client, time);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_client_state(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_client_state(slot->client);
}

int32_t deherm_netcode_client_index(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_client_index(slot->client);
}

int32_t deherm_netcode_client_max_clients(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_client_max_clients(slot->client);
}

int32_t deherm_netcode_client_disconnect(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  netcode_client_disconnect(slot->client);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_client_send(uint32_t client, const uint8_t* data, int32_t bytes) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!data || bytes <= 0 || bytes > DEHERM_NETCODE_MAX_PACKET_BYTES) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  if (netcode_client_state(slot->client) != NETCODE_CLIENT_STATE_CONNECTED) return DEHERM_NETCODE_ERR_NOT_CONNECTED;
  netcode_client_send_packet(slot->client, (NETCODE_CONST uint8_t*)data, (int)bytes);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_client_receive(uint32_t client, uint8_t* out, int32_t max_bytes, uint64_t* sequence) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!out || max_bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;

  int packet_bytes = 0;
  uint64_t packet_sequence = 0;
  uint8_t* packet = netcode_client_receive_packet(slot->client, &packet_bytes, &packet_sequence);
  if (!packet) return 0;

  // The packet is netcode's allocation. It is freed here whatever happens, so
  // no foreign allocation ever reaches the caller - including on the
  // buffer-too-small path, where dropping the packet is the only option that
  // does not leak.
  int32_t result;
  if (packet_bytes > max_bytes) {
    result = DEHERM_NETCODE_ERR_BUFFER_TOO_SMALL;
  } else {
    memcpy(out, packet, (size_t)packet_bytes);
    if (sequence) *sequence = packet_sequence;
    result = (int32_t)packet_bytes;
  }
  netcode_client_free_packet(slot->client, packet);
  return result;
}

int32_t deherm_netcode_client_push_datagram(uint32_t client, const uint8_t* data, int32_t bytes) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (slot->transport != DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) return DEHERM_NETCODE_ERR_WRONG_TRANSPORT;
  if (!data || bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  return deherm_ring_push(&slot->inbound, data, (int)bytes) ? DEHERM_NETCODE_OK : DEHERM_NETCODE_ERR_QUEUE_FULL;
}

int32_t deherm_netcode_client_pop_datagram(uint32_t client, uint8_t* out, int32_t max_bytes) {
  struct deherm_client_slot_t* slot = client_slot(client);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (slot->transport != DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) return DEHERM_NETCODE_ERR_WRONG_TRANSPORT;
  if (!out || max_bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  return (int32_t)deherm_ring_pop(&slot->outbound, out, (int)max_bytes);
}

uint32_t deherm_netcode_client_dropped_outbound(uint32_t client) {
  struct deherm_client_slot_t* slot = client_slot(client);
  return slot ? slot->dropped_outbound : 0u;
}

// --- server -----------------------------------------------------------------

uint32_t deherm_netcode_server_create(const char* bind_address, uint64_t protocol_id, const uint8_t* private_key,
                                      int32_t private_key_bytes, int32_t transport) {
  g_server_create_error = DEHERM_NETCODE_OK;
  if (!g_initialized) {
    g_server_create_error = DEHERM_NETCODE_ERR_NOT_INITIALIZED;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }
  if (!bind_address || !private_key || private_key_bytes != DEHERM_NETCODE_KEY_BYTES) {
    g_server_create_error = DEHERM_NETCODE_ERR_BAD_ARGUMENT;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  int index = -1;
  for (int i = 0; i < DEHERM_NETCODE_MAX_SERVERS; i++) {
    if (!g_servers[i].in_use) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    g_server_create_error = DEHERM_NETCODE_ERR_NO_SLOT;
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  struct deherm_server_slot_t* slot = &g_servers[index];
  memset(slot, 0, sizeof(*slot));
  slot->transport = transport;

  struct netcode_server_config_t config;
  netcode_default_server_config(&config);
  config.protocol_id = protocol_id;
  memcpy(config.private_key, private_key, NETCODE_KEY_BYTES);
  if (transport == DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) {
    config.callback_context = slot;
    config.override_send_and_receive = 1;
    config.send_packet_override = server_send_override;
    config.receive_packet_override = server_receive_override;
  }

  slot->server = netcode_server_create(bind_address, &config, netcode_time());
  if (!slot->server) {
    g_server_create_error = -100 - netcode_server_create_error();
    return DEHERM_NETCODE_INVALID_HANDLE;
  }

  slot->in_use = 1;
  return (uint32_t)(index + 1);
}

int32_t deherm_netcode_server_create_error(void) {
  return g_server_create_error;
}

void deherm_netcode_server_destroy(uint32_t server) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return;
  netcode_server_destroy(slot->server);
  memset(slot, 0, sizeof(*slot));
}

int32_t deherm_netcode_server_start(uint32_t server, int32_t max_clients) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (max_clients <= 0 || max_clients > NETCODE_MAX_CLIENTS) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  netcode_server_start(slot->server, (int)max_clients);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_server_stop(uint32_t server) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  netcode_server_stop(slot->server);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_server_running(uint32_t server) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_server_running(slot->server);
}

int32_t deherm_netcode_server_update(uint32_t server, double time) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  netcode_server_update(slot->server, time);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_server_num_connected_clients(uint32_t server) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_server_num_connected_clients(slot->server);
}

int32_t deherm_netcode_server_client_connected(uint32_t server, int32_t client_index) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  return (int32_t)netcode_server_client_connected(slot->server, (int)client_index);
}

uint64_t deherm_netcode_server_client_id(uint32_t server, int32_t client_index) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return 0u;
  return netcode_server_client_id(slot->server, (int)client_index);
}

int32_t deherm_netcode_server_disconnect_client(uint32_t server, int32_t client_index) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  netcode_server_disconnect_client(slot->server, (int)client_index);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_server_send(uint32_t server, int32_t client_index, const uint8_t* data, int32_t bytes) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!data || bytes <= 0 || bytes > DEHERM_NETCODE_MAX_PACKET_BYTES) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  if (!netcode_server_client_connected(slot->server, (int)client_index)) return DEHERM_NETCODE_ERR_NOT_CONNECTED;
  netcode_server_send_packet(slot->server, (int)client_index, (NETCODE_CONST uint8_t*)data, (int)bytes);
  return DEHERM_NETCODE_OK;
}

int32_t deherm_netcode_server_receive(uint32_t server, int32_t client_index, uint8_t* out, int32_t max_bytes,
                                      uint64_t* sequence) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!out || max_bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;

  int packet_bytes = 0;
  uint64_t packet_sequence = 0;
  uint8_t* packet = netcode_server_receive_packet(slot->server, (int)client_index, &packet_bytes, &packet_sequence);
  if (!packet) return 0;

  int32_t result;
  if (packet_bytes > max_bytes) {
    result = DEHERM_NETCODE_ERR_BUFFER_TOO_SMALL;
  } else {
    memcpy(out, packet, (size_t)packet_bytes);
    if (sequence) *sequence = packet_sequence;
    result = (int32_t)packet_bytes;
  }
  netcode_server_free_packet(slot->server, packet);
  return result;
}

int32_t deherm_netcode_server_push_datagram(uint32_t server, const uint8_t* data, int32_t bytes) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (slot->transport != DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) return DEHERM_NETCODE_ERR_WRONG_TRANSPORT;
  if (!data || bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  return deherm_ring_push(&slot->inbound, data, (int)bytes) ? DEHERM_NETCODE_OK : DEHERM_NETCODE_ERR_QUEUE_FULL;
}

int32_t deherm_netcode_server_pop_datagram(uint32_t server, uint8_t* out, int32_t max_bytes) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (slot->transport != DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM) return DEHERM_NETCODE_ERR_WRONG_TRANSPORT;
  if (!out || max_bytes <= 0) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  return (int32_t)deherm_ring_pop(&slot->outbound, out, (int)max_bytes);
}

int32_t deherm_netcode_server_set_peer_address(uint32_t server, const char* address) {
  struct deherm_server_slot_t* slot = server_slot(server);
  if (!slot) return DEHERM_NETCODE_ERR_INVALID_HANDLE;
  if (!address) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  return netcode_parse_address((NETCODE_CONST char*)address, &slot->peer) == NETCODE_OK
             ? DEHERM_NETCODE_OK
             : DEHERM_NETCODE_ERR_BAD_ARGUMENT;
}

int32_t deherm_netcode_generate_connect_token(const char* server_address, uint64_t client_id, uint64_t protocol_id,
                                              const uint8_t* private_key, int32_t private_key_bytes,
                                              int32_t expire_seconds, int32_t timeout_seconds,
                                              const uint8_t* user_data, int32_t user_data_bytes, uint8_t* out_token,
                                              int32_t out_token_bytes) {
  if (!g_initialized) return DEHERM_NETCODE_ERR_NOT_INITIALIZED;
  if (!server_address || !private_key || private_key_bytes != DEHERM_NETCODE_KEY_BYTES) {
    return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
  }
  if (!out_token || out_token_bytes != DEHERM_NETCODE_CONNECT_TOKEN_BYTES) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;

  uint8_t padded_user_data[NETCODE_USER_DATA_BYTES];
  memset(padded_user_data, 0, sizeof(padded_user_data));
  if (user_data && user_data_bytes > 0) {
    if (user_data_bytes > NETCODE_USER_DATA_BYTES) return DEHERM_NETCODE_ERR_BAD_ARGUMENT;
    memcpy(padded_user_data, user_data, (size_t)user_data_bytes);
  }

  NETCODE_CONST char* addresses[1];
  addresses[0] = (NETCODE_CONST char*)server_address;

  int ok = netcode_generate_connect_token(1, addresses, addresses, (int)expire_seconds, (int)timeout_seconds,
                                          client_id, protocol_id, (NETCODE_CONST uint8_t*)private_key,
                                          padded_user_data, out_token);
  return ok == NETCODE_OK ? DEHERM_NETCODE_OK : DEHERM_NETCODE_ERR_CREATE_FAILED;
}
