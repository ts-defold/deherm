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
#include <atomic>
#include <array>
#include <chrono>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace defold_hermes {

/**
 * Development-only loopback transport for raw CDP JSON. The Node CLI owns
 * HTTP/WebSocket discovery. A transport thread performs bounded, nonblocking
 * newline framing so resume/step commands still arrive while Hermes has the
 * engine thread paused; engine-owned runtime tasks remain on pump().
 */
class InspectorClient {
 public:
  ~InspectorClient() { close(); }

  InspectorClient() = default;
  InspectorClient(const InspectorClient&) = delete;
  InspectorClient& operator=(const InspectorClient&) = delete;

  void start(uint16_t port) {
    if (port_ == port && worker_.joinable()) return;
    stopTransport();
    port_ = port;
    stopping_.store(false, std::memory_order_release);
    worker_ = std::thread([this] { runTransport(); });
  }

  void bindRuntime(Runtime* runtime) {
    std::lock_guard<std::mutex> lock(runtimeMutex_);
    if (runtime_ == runtime) return;
    if (runtime_ && inspectorOpen_) runtime_->closeInspector();
    runtime_ = runtime;
    inspectorOpen_ = false;
    attachInspectorLocked();
  }

  void pump() {
    std::lock_guard<std::mutex> lock(runtimeMutex_);
    if (resetInspector_.exchange(false, std::memory_order_acq_rel) && runtime_) {
      if (inspectorOpen_) runtime_->closeInspector();
      inspectorOpen_ = false;
    }
    attachInspectorLocked();
    if (runtime_ && inspectorOpen_) {
      runtime_->pumpInspector();
      const auto now = std::chrono::steady_clock::now();
      if (connected_.load(std::memory_order_acquire) && now >= nextSnapshot_) {
        enqueue(runtime_->sampleComponentSnapshot());
        nextSnapshot_ = now + kSnapshotInterval;
      }
    }
  }

  void close() {
    stopTransport();
    std::lock_guard<std::mutex> lock(runtimeMutex_);
    port_ = 0;
    if (runtime_ && inspectorOpen_) runtime_->closeInspector();
    inspectorOpen_ = false;
    runtime_ = nullptr;
  }

  bool connected() const noexcept {
    return connected_.load(std::memory_order_acquire);
  }

 private:
  struct OutboundFrame {
    std::string bytes;
    size_t offset = 0;
  };

  static constexpr size_t kMaximumBufferedBytes = 4 * 1024 * 1024;
  static constexpr uint32_t kMaximumCommandsPerPump = 256;
  static constexpr auto kConnectedPollDelay = std::chrono::milliseconds(2);
  static constexpr auto kReconnectDelay = std::chrono::milliseconds(250);
  // Four samples per second keeps the development-only projection live while
  // bounding worst-case 512 KiB serialization to 2 MiB/s per attached target.
  static constexpr auto kSnapshotInterval = std::chrono::milliseconds(250);

