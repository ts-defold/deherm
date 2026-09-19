# @deherm/defold-netcode

A Defold native extension wrapping [netcode](https://github.com/mas-bandwidth/netcode),
Glenn Fiedler's secure client/server protocol, with **two** APIs:

* a flat **C ABI** (`include/defold_netcode/defold_netcode.h`) for the Static
  Hermes adapter, so a TypeScript game does not pay a Lua crossing per packet;
* a standard **Lua module** (`netcode.*`, `luaL_reg`-registered) so the
  extension stands alone as something publishable to the Defold ecosystem.

Neither is a layer over the other. Both call the same `deherm_netcode_*`
functions.

The design, the per-target transport answer and the evidence boundary live in
[`.agents/docs/decisions/netcode-transport-per-target.md`](../../.agents/docs/decisions/netcode-transport-per-target.md).
Read that first; this file is how to use and rebuild the package.

## The short version of the transport question

netcode is a protocol over UDP. Browsers cannot send UDP. netcode's socket layer
is replaceable - `override_send_and_receive` plus a send/receive callback pair,
verified in the source and exercised end to end - so:

| Targets | Transport |
| --- | --- |
| macOS, iOS, Linux, Android, Windows | `DEHERM_NETCODE_TRANSPORT_UDP`, netcode's own sockets |
| `wasm-web`, `wasm_pthread-web` | `DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM`, over WebTransport datagrams |

Same sources, same protocol object, no `#ifdef`. The transport is a runtime
argument to `deherm_netcode_client_create`.

## Layout

```
extension/defold_netcode/      the liftable Defold extension - copy this folder
  ext.manifest                 name only; see the file for why
  include/
    defold_netcode/            the C API this package owns
    sodium.h                   vendored; here because netcode.c opens it with <>
  src/
    netcode_capi.c             the C API implementation, and the ring buffers
    netcode_lua.cpp            the Lua module and the extension lifecycle
    netcode_web_transport.cpp  HTML5 only; pumps the rings onto WebTransport
    vendor/                    netcode.c, netcode.h, sodium.c - verbatim upstream
  lib/web/
    library_defold_netcode.js  the WebTransport datagram channel
  licenses/                    NETCODE.txt (BSD-3-Clause), LIBSODIUM.txt (ISC)

scripts/vendor-netcode.mjs     re-derive the vendored sources; --check verifies
scripts/build-and-test.sh      host build + conformance; --verify pins the digest
scripts/check-extension-syntax.py   all six DM_PLATFORM_* translations
tests/
  override_loopback.c          the conformance test: a session with no socket
  socket_poison.c              aborting socket/bind/sendto/recvfrom
  poison_selftest.c            proves the poison can fail
  adapter-call-path.mjs        the C API driven from JavaScript, wasm
upstream.lock                  the pinned netcode revision and why that repo
vendor-digests.json            sha256 per vendored file
native-lib-digests.json        sha256 of the host library, plus evidence boundary
```

## Using it from a Defold project

Copy or symlink `extension/defold_netcode` into the project root, the way
`examples/war-battles-online/defold/defold_hermes` symlinks the Hermes
extension. Extender compiles the vendored C for whichever target is bundled;
there is nothing to download and no per-target library to select.

### Lua

```lua
local PROTOCOL = 0x11223344  -- both ends must agree
local client = netcode.client_create("0.0.0.0:0", netcode.TRANSPORT_UDP)

-- The connect token comes from your backend, which holds the private key.
netcode.client_connect(client, token_from_backend)

function update(self, dt)
    netcode.client_update(client)
    if netcode.client_state(client) == netcode.STATE_CONNECTED then
        netcode.client_send(client, my_input_packet)
    end
    while true do
        local payload, sequence = netcode.client_receive(client)
        if not payload then break end
        handle(payload, sequence)
    end
end
```

Payloads and tokens are Lua **strings**, not tables of numbers: a 2048-byte
connect token is opaque bytes to the game, and a table would be 2048 stack round
trips per connect.

`netcode.client_receive` returns `nil, nil` when nothing is queued, so
`while true do ... if not payload then break end end` is the drain loop.

### C

```c
#include <defold_netcode/defold_netcode.h>

deherm_netcode_init();   /* seeds the CSPRNG; see below - this is not optional */

uint32_t client = deherm_netcode_client_create("0.0.0.0:0",
                                               DEHERM_NETCODE_TRANSPORT_UDP);
deherm_netcode_client_connect(client, token, DEHERM_NETCODE_CONNECT_TOKEN_BYTES);

/* per frame */
deherm_netcode_client_update(client, deherm_netcode_time());
if (deherm_netcode_client_state(client) == DEHERM_NETCODE_STATE_CONNECTED) {
    deherm_netcode_client_send(client, payload, payload_bytes);
}
uint8_t buffer[DEHERM_NETCODE_MAX_PACKET_BYTES];
uint64_t sequence;
int32_t bytes;
while ((bytes = deherm_netcode_client_receive(client, buffer, sizeof(buffer),
                                              &sequence)) > 0) {
    handle(buffer, bytes, sequence);
}
```

### HTML5

Create the client with `DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM`, open a
WebTransport session with `deherm_netcode_web_connect(url)`, and call
`deherm_netcode_web_pump(client)` once per frame **after**
`deherm_netcode_client_update`. That moves netcode's outbound ring onto the
session's datagram writer and the session's inbound datagrams into netcode.

This path's C seam is proven; the JavaScript has not been run against a live
WebTransport server. See the evidence boundary in the decision note before
relying on it.

## Things that will bite you

**Call `deherm_netcode_init` before anything else.** It seeds libsodium's RNG,
and on wasm that is the call that installs `crypto.getRandomValues` as the
entropy source. Skipping it does not fail loudly - it produces keys that are not
keys. The extension's own `AppInit` does it, so a Defold game gets it for free;
a caller creating a client outside the extension lifecycle does not.

**Never ship the private key in a client.** `generate_connect_token` exists so a
listen server or a test can mint its own tokens. A shipped client must receive
tokens from a backend. No API design can enforce this.

**netcode is single-threaded and not thread safe.** Each client and server must
be updated from one thread. This wrapper adds no locking.

**The host-datagram rings are bounded** (64 slots of 2560 bytes each way). That
is deliberate - an unbounded queue in front of a protocol with its own replay
window turns packet loss into memory growth and latency.
`deherm_netcode_client_dropped_outbound` counts what could not be queued; if it
climbs, the host is not draining fast enough, which is a real defect rather than
the unreliable-channel loss the protocol expects.

## Rebuilding and verifying

```sh
# Re-derive the vendored sources from the pinned revision and record digests.
node scripts/vendor-netcode.mjs

# Verify the committed bytes still match.
node scripts/vendor-netcode.mjs --check

# Host build + the full conformance suite. Records the library digest.
./scripts/build-and-test.sh

# Same, but fails if the digest moved (same host, same compiler).
./scripts/build-and-test.sh --verify

# Also compile and run the conformance suite under wasm, plus the adapter call
# path - the same API driven from JavaScript through exported symbols alone.
EMSDK_ROOT=/path/to/emsdk ./scripts/build-and-test.sh

# All six DM_PLATFORM_* translations. EMSDK_ROOT enables the HTML5 one.
DEFOLD_SDK=/path/to/defoldsdk EMSDK_ROOT=/path/to/emsdk \
  python3 scripts/check-extension-syntax.py
```

The Defold SDK is not vendored. Fetch the `defoldsdk.zip` that the
repository-root `upstream.lock` pins and check its `DEFOLD_SDK_SHA256` before
unpacking.

## Licences

| Component | Licence |
| --- | --- |
| netcode 1.4.8 | BSD-3-Clause |
| vendored libsodium subset (from 1.0.22) | ISC |
| this wrapper | MIT, with the repository |

Upstream asks - the licence does not require it - that products credit
**"netcode - Glenn Fiedler and Rowan Claude"**. A game shipping this should.
