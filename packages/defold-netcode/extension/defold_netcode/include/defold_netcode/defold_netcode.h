#ifndef DEFOLD_NETCODE_H
#define DEFOLD_NETCODE_H

// The C API of the defold_netcode extension.
//
// This is the surface the Static Hermes adapter calls. It exists so that a
// TypeScript game talking to a netcode server does not pay a Lua crossing per
// packet: the Lua API in netcode_lua.cpp is a second, independent caller of
// exactly these functions, not a layer this one goes through.
//
// Shape rules, and why:
//
//   * Handles are `uint32_t` slot ids, not pointers. wasm32 and arm64 disagree
//     about the width of a pointer, so a pointer handle would need a different
//     marshalling program per target; a u32 does not. The slot table is fixed
//     capacity, so a handle is also bounds-checkable rather than dereferenced
//     on faith.
//   * Every function takes and returns scalars or caller-owned buffers. Nothing
//     crosses this ABI that the caller has to free. netcode's own receive API
//     hands back a library-allocated packet; `deherm_netcode_client_receive`
//     copies it into the caller's buffer and frees it on this side, so the
//     adapter never holds a foreign allocation.
//   * No struct is passed by value. Struct layout is ABI-specific; a flat
//     argument list is the same program on every triple.
//   * Errors are returned, never thrown and never logged-and-ignored. A
//     negative return is a DEHERM_NETCODE_ERR_* code.

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Mirrors NETCODE_MAX_PACKET_SIZE and NETCODE_CONNECT_TOKEN_BYTES. They are
// restated rather than included so that a caller of this header does not need
// the vendored netcode.h on its include path; the two are asserted equal at
// compile time in netcode_capi.c, so a version bump that moved them fails the
// build instead of silently truncating a packet.
#define DEHERM_NETCODE_MAX_PACKET_BYTES 1200
#define DEHERM_NETCODE_CONNECT_TOKEN_BYTES 2048
#define DEHERM_NETCODE_KEY_BYTES 32
#define DEHERM_NETCODE_USER_DATA_BYTES 256

// Fixed capacities. A Defold game holds one client; the spare slots exist so a
// listen-server build can hold a client and a server at once, and so a test can
// run several sessions in one process without a reallocating table.
#define DEHERM_NETCODE_MAX_CLIENTS 4
#define DEHERM_NETCODE_MAX_SERVERS 2

#define DEHERM_NETCODE_INVALID_HANDLE 0u

// Which socket layer a client or server is created on. This is the whole point
// of the extension: the protocol, crypto and connection state machine are the
// same object either way, and only the bottom layer differs per target.
//
//   UDP            - netcode's own BSD/Winsock sockets. Every native target.
//   HOST_DATAGRAM  - no socket at all. Outbound packets queue for the host to
//                    drain with `pop_datagram`; inbound packets are pushed in
//                    with `push_datagram`. This is what carries netcode over a
//                    WebTransport datagram channel on HTML5, where the process
//                    cannot open a UDP socket.
typedef enum {
  DEHERM_NETCODE_TRANSPORT_UDP = 0,
  DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM = 1,
} DehermNetcodeTransport;

// Negative results. Positive results are counts or byte lengths; zero means
// "nothing available" on the polling calls, which is not an error.
#define DEHERM_NETCODE_OK 0
#define DEHERM_NETCODE_ERR_NOT_INITIALIZED (-1)
#define DEHERM_NETCODE_ERR_INVALID_HANDLE (-2)
#define DEHERM_NETCODE_ERR_NO_SLOT (-3)
#define DEHERM_NETCODE_ERR_CREATE_FAILED (-4)
#define DEHERM_NETCODE_ERR_BAD_ARGUMENT (-5)
#define DEHERM_NETCODE_ERR_WRONG_TRANSPORT (-6)
#define DEHERM_NETCODE_ERR_BUFFER_TOO_SMALL (-7)
#define DEHERM_NETCODE_ERR_QUEUE_FULL (-8)
#define DEHERM_NETCODE_ERR_NOT_CONNECTED (-9)

// Client states. These are netcode's own values, restated for the same reason
// the byte constants are, and asserted equal at compile time.
#define DEHERM_NETCODE_STATE_CONNECT_TOKEN_EXPIRED (-6)
#define DEHERM_NETCODE_STATE_INVALID_CONNECT_TOKEN (-5)
#define DEHERM_NETCODE_STATE_CONNECTION_TIMED_OUT (-4)
#define DEHERM_NETCODE_STATE_CONNECTION_RESPONSE_TIMED_OUT (-3)
#define DEHERM_NETCODE_STATE_CONNECTION_REQUEST_TIMED_OUT (-2)
#define DEHERM_NETCODE_STATE_CONNECTION_DENIED (-1)
#define DEHERM_NETCODE_STATE_DISCONNECTED 0
#define DEHERM_NETCODE_STATE_SENDING_CONNECTION_REQUEST 1
#define DEHERM_NETCODE_STATE_SENDING_CONNECTION_RESPONSE 2
#define DEHERM_NETCODE_STATE_CONNECTED 3

