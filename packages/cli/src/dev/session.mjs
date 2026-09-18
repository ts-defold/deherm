import { createWriteStream } from "node:fs";
import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  componentProxyConstants,
  generateComponentProxies
} from "../../../compiler/src/component-proxy-generator.mjs";
import { createIncrementalCompiler } from "./compiler.mjs";
import { createDefoldBuilder } from "./defold-builder.mjs";
import { HotReloadCoordinator } from "./coordinator.mjs";
import { createEngineController } from "./engine-process.mjs";
import { applyDevEvent, createDevModel, snapshotDevModel } from "./model.mjs";
import { normalizeResourcePaths } from "./protocol.mjs";
import { startResourceServer } from "./resource-server.mjs";
import { watchProject } from "./watcher.mjs";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const componentSourceSuffixes = componentProxyConstants.sourceKinds.map(({ suffix }) => suffix);
const componentProxySuffixes = componentSourceSuffixes.map((suffix) => suffix.slice(0, -3));
const ignoredEntryDirectories = new Set([
  ".deherm",
  ".git",
  "build",
  "defold_hermes",
  "node_modules"
]);

function isComponentSource(file) {
  return componentSourceSuffixes.some((suffix) => file.endsWith(suffix));
}

function isComponentProxy(file) {
  return componentProxySuffixes.some((suffix) => file.endsWith(suffix));
}

async function resolveEntry(projectRoot, requested) {
  if (requested) return path.resolve(requested);
  const candidates = [
    path.join(projectRoot, "src", "main.ts"),
    path.join(projectRoot, "src", "main.script.ts")
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  let componentEntries = [];
  try {
    componentEntries = (await readdir(projectRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => {
        if (!entry.isFile() || !isComponentSource(entry.name)) return false;
        const relativeParent = path.relative(projectRoot, entry.parentPath);
        return !relativeParent.split(path.sep).some((part) => ignoredEntryDirectories.has(part));
      })
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  } catch {
    // The actionable error below covers missing or unreadable source trees.
  }
  if (componentEntries.length === 1) return componentEntries[0];
  if (componentEntries.length > 1) return componentEntries[0];
  throw new Error(`deherm dev needs --entry <file>; no conventional entry or authored ${componentSourceSuffixes.join(", ")} component was found`);
}

function containedPath(root, relative, label) {
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`${label} must resolve inside ${root}`);
  }
  return resolved;
}

