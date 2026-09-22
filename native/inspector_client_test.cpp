#include <defold_hermes/inspector_client.hpp>

#include "inspector_socket_test_support.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

namespace {

class TestHost final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "inspector-client-test:error:%s\n", message);
  std::exit(1);
}

void pumpUntil(
    defold_hermes::InspectorClient& client,
    const char* outputNeedle) {
  for (int attempt = 0; attempt < 500; ++attempt) {
    client.pump();
    if (defold_hermes::test_socket::waitForOutput(
            outputNeedle, std::chrono::milliseconds(2))) {
      return;
    }
  }
  fail("timed out waiting for CDP output");
}

}  // namespace

int main() {
  using defold_hermes::test_socket::pushCommand;
  using defold_hermes::test_socket::waitForOutput;

  defold_hermes::test_socket::reset();
  TestHost host;
  defold_hermes::Runtime runtime(host);
  constexpr const char* kBundleUrl = "deherm:///deherm/app.dehermc";
  runtime.load(
      "globalThis.__defoldAppV1 = {\n"
      "  init() {\n"
      "    globalThis.__dapValue = 41;\n"
      "    globalThis.__dapValue += 1;\n"
      "  }\n"
      "};\n",
      kBundleUrl);

  defold_hermes::InspectorClient client;
  client.start(9229);
  client.bindRuntime(&runtime);

  pushCommand(R"({"id":1,"method":"Runtime.enable"})");
  pumpUntil(client, R"("id":1)");
  pushCommand(R"({"id":2,"method":"Debugger.enable"})");
  pumpUntil(client, R"("id":2)");

  if (!waitForOutput(R"("method":"Debugger.scriptParsed")"))
    fail("scriptParsed did not cross the transport");

  pushCommand(
      R"({"id":3,"method":"Debugger.setBreakpointByUrl","params":{"url":"deherm:///deherm/app.dehermc","lineNumber":2,"columnNumber":0}})");
  pumpUntil(client, R"("breakpointId")");

  // The controller observes the paused notification on the transport thread
  // and writes resume while the main/engine thread is blocked inside Hermes.
  std::thread controller([&] {
    if (!waitForOutput(R"("method":"Debugger.paused")"))
      fail("paused notification did not cross the transport");
    pushCommand(R"({"id":4,"method":"Debugger.resume"})");
  });
  runtime.init();
  controller.join();

  if (!waitForOutput(R"("method":"Debugger.resumed")") ||
      !waitForOutput(R"("id":4)")) {
    fail("resume did not cross the paused transport");
  }

  client.close();
  std::puts("inspector-client-test:background-transport-breakpoint-resume:ok");
  return 0;
}
