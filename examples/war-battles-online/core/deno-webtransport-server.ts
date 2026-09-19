import {
  adoptServerWebTransportSession,
  type WebTransportSessionLike,
} from "./browser-webtransport.ts";
import type { GameTransport, TransportReceiver } from "./transport.ts";

export interface DenoQuicIncomingLike {
  accept(): Promise<unknown>;
}

export interface DenoQuicListenerLike extends AsyncIterable<DenoQuicIncomingLike> {}

export interface DenoQuicEndpointLike {
  listen(options: { cert: string; key: string; alpnProtocols: readonly string[] }): DenoQuicListenerLike;
  close(): void;
}

export interface DenoQuicRuntimeLike {
  readonly QuicEndpoint: new(options: { hostname: string; port: number }) => DenoQuicEndpointLike;
  upgradeWebTransport(connection: unknown): Promise<WebTransportSessionLike & { readonly url: string }>;
}

export interface DenoWebTransportServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly cert: string;
  readonly key: string;
  readonly maximumSessions?: number;
  readonly runtime?: DenoQuicRuntimeLike;
  readonly receiverForSession: (url: string) => TransportReceiver;
  /**
   * Called once the session is adopted. The receiver this connection was built
   * with is handed back rather than looked up by url: several clients reach the
   * same endpoint url, and the adoption between the two callbacks awaits, so a
   * url is not an identity a caller could correlate on.
   */
  readonly onSession: (url: string, transport: GameTransport, receiver: TransportReceiver) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Thin adapter over Deno's unstable QUIC/WebTransport server API. Authentication
 * and room admission must finish on the reliable session lane before gameplay
 * input is accepted. This module is typechecked in Node but needs Deno
 * --unstable-net, --allow-net, and externally supplied TLS material to execute.
 */
export class DenoWebTransportServer {
  readonly completed: Promise<void>;
  private activeSessions = 0;
  private stopped = false;
  private readonly endpoint: DenoQuicEndpointLike;

  private constructor(
    endpoint: DenoQuicEndpointLike,
    listener: DenoQuicListenerLike,
    runtime: DenoQuicRuntimeLike,
    options: DenoWebTransportServerOptions,
    maximumSessions: number,
  ) {
    this.endpoint = endpoint;
    this.completed = this.run(listener, runtime, options, maximumSessions);
  }

  static start(options: DenoWebTransportServerOptions): DenoWebTransportServer {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new RangeError("QUIC port must be in [1, 65535]");
    }
    const maximumSessions = options.maximumSessions ?? 32;
    if (!Number.isInteger(maximumSessions) || maximumSessions < 1) {
      throw new RangeError("maximumSessions must be a positive integer");
    }
    const runtime = options.runtime ?? denoQuicRuntime();
    const endpoint = new runtime.QuicEndpoint({ hostname: options.hostname, port: options.port });
    const listener = endpoint.listen({ cert: options.cert, key: options.key, alpnProtocols: ["h3"] });
    return new DenoWebTransportServer(endpoint, listener, runtime, options, maximumSessions);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.endpoint.close();
  }

  private async run(
    listener: DenoQuicListenerLike,
    runtime: DenoQuicRuntimeLike,
    options: DenoWebTransportServerOptions,
    maximumSessions: number,
  ): Promise<void> {
    try {
      for await (const incoming of listener) {
        if (this.stopped) break;
        if (this.activeSessions >= maximumSessions) {
          void this.rejectOne(runtime, incoming, options.onError);
          continue;
        }
        void this.acceptOne(runtime, incoming, options);
      }
    } catch (error: unknown) {
      if (!this.stopped) options.onError(error);
    }
  }

  private async acceptOne(
    runtime: DenoQuicRuntimeLike,
    incoming: DenoQuicIncomingLike,
    options: DenoWebTransportServerOptions,
  ): Promise<void> {
    this.activeSessions += 1;
    let counted = true;
    const releaseSession = (): void => {
      if (!counted) return;
      counted = false;
      this.activeSessions -= 1;
    };
    try {
      const connection = await incoming.accept();
      const session = await runtime.upgradeWebTransport(connection);
      const receiver = options.receiverForSession(session.url);
      const countedReceiver: TransportReceiver = {
        onReliable: (channel, payload) => receiver.onReliable(channel, payload),
        onDatagram: (payload) => receiver.onDatagram(payload),
        onClose: (code, reason) => {
          releaseSession();
          receiver.onClose(code, reason);
        },
      };
      const transport = await adoptServerWebTransportSession(session, countedReceiver);
      try {
        options.onSession(session.url, transport, receiver);
      } catch (error: unknown) {
        options.onError(error);
        transport.close(4_002, "session handler rejected connection");
      }
    } catch (error: unknown) {
      releaseSession();
      options.onError(error);
    }
  }

  private async rejectOne(
    runtime: DenoQuicRuntimeLike,
    incoming: DenoQuicIncomingLike,
    onError: (error: unknown) => void,
  ): Promise<void> {
    try {
      const connection = await incoming.accept();
      const session = await runtime.upgradeWebTransport(connection);
      await session.ready;
      session.close({ closeCode: 4_001, reason: "server session limit reached" });
    } catch (error: unknown) {
      onError(error);
    }
  }
}

function denoQuicRuntime(): DenoQuicRuntimeLike {
  const runtime = (globalThis as typeof globalThis & { Deno?: DenoQuicRuntimeLike }).Deno;
  if (runtime?.QuicEndpoint === undefined || runtime.upgradeWebTransport === undefined) {
    throw new Error("Deno unstable QUIC/WebTransport APIs are unavailable");
  }
  return runtime;
}
