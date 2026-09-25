#include <deherm/webtransport/client.hpp>

#include "bounded_payload_ring.hpp"
#include "control_capsule_parser.hpp"
#include "transport_policy.hpp"
#include "url.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <utility>

#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <mbedtls/x509_crt.h>

extern "C" {
#include <h3zero_common.h>
#include <pico_webtransport.h>
#include <picoquic.h>
#include <picoquic_config.h>
#include <picoquic_packet_loop.h>
#include <picosocks.h>
#include <picotls.h>
}

namespace deherm::webtransport {
namespace {

using detail::BoundedPayloadRing;

constexpr std::size_t kCloseReasonBytes = 255;
constexpr std::size_t kConservativeQuicDatagramBytes = 1200;

enum class CommandKind : std::uint8_t {
  open_bidirectional,
  open_unidirectional,
  stream_write,
  stream_reset,
  stream_stop_sending,
  datagram,
  close,
};

struct Command {
  CommandKind kind = CommandKind::close;
  std::uint64_t request_id = 0;
  std::uint64_t stream_id = 0;
  std::uint64_t code = 0;
  bool fin = false;
  std::size_t size = 0;
};

struct EventRecord {
  EventKind kind = EventKind::close;
  std::uint64_t request_id = 0;
  std::uint64_t stream_id = 0;
  bool bidirectional = false;
  bool fin = false;
  std::uint64_t code = 0;
  std::size_t size = 0;
};

struct SignatureVerifier {
  mbedtls_x509_crt certificate;

  SignatureVerifier() { mbedtls_x509_crt_init(&certificate); }
  ~SignatureVerifier() { mbedtls_x509_crt_free(&certificate); }
};

int verifyPinnedSignature(void* context, const std::uint16_t algorithm, const ptls_iovec_t data,
                          const ptls_iovec_t signature) {
  auto* verifier = static_cast<SignatureVerifier*>(context);
  if (data.base == nullptr && data.len == 0 && signature.base == nullptr && signature.len == 0) {
    delete verifier;
    return 0;
  }
  if (verifier == nullptr || algorithm != PTLS_SIGNATURE_ECDSA_SECP256R1_SHA256) {
    delete verifier;
    return PTLS_ALERT_DECRYPT_ERROR;
  }

  std::array<std::uint8_t, 32> digest{};
  const int hash_result = mbedtls_sha256(data.base, data.len, digest.data(), 0);
  const int valid = hash_result == 0
                        ? mbedtls_pk_verify(&verifier->certificate.pk, MBEDTLS_MD_SHA256, digest.data(), digest.size(),
                                            signature.base, signature.len)
                        : hash_result;
  delete verifier;
  return valid == 0 ? 0 : PTLS_ALERT_DECRYPT_ERROR;
}

struct PinVerifier {
  ptls_verify_certificate_t base{};
  std::array<std::uint8_t, kCertificateSha256Bytes> expected{};
};

int verifyPinnedCertificate(ptls_verify_certificate_t* raw, ptls_t*, const char*,
                            int (**verify_signature)(void*, std::uint16_t, ptls_iovec_t, ptls_iovec_t),
                            void** verify_context, ptls_iovec_t* certificates, const std::size_t certificate_count) {
  auto* pin = reinterpret_cast<PinVerifier*>(raw);
  if (certificate_count == 0 || certificates == nullptr || certificates[0].base == nullptr) {
    return PTLS_ALERT_BAD_CERTIFICATE;
  }

  std::array<std::uint8_t, kCertificateSha256Bytes> actual{};
  if (mbedtls_sha256(certificates[0].base, certificates[0].len, actual.data(), 0) != 0) {
    return PTLS_ALERT_BAD_CERTIFICATE;
  }
  std::uint8_t mismatch = 0;
  for (std::size_t index = 0; index < actual.size(); ++index) mismatch |= actual[index] ^ pin->expected[index];
  if (mismatch != 0) {
    return PTLS_ALERT_BAD_CERTIFICATE;
  }

  auto* signature_context = new (std::nothrow) SignatureVerifier;
  if (signature_context == nullptr) return PTLS_ERROR_NO_MEMORY;
  if (mbedtls_x509_crt_parse_der(&signature_context->certificate, certificates[0].base, certificates[0].len) != 0 ||
      mbedtls_pk_can_do(&signature_context->certificate.pk, MBEDTLS_PK_ECDSA) == 0) {
    delete signature_context;
    return PTLS_ALERT_UNSUPPORTED_CERTIFICATE;
  }
  *verify_signature = verifyPinnedSignature;
  *verify_context = signature_context;
  return 0;
}

constexpr std::uint16_t kPinnedAlgorithms[] = {PTLS_SIGNATURE_ECDSA_SECP256R1_SHA256, UINT16_MAX};

static_assert(detail::kH3WebTransportApplicationErrorFirst == H3ZERO_WEBTRANSPORT_APPLICATION_ERROR_FIRST);
static_assert(detail::kH3WebTransportApplicationErrorLast == H3ZERO_WEBTRANSPORT_APPLICATION_ERROR_LAST);

}  // namespace

class Client::Impl final {
 public:
  explicit Impl(detail::ParsedUrl url) : url_(std::move(url)) {
    pin_verifier_.base.cb = verifyPinnedCertificate;
    pin_verifier_.base.algos = kPinnedAlgorithms;
    std::memset(&loop_parameters_, 0, sizeof(loop_parameters_));
    loop_parameters_.dest_if = -1;
  }

