import { BrowserWebSocketClient, type WebSocketLike } from "./browser-websocket.ts";
import type { GameTransport, TransportReceiver } from "./transport.ts";

export interface DenoWebSocketRuntimeLike {
  upgradeWebSocket(request: Request): { socket: WebSocketLike; response: Response };
}

export interface DenoWebSocketUpgradeOptions {
  readonly runtime?: DenoWebSocketRuntimeLike;
  readonly receiver: TransportReceiver;
  readonly onSession: (transport: GameTransport) => void;
}

/**
 * Small seam for the Deno health/control listener. The TCP listener remains
 * ordinary HTTP for health checks, while `/ws` upgrades to the same
 * GameTransport contract. Reliable control/session/snapshot frames are
 * preserved; tick input is intentionally handled by channel 4 because TCP
 * WebSocket has no datagram equivalent.
 */
export function acceptDenoWebSocket(request: Request, options: DenoWebSocketUpgradeOptions): Response {
  const runtime = options.runtime ?? denoWebSocketRuntime();
  const upgraded = runtime.upgradeWebSocket(request);
  const transport = BrowserWebSocketClient.adopt(upgraded.socket, options.receiver);
  const open = (): void => {
    try {
      options.onSession(transport);
    } catch (error: unknown) {
      transport.close(4_002, error instanceof Error ? error.message : "session handler rejected connection");
    }
  };
  if (upgraded.socket.readyState === 1) open();
  else upgraded.socket.addEventListener("open", open);
  return upgraded.response;
}

function denoWebSocketRuntime(): DenoWebSocketRuntimeLike {
  const runtime = (globalThis as typeof globalThis & { Deno?: DenoWebSocketRuntimeLike }).Deno;
  if (runtime?.upgradeWebSocket === undefined) throw new Error("Deno WebSocket upgrade API is unavailable");
  return runtime;
}
