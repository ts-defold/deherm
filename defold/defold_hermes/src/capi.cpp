#include <defold_hermes/capi.h>
#include <defold_hermes/lua_capi.hpp>

namespace {
defold_hermes::LuaTimerDelayFunction gTimerDelay = nullptr;
defold_hermes::LuaTimerUnaryFunction gTimerCancel = nullptr;
defold_hermes::LuaTimerUnaryFunction gTimerTrigger = nullptr;
}

namespace defold_hermes {

void installLuaTimerCapi(
    LuaTimerDelayFunction delay,
    LuaTimerUnaryFunction cancel,
    LuaTimerUnaryFunction trigger) {
  gTimerDelay = delay;
  gTimerCancel = cancel;
  gTimerTrigger = trigger;
}

void uninstallLuaTimerCapi() {
  gTimerDelay = nullptr;
  gTimerCancel = nullptr;
  gTimerTrigger = nullptr;
}

}  // namespace defold_hermes

extern "C" double defold_hermes_example_math_add(double a, double b) {
  return a + b;
}

extern "C" double defold_hermes_example_math_multiply(double a, double b) {
  return a * b;
}

extern "C" uint8_t defold_hermes_lua_timer_cancel(uint32_t handle) {
  bool result = false;
  return gTimerCancel && gTimerCancel(handle, &result) && result ? 1 : 0;
}

extern "C" uint32_t defold_hermes_lua_timer_delay(
    double delay,
    uint8_t repeating,
    uint32_t callback_runtime,
    uint32_t callback_slot,
    uint32_t callback_generation,
    uint32_t callback_type) {
  if (!gTimerDelay) return UINT32_MAX;
  const defold_hermes::lua_bridge::Handle callback = {
    callback_runtime,
    callback_slot,
    callback_generation,
    callback_type
  };
  return gTimerDelay(delay, repeating != 0, callback);
}

extern "C" uint8_t defold_hermes_lua_timer_trigger(uint32_t handle) {
  bool result = false;
  return gTimerTrigger && gTimerTrigger(handle, &result) && result ? 1 : 0;
}
