#pragma once

// Compile-time-switched transport telemetry for generated binding boundaries.
//
// `DEHERM_PROFILE` is a BUILD-TIME definition supplied by the `DEHERM_PROFILE`
// CMake option. It is OFF by default. When it is off every macro in this header
// expands to nothing: no fields, no branches, no storage, and no symbols or
// strings reach the binary. `tests/release-build.test.mjs` proves that from the
// linked artifacts rather than asserting it.
//
// This mirrors Defold's own discipline in
// upstream/defold/engine/dlib/src/dmsdk/dlib/profile.h:112
//
//     #if defined(NDEBUG) || defined(DM_PROFILE_NULL)
//         #define DM_PROFILE(name)
//
// with one deliberate difference: `DEHERM_PROFILE` is independent of `NDEBUG`.
// Defold nulls `DM_PROFILE` unconditionally under `NDEBUG`, so it cannot answer
// "what does this transport cost in a release build". `DEHERM_PROFILE` can be
// enabled in a Release configuration for exactly that measurement.
//
// Sample transport and layout follow
// .agents/docs/decisions/telemetry-wire-format.md: a fixed 32-byte record
// appended to a bounded, preallocated single-producer ring. A full ring
// increments a drop counter; it never blocks, grows, or allocates.

#include <stdint.h>

// ---------------------------------------------------------------------------
// Stable numeric ids. These are plain preprocessor constants: they emit no
// storage and no symbols in either build, so they are declared unconditionally
// and generated call sites may reference them without a guard.
// ---------------------------------------------------------------------------

// Record kinds. 0-4 are reserved by the telemetry wire-format decision table
// (counter, span begin, span end, activation, log).
#define DEHERM_PROFILE_KIND_TRANSPORT_SPAN UINT32_C(5)

// Transports of a runtime, named exactly as the `runtimes` block of
// packages/bindings/generated/defold-binding-lowering-plan.json names them.
// `raw-lua` is not a deherm transport: it is the uninstrumented baseline a
// benchmark harness measures for comparison.
#define DEHERM_PROFILE_TRANSPORT_LUA_STACK     UINT32_C(1)
#define DEHERM_PROFILE_TRANSPORT_C_ABI_NATIVE  UINT32_C(2)
#define DEHERM_PROFILE_TRANSPORT_TYPED_NATIVE  UINT32_C(3)
#define DEHERM_PROFILE_TRANSPORT_JSI           UINT32_C(4)
#define DEHERM_PROFILE_TRANSPORT_DIRECT_MEMORY UINT32_C(5)
#define DEHERM_PROFILE_TRANSPORT_RAW_LUA       UINT32_C(6)
#define DEHERM_PROFILE_TRANSPORT_COUNT         UINT32_C(7)

// Span completion status. Kept small so it packs into one byte of `value_b`.
#define DEHERM_PROFILE_STATUS_OK     UINT32_C(0)
#define DEHERM_PROFILE_STATUS_FAILED UINT32_C(1)

#if !defined(DEHERM_PROFILE)

#define DEHERM_PROFILE_ENABLED 0

// Every instrumentation macro is empty. Name literals passed by generated call
// sites are discarded by the preprocessor and never reach the object file.
#define DEHERM_PROFILE_TRANSPORT_SCOPE(transport, stable_id, shape_id, name) ((void)0)
#define DEHERM_PROFILE_SCOPE_FAILED() ((void)0)

#else

#define DEHERM_PROFILE_ENABLED 1

#include <stddef.h>

// Bounded producer ring capacity in records, overridable at configure time.
// 8192 * 32 bytes = 256 KiB of statically reserved storage.
#if !defined(DEHERM_PROFILE_RING_CAPACITY)
#define DEHERM_PROFILE_RING_CAPACITY 8192
#endif

#if defined(DEHERM_PROFILE_DMPROFILE)
#include <dmsdk/dlib/profile.h>
#endif

namespace defold_hermes {
namespace profile {

/// The fixed 32-byte producer record from the telemetry wire-format decision.
///
/// Field names and offsets are the decision's. `timestamp_us` carries the span
/// start in microseconds since the process epoch, as specified. Transport spans
/// are far shorter than a microsecond, so the elapsed time they actually
/// measure travels in `value_a` in nanoseconds; see the kind table below.
///
/// | Record kind    | `stable_id`     | `value_a`         | `value_b`                       |
/// |----------------|-----------------|-------------------|---------------------------------|
/// | transport span | route stable id | elapsed nanosecs  | transport | shape<<8 | status<<24 |
struct Record {
  uint64_t timestamp_us;
  uint32_t kind;
  uint32_t stable_id;
  uint64_t value_a;
  uint64_t value_b;
};

static_assert(sizeof(Record) == 32, "deherm telemetry record layout drifted");

/// Bounded single-producer/single-consumer ring. Never allocates, never grows,
/// never blocks. A write to a full ring increments `dropped` and is discarded.
struct Ring {
  static constexpr uint32_t kCapacity = static_cast<uint32_t>(DEHERM_PROFILE_RING_CAPACITY);
  static_assert((kCapacity & (kCapacity - 1)) == 0 && kCapacity >= 2,
      "DEHERM_PROFILE_RING_CAPACITY must be a power of two of at least 2");

