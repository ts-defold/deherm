#include <defold_hermes/generated_script_special_call_verification.h>
#include <defold_hermes/lua_capi.hpp>
#include <defold_hermes/runtime.hpp>

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

extern "C" SHUnit* sh_export_deherm_static_special_call();

namespace {

double gResults[3]{};
double gDelay = 0.0;
bool gRepeating = false;
defold_hermes::lua_bridge::Handle gCallback{};
uint32_t gCancelHandle = 0;
uint32_t gTriggerHandle = 0;

uint32_t TimerDelay(
    double delay,
    bool repeating,
    defold_hermes::lua_bridge::Handle callback) {
  gDelay = delay;
  gRepeating = repeating;
  gCallback = callback;
  return DEHERM_VERIFY_TIMER_DELAY_RESULT;
}

bool TimerCancel(uint32_t handle, bool* out) {
  gCancelHandle = handle;
  *out = true;
  return true;
}

bool TimerTrigger(uint32_t handle, bool* out) {
  gTriggerHandle = handle;
  *out = true;
  return true;
}

class Host final : public defold_hermes::Host {
 public:
  void log(const std::string&, const std::string&) override {}
  double now() override { return 0.0; }
  std::string request(const std::string&, const std::string&) override { return {}; }
};

}  // namespace

extern "C" void defold_hermes_static_timer_report(uint32_t stage, double value) {
  if (stage >= 1 && stage <= 3) gResults[stage - 1] = value;
}

int main() {
  try {
    defold_hermes::installLuaTimerCapi(TimerDelay, TimerCancel, TimerTrigger);
    Host host;
    defold_hermes::Runtime runtime(host);
    const defold_hermes::StaticUnitCreator units[] = {sh_export_deherm_static_special_call};
    runtime.loadStatic(units, 1, "defold-hermes://static-special-call");
    if (gResults[0] != DEHERM_VERIFY_TIMER_DELAY_RESULT ||
        gResults[1] != 1.0 || gResults[2] != 1.0 ||
        gDelay != DEHERM_VERIFY_TIMER_DELAY_DELAY ||
        gRepeating != (DEHERM_VERIFY_TIMER_DELAY_REPEATING != 0) ||
        gCallback.runtime != DEHERM_VERIFY_TIMER_DELAY_CALLBACK_RUNTIME ||
        gCallback.slot != DEHERM_VERIFY_TIMER_DELAY_CALLBACK_SLOT ||
        gCallback.generation != DEHERM_VERIFY_TIMER_DELAY_CALLBACK_GENERATION ||
        gCallback.type != DEHERM_VERIFY_TIMER_DELAY_CALLBACK_TYPE ||
        gCancelHandle != DEHERM_VERIFY_TIMER_CANCEL_HANDLE ||
        gTriggerHandle != DEHERM_VERIFY_TIMER_TRIGGER_HANDLE) {
      throw std::runtime_error("Static Hermes special-call ABI vector mismatch");
    }
    defold_hermes::uninstallLuaTimerCapi();
    std::cout << "static-special-call:delay,cancel,trigger:exact\n";
    return 0;
  } catch (const std::exception& error) {
    defold_hermes::uninstallLuaTimerCapi();
    std::cerr << "static-special-call:error:" << error.what() << '\n';
    return 1;
  }
}