// ---------------------------------------------------------------------------
// Library lifetime
// ---------------------------------------------------------------------------

// Reference counted, mirroring netcode_init/netcode_term, so the Lua API and
// the Static Hermes adapter can each initialise without knowing about the
// other. The extension's own AppInit calls this once; callers that create a
// client outside the extension lifecycle should call it too.
//
// This must run before anything else: it is what seeds libsodium's RNG, and on
// wasm that is the call that installs `crypto.getRandomValues` as the entropy
// source. Skipping it does not fail loudly - it produces keys that are not keys.
int32_t deherm_netcode_init(void);
void deherm_netcode_term(void);

// 0 = none, 1 = error, 2 = info, 3 = debug. Defaults to error.
void deherm_netcode_set_log_level(int32_t level);

// Monotonic seconds since the first call. netcode is driven by an absolute time
// the caller supplies, so that a test can advance it deterministically; this is
// the default clock for callers that have no better one.
double deherm_netcode_time(void);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// `bind_address` is the local address, in netcode's "host:port" / "[v6]:port"
// spelling. Under HOST_DATAGRAM it is never bound - no socket is created - but
// it is still parsed and still identifies this peer inside the protocol, so it
// must be a valid address string.
//
// Returns a handle, or DEHERM_NETCODE_INVALID_HANDLE on failure; call
// `deherm_netcode_client_create_error` for the reason.
uint32_t deherm_netcode_client_create(const char* bind_address, int32_t transport);

// The last DEHERM_NETCODE_ERR_* from a failed create, or the underlying
// NETCODE_CLIENT_CREATE_ERROR_* shifted out of the way. Valid until the next
// create call.
int32_t deherm_netcode_client_create_error(void);

void deherm_netcode_client_destroy(uint32_t client);

// `token` is exactly DEHERM_NETCODE_CONNECT_TOKEN_BYTES bytes, minted by a
// backend that holds the private key. A client never holds the private key, so
// there is deliberately no client-side token generation in this API.
int32_t deherm_netcode_client_connect(uint32_t client, const uint8_t* token, int32_t token_bytes);

// Drives the state machine. Under HOST_DATAGRAM this drains whatever
// `push_datagram` has queued and fills the outbound queue; it performs no I/O.
int32_t deherm_netcode_client_update(uint32_t client, double time);

int32_t deherm_netcode_client_state(uint32_t client);
int32_t deherm_netcode_client_index(uint32_t client);
int32_t deherm_netcode_client_max_clients(uint32_t client);
int32_t deherm_netcode_client_disconnect(uint32_t client);

// Sends one unreliable payload packet. `bytes` must be in
// 1..DEHERM_NETCODE_MAX_PACKET_BYTES.
int32_t deherm_netcode_client_send(uint32_t client, const uint8_t* data, int32_t bytes);

// Copies the next received payload into `out`. Returns the byte count, 0 when
// nothing is queued, or a negative error. `sequence` may be NULL.
int32_t deherm_netcode_client_receive(uint32_t client, uint8_t* out, int32_t max_bytes, uint64_t* sequence);

// --- HOST_DATAGRAM pump. Both are DEHERM_NETCODE_ERR_WRONG_TRANSPORT on a UDP
// --- client, so a host that drives the wrong kind of client finds out.

// Hand one datagram that arrived on the host channel to netcode. Call before
// `update`. Returns OK, or ERR_QUEUE_FULL when the inbound ring is saturated -
// dropping is correct here, this is an unreliable channel by construction.
int32_t deherm_netcode_client_push_datagram(uint32_t client, const uint8_t* data, int32_t bytes);

// Take the next datagram netcode wants sent. Returns the byte count, or 0 when
// the outbound queue is empty. Call in a loop after `update` until it returns 0.
int32_t deherm_netcode_client_pop_datagram(uint32_t client, uint8_t* out, int32_t max_bytes);

