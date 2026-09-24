import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// The rejected-diagnostic families are owned by the compiler toolchain so the
// development loop, this packaged harness, and the runtime bug-pool harvester
// all classify engine output the same way.
import { REJECTED_DIAGNOSTICS, firstRejectedDiagnostic } from "@ts-defold/deherm/dev/runtime-diagnostics";
import {
  BOB_TOOLING_IGNORE_ENTRIES,
  TYPED_NATIVE_IGNORE_ENTRY
} from "@ts-defold/deherm/dev/typed-native";

import { DYNAMIC_SERVICE_PORT_ENV, requestGracefulShutdown } from "./graceful-shutdown.mjs";
import { projectionEnvelope } from "./projections.mjs";

/** The projection this harness observes. */
export const PROJECTION_ID = "native-arm64-macos";
export const DEFAULT_SETTLE_MS = 1_500;

export { REJECTED_DIAGNOSTICS, firstRejectedDiagnostic };

// The same tutorial loop the browser gate requires, spelled in engine-log form.
// Keeping the two lists the same behaviour is what makes the native and browser
// projections comparable instead of merely adjacent.
export const RUNTIME_PROFILE_MARKER_PREFIX =
  "INFO:DEFOLD_HERMES: Detected Defold runtime profile 'default-legacy-bullet' from ";
export const REQUIRED_MARKERS = Object.freeze([
  "INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)",
  // Extensions can add registrations between the early engine probe and the
  // final attached runtime. The profile identity is authoritative; the count
  // is observed data and must be a positive integer rather than a stale pin.
  RUNTIME_PROFILE_MARKER_PREFIX,
  "INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'",
  "INFO:DEFOLD_HERMES: war-battles:camera-init:zoom=2.00:view=640x360:cameras=1",
  "INFO:DEFOLD_HERMES: war-battles:camera-bounds:x=[8.0,1288.0]:y=[-172.0,908.0]",
  "INFO:DEFOLD_HERMES: war-battles:ui-init",
  "INFO:DEFOLD_HERMES: war-battles:player-init:560.0:360.0",
  "INFO:DEFOLD_HERMES: war-battles:player-fire:560.0:360.0:1.00:0.00",
  "INFO:DEFOLD_HERMES: war-battles:rocket-init:1.00:0.00",
  "INFO:DEFOLD_HERMES: war-battles:rocket-hit",
  "INFO:DEFOLD_HERMES: war-battles:score:100",
  "INFO:DEFOLD_HERMES: war-battles:rocket-explosion-done",
  "INFO:DEFOLD_HERMES: war-battles:player-moved:1592.0:1072.0",
  // The scripted demonstration ends by handing the scene to the arena, which
  // creates the roster, the turrets and the pickup pads. Observing the engage
  // marker is what distinguishes "the tutorial loop ran" from "the game started".
  "INFO:DEFOLD_HERMES: war-battles:arena-init:players=8:online=0",
  "INFO:DEFOLD_HERMES: war-battles:arena-engaged:players=8:skill=2:seed=1463898690:mode=offline",
  "INFO:DEFOLD_HERMES: Extension update entered (application initialized: false)",
]);

// Markers that only a graceful shutdown can produce. A component `final()` runs
// when the engine tears its collections down, which a signal never does, so
// this line is observable evidence that teardown ran and that a structured Lua
// call from `final` still found its captured script instance.
export const REQUIRED_SHUTDOWN_MARKERS = Object.freeze([
  "INFO:DEFOLD_HERMES: war-battles:player-final",
]);

export function observedRequiredMarkers(transcript, requiredMarkers = REQUIRED_MARKERS) {
  const lines = transcript.replaceAll("\r", "").split("\n").map((line) => line.trimEnd());
  return requiredMarkers.map((marker) => {
    if (marker !== RUNTIME_PROFILE_MARKER_PREFIX) return lines.find((line) => line === marker) ?? null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith(marker)) continue;
      if (/^[1-9][0-9]* generated Lua symbols$/u.test(line.slice(marker.length))) return line;
    }
    return null;
  });
}

/**
 * Reconstruct the required marker list from checked evidence without turning
 * its one measured field into a pinned constant. Every static marker must
 * remain byte-identical and in the canonical order; only the final positive
 * runtime-profile symbol count is admitted as observed data.
 */
