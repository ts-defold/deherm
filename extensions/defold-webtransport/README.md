# WebTransport for Defold

`defold_webtransport` gives Defold games real
[WebTransport](https://www.w3.org/TR/webtransport/) sessions over HTTP/3 and
QUIC:

- unreliable, unordered datagrams for realtime state;
- reliable bidirectional and unidirectional byte streams;
- native macOS, iOS, Linux, Windows, and Android clients;
- browser-hosted WebTransport on HTML5 builds;
- an event-driven Lua API that works without déherm; and
- a Web-standard TypeScript facade when déherm is present.

It is transport infrastructure, not a game protocol. Your application owns
packet framing, versioning, authentication, rate limits, and routing.

## Install

Add the release ZIP to your Defold `game.project`, then choose
**Project → Fetch Libraries**:

```ini
[project]
dependencies#0 = https://github.com/ts-defold/deherm/releases/download/defold-webtransport-v0.1.0/defold-webtransport-0.1.0.zip
```

The same dependency supports Lua-only and déherm projects. Lua users do not
need the npm package.

## Minimal Lua client

WebTransport requires HTTPS. Native version 0.1 also requires exactly one
SHA-256 certificate pin. The pin value is the 32 raw digest bytes, not its
printable hex representation.

```lua
local function decode_hex(value)
    assert(#value == 64, "certificate hash must be 64 hexadecimal characters")
    return (value:gsub("..", function(pair)
        return string.char(assert(tonumber(pair, 16), "invalid certificate hash"))
    end))
end

local function on_webtransport_event(self, event)
    if event.type == "ready" then
        print("WebTransport ready")
        assert(defold_webtransport.send_datagram(self.session, "player input"))
        assert(defold_webtransport.create_bidirectional_stream(self.session))

    elseif event.type == "stream" and not event.incoming then
        -- A requested stream is now writable. true sends FIN.
        assert(defold_webtransport.write(event.stream, "reliable hello", true))

    elseif event.type == "datagram" then
        print("datagram: " .. event.data)

    elseif event.type == "data" then
        print("stream data: " .. event.data)
        if event.fin then print("peer finished this stream") end

    elseif event.type == "reset" or event.type == "stop_sending" then
        print(event.type .. ": " .. event.code)

    elseif event.type == "close" then
        print("closed: " .. event.code .. " " .. (event.reason or ""))
    end
end

function init(self)
    self.session = defold_webtransport.connect("https://127.0.0.1:4443/echo", {
        server_certificate_hashes = {{
            algorithm = "sha-256",
            value = decode_hex("PASTE_64_CHARACTER_CERTIFICATE_SHA256_HERE"),
        }},
        anticipated_incoming_unidirectional_streams = 4,
        anticipated_incoming_bidirectional_streams = 4,
    }, on_webtransport_event)
end

function final(self)
    if self.session then
        defold_webtransport.close(self.session, 0, "game object deleted")
    end
end
```

Callbacks run on Defold's main thread and retain the originating script
instance as `self`.

## Lua API

### Sessions

| Function | Result | Purpose |
| --- | --- | --- |
| `connect(url, options, callback)` | session userdata | Start an HTTPS WebTransport session. `options` may be `nil`. |
| `close(session, close_code?, reason?)` | — | Request a clean application close. |
| `max_datagram_size(session)` | number | Maximum outgoing datagram bytes; `0` before ready or when unavailable. |

`options` accepts:

| Field | Type | Meaning |
| --- | --- | --- |
| `server_certificate_hashes` | array of `{ algorithm, value }` | Certificate pins. Native 0.1 requires exactly one `sha-256` pin. |
| `anticipated_incoming_unidirectional_streams` | integer | Expected incoming unidirectional stream count. |
| `anticipated_incoming_bidirectional_streams` | integer | Expected incoming bidirectional stream count. |

### Datagrams and streams

| Function | Result | Purpose |
| --- | --- | --- |
| `send_datagram(session, bytes)` | boolean | Queue one unreliable datagram. |
| `create_bidirectional_stream(session)` | boolean | Request a bidirectional stream; receive it later in a `stream` event. |
| `create_unidirectional_stream(session)` | boolean | Request an outgoing stream; receive it later in a `stream` event. |
| `write(stream, bytes, fin?)` | boolean | Queue bytes, optionally finishing the sending direction. |
| `reset_stream(stream, code?)` | boolean | Abort the stream's sending direction. |
| `stop_sending(stream, code?)` | boolean | Ask the peer to stop its sending direction. |

A `false` result means bounded native backpressure rejected the operation.
Keep your application state and retry later. Oversized datagrams are also
rejected.

### Callback events

Every event has `type`, `session`, `code`, `fin`, `bidirectional`,
and `incoming`. Relevant events also carry `stream`, binary-string `data`,
or `reason`.

| `event.type` | Meaning |
| --- | --- |
| `ready` | The session is ready for streams and datagrams. |
| `stream` | An incoming stream arrived or a requested outgoing stream opened. |
| `data` | Stream bytes arrived; `fin` marks the peer's final bytes. |
| `datagram` | One unreliable datagram arrived. |
| `reset` | The peer reset a stream. |
| `stop_sending` | The peer asked this endpoint to stop sending. |
| `close` | The session closed or connection setup failed. |

Defold editor completion ships in
`defold_webtransport/script/defold_webtransport.script_api`.

## TypeScript with déherm

Déherm discovers the extension from the Defold project and generates one
WebTransport-shaped facade for native and HTML5 targets:

```ts
import { WebTransport } from "@deherm/project";

const certificate = Uint8Array.from(/* 32 SHA-256 bytes */);
const transport = new WebTransport("https://127.0.0.1:4443/echo", {
  serverCertificateHashes: [{ algorithm: "sha-256", value: certificate }],
  anticipatedConcurrentIncomingUnidirectionalStreams: 4,
  anticipatedConcurrentIncomingBidirectionalStreams: 4,
});

await transport.ready;

const datagrams = transport.datagrams.writable.getWriter();
await datagrams.write(new TextEncoder().encode("player input"));

const stream = await transport.createBidirectionalStream();
const writer = stream.writable.getWriter();
await writer.write(new TextEncoder().encode("reliable hello"));
await writer.close();

const reader = stream.readable.getReader();
for (;;) {
  const packet = await reader.read();
  if (packet.done) break;
  console.log(new TextDecoder().decode(packet.value));
}
```

Native targets use the bounded extension provider. HTML5 delegates to the
browser's `WebTransport`. Application code does not need a target branch.

## Run the echo example

[`examples/defold-webtransport-minimal`](../../examples/defold-webtransport-minimal)
contains an ordinary Lua client and a small Deno HTTP/3/WebTransport echo
server. It has no déherm dependency.

```sh
cd examples/defold-webtransport-minimal
pnpm install
pnpm cert
# Copy the printed certificate_sha256 into main/client.script.
pnpm server
```

Open that directory in Defold, fetch libraries, and run the game. The client
sends a datagram and a bidirectional stream; the server echoes both.

## Target and trust behavior

- Native 0.1 requires one explicit SHA-256 certificate pin.
- HTML5 uses the browser implementation and security model.
- Unsupported browsers fail explicitly. The extension never disguises a
  WebSocket or WebRTC fallback as WebTransport.
- Your application owns fallback, matchmaking, reconnection, and protocol
  compatibility policy.

Native artifacts are selected, downloaded, digest-verified, and cached by
déherm for déherm projects. Lua users receive target libraries in the versioned
Defold extension ZIP.

## C and C++ extensions

Include `defold_webtransport/client.h` for the same callback-driven session,
stream, and datagram operations without Lua or déherm. Event payload storage is
borrowed and valid only during the callback. The lower-level
`defold_webtransport/native_v1.h` provider ABI is intended for language
runtimes; game extensions should normally prefer `client.h`.

## License

The extension is MIT licensed. Picoquic, picotls, Mbed TLS, and bundled
cryptographic dependencies retain their own licenses. Releases include
`licenses/THIRD_PARTY_NOTICES.md` and the complete license texts.
