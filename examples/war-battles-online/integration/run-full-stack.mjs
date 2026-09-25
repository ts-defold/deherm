#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDefoldBuilder } from "../../../packages/cli/src/dev/defold-builder.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm stack -- [options]

Starts the Deno HTTP/3 match server, packaged native game, and browser bot dashboard.

  --bots <0-31>          browser network bots (default: roster - 1)
  --roster <2-32>        authoritative roster size (default: 8)
  --skill <0-3>          server and network bot difficulty (default: 1)
  --quic-port <port>     WebTransport port (default: 4433)
  --health-port <port>   HTTP health/WebSocket port (default: 8080)
  --dashboard-port <p>   bot dashboard port (default: 8090)
  --build-server <url>   local Defold Extender (default: http://127.0.0.1:9010)
  --deno <path>          Deno executable (default: DEHERM_DENO or deno)
  --no-build             explicitly reuse an existing packaged native game
  --no-browser           do not open the bot dashboard`);
  process.exit(0);
}
const options = parseArguments(process.argv.slice(2));
const certificateDirectory = join(exampleRoot, "server/certs");
const certificate = join(certificateDirectory, "localhost.crt");
const privateKey = join(certificateDirectory, "localhost.key");
const fingerprintFile = join(certificateDirectory, "fingerprint.txt");
const webTransportUrl = `https://localhost:${options.quicPort}`;
const healthUrl = `http://localhost:${options.healthPort}/health`;
const dashboardUrl = `http://127.0.0.1:${options.dashboardPort}/?autostart=${options.bots}&skill=${options.skill}`;
const children = new Set();
const childOutput = new WeakMap();
let stopping = false;

try {
  if (!options.noBuild) await buildPackagedGame(options.buildServer);
  execFileSync(join(exampleRoot, "server/make-cert.sh"), { cwd: exampleRoot, stdio: "inherit" });
  execFileSync(process.execPath, [join(exampleRoot, "bot-dashboard/build.mjs")], {
    cwd: exampleRoot,
    stdio: "inherit",
  });
  await Promise.all([access(certificate), access(privateKey), access(fingerprintFile)]);
  const fingerprint = (await readFile(fingerprintFile, "utf8")).trim();

  const server = start("server", options.deno, [
    "run",
    "--unstable-net",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "server/deno-main.ts",
    "--hostname",
    "localhost",
    "--port",
    String(options.quicPort),
    "--health-port",
    String(options.healthPort),
    "--cert",
    certificate,
    "--key",
    privateKey,
    "--roster",
    String(options.roster),
    "--bot-skill",
    String(options.skill),
  ]);
  await waitFor(
    async () =>
      saw(server, "war-battles-server:listening:") && (await fetch(healthUrl).catch(() => undefined))?.ok === true,
    "match server",
    server,
  );

  const dashboard = start("dashboard", options.deno, [
    "run",
    "--allow-net",
    "--allow-read",
    "bot-dashboard/deno-main.ts",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(options.dashboardPort),
    "--webtransport-url",
    webTransportUrl,
    "--certificate-hash-file",
    fingerprintFile,
    "--maximum-bots",
    String(options.roster - 1),
  ]);
  await waitFor(
    async () =>
      saw(dashboard, "war-battles-network-bot-dashboard:listening:") &&
      (await fetch(dashboardUrl).catch(() => undefined))?.ok === true,
    "bot dashboard",
    dashboard,
  );

  const game = start("game", process.execPath, [
    "integration/play-packaged.mjs",
    `--config=war_battles.server=${webTransportUrl}`,
    `--config=war_battles.server_certificate_sha256=${fingerprint}`,
  ]);
  await waitFor(
    async () => {
      if (game.exitCode !== null || game.signalCode !== null) {
        throw new Error("The packaged game exited before joining the match; build it with `pnpm dev --once` first");
      }
      const response = await fetch(healthUrl).catch(() => undefined);
      if (!response?.ok) return false;
      const health = await response.json();
      return saw(game, "war-battles:net:client-welcome:") && health.stats?.humans >= 1;
    },
    "native game admission",
    game,
  );

  if (!options.noBrowser) openBrowser(dashboardUrl);
  console.log(`war-battles-stack:ready:game=1:bots=${options.bots}:server=${webTransportUrl}`);
  console.log(`war-battles-stack:dashboard:${dashboardUrl}`);
  console.log("Press Ctrl-C or close the game to stop the complete stack.");

  const result = await exited(game);
  if (!stopping && result.code !== 0) process.exitCode = result.code ?? 1;
} finally {
  await stopAll();
}

function start(name, command, arguments_) {
  const child = spawn(command, arguments_, { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const output = [];
  childOutput.set(child, output);
  pipeLines(child.stdout, name, false, output);
  pipeLines(child.stderr, name, true, output);
  child.once("error", (error) => {
    if (!stopping) console.error(`[${name}] ${error.message}`);
  });
  return child;
}

async function buildPackagedGame(buildServer) {
  // Compile the current TypeScript generation first. Bob consumes that owned
  // resource; launching an older packaged binary against a newer protocol
  // server otherwise fails closed only after an opaque admission timeout.
  execFileSync(
    process.execPath,
    [
      resolve(exampleRoot, "../../bin/deherm.mjs"),
      "dev",
      "--project",
      "defold",
      "--entry",
      "main/player.script.ts",
      "--watch",
      ".",
      "--build-server",
      buildServer,
      "--once",
      "--headless",
    ],
    {
      cwd: exampleRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        // The project already owns the platform archive selected by `deherm
        // generate`. A stack run compiles gameplay; it must not rotate that
        // artifact to an unpublished contributor-worktree fingerprint.
        DEHERM_WEBTRANSPORT_SOURCE: "defold_webtransport",
      },
    },
  );
  const builder = await createDefoldBuilder({
    projectRoot: join(exampleRoot, "defold"),
    buildServer,
    emit(event) {
      if (event.type !== "log" || !event.message) return;
      const level = event.level === "error" ? "error" : "log";
      console[level](`[build:${event.source ?? "deherm"}] ${event.message}`);
    },
  });
  try {
    await builder.build("War Battles full-stack preflight");
  } finally {
    await builder.close();
  }
}

function pipeLines(stream, name, error, output) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      output.push(line);
      if (output.length > 200) output.shift();
      (error ? console.error : console.log)(`[${name}] ${line}`);
    }
  });
}

