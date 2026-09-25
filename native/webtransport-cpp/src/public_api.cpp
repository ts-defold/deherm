#include <defold_webtransport/client.h>
#include <defold_webtransport/native_v1.h>
#include <deherm/webtransport/client.hpp>
#include <deherm/webtransport/extension_bridge.hpp>

#include "native_v1_internal.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <string_view>

namespace {
using deherm::webtransport::Client;
using deherm::webtransport::Event;
using deherm::webtransport::EventKind;
using deherm::webtransport::Options;
using deherm::webtransport::SendResult;
using deherm::webtransport::State;
using deherm::webtransport::detail::NativeStream;
using deherm::webtransport::detail::NativeStreamRegistry;
using deherm::webtransport::detail::openedStreamFlags;
constexpr std::size_t kMaximumSessions = 16;
constexpr std::size_t kMaximumStreamsPerSession = deherm::webtransport::kMaximumConcurrentStreams;
constexpr std::size_t kPublicPollBytes = DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES +
                                         DEFOLD_WEBTRANSPORT_NATIVE_V1_INITIAL_PAYLOAD_BYTES;

struct NativeSession {
  std::uint32_t handle = 0;
  std::unique_ptr<Client> client;
  NativeStreamRegistry<kMaximumStreamsPerSession> streams;
};
std::array<NativeSession, kMaximumSessions> g_native_sessions{};
std::uint32_t g_next_native_handle = 1;

NativeSession* findNativeSession(std::uint32_t handle) noexcept {
  if (handle == 0) return nullptr;
  for (auto& session : g_native_sessions) if (session.handle == handle) return &session;
  return nullptr;
}
NativeStream* findNativeStream(NativeSession& session, std::uint32_t handle) noexcept {
  return session.streams.byHandle(handle);
}
NativeStream* findNativeStreamId(NativeSession& session, std::uint64_t id) noexcept {
  return session.streams.byId(id);
}
NativeStream* acquireNativeStream(NativeSession& session, std::uint64_t id, bool bidirectional, bool incoming) noexcept {
  return session.streams.acquire(id, bidirectional, incoming);
}
void retireNativeStreamIfTerminal(NativeSession& session, NativeStream* stream) noexcept {
  session.streams.retireIfTerminal(stream);
}
std::int32_t status(SendResult result) noexcept {
  switch (result) {
    case SendResult::sent: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
    case SendResult::backpressured: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_WOULD_BLOCK;
    case SendResult::too_large: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_TOO_LARGE;
    case SendResult::closed: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_CLOSED;
  }
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
}
std::uint32_t state(State source) noexcept {
  switch (source) {
    case State::opening: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CONNECTING;
    case State::ready: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CONNECTED;
    case State::closing: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CLOSING;
    case State::closed: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_CLOSED;
    case State::failed: return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_FAILED;
  }
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_FAILED;
}
bool equalsIgnoringAsciiCase(const char* value, const char* expected) noexcept {
  if (!value || !expected) return false;
  while (*value && *expected) {
    if (std::tolower(static_cast<unsigned char>(*value++)) != std::tolower(static_cast<unsigned char>(*expected++))) return false;
  }
  return *value == '\0' && *expected == '\0';
}
}  // namespace

