---
type: research
title: Defold WebTransport public API compatibility
description: Source-backed boundary between the proven browser/Deno interoperability waist and additive WebTransport Candidate Recommendation surface.
tags: [research, defold, webtransport, typescript, compatibility]
status: active
generated: { by: codex/gpt-5, at: 2026-09-24T00:00:00-04:00 }
sources:
  - id: w3c-webtransport-cr-2026
    resource: https://www.w3.org/TR/2026/CR-webtransport-20260730/
    title: WebTransport Candidate Recommendation Snapshot
    author: team:w3c-webtransport
  - id: deno-webtransport-platform
    resource: https://docs.deno.com/api/web/platform/
    title: Deno WebTransport platform API
    author: team:deno
  - id: deno-upgrade-webtransport
    resource: https://docs.deno.com/api/deno/~/Deno.upgradeWebTransport
    title: Deno.upgradeWebTransport
    author: team:deno
  - id: war-battles-browser-adapter
    resource: ../../../examples/war-battles-online/core/browser-webtransport.ts
    title: War Battles browser WebTransport adapter
    author: team:deherm
  - id: war-battles-quic-evidence
    resource: ../../../examples/war-battles-online/evidence/webtransport-quic-loopback.json
    title: War Battles Chrome-to-Deno WebTransport runtime evidence
    author: team:deherm
---

# Scope and authorities

This note fixes the public TypeScript compatibility target for the standalone
Defold extension. It does not describe the provider ABI, native handles, event
polling, or War Battles framing. Those are implementation layers below the
public facade.

The standards authority is the W3C WebTransport Candidate Recommendation
Snapshot published 30 July 2026. The deployed-runtime authority is Deno 2.9.7's
documented platform API plus the repository's Chrome 154-to-Deno 2.9.7 loopback
evidence. The evidence proves only the features exercised by the War Battles
adapter: session readiness and closure, bidirectional and unidirectional byte
streams, and datagrams. It does not prove every property in either runtime.

# Compatibility decision

Version 0.1 exposes one WebTransport-shaped facade on native and browser
targets. Application code does not choose a target adapter. The required-now
surface is deliberately the smallest browser/Deno interoperability waist that
War Battles has exercised. Candidate Recommendation members outside that waist
are forward-compatible additions: their names and semantics are reserved, but
they must not be implemented as silent no-ops or approximated by a different
transport primitive.

The one intentional compatibility extension is `datagrams.writable`. The 2026
CR defines `datagrams.createWritable(options)` so multiple outgoing datagram
writables can participate in send groups. Deno 2.9.7 and the proven War Battles
browser adapter expose the earlier single `datagrams.writable` stream. Removing
that property now would make the facade conform nominally to the CR while
breaking the deployed interoperability proof. Version 0.1 therefore retains
`writable`; `createWritable()` is additive. A later major compatibility change
may retire the property only after the exercised runtimes and the native
provider both support the factory semantics.

# Source-backed matrix

| Family | W3C 30 July 2026 CR | Deno 2.9.7 documented surface | War Battles exercised | 0.1 disposition |
| --- | --- | --- | --- | --- |
| Session lifecycle | `ready`, `closed`, `draining`, `close`; reliability, congestion control, protocol and response metadata | `ready`, `closed`, `close`; no documented `draining` or session metadata | `ready`, `closed`, `close` | Lifecycle trio required now; `draining` and metadata additive |
| Datagrams | `readable`, `createWritable(options)`, maximum size, age and buffer limits | `readable`, single `writable`, maximum size, age and high-water-mark controls | Reads, writes, and checks maximum size | Read/max required; `writable` compatibility-required; CR factory and controls additive |
| Outgoing unidirectional streams | `createUnidirectionalStream(options)` returns a send stream | Same core call and send-stream shape | Server adapter opens and writes streams | Required now |
| Incoming unidirectional streams | readable stream of receive streams | Same | Browser client consumes server streams | Required now |
| Bidirectional streams | create/incoming streams with readable and writable halves | Same | Browser client opens; Deno server consumes | Required now |
| Stream cancellation/FIN | Inherited Streams `abort`, `cancel`, writer `close`; WebTransport stream errors carry codes | Inherited Streams shape is present | Writer close and reverse-readable cancel are exercised | Required through standard stream behavior, not separate facade methods |
| Constructor options | Pooling, unreliable requirement, headers, certificate hashes, congestion control, anticipated incoming stream counts, protocols, datagram readable type | Pooling, unreliable requirement, certificate hashes, congestion control | Certificate hash and both anticipated incoming counts | Exercised three required; remaining options additive |
| Stream send options | Send group, send order, wait-until-available | Documented | Not exercised | Additive |
| Statistics | Connection, datagram, send-stream, receive-stream and send-group stats | Stream and send-group stats documented; no session `getStats` | Not exercised | Additive; do not fabricate unavailable counters |
| Send groups | Session creates groups; datagram writables and send streams participate by group/order | Group creation and stream group/order documented | Not exercised | Additive |
| TLS exporter | Session `exportKeyingMaterial(label, context, outputLength)` | Not documented in Deno 2.9.7 | Not exercised | Additive and security-sensitive |
| Atomic writer | `atomicWrite` plus `commit` | `atomicWrite` documented, not `commit` | Not exercised | Additive only as exact semantics become available |
| Errors | `WebTransportError` distinguishes session/stream and optional stream code | Documented | Only generic rejection/close handling exercised | Typed error refinement additive |

