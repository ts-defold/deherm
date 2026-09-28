# Minimal Defold WebTransport echo

This is an ordinary Lua Defold project plus a minimal Deno WebTransport echo
server. It deliberately has no dependency on déherm, War Battles, or their
protocol code.

1. Install current Deno and OpenSSL.
2. Run `pnpm cert` in this directory. Copy the printed
   `certificate_sha256` value into the `client` script component property in
   Defold (or replace the placeholder in `main/client.script`).
3. Run `pnpm server`.
4. Open this directory in Defold, fetch libraries, and run the game.

The client opens one bidirectional stream and sends one unreliable datagram.
The Deno server echoes both, and Defold prints the returned payloads. The
server accepts both the current `datagrams.createWritable()` API and Deno's
legacy `datagrams.writable` compatibility shape.

The dependency URL targets the independently versioned
`defold-webtransport-v0.1.0` GitHub release. Before that immutable release is
published, use the release workflow's staged extension tree for repository
dogfood.
