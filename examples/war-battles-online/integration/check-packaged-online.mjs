#!/usr/bin/env node
// Packaged Defold/Wasm -> browser host -> BattleClient -> authoritative Deno
// server acceptance. Unlike check-real-webtransport.mjs, this gate loads the
// actual Bob-produced game bundle and observes the game component's
// allocation-stable live telemetry object. `--fallback` deliberately makes
// only the WebTransport/QUIC endpoint unavailable; the same packaged game
// must then select the Deno TCP/WebSocket listener and keep exchanging input
// and snapshots.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const denoBinary = process.env.DEHERM_DENO ?? "deno";
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;
// Client-side `inputsSent` is only an attempted write. The owner gate must
// also observe the authoritative MatchServer accounting on the control plane.
const minimumInputsAccepted = 3;
const argumentSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
for (const argument of argumentSet) {
  if (argument !== "--fallback") throw new Error(`Unknown argument: ${argument}`);
}
const fallbackMode = argumentSet.has("--fallback");

function makeCertificate(directory) {
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "10",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=serverAuth",
    ],
    { stdio: "ignore" },
  );
  const der = execFileSync("openssl", ["x509", "-in", cert, "-outform", "der"]);
  return { cert, key, sha256: createHash("sha256").update(der).digest("hex") };
}

