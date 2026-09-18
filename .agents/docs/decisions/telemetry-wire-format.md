---
type: Decision
title: Allocation-light telemetry uses fixed records plus protobuf batches
description: Keep telemetry writes bounded and allocation-free on engine hot paths while using generated protobuf/DDF schemas across native, browser, storage, and the deherm TUI.
tags: [telemetry, protobuf, ddf, performance, tui, memory]
status: accepted-design-implementation-pending
generated: { by: codex/gpt-5, at: 2026-09-17T23:10:00-04:00 }
sources:
  - id: schema
    resource: ../../packages/telemetry/schema/deherm_telemetry.proto
    title: Deherm telemetry protobuf schema
    author: team:ts-defold
  - id: resource-protobuf
    resource: ../../upstream/defold/engine/resource/proto/resource/resource_ddf.proto
    title: Pinned Defold resource reload DDF schema
    author: team:defold
---

# Decision

Deherm telemetry uses protobuf 2 as its versioned wire and capture schema. It
does not construct protobuf objects for every API call, lifecycle callback, or
frame sample. Each producer instead appends a fixed 32-byte record to a bounded,
preallocated single-producer/single-consumer ring:

```c
struct DehermTelemetryRecord {
    uint64_t timestamp_us;
    uint32_t kind;
    uint32_t stable_id;
    uint64_t value_a;
    uint64_t value_b;
};
```

The extension update tail drains records outside instrumented hot paths,
resolves numeric ids through a bounded string intern table, and serializes one
`TelemetryBatch`. Separate producer rings are required for threads that cannot
share the engine-thread producer. A full ring increments `dropped_records`; it
never blocks the frame or allocates a larger buffer.

The record is deliberately not a protobuf-shaped union. Its two payload words
have a kind-specific mapping, and dimensions that do not fit are emitted as
separate records joined by a bounded correlation id:

| Record kind | `stable_id` | `value_a` | `value_b` |
|---|---:|---:|---:|
| counter | metric id | signed counter bits | packed target/component ids |
| span begin | span id | correlation id | packed target/component ids |
| span end | span id | correlation id | status id |
| activation | state | build generation | runtime generation |
| log | level | source string id | message string id |
| transport span | route stable id | elapsed nanoseconds | transport \| shape<<8 \| status<<24 |

The `transport span` kind is the binding-boundary leaf. A crossing is far
shorter than the microsecond `timestamp_us` can express, so its duration travels
in `value_a` in nanoseconds and the record stands alone: one record and one
clock pair per crossing rather than a correlated begin/end pair. `timestamp_us`
keeps its declared meaning and is derived from the entry clock read, not a third
one. Producers of this kind are generated, never hand written, and are removed
entirely by the `DEHERM_PROFILE` compile switch described below.

Instance ids and content digests are attached off-path from bounded side tables
keyed by the correlation id; they are never added to the producer record. If a
side table is full, the event remains structurally valid and increments the
drop counter for the omitted dimension.

The generated schema records counters, spans, activation state, interned log
messages, session/sequence ids, and runtime generations. Activation events are
the authority for the TUI: Defold's reload HTTP response proves only that a DDF
message was queued. `ACTIVATION_COMMITTED` proves the candidate actually became
the active Hermes generation.

All protobuf fields are optional or repeated, and each message reserves a
future field range. This lets newer controllers read older batches and permits
fields to be retired without making every historical producer populate them.
Durations use 64-bit microseconds so long captures do not overflow after about
71 minutes.

# Compile-time switch for binding transports

Binding-transport instrumentation is governed by `DEHERM_PROFILE`, a CMake
option that is OFF by default and, when off, removes every field, branch,
storage byte, symbol, and cold string it would otherwise contribute. It follows
the discipline of Defold's own `DM_PROFILE`
(`upstream/defold/engine/dlib/src/dmsdk/dlib/profile.h:112`) but is deliberately
independent of `NDEBUG`, because Defold's profiler is unconditionally null in a
release build and therefore cannot measure a shipping configuration. Spans are
also emitted into `DM_PROFILE_DYN` wherever a profiler exists to receive them.

`pnpm test:profile-compile-out` proves the removal from the linked artifacts
with `nm` and `strings`, and asserts the same markers are present with the
switch on so the proof cannot pass vacuously. Measured overhead with the switch
on is 26-31 ns per span; see
`../research/transport-overhead-measurement.md` for the figures and their
evidence boundary.

# Transport mapping

Native targets send length-prefixed `TelemetryBatch` frames over a dedicated
debug-only stream or initially encode the same message into a structured log
record. HTML5 sends the identical serialized bytes over an outbound loopback
WebSocket. Capture files concatenate length-prefixed batches with a small file
header. The controller decodes once into bounded, column-oriented windows for
charts, tables, and JSON output; Rezi never owns authoritative runtime objects.

# Memory and privacy rules

Cap rings, intern entries, encoded batch bytes, trace windows, and string byte
lengths at startup. Strings and stack traces are interned off-path and may be
redacted or disabled. API tracing is sampled by default. Every batch reports
drops, and the TUI displays them prominently. The implementation is not
conformant until stress tests prove zero producer-path allocations, bounded
memory after 1,000 reload cycles, stable sequence handling, and native/browser
decode parity.