  ~Impl() { shutdown(); }

  bool start(const Options& options) noexcept {
    const auto incoming_credits = detail::incomingStreamCredits(
        options.anticipated_incoming_unidirectional_streams,
        options.anticipated_incoming_bidirectional_streams);
    if (!incoming_credits.valid) return false;
    picoquic_quic_config_t config;
    picoquic_config_init(&config);
    int result = picoquic_config_set_option(&config, picoquic_option_ALPN, "h3");
    if (result == 0 && !options.root_trust_file.empty()) {
      root_trust_file_.assign(options.root_trust_file);
      result = picoquic_config_set_option(&config, picoquic_option_ROOT_TRUST_FILE, root_trust_file_.c_str());
    }
    if (result == 0) {
      quic_ = picoquic_create_and_configure(&config, nullptr, nullptr, picoquic_current_time(), nullptr);
      result = quic_ == nullptr ? -1 : 0;
    }
    picoquic_config_clear(&config);
    if (result != 0) return failStart();

    // Browser hints become concrete QUIC credits. Keep both directions at the
    // WebTransport baseline without advertising more streams than the fixed
    // native registry can represent in total.
    result = picoquic_set_default_tp_value(quic_, picoquic_tp_initial_max_streams_bidi,
                                           incoming_credits.bidirectional);
    if (result == 0) {
      result = picoquic_set_default_tp_value(quic_, picoquic_tp_initial_max_streams_uni,
                                             incoming_credits.unidirectional);
    }
    if (result != 0) return failStart();

    if (options.has_certificate_sha256) {
      pin_verifier_.expected = options.certificate_sha256;
      picoquic_set_verify_certificate_callback(quic_, &pin_verifier_.base, nullptr);
    } else {
      // Picoquic otherwise retains a compatibility fail-open behavior when no
      // root store is configured.  The native game must never inherit that.
      picoquic_set_client_cert_verification_policy(quic_, 1);
    }

    sockaddr_storage address{};
    int is_name = 0;
    result = picoquic_get_server_address(url_.host.c_str(), url_.port, &address, &is_name);
    const char* sni = url_.host.c_str();
    if (result == 0) {
      result = picowt_prepare_client_cnx(quic_, reinterpret_cast<sockaddr*>(&address), &connection_, &h3_context_,
                                         &control_stream_, picoquic_current_time(), sni);
    }
    if (result == 0) {
      result = picowt_connect(connection_, h3_context_, control_stream_, url_.authority.c_str(), url_.path.c_str(),
                              applicationCallback, this, nullptr);
    }
    if (result == 0) result = picoquic_start_client_cnx(connection_);
    if (result != 0) return failStart();

    network_thread_ = picoquic_start_network_thread(quic_, &loop_parameters_, packetLoopCallback, this, &result);
    if (network_thread_ == nullptr || result != 0) return failStart();
    return true;
  }

  State state() const noexcept { return state_.load(std::memory_order_acquire); }
  std::size_t maximumDatagramBytes() const noexcept { return datagram_max_.load(std::memory_order_acquire); }

