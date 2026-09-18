import { spawn as spawnProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const platformEngines = Object.freeze({
  "darwin:arm64": ["arm64-osx/dmengine"],
  "darwin:x64": ["x86_64-osx/dmengine"],
  "linux:arm64": ["arm64-linux/dmengine"],
  "linux:x64": ["x86_64-linux/dmengine"],
  "win32:x64": ["x86_64-win32/dmengine.exe"]
});

async function exists(file, accessFile = access) {
  try {
    await accessFile(file);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBuiltEngine(projectRoot, options = {}) {
  const buildRoot = path.join(path.resolve(projectRoot), "build");
  const runtimeRoot = path.join(buildRoot, "default");
  const platform = options.platform ?? process.platform;
  const architecture = options.arch ?? process.arch;
  const candidates = platformEngines[`${platform}:${architecture}`] ?? [];
  if (!(await exists(path.join(runtimeRoot, "game.projectc"), options.access))) {
    throw new Error(`No compiled Defold project found at ${path.join(runtimeRoot, "game.projectc")}; build the project with Bob first`);
  }
  for (const relative of candidates) {
    const executable = path.join(buildRoot, relative);
    if (await exists(executable, options.access)) return { executable, runtimeRoot };
  }
  throw new Error(`No built Defold engine found for ${platform}/${architecture} under ${buildRoot}; build the custom engine with Bob first`);
}

function diagnosticLevel(line) {
  if (/\b(fatal|panic)\b/i.test(line)) return "fatal";
  if (/\b(error|exception|traceback)\b/i.test(line)) return "error";
  if (/\bwarn(?:ing)?\b/i.test(line)) return "warn";
  return "info";
}

const controlEventPattern = /\bDEHERM_EVENT bundle-(activated|rejected) fingerprint=([0-9a-fA-F]{64}|unavailable) resource_generation=(\d+) runtime_id=(\d+) initial=(true|false)\b/;
const telemetryEventPattern = /\bDEHERM_EVENT telemetry runtime_id=(\d+) frame_dt_us=(\d+) heap_available=(true|false) heap_bytes=(\d+) heap_size_bytes=(\d+) heap_peak_bytes=(\d+) callback_roots=(\d+) component_instances=(\d+) lua_handles=(\d+) lua_handle_capacity=(\d+) arena_high_water_bytes=(\d+)\b/;

export function parseEngineControlEvent(line, id = "local-engine") {
  const match = controlEventPattern.exec(line);
  if (match) {
    const resourceGeneration = Number(match[3]);
    const runtimeId = Number(match[4]);
    if (!Number.isSafeInteger(resourceGeneration) || resourceGeneration <= 0 ||
        !Number.isSafeInteger(runtimeId) || runtimeId < 0) return undefined;
    return {
      type: match[1] === "activated" ? "runtime-activation-observed" : "runtime-activation-rejected",
      id,
      fingerprint: match[2].toLowerCase(),
      resourceGeneration,
      runtimeId,
      initial: match[5] === "true"
    };
  }
  const telemetry = telemetryEventPattern.exec(line);
  if (!telemetry) return undefined;
  const numbers = telemetry.slice(1).map((value, index) => index === 2 ? value : Number(value));
  if (numbers.some((value, index) => index !== 2 && (!Number.isSafeInteger(value) || value < 0))) return undefined;
  return {
    type: "telemetry",
    id,
    values: {
      runtimeId: numbers[0],
      frameDtMs: numbers[1] / 1000,
      hermesHeapAvailable: telemetry[3] === "true",
      hermesHeapBytes: numbers[3],
      hermesHeapSizeBytes: numbers[4],
      hermesPeakBytes: numbers[5],
      callbackRoots: numbers[6],
      componentInstances: numbers[7],
      luaRegistryUsed: numbers[8],
      luaRegistryCapacity: numbers[9],
      arenaHighWaterBytes: numbers[10]
    }
  };
}

function pipeLines(stream, source, emit, targetId) {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) {
      emit({ type: "log", source, level: diagnosticLevel(line), message: line });
      const control = parseEngineControlEvent(line, targetId);
      if (control) emit(control);
    }
  });
  stream?.on("end", () => {
    if (pending) {
      emit({ type: "log", source, level: diagnosticLevel(pending), message: pending });
      const control = parseEngineControlEvent(pending, targetId);
      if (control) emit(control);
    }
    pending = "";
  });
}

export function createEngineController(options) {
  const emit = options.emit ?? (() => {});
  const spawn = options.spawn ?? spawnProcess;
  let child;
  let closing;

  const launch = async () => {
    if (child) return false;
    const resolved = await (options.resolveEngine ?? resolveBuiltEngine)(options.projectRoot);
    emit({ type: "engine-starting", executable: resolved.executable });
    const next = spawn(resolved.executable, [], {
      cwd: resolved.runtimeRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = next;
    pipeLines(next.stdout, "engine", emit, options.targetId ?? "local-engine");
    pipeLines(next.stderr, "engine", emit, options.targetId ?? "local-engine");
    next.once("spawn", () => emit({ type: "engine-started", executable: resolved.executable, pid: next.pid }));
    next.once("error", (error) => {
      if (child === next) child = undefined;
      emit({ type: "engine-failed", diagnostic: error.message });
    });
    next.once("exit", (code, signal) => {
      if (child === next) child = undefined;
      emit({ type: "engine-stopped", code, signal });
    });
    return true;
  };

  const stop = async () => {
    const running = child;
    if (!running) return false;
    if (closing) return closing;
    closing = new Promise((resolve) => {
      const timeout = setTimeout(() => running.kill("SIGKILL"), options.stopTimeoutMs ?? 2_000);
      running.once("exit", () => {
        clearTimeout(timeout);
        resolve(true);
      });
      running.kill("SIGTERM");
    }).finally(() => { closing = undefined; });
    return closing;
  };

  return {
    launch,
    stop,
    toggle: () => child ? stop() : launch(),
    running: () => Boolean(child)
  };
}