export function checkedRequiredMarkers(recorded, requiredMarkers = REQUIRED_MARKERS) {
  if (!Array.isArray(recorded) || recorded.length !== requiredMarkers.length) {
    throw new Error("Recorded runtime markers do not match the required marker count");
  }
  const expected = requiredMarkers.map((marker, index) => {
    if (marker !== RUNTIME_PROFILE_MARKER_PREFIX) return marker;
    const candidate = recorded[index];
    if (typeof candidate !== "string" || !candidate.startsWith(marker) ||
        !/^[1-9][0-9]* generated Lua symbols$/u.test(candidate.slice(marker.length))) {
      throw new Error("Recorded runtime profile marker must carry a positive generated Lua symbol count");
    }
    return candidate;
  });
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
    throw new Error("Recorded runtime markers differ from the required marker set");
  }
  return expected;
}

export function checkedShutdownMarkers(recorded, requiredMarkers = REQUIRED_SHUTDOWN_MARKERS) {
  if (JSON.stringify(recorded) !== JSON.stringify(requiredMarkers)) {
    throw new Error("Recorded shutdown markers differ from the required component-teardown marker set");
  }
  return [...requiredMarkers];
}

export function checkedSettleMs(recorded, requiredSettleMs = DEFAULT_SETTLE_MS) {
  if (recorded !== requiredSettleMs) {
    throw new Error(`Recorded runtime settle window must be ${requiredSettleMs}ms`);
  }
  return requiredSettleMs;
}

async function waitForExitAfterSignal(child, method, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { method, exitCode: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveTermination) => {
    const timer = setTimeout(() => resolveTermination(null), graceMs);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolveTermination({ method, exitCode, signal });
    });
  });
}

/**
 * Ask the engine to shut down the way a game does, so every component `final()`
 * runs. The addressing and the collision census live in `graceful-shutdown.mjs`
 * and both fail loudly; a failure here is never quietly downgraded to a signal,
 * because a signal would produce a transcript that looks like a clean run while
 * proving nothing about teardown. The process is still reaped so the gate does
 * not leak an engine.
 */
async function terminateGracefully(child, transcript, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { method: "already-exited", exitCode: child.exitCode, signal: child.signalCode };
  }
  let addressed;
  try {
    addressed = await requestGracefulShutdown({ transcript: transcript(), pid: child.pid });
  } catch (error) {
    await forceKill(child, graceMs);
    throw error;
  }
  const exited = await waitForExitAfterSignal(child, "system-exit", graceMs);
  if (!exited) {
    await forceKill(child, graceMs);
    throw new Error(
      `Packaged runtime did not exit within ${graceMs}ms of a graceful @system/exit posted to ` +
      `port ${addressed.port} (pid ${addressed.pid})`);
  }
  return { ...exited, port: addressed.port };
}

async function forceKill(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.kill("SIGKILL")) throw new Error("Packaged runtime could not be sent SIGKILL");
  await waitForExitAfterSignal(child, "sigkill", graceMs);
}

