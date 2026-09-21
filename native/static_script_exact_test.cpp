#include <defold_hermes/runtime.hpp>

#include "generated_script_recording_engine.h"
#include "static_script_exact_fixture.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_script_exact();

namespace {
uint32_t gPlanned = 0;
uint32_t gExecuted = 0;
uint32_t gMismatches = UINT32_MAX;

class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};
}  // namespace

extern "C" void deherm_static_script_exact_report(
    uint32_t planned, uint32_t executed, uint32_t mismatches) {
  gPlanned = planned;
  gExecuted = executed;
  gMismatches = mismatches;
}
int main() {
  try {
    deherm_recording_install();
    deherm_recording_select_transport(DEHERM_RECORDING_TRANSPORT_TYPED_NATIVE);
    Host host;
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {
      sh_export_deherm_static_script_exact,
    };
    runtime.loadStatic(units, 1, "defold-hermes://static-script-exact");

    const uint32_t expected = deherm_static_script_exact_vector_count();
    if (gPlanned != expected || gExecuted != expected || gMismatches != 0 ||
        deherm_recording_violation_count() != 0) {
      throw std::runtime_error("Static Hermes did not execute every script vector cleanly");
    }
    for (uint32_t vector = 0; vector < expected; ++vector) {
      const uint32_t route = deherm_static_script_exact_route_index(vector);
      if (deherm_recording_observed_arity(
              route, DEHERM_RECORDING_TRANSPORT_TYPED_NATIVE) !=
              deherm_static_script_exact_argument_count(vector) ||
          deherm_recording_observed_context(
              route, DEHERM_RECORDING_TRANSPORT_TYPED_NATIVE)[0] == '\0' ||
          std::strcmp(deherm_recording_observed_arguments(
                          route, DEHERM_RECORDING_TRANSPORT_TYPED_NATIVE),
                      deherm_static_script_exact_expected_arguments(vector)) != 0 ||
          deherm_recording_find_route(
              deherm_static_script_exact_stable_id(vector)) != route) {
        throw std::runtime_error(
            std::string("Static Hermes vector observation mismatch: ") +
            deherm_static_script_exact_route_id(vector));
      }
    }
    deherm_recording_uninstall();
    std::printf("static-script-exact:%u-routes:all-static-emitted:typed-native:ok\n",
                expected);
    return 0;
  } catch (const std::exception& error) {
    deherm_recording_uninstall();
    std::fprintf(stderr, "static-script-exact:error:%s\n", error.what());
    return 1;
  }
}