# Required-now TypeScript waist

The facade must provide construction from an HTTPS URL and the exercised
options; stable `ready` and `closed` promises; `close(closeInfo?)`; datagram
readable, writable and maximum size; outgoing and incoming uni/bidi streams;
and bidirectional readable/writable halves. Browser and dynamic-Hermes builds
use `Uint8Array`; the sound Static Hermes projection uses `Array<number>` at
the same named stream boundary. Native targets use bounded structural streams
owned by the facade and do not assume DOM Web Streams globals. Byte writes do
not imply message boundaries, so application framing remains above the facade.

`ready` fulfills once the session can be used. `closed` fulfills with
`{ closeCode, reason }` after a clean session close and rejects on failure;
`close()` requests session termination and is not a synchronous destruction
signal. The certificate-hash option retains both its algorithm and byte-value
members. These value shapes are part of the public waist even though they are
not separate transport operations.

The anticipated-incoming-stream options are required despite their absence
from Deno's client type because Chrome uses them in the proven client path to
prevent the server's snapshot/control streams from starving. Deno is the
server-side adopter in that proof, not the constructor consumer.

Native 0.1 requires exactly one SHA-256 server-certificate hash because the
picoquic backend does not yet provide OS/root-store trust. Omitting it rejects
before opening. Browser delegation retains the browser's normal trust behavior.
The low-level v1 open ABI does not transmit anticipated stream counts, so native
0.1 rejects nonzero hints instead of silently dropping them. Browser delegation
continues to pass the hints to the browser implementation.

# Native bounds

The native facade owns a bounded set of 16 sessions. Each session caps live
plus pending streams at 256 and each command/event descriptor ring at 256
entries with a 256 KiB byte arena. The current arm64 macOS build measures
617,000 bytes of fixed `Client` storage, allowing a 255-chunk ordinary burst
while retaining one terminal slot. Terminal stream halves retire their
internal entries; late data for a retired locally-initiated stream is consumed
instead of resurrecting a stale public handle. The public poll buffer remains
bounded by the generated `native_v1` payload limit and fails closed when the
caller cannot retain the current event.

The event ring permanently reserves one descriptor plus 255 payload bytes for
the terminal close event. Saturating ordinary traffic therefore cannot strand
`closed`/`failed` state without its corresponding event. A server
`CLOSE_WEBTRANSPORT_SESSION` capsule is incrementally parsed on the control
stream (including fragmented input) and is never surfaced as an application
stream. Local write/reset/stop failures terminalize the affected stream half,
not the whole session. When RESET_STREAM_AT was not negotiated, reset uses
plain QUIC RESET_STREAM rather than failing the session.

Incoming QUIC stream credits use a 100-stream baseline per direction and fail
closed when `max(100, requested_uni) + max(100, requested_bidi)` exceeds the
256-entry registry. WebTransport's 32-bit application error codes are mapped
to the designated H3 error-code range on reset/stop/connection close and mapped
back on receipt; reserved H3 gaps and values outside the range are protocol
failures. Graceful local or peer closes remain `closed` even with a nonzero
application code, whereas transport/invariant errors become `failed`. The
terminal event is enqueued before terminal state is published, and close-state
transition uses compare/exchange so an already `closed`/`failed` client cannot
regress to `closing`.

