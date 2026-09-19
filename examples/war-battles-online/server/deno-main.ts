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
  TICK_MILLISECONDS,
  type MatchServerOptions,
} from "../core/index.ts";
import { DenoWebTransportServer } from "../core/deno-webtransport-server.ts";
import type { GameTransport, TransportReceiver } from "../core/transport.ts";
import type { ServerSession } from "../core/match-server.ts";

/**
 * The slice of Deno this entry point uses directly. Declared rather than
 * imported so the file typechecks under Node with the rest of the example; the
 * QUIC surface itself is described by `DenoQuicRuntimeLike` in `core/`.
 */
declare const Deno: {
  readTextFile(path: string): Promise<string>;
  args: string[];
  exit(code?: number): never;
  addSignalListener(signal: string, handler: () => void): void;
};

interface Options extends MatchServerOptions {
  hostname: string;
  port: number;
  certPath: string;
  keyPath: string;
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    hostname: "0.0.0.0",
    port: 4433,
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
    else if (argument === "--cert") { options.certPath = required(value, argument); index += 1; }
    else if (argument === "--key") { options.keyPath = required(value, argument); index += 1; }
    else if (argument === "--roster") { (options as { rosterSize: number }).rosterSize = integer(value, argument); index += 1; }
    else if (argument === "--bot-skill") { (options as { botSkill: number }).botSkill = integer(value, argument); index += 1; }
    else if (argument === "--snapshot-interval") { (options as { snapshotIntervalTicks: number }).snapshotIntervalTicks = integer(value, argument); index += 1; }
    else if (argument === "--teams") { (options as { teams: boolean }).teams = true; }
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
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

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  const cert = await Deno.readTextFile(options.certPath);
  const key = await Deno.readTextFile(options.keyPath);
  const digest = await certificateDigest(cert);

  const server = new MatchServer({
    rosterSize: options.rosterSize,
    botSkill: options.botSkill,
    snapshotIntervalTicks: options.snapshotIntervalTicks,
    teams: options.teams,
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
    receiverForSession: (): TransportReceiver => {
      const session = server.createSession();
      pending.set(session, session);
      return session;
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

  console.log(`war-battles-server:listening:https://${options.hostname}:${options.port}`);
  console.log(`war-battles-server:certificate-sha256:${digest}`);
  console.log(`war-battles-server:roster:${options.rosterSize}:bots:${options.botSkill}`);

  // A fixed-step loop driven by wall clock, so a slow tick does not make the
  // match run slow: it makes the next wake-up do more.
  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - previous;
    previous = now;
    server.advance(elapsed, 8);
  }, TICK_MILLISECONDS);

  const stop = (): void => {
    clearInterval(timer);
    server.close(1_001, "server shutting down");
    listener.close();
    console.log("war-battles-server:stopped");
    Deno.exit(0);
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
