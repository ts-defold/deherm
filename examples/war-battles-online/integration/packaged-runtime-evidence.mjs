import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const REQUIRED_MARKERS = Object.freeze([
  "INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)",
  "INFO:DEFOLD_HERMES: Detected Defold runtime profile 'default-legacy-bullet' from 253 generated Lua symbols",
  "INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'",
  "INFO:DEFOLD_HERMES: war-battles:ui-init",
  "INFO:DEFOLD_HERMES: war-battles:player-init:560.0:360.0",
  "INFO:DEFOLD_HERMES: war-battles:player-fire:560.0:360.0:1.00:0.00",
  "INFO:DEFOLD_HERMES: war-battles:rocket-init:1.00:0.00",
  "INFO:DEFOLD_HERMES: war-battles:rocket-hit",
  "INFO:DEFOLD_HERMES: war-battles:score:100",
  "INFO:DEFOLD_HERMES: war-battles:rocket-explosion-done",
  "INFO:DEFOLD_HERMES: Extension update entered (application initialized: false)",
]);

export const REJECTED_DIAGNOSTICS = Object.freeze([
  { id: "error-severity", pattern: /(?:^|\n)[^\n]*\bERROR:/i },
  { id: "fatal-severity", pattern: /(?:^|\n)[^\n]*\bFATAL:/i },
  { id: "script-error", pattern: /RESULT_SCRIPT_ERROR|SCRIPT ERROR/i },
  { id: "lua-traceback", pattern: /stack traceback:/i },
  { id: "javascript-failure", pattern: /\b(?:uncaught|unhandled)\b|\bexception\b/i },
  { id: "bundle-rejected", pattern: /TypeScript bundle generation \d+ was rejected/i },
  { id: "missing-lua-provider", pattern: /global '_deherm_' \(a nil value\)|Lua module is not registered/i },
  { id: "component-runtime-unavailable", pattern: /component (?:backend )?runtime is unavailable/i },
]);

export function firstRejectedDiagnostic(transcript) {
  for (const diagnostic of REJECTED_DIAGNOSTICS) {
    const match = transcript.match(diagnostic.pattern);
    if (match) return { id: diagnostic.id, text: match[0].trim() };
  }
  return null;
}

export function observedRequiredMarkers(transcript, requiredMarkers = REQUIRED_MARKERS) {
  const lines = transcript.replaceAll("\r", "").split("\n");
  return requiredMarkers.map((marker) => lines.find((line) => line === marker) ?? null);
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

async function terminate(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { method: "already-exited", exitCode: child.exitCode, signal: child.signalCode };
  }
  if (!child.kill("SIGTERM")) throw new Error("Packaged runtime could not be sent SIGTERM");
  const graceful = await waitForExitAfterSignal(child, "sigterm", graceMs);
  if (graceful) return graceful;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { method: "sigterm", exitCode: child.exitCode, signal: child.signalCode };
  }
  if (!child.kill("SIGKILL")) throw new Error("Packaged runtime ignored SIGTERM and could not be sent SIGKILL");
  const forced = await waitForExitAfterSignal(child, "sigkill-after-timeout", graceMs);
  if (!forced) throw new Error("Packaged runtime did not report exit after SIGKILL");
  return forced;
}

export async function runPackagedRuntimeEvidence({
  command,
  args = [],
  cwd,
  env = process.env,
  requiredMarkers = REQUIRED_MARKERS,
  timeoutMs = 15_000,
  settleMs = 1_500,
  terminationGraceMs = 2_000,
}) {
  for (const [name, value] of Object.entries({ timeoutMs, settleMs, terminationGraceMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (settleMs >= timeoutMs) throw new Error("settleMs must be less than timeoutMs");
  if (!Array.isArray(requiredMarkers) || requiredMarkers.length === 0 || new Set(requiredMarkers).size !== requiredMarkers.length) {
    throw new Error("requiredMarkers must be a non-empty list of unique strings");
  }

  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    termination = await terminate(child, terminationGraceMs);
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
  const terminatedBySignal = termination.method === "sigterm" && termination.exitCode === null && termination.signal === "SIGTERM";
  const handledSigtermCleanly = termination.method === "sigterm" && termination.exitCode === 0 && termination.signal === null;
  if (!terminatedBySignal && !handledSigtermCleanly) {
    throw new Error(
      `Packaged runtime did not terminate from SIGTERM (method=${termination.method}, code=${termination.exitCode}, signal=${termination.signal}):\n${transcript}`,
    );
  }

  return {
    markers: observedRequiredMarkers(transcript, requiredMarkers),
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

export function buildEvidenceDocument({ artifacts, sourceInputs, markers, settleMs, termination, transcript }) {
  const artifactKey = digestEvidenceInputs(artifacts);
  const sourceKey = digestEvidenceInputs(sourceInputs);
  const transcriptRecord = transcript;
  if (!transcriptRecord || !Number.isSafeInteger(transcriptRecord.canonicalLineCount) || transcriptRecord.canonicalLineCount <= 0 ||
      !/^[0-9a-f]{64}$/.test(transcriptRecord.canonicalSha256)) {
    throw new Error("Transcript evidence must contain a positive canonical line count and SHA-256 digest");
  }
  const terminationIsSignal = termination?.method === "sigterm" && termination.exitCode === null && termination.signal === "SIGTERM";
  const terminationIsCleanExit = termination?.method === "sigterm" && termination.exitCode === 0 && termination.signal === null;
  if (!terminationIsSignal && !terminationIsCleanExit) throw new Error("Transcript evidence must record the observed SIGTERM exit result");
  const evidenceKey = createHash("sha256")
    .update(JSON.stringify({ artifactKey, sourceKey, transcript: transcriptRecord }))
    .digest("hex");
  return {
    schemaVersion: 2,
    scope: "war-battles-packaged-gui-typescript-dynamic-hermes",
    target: "arm64-macos",
    runtime: "dynamic-hermes",
    status: "observed-clean",
    claim: "The packaged War Battles GUI proxy attached its generated TypeScript component, loaded the bundle in Dynamic Hermes, completed its TypeScript GUI initialization, first render, and first update render through real Defold APIs, and remained free of rejected diagnostics for the bounded settling window.",
    exclusions: [
      "Static Hermes execution",
      "HTML5 browser-host execution",
      "all Defold component contexts or lifecycle combinations",
      "the complete generated script or dmSDK surface",
      "multiplayer transport execution",
    ],
    artifactKey,
    sourceKey,
    evidenceKey,
    artifacts,
    sourceInputs,
    observation: {
      requiredMarkers: markers,
      settleMs,
      rejectedDiagnosticIds: REJECTED_DIAGNOSTICS.map(({ id }) => id),
      termination,
      transcript: transcriptRecord,
    },
  };
}
