#include <defold_hermes/runtime.hpp>

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
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

bool contains(const std::string& value, const std::string& needle) {
  return value.find(needle) != std::string::npos;
}

defold_hermes::Runtime::ComponentValue number(double value) {
  defold_hermes::Runtime::ComponentValue result;
  result.kind = defold_hermes::Runtime::ComponentValueKind::kNumber;
  result.number = value;
  return result;
}

defold_hermes::Runtime::ComponentValue string(const std::string& value) {
  defold_hermes::Runtime::ComponentValue result;
  result.kind = defold_hermes::Runtime::ComponentValueKind::kString;
  result.string = value.data();
  result.stringLength = static_cast<uint32_t>(value.size());
  return result;
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
      "globalThis.__telemetryGetterRuns = 0;\n"
      "globalThis.__defoldComponentsV1 = {\n"
      "  telemetry: {\n"
      "    schemaFingerprint: 'schema-telemetry-v1',\n"
      "    contextKind: 'game-object',\n"
      "    definition: { init(self) {\n"
      "      globalThis.__telemetrySelf = self;\n"
      "      globalThis.__telemetryProxyReads = 0;\n"
      "      Object.defineProperty(self, 'getter', { configurable: true, get() {\n"
      "        globalThis.__telemetryGetterRuns += 1; return 99;\n"
      "      }});\n"
      "      delete self.inheritedOnly;\n"
      "      Object.setPrototypeOf(self, { inheritedOnly: 88 });\n"
      "      self.undefinedValue = undefined;\n"
      "      self.invalidHash = -1n;\n"
      "      self.invalidUrl.__dehermUrlV1 = true; self.invalidUrl.socket = 1n;\n"
      "      self.invalidVector.__dehermValueKind = 'vector3';\n"
      "      self.invalidVector.x = 1; self.invalidVector.y = Infinity; self.invalidVector.z = 3;\n"
      "      self.functionValue = function() {};\n"
      "    }}\n"
      "  }\n"
      "};\n"
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
          R"({"id":3,"method":"Debugger.setBreakpointByUrl","params":{"url":"deherm:///deherm/app.dehermc","lineNumber":24,"columnNumber":0}})")) {
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

  const std::string emptySnapshot = runtime.sampleComponentSnapshot();
  if (emptySnapshot.empty() || emptySnapshot.size() > 512 * 1024 ||
      !contains(emptySnapshot, R"("channel":"deherm-dev-v1")") ||
      !contains(emptySnapshot, R"("schemaVersion":1)") ||
      !contains(emptySnapshot, R"("type":"component-snapshot")") ||
      !contains(emptySnapshot, R"("sequence":1)") ||
      !contains(emptySnapshot, R"("complete":true)") ||
      !contains(emptySnapshot, R"("omitted":{"instances":0,"properties":0})") ||
      !contains(emptySnapshot, R"("instances":[])") ||
      !contains(emptySnapshot, std::string(R"("runtimeId":)") + std::to_string(runtime.identity()))) {
    fail("empty component snapshot envelope is not canonical", transcript);
  }

  using Kind = defold_hermes::Runtime::ComponentValueKind;
  auto handle = runtime.attachComponent(
      "telemetry", "schema-telemetry-v1",
      defold_hermes::Runtime::ComponentContext::kGameObject);
  defold_hermes::Runtime::ComponentValue value;
  value.kind = Kind::kNil;
  runtime.setComponentProperty(handle, "nil", value);
  value = {};
  value.kind = Kind::kBoolean;
  value.boolean = true;
  runtime.setComponentProperty(handle, "flag", value);
  runtime.setComponentProperty(handle, "count", number(42.5));
  const std::string label = "hello \"telemetry\"";
  runtime.setComponentProperty(handle, "label", string(label));
  value = {};
  value.kind = Kind::kHash;
  value.lanes64[0] = UINT64_C(0x0123456789abcdef);
  runtime.setComponentProperty(handle, "hash", value);
  value = {};
  value.kind = Kind::kUrl;
  value.lanes64[0] = 1;
  value.lanes64[1] = 2;
  value.lanes64[2] = 3;
  value.lanes64[3] = 4;
  runtime.setComponentProperty(handle, "url", value);
  value = {};
  value.kind = Kind::kVector3;
  value.lanes32[0] = 1;
  value.lanes32[1] = 2;
  value.lanes32[2] = 3;
  runtime.setComponentProperty(handle, "v3", value);
  value.kind = Kind::kVector4;
  value.lanes32[3] = 4;
  runtime.setComponentProperty(handle, "v4", value);
  value.kind = Kind::kQuaternion;
  runtime.setComponentProperty(handle, "quat", value);
  const std::string tooLong(257, 'x');
  runtime.setComponentProperty(handle, "tooLong", string(tooLong));
  runtime.setComponentProperty(handle, "nonfinite",
      number(std::numeric_limits<double>::infinity()));
  runtime.setComponentProperty(handle, "getter", number(1));
  runtime.setComponentProperty(handle, "inheritedOnly", number(2));
  value = {};
  value.kind = Kind::kObject;
  runtime.setComponentProperty(handle, "unsupported", value);
  value = {};
  runtime.setComponentProperty(handle, "undefinedValue", value);
  runtime.setComponentProperty(handle, "invalidHash", value);
  value.kind = Kind::kObject;
  runtime.setComponentProperty(handle, "invalidUrl", value);
  runtime.setComponentProperty(handle, "invalidVector", value);
  value = {};
  runtime.setComponentProperty(handle, "functionValue", value);
  for (int index = 19; index < 35; ++index) {
    const std::string name = "property" + std::to_string(index);
    runtime.setComponentProperty(handle, name.c_str(), number(index));
  }
  runtime.setComponentProperty(handle, "property32", number(3200));
  runtime.dispatchComponent(handle, "init", nullptr, 0);

  const std::string snapshot = runtime.sampleComponentSnapshot();
  const auto property = [&snapshot](const char* name, const char* encoded) {
    return contains(snapshot,
        std::string(R"("name":")") + name + R"(","value":)" + encoded);
  };
  if (snapshot.empty() || snapshot.size() > 512 * 1024 ||
      !contains(snapshot, R"("sequence":2)") ||
      !contains(snapshot, R"("complete":false)") ||
      !contains(snapshot, R"("omitted":{"instances":0,"properties":3})") ||
      !contains(snapshot, R"("instanceId":{"slot":0,"generation":1})") ||
      !contains(snapshot, R"("componentId":"telemetry")") ||
      !contains(snapshot, R"("schemaFingerprint":"schema-telemetry-v1")") ||
      !contains(snapshot, R"("contextKind":"game-object")") ||
      !property("nil", R"({"kind":"nil"})") ||
      !property("flag", R"({"kind":"boolean","value":true})") ||
      !property("count", R"({"kind":"number","value":42.5})") ||
      !property("label", R"({"kind":"string","value":"hello \"telemetry\""})") ||
      !property("hash", R"({"kind":"hash","value":"0123456789abcdef"})") ||
      !property("url", R"({"kind":"url","socket":"0000000000000001","reserved":"0000000000000002","path":"0000000000000003","fragment":"0000000000000004"})") ||
      !property("v3", R"({"kind":"vector3","value":[1,2,3]})") ||
      !property("v4", R"({"kind":"vector4","value":[1,2,3,4]})") ||
      !property("quat", R"({"kind":"quaternion","value":[1,2,3,4]})") ||
      !property("tooLong", R"({"kind":"unavailable","reason":"string-too-long"})") ||
      !property("nonfinite", R"({"kind":"unavailable","reason":"non-finite-number"})") ||
      !property("getter", R"({"kind":"unavailable","reason":"accessor-property"})") ||
      !property("inheritedOnly", R"({"kind":"unavailable","reason":"missing-own-property"})") ||
      !property("unsupported", R"({"kind":"unavailable","reason":"unsupported-object"})") ||
      !property("undefinedValue", R"({"kind":"unavailable","reason":"undefined"})") ||
      !property("invalidHash", R"({"kind":"unavailable","reason":"bigint-out-of-range"})") ||
      !property("invalidUrl", R"({"kind":"unavailable","reason":"invalid-url"})") ||
      !property("invalidVector", R"({"kind":"unavailable","reason":"invalid-vector"})") ||
      !property("functionValue", R"({"kind":"unavailable","reason":"unsupported-type"})") ||
      contains(snapshot, R"("name":"property32")")) {
    fail("component snapshot value projection is not canonical", transcript);
  }

  if (!runtime.inspectorCommand(
          R"({"id":13,"method":"Runtime.evaluate","params":{"expression":"globalThis.__telemetryRetainedV4 = globalThis.__telemetrySelf.v4; globalThis.__telemetrySelf.v4 = 17","returnByValue":true}})")) {
    fail("structured-root scalar replacement evaluation was rejected", transcript);
  }
  runtime.pumpInspector();
  const std::string scalarReplacementSnapshot = runtime.sampleComponentSnapshot();
  if (!contains(scalarReplacementSnapshot,
          R"("name":"v4","value":{"kind":"number","value":17})")) {
    fail("structured-root scalar replacement was not observed", transcript);
  }
  if (!runtime.inspectorCommand(
          R"({"id":14,"method":"Runtime.evaluate","params":{"expression":"globalThis.__telemetrySelf.v4 = globalThis.__telemetryRetainedV4","returnByValue":true}})")) {
    fail("structured-root restoration evaluation was rejected", transcript);
  }
  runtime.pumpInspector();
  const std::string releasedRootSnapshot = runtime.sampleComponentSnapshot();
  if (!contains(releasedRootSnapshot,
          R"("name":"v4","value":{"kind":"unavailable","reason":"untrusted-structured-value"})")) {
    fail("structured root survived a scalar replacement", transcript);
  }

  if (!runtime.inspectorCommand(
          R"({"id":10,"method":"Runtime.evaluate","params":{"expression":"globalThis.__telemetryGetterRuns","returnByValue":true}})")) {
    fail("getter counter evaluation was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":10)") || !contains(transcript, R"("value":0)"))
    fail("component snapshot invoked an accessor", transcript);

  if (!runtime.inspectorCommand(
          R"JSON({"id":11,"method":"Runtime.evaluate","params":{"expression":"globalThis.__telemetrySelf.v3 = new Proxy(globalThis.__telemetrySelf.v3, { getOwnPropertyDescriptor(target, name) { globalThis.__telemetryProxyReads += 1; return Reflect.getOwnPropertyDescriptor(target, name); } })","returnByValue":true}})JSON")) {
    fail("Proxy replacement evaluation was rejected", transcript);
  }
  runtime.pumpInspector();
  const std::string proxySnapshot = runtime.sampleComponentSnapshot();
  if (!contains(proxySnapshot,
          R"("name":"v3","value":{"kind":"unavailable","reason":"untrusted-structured-value"})")) {
    fail("component snapshot reflected on an untrusted structured replacement", transcript);
  }
  if (!runtime.inspectorCommand(
          R"({"id":12,"method":"Runtime.evaluate","params":{"expression":"globalThis.__telemetryProxyReads","returnByValue":true}})")) {
    fail("Proxy counter evaluation was rejected", transcript);
  }
  runtime.pumpInspector();
  if (!contains(transcript, R"("id":12)") || !contains(transcript, R"("value":0)"))
    fail("component snapshot invoked a Proxy descriptor trap", transcript);

  // Populate enough complete instances to cross the frame cap. The sampler
  // must roll back the whole first non-fitting instance, then count it and all
  // later live slots without emitting a partial object.
  const std::string bounded(256, 'b');
  for (int instance = 0; instance < 64; ++instance) {
    const auto bulky = runtime.attachComponent(
        "telemetry", "schema-telemetry-v1",
        defold_hermes::Runtime::ComponentContext::kGameObject);
    for (int index = 0; index < 32; ++index) {
      const std::string name = "bulk" + std::to_string(index);
      runtime.setComponentProperty(bulky, name.c_str(), string(bounded));
    }
  }
  const std::string boundedSnapshot = runtime.sampleComponentSnapshot();
  if (boundedSnapshot.empty() || boundedSnapshot.size() > 512 * 1024 ||
      contains(boundedSnapshot, R"("omitted":{"instances":0)") ||
      !contains(boundedSnapshot, R"("complete":false)") ||
      boundedSnapshot.back() != '}') {
    fail("component snapshot frame bound did not omit whole instances", transcript);
  }

  runtime.closeInspector();
  if (runtime.inspectorCommand(R"({"id":10,"method":"Runtime.enable"})"))
    fail("closed inspector accepted a command", transcript);
  std::puts("runtime-inspector-test:component-snapshot-schema-bounds-own-data:ok");
  std::puts("runtime-inspector-test:cdp-breakpoint-runtime-profiler-heap-close:ok");
  return 0;
}