// How many outbound datagrams were dropped because the queue was full, since
// creation. A host that sees this climb is not draining fast enough; silence
// here would turn a scheduling bug into an unexplained packet loss rate.
uint32_t deherm_netcode_client_dropped_outbound(uint32_t client);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
//
// The server is here because a listen-server build runs one in the same process
// as its client, and because the loopback conformance test needs both ends. A
// dedicated server is expected to run the same netcode elsewhere, not this
// extension.

uint32_t deherm_netcode_server_create(const char* bind_address, uint64_t protocol_id,
                                      const uint8_t* private_key, int32_t private_key_bytes,
                                      int32_t transport);
int32_t deherm_netcode_server_create_error(void);
void deherm_netcode_server_destroy(uint32_t server);

int32_t deherm_netcode_server_start(uint32_t server, int32_t max_clients);
int32_t deherm_netcode_server_stop(uint32_t server);
int32_t deherm_netcode_server_running(uint32_t server);
int32_t deherm_netcode_server_update(uint32_t server, double time);

int32_t deherm_netcode_server_num_connected_clients(uint32_t server);
int32_t deherm_netcode_server_client_connected(uint32_t server, int32_t client_index);
uint64_t deherm_netcode_server_client_id(uint32_t server, int32_t client_index);
int32_t deherm_netcode_server_disconnect_client(uint32_t server, int32_t client_index);

int32_t deherm_netcode_server_send(uint32_t server, int32_t client_index, const uint8_t* data, int32_t bytes);
int32_t deherm_netcode_server_receive(uint32_t server, int32_t client_index, uint8_t* out, int32_t max_bytes,
                                      uint64_t* sequence);

int32_t deherm_netcode_server_push_datagram(uint32_t server, const uint8_t* data, int32_t bytes);
int32_t deherm_netcode_server_pop_datagram(uint32_t server, uint8_t* out, int32_t max_bytes);

// Which address a HOST_DATAGRAM server should attribute inbound datagrams to.
// The host channel is point-to-point, so a server on it serves exactly one
// peer. A dedicated server fronting many WebTransport sessions needs one
// netcode server per session, or a real per-session address; this pilot does
// neither, and that limit is stated rather than papered over.
int32_t deherm_netcode_server_set_peer_address(uint32_t server, const char* address);

// Mints a connect token. This needs the private key, so it belongs to a backend
// or to a listen-server that is its own backend - never to a shipped client.
int32_t deherm_netcode_generate_connect_token(const char* server_address, uint64_t client_id, uint64_t protocol_id,
                                              const uint8_t* private_key, int32_t private_key_bytes,
                                              int32_t expire_seconds, int32_t timeout_seconds,
                                              const uint8_t* user_data, int32_t user_data_bytes,
                                              uint8_t* out_token, int32_t out_token_bytes);

// ---------------------------------------------------------------------------
// HTML5: the WebTransport datagram channel
// ---------------------------------------------------------------------------
//
// Declared only under DM_PLATFORM_HTML5 because that is the only target where
// they are defined - netcode_web_transport.cpp is entirely behind the same
// guard, since Extender compiles every src/ file for every target and an
// ext.manifest cannot exclude a platform. A caller that reaches for these on a
// native target gets a compile error naming the function, which is a better
// failure than a link error naming a mangled symbol.

#if defined(DM_PLATFORM_HTML5)

// Opens a WebTransport session. Returns immediately - the handshake is
// asynchronous in the browser and a Defold update cannot block on a promise -
// so poll `deherm_netcode_web_is_open` before expecting datagrams to move.
int32_t deherm_netcode_web_connect(const char* url);
int32_t deherm_netcode_web_is_open(void);

// The session's own datagram limit. Worth checking against
// DEHERM_NETCODE_CONNECT_TOKEN_BYTES: netcode's payload packets fit a typical
// QUIC datagram, but its connection request carries a 2048-byte connect token,
// and a path that cannot carry that cannot complete a handshake. Surfacing the
// number turns that from an unexplained timeout into a diagnosable condition.
uint32_t deherm_netcode_web_max_datagram_size(void);

void deherm_netcode_web_close(void);

// One frame of the channel. Call AFTER deherm_netcode_client_update: that is
// when netcode has finished writing what it wants sent. Returns the number of
// datagrams moved, or a negative DEHERM_NETCODE_ERR_*.
int32_t deherm_netcode_web_pump(uint32_t client);

// Six int32 counters, in order: datagrams sent, received, dropped for being
// larger than the path allows, dropped because the inbound queue was full,
// write errors, and the current inbound queue depth. The caller supplies the
// array; nothing is allocated.
void deherm_netcode_web_stats(int32_t* out_six_counters);

#endif  // DM_PLATFORM_HTML5

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // DEFOLD_NETCODE_H
