// A runnable dedicated server.
//
//   deno run --unstable-net --allow-net --allow-read \
//     examples/war-battles-online/server/deno-main.ts \
//     --cert server/certs/localhost.crt --key server/certs/localhost.key
//
// It terminates HTTP/3 with Deno's unstable QUIC endpoint, adopts each accepted
// WebTransport session through the same `GameTransport` boundary the in-memory
// tests use, and runs one authoritative `MatchServer` at 60 Hz. Nothing about
// the match is Deno-specific: swapping this file for a Quinn or Colyseus host
// changes the first twenty lines and nothing below them.
//
// TLS. A browser will only open a WebTransport session to a certificate it
// trusts, or to one whose SHA-256 you hand it in `serverCertificateHashes`. The
// second option needs an ECDSA P-256 certificate valid for at most 14 days;
// `server/make-cert.sh` produces exactly that, and this server prints the digest
// to paste into the client. See `server/README.md`.

import {
  MatchServer,
  DurableSessionPersistence,
  SessionLedger,
  TICK_RATE,
  TICK_MILLISECONDS,
  type MatchServerOptions,
} from "../core/index.ts";
import {
  DenoWebTransportServer,
  type DenoWebTransportLifecycleEvent,
} from "../core/deno-webtransport-server.ts";
import { acceptDenoWebSocket } from "../core/deno-websocket-server.ts";
import { DenoDurableSessionFile } from "./durable-session-file.ts";
import type { GameTransport, TransportReceiver } from "../core/transport.ts";
import type { ServerSession } from "../core/match-server.ts";

/**
 * The slice of Deno this entry point uses directly. Declared rather than
 * imported so the file typechecks under Node with the rest of the example; the
 * QUIC surface itself is described by `DenoQuicRuntimeLike` in `core/`.
 */
declare const Deno: {
  readTextFile(path: string): Promise<string>;
  env: { get(name: string): string | undefined };
  args: string[];
  serve(
    options: { hostname: string; port: number },
    handler: (request: Request) => Response,
  ): { shutdown(): Promise<void> };
  exit(code?: number): never;
  addSignalListener(signal: string, handler: () => void): void;
};