extern "C" std::uint32_t defold_webtransport_native_v1_open(const char* url, std::uint32_t url_length,
    const std::uint8_t* certificate_sha256, std::uint32_t certificate_sha256_length,
    std::uint32_t anticipated_incoming_unidirectional_streams,
    std::uint32_t anticipated_incoming_bidirectional_streams) {
  if (!url || url_length == 0 || !certificate_sha256 || certificate_sha256_length != 32) return 0;
  NativeSession* slot = nullptr;
  for (auto& session : g_native_sessions) if (session.handle == 0) { slot = &session; break; }
  if (!slot) return 0;
  std::string owned_url(url, url_length);
  Options options;
  options.url = owned_url;
  options.anticipated_incoming_unidirectional_streams = anticipated_incoming_unidirectional_streams;
  options.anticipated_incoming_bidirectional_streams = anticipated_incoming_bidirectional_streams;
  options.has_certificate_sha256 = true;
  std::copy_n(certificate_sha256, options.certificate_sha256.size(), options.certificate_sha256.data());
  auto client = Client::open(options);
  if (!client) return 0;
  std::uint32_t handle = g_next_native_handle++;
  if (handle == 0) handle = g_next_native_handle++;
  slot->handle = handle;
  slot->client = std::move(client);
  slot->streams.clear();
  return handle;
}
extern "C" std::uint32_t defold_webtransport_native_v1_state(std::uint32_t handle) {
  auto* session = findNativeSession(handle);
  return session ? state(session->client->state()) : DEFOLD_WEBTRANSPORT_NATIVE_V1_STATE_FAILED;
}
extern "C" std::uint32_t defold_webtransport_native_v1_max_datagram_bytes(std::uint32_t handle) {
  auto* session = findNativeSession(handle);
  return session ? static_cast<std::uint32_t>(session->client->maximumDatagramBytes()) : 0;
}
extern "C" std::int32_t defold_webtransport_native_v1_open_bidirectional_stream(std::uint32_t handle, std::uint32_t request_id) {
  auto* session = findNativeSession(handle);
  return !session || request_id == 0 ? DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT
                                     : status(session->client->openBidirectionalStream(request_id));
}
extern "C" std::int32_t defold_webtransport_native_v1_open_unidirectional_stream(std::uint32_t handle, std::uint32_t request_id) {
  auto* session = findNativeSession(handle);
  return !session || request_id == 0 ? DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT
                                     : status(session->client->openUnidirectionalStream(request_id));
}
extern "C" std::int32_t defold_webtransport_native_v1_write_stream(std::uint32_t handle, std::uint32_t stream_handle,
    const std::uint8_t* bytes, std::uint32_t bytes_length, bool fin) {
  auto* session = findNativeSession(handle);
  if (!session || (bytes_length && !bytes)) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  auto* stream = findNativeStream(*session, stream_handle);
  if (!stream || stream->write_terminal) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  const auto result = session->client->writeStream(stream->id, bytes, bytes_length, fin);
  if (result == SendResult::sent && fin) {
    stream->write_terminal = true;
    retireNativeStreamIfTerminal(*session, stream);
  }
  return status(result);
}
extern "C" std::int32_t defold_webtransport_native_v1_reset_stream(std::uint32_t handle, std::uint32_t stream_handle, std::uint32_t code) {
  auto* session = findNativeSession(handle);
  auto* stream = session ? findNativeStream(*session, stream_handle) : nullptr;
  if (!stream || stream->write_terminal) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  const auto result = session->client->resetStream(stream->id, code);
  if (result == SendResult::sent) {
    stream->write_terminal = true;
    retireNativeStreamIfTerminal(*session, stream);
  }
  return status(result);
}
extern "C" std::int32_t defold_webtransport_native_v1_stop_sending(std::uint32_t handle, std::uint32_t stream_handle, std::uint32_t code) {
  auto* session = findNativeSession(handle);
  auto* stream = session ? findNativeStream(*session, stream_handle) : nullptr;
  if (!stream || stream->read_terminal) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  const auto result = session->client->stopSending(stream->id, code);
  if (result == SendResult::sent) {
    stream->read_terminal = true;
    retireNativeStreamIfTerminal(*session, stream);
  }
  return status(result);
}
extern "C" std::int32_t defold_webtransport_native_v1_try_send_datagram(std::uint32_t handle, const std::uint8_t* bytes, std::uint32_t bytes_length) {
  auto* session = findNativeSession(handle);
  return !session || (bytes_length && !bytes) ? DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT
                                              : status(session->client->trySendDatagram(bytes, bytes_length));
}
extern "C" std::int32_t defold_webtransport_native_v1_poll(std::uint32_t handle, std::uint8_t* output, std::uint32_t output_length) {
  auto* session = findNativeSession(handle);
  if (!session || !output || output_length < sizeof(DefoldWebTransportNativeV1PollHeader)) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
poll_next:
  Event event;
  if (!session->client->peek(event)) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_NO_EVENT;
  DefoldWebTransportNativeV1PollHeader header{};
  NativeStream* stream = nullptr;
  bool synthetic_open = false;
  if (event.kind == EventKind::stream_opened || event.kind == EventKind::stream_data) {
    if (event.kind == EventKind::stream_data && findNativeStreamId(*session, event.stream_id) == nullptr &&
        !deherm::webtransport::detail::shouldAcquireUnknownDataStream(event.stream_id)) {
      // A locally-created stream may have retired before a late callback was
      // delivered. Never resurrect it as an incoming stream.
      if (!session->client->consume()) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
      goto poll_next;
    }
    const bool incoming = event.kind == EventKind::stream_data || event.request_id == 0;
    stream = acquireNativeStream(*session, event.stream_id, event.bidirectional, incoming);
    if (!stream) {
      if (!session->client->consume()) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
      session->client->fail("native stream registry is full");
      return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
    }
    synthetic_open = event.kind != EventKind::stream_opened && !stream->announced;
  } else if (event.kind == EventKind::stream_reset || event.kind == EventKind::stream_stop_sending) {
    stream = findNativeStreamId(*session, event.stream_id);
    // A terminal notification may race with local retirement. It no longer has
    // an addressable public stream and is intentionally consumed, not rebound.
    if (!stream) {
      if (!session->client->consume()) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
      goto poll_next;
    }
  }
  if (synthetic_open) {
    header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_OPENED;
    header.flags = DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_INCOMING |
                   (event.bidirectional ? DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL : 0);
    header.stream_handle = stream->handle;
    stream->announced = true;
  } else {
    switch (event.kind) {
      case EventKind::ready: header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_READY; break;
      case EventKind::stream_opened:
        if (event.request_id > std::numeric_limits<std::uint32_t>::max()) {
          if (!session->client->consume()) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
          session->client->fail("native stream request id exceeds the public ABI");
          return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
        }
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_OPENED;
        header.request_id = static_cast<std::uint32_t>(event.request_id);
        header.stream_handle = stream->handle;
        header.flags = openedStreamFlags(event.request_id, event.bidirectional);
        stream->announced = true;
        break;
      case EventKind::stream_data:
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_DATA; header.stream_handle = stream->handle;
        header.flags = event.fin ? DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_FIN : 0;
        header.payload_length = static_cast<std::uint32_t>(event.size); break;
      case EventKind::datagram:
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_DATAGRAM; header.payload_length = static_cast<std::uint32_t>(event.size); break;
      case EventKind::stream_reset:
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_RESET; header.stream_handle = stream->handle; header.code = static_cast<std::int32_t>(event.code); break;
      case EventKind::stream_stop_sending:
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_STOP_SENDING; header.stream_handle = stream->handle; header.code = static_cast<std::int32_t>(event.code); break;
      case EventKind::close:
        header.kind = DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_CLOSE; header.code = static_cast<std::int32_t>(event.code);
        header.payload_length = static_cast<std::uint32_t>(event.size); break;
    }
  }
  header.header_version = DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_VERSION;
  std::memcpy(output, &header, sizeof(header));
  if (header.payload_length > output_length - sizeof(header)) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_BUFFER_TOO_SMALL;
  if (header.payload_length) std::memcpy(output + sizeof(header), event.bytes.data(), header.payload_length);
  if (!synthetic_open && !session->client->consume()) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INTERNAL_ERROR;
  if (!synthetic_open && stream) {
    if (event.kind == EventKind::stream_data && event.fin) stream->read_terminal = true;
    if (event.kind == EventKind::stream_reset) stream->read_terminal = true;
    if (event.kind == EventKind::stream_stop_sending) stream->write_terminal = true;
    retireNativeStreamIfTerminal(*session, stream);
  }
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" std::int32_t defold_webtransport_native_v1_close(std::uint32_t handle, std::uint32_t error_code,
    const char* reason, std::uint32_t reason_length) {
  auto* session = findNativeSession(handle);
  if (!session || (reason_length && !reason)) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  session->client->close(error_code, std::string_view(reason ? reason : "", reason_length));
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" std::int32_t defold_webtransport_native_v1_destroy(std::uint32_t handle) {
  auto* session = findNativeSession(handle);
  if (!session) return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_INVALID_ARGUMENT;
  session->client.reset(); session->streams.clear(); session->handle = 0;
  return DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}

