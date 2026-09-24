// Real installed-package/native driver for War Battles HMR.

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";

import { HMR_STATE_API, validateHmrRuntimeHealth } from "./hmr-state-soak.mjs";

const execFile = promisify(execFileCallback);
const timeoutMs = Number(process.env.DEHERM_WAR_BATTLES_HMR_TIMEOUT_MS ?? 90_000);
const shutdownTimeoutMs = Number(process.env.DEHERM_WAR_BATTLES_HMR_SHUTDOWN_TIMEOUT_MS ?? 15_000);
const markerPattern = /war-battles:hmr-reload:edit=([^:]+):tick=(\d+):entities=(\d+):elapsed=([0-9.]+)/u;
export const DEFAULT_INSTALLED_HMR_BUILD_SERVER = "http://127.0.0.1:9010";

export function installedHmrLaunchConfiguration(environment = process.env) {
  return {
    buildServer:
      environment.DEHERM_BUILD_SERVER || environment.DEFOLD_HERMES_BUILD_SERVER || DEFAULT_INSTALLED_HMR_BUILD_SERVER,
    // Online policy resolution is the correctness default. An explicit
    // DEHERM_OFFLINE=1 remains supported, but the harness must not silently
    // reuse an older authenticated surface for the same Defold revision after
    // the package's stable runtime ABI has advanced.
    environment: { ...environment },
  };
}

export function dependencyLinkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

export function windowsTaskkillArguments(pid, force = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid owned Windows process id: ${pid}`);
  return ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
}

export function ownedPosixGroupAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid owned POSIX process-group id: ${pid}`);
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the group exists but is not signalable by this process. It
    // is still live and must not be treated as safely reaped.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function stopOwnedProcessTree({
  pid,
  ownsProcessGroup,
  leaderExited,
  groupAlive,
  signalGroup,
  taskkill,
  exited,
  shutdownMs = shutdownTimeoutMs,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const treeAlive = () => (ownsProcessGroup ? groupAlive() : !leaderExited());
  const waitForTreeExit = async () => {
    const deadline = Date.now() + shutdownMs;
    for (;;) {
      if (!treeAlive()) return exited;
      if (Date.now() >= deadline) return undefined;
      await sleep(50);
    }
  };
  if (!ownsProcessGroup) {
    // taskkill /T is the only evidence that the Windows descendants were
    // addressed. A vanished leader is not proof that Bob/dmengine also exited,
    // so fail closed when the tree operation cannot name the original PID.
    try {
      await taskkill(false, pid);
    } catch (error) {
      throw new Error(`could not terminate owned Windows HMR process tree for pid ${pid}`, { cause: error });
    }
    const graceful = await waitForTreeExit();
    if (graceful) return graceful;
    await taskkill(true, pid);
    const forced = await waitForTreeExit();
    if (!forced) throw new Error("owned Windows HMR process tree did not exit after taskkill /T /F");
    return forced;
  }

  if (treeAlive()) signalGroup("SIGTERM");
  const graceful = await waitForTreeExit();
  if (graceful) return graceful;
  if (treeAlive()) signalGroup("SIGKILL");
  const forced = await waitForTreeExit();
  if (!forced) throw new Error("owned HMR process group did not exit after SIGKILL");
  return forced;
}

export async function cleanupOwnedHmrRun({ stopOwnedTree, childClosed, restoreOwnedFiles }) {
  const failures = [];
  try {
    await stopOwnedTree();
    // The child process 'close' event follows stream closure, so all final
    // stdout/stderr is visible to the post-close health sweep.
    await childClosed;
  } catch (error) {
    failures.push(error);
  }
  try {
    // Restoration is independent of process cleanup. Never leave the temporary
    // implementation-only edit behind because process reaping failed.
    await restoreOwnedFiles();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "installed HMR cleanup and source restoration both failed");
}

export async function installedPackageTreeSha256(packageRoot) {
  const hash = createHash("sha256");
  const visit = async (directory, prefix = "") => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== "node_modules")
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        hash
          .update(relative)
          .update("\0")
          .update(await readFile(absolute))
          .update("\0");
      } else throw new Error(`installed package contains unsupported entry: ${relative}`);
    }
  };
  await visit(packageRoot);
  return hash.digest("hex");
}