  Record records[kCapacity];
  uint32_t write;
  uint32_t read;
  uint64_t produced;
  uint64_t dropped;
};

/// The engine-thread producer ring. Statically stored; separate threads that
/// cannot share it require their own ring, per the telemetry decision.
Ring& ring() noexcept;

/// Monotonic nanosecond clock used for span durations.
uint64_t nowNanoseconds() noexcept;

/// Append one record. Allocation-free and branch-bounded.
void append(const Record& record) noexcept;

/// Drain up to `capacity` records into `out`, returning how many were copied.
/// Intended for the extension update tail and for benchmark reporting.
uint32_t drain(Record* out, uint32_t capacity) noexcept;

/// Discard buffered records without reading them; keeps the drop counter.
void reset() noexcept;

inline uint64_t packTransportSpanDimensions(uint32_t transport, uint32_t contractShape,
    uint32_t status) noexcept {
  return static_cast<uint64_t>(transport & 0xFFu)
      | (static_cast<uint64_t>(contractShape & 0xFFFFu) << 8)
      | (static_cast<uint64_t>(status & 0xFFu) << 24);
}

/// RAII span. Reads the clock at entry and exit, then appends exactly one
/// record. It performs no allocation, takes no lock, and touches no heap.
class TransportScope {
 public:
  // Exactly two clock reads per span, one at entry and one at exit. The
  // microsecond timestamp is derived from the entry read rather than taken
  // separately: a third read would be pure instrumentation cost.
  TransportScope(uint32_t transport, uint32_t stableId, uint32_t contractShape) noexcept
      : begin_(nowNanoseconds()), transport_(transport),
        stableId_(stableId), contractShape_(contractShape), status_(DEHERM_PROFILE_STATUS_OK) {}

  TransportScope(const TransportScope&) = delete;
  TransportScope& operator=(const TransportScope&) = delete;

  void failed() noexcept { status_ = DEHERM_PROFILE_STATUS_FAILED; }

  ~TransportScope() {
    Record record;
    record.timestamp_us = begin_ / UINT64_C(1000);
    record.kind = DEHERM_PROFILE_KIND_TRANSPORT_SPAN;
    record.stable_id = stableId_;
    record.value_a = nowNanoseconds() - begin_;
    record.value_b = packTransportSpanDimensions(transport_, contractShape_, status_);
    append(record);
  }

 private:
  uint64_t begin_;
  uint32_t transport_;
  uint32_t stableId_;
  uint32_t contractShape_;
  uint32_t status_;
};

}  // namespace profile
}  // namespace defold_hermes

#define DEHERM_PROFILE_PASTE_(a, b) a##b
#define DEHERM_PROFILE_PASTE(a, b) DEHERM_PROFILE_PASTE_(a, b)

// Emit the same scope into Defold's profiler so the engine profiler and the web
// profiler show deherm transports for free. The condition is exactly the one
// profile.h:112 uses to null itself: under NDEBUG or DM_PROFILE_NULL there is no
// profiler to emit into, so we emit nothing rather than a dead name cache. Our
// own ring is unaffected either way and keeps working in Release, which is the
// whole reason DEHERM_PROFILE exists.
//
// The packaged Defold extension is compiled by the Extender with `-O2 -g` and no
// NDEBUG, so a shipped extension built with DEHERM_PROFILE does get the scopes.
#if defined(DEHERM_PROFILE_DMPROFILE) && !defined(NDEBUG) && !defined(DM_PROFILE_NULL)
#define DEHERM_PROFILE_DM_SCOPE_(name, line)                                  \
  static uint64_t DEHERM_PROFILE_PASTE(dehermProfileNameHash, line) = 0;      \
  DM_PROFILE_DYN((name), &DEHERM_PROFILE_PASTE(dehermProfileNameHash, line));
#else
// No profiler to emit into. The name is still consumed syntactically so the
// generated identity tables stay referenced; the cast itself compiles to
// nothing.
#define DEHERM_PROFILE_DM_SCOPE_(name, line) static_cast<void>(name);
#endif

#define DEHERM_PROFILE_TRANSPORT_SCOPE_(transport, stable_id, shape_id, name, line) \
  DEHERM_PROFILE_DM_SCOPE_(name, line)                                              \
  ::defold_hermes::profile::TransportScope dehermProfileScope(                      \
      (transport), static_cast<uint32_t>(stable_id), static_cast<uint32_t>(shape_id))

/// Open a transport span for the remainder of the enclosing block. `name` is a
/// cold string used only by dmProfile; the ring carries numeric ids only.
/// At most one per block: the scope object has a fixed name so a second one in
/// the same scope is a compile error rather than a silent double count.
#define DEHERM_PROFILE_TRANSPORT_SCOPE(transport, stable_id, shape_id, name) \
  DEHERM_PROFILE_TRANSPORT_SCOPE_(transport, stable_id, shape_id, name, __LINE__)

/// Mark the open scope as a failed crossing.
#define DEHERM_PROFILE_SCOPE_FAILED() dehermProfileScope.failed()

#endif  // DEHERM_PROFILE
