#include <defold_hermes/runtime.hpp>

#include "static_dmsdk_exact_fixture.h"

#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_dmsdk_exact();
extern "C" int deherm_dmsdk_generated_provider_install_run_exact_verification(void);
extern "C" void deherm_dmsdk_generated_provider_install_reset_exact_observations(void);
extern "C" uint32_t deherm_dmsdk_generated_provider_install_exact_call_count(uint32_t id);
extern "C" uint32_t deherm_dmsdk_generated_provider_install_exact_failure_count(uint32_t id);

namespace {
uint32_t gReportedVectors = 0;
uint32_t gReportedMismatches = UINT32_MAX;

class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};
}  // namespace

extern "C" void deherm_static_dmsdk_exact_report(
    uint32_t vectors,
    uint32_t mismatches) {
  gReportedVectors = vectors;
  gReportedMismatches = mismatches;
}

int main() {
  try {
    // The generated native driver initializes address-bearing vector fixtures
    // and proves them once. Resetting observations makes all evidence checked
    // below attributable only to the subsequent Static Hermes replay.
    if (deherm_dmsdk_generated_provider_install_run_exact_verification() != 0) {
      throw std::runtime_error("generated native exact-call prerequisite failed");
    }
    deherm_dmsdk_generated_provider_install_reset_exact_observations();

    Host host;
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_dmsdk_exact,
    };
    runtime.loadStatic(units, 1, "defold-hermes://static-dmsdk-exact");

    const uint32_t expected = deherm_static_dmsdk_exact_vector_count();
    if (gReportedVectors != expected || gReportedMismatches != 0) {
      throw std::runtime_error("Static Hermes did not report every exact vector cleanly");
    }
    for (uint32_t vector = 0; vector < expected; ++vector) {
      const uint32_t id = deherm_static_dmsdk_exact_vector_id(vector);
      if (deherm_dmsdk_generated_provider_install_exact_call_count(id) != 1 ||
          deherm_dmsdk_generated_provider_install_exact_failure_count(id) != 0) {
        throw std::runtime_error("recording callee rejected a Static Hermes frame");
      }
    }
    std::printf("static-dmsdk-exact:%u-vectors:bounded-frame:ok\n", expected);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "static-dmsdk-exact:error:%s\n", error.what());
    return 1;
  }
}