export function assertInstalledPackageTreeSha256(recordedTreeSha256, currentTreeSha256) {
  if (!/^[0-9a-f]{64}$/u.test(recordedTreeSha256 ?? "")) {
    throw new Error("recorded installed package treeSha256 is invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(currentTreeSha256 ?? "")) {
    throw new Error("current installed package treeSha256 is invalid");
  }
  if (recordedTreeSha256 !== currentTreeSha256) {
    throw new Error(
      [
        "recorded installed package treeSha256 does not match the current packed package",
        `recorded=${recordedTreeSha256}`,
        `current=${currentTreeSha256}`,
      ].join("; "),
    );
  }
  return true;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function packPackageTree(repositoryRoot) {
  const stage = await mkdtemp(path.join(tmpdir(), "deherm-installed-hmr-"));
  try {
    await execFile("pnpm", ["pack", "--pack-destination", stage], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
    const archive = (await readdir(stage)).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error("pnpm pack did not produce a public package archive");
    await execFile("tar", ["-xzf", path.join(stage, archive), "-C", stage], { maxBuffer: 1 * 1024 * 1024 });
    const packageRoot = path.join(stage, "package");
    if (
      !(await exists(path.join(packageRoot, "bin/deherm.mjs"))) ||
      !(await exists(path.join(packageRoot, "package.json")))
    )
      throw new Error("packed package has no public deherm bin");
    const treeSha256 = await installedPackageTreeSha256(packageRoot);
    return { packageRoot, stage, treeSha256 };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Pack the current public package and return the exact tree identity used by
 * the live installed-package driver. The temporary extraction is always
 * removed, so evidence checking cannot accidentally retain or reuse stale
 * package state.
 */
export async function packedPackageTreeSha256(repositoryRoot) {
  const packed = await packPackageTree(repositoryRoot);
  try {
    return packed.treeSha256;
  } finally {
    await rm(packed.stage, { recursive: true, force: true });
  }
}

async function makePackedBoundary(repositoryRoot) {
  const packed = await packPackageTree(repositoryRoot);
  try {
    // Keep dependency resolution at the installed package boundary while
    // reusing this checkout's locked dependency store; no source import is used.
    await symlink(
      path.join(repositoryRoot, "node_modules"),
      path.join(packed.packageRoot, "node_modules"),
      dependencyLinkType(),
    );
    return { ...packed, source: "pnpm-pack-tarball", verified: true };
  } catch (error) {
    await rm(packed.stage, { recursive: true, force: true });
    throw error;
  }
}

function stateTarget(state) {
  return (
    state?.targets?.find((target) => target.id === "local-engine") ??
    state?.targets?.find((target) => target.runtime === "hermes")
  );
}

export function parseReloadMarker(message) {
  const match = markerPattern.exec(String(message ?? ""));
  if (!match) return undefined;
  return {
    edit: match[1],
    gameplayTick: Number(match[2]),
    worldEntityCount: Number(match[3]),
    elapsedSeconds: Number(match[4]),
  };
}

export function runtimeErrorFromEvents(events, start = 0) {
  const event = events
    .slice(start)
    .find(
      (candidate) =>
        candidate?.type === "runtime-activation-rejected" || (candidate?.type === "log" && candidate.level === "error"),
    );
  if (!event) return undefined;
  return {
    type: event.type,
    ...(event.source ? { source: event.source } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
    ...(event.fingerprint ? { fingerprint: event.fingerprint } : {}),
  };
}

export function parseCliEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    return { event: parsed?.event ?? parsed, protocolError: false };
  } catch {
    return {
      event: {
        type: "log",
        level: "error",
        source: "stdout-protocol",
        message: line,
      },
      protocolError: true,
    };
  }
}

export function snapshotFromState(state, gameplay = {}) {
  const target = stateTarget(state);
  const component = target?.componentSnapshot;
  const instances = target?.instances;
  if (!target || !component || !Array.isArray(instances) || instances.length < 1)
    throw new Error("native inspector state has no complete component snapshot");
  if (target.instanceProjection?.complete === false)
    throw new Error("native inspector state component projection is incomplete");
  const telemetry = target.telemetry ?? {};
  if (telemetry.componentInstances !== undefined && telemetry.componentInstances !== instances.length) {
    throw new Error(
      `native component snapshot count ${instances.length} disagrees with telemetry ${telemetry.componentInstances}`,
    );
  }
  if (telemetry.runtimeId !== undefined && telemetry.runtimeId !== component.runtimeId) {
    throw new Error(
      `native component snapshot runtime ${component.runtimeId} disagrees with telemetry ${telemetry.runtimeId}`,
    );
  }
  const transientSources = new Set(["main/rocket.script.ts", "main/pickup.script.ts"]);
  const persistentInstances = instances.filter((instance) => !transientSources.has(instance.source));
  const transientInstances = instances.filter((instance) => transientSources.has(instance.source));
  const arenaInstances = instances.filter((instance) => instance.source === "main/arena.script.ts");
  if (persistentInstances.length < 1 || arenaInstances.length !== 1) {
    throw new Error(
      `native component snapshot has ${persistentInstances.length} persistent instances and ${arenaInstances.length} arena anchors`,
    );
  }
  return {
    entityCount: Number.isSafeInteger(gameplay.worldEntityCount) ? gameplay.worldEntityCount : 1,
    componentCount: instances.length,
    gameplayTick: Number.isSafeInteger(gameplay.gameplayTick) ? gameplay.gameplayTick : 0,
    runtimeId: component.runtimeId,
    instanceIds: instances.map((instance) => instance.instanceId),
    persistentInstanceIds: persistentInstances.map((instance) => instance.instanceId),
    transientInstanceIds: transientInstances.map((instance) => instance.instanceId),
    transientPopulation: transientInstances.length,
    arenaInstanceId: arenaInstances[0].instanceId,
    ...(telemetry.frameDtMs !== undefined ? { frameDtMs: telemetry.frameDtMs } : {}),
    ...(telemetry.hermesHeapBytes !== undefined ? { heapBytes: telemetry.hermesHeapBytes } : {}),
    ...(telemetry.hermesPeakBytes !== undefined ? { heapPeakBytes: telemetry.hermesPeakBytes } : {}),
    ...(telemetry.callbackRoots !== undefined ? { callbackRoots: telemetry.callbackRoots } : {}),
    ...(telemetry.luaRegistryUsed !== undefined ? { luaHandles: telemetry.luaRegistryUsed } : {}),
    ...(telemetry.arenaHighWaterBytes !== undefined ? { arenaHighWaterBytes: telemetry.arenaHighWaterBytes } : {}),
  };
}

export async function createWarBattlesHmrDriver({ repositoryRoot, exampleRoot, installedPackageRoot }) {
  const projectRoot = path.join(exampleRoot, "defold");
  const sourceFile = path.join(projectRoot, "main/arena.script.ts");
  const originalSource = await readFile(sourceFile, "utf8");
  if (!originalSource.includes('logHmrState(self, "baseline")'))
    throw new Error("arena.script.ts is missing the production HMR marker");
  let packageBoundary;
  if (installedPackageRoot) {
    const packageRoot = path.resolve(installedPackageRoot);
    if (!(await exists(path.join(packageRoot, "bin/deherm.mjs"))))
      throw new Error(`installed package has no public bin: ${packageRoot}`);
    packageBoundary = {
      packageRoot,
      source: "provided-installed-package",
      treeSha256: await installedPackageTreeSha256(packageRoot),
      verified: true,
    };
  } else packageBoundary = await makePackedBoundary(repositoryRoot);

  const ownsProcessGroup = process.platform !== "win32";
  const launchConfiguration = installedHmrLaunchConfiguration(process.env);
  const child = spawn(
    process.execPath,
    [
      path.join(packageBoundary.packageRoot, "bin/deherm.mjs"),
      "dev",
      "--project",
      projectRoot,
      "--entry",
      "main/arena.script.ts",
      "--watch",
      projectRoot,
      "--headless",
      "--json",
      "--build-server",
      launchConfiguration.buildServer,
    ],
    {
      cwd: packageBoundary.packageRoot,
      env: launchConfiguration.environment,
      stdio: ["ignore", "pipe", "pipe"],
      // A failed soak must not leave the CLI, Bob, or dmengine writing the next
      // run's source and session log. POSIX gives this installed boundary its own
      // process group so escalation can terminate the complete owned tree.
      detached: ownsProcessGroup,
    },
  );
  const events = [];
  const markers = [];
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const decoded = parseCliEventLine(line);
      const event = decoded.event;
      events.push(event);
      if (!decoded.protocolError) {
        const marker = event?.type === "log" ? parseReloadMarker(event.message) : undefined;
        if (marker) markers.push({ marker, event });
      } else {
        // `deherm dev --json` owns stdout as a machine protocol. Any non-JSON
        // line is therefore a protocol/runtime failure, not ignorable console
        // decoration. Retain it in diagnostics and in the per-edit event
        // window so a seemingly successful activation cannot hide the error.
        stderr += `${line}\n`;
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const signalOwnedPosixTree = (signal) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  const stopOwnedTree = async () => {
    const leaderExited = () => child.exitCode !== null || child.signalCode !== null;
    // Do not key cleanup solely off the CLI leader. A detached child can have
    // already exited while Bob/dmengine remains in the owned POSIX group.
    const result = await stopOwnedProcessTree({
      pid: child.pid,
      ownsProcessGroup,
      leaderExited,
      groupAlive: () => ownedPosixGroupAlive(child.pid),
      signalGroup: signalOwnedPosixTree,
      taskkill: (force, pid) => execFile("taskkill.exe", windowsTaskkillArguments(pid, force)),
      exited,
    });
    return result;
  };
  const sessionFile = path.join(projectRoot, ".deherm/dev/inspector.json");
  let session;
  let eventCursor = 0;
  let markerCursor = 0;
  let lastGameplayTick = 0;
  let lastGameplay = { gameplayTick: 0, worldEntityCount: 1 };
  let pendingEdit;
  let currentEdit = "baseline";
  let lastWrittenSource = originalSource;
  let closed = false;

  const restoreOwnedFiles = async () => {
    const current = await readFile(sourceFile, "utf8");
    if (current === lastWrittenSource) await writeFile(sourceFile, originalSource);
    else if (current !== originalSource) throw new Error("arena.script.ts changed externally; left it untouched");
    if (packageBoundary.stage) await rm(packageBoundary.stage, { recursive: true, force: true });
  };
  const cleanupOwnedRun = async () => {
    await cleanupOwnedHmrRun({ stopOwnedTree, childClosed, restoreOwnedFiles });
  };

  async function readState() {
    if (!session) session = JSON.parse(await readFile(sessionFile, "utf8"));
    const response = await fetch(session.stateUrl, {
      headers: { authorization: `Bearer ${session.authToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`native inspector state failed: HTTP ${response.status}`);
    return response.json();
  }
  function coherentState(state, fingerprint) {
    const target = stateTarget(state);
    const component = target?.componentSnapshot;
    const instances = target?.instances;
    const telemetry = target?.telemetry ?? {};
    if (
      !component ||
      !Array.isArray(instances) ||
      instances.length < 1 ||
      target.instanceProjection?.complete === false
    )
      return false;
    if (telemetry.componentInstances !== instances.length || telemetry.runtimeId !== component.runtimeId) return false;
    if (fingerprint !== undefined && telemetry.bundleFingerprint !== fingerprint) return false;
    return true;
  }
  async function waitFor(predicate, label, waitTimeout = timeoutMs) {
    const deadline = Date.now() + waitTimeout;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${label} timed out${stderr ? `; ${stderr.slice(-1_000)}` : ""}`);
      const result = await predicate();
      if (result !== undefined && result !== false) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function waitForCoherentState(label, fingerprint) {
    return waitFor(async () => {
      const state = await readState();
      return coherentState(state, fingerprint) ? state : undefined;
    }, label);
  }
  async function ensureSession() {
    await waitFor(async () => {
      if (!(await exists(sessionFile))) return undefined;
      try {
        session = JSON.parse(await readFile(sessionFile, "utf8"));
        return session.pid === child.pid && session.stateUrl && session.authToken ? true : undefined;
      } catch {
        return undefined;
      }
    }, "inspector session");
    const unauthorized = await fetch(session.stateUrl, { signal: AbortSignal.timeout(5_000) });
    if (unauthorized.status !== 401)
      throw new Error(`native inspector state endpoint did not require Bearer auth (HTTP ${unauthorized.status})`);
  }
  try {
    await ensureSession();
  } catch (error) {
    try {
      await cleanupOwnedRun();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "installed HMR startup and cleanup both failed");
    }
    throw error;
  }

  const baselineSnapshot = async () => {
    await waitFor(
      () => events.some((event) => event?.type === "log" && /war-battles:arena-engaged/u.test(event.message)),
      "War Battles gameplay start",
    );
    // Let the arena's factories finish attaching their component instances so
    // the baseline is the live match, not the tutorial scene's pre-engagement
    // population.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const baselineState = await waitForCoherentState("native component snapshot baseline");
    const initial = await waitFor(
      () => markers.find(({ marker }) => marker.edit === "initial")?.marker,
      "initial War Battles gameplay state marker",
    );
    lastGameplayTick = initial.gameplayTick;
    lastGameplay = initial;
    markerCursor = markers.length;
    return snapshotFromState(baselineState, initial);
  };
  const activeFingerprint = async () =>
    stateTarget(await waitForCoherentState("initial bundle activation")).telemetry.bundleFingerprint;
  const applyAcceptedComponentBodyReload = async (index) => {
    const token = `cycle-${index}-${Date.now().toString(36)}`;
    const current = await readFile(sourceFile, "utf8");
    if (current !== lastWrittenSource)
      throw new Error("arena.script.ts changed outside the installed HMR driver; refusing to overwrite it");
    // Ignore startup builds/markers; this edit's build and activation are the
    // only events that may satisfy the next cycle.
    eventCursor = events.length;
    markerCursor = markers.length;
    const next = current.replace(`logHmrState(self, "${currentEdit}")`, `logHmrState(self, "${token}")`);
    if (next === current) throw new Error("could not prepare an implementation-only arena marker edit");
    await writeFile(sourceFile, next);
    lastWrittenSource = next;
    pendingEdit = token;
    currentEdit = token;
    return token;
  };
  const waitForAccepted = async (index) => {
    const cycleStart = eventCursor;
    const build = await waitFor(() => {
      for (; eventCursor < events.length; eventCursor += 1) {
        const event = events[eventCursor];
        if (event?.type === "build-succeeded" && typeof event.fingerprint === "string") return event;
      }
      return undefined;
    }, `accepted cycle ${index} build`);
    const activation = await waitFor(
      () =>
        events
          .slice(eventCursor)
          .find((event) => event?.type === "runtime-activation-observed" && event.fingerprint === build.fingerprint),
      `accepted cycle ${index} activation`,
    );
    eventCursor = events.indexOf(activation) + 1;
    const marker = await waitFor(() => {
      for (; markerCursor < markers.length; markerCursor += 1) {
        const marker = markers[markerCursor].marker;
        if (marker.edit === pendingEdit && marker.gameplayTick > lastGameplayTick) return marker;
      }
      return undefined;
    }, `accepted cycle ${index} gameplay marker`);
    lastGameplayTick = marker.gameplayTick;
    lastGameplay = marker;
    pendingEdit = undefined;
    const state = await waitForCoherentState(`accepted cycle ${index} coherent state fingerprint`, build.fingerprint);
    const runtimeError = runtimeErrorFromEvents(events, cycleStart);
    return {
      status: "activated",
      fingerprint: build.fingerprint,
      activeFingerprint: build.fingerprint,
      runtimeId: activation.runtimeId,
      gameplay: marker,
      snapshotState: state,
      ...(runtimeError ? { runtimeError } : {}),
    };
  };
  const snapshot = async () =>
    snapshotFromState(await waitForCoherentState("accepted reload state snapshot"), lastGameplay);
  const close = async () => {
    if (closed) return;
    closed = true;
    await cleanupOwnedRun();
  };
  const assertClean = async () => validateHmrRuntimeHealth(events, stderr);
  return {
    installedPackage: {
      verified: packageBoundary.verified,
      packageName: "@ts-defold/deherm",
      source: packageBoundary.source,
      treeSha256: packageBoundary.treeSha256,
      command: "bin/deherm.mjs",
    },
    runtimeApi: {
      name: HMR_STATE_API,
      available: true,
      target: "native",
      endpoint: "/deherm/dev/v1/snapshot",
    },
    baselineSnapshot,
    activeFingerprint,
    applyAcceptedComponentBodyReload,
    waitForAccepted,
    snapshot,
    assertClean,
    close,
  };
}
