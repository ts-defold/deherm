#pragma once

#include <defold_hermes/lua_bridge_core.hpp>

#include <cstdint>

namespace defold_hermes {

using LuaTimerDelayFunction = uint32_t (*)(
    double delay,
    bool repeating,
    lua_bridge::Handle callback);
using LuaTimerUnaryFunction = bool (*)(uint32_t handle, bool* out);

void installLuaTimerCapi(
    LuaTimerDelayFunction delay,
    LuaTimerUnaryFunction cancel,
    LuaTimerUnaryFunction trigger);
void uninstallLuaTimerCapi();

}  // namespace defold_hermes
