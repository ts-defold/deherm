#include <defold_hermes/runtime.hpp>

#include "static_dmsdk_exact_fixture.h"

#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_dmsdk_exact();
extern "C" int deherm_dmsdk_universal_ready_provider_install_run_exact_verification(void);
extern "C" void deherm_dmsdk_universal_ready_provider_install_reset_exact_observations(void);
extern "C" uint32_t deherm_dmsdk_universal_ready_provider_install_exact_call_count(uint32_t id);
extern "C" uint32_t deherm_dmsdk_universal_ready_provider_install_exact_failure_count(uint32_t id);

namespace {
uint32_t gReportedPlannedVectors = 0;
uint32_t gReportedApplicableVectors = 0;
uint32_t gReportedExecutedVectors = 0;
uint32_t gReportedMismatches = UINT32_MAX;
uint32_t gReportedMaximumArgumentCount = UINT32_MAX;
uint32_t gReportedArgumentTagMask = 0;
uint32_t gReportedResultTagMask = 0;

class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};
}  // namespace

extern "C" void deherm_static_dmsdk_exact_report(
    uint32_t planned,
    uint32_t applicable,
    uint32_t executed,
    uint32_t mismatches,
    uint32_t maximum_argument_count,
    uint32_t argument_tag_mask,
    uint32_t result_tag_mask) {
  gReportedPlannedVectors = planned;
  gReportedApplicableVectors = applicable;
  gReportedExecutedVectors = executed;
  gReportedMismatches = mismatches;
  gReportedMaximumArgumentCount = maximum_argument_count;
  gReportedArgumentTagMask = argument_tag_mask;
  gReportedResultTagMask = result_tag_mask;
}

int main() {
  try {
    // The generated native driver initializes address-bearing vector fixtures
    // and proves them once. Resetting observations makes all evidence checked
    // below attributable only to the subsequent Static Hermes replay.
    if (deherm_dmsdk_universal_ready_provider_install_run_exact_verification() != 0) {
      throw std::runtime_error("generated native exact-call prerequisite failed");
    }
    deherm_dmsdk_universal_ready_provider_install_reset_exact_observations();

    Host host;
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_dmsdk_exact,
    };
    runtime.loadStatic(units, 1, "defold-hermes://static-dmsdk-exact");

    const uint32_t expected = deherm_static_dmsdk_exact_vector_count();
    const uint32_t corpus = deherm_static_dmsdk_exact_corpus_vector_count();
    const uint32_t blocked = deherm_static_dmsdk_exact_blocked_vector_count();
    if (expected + blocked != corpus) {
      throw std::runtime_error("Static Hermes applicability partition omitted a vector");
    }
    if (gReportedPlannedVectors != corpus ||
        gReportedApplicableVectors != expected ||
        gReportedExecutedVectors != expected ||
        gReportedMismatches != 0) {
      throw std::runtime_error("Static Hermes did not report every exact vector cleanly");
    }
    if (gReportedMaximumArgumentCount !=
            deherm_static_dmsdk_exact_planned_maximum_argument_count() ||
        gReportedArgumentTagMask !=
            deherm_static_dmsdk_exact_planned_argument_tag_mask() ||
        gReportedResultTagMask !=
            deherm_static_dmsdk_exact_planned_result_tag_mask()) {
      throw std::runtime_error("Static Hermes exercised shape report drifted from its applicable plan");
    }
    for (uint32_t vector = 0; vector < expected; ++vector) {
      const uint32_t id = deherm_static_dmsdk_exact_vector_id(vector);
      if (deherm_dmsdk_universal_ready_provider_install_exact_call_count(id) != 1 ||
          deherm_dmsdk_universal_ready_provider_install_exact_failure_count(id) != 0) {
        throw std::runtime_error("recording callee rejected a Static Hermes frame");
      }
    }
    std::printf(
        "static-dmsdk-exact:%u/%u-runtime-executed:%u-applicable:%u-blocked:maximum-exercised-arguments-%u:exercised-argument-tag-mask-0x%08x:exercised-result-tag-mask-0x%08x:bounded-frame:ok\n",
        gReportedExecutedVectors, corpus, expected, blocked,
        gReportedMaximumArgumentCount, gReportedArgumentTagMask,
        gReportedResultTagMask);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "static-dmsdk-exact:error:%s\n", error.what());
    return 1;
  }
}
