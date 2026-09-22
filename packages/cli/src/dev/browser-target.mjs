// The HTML5 target of a development session.
//
// A native target is a process the session starts and talks to over Defold's
// engine service: it posts a resource reload and reads an acknowledgement back
// out of the engine's stdout. A browser target is a different shape in every
// one of those respects, and this module is where the difference lives rather
// than leaking into the session:
//
//   * there is no engine service in a browser page, so the bundle is *pushed*
//     into the page over CDP instead of being fetched by the engine;
//   * activation is a transaction inside the page (see
//     `lib/web/library_defold_hermes.js`), and it acknowledges with the same
//     `DEHERM_EVENT bundle-activated fingerprint=...` line the native
//     extension logs, so the session joins it back to a build exactly the
//     same way;
//   * the engine's telemetry counters are Hermes counters, and the browser
//     host has no Hermes. What the browser genuinely measures is reported and
//     what it cannot is named. Nothing is imitated.
//
// Ports are scoped loopback ports, the Chrome profile is a fresh temporary
// directory, and `stop` releases the page, the browser, the server and the
// profile.

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { defaultChromeBinary, openBundlePage } from "./browser-host.mjs";
import { parseEngineControlEvent } from "./engine-process.mjs";
import {
  createInspectorSession,
  removeOwnedInspectorSession,
  writeInspectorSession
} from "./inspector-session.mjs";

export const BROWSER_TARGET_ID = "browser-host";

/**
 * What this target cannot do, declared rather than discovered.
 *
 * These are reported to the console as capability gaps against the native
 * target, so an operator reads the difference instead of inferring it from a
 * blank column.
 */
export const browserCapabilityGaps = Object.freeze([
  Object.freeze({
    name: "hermes-heap",
    available: false,
    reason: "The browser runtime embeds no Hermes. performance.memory reports the page's JavaScript heap and is shown under its own name."
  }),
  Object.freeze({
    name: "lua-handles",
    available: false,
    reason: "The Lua value registry lives inside the Wasm engine and exports no counter to the browser host."
  }),
  Object.freeze({
    name: "arena-high-water",
    available: false,
    reason: "The generated browser value bridge resets per-call arena state and records no high-water mark; adding one is a generator change."
  }),
  Object.freeze({
    name: "typed-native-transport",
    available: false,
    reason: "typed-native is a transport of the Hermes runtime; the browser projection lowers every route to direct-memory instead."
  }),
  Object.freeze({
    name: "engine-service-reload",
    available: false,
    reason: "An HTML5 page exposes no Defold engine service, so a bundle is pushed into the page over CDP rather than posted as a resource reload."
  }),
  Object.freeze({
    name: "wasm-rebuild-in-session",
    available: false,
    reason: "A wasm-web engine is produced by Bob and Extender, not by this session. A TypeScript edit does not change the engine, so the session reloads the bundle inside the running page; changing the extension or game.project needs a new wasm-web bundle."
  }),
  Object.freeze({
    name: "visual-verification",
    available: false,
    reason: "Nothing here inspects the canvas. The observable surface is the console transcript, page errors, and what the page reports when asked."
  })
]);

async function newestBundleDirectory(root, index) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let newest;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    let information;
    try {
      information = await stat(path.join(directory, index));
    } catch {
      continue;
    }
    if (!newest || information.mtimeMs > newest.mtimeMs) newest = { directory, mtimeMs: information.mtimeMs };
  }
  return newest;
}

/**
 * The repository a project sits inside, or null when it is standalone.
 *
 * Walked from the PROJECT rather than the working directory, so the answer is a
 * property of the project's location and not of how the process was invoked.
 */
