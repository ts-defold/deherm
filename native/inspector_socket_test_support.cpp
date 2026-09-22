#include "inspector_socket_test_support.hpp"

#include <dmsdk/dlib/socket.h>

#include <algorithm>
#include <condition_variable>
#include <cstring>
#include <mutex>

namespace {

std::mutex gMutex;
std::condition_variable gChanged;
std::string gCommands;
std::string gOutput;
bool gConnected = false;

}  // namespace

namespace defold_hermes::test_socket {

void reset() {
  std::lock_guard<std::mutex> lock(gMutex);
  gCommands.clear();
  gOutput.clear();
  gConnected = false;
}

void pushCommand(std::string command) {
  std::lock_guard<std::mutex> lock(gMutex);
  gCommands += std::move(command);
  gCommands.push_back('\n');
  gChanged.notify_all();
}

bool waitForOutput(const std::string& needle, std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(gMutex);
  return gChanged.wait_for(lock, timeout, [&] {
    return gOutput.find(needle) != std::string::npos;
  });
}

}  // namespace defold_hermes::test_socket

// The transport test intentionally supplies a deterministic in-memory
// implementation of the small dmSocket surface InspectorClient consumes. It
// exercises the production transport thread and framing without binding a
// host port or depending on platform socket scheduling.
namespace dmSocket {

Address::Address() : m_family(DOMAIN_MISSING), m_address{0, 0, 0, 0} {}

Result New(Domain, Type, Protocol, Socket* socket) {
  *socket = 1;
  return RESULT_OK;
}

Result Delete(Socket) {
  std::lock_guard<std::mutex> lock(gMutex);
  gConnected = false;
  gChanged.notify_all();
  return RESULT_OK;
}

Result Connect(Socket, Address, int) {
  std::lock_guard<std::mutex> lock(gMutex);
  gConnected = true;
  gChanged.notify_all();
  return RESULT_OK;
}

Result SetBlocking(Socket, bool) { return RESULT_OK; }
Result SetNoDelay(Socket, bool) { return RESULT_OK; }

Result Send(Socket, const void* buffer, int length, int* sentBytes) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (!gConnected) return RESULT_NOTCONN;
  gOutput.append(static_cast<const char*>(buffer), static_cast<size_t>(length));
  *sentBytes = length;
  gChanged.notify_all();
  return RESULT_OK;
}

Result Receive(Socket, void* buffer, int length, int* receivedBytes) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (!gConnected) return RESULT_NOTCONN;
  if (gCommands.empty()) {
    *receivedBytes = 0;
    return RESULT_WOULDBLOCK;
  }
  const size_t count = std::min(static_cast<size_t>(length), gCommands.size());
  std::memcpy(buffer, gCommands.data(), count);
  gCommands.erase(0, count);
  *receivedBytes = static_cast<int>(count);
  return RESULT_OK;
}

Result GetHostByName(const char*, Address* address, bool, bool) {
  address->m_family = DOMAIN_IPV4;
  address->m_address[3] = 0x7f000001;
  return RESULT_OK;
}

}  // namespace dmSocket