export async function runPackagedRuntimeEvidence({
  command,
  args = [],
  cwd,
  env = process.env,
  requiredMarkers = REQUIRED_MARKERS,
  shutdownMarkers = REQUIRED_SHUTDOWN_MARKERS,
  timeoutMs = 30_000,
  settleMs = 1_500,
  terminationGraceMs = 8_000,
}) {
  for (const [name, value] of Object.entries({ timeoutMs, settleMs, terminationGraceMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (settleMs >= timeoutMs) throw new Error("settleMs must be less than timeoutMs");
  if (!Array.isArray(requiredMarkers) || requiredMarkers.length === 0 || new Set(requiredMarkers).size !== requiredMarkers.length) {
    throw new Error("requiredMarkers must be a non-empty list of unique strings");
  }
  if (!Array.isArray(shutdownMarkers) || new Set(shutdownMarkers).size !== shutdownMarkers.length) {
    throw new Error("shutdownMarkers must be a list of unique strings");
  }

  // The engine service port is what a graceful shutdown is addressed to, and a
  // default port is shared between engines by SO_REUSEPORT. Asking the kernel
  // for one per engine is the half of the fix that no census can substitute.
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...DYNAMIC_SERVICE_PORT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let transcript = "";
  let markerObservedAt = null;
  let settled = false;
  const append = (chunk) => { transcript += chunk.toString("utf8").replaceAll("\r", ""); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  let observationFailure = null;
  let termination;
  try {
    await new Promise((resolveObservation, rejectObservation) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const diagnostic = firstRejectedDiagnostic(transcript);
        if (diagnostic) {
          clearInterval(timer);
          rejectObservation(new Error(`Packaged runtime emitted rejected diagnostic '${diagnostic.id}': ${diagnostic.text}\n${transcript}`));
          return;
        }
        const observed = observedRequiredMarkers(transcript, requiredMarkers);
        if (observed.every(Boolean)) markerObservedAt ??= Date.now();
        if (markerObservedAt !== null && Date.now() - markerObservedAt >= settleMs) {
          settled = true;
          clearInterval(timer);
          resolveObservation();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          const missing = requiredMarkers.filter((_, index) => !observed[index]);
          rejectObservation(new Error(`Packaged runtime timed out; missing markers: ${missing.join(" | ")}\n${transcript}`));
        }
      }, 20);
      child.once("error", (error) => {
        clearInterval(timer);
        rejectObservation(error);
      });
      child.once("exit", (exitCode, signal) => {
        if (settled) return;
        clearInterval(timer);
        rejectObservation(new Error(`Packaged runtime exited before the observation window completed (code=${exitCode}, signal=${signal}):\n${transcript}`));
      });
    });
  } catch (error) {
    observationFailure = error;
  }
  try {
    termination = await terminateGracefully(child, () => transcript, terminationGraceMs);
  } catch (cleanupError) {
    if (observationFailure) {
      observationFailure.cleanupFailure = cleanupError;
      throw observationFailure;
    }
    throw cleanupError;
  }
  if (observationFailure) throw observationFailure;

  const diagnostic = firstRejectedDiagnostic(transcript);
  if (diagnostic) {
    throw new Error(`Packaged runtime emitted rejected diagnostic '${diagnostic.id}' during shutdown: ${diagnostic.text}\n${transcript}`);
  }
  // A graceful shutdown is the claim; a non-zero code or a signal means the
  // engine did not shut down the way a game does, whatever else the transcript
  // shows.
  if (termination.method !== "system-exit" || termination.exitCode !== 0 || termination.signal !== null) {
    throw new Error(
      `Packaged runtime did not exit cleanly from @system/exit (method=${termination.method}, code=${termination.exitCode}, signal=${termination.signal}):\n${transcript}`,
    );
  }
  const observedShutdown = observedRequiredMarkers(transcript, shutdownMarkers);
  if (!observedShutdown.every(Boolean)) {
    const missing = shutdownMarkers.filter((_, index) => !observedShutdown[index]);
    throw new Error(
      `Packaged runtime shut down without running component teardown; missing markers: ${missing.join(" | ")}\n${transcript}`,
    );
  }

  return {
    markers: observedRequiredMarkers(transcript, requiredMarkers),
    shutdownMarkers: observedShutdown,
    transcript,
    settleMs,
    termination,
  };
}

export function canonicalizeRuntimeTranscript(transcript) {
  return transcript
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line
      .replace(/Log server started on port \d+/, "Log server started on port <dynamic>")
      .replace(/Engine service started on port \d+/, "Engine service started on port <dynamic>")
      .replace(/Initialized Remotery \(ws:\/\/127\.0\.0\.1:\d+\/rmt\)/, "Initialized Remotery (ws://127.0.0.1:<dynamic>/rmt)")
      .replace(/Target listening with name: .* - (?:\d{1,3}\.){3}\d{1,3} - Darwin/, "Target listening with name: <host> - <address> - Darwin"))
    .join("\n") + "\n";
}

