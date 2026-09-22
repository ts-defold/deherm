#pragma once

#include <chrono>
#include <string>

namespace defold_hermes::test_socket {

void reset();
void pushCommand(std::string command);
bool waitForOutput(
    const std::string& needle,
    std::chrono::milliseconds timeout = std::chrono::seconds(5));

}  // namespace defold_hermes::test_socket
