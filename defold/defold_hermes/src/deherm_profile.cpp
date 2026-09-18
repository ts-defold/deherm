// Producer ring for compile-time-switched transport telemetry.
//
// The entire translation unit is gated on DEHERM_PROFILE. With the option off
// this file contributes no code, no data, and no symbols; CMake also leaves it
// out of every target, so the guard is belt and braces for consumers that add
// the file by glob (the headless conformance driver does exactly that).

#include <defold_hermes/deherm_profile.hpp>

#if DEHERM_PROFILE_ENABLED

#include <chrono>

namespace defold_hermes {
namespace profile {
namespace {

// Statically reserved. The ring is the only storage the producer path touches,
// and it is reserved before any binding call can run.
Ring gRing{};

}  // namespace

Ring& ring() noexcept { return gRing; }

// No lazily initialised epoch: a function-local static would put a guard load
// and a branch on the producer path. steady_clock is monotonic and its raw
// nanosecond count fits uint64 for any realistic uptime.
uint64_t nowNanoseconds() noexcept {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

void append(const Record& record) noexcept {
  const uint32_t next = (gRing.write + 1u) & (Ring::kCapacity - 1u);
  if (next == gRing.read) {
    ++gRing.dropped;
    return;
  }
  gRing.records[gRing.write] = record;
  gRing.write = next;
  ++gRing.produced;
}

uint32_t drain(Record* out, uint32_t capacity) noexcept {
  if (out == nullptr) return 0;
  uint32_t copied = 0;
  while (copied < capacity && gRing.read != gRing.write) {
    out[copied++] = gRing.records[gRing.read];
    gRing.read = (gRing.read + 1u) & (Ring::kCapacity - 1u);
  }
  return copied;
}

void reset() noexcept {
  gRing.read = gRing.write;
}

}  // namespace profile
}  // namespace defold_hermes

#endif  // DEHERM_PROFILE_ENABLED
