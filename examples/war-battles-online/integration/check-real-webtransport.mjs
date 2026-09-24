#!/usr/bin/env node
// Real loopback WebTransport/QUIC gate for the War Battles protocol.
//
// This owns every resource it creates: a short-lived certificate, a
// Deno HTTP/3 server, a static loopback page, a dedicated headless Chrome
// profile, and one real BattleClient. The pass condition is intentionally
// above the transport handshake: the client must receive the 32-player
// welcome, apply authoritative snapshots, and send tick inputs as QUIC
// datagrams through the production GameTransport adapter.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  assertWebTransportEvidence,
  buildWebTransportSourceInputs,
  digestWebTransportSourceInputs,
  WEBTRANSPORT_OWNER,
} from "./webtransport-evidence.mjs";
import { projectionEnvelope } from "./projections.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const evidencePath = resolve(exampleRoot, "evidence/webtransport-quic-loopback.json");
const denoBinary = process.env.DEHERM_DENO ?? "deno";
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;
const debugMode = process.env.DEHERM_WAR_BATTLES_QUIC_DEBUG ?? "";
const retainDebugArtifacts = debugMode !== "";
const captureNetLog = debugMode === "netlog";
const argumentSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
const minimumSnapshotsApplied = 3;
const minimumInputsSent = 3;

for (const argument of argumentSet) {
  if (!["--record-evidence", "--check-evidence", "--check-sources"].includes(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}
if (["--record-evidence", "--check-evidence", "--check-sources"].filter((mode) => argumentSet.has(mode)).length > 1) {
  throw new Error("WebTransport evidence modes are mutually exclusive");
}

const sourceInputs = await buildWebTransportSourceInputs();
const sourceKey = digestWebTransportSourceInputs(sourceInputs);

async function readRecordedEvidence() {
  return JSON.parse(await readFile(evidencePath, "utf8"));
}

if (argumentSet.has("--check-sources")) {
  const recorded = await readRecordedEvidence();
  assertWebTransportEvidence(recorded, { sourceInputs });
  console.log(`war-battles-webtransport-sources:fresh:${sourceKey}`);
  process.exit(0);
}

if (argumentSet.has("--check-evidence")) {
  const recorded = await readRecordedEvidence();
  assertWebTransportEvidence(recorded, { sourceInputs });
  console.log(`war-battles-webtransport-evidence:fresh:${recorded.sourceKey}`);
  process.exit(0);
}

function linesFrom(child, target) {
  const append = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/u)) if (line !== "") target.push(line);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
}

