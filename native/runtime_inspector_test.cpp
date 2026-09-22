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
  std::size_t heap_chunk_count = 0;
  std::size_t heap_chunk_bytes = 0;
  if (!runtime.inspectorAvailable()) fail("debugger-enabled runtime reported unavailable", transcript);
  if (!runtime.openInspector([&](const std::string& message) {
        if (message.find(R"("method":"HeapProfiler.addHeapSnapshotChunk")") != std::string::npos) {
          ++heap_chunk_count;
          heap_chunk_bytes += message.size();
        } else {
          transcript.push_back(message);
        }
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

  if (!runtime.inspectorCommand(R"({"id":3,"method":"Profiler.start"})"))
    fail("Profiler.start command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":3)"))
    fail("Profiler.start produced no exact response", transcript);
  if (!runtime.inspectorCommand(
          R"JS({"id":4,"method":"Runtime.evaluate","params":{"expression":"(()=>{let n=0;for(let i=0;i<10000;i++)n+=i;return n})()","returnByValue":true}})JS")) {
    fail("profiled Runtime.evaluate command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":4)"))
    fail("profiled Runtime.evaluate produced no response", transcript);
  if (!runtime.inspectorCommand(R"({"id":5,"method":"Profiler.stop"})"))
    fail("Profiler.stop command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":5)") || !contains(transcript, R"("profile")") ||
      !contains(transcript, R"("nodes")")) {
    fail("Profiler.stop did not return a standard CPU profile", transcript);
  }

  if (!runtime.inspectorCommand(
          R"({"id":6,"method":"HeapProfiler.takeHeapSnapshot","params":{"reportProgress":true,"captureNumericValue":true}})")) {
    fail("HeapProfiler.takeHeapSnapshot command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":6)") || heap_chunk_count == 0 || heap_chunk_bytes == 0)
    fail("HeapProfiler.takeHeapSnapshot did not stream a standard snapshot", transcript);

  runtime.closeInspector();
  if (runtime.inspectorCommand(R"({"id":7,"method":"Runtime.enable"})"))
    fail("closed inspector accepted a command", transcript);
  std::puts("runtime-inspector-test:cdp-runtime-profiler-heap-close:ok");
  return 0;
}
