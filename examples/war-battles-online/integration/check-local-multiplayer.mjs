#!/usr/bin/env node
// Real multi-client WebTransport acceptance.
//
// Each client below is a synthetic browser BattleClient (the same production
// WebTransportGameClient used by the game bundle), not the packaged Defold
// engine. The gate proves two independent WebTransport sessions join one
// authoritative MatchServer and that both receive snapshots/send datagrams.
// It deliberately does not claim packaged-engine or WAN evidence.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const denoBinary = process.env.DEHERM_DENO ?? "deno";
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;
// Keep only switches for validation; their separate values are consumed by
// option() below and must not be mistaken for unknown switches.
const argumentsSet = new Set(
  process.argv.slice(2).filter((argument) => argument.startsWith("--") && argument !== "--"),
);
const external = argumentsSet.has("--external");

function option(name, fallback) {
  const prefix = `${name}=`;
  const inline = [...argumentsSet].find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rosterSize = Number.parseInt(option("--roster", "16"), 10);
const clientCount = Number.parseInt(option("--clients", "16"), 10);
const quicPort = Number.parseInt(option("--quic-port", "0"), 10);
const healthPort = Number.parseInt(option("--health-port", "0"), 10);
for (const argument of argumentsSet) {
  if (
    !["--external", "--roster", "--clients", "--quic-port", "--health-port"].some(
      (name) => argument === name || argument.startsWith(`${name}=`),
    )
  ) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}
if (!Number.isInteger(rosterSize) || rosterSize < 2 || rosterSize > 32) throw new Error("--roster must be 2..32");
if (!Number.isInteger(clientCount) || clientCount < 1 || clientCount > rosterSize)
  throw new Error("--clients must be 1..roster");

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
  return { cert, key, digest: createHash("sha256").update(der).digest() };
}

function browserEntrySingle(url, digest) {
  return `
    import { BattleClient, WebTransportGameClient } from "./core/index.ts";
    const name = globalThis.__warBattlesClientName;
    const evidence = globalThis.__warBattlesMultiplayerEvidence = {
      name, state: "connecting", errors: [], playerId: 0, rosterSize: 0,
      matchId: null, snapshotsApplied: 0, inputsSent: 0, inputsDropped: 0,
      lastServerTick: 0, transport: null,
    };
    const digest = Uint8Array.from(${JSON.stringify([...digest])});
    const client = new BattleClient({
      name,
      onError: (error) => evidence.errors.push(String(error)),
      onReject: (reject) => evidence.errors.push(\`rejected:\${reject.code}:\${reject.reason}\`),
    });
    globalThis.__warBattlesMultiplayerClose = () => client.close(1000, "acceptance complete");
    WebTransportGameClient.connect(
      ${JSON.stringify(url)}, client, undefined,
      { serverCertificateHashes: [{ algorithm: "sha-256", value: digest.buffer }] },
    ).then((transport) => {
      evidence.transport = { ...transport.capabilities };
      client.attach(transport);
      setInterval(() => {
        if (client.state === "ready") {
          client.setControls({ moveX: 1, moveY: 0, fire: false, boost: false, weapon: 0 });
          client.update(17, 2);
        }
        evidence.state = client.state;
        evidence.playerId = client.playerId;
        evidence.rosterSize = client.rosterSize;
        evidence.matchId = client.world?.matchId ?? null;
        evidence.snapshotsApplied = client.stats.snapshotsApplied;
        evidence.inputsSent = client.stats.inputsSent;
        evidence.inputsDropped = client.stats.inputsDropped;
        evidence.lastServerTick = client.stats.lastServerTick;
      }, 17);
    }, (error) => {
      evidence.state = "failed";
      evidence.errors.push(String(error));
    });
  `;
}