async function terminate(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function makeCertificate(directory) {
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync("openssl", [
    // Chromium's custom WebTransport certificate verifier accepts short-lived
    // P-256 certificates pinned by DER SHA-256 without modifying trust state.
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", key, "-out", cert,
    "-days", "10", "-nodes", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "keyUsage=critical,digitalSignature",
    "-addext", "extendedKeyUsage=serverAuth",
  ], { stdio: "ignore" });
  const der = execFileSync("openssl", ["x509", "-in", cert, "-outform", "der"]);
  return { cert, key, digest: createHash("sha256").update(der).digest() };
}

function browserEntry(url, digest) {
  return `
    import { BattleClient, BrowserWebTransportClient } from "./core/index.ts";

    const evidence = globalThis.__warBattlesQuicEvidence = {
      ok: false,
      state: "connecting",
      errors: [],
      logs: [],
      rosterSize: 0,
      playerId: 0,
      snapshotsApplied: 0,
      inputsSent: 0,
      inputsDropped: 0,
      lastServerTick: 0,
      lastLocalTick: 0,
      transport: null,
    };
    const digest = Uint8Array.from(${JSON.stringify([...digest])});
    const client = new BattleClient({
      name: "chrome-quic-gate",
      onLog: (line) => evidence.logs.push(line),
      onError: (error) => evidence.errors.push(String(error)),
      onReject: (reject) => evidence.errors.push(\`rejected:\${reject.code}:\${reject.reason}\`),
    });
    let timer;
    globalThis.__warBattlesQuicClose = () => {
      if (timer !== undefined) clearInterval(timer);
      client.close(1000, "loopback gate complete");
    };
    BrowserWebTransportClient.connect(
      ${JSON.stringify(url)},
      client,
      undefined,
      { serverCertificateHashes: [{ algorithm: "sha-256", value: digest.buffer }] },
    ).then((transport) => {
      evidence.transport = { ...transport.capabilities };
      client.attach(transport);
      timer = setInterval(() => {
        if (client.state === "ready") {
          client.setControls({ moveX: 1, moveY: 0, fire: false, boost: false, weapon: 0 });
          client.update(17, 2);
        }
        evidence.state = client.state;
        evidence.rosterSize = client.rosterSize;
        evidence.playerId = client.playerId;
        evidence.snapshotsApplied = client.stats.snapshotsApplied;
        evidence.inputsSent = client.stats.inputsSent;
        evidence.inputsDropped = client.stats.inputsDropped;
        evidence.lastServerTick = client.stats.lastServerTick;
        evidence.lastLocalTick = client.world?.tick ?? 0;
        evidence.ok = client.state === "ready" && client.rosterSize === 32 &&
          client.stats.snapshotsApplied >= ${minimumSnapshotsApplied} &&
          client.stats.inputsSent >= ${minimumInputsSent};
      }, 17);
    }, (error) => {
      evidence.state = "failed";
      evidence.errors.push(String(error));
    });
  `;
}

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-quic."));
  const serverLines = [];
  let server;
  let page;
  try {
    const { cert, key, digest } = makeCertificate(scratch);
    const quicPort = Number.parseInt(process.env.DEHERM_WAR_BATTLES_QUIC_PORT ?? "", 10) || await freeLoopbackPort();
    const pagePort = await freeLoopbackPort();
    const debuggingPort = await freeLoopbackPort();
    // Deno's unstable upgrade API currently expects the root WebTransport URL;
    // keep the conformance gate identical to the official server/client shape.
    const url = `https://localhost:${quicPort}`;

    await build({
      stdin: {
        contents: browserEntry(url, digest),
        resolveDir: exampleRoot,
        sourcefile: "war-battles-real-quic-client.ts",
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
    await writeFile(
      join(scratch, "index.html"),
      "<!doctype html><meta charset=\"utf-8\"><link rel=\"icon\" href=\"data:,\"><title>War Battles QUIC gate</title><script src=\"client.js\"></script>\n",
    );

    server = spawn(denoBinary, [
      "run", "--unstable-net", "--allow-net", "--allow-read", "--allow-env",
      resolve(exampleRoot, "server/deno-main.ts"),
      "--hostname", "localhost",
      "--port", String(quicPort),
      "--cert", cert,
      "--key", key,
      "--roster", "32",
      "--bot-skill", "2",
    ], { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] });
    linesFrom(server, serverLines);
    await waitFor(() => serverLines.some((line) => line.includes("war-battles-server:listening:")), {
      timeoutMs: 15_000,
      intervalMs: 50,
      what: `the Deno QUIC listener (tail: ${JSON.stringify(serverLines.slice(-12))})`,
    });

    page = await openBundlePage({
      bundleDirectory: scratch,
      port: pagePort,
      debuggingPort,
      chromeBinary,
      retain: true,
      // WebTransport enables QUIC itself. `--origin-to-force-quic-on` selects
      // Chrome's ordinary Web-PKI verifier and defeats serverCertificateHashes.
      chromeArguments: captureNetLog
        ? [`--log-net-log=${join(scratch, "chrome-netlog.json")}`, "--net-log-capture-mode=Everything"]
        : [],
    });
    const observed = await waitFor(async () => {
      const result = await page.client.send("Runtime.evaluate", {
        expression: "globalThis.__warBattlesQuicEvidence ?? null",
        returnByValue: true,
      });
      const value = result.result.value;
      if (value?.state === "failed" || value?.state === "closed" || value?.state === "rejected" || value?.errors?.length) {
        const error = new Error(`WebTransport client failed: ${JSON.stringify(value)}; server=${JSON.stringify(serverLines.slice(-20))}`);
        error.fatal = true;
        throw error;
      }
      return value?.ok ? value : false;
    }, { timeoutMs: 30_000, intervalMs: 100, what: "a real authoritative QUIC session" });

    assert.equal(observed.transport?.protocol, "webtransport-h3");
    assert.equal(observed.transport?.reliableStreams, true);
    assert.equal(observed.transport?.datagrams, true);
    assert.ok(observed.transport.maxDatagramBytes >= 32, "negotiated datagram capacity must carry one input packet");
    assert.equal(observed.rosterSize, 32);
    assert.ok(observed.playerId >= 1 && observed.playerId <= 32);
    assert.ok(observed.snapshotsApplied >= minimumSnapshotsApplied);
    assert.ok(observed.inputsSent >= minimumInputsSent);
    assert.ok(serverLines.some((line) => line.includes("war-battles-server:session-accepted:")));
    assert.ok(serverLines.some((line) => line.includes("war-battles-server:session-joined:chrome-quic-gate:slot=")));
    const acceptedInputMarker = `war-battles-server:stats:inputs-accepted:count=${minimumInputsSent}`;
    await waitFor(
      () => serverLines.includes(acceptedInputMarker),
      { timeoutMs: 5_000, intervalMs: 25, what: "the Deno MatchServer input-acceptance marker" },
    );
    assert.deepEqual(observed.errors, []);

    const evidence = {
      schemaVersion: 2,
      owner: WEBTRANSPORT_OWNER,
      generator: WEBTRANSPORT_OWNER,
      kind: "war-battles.real-webtransport-loopback",
      projection: projectionEnvelope("browser-webtransport-loopback"),
      transport: observed.transport,
      rosterSize: observed.rosterSize,
      playerId: observed.playerId,
      minimumSnapshotsApplied,
      minimumInputsSent,
      observedSnapshotsApplied: observed.snapshotsApplied,
      observedInputsSent: observed.inputsSent,
      lastServerTick: observed.lastServerTick,
      lastLocalTick: observed.lastLocalTick,
      input: { moveX: 1, moveY: 0, fire: false, boost: false, weapon: 0 },
      inputsDropped: observed.inputsDropped,
      server: {
        inputsAcceptedAtLeast: minimumInputsSent,
        markers: serverLines
        .filter((line) => line.startsWith("war-battles-server:") && !line.includes("certificate-sha256"))
        .map((line) => line.replaceAll(`https://localhost:${quicPort}`, "https://localhost:<port>")),
      },
      runtime: {
        deno: execFileSync(denoBinary, ["--version"], { encoding: "utf8" }).split(/\r?\n/u)[0],
        chrome: execFileSync(chromeBinary, ["--version"], { encoding: "utf8" }).trim(),
      },
      sourceInputs,
      sourceKey,
      evidenceBoundary: "Real loopback Chrome-to-Deno HTTP/3/WebTransport transport, authoritative welcome/snapshot/input evidence; server input acceptance is observed from MatchServer stats; reliable-lane persistence is not claimed; not WAN, ingress, native Defold, or allocation evidence.",
    };
    assertWebTransportEvidence(evidence, { sourceInputs });
    await page.client.send("Runtime.evaluate", { expression: "globalThis.__warBattlesQuicClose?.()" });
    console.log(`war-battles-webtransport:ok:player=${evidence.playerId}:snapshots=${observed.snapshotsApplied}:inputs=${observed.inputsSent}`);
    if (argumentSet.has("--record-evidence")) {
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`war-battles-webtransport:evidence:${evidencePath}`);
    }
    return evidence;
  } catch (error) {
    if (retainDebugArtifacts) {
      let browserEvidence = null;
      try {
        const result = await page?.client.send("Runtime.evaluate", {
          expression: "globalThis.__warBattlesQuicEvidence ?? null",
          returnByValue: true,
        });
        browserEvidence = result?.result.value ?? null;
      } catch { /* the page may already be gone */ }
      console.error(`war-battles-webtransport:debug:${scratch}`);
      const serverErrors = serverLines.filter((line) => line.includes("war-battles-server:error:")).length;
      console.error(`war-battles-webtransport:server-errors:${serverErrors}`);
      console.error(`war-battles-webtransport:server:${JSON.stringify([...serverLines.slice(0, 14), ...serverLines.slice(-20)])}`);
      console.error(`war-battles-webtransport:evidence:${JSON.stringify(browserEvidence)}`);
      console.error(`war-battles-webtransport:browser:${JSON.stringify(page?.client.transcript ?? [])}`);
      console.error(`war-battles-webtransport:failures:${JSON.stringify(page?.client.failures ?? [])}`);
    }
    throw error;
  } finally {
    await page?.close();
    await terminate(server);
    if (!retainDebugArtifacts) await rm(scratch, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

export { run };