  SendResult openStream(const std::uint64_t request_id, const bool bidirectional) noexcept {
    return queueCommand(bidirectional ? CommandKind::open_bidirectional : CommandKind::open_unidirectional,
                        [&](Command& command) { command.request_id = request_id; });
  }

  SendResult writeStream(const std::uint64_t stream_id, const std::uint8_t* bytes, const std::size_t size,
                         const bool fin) noexcept {
    if (size > kMaximumReliableBytes || (size != 0 && bytes == nullptr)) return SendResult::too_large;
    return queueCommand(CommandKind::stream_write, [&](Command& command) {
      command.stream_id = stream_id;
      command.fin = fin;
    }, bytes, size);
  }

  SendResult resetStream(const std::uint64_t stream_id, const std::uint64_t code) noexcept {
    return queueCommand(CommandKind::stream_reset, [&](Command& command) {
      command.stream_id = stream_id;
      command.code = code;
    });
  }

  SendResult stopSending(const std::uint64_t stream_id, const std::uint64_t code) noexcept {
    return queueCommand(CommandKind::stream_stop_sending, [&](Command& command) {
      command.stream_id = stream_id;
      command.code = code;
    });
  }

  template <typename Writer>
  SendResult queueCommand(const CommandKind kind, Writer&& writer, const std::uint8_t* bytes = nullptr,
                          const std::size_t size = 0) noexcept {
    if (state() != State::ready) return SendResult::closed;
    Command command;
    command.kind = kind;
    command.size = size;
    writer(command);
    const bool queued = commands_.push(command, bytes);
    if (!queued) return SendResult::backpressured;
    wake();
    return SendResult::sent;
  }

  SendResult sendDatagram(const std::uint8_t* bytes, const std::size_t size) noexcept {
    const auto maximum = maximumDatagramBytes();
    if (size > maximum || size > kMaximumDatagramBytes || (size != 0 && bytes == nullptr)) return SendResult::too_large;
    if (state() != State::ready) return SendResult::closed;
    bool expected = false;
    if (!datagram_queued_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
      return SendResult::backpressured;
    }
    Command command;
    command.kind = CommandKind::datagram;
    command.size = size;
    const bool queued = commands_.push(command, bytes);
    if (!queued) {
      datagram_queued_.store(false, std::memory_order_release);
      return SendResult::backpressured;
    }
    wake();
    return SendResult::sent;
  }

  bool poll(Event& target) noexcept {
    EventRecord source;
    if (!events_.pop(source, target.bytes.data(), target.bytes.size())) return false;
    target.kind = source.kind;
    target.request_id = source.request_id;
    target.stream_id = source.stream_id;
    target.bidirectional = source.bidirectional;
    target.fin = source.fin;
    target.code = source.code;
    target.size = source.size;
    return true;
  }

  bool peek(Event& target) noexcept {
    EventRecord source;
    if (!events_.peek(source, target.bytes.data(), target.bytes.size())) return false;
    target.kind = source.kind;
    target.request_id = source.request_id;
    target.stream_id = source.stream_id;
    target.bidirectional = source.bidirectional;
    target.fin = source.fin;
    target.code = source.code;
    target.size = source.size;
    return true;
  }

  bool consume() noexcept { return events_.discard(); }

  void requestClose(const std::uint32_t code, const std::string_view reason) noexcept {
    if (!detail::beginClosing(state_)) return;
    const auto size = std::min(reason.size(), kCloseReasonBytes);
    Command command;
    command.kind = CommandKind::close;
    command.code = code;
    command.size = size;
    const bool queued = commands_.push(command, reinterpret_cast<const std::uint8_t*>(reason.data()));
    if (!queued) {
      emitFailure("close command queue is full");
      return;
    }
    wake();
  }

  void requestFailure(const std::string_view reason) noexcept { emitFailure(reason); }

 private:
  bool failStart() noexcept {
    state_.store(State::failed, std::memory_order_release);
    shutdown();
    return false;
  }

  void wake() noexcept {
    auto* thread = network_thread_;
    if (thread != nullptr) (void)picoquic_wake_up_network_thread(thread);
  }

