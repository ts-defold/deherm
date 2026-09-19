---
type: Architecture Decision
title: Carry netcode over UDP on native and over WebTransport datagrams on HTML5, by swapping its socket layer
description: netcode's protocol, crypto and connection state machine are target-independent; only its bottom layer is not, and it is designed to be replaced. That replacement is verified in the upstream source and exercised end to end, natively and under wasm, with the socket syscalls poisoned.
tags: [decision, netcode, transport, webtransport, html5, wasm, native-extension, war-battles]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-19T14:30:00-04:00 }
sources:
  - id: netcode-upstream
    resource: https://github.com/mas-bandwidth/netcode
    title: netcode - secure client/server protocol over UDP, revision 47a156b17df9110c1a2d5d8cbf5b7768d1838a47 (1.4.8)
    author: human:glennfiedler
  - id: netcode-standard
    resource: https://github.com/mas-bandwidth/netcode/blob/main/STANDARD.md
    title: The netcode 1.02 wire standard
    author: human:glennfiedler
  - id: netcode-io-domain
    resource: https://netcode.io
    title: netcode.io - a set of networking libraries for Zig
    author: human:endel
  - id: target-macros
    resource: ../../../packages/bindings/overrides/dmsdk-target-macros.json
    title: The declared bundle targets and their clang triples
    author: project:deherm
  - id: transport-selection
    resource: ../../../examples/war-battles-online/integration/transport-selection.ts
    title: War Battles evidence-gated transport selection
    author: project:deherm
  - id: html5-bundle
    resource: ./html5-bundle-and-static-wasm.md
    title: HTML5 bundle and Static Wasm profiles
    author: project:deherm
  - id: typed-native-manifest
    resource: ../../../examples/war-battles-online/defold/defold_hermes_typed_native/ext.manifest
    title: Why a second extension declares no context of its own
    author: project:deherm
---

# The question this had to answer first

War Battles Online targets HTML5 among other things, and the wanted end state is
a WebTransport session carrying the game. netcode is a protocol **over UDP**, and
a browser cannot open a UDP socket. Everything else about wrapping netcode as a
Defold extension is ordinary work; this is the part that decides whether the work
is worth starting.

A design that silently drops HTML5 would be a failed design here, so the answer
was established before any binding code was written, and it was established by
reading and running the upstream source rather than by trusting its reputation
for modularity.

# What was verified in the netcode source

netcode's client and server configuration structs each carry three fields
(`netcode.h:208-210` and `netcode.h:285-287` at the pinned revision):

```c
int override_send_and_receive;
void (*send_packet_override)(void*,struct netcode_address_t*,NETCODE_CONST uint8_t*,int);
int (*receive_packet_override)(void*,struct netcode_address_t*,uint8_t*,int);
```

Four things were checked in `netcode.c`, because the existence of a callback
field is not the same as a socket layer that can actually be removed:

1. **No socket is created.** `netcode_client_socket_create` and
   `netcode_server_socket_create` both wrap their call to `netcode_socket_create`
   in `if ( !config->override_send_and_receive )`. With the flag set, the
   function returns 1 having done nothing.
2. **No socket is sent to.** Both ends share one send path,
   `netcode_send_packet_to_address`, whose dispatch is `network_simulator`, else
   `send_packet_override`, else the socket matching the destination address
   family. The override is checked before either socket.
3. **No socket is received from.** The client and server update loops call
   `config->receive_packet_override(...)` where they would otherwise call
   `netcode_socket_receive_packet`.
4. **A partial override is refused at create time**, not dereferenced on the
   first update: both create functions return NULL with
   `..._MISSING_OVERRIDE_CALLBACK` if the flag is set and either callback is
   absent.

The split is therefore clean, and it is clean *by design* - upstream's own test
suite uses it (`test_wire_*` in `netcode.c`), so it is a supported configuration
rather than an accident of the code's shape that a refactor could take away.

# What was measured, not argued