struct DefoldWebTransportSession;
struct PublicStreamRecord {
  DefoldWebTransportSession* session = nullptr;
  std::uint32_t native_handle = 0;
  std::uint32_t token = 0;
};
struct DefoldWebTransportSession {
  std::uint32_t native_handle = 0;
  DefoldWebTransportEventCallback callback = nullptr;
  void* user_data = nullptr;
  std::uint32_t next_request_id = 1;
  bool delivering_callback = false;
  bool destroy_requested = false;
  std::array<PublicStreamRecord, kMaximumStreamsPerSession> streams{};
  std::array<std::uint8_t, kPublicPollBytes> poll{};
};
namespace {
std::array<DefoldWebTransportSession*, kMaximumSessions> g_public_sessions{};
std::uint32_t g_next_public_stream_token = 1;
bool registerPublicSession(DefoldWebTransportSession* session) noexcept {
  for (auto& candidate : g_public_sessions) if (!candidate) { candidate = session; return true; }
  return false;
}
void unregisterPublicSession(DefoldWebTransportSession* session) noexcept {
  for (auto& candidate : g_public_sessions) if (candidate == session) candidate = nullptr;
}
void destroyPublicSessionNow(DefoldWebTransportSession* session) noexcept {
  if (!session) return;
  unregisterPublicSession(session);
  if (session->native_handle) (void)defold_webtransport_native_v1_destroy(session->native_handle);
  delete session;
}
PublicStreamRecord* publicStreamRecord(DefoldWebTransportStream* token) noexcept {
  const auto value = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(token));
  if (value == 0) return nullptr;
  for (auto* session : g_public_sessions) {
    if (!session) continue;
    for (auto& stream : session->streams) if (stream.token == value) return &stream;
  }
  return nullptr;
}
bool publicTokenInUse(const std::uint32_t token) noexcept {
  return publicStreamRecord(reinterpret_cast<DefoldWebTransportStream*>(static_cast<std::uintptr_t>(token))) != nullptr;
}
DefoldWebTransportStream* publicStream(DefoldWebTransportSession& session, std::uint32_t handle) noexcept {
  for (auto& stream : session.streams) {
    if (stream.token != 0 && stream.native_handle == handle) {
      return reinterpret_cast<DefoldWebTransportStream*>(static_cast<std::uintptr_t>(stream.token));
    }
  }
  for (auto& stream : session.streams) {
    if (stream.token == 0) {
      std::uint32_t token = g_next_public_stream_token;
      for (;;) {
        if (++g_next_public_stream_token == 0) g_next_public_stream_token = 1;
        if (!publicTokenInUse(token)) break;
        token = g_next_public_stream_token;
      }
      stream = {&session, handle, token};
      return reinterpret_cast<DefoldWebTransportStream*>(static_cast<std::uintptr_t>(token));
    }
  }
  return nullptr;
}
void deliverPublic(DefoldWebTransportSession& session) noexcept {
  const auto* header = reinterpret_cast<const DefoldWebTransportNativeV1PollHeader*>(session.poll.data());
  DefoldWebTransportEvent event{};
  event.struct_size = sizeof(event); event.session = &session; event.code = static_cast<std::uint32_t>(header->code);
  event.bytes = {session.poll.data() + sizeof(*header), header->payload_length};
  event.fin = (header->flags & DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_FIN) != 0;
  event.bidirectional = (header->flags & DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_BIDIRECTIONAL) != 0;
  event.incoming = (header->flags & DEFOLD_WEBTRANSPORT_NATIVE_V1_FLAG_STREAM_INCOMING) != 0;
  std::array<char, 256> reason{};
  switch (header->kind) {
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_READY: event.type = DEFOLD_WEBTRANSPORT_EVENT_READY; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_OPENED: event.type = DEFOLD_WEBTRANSPORT_EVENT_STREAM; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_DATA: event.type = DEFOLD_WEBTRANSPORT_EVENT_DATA; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_DATAGRAM: event.type = DEFOLD_WEBTRANSPORT_EVENT_DATAGRAM; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_RESET: event.type = DEFOLD_WEBTRANSPORT_EVENT_STREAM_RESET; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_STREAM_STOP_SENDING: event.type = DEFOLD_WEBTRANSPORT_EVENT_STOP_SENDING; break;
    case DEFOLD_WEBTRANSPORT_NATIVE_V1_EVENT_CLOSE:
      event.type = DEFOLD_WEBTRANSPORT_EVENT_CLOSE;
      std::memcpy(reason.data(), event.bytes.data, std::min(event.bytes.size, reason.size() - 1)); event.reason = reason.data(); break;
    default: return;
  }
  if (header->stream_handle) {
    event.stream = publicStream(session, header->stream_handle);
    if (!event.stream) { (void)defold_webtransport_native_v1_close(session.native_handle, 2, "stream registry full", 20); return; }
  }
  session.delivering_callback = true;
  session.callback(session.user_data, &event);
  session.delivering_callback = false;
}
}  // namespace