  void shutdown() noexcept {
    if (network_thread_ != nullptr) {
      picoquic_delete_network_thread(network_thread_);
      network_thread_ = nullptr;
    }
    if (h3_context_ != nullptr && connection_ != nullptr) {
      h3zero_callback_delete_context(connection_, h3_context_);
      h3_context_ = nullptr;
      control_stream_ = nullptr;
    }
    if (quic_ != nullptr) {
      picoquic_free(quic_);
      quic_ = nullptr;
      connection_ = nullptr;
    }
    if (state() != State::failed) state_.store(State::closed, std::memory_order_release);
  }

  static int packetLoopCallback(picoquic_quic_t*, const picoquic_packet_loop_cb_enum event, void* context, void*) {
    auto* self = static_cast<Impl*>(context);
    switch (event) {
      case picoquic_packet_loop_wake_up:
        self->processCommands();
        break;
      case picoquic_packet_loop_after_receive:
      case picoquic_packet_loop_after_send:
        if (self->connection_ != nullptr && picoquic_get_cnx_state(self->connection_) == picoquic_state_disconnected) {
          const auto remote_error = picoquic_get_remote_error(self->connection_);
          std::uint32_t application_error = 0;
          if (remote_error == 0 || remote_error == H3ZERO_NO_ERROR) {
            self->emitGracefulClose(0, "QUIC connection closed");
          } else if (detail::h3ErrorToWebTransportApplicationError(remote_error, application_error)) {
            self->emitGracefulClose(application_error, "peer closed WebTransport session");
          } else {
            self->emitFailure("QUIC connection disconnected");
          }
        }
        break;
      case picoquic_packet_loop_ready:
      case picoquic_packet_loop_port_update:
      case picoquic_packet_loop_time_check:
      case picoquic_packet_loop_system_call_duration:
      case picoquic_packet_loop_alt_port:
        break;
    }
    return 0;
  }

  static int applicationCallback(picoquic_cnx_t* connection, std::uint8_t* bytes, const std::size_t size,
                                 const picohttp_call_back_event_t event, h3zero_stream_ctx_t* stream, void* context) {
    auto* self = static_cast<Impl*>(context);
    switch (event) {
      case picohttp_callback_connecting:
        return 0;
      case picohttp_callback_connect_accepted:
        return self->onConnected();
      case picohttp_callback_connect_refused:
        self->emitConnectRefused();
        return -1;
      case picohttp_callback_post_data:
      case picohttp_callback_post_fin:
        if (stream == nullptr) return -1;
        if (stream == self->control_stream_) {
          return self->processControlCapsules(bytes, size, event == picohttp_callback_post_fin);
        }
        self->emitData(EventKind::stream_data, stream->stream_id, event == picohttp_callback_post_fin, bytes, size);
        return 0;
      case picohttp_callback_post_datagram:
        self->emitData(EventKind::datagram, 0, false, bytes, size);
        return 0;
      case picohttp_callback_provide_datagram:
        return self->provideDatagram(bytes, size);
      case picohttp_callback_reset:
        if (stream == nullptr) return -1;
        if (stream == self->control_stream_) {
          self->emitFailure("WebTransport control stream was reset");
          return -1;
        }
        {
          std::uint32_t application_error = 0;
          if (!detail::h3ErrorToWebTransportApplicationError(
                  picoquic_get_remote_stream_error(connection, stream->stream_id), application_error)) {
            self->emitFailure("peer reset used an invalid WebTransport application error");
            return -1;
          }
          self->emitStreamControl(EventKind::stream_reset, 0, stream->stream_id, application_error);
        }
        return 0;
      case picohttp_callback_stop_sending:
        if (stream == nullptr) return -1;
        if (stream == self->control_stream_) {
          self->emitFailure("WebTransport control stream received stop-sending");
          return -1;
        }
        {
          std::uint32_t application_error = 0;
          if (!detail::h3ErrorToWebTransportApplicationError(
                  picoquic_get_remote_stream_error(connection, stream->stream_id), application_error)) {
            self->emitFailure("peer stop-sending used an invalid WebTransport application error");
            return -1;
          }
          self->emitStreamControl(EventKind::stream_stop_sending, 0, stream->stream_id, application_error);
        }
        return 0;
      case picohttp_callback_drain:
        self->emitGracefulClose(0, "WebTransport session drained");
        return 0;
      case picohttp_callback_deregister:
      case picohttp_callback_free:
        return 0;
      case picohttp_callback_provide_data:
      case picohttp_callback_get:
      case picohttp_callback_post:
      case picohttp_callback_connect:
        (void)connection;
        return -1;
    }
    return -1;
  }