function browserEntryMany(url, digest, count) {
  return `
    import { BattleClient, WebTransportGameClient } from "./core/index.ts";
    const address = ${JSON.stringify(url)};
    const digest = Uint8Array.from(${JSON.stringify([...digest])});
    const evidence = globalThis.__warBattlesMultiplayerEvidence = { clients: [] };
    const clients = [];
    const liveClients = [];
    for (let index = 0; index < ${count}; index += 1) {
      const observed = {
        name: "client-" + (index + 1), state: "connecting", errors: [], playerId: 0,
        rosterSize: 0, matchId: null, snapshotsApplied: 0, inputsSent: 0,
        inputsDropped: 0, lastServerTick: 0, transport: null,
      };
      evidence.clients.push(observed);
      clients.push(observed);
      const client = new BattleClient({
        name: observed.name,
        onError: (error) => observed.errors.push(String(error)),
        onReject: (reject) => observed.errors.push("rejected:" + reject.code + ":" + reject.reason),
      });
      liveClients.push(client);
      WebTransportGameClient.connect(
        address, client, undefined,
        { serverCertificateHashes: [{ algorithm: "sha-256", value: digest.buffer }] },
      ).then((transport) => {
        observed.transport = { ...transport.capabilities };
        client.attach(transport);
      }, (error) => {
        observed.state = "failed";
        observed.errors.push(String(error));
      });
    }
    globalThis.__warBattlesMultiplayerClose = () => liveClients.forEach((client) => client.close(1000, "acceptance complete"));
    setInterval(() => {
      for (let index = 0; index < clients.length; index += 1) {
        const observed = clients[index];
        const client = liveClients[index];
        if (client?.state === "ready") {
          const axis = (observed.playerId & 1) === 0 ? -1 : 1;
          client.setControls({ moveX: axis, moveY: 0, fire: false, boost: false, weapon: 0 });
          client.update(17, 2);
        }
        observed.state = client.state;
        observed.playerId = client.playerId;
        observed.rosterSize = client.rosterSize;
        observed.matchId = client.world?.matchId ?? null;
        observed.snapshotsApplied = client.stats.snapshotsApplied;
        observed.inputsSent = client.stats.inputsSent;
        observed.inputsDropped = client.stats.inputsDropped;
        observed.lastServerTick = client.stats.lastServerTick;
      }
    }, 17);
  `;
}

