#!/usr/bin/env node
// Packaged Defold/Wasm -> browser host -> BattleClient -> WebTransport ->
// authoritative Deno server acceptance. Unlike check-real-webtransport.mjs,
// this gate loads the actual Bob-produced game bundle and observes the game
// component's allocation-stable live telemetry object.

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
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE
  ?? resolve(repositoryRoot, "build/bundle/War Battles");
const denoBinary = process.env.DEHERM_DENO ?? "deno";
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;

function makeCertificate(directory) {
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", key, "-out", cert, "-days", "10", "-nodes", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "keyUsage=critical,digitalSignature",
    "-addext", "extendedKeyUsage=serverAuth",
  ], { stdio: "ignore" });
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
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 2_000)),
  ]);
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
    const serverUrl = `https://localhost:${quicPort}`;

    server = spawn(denoBinary, [
      "run", "--unstable-net", "--allow-net", "--allow-read",
      resolve(exampleRoot, "server/deno-main.ts"),
      "--hostname", "localhost", "--port", String(quicPort),
      "--cert", certificate.cert, "--key", certificate.key,
      "--roster", "8", "--bot-skill", "2",
    ], { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] });
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
        server: serverUrl,
        serverCertificateSha256: certificate.sha256,
      })};`,
    });
    const loaded = page.client.waitForEvent("Page.loadEventFired");
    await page.client.send("Page.navigate", { url: page.pageUrl });
    await loaded;

    const telemetry = await waitFor(async () => {
      const result = await page.client.send("Runtime.evaluate", {
        expression: "globalThis.__warBattlesTelemetryV1 ?? null",
        returnByValue: true,
      });
      const value = result.result.value;
      if (value?.state === "failed" || value?.state === "rejected") {
        throw new Error(`packaged client failed: ${JSON.stringify(value)}`);
      }
      return value?.mode === "online" && value.state === "ready"
        && value.snapshotsApplied >= 3 && value.inputsSent >= 3
        ? value
        : false;
    }, { timeoutMs: 60_000, intervalMs: 100, what: "the packaged Defold game to exchange live QUIC traffic" });

    const fatal = page.client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
    assert.equal(telemetry.mode, "online");
    assert.equal(telemetry.state, "ready");
    assert.equal(telemetry.rosterSize, 8);
    assert.ok(telemetry.playerId > 0);
    assert.ok(telemetry.snapshotsApplied >= 3);
    assert.ok(telemetry.inputsSent >= 3);
    assert.ok(telemetry.lastServerTick > 0);
    assert.deepEqual(fatal, [], `packaged browser failures: ${JSON.stringify(fatal)}`);
    assert.ok(page.client.transcript.includes("war-battles:arena-init:players=8:online=1"));
    assert.ok(page.client.transcript.some((line) => line.includes("war-battles:net:client-welcome:")));
    assert.ok(serverLines.some((line) => line.includes("session-joined:")));

    console.log([
      "war-battles-packaged-online:ok",
      `player=${telemetry.playerId}`,
      `snapshots=${telemetry.snapshotsApplied}`,
      `inputs=${telemetry.inputsSent}`,
      `serverTick=${telemetry.lastServerTick}`,
    ].join(":"));
    return telemetry;
  } finally {
    await page?.close().catch(() => undefined);
    await stop(server);
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
