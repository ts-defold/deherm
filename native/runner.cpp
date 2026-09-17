#include <defold_hermes/runtime.hpp>

#include <chrono>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace {

std::string readFile(const char* path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error(std::string("Cannot open bundle: ") + path);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

class ConsoleHost final : public defold_hermes::Host {
 public:
  void log(const std::string& level, const std::string& message) override {
    std::cout << "host.log:" << level << ':' << message << '\n';
  }

  double now() override {
    using Clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count();
  }

  std::string request(
      const std::string& channel,
      const std::string& payload) override {
    std::cout << "host.request:" << channel << ':' << payload << '\n';
    return "hermes:" + channel + ':' + payload;
  }
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: defold-hermes-runner <bundle.js|bundle.hbc>\n";
    return 2;
  }

  try {
    ConsoleHost host;
    defold_hermes::Runtime runtime(host);
    std::cout << "host.ready:hermes\n";
    runtime.load(readFile(argv[1]), "defold-hermes://sample.js");
    runtime.init();
    for (int index = 0; index < 3; ++index) runtime.update(1.0 / 60.0);
    runtime.onMessage("hello-from-hermes-host");
    runtime.finalize();
    std::cout << "defold-hermes:ok\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "defold-hermes:error:" << error.what() << '\n';
    return 1;
  }
}