function linesFrom(child, target) {
  const append = (chunk) => target.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
  child.stdout.on("data", append);
  child.stderr.on("data", append);
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-packaged-online."));
  const serverLines = [];
  let server;
  let page;
  try {
    const certificate = makeCertificate(scratch);
    const quicPort = await freeLoopbackPort();
    const pagePort = await freeLoopbackPort();
    const debuggingPort = await freeLoopbackPort();
    const healthPort = await freeLoopbackPort();
    const serverUrl = `https://localhost:${quicPort}`;
    // Keep the authoritative server alive, but point the packaged client at a
    // different loopback port for the fallback run. This makes QUIC failure
    // deterministic while leaving its TCP/WebSocket control listener usable.
    const clientServerUrl = fallbackMode ? `https://localhost:${await freeLoopbackPort()}` : serverUrl;
    const websocketUrl = `ws://localhost:${healthPort}/ws`;
    const healthUrl = `http://localhost:${healthPort}/readyz`;
    const acceptedInputMarker = `war-battles-server:stats:inputs-accepted:count=${minimumInputsAccepted}`;

    server = spawn(
      denoBinary,
      [
        "run",
        "--unstable-net",
        "--allow-net",
        "--allow-read",
        "--allow-env",
        resolve(exampleRoot, "server/deno-main.ts"),
        "--hostname",
        "localhost",
        "--port",
        String(quicPort),
        "--health-port",
        String(healthPort),
        "--cert",
        certificate.cert,
        "--key",
        certificate.key,
        "--roster",
        "8",
        "--bot-skill",
        "2",
      ],
      { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    linesFrom(server, serverLines);
    await waitFor(() => serverLines.some((line) => line.includes("war-battles-server:listening:")), {
      timeoutMs: 15_000,
      intervalMs: 50,
      what: `the Deno QUIC listener (tail: ${JSON.stringify(serverLines.slice(-12))})`,
    });

    page = await openBundlePage({
      bundleDirectory,
      port: pagePort,
      debuggingPort,
      chromeBinary,
      retain: true,
      deferNavigation: true,
    });
    await page.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__warBattlesConfigV1 = ${JSON.stringify({
        server: clientServerUrl,
        serverWebSocket: websocketUrl,
        serverCertificateSha256: fallbackMode ? "00".repeat(32) : certificate.sha256,
      })};`,
    });
    const loaded = page.client.waitForEvent("Page.loadEventFired");
    await page.client.send("Page.navigate", { url: page.pageUrl });
    await loaded;

    let lastTelemetry = null;
    const telemetry = await waitFor(
      async () => {
        const result = await page.client.send("Runtime.evaluate", {
          expression: "globalThis.__warBattlesTelemetryV1 ?? null",
          returnByValue: true,
        });
        const value = result.result.value;
        lastTelemetry = value;
        if (value?.state === "failed" || value?.state === "rejected") {
          throw new Error(`packaged client failed: ${JSON.stringify(value)}`);
        }
        return value?.mode === "online" &&
          value.state === "ready" &&
          value.transport === (fallbackMode ? "websocket-tcp" : "webtransport-h3-quic") &&
          value.inputLane === (fallbackMode ? "reliable-fallback" : "datagram") &&
          value.snapshotsApplied >= minimumInputsAccepted &&
          value.inputsSent >= minimumInputsAccepted
          ? value
          : false;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 100,
        what: `the packaged Defold game to exchange ${fallbackMode ? "WebSocket/TCP" : "QUIC"} traffic (telemetry=${JSON.stringify(lastTelemetry)}, transcript=${JSON.stringify(page.client.transcript.slice(-12))}, server=${JSON.stringify(serverLines.slice(-12))})`,
      },
    );

    const expectedFallbackFailures = page.client.failures.filter(
      (failure) =>
        fallbackMode &&
        failure.kind === "log" &&
        failure.detail.includes(`Failed to establish a connection to ${clientServerUrl}/`) &&
        failure.detail.includes("ERR_CONNECTION_REFUSED"),
    );
    const fatal = page.client.failures.filter(
      (failure) => !failure.url?.endsWith("/favicon.ico") && !expectedFallbackFailures.includes(failure),
    );
    assert.equal(telemetry.mode, "online");
    assert.equal(telemetry.state, "ready");
    assert.equal(telemetry.transport, fallbackMode ? "websocket-tcp" : "webtransport-h3-quic");
    assert.equal(telemetry.inputLane, fallbackMode ? "reliable-fallback" : "datagram");
    assert.equal(telemetry.rosterSize, 8);
    assert.ok(telemetry.playerId > 0);
    assert.ok(telemetry.snapshotsApplied >= minimumInputsAccepted);
    assert.ok(telemetry.inputsSent >= minimumInputsAccepted);
    assert.ok(telemetry.lastServerTick > 0);

    // `inputsSent` above is client telemetry and can pass even if the server
    // drops every packet. Read the server's control endpoint after the game is
    // ready and require both its live MatchServer stats and exact milestone
    // marker, with enough context to diagnose a stalled authority in CI.
    const authoritativeHealth = await waitFor(
      async () => {
        let response;
        let body;
        try {
          response = await fetch(healthUrl, { cache: "no-store" });
          body = await response.text();
        } catch {
          throw new Error(
            [
              `health fetch failed for ${healthUrl}: ${error instanceof Error ? error.message : String(error)}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          throw new Error(
            [
              `health response was not JSON: status=${response.status} body=${JSON.stringify(body.slice(0, 500))}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        const inputsAccepted = payload?.stats?.inputsAccepted;
        const markerObserved = serverLines.includes(acceptedInputMarker);
        if (
          !response.ok ||
          !Number.isFinite(inputsAccepted) ||
          inputsAccepted < minimumInputsAccepted ||
          !markerObserved
        ) {
          throw new Error(
            [
              `authoritative acceptance incomplete: status=${response.status}`,
              `inputsAccepted=${JSON.stringify(inputsAccepted)}`,
              `required=${minimumInputsAccepted}`,
              `marker=${markerObserved ? "observed" : `missing:${acceptedInputMarker}`}`,
              `health=${JSON.stringify(payload)}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        return payload;
      },
      {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: `the authoritative server to report at least ${minimumInputsAccepted} accepted inputs at ${healthUrl}`,
      },
    );
    assert.ok(authoritativeHealth.stats.inputsAccepted >= minimumInputsAccepted);
    assert.ok(serverLines.includes(acceptedInputMarker));
    assert.equal(
      expectedFallbackFailures.length,
      fallbackMode ? 1 : 0,
      "the fallback gate must observe exactly the deliberately unavailable QUIC endpoint",
    );
    assert.deepEqual(fatal, [], `packaged browser failures: ${JSON.stringify(fatal)}`);
    assert.ok(page.client.transcript.includes("war-battles:arena-init:players=8:online=1"));
    assert.ok(page.client.transcript.some((line) => line.includes("war-battles:net:client-welcome:")));
    assert.ok(serverLines.some((line) => line.includes("session-joined:")));
    if (fallbackMode) {
      assert.ok(
        page.client.transcript.some(
          (line) => line.includes("war-battles:arena-online-fallback:") && line.endsWith(":websocket-tcp"),
        ),
      );
      assert.ok(page.client.transcript.includes("war-battles:net:transport=websocket-tcp"));
      assert.ok(serverLines.some((line) => line.includes("session-accepted:websocket-tcp")));
    } else {
      assert.ok(page.client.transcript.includes("war-battles:net:transport=webtransport-h3-quic"));
    }

    console.log(
      [
        "war-battles-packaged-online:ok",
        `mode=${fallbackMode ? "websocket-fallback" : "webtransport"}`,
        `transport=${telemetry.transport}`,
        `inputLane=${telemetry.inputLane}`,
        `player=${telemetry.playerId}`,
        `snapshots=${telemetry.snapshotsApplied}`,
        `inputs=${telemetry.inputsSent}`,
        `accepted=${authoritativeHealth.stats.inputsAccepted}`,
        `serverTick=${telemetry.lastServerTick}`,
      ].join(":"),
    );
    return telemetry;
  } finally {
    await page?.close().catch(() => undefined);
    await stop(server);
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
