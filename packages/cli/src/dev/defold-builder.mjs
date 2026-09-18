import { createHash } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertProjectNativeArtifact, defoldToolchain, hostDefoldPlatform } from "../toolchains.mjs";

async function exists(file, mode) {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureBob(projectRoot, lock, options = {}) {
  const metadata = lock.toolchain?.bob ?? defoldToolchain(lock.defoldRevision).bob;
  if (!/^https:\/\//.test(metadata.url) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error("deherm.lock contains invalid Bob toolchain metadata");
  }
  const directory = path.join(projectRoot, ".deherm", "cache", "toolchains", lock.defoldRevision);
  const target = path.join(directory, "bob.jar");
  if (await exists(target)) {
    const current = sha256(await readFile(target));
    if (current === metadata.sha256) return target;
    await rm(target, { force: true });
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.download-${process.pid}`;
  await rm(temporary, { force: true });
  options.emit?.({ type: "log", source: "bob", message: `downloading verified Bob for Defold ${lock.defoldRevision.slice(0, 7)}` });
  const response = await (options.fetch ?? globalThis.fetch)(metadata.url, { signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 120_000) });
  if (!response.ok) throw new Error(`Unable to download Bob: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== metadata.sha256) throw new Error(`Downloaded Bob checksum mismatch: expected ${metadata.sha256}, got ${actual}`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, target);
  return target;
}

async function resolveJava(options = {}) {
  const candidates = [
    options.java,
    process.env.DEHERM_JAVA,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : undefined,
    "/opt/homebrew/opt/openjdk@25/bin/java",
    "/usr/local/opt/openjdk@25/bin/java"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate, constants.X_OK)) return candidate;
  return "java";
}

function pipeLines(stream, source, emit) {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim() || /\bFINE\b/.test(line)) continue;
      emit({ type: "log", source, level: /\b(error|fatal)\b/i.test(line) ? "error" : /\bwarn/i.test(line) ? "warn" : "info", message: line });
    }
  });
  stream?.on("end", () => {
    if (pending.trim()) emit({ type: "log", source, message: pending });
    pending = "";
  });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawnProcess)(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    pipeLines(child.stdout, options.source ?? "bob", options.emit ?? (() => {}));
    pipeLines(child.stderr, options.source ?? "bob", options.emit ?? (() => {}));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited ${code ?? `with ${signal}`}`));
    });
  });
}

const ignoredOutputNames = new Set(["_BobBuildState_", "digest_cache", "game.arcd", "game.arci", "game.dmanifest", "game.graph.json"]);

async function compiledResources(outputRoot) {
  const resources = new Map();
  async function visit(directory) {
    let entries = await readdir(directory, { withFileTypes: true });
    entries = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && !ignoredOutputNames.has(entry.name) && entry.name.endsWith("c")) {
        const information = await stat(absolute);
        resources.set(path.relative(outputRoot, absolute).split(path.sep).join("/"), `${information.size}:${information.mtimeMs}`);
      }
    }
  }
  if (await exists(outputRoot)) await visit(outputRoot);
  return resources;
}

function changedResources(before, after) {
  const changed = [];
  for (const [relative, identity] of after) if (before.get(relative) !== identity) changed.push(`/${relative}`);
  return changed.sort();
}

export function extractBobFailureDiagnostics(text, limit = 12) {
  if (typeof text !== "string") throw new TypeError("Bob diagnostics input must be text");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Bob diagnostics limit must be a non-negative integer");
  const diagnostics = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !(
      /^(?:ERROR|FATAL):/.test(line) ||
      /:\d+:\d+: (?:fatal )?error:/.test(line) ||
      /(?:ExtenderException|Unable to find property|Cannot (?:get|set|create) property)/.test(line)
    )) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    diagnostics.push(line);
    if (diagnostics.length === limit) break;
  }
  return diagnostics;
}

async function emitBobFailureDiagnostics(projectRoot, platform, emit) {
  const logFile = path.join(projectRoot, "build", platform, "log.txt");
  let text;
  try {
    text = await readFile(logFile, "utf8");
  } catch {
    return undefined;
  }
  const diagnostics = extractBobFailureDiagnostics(text);
  for (const message of diagnostics) emit({ type: "log", source: "compiler", level: "error", message });
  emit({
    type: "log",
    source: "bob",
    level: "error",
    message: `full native build log: ${path.relative(projectRoot, logFile).split(path.sep).join("/")}`
  });
  return logFile;
}

function engineRelativePath(platform) {
  const mapped = {
    "arm64-macos": ["arm64-osx", "dmengine"],
    "x86_64-macos": ["x86_64-osx", "dmengine"],
    "arm64-linux": ["arm64-linux", "dmengine"],
    "x86_64-linux": ["x86_64-linux", "dmengine"],
    "x86_64-win32": ["x86_64-win32", "dmengine.exe"]
  }[platform];
  if (!mapped) throw new Error(`No Defold engine output mapping exists for ${platform}`);
  return mapped;
}

export async function createDefoldBuilder(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const emit = options.emit ?? (() => {});
  const lock = JSON.parse(await readFile(path.join(projectRoot, "deherm.lock"), "utf8"));
  const bob = await ensureBob(projectRoot, lock, { ...options, emit });
  const java = await resolveJava(options);
  const platform = options.platform ?? hostDefoldPlatform();
  await assertProjectNativeArtifact(projectRoot, platform);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(projectRoot, "build", "default"));
  const buildServer = options.buildServer ?? process.env.DEHERM_BUILD_SERVER ?? process.env.DEFOLD_HERMES_BUILD_SERVER;
  let previous = await compiledResources(outputRoot);
  let loop = Promise.resolve();

  const build = (reason = "change") => {
    const operation = loop.then(async () => {
      emit({ type: "defold-build-started", reason });
      const before = previous;
      const args = [
        "-jar", bob,
        "--root", projectRoot,
        "--output", path.relative(projectRoot, outputRoot),
        "--platform", platform,
        "--architectures", platform,
        "--variant", "debug",
        "--archive",
        "--verbose"
      ];
      if (buildServer) args.push("--build-server", buildServer);
      args.push("resolve", "build");
      try {
        await run(java, args, { ...options, cwd: projectRoot, emit, source: "bob" });
        const engine = path.join(projectRoot, "build", ...engineRelativePath(platform));
        if (process.platform !== "win32" && await exists(engine)) await chmod(engine, 0o755);
        previous = await compiledResources(outputRoot);
        const resources = changedResources(before, previous);
        emit({ type: "defold-build-succeeded", reason, resources });
        return { resources, outputRoot, platform };
      } catch (error) {
        const logFile = await emitBobFailureDiagnostics(projectRoot, platform, emit);
        const detail = error instanceof Error ? error.message : String(error);
        const diagnostic = logFile
          ? `${detail}; see ${path.relative(projectRoot, logFile).split(path.sep).join("/")}`
          : detail;
        emit({ type: "defold-build-failed", reason, diagnostic });
        throw new Error(diagnostic, { cause: error });
      }
    });
    loop = operation.catch(() => {});
    return operation;
  };

  return { build, outputRoot, platform, close: async () => loop };
}