extern "C" DefoldWebTransportSession* defold_webtransport_connect(const DefoldWebTransportOptions* options) {
  if (!options || options->abi_version != DEFOLD_WEBTRANSPORT_CLIENT_ABI_VERSION || options->struct_size < sizeof(*options) || !options->url || !options->callback) return nullptr;
  if (options->certificate_hash_count > DEFOLD_WEBTRANSPORT_MAX_CERTIFICATE_HASHES) return nullptr;
  if (options->certificate_hash_count != 0 && options->certificate_hashes == nullptr) return nullptr;
  const DefoldWebTransportCertificateHash* accepted = nullptr;
  for (std::size_t i = 0; i < options->certificate_hash_count; ++i) {
    const auto& hash = options->certificate_hashes[i];
    if ((equalsIgnoringAsciiCase(hash.algorithm, "sha-256") || equalsIgnoringAsciiCase(hash.algorithm, "sha256")) && hash.value.data && hash.value.size == 32) { accepted = &hash; break; }
  }
  const auto url_length = std::strlen(options->url);
  if (!accepted || url_length > std::numeric_limits<std::uint32_t>::max()) return nullptr;
  const auto handle = defold_webtransport_native_v1_open(
      options->url, static_cast<std::uint32_t>(url_length), accepted->value.data, 32,
      options->anticipated_incoming_unidirectional_streams,
      options->anticipated_incoming_bidirectional_streams);
  if (!handle) return nullptr;
  auto session = std::unique_ptr<DefoldWebTransportSession>(new (std::nothrow) DefoldWebTransportSession);
  if (!session) { (void)defold_webtransport_native_v1_destroy(handle); return nullptr; }
  session->native_handle = handle; session->callback = options->callback; session->user_data = options->user_data;
  if (!registerPublicSession(session.get())) { (void)defold_webtransport_native_v1_destroy(handle); return nullptr; }
  return session.release();
}
extern "C" void defold_webtransport_destroy(DefoldWebTransportSession* session) {
  if (!session) return;
  if (session->delivering_callback) { session->destroy_requested = true; unregisterPublicSession(session); return; }
  destroyPublicSessionNow(session);
}
extern "C" void defold_webtransport_close(DefoldWebTransportSession* session, std::uint32_t code, const char* reason) {
  if (!session) return; const char* value = reason ? reason : "";
  (void)defold_webtransport_native_v1_close(session->native_handle, code, value, static_cast<std::uint32_t>(std::strlen(value)));
}
extern "C" bool defold_webtransport_create_bidirectional_stream(DefoldWebTransportSession* session) {
  if (!session) return false; const auto request = session->next_request_id++;
  return defold_webtransport_native_v1_open_bidirectional_stream(session->native_handle, request) == 0;
}
extern "C" bool defold_webtransport_create_unidirectional_stream(DefoldWebTransportSession* session) {
  if (!session) return false; const auto request = session->next_request_id++;
  return defold_webtransport_native_v1_open_unidirectional_stream(session->native_handle, request) == 0;
}
extern "C" bool defold_webtransport_stream_write(DefoldWebTransportStream* stream, DefoldWebTransportBytes bytes, bool fin) {
  auto* record = publicStreamRecord(stream);
  return record && bytes.size <= UINT32_MAX &&
         defold_webtransport_native_v1_write_stream(record->session->native_handle, record->native_handle, bytes.data, static_cast<std::uint32_t>(bytes.size), fin) == 0;
}
extern "C" bool defold_webtransport_stream_reset(DefoldWebTransportStream* stream, std::uint32_t code) {
  auto* record = publicStreamRecord(stream);
  return record && defold_webtransport_native_v1_reset_stream(
      record->session->native_handle, record->native_handle, code) ==
      DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" bool defold_webtransport_stream_stop_sending(DefoldWebTransportStream* stream, std::uint32_t code) {
  auto* record = publicStreamRecord(stream);
  return record && defold_webtransport_native_v1_stop_sending(
      record->session->native_handle, record->native_handle, code) ==
      DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK;
}
extern "C" void defold_webtransport_stream_release(DefoldWebTransportStream* stream) {
  auto* record = publicStreamRecord(stream);
  if (record) *record = {};
}
extern "C" bool defold_webtransport_send_datagram(DefoldWebTransportSession* session, DefoldWebTransportBytes bytes) {
  return session && bytes.size <= UINT32_MAX && defold_webtransport_native_v1_try_send_datagram(session->native_handle, bytes.data, static_cast<std::uint32_t>(bytes.size)) == 0;
}
extern "C" std::size_t defold_webtransport_max_datagram_size(const DefoldWebTransportSession* session) {
  return session ? defold_webtransport_native_v1_max_datagram_bytes(session->native_handle) : 0;
}
extern "C" std::size_t defold_webtransport_pump_callbacks(void) {
  std::size_t delivered = 0;
  for (auto* session : g_public_sessions) {
    if (!session) continue;
    for (;;) {
      const auto result = defold_webtransport_native_v1_poll(session->native_handle, session->poll.data(), static_cast<std::uint32_t>(session->poll.size()));
      if (result == DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_NO_EVENT) break;
      if (result != DEFOLD_WEBTRANSPORT_NATIVE_V1_STATUS_OK) { (void)defold_webtransport_native_v1_close(session->native_handle, 2, "public poll failed", 18); break; }
      deliverPublic(*session); ++delivered;
      if (session->destroy_requested) { destroyPublicSessionNow(session); break; }
    }
  }
  return delivered;
}
