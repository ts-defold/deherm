#include <defold_hermes/runtime.hpp>
#include <defold_hermes/generated_static_hermes_vmath.h>
#include <defold_hermes/script_bridge_capi.hpp>

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_ffi();
extern "C" SHUnit* sh_export_deherm_static_app();
extern "C" SHUnit* sh_export_deherm_static_vmath();
extern "C" SHUnit* sh_export_deherm_static_universal();

namespace {
std::atomic<bool> gTrackAllocations{false};
std::atomic<uint64_t> gAllocations{0};
}

void* operator new(std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) {
    gAllocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) {
    gAllocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {

double gStaticFfiResult = 0.0;
uint32_t gLifecycleMask = 0;
double gLifecycleUpdate = 0.0;
double gLifecycleMessageLength = 0.0;
double gLifecycleFinalUpdates = 0.0;
double gVmathResults[8]{};
uint32_t gUniversalResults = 0;
uint32_t gUniversalRecordEntries = 0;
double gUniversalValueChecksums[5]{};

bool StaticUniversalDispatch(void*, defold_hermes::ScriptCallFrame* frame) {
  if (!frame || frame->argumentCount != 1 || frame->resultCapacity < 1) return false;
  frame->results[0] = frame->arguments[0];
  frame->resultCount = 1;
  return true;
}

const char* StaticUniversalLastError(void*) { return "Static universal probe dispatch failed"; }

class ConsoleHost final : public defold_hermes::Host {
 public:
  void log(const std::string& level, const std::string& message) override {
    std::cout << "static.host.log:" << level << ':' << message << '\n';
  }

  double now() override { return 42.0; }

  std::string request(
      const std::string& channel,
      const std::string& payload) override {
    return "static:" + channel + ':' + payload;
  }
};

}  // namespace

extern "C" void defold_hermes_static_probe_report(double value) {
  gStaticFfiResult = value;
}

extern "C" void defold_hermes_static_lifecycle_report(
    uint32_t stage,
    double value) {
  if (stage < 32) gLifecycleMask |= 1u << stage;
  if (stage == 2) gLifecycleUpdate = value;
  if (stage == 3) gLifecycleMessageLength = value;
  if (stage == 4) gLifecycleFinalUpdates = value;
}

extern "C" void defold_hermes_static_vmath_report(
    uint32_t stage,
    double value) {
  if (stage >= 1 && stage <= 8) gVmathResults[stage - 1] = value;
}

extern "C" void defold_hermes_static_universal_report(
    uint32_t results,
    uint32_t recordEntries) {
  gUniversalResults = results;
  gUniversalRecordEntries = recordEntries;
}

extern "C" void defold_hermes_static_universal_value_report(
    uint32_t stage,
    double checksum) {
  if (stage >= 1 && stage <= 5) gUniversalValueChecksums[stage - 1] = checksum;
}

int main() {
  try {
    ConsoleHost host;
    defold_hermes::installScriptBridgeApi(
        {nullptr, StaticUniversalDispatch, StaticUniversalLastError, nullptr});
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_ffi,
      sh_export_deherm_static_app,
      sh_export_deherm_static_vmath,
      sh_export_deherm_static_universal,
    };
    runtime.loadStatic(units, 4, "defold-hermes://static-app");
    if (std::fabs(gStaticFfiResult - 42.0) > 0.000001) {
      throw std::runtime_error("Strict Static Hermes C ABI probe did not return 42");
    }
    std::cout << "static.ffi:" << gStaticFfiResult << '\n';
    const double expectedVmath[] = {13.0, 5.0, 1.0, 2.0, 169.0, 30.0, 9.0, 1.0};
    for (size_t index = 0; index < 8; ++index) {
      if (std::fabs(gVmathResults[index] - expectedVmath[index]) > 0.000001) {
        throw std::runtime_error("Generated Static Hermes vmath bridge returned an unexpected value");
      }
    }
    volatile double nativeVmathSink = 0.0;
    gAllocations.store(0, std::memory_order_relaxed);
    gTrackAllocations.store(true, std::memory_order_relaxed);
    for (uint32_t iteration = 0; iteration < 10000; ++iteration) {
      nativeVmathSink += deherm_static_vmath_8d4b1f66_length_vector3(3.0f, 4.0f, 12.0f);
      nativeVmathSink += deherm_static_vmath_a027f373_project_vector3_vector3(
          2.0f, 4.0f, 6.0f, 1.0f, 2.0f, 3.0f);
      nativeVmathSink += deherm_static_vmath_b1bb687b_length_sqr_quaternion(
          1.0f, 2.0f, 2.0f, 0.0f);
    }
    gTrackAllocations.store(false, std::memory_order_relaxed);
    if (nativeVmathSink != 240000.0 ||
        gAllocations.load(std::memory_order_relaxed) != 0) {
      throw std::runtime_error("Generated Static Hermes vmath hot path allocated or produced unstable output");
    }
    std::cout << "static.vmath:3-bindings,7-shapes\n";
    std::cout << "static.vmath.project-zero-target:rejected\n";
    std::cout << "static.vmath.allocations:0\n";
    if (gUniversalResults != 1 || gUniversalRecordEntries != 7) {
      throw std::runtime_error("Sound-typed Static Hermes universal marshaller returned an unexpected value graph");
    }
    // Column-major Matrix4 weighted lane sum, the four exact dmMessage::URL
    // 64-bit lanes split into uint32 halves, an exact dmhash_t, a float32
    // Vector3 lane sum, and the two record arities.
    const double expectedUniversalValues[] = {1496.0, 9470447106.0, 2328826710.0, 6.875, 20.0};
    for (size_t index = 0; index < 5; ++index) {
      if (gUniversalValueChecksums[index] != expectedUniversalValues[index]) {
        throw std::runtime_error("Transparent Defold value record did not survive the sound-typed frame");
      }
    }
    std::cout << "static.universal:scalar,string,array,record,hash,vector3,matrix4,url\n";
    std::cout << "static.universal.transparent-defold-values:matrix4,url,hash,vector3\n";
    runtime.init();
    runtime.update(1.0 / 60.0);
    runtime.onMessage("hello-from-static-hermes");
    runtime.finalize();
    const uint32_t expectedLifecycleMask =
        (1u << 1) | (1u << 2) | (1u << 3) | (1u << 4);
    if (gLifecycleMask != expectedLifecycleMask ||
        std::fabs(gLifecycleUpdate - (1.0 / 60.0)) > 0.000001 ||
        gLifecycleMessageLength != 24.0 ||
        gLifecycleFinalUpdates != 1.0) {
      throw std::runtime_error("Sound-typed Static Hermes lifecycle probe failed");
    }
    std::cout << "static.lifecycle:typed-strict:init,update,message,final\n";
    std::cout << "defold-hermes-static:ok\n";
    defold_hermes::uninstallScriptBridgeApi();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "defold-hermes-static:error:" << error.what() << '\n';
    return 1;
  }
}
