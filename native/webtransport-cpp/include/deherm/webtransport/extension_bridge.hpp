#pragma once

#include <cstddef>

// The Defold extension calls this once per engine update. It is deliberately
// not part of the ordinary C client ABI: callbacks are delivered by the
// extension lifecycle and never by picoquic's network thread.
extern "C" std::size_t defold_webtransport_pump_callbacks(void);