Reading the source establishes that the socket layer *should* be removable.
`packages/defold-netcode/tests/override_loopback.c` establishes that it *is*.

A netcode client and a netcode server are created on the host-datagram transport
and driven through a real connect handshake - connect-token decryption,
challenge/response, the lot - and then through 240 frames of payload packets in
both directions. Nothing carries bytes between them but the test draining one
end's outbound queue into the other end's inbound queue.

| Run | Handshake | Payloads delivered, of 240 offered each way |
| --- | --- | --- |
| Native arm64-osx, clean channel | connected on tick 10 | 239 server, 239 client |
| Native arm64-osx, 1-in-3 datagrams dropped | connected on tick 10 | 159 server, 159 client |
| wasm32 under emsdk 4.0.6 / node, clean | connected on tick 10 | 239 server, 239 client |
| wasm32 under emsdk 4.0.6 / node, 1-in-3 dropped | connected on tick 10 | 159 server, 159 client |

The wasm numbers are not merely "also passing" - they are **identical**, tick for
tick and packet for packet, to the native ones. The protocol does not behave
differently on wasm; it behaves the same, which is the strongest available
evidence that nothing target-specific leaks into the connection state machine.

## The negative was measured too

A passing test proves packets moved. It does not prove no socket was opened
alongside. `packages/defold-netcode/tests/socket_poison.c` supplies strong
definitions of `socket`, `bind`, `sendto` and `recvfrom` that `abort()`, and the
same conformance binary linked against them still passes.

That is only worth something if the poison can fail, so
`tests/poison_selftest.c` creates a **default-config** server on the same link
line and is asserted to abort inside `socket()`. `scripts/build-and-test.sh`
requires that abort, and requires the diagnostic to name `socket()` rather than
accepting any non-zero exit. Without that companion, a pass under poison would
be indistinguishable from the poison not being linked at all.

# The decision, per target

The protocol object is the same everywhere. Only the bottom layer differs, and
it differs by a **runtime argument**, not a build setting - there is no
per-target source, no per-target library, and no `#ifdef` selecting a transport.

| Bundle target | What carries netcode packets |
| --- | --- |
| `arm64-osx`, `x86_64-osx`, `x86-osx` | netcode's own BSD sockets |
| `arm64-ios`, `arm64_sim-ios` | netcode's own BSD sockets |
| `arm64-linux`, `x86_64-linux` | netcode's own BSD sockets |
| `arm64-android`, `armv7-android`, `x86_64-android` | netcode's own BSD sockets |
| `x86_64-win32` | netcode's own Winsock path |
| `wasm-web`, `wasm_pthread-web` | WebTransport datagrams, via the host-datagram transport |

That is all thirteen triples declared in
`packages/bindings/overrides/dmsdk-target-macros.json`, with nothing left out.

`x86-osx` is listed because the file declares it; Defold retired 32-bit macOS
and `defold/defold_hermes/ext.manifest` already omits it. Nothing here depends
on it either way, since there is no per-target artefact to build for it.

## Why datagrams rather than a reliable WebTransport stream

netcode is unreliable-ordered with its own sequencing, replay protection and
timeouts. Putting it on a reliable stream would reintroduce precisely the
head-of-line blocking the protocol exists to avoid, and would turn its loss
handling into dead code that has never run. WebTransport datagrams are the
matching primitive, and they are what `core/browser-webtransport.ts` in War
Battles already reaches for.

## The one place the fit is imperfect

`NETCODE_MAX_PACKET_SIZE` is 1200, which sits inside a typical QUIC datagram
budget. The **connection request** packet does not: it carries a 2048-byte
connect token. A QUIC path that reports a `maxDatagramSize` below that cannot
carry the handshake.

This is not papered over. `lib/web/library_defold_netcode.js` drops an
oversized datagram and counts it, rather than inventing a fragmentation scheme -
netcode retransmits the connection request, so a drop costs a retry, whereas a
second protocol underneath the first would be unproven code on the security
path. `maxDatagramSize` is read from the live session and exposed, so a path too
small to complete a handshake is diagnosable instead of presenting as an
unexplained "connection timed out".