  int onConnected() noexcept {
    const auto* remote = picoquic_get_transport_parameters(connection_, 0);
    std::size_t maximum = 0;
    if (remote != nullptr && remote->max_datagram_frame_size > 1) {
      maximum = std::min<std::size_t>(remote->max_datagram_frame_size - 1, kConservativeQuicDatagramBytes - 1);
    }
    datagram_max_.store(maximum, std::memory_order_release);
    state_.store(State::ready, std::memory_order_release);
    emitData(EventKind::ready, 0, false, nullptr, 0);
    return 0;
  }

  void emitConnectRefused() noexcept {
    const auto* remote = connection_ == nullptr ? nullptr : picoquic_get_transport_parameters(connection_, 0);
    char detail[kCloseReasonBytes + 1]{};
    std::snprintf(detail, sizeof(detail),
                  "WebTransport CONNECT refused: settings=%u datagram=%llu wt=%llu sessions=%llu connect=%llu "
                  "reset-at=%u max-dgram=%u",
                  h3_context_ == nullptr ? 0U : h3_context_->settings.settings_received,
                  static_cast<unsigned long long>(h3_context_ == nullptr ? 0 : h3_context_->settings.h3_datagram),
                  static_cast<unsigned long long>(h3_context_ == nullptr ? 0 : h3_context_->settings.webtransport_enabled),
                  static_cast<unsigned long long>(h3_context_ == nullptr ? 0 : h3_context_->settings.webtransport_max_sessions),
                  static_cast<unsigned long long>(h3_context_ == nullptr ? 0 : h3_context_->settings.enable_connect_protocol),
                  remote == nullptr ? 0U : remote->is_reset_stream_at_enabled,
                  remote == nullptr ? 0U : remote->max_datagram_frame_size);
    emitFailure(detail);
  }

  int provideDatagram(void* context, const std::size_t available) noexcept {
    if (!pending_datagram_ready_) return 0;
    if (pending_datagram_size_ > available) {
      (void)h3zero_provide_datagram_buffer(context, 0, 1);
      return 0;
    }
    auto* target = h3zero_provide_datagram_buffer(context, pending_datagram_size_, 0);
    if (target == nullptr) return -1;
    std::memcpy(target, pending_datagram_.data(), pending_datagram_size_);
    pending_datagram_ready_ = false;
    pending_datagram_size_ = 0;
    datagram_queued_.store(false, std::memory_order_release);
    return 0;
  }

  int processControlCapsules(const std::uint8_t* bytes, const std::size_t size, const bool fin) noexcept {
    const bool valid = control_capsules_.feed(bytes, size, fin, [this](const detail::ControlCapsuleEvent& event) {
      if (event.kind == detail::ControlCapsuleKind::close) {
        emitGracefulClose(event.code,
                          std::string_view(reinterpret_cast<const char*>(event.reason.data()), event.reason_size));
      }
      // DRAIN_WEBTRANSPORT_SESSION is advisory. Picoquic also reports the
      // eventual drain lifecycle callback; it is not an application stream.
    });
    if (!valid) {
      emitFailure("malformed WebTransport control capsule");
      return -1;
    }
    if (fin) emitGracefulClose(0, "WebTransport control stream closed");
    return 0;
  }

