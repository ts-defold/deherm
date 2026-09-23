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

/**
 * Transport milestones emitted by the Deno adapter. The connection id makes
 * the trace useful when several handshakes are in flight at once, while the
 * URL is only available after the WebTransport upgrade.
 */
export type DenoWebTransportLifecyclePhase =
  | "incoming"
  | "quic-accepted"
  | "webtransport-upgraded"
  | "session-ready";

export interface DenoWebTransportLifecycleEvent {
  readonly phase: DenoWebTransportLifecyclePhase;
  readonly connectionId: number;
  readonly url?: string;
}

export interface DenoWebTransportServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly cert: string;
  readonly key: string;
  readonly maximumSessions?: number;
  readonly runtime?: DenoQuicRuntimeLike;
  /** Optional diagnostic hook. Exceptions are intentionally ignored. */
  readonly onLifecycle?: (event: DenoWebTransportLifecycleEvent) => void;
  /** Removes receiver/session bookkeeping when readiness fails before adoption. */
  readonly onSessionError?: (url: string, receiver: TransportReceiver) => void;
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
  private nextConnectionId = 1;
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
        const connectionId = this.nextConnectionId;
        this.nextConnectionId += 1;
        this.trace(options, { phase: "incoming", connectionId });
        if (this.activeSessions >= maximumSessions) {
          void this.rejectOne(runtime, incoming, options, connectionId);
          continue;
        }
        void this.acceptOne(runtime, incoming, options, connectionId);
      }
    } catch (error: unknown) {
      if (!this.stopped) options.onError(error);
    }
  }

  private async acceptOne(
    runtime: DenoQuicRuntimeLike,
    incoming: DenoQuicIncomingLike,
    options: DenoWebTransportServerOptions,
    connectionId: number,
  ): Promise<void> {
    this.activeSessions += 1;
    let counted = true;
    const releaseSession = (): void => {
      if (!counted) return;
      counted = false;
      this.activeSessions -= 1;
    };
    let session: (WebTransportSessionLike & { readonly url: string }) | undefined;
    let receiver: TransportReceiver | undefined;
    try {
      const connection = await incoming.accept();
      this.trace(options, { phase: "quic-accepted", connectionId });
      session = await runtime.upgradeWebTransport(connection);
      this.trace(options, { phase: "webtransport-upgraded", connectionId, url: session.url });
      const sessionReceiver = options.receiverForSession(session.url);
      receiver = sessionReceiver;
      const countedReceiver: TransportReceiver = {
        onReliable: (channel, payload) => sessionReceiver.onReliable(channel, payload),
        onDatagram: (payload) => sessionReceiver.onDatagram(payload),
        onClose: (code, reason) => {
          releaseSession();
          sessionReceiver.onClose(code, reason);
        },
      };
      const transport = await adoptServerWebTransportSession(session, countedReceiver);
      this.trace(options, { phase: "session-ready", connectionId, url: session.url });
      try {
        options.onSession(session.url, transport, receiver);
      } catch (error: unknown) {
        options.onError(error);
        transport.close(4_002, "session handler rejected connection");
      }
    } catch (error: unknown) {
      releaseSession();
      if (receiver !== undefined) {
        try {
          options.onSessionError?.(session?.url ?? "", receiver);
        } catch (callbackError: unknown) {
          options.onError(callbackError);
        }
        try {
          receiver.onClose(1, "session readiness failed");
        } catch (receiverError: unknown) {
          options.onError(receiverError);
        }
      }
      if (session !== undefined) {
        try {
          session.close({ closeCode: 4_006, reason: "session readiness failed" });
        } catch (closeError: unknown) {
          options.onError(closeError);
        }
      }
      options.onError(error);
    }
  }

  private async rejectOne(
    runtime: DenoQuicRuntimeLike,
    incoming: DenoQuicIncomingLike,
    options: DenoWebTransportServerOptions,
    connectionId: number,
  ): Promise<void> {
    let session: (WebTransportSessionLike & { readonly url: string }) | undefined;
    let closeAttempted = false;
    const closeSession = (closeCode: number, reason: string): void => {
      if (session === undefined || closeAttempted) return;
      closeAttempted = true;
      try {
        session.close({ closeCode, reason });
      } catch (error: unknown) {
        options.onError(error);
      }
    };
    try {
      const connection = await incoming.accept();
      this.trace(options, { phase: "quic-accepted", connectionId });
      session = await runtime.upgradeWebTransport(connection);
      this.trace(options, { phase: "webtransport-upgraded", connectionId, url: session.url });
      await session.ready;
      closeSession(4_001, "server session limit reached");
    } catch (error: unknown) {
      closeSession(4_006, "session readiness failed");
      options.onError(error);
    }
  }

  private trace(options: DenoWebTransportServerOptions, event: DenoWebTransportLifecycleEvent): void {
    try {
      options.onLifecycle?.(event);
    } catch {
      // Diagnostics must never prevent a connection from being accepted.
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
