import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";

import { connectCdp } from "./browser-host.mjs";
import { defaultInspectorSessionFile, readInspectorSession } from "./inspector-session.mjs";

function timestampName() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function defaultOutput(projectRoot, kind) {
  const extension = kind === "cpu" ? "cpuprofile" : "heapsnapshot";
  return path.join(projectRoot, ".deherm", "profiles", `${kind}-${timestampName()}.${extension}`);
}

async function atomicJson(file, value) {
  const destination = path.resolve(file);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function discoverTarget(sessionFile, projectRoot, replaceDebugger) {
  const session = await readInspectorSession(sessionFile);
  if (path.resolve(session.projectRoot) !== path.resolve(projectRoot)) {
    throw new Error(`Inspector session belongs to a different project: ${session.projectRoot}`);
  }
  let response;
  try {
    response = await fetch(`${session.devtoolsUrl}/json/list`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`Inspector session ${session.sessionId} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Inspector discovery failed with HTTP ${response.status}`);
  const targets = await response.json();
  const target = Array.isArray(targets) ? targets.find((candidate) => candidate?.id === "deherm") : undefined;
  if (!target?.webSocketDebuggerUrl) throw new Error("Inspector discovery did not return the déherm runtime target");
  if (target.webSocketDebuggerUrl !== session.websocketUrl) {
    throw new Error("Inspector discovery URL does not match the authenticated session descriptor");
  }
  if (target.attached && !replaceDebugger) {
    throw new Error("A debugger frontend is already attached; detach it or pass --replace-debugger to capture a profile");
  }
  return { session, target };
}

export async function captureCpuProfile(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const sessionFile = path.resolve(options.sessionFile ?? defaultInspectorSessionFile(projectRoot));
  const durationMs = options.durationMs ?? 10_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
    throw new Error("CPU profile duration must be an integer from 1 through 86400000 milliseconds");
  }
  const { session, target } = await discoverTarget(sessionFile, projectRoot, options.replaceDebugger === true);
  const websocketUrl = new URL(target.webSocketDebuggerUrl);
  if (options.replaceDebugger === true) websocketUrl.searchParams.set("replace", "1");
  const client = await connectCdp(websocketUrl.href, { retain: false });
  try {
    await client.send("Profiler.start", {}, { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const result = await client.send("Profiler.stop", {}, { timeoutMs: 30_000 });
    if (!result?.profile || !Array.isArray(result.profile.nodes)) {
      throw new Error("Hermes returned no valid CPU profile");
    }
    const output = await atomicJson(options.output ?? defaultOutput(projectRoot, "cpu"), result.profile);
    return {
      kind: "cpu",
      output,
      durationMs,
      sessionId: session.sessionId,
      nodeCount: result.profile.nodes.length,
      sampleCount: result.profile.samples?.length ?? 0
    };
  } finally {
    await client.close();
  }
}

export async function captureHeapSnapshot(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const sessionFile = path.resolve(options.sessionFile ?? defaultInspectorSessionFile(projectRoot));
  const { session, target } = await discoverTarget(sessionFile, projectRoot, options.replaceDebugger === true);
  const destination = path.resolve(options.output ?? defaultOutput(projectRoot, "heap"));
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const websocketUrl = new URL(target.webSocketDebuggerUrl);
  if (options.replaceDebugger === true) websocketUrl.searchParams.set("replace", "1");
  const client = await connectCdp(websocketUrl.href, { retain: false });
  let handle;
  let writes = Promise.resolve();
  let chunkCount = 0;
  let bytes = 0;
  let writeFailure;
  let unsubscribe = () => {};
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    handle = await open(temporary, "wx", 0o600);
    unsubscribe = client.onEvent("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => {
      if (typeof chunk !== "string" || writeFailure) return;
      chunkCount += 1;
      bytes += Buffer.byteLength(chunk);
      writes = writes.then(() => handle.write(chunk)).catch((error) => { writeFailure = error; });
    });
    await client.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: true,
      captureNumericValue: true
    }, { timeoutMs: options.timeoutMs ?? 120_000 });
    await writes;
    if (writeFailure) throw writeFailure;
    if (!chunkCount || !bytes) throw new Error("Hermes returned an empty heap snapshot");
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
    return { kind: "heap", output: destination, sessionId: session.sessionId, chunkCount, bytes };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  } finally {
    unsubscribe();
    await client.close();
  }
}