  void processCommands() noexcept {
    Command command;
    while (commands_.pop(command, command_scratch_.data(), command_scratch_.size())) {
      if (connection_ == nullptr || control_stream_ == nullptr) {
        emitFailure("native WebTransport context is unavailable");
        return;
      }
      if (command.kind == CommandKind::open_bidirectional || command.kind == CommandKind::open_unidirectional) {
        const bool bidirectional = command.kind == CommandKind::open_bidirectional;
        auto* stream = picowt_create_local_stream(connection_, bidirectional ? 1 : 0, h3_context_,
                                                   control_stream_->stream_id);
        if (stream == nullptr) {
          emitFailure("failed to open local WebTransport stream");
          return;
        }
        emitStreamControl(EventKind::stream_opened, command.request_id, stream->stream_id, 0);
      } else if (command.kind == CommandKind::stream_write) {
        auto* stream = h3zero_find_stream(h3_context_, command.stream_id);
        if (stream == nullptr ||
            picoquic_add_to_stream_with_ctx(connection_, command.stream_id, command_scratch_.data(), command.size,
                                            command.fin ? 1 : 0, stream) != 0) {
          emitStreamControl(static_cast<EventKind>(detail::streamFailureEventKind(detail::StreamCommandFailure::write)),
                            0, command.stream_id, 2);
          continue;
        }
      } else if (command.kind == CommandKind::stream_reset) {
        auto* stream = h3zero_find_stream(h3_context_, command.stream_id);
        const auto* remote = picoquic_get_transport_parameters(connection_, 0);
        std::uint64_t h3_error = 0;
        int reset_result = -1;
        if (stream != nullptr && detail::webTransportApplicationErrorToH3(command.code, h3_error)) {
          if (detail::resetMode(remote != nullptr && remote->is_reset_stream_at_enabled != 0) ==
              detail::ResetMode::reliable) {
            reset_result = picowt_reset_stream(connection_, stream, h3_error);
          } else {
            reset_result = picoquic_reset_stream(connection_, stream->stream_id, h3_error);
            if (reset_result == 0) stream->ps.stream_state.is_fin_sent = 1;
          }
        }
        if (reset_result != 0) {
          emitStreamControl(static_cast<EventKind>(detail::streamFailureEventKind(detail::StreamCommandFailure::reset)),
                            0, command.stream_id, command.code);
          continue;
        }
      } else if (command.kind == CommandKind::stream_stop_sending) {
        std::uint64_t h3_error = 0;
        if (!detail::webTransportApplicationErrorToH3(command.code, h3_error) ||
            picoquic_stop_sending(connection_, command.stream_id, h3_error) != 0) {
          emitStreamControl(
              static_cast<EventKind>(detail::streamFailureEventKind(detail::StreamCommandFailure::stop_sending)),
              0, command.stream_id, command.code);
          continue;
        }
      } else if (command.kind == CommandKind::datagram) {
        if (pending_datagram_ready_) {
          datagram_queued_.store(false, std::memory_order_release);
          emitFailure("datagram admission invariant failed");
          return;
        }
        pending_datagram_size_ = command.size;
        pending_datagram_ready_ = true;
        if (command.size != 0) std::memcpy(pending_datagram_.data(), command_scratch_.data(), command.size);
        if (h3zero_set_datagram_ready(connection_, control_stream_->stream_id) != 0) {
          pending_datagram_ready_ = false;
          pending_datagram_size_ = 0;
          datagram_queued_.store(false, std::memory_order_release);
          emitFailure("failed to schedule WebTransport datagram");
          return;
        }
      } else {
        const std::string reason(reinterpret_cast<const char*>(command_scratch_.data()), command.size);
        const auto close_code = static_cast<std::uint32_t>(command.code);
        std::uint64_t h3_error = 0;
        if (!detail::webTransportApplicationErrorToH3(close_code, h3_error)) {
          emitFailure("local close used an invalid WebTransport application error");
          return;
        }
        (void)picowt_send_close_session_message(connection_, control_stream_, close_code, reason.c_str());
        (void)picoquic_close_ex(connection_, h3_error, reason.c_str());
        emitGracefulClose(close_code, reason);
        return;
      }
    }
  }

  void emitData(const EventKind kind, const std::uint64_t stream_id, const bool fin, const std::uint8_t* bytes,
                const std::size_t size) noexcept {
    if (size > kMaximumReliableBytes) {
      emitFailure("native event exceeds fixed limit");
      return;
    }
    EventRecord event;
    event.kind = kind;
    event.stream_id = stream_id;
    event.bidirectional = (stream_id & 2U) == 0;
    event.fin = fin;
    event.size = size;
    const bool queued = events_.push(event, bytes, 1, kCloseReasonBytes);
    if (!queued && kind != EventKind::datagram) emitFailure("native event queue is full");
  }

  void emitStreamControl(const EventKind kind, const std::uint64_t request_id, const std::uint64_t stream_id,
                         const std::uint64_t code) noexcept {
    EventRecord event;
    event.kind = kind;
    event.request_id = request_id;
    event.stream_id = stream_id;
    event.bidirectional = (stream_id & 2U) == 0;
    event.code = code;
    const bool queued = events_.push(event, nullptr, 1, kCloseReasonBytes);
    if (!queued) emitFailure("native event queue is full");
  }