function findRepositoryRoot(from) {
  let directory = from;
  for (;;) {
    for (const marker of [".git", "pnpm-workspace.yaml"]) {
      if (existsSync(path.join(directory, marker))) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Find the packaged HTML5 bundle to serve.
 *
 * Bob writes a bundle under whichever `--bundle-output` it was given, so both
 * the project-relative and the working-directory-relative conventions are
 * searched, newest first. A miss is an actionable message rather than a
 * fallback: serving the wrong directory would be worse than saying which
 * command produces the right one.
 */
export async function resolveWebBundle(options) {
  const index = options.index ?? "index.html";
  if (options.bundleDirectory) {
    const directory = path.resolve(options.bundleDirectory);
    await stat(path.join(directory, index));
    return { directory, index, source: "explicit" };
  }
  // Three conventions, newest first. The repository root matters because a
  // Defold project inside a monorepo - examples/<name>/defold here - gets its
  // bundle written to the REPOSITORY's build/bundle, which is neither the
  // project root nor necessarily the working directory. Searching only the
  // first two made discovery depend on where the TUI happened to be launched
  // from: it worked from the repository and failed from a home directory,
  // reporting a bundle missing that was sitting on disk the whole time.
  const roots = [
    path.join(path.resolve(options.projectRoot), "build", "bundle"),
    path.join(path.resolve(options.cwd ?? process.cwd()), "build", "bundle")
  ];
  const repositoryRoot = findRepositoryRoot(path.resolve(options.projectRoot));
  if (repositoryRoot) {
    const candidate = path.join(repositoryRoot, "build", "bundle");
    if (!roots.includes(candidate)) roots.push(candidate);
  }
  for (const root of roots) {
    const found = await newestBundleDirectory(root, index);
    if (found) return { directory: found.directory, index, source: root };
  }
  throw new Error(
    `No packaged HTML5 bundle found under ${roots.join(" or ")}. ` +
    "Bundle the project for wasm-web first (DEFOLD_HERMES_PLATFORM=wasm-web scripts/bob-local.sh bundle), " +
    "or pass --web-bundle <directory>.");
}

/**
 * Map what the page reports into the session's telemetry shape.
 *
 * Only counters that mean the same thing on both targets reuse a native name.
 * `performance.memory` is the page's JavaScript heap, not a Hermes heap, so it
 * travels under its own names and `hermesHeapAvailable` stays false.
 */
export function browserTelemetryEvent(id, reported) {
  if (!reported || typeof reported !== "object") return undefined;
  const available = reported.available ?? {};
  return {
    type: "telemetry",
    id,
    values: {
      runtimeId: reported.componentRevision ?? 0,
      bundleGeneration: reported.generation ?? 0,
      frames: reported.frames ?? 0,
      ...(typeof available.frameDtMs === "number" ? { frameDtMs: available.frameDtMs } : {}),
      componentInstances: available.componentInstances ?? 0,
      componentCapacity: available.componentCapacity ?? 0,
      callbackRoots: available.callbackRoots ?? 0,
      callbackCapacity: available.callbackCapacity ?? 0,
      hermesHeapAvailable: false,
      ...(typeof available.jsHeapBytes === "number" ? {
        jsHeapBytes: available.jsHeapBytes,
        jsHeapSizeBytes: available.jsHeapSizeBytes,
        jsHeapLimitBytes: available.jsHeapLimitBytes
      } : {})
    },
    capabilities: Object.entries(reported.unavailable ?? {})
      .filter(([, reason]) => typeof reason === "string")
      .map(([name, reason]) => ({ name, available: false, reason }))
  };
}

export function browserComponentSnapshotEvent(id, connectionEpoch, reported) {
  if (!reported || reported.schemaVersion !== 1 || reported.type !== "component-snapshot" ||
      !Array.isArray(reported.instances)) return undefined;
  return { ...reported, id, connectionEpoch };
}

/**
 * A browser target with the same controller surface as the native engine
 * controller - `launch`, `stop`, `toggle`, `running` - plus `activate`, which
 * is how a new bundle reaches a page that no engine service can be asked to
 * reload.
 */
export function createBrowserTarget(options) {
  const emit = options.emit ?? (() => {});
  const id = options.targetId ?? BROWSER_TARGET_ID;
  const projectRoot = path.resolve(options.projectRoot);
  const openPage = options.openBundlePage ?? openBundlePage;
  let page;
  let telemetryTimer;
  let telemetryPoll;
  let starting;
  let stopping;
  let pushed = 0;
  let connectionEpoch = 0;

  const log = (message, level = "info") => emit({ type: "log", source: "browser", level, message });

  const publishCapabilities = () => emit({
    type: "target-capabilities",
    id,
    capabilities: browserCapabilityGaps.map((gap) => ({ ...gap }))
  });

  const onConsole = (line, level) => {
    emit({
      type: "log",
      source: "browser",
      level: level === "error" ? "error" : level === "warning" ? "warn" : "info",
      message: line
    });
    // The page logs the same control events the native extension logs, so one
    // parser serves both targets and the console cannot tell a real activation
    // from a reload that changed nothing by anything other than a fingerprint.
    const control = parseEngineControlEvent(line, id);
    if (control) emit(control);
  };

  const pollTelemetry = async () => {
    if (telemetryPoll) return telemetryPoll;
    const polledPage = page;
    const polledEpoch = connectionEpoch;
    if (!polledPage) return;
    telemetryPoll = (async () => {
      try {
        const result = await polledPage.client.send("Runtime.evaluate", {
          expression: `(() => {
            const dev = globalThis.__defoldHermesDevV1;
            return dev ? {
              telemetry: dev.telemetry(),
              componentSnapshot: typeof dev.componentSnapshot === "function" ? dev.componentSnapshot() : null
            } : null;
          })()`,
          returnByValue: true
        });
        // A CDP response from a page that closed while evaluation was pending
        // must never be relabelled as the replacement page's connection epoch.
        if (page !== polledPage || connectionEpoch !== polledEpoch) return;
        const reported = result.result?.value;
        const telemetry = browserTelemetryEvent(id, reported?.telemetry);
        if (telemetry) emit(telemetry);
        const snapshot = browserComponentSnapshotEvent(id, polledEpoch, reported?.componentSnapshot);
        if (snapshot) emit(snapshot);
      } catch {
        // A page that is navigating or closing simply reports nothing this tick.
      }
    })();
    try {
      return await telemetryPoll;
    } finally {
      telemetryPoll = undefined;
    }
  };

  const launch = async () => {
    if (stopping) await stopping.catch(() => {});
    if (page || starting) return false;
    starting = (async () => {
      const bundle = await resolveWebBundle({
        projectRoot,
        cwd: options.cwd,
        bundleDirectory: options.bundleDirectory
      });
      log(`serving ${path.relative(projectRoot, bundle.directory) || bundle.directory}`);
      let openedExited = false;
      let opened;
      let openedEpoch;
      opened = await openPage({
        bundleDirectory: bundle.directory,
        index: bundle.index,
        chromeBinary: options.chromeBinary ?? defaultChromeBinary,
        headless: options.headless,
        retain: false,
        onConsole,
        onFailure: (failure) => {
          if (failure.url?.endsWith("/favicon.ico")) return;
          emit({ type: "log", source: "browser", level: "error", message: `${failure.kind}: ${failure.detail}` });
        },
        onBrowserExit: () => {
          openedExited = true;
          if (!opened || page !== opened) return;
          page = undefined;
          clearInterval(telemetryTimer);
          telemetryTimer = undefined;
          if (opened.inspectorSession) {
            void removeOwnedInspectorSession(options.sessionFile, opened.inspectorSession.sessionId)
              .catch(() => {});
          }
          emit({ type: "target-disconnected", id, connectionEpoch: openedEpoch });
          emit({ type: "log", source: "browser", message: "browser exited" });
        }
      });
      let inspectorSession;
      try {
        inspectorSession = options.sessionFile
          ? createInspectorSession({
              runtime: "browser",
              projectRoot,
              devtoolsPort: opened.debuggingPort,
              devtoolsUrl: `http://127.0.0.1:${opened.debuggingPort}`,
              websocketUrl: opened.target.webSocketDebuggerUrl,
              bundleUrl: "defold-hermes://app.js",
              sourceMapFile: options.sourceMapFile
            })
          : undefined;
        if (inspectorSession) await writeInspectorSession(options.sessionFile, inspectorSession);
        if (openedExited) throw new Error("browser exited while publishing its inspector session");
      } catch (error) {
        await opened.close().catch(() => {});
        if (inspectorSession) {
          await removeOwnedInspectorSession(options.sessionFile, inspectorSession.sessionId).catch(() => {});
        }
        throw error;
      }
      opened.inspectorSession = inspectorSession;
      page = opened;
      openedEpoch = ++connectionEpoch;
      emit({ type: "target-configured", id, name: `chrome:${opened.server.port}`, url: opened.pageUrl, runtime: "browser" });
      emit({ type: "target-connected", id, name: `chrome:${opened.server.port}`, url: opened.pageUrl, connectionEpoch: openedEpoch });
      publishCapabilities();
      log(`page ${opened.pageUrl} (CDP 127.0.0.1:${opened.debuggingPort}, profile ${opened.profile})`);
      if (inspectorSession) log(`browser inspector session: ${options.sessionFile}`);
      telemetryTimer = setInterval(() => { void pollTelemetry(); }, options.telemetryIntervalMs ?? 1_000);
      telemetryTimer.unref?.();
      return true;
    })().finally(() => { starting = undefined; });
    return starting;
  };

  const stop = async () => {
    if (starting) await starting.catch(() => {});
    const open = page;
    if (!open) return false;
    if (stopping) return stopping;
    const stoppedEpoch = connectionEpoch;
    page = undefined;
    clearInterval(telemetryTimer);
    telemetryTimer = undefined;
    stopping = open.close().then(async () => {
      if (open.inspectorSession) {
        await removeOwnedInspectorSession(options.sessionFile, open.inspectorSession.sessionId);
      }
      emit({ type: "target-disconnected", id, connectionEpoch: stoppedEpoch });
      log("browser target stopped; server, profile and browser released");
      return true;
    }).finally(() => { stopping = undefined; });
    return stopping;
  };

  /**
   * Push one built bundle into the running page and wait for the page's own
   * verdict. The fingerprint acknowledgement arrives as a console control
   * event; this returns the direct result so a caller can report a rejection
   * without waiting for a line to be parsed.
   */
  const activate = async (generation) => {
    if (!page) return { status: "skipped", reason: "no browser target is running" };
    const source = await readFile(options.bundleFile, "utf8");
    if (generation !== undefined) emit({ type: "reload-started", id, generation });
    const result = await page.client.send("Runtime.evaluate", {
      expression: `globalThis.__defoldHermesDevV1
        ? globalThis.__defoldHermesDevV1.activate(${JSON.stringify(source)})
        : { status: "rejected", diagnostic: "browser host is not loaded" }`,
      returnByValue: true,
      awaitPromise: false
    });
    const value = result.result?.value ?? { status: "rejected", diagnostic: "page returned nothing" };
    ++pushed;
    if (generation !== undefined) {
      if (value.status === "activated") emit({ type: "reload-signalled", id, generation });
      else emit({ type: "reload-failed", id, generation, diagnostic: value.diagnostic ?? "browser rejected the bundle" });
    }
    return value;
  };

  return {
    id,
    launch,
    stop,
    toggle: () => (page ? stop() : launch()),
    running: () => Boolean(page),
    activate,
    pushCount: () => pushed,
    capabilities: () => browserCapabilityGaps.map((gap) => ({ ...gap })),
    pageUrl: () => page?.pageUrl
  };
}