interface Options extends MatchServerOptions {
  hostname: string;
  port: number;
  healthPort: number;
  certPath: string;
  keyPath: string;
  resumeKeyText?: string;
  resumeKeyPath?: string;
  sessionStatePath?: string;
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    hostname: "0.0.0.0",
    port: 4433,
    healthPort: 8080,
    certPath: "server/certs/localhost.crt",
    keyPath: "server/certs/localhost.key",
    rosterSize: 8,
    botSkill: 2,
    snapshotIntervalTicks: 3,
    teams: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (argument === "--hostname") { options.hostname = required(value, argument); index += 1; }
    else if (argument === "--port") { options.port = integer(value, argument); index += 1; }
    else if (argument === "--health-port") { options.healthPort = integer(value, argument); index += 1; }
    else if (argument === "--cert") { options.certPath = required(value, argument); index += 1; }
    else if (argument === "--key") { options.keyPath = required(value, argument); index += 1; }
    else if (argument === "--roster") { (options as { rosterSize: number }).rosterSize = integer(value, argument); index += 1; }
    else if (argument === "--bot-skill") { (options as { botSkill: number }).botSkill = integer(value, argument); index += 1; }
    else if (argument === "--snapshot-interval") { (options as { snapshotIntervalTicks: number }).snapshotIntervalTicks = integer(value, argument); index += 1; }
    else if (argument === "--teams") { (options as { teams: boolean }).teams = true; }
    else if (argument === "--resume-key") { options.resumeKeyText = required(value, argument); index += 1; }
    else if (argument === "--resume-key-file") { options.resumeKeyPath = required(value, argument); index += 1; }
    else if (argument === "--session-state") { options.sessionStatePath = required(value, argument); index += 1; }
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function hexSecret(text: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error("--resume-key/WAR_BATTLES_RESUME_KEY must be exactly 64 hexadecimal characters");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function configuredResumeKey(text: string | undefined, statePath: string | undefined): Uint8Array | undefined {
  if (statePath !== undefined && text === undefined) {
    throw new Error("a durable session state path requires --resume-key or WAR_BATTLES_RESUME_KEY");
  }
  return text === undefined ? undefined : hexSecret(text);
}

/**
 * Persistence is an admission prerequisite, not merely a health signal. Once
 * a write fails, callers must stop creating new sessions until a later write
 * has completed successfully.
 */
export interface SessionAdmissionGate {
  readonly allowed: boolean;
  fail(): void;
  recover(): void;
}

export function createSessionAdmissionGate(initiallyAllowed = true): SessionAdmissionGate {
  let allowed = initiallyAllowed;
  return {
    get allowed(): boolean { return allowed; },
    fail(): void { allowed = false; },
    recover(): void { allowed = true; },
  };
}

/** Creates a session only while the persistence admission gate is open. */
export function admitNewSession<T>(admission: SessionAdmissionGate, create: () => T): T | undefined {
  return admission.allowed ? create() : undefined;
}

function required(value: string | undefined, option: string): string {
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function integer(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isInteger(parsed)) throw new Error(`${option} requires an integer`);
  return parsed;
}

/** SHA-256 of the certificate's DER body, which is what a browser matches on. */
async function certificateDigest(pem: string): Promise<string> {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function logTransportLifecycle(event: DenoWebTransportLifecycleEvent): void {
  const detail = event.url === undefined
    ? `id=${event.connectionId}`
    : `id=${event.connectionId}:url=${event.url}`;
  console.log(`war-battles-server:${event.phase}:${detail}`);
}

const rejectedReceiver: TransportReceiver = {
  onReliable: () => {},
  onDatagram: () => {},
  onClose: () => {},
};

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  const statePath = options.sessionStatePath ?? Deno.env.get("WAR_BATTLES_SESSION_STATE");
  const resumeKeyPath = options.resumeKeyPath ?? Deno.env.get("WAR_BATTLES_RESUME_KEY_FILE");
  let configuredResumeKeyText = options.resumeKeyText ?? Deno.env.get("WAR_BATTLES_RESUME_KEY");
  if (configuredResumeKeyText !== undefined && resumeKeyPath !== undefined) {
    throw new Error("configure only one of resume-key and resume-key-file");
  }
  if (resumeKeyPath !== undefined) configuredResumeKeyText = (await Deno.readTextFile(resumeKeyPath)).trim();
  const resumeKey = configuredResumeKey(configuredResumeKeyText, statePath);
  const matchId = options.matchId ?? 77;
  const rosterSize = options.rosterSize ?? 8;
  let ready = true;
  let stopping = false;
  const admission = createSessionAdmissionGate(true);
  const ledger = new SessionLedger({
    matchId,
    rosterSize,
    restartReservationTicks: options.resumeGraceTicks ?? TICK_RATE * 30,
  });
  const persistence = statePath === undefined ? undefined : new DurableSessionPersistence(ledger, new DenoDurableSessionFile(statePath));
  if (persistence !== undefined) {
    await persistence.restore();
    console.log(`war-battles-server:session-state:${statePath}`);
  }
  const cert = await Deno.readTextFile(options.certPath);
  const key = await Deno.readTextFile(options.keyPath);
  const digest = await certificateDigest(cert);

  const server = new MatchServer({
    matchId,
    rosterSize,
    botSkill: options.botSkill,
    snapshotIntervalTicks: options.snapshotIntervalTicks,
    teams: options.teams,
    resumeKey,
    sessionLedger: ledger,
    onSessionStateChange: (_reason, tick) => {
      if (persistence === undefined) return;
      void persistence.flush(tick).then(() => {
        admission.recover();
        if (!stopping) ready = true;
      }).catch((error: unknown) => {
        console.error("war-battles-server:session-state-write-error:", error);
        admission.fail();
        ready = false;
      });
    },
    onError: (error: unknown) => console.error("war-battles-server:error:", error),
    onLog: (line: string) => console.log(`war-battles-server:${line}`),
  });

  const pending = new Map<TransportReceiver, ServerSession>();
  const listener = DenoWebTransportServer.start({
    hostname: options.hostname,
    port: options.port,
    cert,
    key,
    maximumSessions: 32,
    onLifecycle: logTransportLifecycle,
    receiverForSession: (): TransportReceiver => {
      // The adapter still needs a receiver to finish and close an already
      // upgraded QUIC session, but it must never allocate a MatchServer
      // session while durable admission is unhealthy.
      const session = admitNewSession(admission, () => server.createSession());
      if (session === undefined) return rejectedReceiver;
      pending.set(session, session);
      return session;
    },
    onSessionError: (_url: string, receiver: TransportReceiver): void => {
      pending.delete(receiver);
    },
    onSession: (url: string, transport: GameTransport, receiver: TransportReceiver): void => {
      const session = pending.get(receiver);
      pending.delete(receiver);
      if (session === undefined) {
        transport.close(4_005, "unknown session");
        return;
      }
      session.attach(transport);
      console.log(`war-battles-server:session-accepted:${url}`);
    },
    onError: (error: unknown) => console.error("war-battles-server:transport-error:", error),
  });

  // Keep readiness on a plain loopback-friendly HTTP control port. It is
  // deliberately separate from the HTTP/3/WebTransport endpoint: a Docker
  // healthcheck can verify the process without pretending that TCP is the
  // gameplay transport. The response includes MatchServer.stats so an
  // integration gate can observe authoritative admissions and input handling.
  void listener.completed.then(() => {
    if (!ready) return;
    ready = false;
    admission.fail();
    console.error("war-battles-server:listener-stopped-unexpectedly");
  });
  let activeWebSocketSessions = 0;
  const healthServer = Deno.serve({ hostname: options.hostname, port: options.healthPort }, (request: Request): Response => {
    const path = new URL(request.url).pathname;
    if (path === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (stopping || !ready || !admission.allowed) {
        return new Response("server is not accepting sessions\n", { status: 503 });
      }
      if (activeWebSocketSessions >= 32) {
        return new Response("websocket session limit reached\n", { status: 503 });
      }
      const session = admitNewSession(admission, () => server.createSession());
      if (session === undefined) {
        return new Response("session persistence is unavailable\n", { status: 503 });
      }
      activeWebSocketSessions += 1;
      let counted = true;
      const receiver: TransportReceiver = {
        onReliable: (channel, payload) => session.onReliable(channel, payload),
        onDatagram: (payload) => session.onDatagram(payload),
        onClose: (code, reason) => {
          if (counted) {
            counted = false;
            activeWebSocketSessions -= 1;
            session.onClose(code, reason);
          }
        },
      };
      try {
        return acceptDenoWebSocket(request, {
          receiver,
          onSession: (transport) => {
            session.attach(transport);
            console.log("war-battles-server:session-accepted:websocket-tcp");
          },
        });
      } catch (error: unknown) {
        if (counted) {
          counted = false;
          activeWebSocketSessions -= 1;
        }
        session.onClose(1_006, "websocket upgrade failed");
        console.error("war-battles-server:websocket-upgrade-error:", error);
        return new Response("websocket upgrade failed\n", { status: 500 });
      }
    }
    if (path !== "/healthz" && path !== "/readyz" && path !== "/health") {
      return new Response("not found\n", { status: 404 });
    }
    const payload = {
      ok: path === "/healthz" || ready,
      ready,
      transport: "webtransport-h3",
      websocketFallback: "websocket-tcp",
      endpoint: `https://${options.hostname}:${options.port}`,
      certificateSha256: digest,
      rosterSize: options.rosterSize,
      stats: server.stats,
    };
    return new Response(JSON.stringify(payload) + "\n", {
      status: payload.ok ? 200 : 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  });

  console.log(`war-battles-server:listening:https://${options.hostname}:${options.port}`);
  console.log(`war-battles-server:health:http://${options.hostname}:${options.healthPort}`);
  console.log(`war-battles-server:certificate-sha256:${digest}`);
  console.log(`war-battles-server:roster:${options.rosterSize}:bots:${options.botSkill}`);

  // A fixed-step loop driven by wall clock, so a slow tick does not make the
  // match run slow: it makes the next wake-up do more.
  let previous = Date.now();
  // Keep the runtime proof bounded and machine-readable. This is deliberately
  // derived from MatchServer.stats rather than from a client-side write result:
  // the real gate must observe that the authoritative server accepted input.
  const inputMilestone = 3;
  let inputMilestoneLogged = false;
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - previous;
    previous = now;
    server.advance(elapsed, 8);
    if (!inputMilestoneLogged && server.stats.inputsAccepted >= inputMilestone) {
      inputMilestoneLogged = true;
      console.log(`war-battles-server:stats:inputs-accepted:count=${inputMilestone}`);
    }
  }, TICK_MILLISECONDS);

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    ready = false;
    admission.fail();
    clearInterval(timer);
    server.close(1_001, "server shutting down");
    void (persistence?.flush(server.sessionTick()) ?? Promise.resolve()).then(() => listener.close()).then(() => healthServer.shutdown()).then(() => {
      console.log("war-battles-server:stopped");
      Deno.exit(0);
    }).catch((error: unknown) => {
      console.error("war-battles-server:shutdown-error:", error);
      Deno.exit(1);
    });
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  await listener.completed;
}

// `import.meta.main` is Deno's entry-point flag; under Node this file is only
// ever imported for typechecking, where it is undefined.
if ((import.meta as { main?: boolean }).main === true) {
  await main(Deno.args);
}