async function health(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  const value = await response.json();
  return { response, value };
}

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-multiplayer."));
  const pages = [];
  let server;
  const serverLines = [];
  let quic;
  let healthUrl;
  let digest;
  try {
    console.log(`war-battles-multiplayer:starting:clients=${clientCount}:roster=${rosterSize}`);
    if (external) {
      quic = quicPort || 4433;
      const healthPortValue = healthPort || 8080;
      healthUrl = `http://127.0.0.1:${healthPortValue}/readyz`;
      await waitFor(async () => (await health(healthUrl)).response.ok, {
        timeoutMs: 30_000,
        intervalMs: 100,
        what: "external War Battles readiness",
      });
      const observed = await health(healthUrl);
      assert.equal(observed.value.ready, true);
      assert.match(observed.value.certificateSha256, /^[0-9a-f]{64}$/u);
      digest = Buffer.from(observed.value.certificateSha256, "hex");
    } else {
      const cert = makeCertificate(scratch);
      digest = cert.digest;
      quic = quicPort || (await freeLoopbackPort());
      const healthPortValue = healthPort || (await freeLoopbackPort());
      healthUrl = `http://localhost:${healthPortValue}/readyz`;
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
          String(quic),
          "--health-port",
          String(healthPortValue),
          "--cert",
          cert.cert,
          "--key",
          cert.key,
          "--roster",
          String(rosterSize),
          "--bot-skill",
          "2",
        ],
        { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const append = (chunk) => serverLines.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
      server.stdout.on("data", append);
      server.stderr.on("data", append);
      server.on("error", (error) => serverLines.push(`spawn-error:${String(error)}`));
      server.on("exit", (code, signal) => serverLines.push(`exit:${code}:${signal}`));
      await waitFor(async () => (await health(healthUrl)).response.ok, {
        timeoutMs: 15_000,
        intervalMs: 50,
        what: `Deno WebTransport readiness (server=${serverLines.slice(-10).join(" | ")})`,
      });
    }
    console.log("war-battles-multiplayer:server-ready");

    const transportHost = external ? "127.0.0.1" : "localhost";
    await build({
      stdin: {
        contents:
          clientCount === 1
            ? browserEntrySingle(`https://${transportHost}:${quic}`, digest)
            : browserEntryMany(`https://${transportHost}:${quic}`, digest, clientCount),
        resolveDir: exampleRoot,
        sourcefile: "war-battles-multiplayer-client.ts",
        loader: "ts",
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      outfile: join(scratch, "client.js"),
      sourcemap: "inline",
      logLevel: "silent",
    });
    console.log("war-battles-multiplayer:browser-bundle-ready");
    const singleton = clientCount === 1;
    await writeFile(
      join(scratch, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>War Battles multiplayer</title>${singleton ? '<script>globalThis.__warBattlesClientName="client-1"</script>' : ""}<script src="client.js"></script>\n`,
    );
    pages.push(
      await openBundlePage({
        bundleDirectory: scratch,
        port: await freeLoopbackPort(),
        debuggingPort: await freeLoopbackPort(),
        chromeBinary,
        retain: true,
      }),
    );
    console.log("war-battles-multiplayer:browser-page-ready");

    const observed = await waitFor(
      async () => {
        const result = await pages[0].client.send("Runtime.evaluate", {
          expression:
            "(() => { const value = globalThis.__warBattlesMultiplayerEvidence; return Array.isArray(value?.clients) ? value.clients : [value]; })()",
          returnByValue: true,
        });
        const candidate = result.result.value;
        if (candidate?.some((client) => client?.state === "failed" || client?.errors?.length)) {
          throw new Error(`client failed: ${JSON.stringify(candidate)}`);
        }
        return candidate?.length === clientCount &&
          candidate.every(
            (client) => client?.state === "ready" && client.snapshotsApplied >= 3 && client.inputsSent >= 3,
          )
          ? candidate
          : false;
      },
      { timeoutMs: 45_000, intervalMs: 100, what: `${clientCount} real WebTransport clients in one browser page` },
    );
    console.log("war-battles-multiplayer:clients-ready-and-snapshotting");
    console.log(
      `war-battles-multiplayer:initial-authority-stats:${JSON.stringify((await health(healthUrl)).value.stats)}`,
    );

    assert.equal(observed.length, clientCount);
    assert.equal(
      new Set(observed.map((client) => client.playerId)).size,
      clientCount,
      "clients must own distinct slots",
    );
    assert.equal(new Set(observed.map((client) => client.matchId)).size, 1, "clients must join the same match");
    for (const client of observed) {
      assert.equal(client.transport?.protocol, "webtransport-h3");
      assert.equal(client.transport?.reliableStreams, true);
      assert.equal(client.transport?.datagrams, true);
      assert.ok(client.transport.maxDatagramBytes >= 32);
      assert.equal(client.rosterSize, rosterSize);
      assert.ok(client.snapshotsApplied >= 3);
      assert.ok(client.inputsSent >= 3);
      assert.deepEqual(client.errors, []);
    }

    let lastStats;
    await waitFor(
      async () => {
        const observedHealth = await health(healthUrl);
        const stats = observedHealth.value.stats;
        lastStats = stats;
        return stats?.humans >= clientCount &&
          stats?.bots === rosterSize - clientCount &&
          stats?.inputsAccepted >= clientCount
          ? observedHealth.value
          : false;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 50,
        what: `authoritative ${clientCount}-player admission and input stats (${JSON.stringify(lastStats)})`,
      },
    );
    console.log("war-battles-multiplayer:authority-accepted-full-roster-input");
    await pages[0].client.send("Runtime.evaluate", { expression: "globalThis.__warBattlesMultiplayerClose?.()" });
    console.log(
      `war-battles-multiplayer:ok:clients=${clientCount}:match=${observed[0].matchId}:players=${observed.map((client) => client.playerId).join(",")}:source=${external ? "external" : "local-deno"}`,
    );
  } finally {
    for (const page of pages.reverse()) await page.close().catch(() => undefined);
    if (server !== undefined) {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      await new Promise((resolveExit) => {
        if (server.exitCode !== null || server.signalCode !== null) return resolveExit();
        server.once("exit", resolveExit);
        setTimeout(resolveExit, 2_000);
      });
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
