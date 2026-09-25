# Native WebTransport core proof

This directory proves the native backend for the independently released
`defold-webtransport` extension. It is not itself a Defold library dependency:
Defold Extender does not run this FetchContent build. CI builds the pinned
static libraries per target and the release packager stages those artifacts
under `defold_webtransport/lib/<platform>/`.

## Pinned sources

| dependency | revision | license |
| --- | --- | --- |
| picoquic / h3zero / picowt | `8616f9d402cf886ade825e299e781a24fb4293db` | BSD-2-Clause |
| picotls | `bfa67875982afc4c24f21e146cef4747fa189c2f` | MIT |
| Mbed TLS 3.6.7 | `068ff080b369adfac81509f9b57b2afabaf82dc5` | Apache-2.0 OR GPL-2.0-or-later |
| mbedtls-framework | `dde0c4a0e448a0552f18817dcea633bb851fd288` | Apache-2.0 |

The extension builds its own ordinary-symbol Mbed TLS. Defold's `dmbedtls`
archive is an engine-private implementation: it is compiled with a private
`mbedtls_user_config.h`, rewrites symbols to `dm_*` through
`mbedtls_rename.h`, and does not expose Mbed TLS headers through dmSDK. Reusing
it would couple the extension to an undocumented engine configuration. The
ordinary symbols in the extension do not collide with Defold's renamed copy.

## Contract and memory

The core is WebTransport-shaped and protocol-agnostic. It exposes session
state, negotiated datagram capacity, asynchronous uni/bidirectional stream
creation, stream chunks and FIN, reset, stop-sending, datagrams, and close.
It never parses or emits War Battles channels or framing.

The network worker never calls Lua, Hermes, or Defold. Main-thread commands and
worker events cross two fixed 256 KiB byte arenas with 64 small FIFO
descriptors each. One 64 KiB worker scratch buffer and one 1.2 KiB datagram
staging buffer complete the fixed transport storage. Queue admission is
fail-closed and returns backpressure; datagrams are latest-only and never build
an unbounded stale queue. Enqueue, dequeue, stream write, and datagram delivery
perform no heap allocation. Native and ergonomic stream handles use fixed 256
entry registries with monotonically changing tokens: terminal streams retire
their slots, while stale public tokens fail closed instead of aliasing a reused
slot. Session construction, TLS setup, URL ownership,
and close-reason formatting are deliberately outside that hot path.

Incoming-stream hints are carried unchanged across generated TS, the native v1
C ABI, and the browser constructor. Native values above `uint16_t` fail closed;
picoquic advertises at least the WebTransport baseline of 100 incoming streams
per direction while retaining a stronger upstream default.

`deherm_webtransport_cpp_test` asserts the fixed client implementation remains
under 700 KiB; the verified arm64 build reports `597944` bytes.

## Verified evidence (arm64 macOS)

1. `picohttp_ct picowt_baton_basic picowt_baton_multi picowt_webtransport_requirements_met`
   passes upstream's picowt stream/datagram tests.
2. The Mbed TLS build completes without linking OpenSSL into picoquic. The
   release archives before dead stripping measured approximately 730 KiB
   picoquic core, 775 KiB mbedcrypto, 433 KiB mbedtls, and 87 KiB mbedx509.
3. `deherm_webtransport_cpp_test` passes URL/trust/fixed-storage checks.
   It also verifies local/remote uni/bidirectional event flags and retires more
   than 128 sequential stream handles without stale-handle reuse.
4. `deherm_webtransport_cpp_probe` connects to the repository's Deno 2.9
   WebTransport server with a leaf-certificate SHA-256 pin, completes TLS,
   QUIC, HTTP/3 CONNECT, a client bidirectional hello, the server's persistent
   unidirectional welcome stream, and credential acknowledgement. It then
   sends three valid 32-byte game inputs as QUIC datagrams. The authoritative
   `/readyz` counter reports accepted inputs with zero rejects; this is receiver evidence,
   not merely a successful client enqueue.
5. `deherm_webtransport_public_api_probe` exercises the ordinary community C
   facade against that same Deno server, including stream creation, explicit
   wrapper release, stale-token rejection, and session destruction reentered
   from the main-thread callback.
6. `browser_backend_test.mjs` executes the Emscripten JS library in a bounded
   fake browser runtime and covers async admission limits, 64/8 hint transport,
   local request correlation, incoming uni/bidirectional flags, and destroy
   cancellation.

The interop fixture understands the game protocol only so the authoritative
receiver can prove datagram delivery. That knowledge is confined to
`test/interop_probe.cpp`.

## Compatibility patch

Current picoquic requires `RESET_STREAM_AT` for the new `webtransport-h3`
draft. Deno 2.9 implements the browser-compatible legacy `webtransport`
setting (`MAX_WEBTRANSPORT_SESSIONS`) with Extended CONNECT and H3/QUIC
datagrams but does not advertise `RESET_STREAM_AT`. The pinned patch keeps the
new path strict and permits only that legacy combination. Without it, TLS and
QUIC succeed but picoquic refuses CONNECT locally.

The picotls patch moves its DTrace capability probe into the CMake build
directory. DTrace is disabled for extension artifacts; configuring the proof
must not create `.tmp.dprobes.h` in the repository root.

## Why picoquic

- **picoquic/h3zero/picowt:** direct C API for WebTransport CONNECT, streams,
  datagrams, worker wakeup, and a source-buildable TLS seam. This is the chosen
  backend.
- **Google QUICHE:** capable but brings BoringSSL, Abseil, a platform API, and
  an embedding build layer. Its public repository tells embedders to supply
  platform APIs/build files, making the Defold artifact matrix materially
  larger.
- **Proxygen/mvfst:** capable C++, but requires Folly plus a broad HTTP stack;
  it is disproportionate for a small standalone Defold extension.

## Release archive boundary

The purpose-built archive is `defold-webtransport-<version>.zip` and contains:

```text
game.project
defold_webtransport/
  ext.manifest
  include/defold_webtransport/...
  src/...                         # Defold/Lua lifecycle wrapper
  script/defold_webtransport.script_api
  webtransport/defold-hermes.bindings.json
  lib/web/library_defold_webtransport.js
  lib/<native-platform>/*.a|*.lib # downloaded content-addressed CI artifacts
  licenses/...
```

The extension-owned descriptor is the authority from which public C
declarations, Lua/editor metadata, and the optional deherm provider are
generated. Native implementation bodies and the browser JS backend implement
that generated contract. No platform binary is committed to git.