The standalone Defold Lua adapter preserves the originating script instance
with `dmScript::LuaCallbackInfo` and invokes callbacks through
`SetupCallback`/`TeardownCallback`; a raw registry function reference is not a
valid substitute. Lua stream userdata tracks the readable and writable halves
separately, so peer FIN retires only the read half of a bidirectional stream,
while an accepted FIN/reset can immediately release an outgoing
unidirectional wrapper. Callback destruction requested reentrantly from inside
the callback is deferred until `TeardownCallback` completes; the session can
be destroyed without invalidating the callback frame currently executing.
Lua option decoding rejects over-bound certificate arrays and wrong-typed
certificate/stream-hint fields rather than truncating or silently defaulting.
The browser backend treats any event-byte or event-count
overflow as one terminal session failure and requests one transport close. It
must never discard a datagram or stream chunk and continue the session. Its
live-stream registry is independently capped at 256 entries, matching the
native core; pending local creates count against that cap, and remote stream
growth beyond it fails the session closed. Once `closeRequested` is set, both
ordinary and `native_v1` browser entry points reject new stream creation,
stream writes, and datagrams. Late create promises are aborted/cancelled rather
than registered, and stream release decrements the explicit live count exactly
once.

Evidence boundary (2026-09-24): focused native tests prove fragmented capsule
parsing, malformed-capsule rejection, the reserved close slot under a saturated
ring, reset-mode selection, per-stream failure classification, and local-vs-peer
stream resurrection policy. The same tests and the real threaded client pass
under ASan+UBSan. A pinned-certificate arm64 macOS client interoperates with the
Deno WebTransport server for CONNECT, reliable streams, three datagrams,
stream-local command failures, plain-reset fallback, and peer close. Deno's
game server closes QUIC directly after its reset policy, so it is not evidence
for receiving a CLOSE_WEBTRANSPORT_SESSION capsule; that claim remains bounded
to the focused parser test. The browser runtime fixture additionally saturates
the live-stream registry through the actual registration helper, proves release
and replacement accounting, drives one excess remote stream through the
incoming-reader path, and verifies post-close rejection on both public ABIs.
The native fixture also proves bounded-credit sums, H3 mapping boundaries and
reserved gaps, unsigned reservation arithmetic, close publication order,
terminal-state non-regression, poison-head discard, and the 255-data-plus-close
descriptor burst. The live Deno probe observes the mapped reset on the wire and
asserts that the resulting nonzero peer close leaves the client `closed`; Deno
reports the transport-layer H3 code rather than decoding it for its application
log, which is a server API behavior rather than evidence of a raw-code send.
Defold/Bob linkage is separate evidence.

# Forward-compatible additions

`draining` is the first lifecycle addition to prioritize: it is a distinct
server request for graceful migration, not an alias for `closed`. Connection
and stream statistics follow only when the backend can report the specified
units and monotonicity; absent counters remain absent rather than zero. Send
groups require real scheduling semantics across streams and datagram
writables. The TLS exporter requires the actual TLS session exporter and its
label/context bounds; deriving unrelated bytes is not compatible.

The CR itself marks connection-level `bytesAcknowledged` as at risk and notes
implementation risk around low-latency congestion control. Neither can anchor
the 0.1 compatibility claim. If added, their availability must remain explicit
instead of returning invented zeroes or silently selecting default congestion
control.

Pooling, HTTP/2 reliable-only operation, custom headers, protocol negotiation,
response headers, atomic writes, and readable BYOB selection remain outside the
0.1 runtime claim. Their names are reserved so adding them is source-compatible,
but an unsupported requested option must reject clearly instead of being
accepted and ignored.

# Drift guard

`defold_webtransport/webtransport/public-api-compatibility.json` is the
machine-readable classification and community-surface recipe. Together with
the low-level descriptor it generates `client.h`, Lua registration and docs,
and dynamic/Static TypeScript facades. Tests reject handle/poll/provider leakage
from those ordinary surfaces and exercise bounds, backpressure, close, browser
identity, and drift. The sole low-level exemption is the explicitly advanced,
versioned `native_v1.h` ABI.

Standalone-extension drift checks additionally compare every ergonomic
`client.h` function with the common Emscripten library exports, syntax-check the
Defold C++ adapter, and execute the browser overflow terminalization helper.
This prevents the native and HTML5 implementations from silently diverging on
stream release, callback ownership, or queue-failure semantics.
