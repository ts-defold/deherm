#pragma once

#if !defined(DEHERM_HERMES_DEBUGGER) && __has_include(<defold_hermes/generated_runtime_variant.h>)
#include <defold_hermes/generated_runtime_variant.h>
#endif
#ifndef DEHERM_HERMES_DEBUGGER
#define DEHERM_HERMES_DEBUGGER 0
#endif
#include <defold_hermes/runtime.hpp>

#include <cstdint>

#if DEHERM_HERMES_DEBUGGER

#include <dmsdk/dlib/socket.h>

#include <algorithm>
#include <array>
#include <deque>
#include <string>

namespace defold_hermes {

/**
 * Development-only loopback transport for raw CDP JSON. The Node CLI owns
 * HTTP/WebSocket discovery; this engine-side client performs bounded,
 * nonblocking newline framing at the extension update safe point.
 */
class InspectorClient {
 public:
  ~InspectorClient() { close(); }

  InspectorClient() = default;
  InspectorClient(const InspectorClient&) = delete;
  InspectorClient& operator=(const InspectorClient&) = delete;

  void start(uint16_t port) {
    if (port_ == port) return;
    disconnect();
    port_ = port;
    retryFrames_ = 0;
  }

  void bindRuntime(Runtime* runtime) {
    if (runtime_ == runtime) return;
    if (runtime_ && inspectorOpen_) runtime_->closeInspector();
    runtime_ = runtime;
    inspectorOpen_ = false;
    attachInspector();
  }

  void pump() {
    if (!port_) return;
    if (socket_ == dmSocket::INVALID_SOCKET_HANDLE) {
      if (retryFrames_ > 0) {
        --retryFrames_;
        return;
      }
      if (!connect()) {
        retryFrames_ = kRetryFrames;
        return;
      }
    }
    attachInspector();
    receiveCommands();
    if (runtime_ && inspectorOpen_) runtime_->pumpInspector();
    flushMessages();
  }

  void close() {
    port_ = 0;
    disconnect();
    runtime_ = nullptr;
  }

  bool connected() const noexcept {
    return socket_ != dmSocket::INVALID_SOCKET_HANDLE;
  }

 private:
  static constexpr size_t kMaximumBufferedBytes = 4 * 1024 * 1024;
  static constexpr uint32_t kRetryFrames = 120;
  static constexpr uint32_t kMaximumCommandsPerPump = 256;

  bool connect() {
    dmSocket::Socket candidate = dmSocket::INVALID_SOCKET_HANDLE;
    if (dmSocket::New(
            dmSocket::DOMAIN_IPV4,
            dmSocket::TYPE_STREAM,
            dmSocket::PROTOCOL_TCP,
            &candidate) != dmSocket::RESULT_OK) {
      return false;
    }
    dmSocket::Address loopback;
    if (dmSocket::GetHostByName("127.0.0.1", &loopback, true, false) != dmSocket::RESULT_OK ||
        dmSocket::Connect(candidate, loopback, port_) != dmSocket::RESULT_OK ||
        dmSocket::SetBlocking(candidate, false) != dmSocket::RESULT_OK) {
      dmSocket::Delete(candidate);
      return false;
    }
    dmSocket::SetNoDelay(candidate, true);
    socket_ = candidate;
    attachInspector();
    return true;
  }

  void attachInspector() {
    if (!runtime_ || inspectorOpen_ || socket_ == dmSocket::INVALID_SOCKET_HANDLE) return;
    inspectorOpen_ = runtime_->openInspector([this](const std::string& message) {
      const size_t framedSize = message.size() + 1;
      if (framedSize > kMaximumBufferedBytes || outputBytes_ > kMaximumBufferedBytes - framedSize) {
        overflowed_ = true;
        return;
      }
      output_.push_back(message + '\n');
      outputBytes_ += framedSize;
    });
  }

  void receiveCommands() {
    std::array<char, 16 * 1024> chunk{};
    uint32_t commands = 0;
    for (uint32_t attempt = 0; attempt < 32; ++attempt) {
      int received = 0;
      const auto result = dmSocket::Receive(
          socket_, chunk.data(), static_cast<int>(chunk.size()), &received);
      if (result == dmSocket::RESULT_WOULDBLOCK) break;
      if (result != dmSocket::RESULT_OK || received <= 0) {
        disconnect();
        return;
      }
      if (input_.size() > kMaximumBufferedBytes - static_cast<size_t>(received)) {
        disconnect();
        return;
      }
      input_.append(chunk.data(), static_cast<size_t>(received));
      for (;;) {
        const size_t newline = input_.find('\n');
        if (newline == std::string::npos) break;
        size_t length = newline;
        if (length && input_[length - 1] == '\r') --length;
        // The engine socket can connect before the first bundle has produced a
        // runtime. Keep the bounded command in place until bindRuntime rather
        // than dropping the debugger session during startup.
        if (length && (!runtime_ || !inspectorOpen_)) return;
        if (length && !runtime_->inspectorCommand(input_.substr(0, length))) {
          disconnect();
          return;
        }
        input_.erase(0, newline + 1);
        if (length) {
          runtime_->pumpInspector();
          if (++commands == kMaximumCommandsPerPump) return;
        }
      }
    }
  }

  void flushMessages() {
    if (overflowed_) {
      disconnect();
      return;
    }
    while (!output_.empty()) {
      std::string& message = output_.front();
      const size_t remaining = message.size() - outputOffset_;
      int sent = 0;
      const auto result = dmSocket::Send(
          socket_, message.data() + outputOffset_, static_cast<int>(remaining), &sent);
      if (result == dmSocket::RESULT_WOULDBLOCK) return;
      if (result != dmSocket::RESULT_OK || sent <= 0) {
        disconnect();
        return;
      }
      outputOffset_ += static_cast<size_t>(sent);
      outputBytes_ -= static_cast<size_t>(sent);
      if (outputOffset_ == message.size()) {
        output_.pop_front();
        outputOffset_ = 0;
      }
    }
  }

  void disconnect() {
    if (runtime_ && inspectorOpen_) runtime_->closeInspector();
    inspectorOpen_ = false;
    if (socket_ != dmSocket::INVALID_SOCKET_HANDLE) dmSocket::Delete(socket_);
    socket_ = dmSocket::INVALID_SOCKET_HANDLE;
    input_.clear();
    output_.clear();
    outputOffset_ = 0;
    outputBytes_ = 0;
    overflowed_ = false;
  }

  Runtime* runtime_ = nullptr;
  dmSocket::Socket socket_ = dmSocket::INVALID_SOCKET_HANDLE;
  uint16_t port_ = 0;
  uint32_t retryFrames_ = 0;
  bool inspectorOpen_ = false;
  bool overflowed_ = false;
  std::string input_;
  std::deque<std::string> output_;
  size_t outputOffset_ = 0;
  size_t outputBytes_ = 0;
};

}  // namespace defold_hermes

#else

namespace defold_hermes {

class InspectorClient {
 public:
  void start(uint16_t) {}
  void bindRuntime(Runtime*) {}
  void pump() {}
  void close() {}
  bool connected() const noexcept { return false; }
};

}  // namespace defold_hermes

#endif