Whether real paths report a large enough `maxDatagramSize` is **not established
here**. It is the first thing a live WebTransport gate must measure.

# The implementation is C and BSD-3-Clause, not Zig

This was worth checking rather than assuming, and the assumption in circulation
was wrong in an understandable way.

* `https://netcode.io` is **not this protocol**. That domain hosts Endel
  Dreyer's pure-Zig QUIC / TLS 1.3 / HTTP/3 / WebTransport stack; the "netcode"
  multiplayer server listed there is marked coming soon. Nothing on it
  implements this wire format. The name collision is the whole source of the
  confusion, and the Zig project's actual subject - WebTransport - makes it
  easier still to mistake for the thing we needed.
* `github.com/networkprotocol/netcode` and `.../netcode.io` both **redirect** to
  `mas-bandwidth/netcode`; all three report the same HEAD
  (`47a156b17df9110c1a2d5d8cbf5b7768d1838a47`).
* The GitHub API reports that repository as language **C**, licence
  **BSD-3-Clause**, not archived. Its language breakdown is 743 KB of C against
  1.9 KB of C++.

There was therefore no choice to make between a Zig and a C implementation: at
the canonical URL there is one implementation and it is C. Ports exist in Rust
(`mas-bandwidth/netcode.rs`) and C# (`mas-bandwidth/netcode.cs`, AGPL-3.0), and
neither is a better fit - a Defold extension wants a C ABI, and the C# port's
licence would be a problem this repository should not take on.

## What that decides about packaging

Because the source is C and permissively licensed, **it is vendored as source and
Extender compiles it per target**. The alternative - thirteen precompiled static
libraries, one per triple - would have to be built, digest-pinned and kept in
step for each of the thirteen, and would buy nothing that a pinned source digest
does not already buy. It would also be the only thing in this repository
requiring a cross-compilation lane for a dependency that compiles cleanly
everywhere from one set of files.

Provenance is `packages/defold-netcode/scripts/vendor-netcode.mjs`: it clones at
the pinned revision, copies an explicit file list verbatim, and records a sha256
per file into `vendor-digests.json`. `--check` re-derives and refuses a
mismatch. The vendored bytes are committed because Extender needs them; they are
not opaque, because the script reproduces them.

## Licences

| Component | Licence | Conflict |
| --- | --- | --- |
| netcode 1.4.8 | BSD-3-Clause | none |
| vendored libsodium subset (amalgamated from 1.0.22, ships inside the netcode tree) | ISC | none |

Both are permissive and both are compatible with this repository's MIT. The
libsodium subset carries no licence file of its own - its terms live in the
leading comment of `sodium.h` - so the vendoring script **extracts** that banner
into `licenses/LIBSODIUM.txt` rather than transcribing it, which means an
upstream change to the terms shows up as a digest mismatch instead of going
unnoticed.

Upstream also makes a request the licence does not require: credit "netcode -
Glenn Fiedler and Rowan Claude" in product credits. Any game shipping this
should honour it.

# Two APIs, as siblings

The extension exposes the protocol twice, and the relationship between them is
the point.

`include/defold_netcode/defold_netcode.h` is a flat C ABI. It is what a Static
Hermes adapter calls, and it exists so that a TypeScript game sending one packet
per tick does not pay a Lua crossing per packet. Its shape follows from that:
`uint32_t` slot handles rather than pointers, because wasm32 and arm64 disagree
about pointer width and a u32 is the same marshalling program on both; no struct
passed by value, because struct layout is ABI-specific; caller-owned buffers
only, so nothing the caller has to free ever crosses the boundary - netcode's
own receive API hands back a library allocation, and the wrapper copies it out
and frees it on the near side.

