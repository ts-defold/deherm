#!/usr/bin/env node
// Real browser WebTransport load/demo gate for the shared network bot driver.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const botCount = Number.parseInt(process.env.DEHERM_NETWORK_BOTS ?? "4", 10);
const rosterSize = Math.max(8, botCount);
if (!Number.isInteger(botCount) || botCount < 1 || botCount > 32) {
  throw new RangeError("DEHERM_NETWORK_BOTS must be an integer in [1, 32]");
}

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-network-bots."));
  const serverLines = [];
  let server;
  let page;
  try {
    const { cert, key, digest } = makeCertificate(scratch);
    const quicPort = await freeLoopbackPort();
    const healthPort = await freeLoopbackPort();
    const pagePort = await freeLoopbackPort();
    const debuggingPort = await freeLoopbackPort();
    const url = `https://localhost:${quicPort}`;

    await build({
      entryPoints: [join(exampleRoot, "bot-dashboard/client.ts")],
      outfile: join(scratch, "client.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      sourcemap: "inline",
      logLevel: "silent",
    });
    await cp(join(exampleRoot, "bot-dashboard/index.html"), join(scratch, "index.html"));
    await writeFile(
      join(scratch, "config.json"),
      `${JSON.stringify({ webTransportUrl: url, certificateHash: digest.toString("hex"), maximumBots: 32 })}\n`,
    );

    server = spawn(
      denoBinary,
      [
        "run",
        "--unstable-net",
        "--allow-net",
        "--allow-read",
        "--allow-env",
        join(exampleRoot, "server/deno-main.ts"),
        "--hostname",
        "localhost",
        "--port",
        String(quicPort),
        "--health-port",
        String(healthPort),
        "--cert",
        cert,
        "--key",
        key,
        "--roster",
        String(rosterSize),
        "--bot-skill",
        "1",
      ],
      { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    collectLines(server, serverLines);
    await waitFor(() => serverLines.some((line) => line.includes("war-battles-server:listening:")), {
      timeoutMs: 15_000,
      intervalMs: 50,
      what: `the network-bot QUIC server (${JSON.stringify(serverLines.slice(-12))})`,
    });

    page = await openBundlePage({
      bundleDirectory: scratch,
      port: pagePort,
      debuggingPort,
      chromeBinary,
      retain: true,
    });
    await waitFor(
      async () => {
        const result = await page.client.send("Runtime.evaluate", {
          expression: "typeof globalThis.__warBattlesNetworkBots === 'object'",
          returnByValue: true,
        });
        return result.result.value === true;
      },
      { timeoutMs: 15_000, what: "the bot dashboard API" },
    );

    await page.client.send("Runtime.evaluate", {
      expression: `globalThis.__warBattlesNetworkBots.start(${JSON.stringify({
        count: botCount,
        skill: 1,
        url,
        certificateHash: digest.toString("hex"),
      })})`,
      awaitPromise: true,
    });

    const observed = await waitFor(
      async () => {
        const result = await page.client.send("Runtime.evaluate", {
          expression: "globalThis.__warBattlesNetworkBots.summary()",
          returnByValue: true,
        });
        const value = result.result.value;
        if (value?.failed > 0) {
          const error = new Error(
            `network bot failed: ${JSON.stringify(value)}; browser=${JSON.stringify(page.client.failures)}`,
          );
          error.fatal = true;
          throw error;
        }
        if (value?.ready !== botCount || value.bots?.length !== botCount) return false;
        return value.bots.every(
          (bot) =>
            bot.snapshotsApplied >= 3 &&
            bot.inputsSent >= 3 &&
            bot.nonIdleCommands > 0 &&
            bot.observedTravelUnits > 0 &&
            bot.pongsReceived > 0,
        )
          ? value
          : false;
      },
      { timeoutMs: 40_000, intervalMs: 100, what: `${botCount} active network bot clients` },
    );

    const health = await (await fetch(`http://localhost:${healthPort}/health`)).json();
    assert.equal(health.transport, "webtransport-h3");
    assert.equal(health.stats.humans, botCount);
    assert.equal(health.stats.bots, rosterSize - botCount);
    assert.ok(health.stats.inputsAccepted >= botCount * 3);
    assert.equal(new Set(observed.players).size, botCount);
    for (const bot of observed.bots) {
      assert.ok(bot.snapshotsApplied >= 3, `bot ${bot.index} must receive snapshots`);
      assert.ok(bot.inputsSent >= 3, `bot ${bot.index} must send inputs`);
      assert.ok(bot.nonIdleCommands > 0, `bot ${bot.index} must make a non-idle shared-brain decision`);
      assert.ok(bot.observedTravelUnits > 0, `bot ${bot.index} must move in its snapshot-reconciled view`);
      assert.ok(bot.pongsReceived > 0, `bot ${bot.index} must receive protocol-ping telemetry`);
    }
    assert.equal(page.client.failures.length, 0);

    const playersBeforeRedeploy = [...observed.players];
    const countersBeforeRedeploy = observed.bots.map((bot) => ({
      snapshotsApplied: bot.snapshotsApplied,
      inputsSent: bot.inputsSent,
    }));
    await page.client.send("Runtime.evaluate", {
      expression: `globalThis.__warBattlesNetworkBots.start(${JSON.stringify({
        count: botCount,
        skill: 2,
        url,
        certificateHash: digest.toString("hex"),
      })})`,
      awaitPromise: true,
    });
    const redeployed = await waitFor(
      async () => {
        const result = await page.client.send("Runtime.evaluate", {
          expression: "globalThis.__warBattlesNetworkBots.summary()",
          returnByValue: true,
        });
        const value = result.result.value;
        if (value?.ready !== botCount || value.bots?.length !== botCount) return false;
        return value.bots.every(
          (bot, index) =>
            bot.snapshotsApplied > countersBeforeRedeploy[index].snapshotsApplied &&
            bot.inputsSent > countersBeforeRedeploy[index].inputsSent,
        )
          ? value
          : false;
      },
      { timeoutMs: 10_000, intervalMs: 100, what: "the in-place network bot dashboard redeploy" },
    );
    assert.deepEqual(redeployed.players, playersBeforeRedeploy, "same-endpoint redeploy must retain live sessions");

    await page.client.send("Runtime.evaluate", { expression: "globalThis.__warBattlesNetworkBots.stop()" });
    console.log(
      `war-battles-network-bots:ok:bots=${botCount}:snapshots=${observed.snapshotsApplied}:inputs=${observed.inputsSent}`,
    );
    return observed;
  } finally {
    await page?.close();
    await terminate(server);
    await rm(scratch, { recursive: true, force: true });
  }
}

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

function collectLines(child, target) {
  const append = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u)) if (line !== "") target.push(line);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
}

async function terminate(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

export { run };
