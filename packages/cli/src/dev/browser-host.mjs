// Machinery for driving a packaged HTML5 bundle in a real browser.
//
// One place owns the awkward parts - a scoped loopback port, a static server
// for the bundle, a dedicated Chrome profile, a minimal CDP client, and a
// teardown that leaves nothing behind - because there are two consumers with
// the same needs and opposite lifetimes: the packaged runtime gate, which
// opens a page, asserts a marker transcript and exits, and the development
// browser target, which keeps a page alive across edits.
//
// Nothing here inspects a canvas or claims anything about what is drawn. The
// observable surface is the console transcript, page errors, and whatever the
// page itself reports when asked.

import { spawn as spawnProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where Chrome usually is, per host. Overridable by every caller. */
export const defaultChromeBinary = process.env.DEHERM_CHROME
  ?? process.env.DEFOLD_HERMES_CHROME
  ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".ttf", "font/ttf"],
  [".ico", "image/x-icon"]
]);

/**
 * A port the operating system has just confirmed is free on loopback. The
 * probe is closed before the value is returned, so this is a scope rather than
 * a reservation; every caller binds immediately afterwards.
 */
export async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createSocketProbe();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function waitFor(predicate, { timeoutMs, intervalMs = 150, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.fatal === true) throw error;
      lastError = error;
    }
    await new Promise((sleep) => setTimeout(sleep, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

/**
 * Serve one bundle directory on loopback. Requests are resolved inside the
 * root and nowhere else; there is no directory listing and no upward escape.
 */
export async function startBundleServer(options) {
  const root = path.resolve(options.root);
  const index = options.index ?? "index.html";
  const server = createServer((request, response) => {
    let requested;
    try {
      requested = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("invalid URL\n");
      return;
    }
    const file = path.normalize(path.join(root, requested === "/" ? `/${index}` : requested));
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if ((file !== root && !file.startsWith(prefix)) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": mimeTypes.get(path.extname(file)) ?? "application/octet-stream",
      // A development host must never serve a stale engine or archive after a
      // rebundle, and these bytes never leave loopback.
      "cache-control": "no-store"
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    root,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}/${encodeURIComponent(index)}`,
    close: () => new Promise((resolve) => server.close(() => resolve(true)))
  };
}

/**
 * A minimal Chrome DevTools Protocol client: request/response, event waits,
 * and a console/error stream. `retain` keeps the transcript for a consumer
 * that asserts over the whole run; a long-lived session sets it false and
 * consumes lines through `onConsole`.
 */
export async function connectCdp(webSocketDebuggerUrl, options = {}) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ready, failed) => {
    socket.addEventListener("open", ready, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
  const retain = options.retain !== false;
  let nextId = 1;
  const pending = new Map();
  const waiters = new Map();
  const listeners = new Map();
  const transcript = [];
  const failures = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const continuation = pending.get(message.id);
      if (!continuation) return;
      pending.delete(message.id);
      if (continuation.timer) clearTimeout(continuation.timer);
      if (message.error) continuation.reject(new Error(message.error.message));
      else continuation.resolve(message.result);
      return;
    }
    const queued = waiters.get(message.method);
    if (queued?.length) {
      waiters.delete(message.method);
      for (const waiter of queued) {
        clearTimeout(waiter.timer);
        waiter.resolve(message.params);
      }
    }
    for (const notify of listeners.get(message.method) ?? []) notify(message.params);
    if (message.method === "Runtime.consoleAPICalled") {
      const rendered = message.params.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" ");
      // The browser host prefixes every application log line; engine output
      // arrives as Emscripten's own console lines.
      const line = rendered.replace(/^\[defold-hermes\] /, "").replace(/\n$/, "");
      if (retain) transcript.push(line);
      options.onConsole?.(line, message.params.type ?? "log");
    } else if (message.method === "Runtime.exceptionThrown") {
      const failure = { kind: "exception", detail: message.params.exceptionDetails.text };
      if (retain) failures.push(failure);
      options.onFailure?.(failure);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const failure = {
        kind: "log",
        detail: message.params.entry.text,
        url: message.params.entry.url ?? null
      };
      if (retain) failures.push(failure);
      options.onFailure?.(failure);
    }
  });
  const send = (method, params = {}, sendOptions = {}) => {
    const id = nextId++;
    const result = new Promise((ok, no) => {
      const timer = sendOptions.timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            no(new Error(`Timed out waiting for CDP response to ${method}`));
          }, sendOptions.timeoutMs)
        : undefined;
      pending.set(id, { resolve: ok, reject: no, timer });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  };
  const waitForEvent = (method, timeoutMs = 30_000) => new Promise((ok, no) => {
    const timer = setTimeout(() => {
      const queue = waiters.get(method) ?? [];
      const remaining = queue.filter((waiter) => waiter.timer !== timer);
      if (remaining.length) waiters.set(method, remaining);
      else waiters.delete(method);
      no(new Error(`Timed out waiting for CDP event ${method}`));
    }, timeoutMs);
    const queue = waiters.get(method) ?? [];
    queue.push({ resolve: ok, reject: no, timer });
    waiters.set(method, queue);
  });
  const onEvent = (method, listener) => {
    const group = listeners.get(method) ?? new Set();
    group.add(listener);
    listeners.set(method, group);
    return () => {
      group.delete(listener);
      if (!group.size) listeners.delete(method);
    };
  };
  const close = () => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.addEventListener("close", resolve, { once: true });
    socket.close(1000, "CDP client closed");
  });
  socket.addEventListener("close", () => {
    for (const [, continuation] of pending) {
      if (continuation.timer) clearTimeout(continuation.timer);
      continuation.reject(new Error("CDP connection closed"));
    }
    pending.clear();
    for (const [method, queued] of waiters) {
      for (const waiter of queued) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`CDP connection closed while waiting for ${method}`));
      }
    }
    waiters.clear();
    listeners.clear();
    options.onClose?.();
  });
  return { socket, send, waitForEvent, onEvent, transcript, failures, close };
}

/**
 * Launch a headless Chrome on its own debugging port and its own profile
 * directory. The profile is a fresh temporary directory so the run inherits no
 * state and leaves none; the caller removes it in `close`.
 */
export async function launchChrome(options) {
  const profile = options.profile ?? await mkdtemp(path.join(tmpdir(), "deherm-browser-target."));
  const spawn = options.spawn ?? spawnProcess;
  const argv = [
    ...(options.headless === false ? [] : ["--headless=new"]),
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--remote-debugging-port=${options.debuggingPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.extraArguments ?? []),
    options.url
  ];
  const child = spawn(options.binary ?? defaultChromeBinary, argv, { stdio: ["ignore", "ignore", "pipe"] });
  return { child, profile, argv };
}

async function terminate(child) {
  if (!child || (child.exitCode === null && child.signalCode === null) === false) return;
  child.kill("SIGTERM");
  await new Promise((done) => setTimeout(done, 400));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/**
 * Serve a bundle, open it in a dedicated headless Chrome, and attach CDP.
 *
 * The returned handle owns every resource it created and releases all of them
 * in `close`, whether or not the page ever loaded: server socket, browser
 * process, CDP socket, and profile directory.
 */
export async function openBundlePage(options) {
  const bundleDirectory = path.resolve(options.bundleDirectory);
  const index = options.index ?? "index.html";
  if (!existsSync(path.join(bundleDirectory, index))) {
    throw new Error(`No ${index} in ${bundleDirectory}; bundle the project for wasm-web first`);
  }
  const server = await startBundleServer({ root: bundleDirectory, index, port: options.port });
  let browser;
  let client;
  const close = async () => {
    try { client?.socket.close(); } catch { /* already closed */ }
    await terminate(browser?.child);
    await server.close();
    if (browser?.profile && options.keepProfile !== true) {
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  try {
    const debuggingPort = options.debuggingPort ?? await freeLoopbackPort();
    const initialUrl = options.deferNavigation === true ? "about:blank" : server.pageUrl;
    browser = await launchChrome({
      binary: options.chromeBinary,
      url: initialUrl,
      debuggingPort,
      headless: options.headless,
      spawn: options.spawn,
      extraArguments: options.chromeArguments
    });
    browser.child.once("exit", () => options.onBrowserExit?.());
    await waitFor(async () => (await fetch(server.pageUrl)).ok,
      { timeoutMs: options.serverTimeoutMs ?? 15_000, what: "the local bundle server" });
    const target = await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
      return targets.find((candidate) => candidate.type === "page" && candidate.url === initialUrl);
    }, { timeoutMs: options.browserTimeoutMs ?? 30_000, what: "the headless Chrome page target" });
    client = await connectCdp(target.webSocketDebuggerUrl, {
      retain: options.retain,
      onConsole: options.onConsole,
      onFailure: options.onFailure,
      onClose: options.onClose
    });
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    return { server, browser, client, target, debuggingPort, pageUrl: server.pageUrl, profile: browser.profile, close };
  } catch (error) {
    await close();
    if (browser?.profile && options.keepProfile === true) {
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    throw error;
  }
}