`src/netcode_lua.cpp` is a normal `luaL_reg` Defold module. It calls the **same**
C functions. It is not a layer over the C API and the C API is not a layer under
it; they are two callers of one implementation.

That costs a second argument-checking layer. It buys the property that neither
surface can acquire a dependency on the other's conventions - if the Lua surface
grows a table shape the C ABI does not, and if the C ABI grows a handle kind Lua
does not have to represent it. It also means the extension stands alone as
something publishable to the Defold ecosystem, where a C API nobody can reach
from Lua would not.

# What this costs elsewhere

`ext.manifest` declares a name and nothing else. Extender merges every
extension's context into one per-build setting, so any flag declared here would
land on `defold_hermes` too - the trap already documented in
`defold_hermes_typed_native/ext.manifest`. The extension is arranged so that it
needs no context at all: `netcode.c` opens libsodium with angle brackets
(`#include <sodium.h>`), which searches only the include path, so `sodium.h` is
vendored into this extension's own `include/`, which Extender puts on the
include path by itself. `netcode.h` stays beside `netcode.c` in `src/vendor`,
which opens it with quotes.

Extender also compiles every file in `src/` for every target and `ext.manifest`
cannot exclude a platform, so `netcode_web_transport.cpp` is entirely behind
`DM_PLATFORM_HTML5`. On other targets it compiles to nothing - which is correct
rather than fail-closed, because the extension is fully usable on native
without it.

# Boundary

What is observed:

* the vendored sources compile for `arm64-osx` and for
  `wasm32-unknown-emscripten` under the pinned emsdk 4.0.6;
* a full netcode session - handshake and payload traffic, clean and lossy -
  runs over a swapped socket layer, natively and under wasm, with identical
  results;
* no socket syscall is reached on that path, by link-time interposition whose
  ability to fail is itself asserted;
* the host static library rebuilds to the same sha256 on the same host and
  compiler (`fc72000cec38a0bf...`, 135 384 bytes);
* both C++ translation units pass `-Wall -Wextra -Werror` under all six
  `DM_PLATFORM_*` macros against the defoldsdk pinned by the repository-root
  `upstream.lock`, with HTML5 translated by Emscripten's own `em++`.

What is **not** claimed:

* **Extender has not compiled this.** Every target other than `arm64-osx` and
  `wasm32` is a syntax check plus an argument about portability, not a build.
* **No engine has run it.** There is no Defold runtime evidence of any kind -
  no packaged run, no browser run, no `dmengine` transcript.
* **No live WebTransport session has carried a netcode packet.**
  `library_defold_netcode.js` is written and unexecuted. Its C seam is proven;
  the file itself is not. It must not be recorded as runtime evidence, and
  `CURRENT_TRANSPORT_EVIDENCE` in
  `examples/war-battles-online/integration/transport-selection.ts` must not gain
  a netcode candidate marked eligible until a gate has observed one.
* **The UDP transport has no runtime evidence either.** The conformance test
  exercises the host-datagram path; the native socket path is netcode's own,
  unmodified, and untested here.
* **War Battles does not use this.** The game's `GameTransport` seam is
  unchanged.

# Follow-up, in the order that retires the most risk

1. A live WebTransport gate: a server that echoes datagrams, a browser client
   that completes a netcode handshake through `library_defold_netcode.js`, and
   the observed `maxDatagramSize` recorded. This is the only thing that can turn
   the HTML5 story from designed-and-plausible into evidenced, and it is also
   what measures the 2048-byte connection-request risk above.
2. An Extender build of the extension for the full target set, which is the only
   way the per-target compile claim stops being an argument.
3. A `GameTransport` implementation over this extension, which is what lets War
   Battles select it - behind the same evidence gate as every other candidate.
4. Generated bindings rather than a hand-written C header. This package is a
   pilot: its header was written by hand, which is exactly what
   `generator-product-contract.md` says the product does not do. If netcode
   stays, its surface should be ingested through the native-extension header
   generator like any other C API.