function waitForSignal() {
  return new Promise((resolve) => {
    const done = (signal) => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve(signal);
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

async function entryTsconfig(projectRoot, entryPoint) {
  // A development bundle composes every authored component through the
  // generated registry. It therefore needs the unfiltered runtime SDK while
  // the separate context projects remain the authoritative typecheck gates.
  const bundle = path.join(projectRoot, "tsconfig.deherm.bundle.json");
  if (await exists(bundle)) return bundle;
  const name = entryPoint.toLowerCase();
  const context = name.endsWith(".script.ts")
    ? "game-object"
    : name.endsWith(".gui.ts") || name.endsWith(".gui_script.ts")
      ? "gui"
      : name.endsWith(".render.ts")
        ? "render"
        : "shared";
  const generated = path.join(projectRoot, `tsconfig.deherm.${context}.json`);
  if (await exists(generated)) return generated;
  const conventional = path.join(projectRoot, "tsconfig.json");
  return await exists(conventional) ? conventional : undefined;
}

export function createDevWatchOptions({ outputFile, sourceMirror, buildMirror }) {
  return {
    ignoredPaths: [outputFile, sourceMirror, buildMirror].flatMap((file) => [file, `${file}.map`]),
    shouldIgnore: (_file, relative) => isComponentProxy(relative) || relative.includes(".deherm-tmp-")
  };
}

function needsDefoldBuild(files) {
  return files.some((file) => isComponentSource(file) || !/\.[cm]?[jt]sx?$/.test(file));
}

function needsEngineRestart(files) {
  return files.some((file) => file === "game.project" || file.startsWith("defold_hermes/") || file.endsWith("/ext.manifest") || file === "ext.manifest");
}

export async function runDevSession(options = {}) {
  const services = options.services ?? {};
  const projectRoot = path.resolve(options.project ?? process.cwd());
  const entryPoint = await resolveEntry(projectRoot, options.entry);
  const outputFile = path.resolve(options.outputFile ?? path.join(projectRoot, ".deherm", "dev", "app.dehermc"));
  const sessionLogFile = path.resolve(options.sessionLog ?? path.join(projectRoot, ".deherm", "dev", "session.log"));
  await mkdir(path.dirname(sessionLogFile), { recursive: true });
  const sessionLog = createWriteStream(sessionLogFile, { flags: "w" });
  let sessionLogFailed = false;
  let sessionLogClosed = false;
  sessionLog.on("error", () => { sessionLogFailed = true; });
  const closeSessionLog = async () => {
    if (sessionLogClosed) return;
    sessionLogClosed = true;
    if (sessionLog.destroyed) return;
    await new Promise((resolve) => sessionLog.end(resolve));
  };
  const [resourcePath] = normalizeResourcePaths([options.resourcePath ?? "/deherm/app.dehermc"]);
  const resourceRelative = resourcePath.slice(1);
  const sourceMirror = options.sourceMirror
    ? containedPath(projectRoot, path.relative(projectRoot, path.resolve(options.sourceMirror)), "source mirror")
    : containedPath(projectRoot, resourceRelative, "resource path");
  const buildRoot = path.resolve(options.buildDir ?? path.join(projectRoot, "build", "default"));
  const buildMirror = containedPath(buildRoot, resourceRelative, "build resource path");
  const model = createDevModel();
  const listeners = new Set();
  const lineOutput = options.headless || (!options.json && (!process.stdin.isTTY || !process.stdout.isTTY));
  const emit = (event) => {
    applyDevEvent(model, event);
    if (!sessionLogFailed && !sessionLog.destroyed) {
      const timestamp = new Date(event.at ?? Date.now()).toISOString();
      const line = event.type === "log"
        ? `${timestamp} [${String(event.level ?? "info").toUpperCase()}] ${event.source ?? "deherm"} ${event.message}`
        : `${timestamp} [EVENT] ${event.type} ${JSON.stringify(event)}`;
      sessionLog.write(`${line}\n`);
    }
    if (options.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, event })}\n`);
    else if (lineOutput) {
      const detail = event.diagnostic ? `: ${event.diagnostic}` : "";
      process.stdout.write(`[deherm] ${event.type} generation=${event.generation ?? "-"}${detail}\n`);
    }
    for (const listener of listeners) listener(event);
    services.onEvent?.(event);
  };
  emit({ type: "log", source: "dev", message: `session log: ${path.relative(projectRoot, sessionLogFile).split(path.sep).join("/")}` });
  const targets = new Map((options.targets ?? []).map((url, index) => {
    const id = `target-${index + 1}`;
    const name = new URL(url).host;
    emit({ type: "target-configured", id, name, url });
    return [id, { url, name }];
  }));
  if (targets.size) {
    emit({
      type: "log",
      level: "warn",
      source: "reload",
      message: "Defold HTTP 200 acknowledges enqueue only; the target remains awaiting activation until runtime telemetry confirms a committed generation"
    });
  }
  let generatedComponents = false;
  const compiler = await (services.createIncrementalCompiler ?? createIncrementalCompiler)({
    entryPoint,
    // The generated registry imports every authored component and installs the
    // runtime component table. Import it before the requested app entry so a
    // single development bundle supports component-only, app-only, and mixed
    // projects without asking authors to maintain a bootstrap file.
    preludeEntries: [path.join(projectRoot, ".deherm", "generated", "components", "registry.ts")],
    tsconfig: await entryTsconfig(projectRoot, entryPoint),
    outputFile,
    mirrors: [sourceMirror, buildMirror],
    resourcePath,
    useTtsc: options.useTtsc,
    beforeRebuild: options.components === false ? undefined : async (changedSources) => {
      if (generatedComponents && !changedSources.some(isComponentSource)) return;
      await generateComponentProxies({ projectRoot, outputRoot: projectRoot });
      generatedComponents = true;
    }
  });
  const coordinator = services.createCoordinator
    ? services.createCoordinator({ compiler, targets, emit })
    : new HotReloadCoordinator({ compiler, targets, emit });
  const servicePort = options.servicePort ?? 8001;
  const localTargetUrl = `http://127.0.0.1:${servicePort}`;
  const engine = (services.createEngineController ?? createEngineController)({
    projectRoot,
    emit,
    targetId: "local-engine",
    env: { DM_SERVICE_PORT: String(servicePort) }
  });
  await coordinator.requestBuild([path.relative(projectRoot, entryPoint).split(path.sep).join("/") || path.basename(entryPoint)]);

  if (options.once) {
    await coordinator.close();
    await closeSessionLog();
    return snapshotDevModel(model);
  }


  if (![...targets.values()].some(({ url }) => url === localTargetUrl)) {
    targets.set("local-engine", { url: localTargetUrl, name: `local:${servicePort}` });
    emit({ type: "target-configured", id: "local-engine", name: `local:${servicePort}`, url: localTargetUrl });
  }

  let builder;
  let builderPromise;
  let developmentLoop = Promise.resolve();
  const ensureBuilder = () => builderPromise ??= (services.createDefoldBuilder ?? createDefoldBuilder)({
    projectRoot,
    outputRoot: buildRoot,
    buildServer: options.buildServer,
    emit
  }).then((value) => (builder = value));
  const enqueue = (operation) => {
    const current = developmentLoop.then(operation);
    developmentLoop = current.catch(() => {});
    return current;
  };
  const buildDefoldAndMaybeLaunch = (
      reason,
      restart = false,
      launch = options.autoLaunch !== false) => enqueue(async () => {
    const activeBuilder = await ensureBuilder();
    const result = await activeBuilder.build(reason);
    if (restart && engine.running()) await engine.stop();
    if (launch && !engine.running()) await engine.launch();
    else if (engine.running() && result.resources.length) await coordinator.reloadResources(result.resources);
    return result;
  });
  const launchBuiltGame = () => enqueue(async () => {
    if (model.defoldBuild.status !== "ready") {
      const activeBuilder = await ensureBuilder();
      await activeBuilder.build("manual launch");
    }
    if (!engine.running()) await engine.launch();
  });
  const processChanges = (files) => enqueue(async () => {
    await coordinator.requestBuild(files);
    if (!needsDefoldBuild(files)) return;
    const activeBuilder = await ensureBuilder();
    const result = await activeBuilder.build(`changed ${files.length} file(s)`);
    if (needsEngineRestart(files)) {
      const wasRunning = engine.running();
      if (wasRunning) await engine.stop();
      if (wasRunning || options.autoLaunch !== false) await engine.launch();
    } else if (engine.running() && result.resources.length) {
      await coordinator.reloadResources(result.resources);
    }
  });

  await mkdir(buildRoot, { recursive: true });
  const resourceServer = options.serve === false ? undefined : await (services.startResourceServer ?? startResourceServer)({
    root: buildRoot,
    host: options.serveHost,
    port: options.servePort,
    onError: (error) => emit({ type: "log", level: "error", source: "resource-server", message: error.message })
  });
  if (resourceServer) {
    emit({ type: "log", source: "resource-server", message: `serving ${buildRoot} at ${resourceServer.baseUrl}` });
  }
  const watcher = await (services.watchProject ?? watchProject)({
    root: path.resolve(options.watchRoot ?? projectRoot),
    debounceMs: options.debounceMs,
    ...createDevWatchOptions({ outputFile, sourceMirror, buildMirror }),
    onBatch: (files) => processChanges(files),
    onError: (error) => emit({ type: "log", level: "error", source: "watcher", message: error.message })
  });
  const startup = buildDefoldAndMaybeLaunch("initial dev startup", false).catch((error) => emit({
    type: "log",
    level: "error",
    source: "dev",
    message: `automatic Defold build/launch failed: ${error instanceof Error ? error.message : String(error)}`
  }));
  const close = async () => {
    watcher.close();
    await startup;
    await developmentLoop;
    await engine.stop();
    await coordinator.close();
    await builder?.close();
    await resourceServer?.close();
    await closeSessionLog();
  };
  if (services.runDevTui || (!options.headless && !options.json && process.stdin.isTTY && process.stdout.isTTY)) {
    const runDevTui = services.runDevTui ?? (await import("./tui.mjs")).runDevTui;
    try {
      await runDevTui({
        snapshot: () => snapshotDevModel(model),
        onIntent(intent) {
          if (intent.type === "reload") {
            void coordinator.requestBuild([]).catch((error) => emit({
              type: "log",
              level: "error",
              source: "coordinator",
              message: error.message
            }));
          }
          else if (intent.type === "rebuild") {
            void enqueue(async () => {
              await coordinator.requestBuild([]);
              const activeBuilder = await ensureBuilder();
              await activeBuilder.build("manual full rebuild");
              const wasRunning = engine.running();
              if (wasRunning) await engine.stop();
              if (wasRunning || options.autoLaunch !== false) await engine.launch();
            }).catch((error) => emit({
              type: "log",
              level: "error",
              source: "coordinator",
              message: error instanceof Error ? error.message : String(error)
            }));
          }
          else if (intent.type === "play") {
            const action = engine.running()
              ? engine.stop()
              : launchBuiltGame();
            void action.catch((error) => emit({
              type: "engine-failed",
              diagnostic: error instanceof Error ? error.message : String(error)
            }));
          }
          else emit({ type: "log", source: "tui", message: `${intent.type} panel is staged but not implemented` });
        }
      });
    } finally {
      await close();
    }
  } else {
    await (services.waitForSignal ?? waitForSignal)();
    await close();
  }
  return snapshotDevModel(model);
}