  void enqueue(std::string message) {
    if (message.empty()) return;
    std::lock_guard<std::mutex> lock(outputMutex_);
    const size_t framedSize = message.size() + 1;
    if (framedSize > kMaximumBufferedBytes ||
        outputBytes_ > kMaximumBufferedBytes - framedSize) {
      overflowed_ = true;
      return;
    }
    message.push_back('\n');
    outputBytes_ += framedSize;
    output_.push_back({std::move(message), 0});
  }

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
    connected_.store(true, std::memory_order_release);
    return true;
  }

  void attachInspectorLocked() {
    if (!runtime_ || inspectorOpen_ || !port_) return;
    inspectorOpen_ = runtime_->openInspector([this](const std::string& message) {
      enqueue(message);
    });
    nextSnapshot_ = std::chrono::steady_clock::time_point::min();
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
        disconnectTransport();
        return;
      }
      if (input_.size() > kMaximumBufferedBytes - static_cast<size_t>(received)) {
        disconnectTransport();
        return;
      }
      input_.append(chunk.data(), static_cast<size_t>(received));
      for (;;) {
        const size_t newline = input_.find('\n');
        if (newline == std::string::npos) break;
        size_t length = newline;
        if (length && input_[length - 1] == '\r') --length;
        if (length) {
          // CDPAgent accepts commands from arbitrary threads. RuntimeTaskRunner
          // executes each command either at the engine safe point or through a
          // Hermes async interrupt while JavaScript is running/paused.
          bool accepted = false;
          {
            std::lock_guard<std::mutex> lock(runtimeMutex_);
            if (!runtime_ || !inspectorOpen_) return;
            accepted = runtime_->inspectorCommand(input_.substr(0, length));
          }
          if (!accepted) {
            disconnectTransport();
            return;
          }
        }
        input_.erase(0, newline + 1);
        if (length && ++commands == kMaximumCommandsPerPump) return;
      }
    }
  }

  void flushMessages() {
    bool disconnect = false;
    {
      std::lock_guard<std::mutex> lock(outputMutex_);
      if (overflowed_) {
        disconnect = true;
      } else {
        while (!output_.empty()) {
          OutboundFrame& frame = output_.front();
          const size_t remaining = frame.bytes.size() - frame.offset;
          int sent = 0;
          const auto result = dmSocket::Send(
              socket_, frame.bytes.data() + frame.offset, static_cast<int>(remaining), &sent);
          if (result == dmSocket::RESULT_WOULDBLOCK) break;
          if (result != dmSocket::RESULT_OK || sent <= 0) {
            disconnect = true;
            break;
          }
          frame.offset += static_cast<size_t>(sent);
          outputBytes_ -= static_cast<size_t>(sent);
          if (frame.offset == frame.bytes.size()) {
            output_.pop_front();
          }
        }
      }
    }
    if (disconnect) {
      disconnectTransport();
    }
  }

  void disconnectTransport() {
    if (socket_ != dmSocket::INVALID_SOCKET_HANDLE) dmSocket::Delete(socket_);
    socket_ = dmSocket::INVALID_SOCKET_HANDLE;
    connected_.store(false, std::memory_order_release);
    input_.clear();
    // Closing a debugger while paused must not strand the game thread. The
    // command is safe from this transport thread and Hermes handles it via an
    // async interrupt. The next engine pump rebuilds a clean inspector agent.
    {
      std::lock_guard<std::mutex> lock(runtimeMutex_);
      if (runtime_ && inspectorOpen_) {
        runtime_->inspectorCommand(R"({"id":-1,"method":"Debugger.resume"})");
        resetInspector_.store(true, std::memory_order_release);
      }
    }
    {
      std::lock_guard<std::mutex> lock(outputMutex_);
      output_.clear();
      outputBytes_ = 0;
      overflowed_ = false;
    }
  }

  void runTransport() {
    while (!stopping_.load(std::memory_order_acquire)) {
      if (socket_ == dmSocket::INVALID_SOCKET_HANDLE && !connect()) {
        std::this_thread::sleep_for(kReconnectDelay);
        continue;
      }
      receiveCommands();
      if (socket_ != dmSocket::INVALID_SOCKET_HANDLE) flushMessages();
      std::this_thread::sleep_for(kConnectedPollDelay);
    }
    if (socket_ != dmSocket::INVALID_SOCKET_HANDLE) dmSocket::Delete(socket_);
    socket_ = dmSocket::INVALID_SOCKET_HANDLE;
    connected_.store(false, std::memory_order_release);
  }

  void stopTransport() {
    stopping_.store(true, std::memory_order_release);
    if (worker_.joinable()) worker_.join();
  }

  std::mutex runtimeMutex_;
  Runtime* runtime_ = nullptr;
  bool inspectorOpen_ = false;
  std::atomic<bool> resetInspector_{false};

  std::thread worker_;
  std::atomic<bool> stopping_{true};
  std::atomic<bool> connected_{false};
  dmSocket::Socket socket_ = dmSocket::INVALID_SOCKET_HANDLE;
  uint16_t port_ = 0;
  std::string input_;

  std::mutex outputMutex_;
  std::deque<OutboundFrame> output_;
  size_t outputBytes_ = 0;
  bool overflowed_ = false;
  std::chrono::steady_clock::time_point nextSnapshot_{};
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
