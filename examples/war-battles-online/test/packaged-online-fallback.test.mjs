import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const gatePath = new URL("../integration/check-packaged-online.mjs", import.meta.url);
const arenaPath = new URL("../defold/main/arena.script.ts", import.meta.url);

test("the packaged online owner exposes a real QUIC-to-TCP fallback proof", async () => {
  const gate = await readFile(gatePath, "utf8");
  const arena = await readFile(arenaPath, "utf8");

  // Keep this test structural and cheap: the end-to-end observation belongs to
  // `pnpm runtime:browser:online:fallback`, while these assertions prevent a
  // future gate from silently regressing to a standalone adapter harness.
  assert.match(gate, /argumentSet\.has\("--fallback"\)/u);
  assert.match(gate, /DEHERM_WAR_BATTLES_WEB_BUNDLE/u);
  assert.match(gate, /Page\.addScriptToEvaluateOnNewDocument/u);
  assert.match(gate, /serverWebSocket: websocketUrl/u);
  assert.match(gate, /serverCertificateSha256: fallbackMode \? "00"\.repeat\(32\)/u);
  assert.match(gate, /value\.transport === \(fallbackMode \? "websocket-tcp"/u);
  assert.match(gate, /value\.inputLane === \(fallbackMode \? "reliable-fallback"/u);
  assert.match(gate, /const minimumInputsAccepted = 3/u);
  assert.match(gate, /const healthUrl = `http:\/\/localhost:\$\{healthPort\}\/readyz`/u);
  assert.match(gate, /payload\?\.stats\?\.inputsAccepted/u);
  assert.match(gate, /authoritative acceptance incomplete/u);
  assert.match(gate, /war-battles-server:stats:inputs-accepted:count=\$\{minimumInputsAccepted\}/u);
  assert.match(gate, /session-accepted:websocket-tcp/u);
  assert.match(arena, /transport: "webtransport-h3-quic" \| "websocket-tcp" \| null/u);
  assert.match(arena, /inputLane: "datagram" \| "reliable-fallback" \| null/u);
  assert.match(arena, /attachOnlineTransport\(self, client, transport\)/u);
});
