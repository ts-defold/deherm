// Graceful shutdown of one packaged Defold engine, addressed by identity.
//
// SIGTERM and SIGINT tear the process down without running a single component
// `final()`, so a signal can never exercise teardown. The only way in is the
// engine service: `POST /post/@system/exit` posts a `system_ddf.Exit` message
// into the running engine, which then shuts down the way a game does.
//
// That service is an HTTP server on a port, and a port is not an engine. Defold
// sets `SO_REUSEADDR`/`SO_REUSEPORT` on every listening socket
// (`dlib/socket_posix.cpp`), so two engines started from the same default
// configuration both bind the default service port and the kernel hands an
// incoming connection to whichever it likes. An exit post aimed at "the engine
// on port 8001" can therefore be absorbed by a stray engine while the one under
// observation keeps running, and the census it was supposed to produce comes
// back UNOBSERVED with nothing to say why.
//
// Two mechanisms, both required:
//
//   * the engine under observation is started with `DM_SERVICE_PORT=dynamic`,
//     so the kernel assigns it a port nobody else asked for, and the port is
//     read back out of *that child's own* transcript rather than assumed;
//   * before anything is posted, the listeners on that port are enumerated and
//     the set must be exactly the engine's own process. A second listener is a
//     hard failure that names both processes, never a silent post into one of
//     them.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Defold logs its engine-service port once, at startup, before any game code. */
const ENGINE_SERVICE_PORT = /^INFO:ENGINE: Engine service started on port (\d+)$/m;

/** Environment that gives one engine a service port of its own. */
export const DYNAMIC_SERVICE_PORT_ENV = Object.freeze({ DM_SERVICE_PORT: "dynamic" });

/**
 * The engine service port this transcript reports, or null while the line has
 * not been printed yet. `dynamic` resolves to a kernel-assigned port, so this
 * is the only authority for which port belongs to this process.
 */
export function engineServicePort(transcript) {
  const match = ENGINE_SERVICE_PORT.exec(String(transcript).replaceAll("\r", ""));
  if (!match) return null;
  const port = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Engine service reported an unusable port: ${match[1]}`);
  }
  return port;
}

/**
 * Every process listening on a TCP port, as a sorted set of pids. `lsof` exits
 * 1 with no output when nothing matches, which is an empty set rather than an
 * error; anything else is reported, because a census that cannot be taken must
 * not be mistaken for a census that found one listener.
 */
export async function listeningPids(port, { execFile: exec = execFileAsync } = {}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`port must be a TCP port number, got ${port}`);
  }
  let stdout = "";
  try {
    ({ stdout } = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "lsof is required to prove which process owns the engine service port; " +
        "without it an exit post cannot be shown to have reached the engine under observation");
    }
    // `lsof -t` exits 1 when the filter matches nothing and prints nothing.
    if (error?.code === 1 && !String(error.stdout ?? "").trim()) return [];
    throw error;
  }
  const pids = new Set();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(pid)) throw new Error(`lsof reported an unparsable pid: ${trimmed}`);
    pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

/**
 * Refuse to address a port that more than one process is listening on, and
 * refuse to address one that the engine under observation is not listening on.
 * Both are loud: the whole point is that the failure mode this replaces was
 * silent.
 */
export function assertSoleEngineListener({ port, pid, pids }) {
  if (pids.length === 0) {
    throw new Error(
      `No process is listening on engine service port ${port}; the engine under observation ` +
      `(pid ${pid}) reported it but is not serving it`);
  }
  if (pids.length > 1 || pids[0] !== pid) {
    throw new Error(
      `Engine service port ${port} is shared by ${pids.length} process(es) [${pids.join(", ")}] ` +
      `but the engine under observation is pid ${pid}. Defold sets SO_REUSEPORT on its listening ` +
      "sockets, so an exit post to this port could be absorbed by another engine. Stop the other " +
      "dmengine process(es) and re-run; this gate will not post into an engine it cannot name.");
  }
  return { port, pid };
}

/**
 * `system_ddf.Exit` carries one required int32 field. Protobuf field 1,
 * wire type 0: tag `0x08` then a varint. Non-negative codes only, which is
 * every code an exit probe has reason to send.
 */
export function encodeSystemExit(code = 0) {
  if (!Number.isSafeInteger(code) || code < 0 || code > 0x7fffffff) {
    throw new Error(`exit code must be a non-negative int32, got ${code}`);
  }
  const bytes = [0x08];
  let value = code;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

/**
 * Post the exit message to one named engine. The caller has already proven the
 * port belongs to that engine; this only sends and reports the HTTP result.
 */
export async function postSystemExit({ port, code = 0, timeoutMs = 2_000, fetch: fetchImpl = globalThis.fetch }) {
  const url = `http://127.0.0.1:${port}/post/@system/exit`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: encodeSystemExit(code),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Engine service refused the exit post: ${response.status} ${response.statusText}`);
  }
  return { url, status: response.status };
}

/**
 * The whole probe: resolve the port from this engine's own transcript, prove it
 * is the only listener, and post. Returns what was addressed so the caller can
 * record it as part of the observation.
 */
export async function requestGracefulShutdown({
  transcript,
  pid,
  code = 0,
  timeoutMs = 2_000,
  execFile: exec = execFileAsync,
  fetch: fetchImpl = globalThis.fetch
}) {
  const port = engineServicePort(transcript);
  if (port === null) {
    throw new Error(
      "The engine never reported an engine service port, so a graceful shutdown cannot be addressed. " +
      "Start it with DM_SERVICE_PORT=dynamic and keep its stdout.");
  }
  const pids = await listeningPids(port, { execFile: exec });
  assertSoleEngineListener({ port, pid, pids });
  const posted = await postSystemExit({ port, code, timeoutMs, fetch: fetchImpl });
  return { method: "system-exit", port, pid, code, status: posted.status };
}
