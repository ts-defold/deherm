#include <defold_hermes/runtime.hpp>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

class TestHost final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};

[[noreturn]] void fail(const char* message, const std::vector<std::string>& transcript) {
  std::fprintf(stderr, "runtime-inspector-test:error:%s\n", message);
  for (const auto& entry : transcript) std::fprintf(stderr, "runtime-inspector-test:cdp:%s\n", entry.c_str());
  std::exit(1);
}

bool contains(const std::vector<std::string>& transcript, const char* needle) {
  for (const auto& entry : transcript) {
    if (entry.find(needle) != std::string::npos) return true;
  }
  return false;
}

}  // namespace

int main() {
  TestHost host;
  defold_hermes::Runtime runtime(host);
  std::vector<std::string> transcript;
  if (!runtime.inspectorAvailable()) fail("debugger-enabled runtime reported unavailable", transcript);
  if (!runtime.openInspector([&transcript](const std::string& message) {
        transcript.push_back(message);
      })) {
    fail("could not open inspector", transcript);
  }
  if (runtime.openInspector([](const std::string&) {}))
    fail("a second inspector session was accepted", transcript);

  if (!runtime.inspectorCommand(R"({"id":1,"method":"Runtime.enable"})"))
    fail("Runtime.enable command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":1)"))
    fail("Runtime.enable produced no exact response", transcript);

  if (!runtime.inspectorCommand(
          R"({"id":2,"method":"Runtime.evaluate","params":{"expression":"6*7","returnByValue":true}})")) {
    fail("Runtime.evaluate command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":2)") || !contains(transcript, R"("value":42)"))
    fail("Runtime.evaluate did not return the evaluated value", transcript);

  runtime.closeInspector();
  if (runtime.inspectorCommand(R"({"id":3,"method":"Runtime.enable"})"))
    fail("closed inspector accepted a command", transcript);
  std::puts("runtime-inspector-test:cdp-runtime-enable-evaluate-close:ok");
  return 0;
}
