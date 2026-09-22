import http from "node:http";
import net from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import {
  createInspectorSession,
  removeOwnedInspectorSession,
  writeInspectorSession
} from "./inspector-session.mjs";

const maximumMessageBytes = 4 * 1024 * 1024;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Bridge the engine's deliberately tiny newline-delimited CDP socket to a
 * standard loopback WebSocket/discovery endpoint understood by Chrome and
 * VS Code. The engine never parses HTTP or WebSocket framing on its frame
 * thread; the Node development control plane owns that cold-path protocol.
 */
export async function createInspectorBridge(options = {}) {
  const emit = options.emit ?? (() => {});
  let engineSocket;
  let frontendSocket;
  let resettingEngine = false;
  let pendingFrontendBytes = 0;
  let pendingFrontendCommands = [];
  let closing = false;

  const log = (message, level = "info") => emit({ type: "log", source: "inspector", level, message });

  const engineServer = net.createServer((socket) => {
    if (engineSocket) engineSocket.destroy();
    engineSocket = socket;
    resettingEngine = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    let pending = Buffer.alloc(0);
    log("native Hermes inspector connected");
    for (const command of pendingFrontendCommands) socket.write(command);
    pendingFrontendCommands = [];
    pendingFrontendBytes = 0;
    socket.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length > maximumMessageBytes) {
        log(`engine inspector frame exceeded ${maximumMessageBytes} bytes`, "error");
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const message = pending.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
        pending = pending.subarray(newline + 1);
        if (message && frontendSocket?.readyState === WebSocket.OPEN) frontendSocket.send(message);
      }
    });
    socket.on("error", (error) => {
      if (!closing) log(`native inspector transport error: ${error.message}`, "warn");
    });
    socket.on("close", () => {
      if (engineSocket === socket) engineSocket = undefined;
      if (!closing) log("native Hermes inspector disconnected", "warn");
    });
  });
  const engineAddress = await listen(engineServer, options.enginePort ?? 0);

  let devtoolsPort = 0;
  const target = () => {
    const websocket = `ws://127.0.0.1:${devtoolsPort}/devtools/page/deherm`;
    return {
      id: "deherm",
      type: "node",
      title: options.title ?? "déherm / Defold",
      description: "Hermes CDP runtime inside Defold",
      url: "deherm://runtime",
      attached: frontendSocket?.readyState === WebSocket.OPEN,
      webSocketDebuggerUrl: websocket,
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${devtoolsPort}/devtools/page/deherm`
    };
  };
  const httpServer = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let body;
    if (pathname === "/json" || pathname === "/json/list") body = JSON.stringify([target()]);
    else if (pathname === "/json/version") body = JSON.stringify({
      Browser: "déherm/Hermes",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: target().webSocketDebuggerUrl
    });
    else {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: maximumMessageBytes });
  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/devtools/page/deherm") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request));
  });
  websocketServer.on("connection", (socket, request) => {
    const replace = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("replace") === "1";
    if (frontendSocket?.readyState === WebSocket.OPEN && !replace) {
      socket.close(1013, "a debugger frontend is already attached");
      return;
    }
    if (frontendSocket) {
      frontendSocket.close(1012, "replaced by an explicitly authorized debugger client");
      resettingEngine = true;
      engineSocket?.destroy();
    }
    frontendSocket = socket;
    log("CDP frontend attached");
    socket.on("message", (data, binary) => {
      if (binary) {
        socket.close(1003, "CDP commands must be UTF-8 JSON text");
        return;
      }
      const message = data.toString("utf8");
      if (!engineSocket || engineSocket.destroyed) {
        if (resettingEngine) {
          const framed = `${message}\n`;
          const bytes = Buffer.byteLength(framed);
          if (bytes > maximumMessageBytes || pendingFrontendBytes > maximumMessageBytes - bytes) {
            socket.close(1013, "engine inspector reset queue is full");
            return;
          }
          pendingFrontendCommands.push(framed);
          pendingFrontendBytes += bytes;
          return;
        }
        let id;
        try { id = JSON.parse(message)?.id; } catch {}
        socket.send(JSON.stringify({
          ...(id === undefined ? {} : { id }),
          error: { code: -32000, message: "Defold Hermes runtime is not connected" }
        }));
        return;
      }
      if (engineSocket.writableLength + Buffer.byteLength(message) > maximumMessageBytes) {
        socket.close(1013, "engine inspector is not draining commands");
        return;
      }
      engineSocket.write(`${message}\n`);
    });
    socket.on("close", () => {
      if (frontendSocket === socket) {
        frontendSocket = undefined;
        pendingFrontendCommands = [];
        pendingFrontendBytes = 0;
        // Hermes CDPAgent owns debugger-domain state for one frontend
        // lifetime. Keeping the engine TCP stream alive after its WebSocket
        // disappears makes a later frontend look attached and even accept
        // breakpoints, but the agent no longer interrupts the runtime. Closing
        // this private transport tells InspectorClient to resume if necessary,
        // rebuild the agent at the next engine safe point, and reconnect with a
        // genuinely fresh session.
        if (engineSocket && !engineSocket.destroyed) {
          resettingEngine = true;
          engineSocket.destroy();
        }
      }
      if (!closing) log("CDP frontend detached");
    });
    socket.on("error", (error) => {
      if (!closing) log(`CDP frontend error: ${error.message}`, "warn");
    });
  });
  let devtoolsUrl;
  let session;
  try {
    const devtoolsAddress = await listen(httpServer, options.devtoolsPort ?? 0);
    devtoolsPort = devtoolsAddress.port;
    devtoolsUrl = `http://127.0.0.1:${devtoolsPort}`;
    session = options.sessionFile
      ? createInspectorSession({
          projectRoot: options.projectRoot,
          enginePort: engineAddress.port,
          devtoolsPort,
          devtoolsUrl,
          websocketUrl: target().webSocketDebuggerUrl,
          bundleUrl: options.bundleUrl,
          sourceMapFile: options.sourceMapFile
        })
      : undefined;
    if (session) await writeInspectorSession(options.sessionFile, session);
  } catch (error) {
    closing = true;
    engineSocket?.destroy();
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    await Promise.all([closeServer(engineServer), closeServer(httpServer)]);
    throw error;
  }
  log(`CDP discovery ready at ${devtoolsUrl}/json/list`);
  if (session) log(`inspector session: ${options.sessionFile}`);

  const close = async () => {
    if (closing) return;
    closing = true;
    frontendSocket?.close(1001, "déherm session closed");
    engineSocket?.destroy();
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    await Promise.all([closeServer(engineServer), closeServer(httpServer)]);
    if (session) await removeOwnedInspectorSession(options.sessionFile, session.sessionId);
  };

  return {
    enginePort: engineAddress.port,
    devtoolsPort,
    devtoolsUrl,
    websocketUrl: target().webSocketDebuggerUrl,
    session,
    sessionFile: options.sessionFile,
    close
  };
}
