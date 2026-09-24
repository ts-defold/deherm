#!/usr/bin/env node
// Real browser WebSocket fallback gate.
//
// WebTransport remains the preferred game path. This gate deliberately points
// Chrome at the Deno health/control TCP listener, exercises the same
// BattleClient, and requires the reliable input-fallback lane to reach the
// authoritative server. Its protocol label is checked as websocket-tcp.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
const dockerMode = process.argv.includes("--docker");
const composeProject = `war-battles-websocket-gate-${process.pid}`;

function composeCommand() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return ["docker", "compose"];
  } catch {
    return ["docker-compose"];
  }
}

function compose(args) {
  const [binary, ...prefix] = composeCommand();
  execFileSync(binary, [
    ...prefix,
    "-p", composeProject,
    "-f", join(exampleRoot, "docker", "compose.yaml"),
    ...args,
  ], {
    cwd: exampleRoot,
    stdio: "inherit",
  });
}

function makeCertificate(directory) {
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", key, "-out", cert, "-days", "10", "-nodes", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { cert, key };
}

function browserEntry(url) {
  return `
    import { BattleClient, BrowserWebSocketClient } from "./core/index.ts";
    const evidence = globalThis.__warBattlesWebSocketEvidence = {
      state: "connecting", errors: [], transport: null, rosterSize: 0,
      snapshotsApplied: 0, inputsSent: 0, inputsDropped: 0, playerId: 0,
    };
    const client = new BattleClient({
      name: "chrome-websocket-fallback",
      onError: (error) => evidence.errors.push(String(error)),
      onReject: (reject) => evidence.errors.push(\`rejected:\${reject.code}:\${reject.reason}\`),
    });
    globalThis.__warBattlesWebSocketClose = () => client.close(1000, "fallback gate complete");
    globalThis.__warBattlesWebSocketResume = async (nextUrl) => {
      const resumed = new BattleClient({
        name: "chrome-websocket-resume",
        onError: (error) => evidence.errors.push(String(error)),
        onReject: (reject) => evidence.errors.push(\`rejected:\${reject.code}:\${reject.reason}\`),
      });
      resumed.resumeToken.set(Uint8Array.from(evidence.resumeToken ?? []));
      const resumedTransport = await BrowserWebSocketClient.connect(nextUrl, resumed);
      resumed.attach(resumedTransport);
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        const poll = () => {
          if (resumed.state === "ready") return resolve();
          if (resumed.state === "rejected" || performance.now() > deadline) return reject(new Error(\`resume failed: \${resumed.state}\`));
          setTimeout(poll, 20);
        };
        poll();
      });
      return { state: resumed.state, playerId: resumed.playerId, transport: { ...resumedTransport.capabilities } };
    };
    BrowserWebSocketClient.connect(${JSON.stringify(url)}, client).then((transport) => {
      evidence.transport = { ...transport.capabilities };
      client.attach(transport);
      setInterval(() => {
        if (client.state === "ready") {
          client.setControls({ moveX: 1, moveY: 0, fire: false, boost: false, weapon: 0 });
          client.update(17, 2);
        }
        evidence.state = client.state;
        evidence.rosterSize = client.rosterSize;
        evidence.playerId = client.playerId;
        evidence.resumeToken = Array.from(client.resumeToken);
        evidence.snapshotsApplied = client.stats.snapshotsApplied;
        evidence.inputsSent = client.stats.inputsSent;
        evidence.inputsDropped = client.stats.inputsDropped;
      }, 17);
    }, (error) => {
      evidence.state = "failed";
      evidence.errors.push(String(error));
    });
  `;
}

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-websocket."));
  const quicPort = dockerMode ? Number(process.env.WAR_BATTLES_QUIC_PORT ?? 4433) : await freeLoopbackPort();
  const healthPort = dockerMode ? Number(process.env.WAR_BATTLES_HEALTH_PORT ?? 8080) : await freeLoopbackPort();
  const pagePort = await freeLoopbackPort();
  const debuggingPort = await freeLoopbackPort();
  let server;
  let dockerStarted = false;
  let page;
  const serverLines = [];
  try {
    if (dockerMode) {
      compose(["up", "-d", "--build"]);
      dockerStarted = true;
    } else {
      const certificate = makeCertificate(scratch);
      server = spawn(denoBinary, [
        "run", "--unstable-net", "--allow-net", "--allow-env", "--allow-read",
        resolve(exampleRoot, "server/deno-main.ts"),
        "--hostname", "localhost", "--port", String(quicPort), "--health-port", String(healthPort),
        "--cert", certificate.cert, "--key", certificate.key, "--roster", "8", "--bot-skill", "2",
      ], { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] });
      const append = (chunk) => serverLines.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
      server.stdout.on("data", append);
      server.stderr.on("data", append);
    }
    const healthUrl = `http://localhost:${healthPort}/readyz`;
    await waitFor(async () => (await fetch(healthUrl)).ok, {
      timeoutMs: 15_000, intervalMs: 50,
      what: `${dockerMode ? "Docker" : "Deno"} WebSocket fallback readiness (tail: ${JSON.stringify(serverLines.slice(-8))})`,
    });

    await build({
      stdin: {
        contents: browserEntry(`ws://localhost:${healthPort}/ws`),
        resolveDir: exampleRoot,
        sourcefile: "war-battles-websocket-client.ts",
        loader: "ts",
      },
      bundle: true, format: "iife", platform: "browser", target: "es2022",
      outfile: join(scratch, "client.js"), sourcemap: "inline", logLevel: "silent",
    });
    await writeFile(join(scratch, "index.html"), "<!doctype html><meta charset=\"utf-8\"><title>War Battles WebSocket fallback</title><script src=\"client.js\"></script>\n");
    page = await openBundlePage({
      bundleDirectory: scratch, port: pagePort, debuggingPort, chromeBinary, retain: true,
    });
    const observed = await waitFor(async () => {
      const result = await page.client.send("Runtime.evaluate", {
        expression: "globalThis.__warBattlesWebSocketEvidence ?? null", returnByValue: true,
      });
      const value = result.result.value;
      if (value?.state === "failed" || value?.errors?.length) throw new Error(`fallback failed: ${JSON.stringify(value)}`);
      return value?.state === "ready" && value.snapshotsApplied >= 3 && value.inputsSent >= 3 ? value : false;
    }, { timeoutMs: 30_000, intervalMs: 100, what: "real browser WebSocket fallback" });

    assert.equal(observed.transport?.protocol, "websocket-tcp");
    assert.equal(observed.transport?.reliableStreams, true);
    assert.equal(observed.transport?.datagrams, false);
    assert.equal(observed.transport?.maxDatagramBytes, 0);
    assert.equal(observed.rosterSize, 8);
    const health = await (await fetch(healthUrl)).json();
    assert.ok(health.stats?.inputsAccepted >= 3, "authoritative server must accept reliable input fallback");
    assert.deepEqual(observed.errors, []);

    if (dockerMode) {
      // The Compose stop hook flushes the ledger before the process exits. A
      // second client must therefore resume the same slot with the old token
      // after a real container restart, not merely join an anonymous slot.
      compose(["restart", "war-battles"]);
      await waitFor(async () => (await fetch(healthUrl)).ok, {
        timeoutMs: 15_000, intervalMs: 100, what: "Docker readiness after restart",
      });
      const resumed = await page.client.send("Runtime.evaluate", {
        expression: `globalThis.__warBattlesWebSocketResume(${JSON.stringify(`ws://localhost:${healthPort}/ws`)})`,
        awaitPromise: true, returnByValue: true,
      });
      assert.equal(resumed.result.value?.state, "ready");
      assert.equal(resumed.result.value?.playerId, observed.playerId, "restart must retain the authenticated player slot");
      assert.equal(resumed.result.value?.transport?.protocol, "websocket-tcp");
    }
    console.log(`war-battles-websocket-fallback:ok:protocol=${observed.transport.protocol}:inputs=${observed.inputsSent}:snapshots=${observed.snapshotsApplied}${dockerMode ? ":restart-resume=ok" : ""}`);
  } finally {
    await page?.client.send("Runtime.evaluate", { expression: "globalThis.__warBattlesWebSocketClose?.()" }).catch(() => undefined);
    await page?.close().catch(() => undefined);
    if (server !== undefined) {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      await new Promise((resolveExit) => {
        if (server.exitCode !== null || server.signalCode !== null) return resolveExit();
        server.once("exit", resolveExit);
        setTimeout(resolveExit, 2_000);
      });
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }
    // This gate owns an isolated Compose project. Keep the product deployment's
    // durable volume semantics, but remove the gate's volumes so repeated proof
    // runs cannot inherit reservations or credentials from an earlier run.
    if (dockerStarted) compose(["down", "--volumes"]);
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
