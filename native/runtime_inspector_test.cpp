#include <defold_hermes/runtime.hpp>

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
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
  std::mutex transcript_mutex;
  std::atomic<bool> paused{false};
  std::size_t heap_chunk_count = 0;
  std::size_t heap_chunk_bytes = 0;
  if (!runtime.inspectorAvailable()) fail("debugger-enabled runtime reported unavailable", transcript);
  if (!runtime.openInspector([&](const std::string& message) {
        if (message.find(R"("method":"Debugger.paused")") != std::string::npos) {
          paused.store(true, std::memory_order_release);
        }
        std::lock_guard<std::mutex> lock(transcript_mutex);
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

  if (!runtime.inspectorCommand(R"({"id":2,"method":"Debugger.enable"})"))
    fail("Debugger.enable command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":2)"))
    fail("Debugger.enable produced no exact response", transcript);

  constexpr const char* kBundleUrl = "deherm:///deherm/app.dehermc";
  runtime.load(
      "globalThis.__defoldAppV1 = {\n"
      "  init() {\n"
      "    globalThis.__dapValue = 41;\n"
      "    globalThis.__dapValue += 1;\n"
      "  }\n"
      "};\n",
      kBundleUrl);
  runtime.pumpInspector();
  if (!contains(transcript, R"("method":"Debugger.scriptParsed")") ||
      !contains(transcript, R"("url":"deherm:\/\/\/deherm\/app.dehermc")")) {
    fail("the loaded bundle produced no exact scriptParsed URL", transcript);
  }
  if (!runtime.inspectorCommand(
          R"({"id":3,"method":"Debugger.setBreakpointByUrl","params":{"url":"deherm:///deherm/app.dehermc","lineNumber":2,"columnNumber":0}})")) {
    fail("Debugger.setBreakpointByUrl command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":3)") || !contains(transcript, R"("breakpointId")") ||
      !contains(transcript, R"("locations")")) {
    fail("Debugger.setBreakpointByUrl did not bind the loaded bundle", transcript);
  }

  // Hermes pauses inside the mutator thread. A real debugger sends resume from
  // its transport thread; RuntimeTaskRunner interrupts the paused runtime and
  // executes the command with exclusive runtime access. Model that concurrency
  // here instead of trying to resume after the blocking init() call returns.
  std::atomic<bool> init_completed{false};
  std::atomic<bool> resume_accepted{false};
  std::thread debugger_thread([&] {
    while (!paused.load(std::memory_order_acquire) &&
           !init_completed.load(std::memory_order_acquire)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (paused.load(std::memory_order_acquire)) {
      resume_accepted.store(
          runtime.inspectorCommand(R"({"id":4,"method":"Debugger.resume"})"),
          std::memory_order_release);
    }
  });
  runtime.init();
  init_completed.store(true, std::memory_order_release);
  debugger_thread.join();
  if (!paused.load(std::memory_order_acquire))
    fail("authored bundle breakpoint did not pause Hermes", transcript);
  if (!resume_accepted.load(std::memory_order_acquire))
    fail("Debugger.resume command was rejected", transcript);
  if (!contains(transcript, R"("id":4)") || !contains(transcript, R"("method":"Debugger.resumed")"))
    fail("Debugger.resume did not continue the paused application", transcript);

  if (!runtime.inspectorCommand(
          R"({"id":5,"method":"Runtime.evaluate","params":{"expression":"globalThis.__dapValue","returnByValue":true}})")) {
    fail("Runtime.evaluate command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":5)") || !contains(transcript, R"("value":42)"))
    fail("Runtime.evaluate did not return the evaluated value", transcript);

  if (!runtime.inspectorCommand(R"({"id":6,"method":"Profiler.start"})"))
    fail("Profiler.start command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":6)"))
    fail("Profiler.start produced no exact response", transcript);
  if (!runtime.inspectorCommand(
          R"JS({"id":7,"method":"Runtime.evaluate","params":{"expression":"(()=>{let n=0;for(let i=0;i<10000;i++)n+=i;return n})()","returnByValue":true}})JS")) {
    fail("profiled Runtime.evaluate command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":7)"))
    fail("profiled Runtime.evaluate produced no response", transcript);
  if (!runtime.inspectorCommand(R"({"id":8,"method":"Profiler.stop"})"))
    fail("Profiler.stop command was rejected", transcript);
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":8)") || !contains(transcript, R"("profile")") ||
      !contains(transcript, R"("nodes")")) {
    fail("Profiler.stop did not return a standard CPU profile", transcript);
  }

  if (!runtime.inspectorCommand(
          R"({"id":9,"method":"HeapProfiler.takeHeapSnapshot","params":{"reportProgress":true,"captureNumericValue":true}})")) {
    fail("HeapProfiler.takeHeapSnapshot command was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":9)") || heap_chunk_count == 0 || heap_chunk_bytes == 0)
    fail("HeapProfiler.takeHeapSnapshot did not stream a standard snapshot", transcript);

  runtime.closeInspector();
  if (runtime.inspectorCommand(R"({"id":10,"method":"Runtime.enable"})"))
    fail("closed inspector accepted a command", transcript);
  std::puts("runtime-inspector-test:cdp-breakpoint-runtime-profiler-heap-close:ok");
  return 0;
}