function saw(child, marker) {
  return childOutput.get(child)?.some((line) => line.includes(marker)) === true;
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    [...children].map((child) =>
      Promise.race([exited(child).catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))]),
    ),
  );
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function waitFor(predicate, description, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${description} process exited before reporting ready`);
    }
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}

function parseArguments(arguments_) {
  const value = (name, fallback) => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : fallback;
  };
  const integer = (name, fallback, minimum, maximum) => {
    const parsed = Number.parseInt(value(name, String(fallback)), 10);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
    }
    return parsed;
  };
  const roster = integer("--roster", 8, 2, 32);
  const bots = integer("--bots", roster - 1, 0, roster - 1);
  return {
    roster,
    bots,
    skill: integer("--skill", 1, 0, 3),
    quicPort: integer("--quic-port", 4433, 1, 65_535),
    healthPort: integer("--health-port", 8080, 1, 65_535),
    dashboardPort: integer("--dashboard-port", 8090, 1, 65_535),
    buildServer: value("--build-server", process.env.DEHERM_BUILD_SERVER ?? "http://127.0.0.1:9010"),
    deno: value("--deno", process.env.DEHERM_DENO ?? "deno"),
    noBuild: arguments_.includes("--no-build"),
    noBrowser: arguments_.includes("--no-browser"),
  };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopAll().then(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}