  void emitGracefulClose(const std::uint32_t code, const std::string_view reason) noexcept {
    emitTerminal(State::closed, code, reason);
  }

  void emitFailure(const std::string_view reason) noexcept { emitTerminal(State::failed, 2, reason); }

  void emitTerminal(const State terminal, const std::uint32_t code, const std::string_view reason) noexcept {
    bool expected = false;
    if (!close_emitted_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
    const auto size = std::min(reason.size(), kCloseReasonBytes);
    EventRecord event;
    event.kind = EventKind::close;
    event.fin = true;
    event.code = code;
    event.size = size;
    const bool published = detail::publishTerminalState(state_, terminal, [&] {
      return events_.push(event, reinterpret_cast<const std::uint8_t*>(reason.data()));
    });
    if (!published) close_emitted_.store(false, std::memory_order_release);
  }

  detail::ParsedUrl url_;
  std::string root_trust_file_;
  PinVerifier pin_verifier_{};
  picoquic_quic_t* quic_ = nullptr;
  picoquic_cnx_t* connection_ = nullptr;
  h3zero_callback_ctx_t* h3_context_ = nullptr;
  h3zero_stream_ctx_t* control_stream_ = nullptr;
  picoquic_network_thread_ctx_t* network_thread_ = nullptr;
  picoquic_packet_loop_param_t loop_parameters_{};

  std::atomic<State> state_{State::opening};
  std::atomic<std::size_t> datagram_max_{0};
  std::atomic<bool> close_emitted_{false};
  detail::ControlCapsuleParser control_capsules_;
  std::atomic<bool> datagram_queued_{false};
  BoundedPayloadRing<Command, kDescriptorCapacity, kCommandByteCapacity> commands_;
  BoundedPayloadRing<EventRecord, kDescriptorCapacity, kEventByteCapacity> events_;
  std::array<std::uint8_t, kMaximumReliableBytes> command_scratch_{};

  std::size_t pending_datagram_size_ = 0;
  bool pending_datagram_ready_ = false;
  std::array<std::uint8_t, kConservativeQuicDatagramBytes> pending_datagram_{};
};

Client::Client(std::unique_ptr<Impl> impl) noexcept : impl_(std::move(impl)) {}

std::size_t Client::fixedStorageBytes() noexcept { return sizeof(Impl); }

std::unique_ptr<Client> Client::open(const Options& options) {
  if (!options.has_certificate_sha256 && options.root_trust_file.empty()) return nullptr;
  detail::ParsedUrl url;
  if (!detail::parseHttpsUrl(options.url, url)) return nullptr;
  auto impl = std::make_unique<Impl>(std::move(url));
  if (!impl->start(options)) return nullptr;
  return std::unique_ptr<Client>(new Client(std::move(impl)));
}

Client::~Client() = default;
State Client::state() const noexcept { return impl_->state(); }
std::size_t Client::maximumDatagramBytes() const noexcept { return impl_->maximumDatagramBytes(); }

SendResult Client::openBidirectionalStream(const std::uint64_t request_id) noexcept {
  return impl_->openStream(request_id, true);
}

SendResult Client::openUnidirectionalStream(const std::uint64_t request_id) noexcept {
  return impl_->openStream(request_id, false);
}

SendResult Client::writeStream(const std::uint64_t stream_id, const std::uint8_t* bytes, const std::size_t size,
                               const bool fin) noexcept {
  return impl_->writeStream(stream_id, bytes, size, fin);
}

SendResult Client::resetStream(const std::uint64_t stream_id, const std::uint64_t code) noexcept {
  return impl_->resetStream(stream_id, code);
}

SendResult Client::stopSending(const std::uint64_t stream_id, const std::uint64_t code) noexcept {
  return impl_->stopSending(stream_id, code);
}

SendResult Client::trySendDatagram(const std::uint8_t* bytes, const std::size_t size) noexcept {
  return impl_->sendDatagram(bytes, size);
}

bool Client::poll(Event& event) noexcept { return impl_->poll(event); }
bool Client::peek(Event& event) noexcept { return impl_->peek(event); }
bool Client::consume() noexcept { return impl_->consume(); }
void Client::close(const std::uint32_t code, const std::string_view reason) noexcept { impl_->requestClose(code, reason); }
void Client::fail(const std::string_view reason) noexcept { impl_->requestFailure(reason); }

}  // namespace deherm::webtransport