export function transcriptEvidence(transcript) {
  const canonical = canonicalizeRuntimeTranscript(transcript);
  return {
    canonicalLineCount: canonical.split("\n").filter(Boolean).length,
    canonicalSha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

export async function sha256Artifact(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, path);
  const [contents, metadata] = await Promise.all([readFile(absolute), stat(absolute)]);
  if (!metadata.isFile()) throw new Error(`Runtime evidence artifact is not a file: ${absolute}`);
  return {
    path: relative(repositoryRoot, absolute).replaceAll("\\", "/"),
    bytes: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

/**
 * Canonicalise `.defignore` for runtime source evidence without hiding rules
 * authored by the game. The project boundary owns the invariant tooling/cache
 * exclusions, and the web/native target reconciler owns one transient transport
 * exclusion. Adding or removing those exact trimmed lines must not invalidate
 * native evidence. Every other line remains an input because it can change what
 * Bob uploads and therefore what the observed engine actually executes.
 *
 * Reconciliation rewrites line endings and trailing blank lines, so those are
 * normalised here as syntax rather than treated as semantic project changes.
 */
export function normalizedDefignoreText(
  text = "",
  managedEntries = [...BOB_TOOLING_IGNORE_ENTRIES, TYPED_NATIVE_IGNORE_ENTRY]
) {
  const managed = new Set(Array.isArray(managedEntries) ? managedEntries : [managedEntries]);
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    .filter((line) => !managed.has(line.trim()));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export async function sha256DefignoreEvidence(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, path);
  let text = "";
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const normalized = normalizedDefignoreText(text);
  return {
    path: `${relative(repositoryRoot, absolute).replaceAll("\\", "/")}#authored-rules`,
    bytes: Buffer.byteLength(normalized),
    sha256: createHash("sha256").update(normalized).digest("hex"),
  };
}

export async function sha256Tree(repositoryRoot, path, { exclude = () => false } = {}) {
  const absoluteRoot = resolve(repositoryRoot, path);
  const records = [];
  let bytes = 0;
  async function visit(absolute, local) {
    if (exclude(local)) return;
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        await visit(join(absolute, entry.name), local ? `${local}/${entry.name}` : entry.name);
      }
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolute);
      records.push({ path: local, kind: "symlink", bytes: Buffer.byteLength(target), sha256: createHash("sha256").update(target).digest("hex") });
      bytes += Buffer.byteLength(target);
      return;
    }
    if (!metadata.isFile()) throw new Error(`Unsupported runtime evidence tree entry: ${absolute}`);
    const contents = await readFile(absolute);
    records.push({ path: local, kind: "file", bytes: metadata.size, sha256: createHash("sha256").update(contents).digest("hex") });
    bytes += metadata.size;
  }
  await visit(absoluteRoot, "");
  if (records.length === 0) throw new Error(`Runtime evidence source tree is empty: ${absoluteRoot}`);
  return {
    path: relative(repositoryRoot, absoluteRoot).replaceAll("\\", "/"),
    kind: "tree",
    fileCount: records.length,
    bytes,
    sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}

export function digestEvidenceInputs(entries) {
  return createHash("sha256")
    .update(JSON.stringify(entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))))
    .digest("hex");
}

export function buildEvidenceDocument({
  artifacts,
  sourceInputs,
  markers,
  shutdownMarkers,
  settleMs,
  termination,
  transcript,
}) {
  const artifactKey = digestEvidenceInputs(artifacts);
  const sourceKey = digestEvidenceInputs(sourceInputs);
  const transcriptRecord = transcript;
  if (!transcriptRecord || !Number.isSafeInteger(transcriptRecord.canonicalLineCount) || transcriptRecord.canonicalLineCount <= 0 ||
      !/^[0-9a-f]{64}$/.test(transcriptRecord.canonicalSha256)) {
    throw new Error("Transcript evidence must contain a positive canonical line count and SHA-256 digest");
  }
  // Only a graceful shutdown runs component `final()`, so only a graceful
  // shutdown can be recorded here. A signal-terminated run is a different
  // observation and must not be written into this document's shape.
  const terminationIsGraceful = termination?.method === "system-exit" &&
    termination.exitCode === 0 && termination.signal === null &&
    Number.isSafeInteger(termination.port) && termination.port > 0;
  if (!terminationIsGraceful) {
    throw new Error("Transcript evidence must record a clean @system/exit shutdown with the engine service port it was addressed to");
  }
  if (!Array.isArray(shutdownMarkers) || shutdownMarkers.length === 0 || shutdownMarkers.some((marker) => typeof marker !== "string")) {
    throw new Error("Transcript evidence must record the observed component-teardown markers");
  }
  const evidenceKey = createHash("sha256")
    .update(JSON.stringify({ artifactKey, sourceKey, transcript: transcriptRecord }))
    .digest("hex");
  return {
    schemaVersion: 3,
    projection: projectionEnvelope(PROJECTION_ID),
    target: "arm64-macos",
    status: "observed-clean",
    artifactKey,
    sourceKey,
    evidenceKey,
    artifacts,
    sourceInputs,
    observation: {
      requiredMarkers: markers,
      shutdownMarkers,
      settleMs,
      rejectedDiagnosticIds: REJECTED_DIAGNOSTICS.map(({ id }) => id),
      termination,
      transcript: transcriptRecord,
    },
  };
}
