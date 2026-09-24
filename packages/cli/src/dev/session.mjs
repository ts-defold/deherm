import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  componentAuthoringConventions,
  generateComponentProxies
} from "../../../compiler/src/component-proxy-generator.mjs";
import { recordBundleBuild } from "../build-artifacts.mjs";
import {
  writeProjectDmSdkCallSymbolIndex,
  writeProjectResourceSymbols,
  writeProjectRouteSymbolIndex
} from "../resource-symbols.mjs";
import { readReleaseReachability } from "./release-reachability.mjs";
import { createBugPoolRecorder, defaultBugPoolFile } from "./bug-pool.mjs";
import { createIncrementalCompiler } from "./compiler.mjs";
import { createDefoldBuilder, defaultDefoldBundleOutput } from "./defold-builder.mjs";
import { HotReloadCoordinator } from "./coordinator.mjs";
import { createEngineController } from "./engine-process.mjs";
import { createInspectorBridge } from "./inspector-bridge.mjs";
import { defaultBrowserInspectorSessionFile, defaultInspectorSessionFile } from "./inspector-session.mjs";
import { BROWSER_TARGET_ID, createBrowserTarget } from "./browser-target.mjs";
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

const componentSourceSuffixes = componentAuthoringConventions.map(({ suffix }) => suffix);
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

async function resolveEntry(projectRoot, requested) {
  if (requested) return path.isAbsolute(requested) ? requested : path.resolve(projectRoot, requested);
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

export function createDevWatchOptions({
  projectRoot,
  outputFile,
  sourceMirror,
  buildMirror,
  lockFile,
  generatedRoot,
  generatedProxyPaths = new Set()
}) {
  const toolchainOutputs = projectRoot ? [
    path.join(projectRoot, ".defignore"),
    path.join(projectRoot, "defold_hermes", "include", "libhermesvm-config.h"),
    path.join(projectRoot, "defold_hermes", "include", "defold_hermes", "generated_runtime_variant.h"),
    path.join(projectRoot, "defold_hermes", "lib")
  ] : [];
  return {
    ignoredPaths: [outputFile, sourceMirror, buildMirror].flatMap((file) => [
      file,
      `${file}.map`,
      `${file}.hbc`,
      `${file}.hbc.map`
    ]).concat(lockFile ? [lockFile] : [])
      .concat(generatedRoot ? [generatedRoot] : [])
      .concat(toolchainOutputs),
    // The watcher already drops every atomic-write scratch name, including
    // `.deherm-tmp-*`; this only hides the proxies the session itself writes.
    shouldIgnore: (_file, relative) => generatedProxyPaths.has(relative)
  };
}

// Prose is not a build input. A README edit must not schedule a TypeScript
// rebuild, and it is not a Defold resource either, so a documentation-only
// batch leaves both pipelines alone.
const documentationSuffixes = [".md", ".markdown", ".mdx", ".mdc", ".txt", ".rst", ".adoc", ".log"];

export function isDocumentationOnlyChange(file) {
  const name = file.toLowerCase();
  return documentationSuffixes.some((suffix) => name.endsWith(suffix)) ||
    ["license", "licence", "notice", "authors", "changelog"].includes(name.split("/").at(-1));
}

export function buildRelevantChanges(files) {
  return files.filter((file) => !isDocumentationOnlyChange(file));
}

async function refreshProjectSymbolIndexes(projectRoot, generatedRoot) {
  const irRoot = path.join(generatedRoot, "ir");
  const groups = [
    {
      name: "resource",
      inputs: ["defold-resource-declaration-schema.json", "defold-script-resource-namespaces.json"],
      output: "resource-symbols.json",
      write: () => writeProjectResourceSymbols(projectRoot, generatedRoot)
    },
    {
      name: "script-route",
      inputs: ["script-api.json", "binding-lowering-plan.json"],
      output: "script-route-symbol-index.json",
      write: () => writeProjectRouteSymbolIndex(generatedRoot)
    },
    {
      name: "dmsdk-call",
      inputs: ["dmsdk.json", "dmsdk-universal-bindings.json"],
      output: "dmsdk-call-symbol-index.json",
      write: () => writeProjectDmSdkCallSymbolIndex(generatedRoot)
    }
  ];
  const written = [];
  const unavailable = [];
  for (const group of groups) {
    if ((await Promise.all(group.inputs.map((file) => exists(path.join(irRoot, file))))).every(Boolean)) {
      await group.write();
      written.push(group.name);
    } else {
      await rm(path.join(generatedRoot, "generated", group.output), { force: true });
      unavailable.push(group.name);
    }
  }
  return { written, unavailable };
}

function needsDefoldBuild(files, componentProxyChanged = false) {
  return files.some((file) => !/\.[cm]?[jt]sx?$/.test(file)) ||
    (componentProxyChanged && files.some(isComponentSource));
}

export function resourcesForBobReload(resources, compilerResources, compilerReloadSignalled) {
  if (!compilerReloadSignalled) return [...resources];
  const compilerArtifacts = new Set(compilerResources.flatMap((resource) => [resource, `${resource}.hbc`]));
  return resources.filter((resource) => !compilerArtifacts.has(resource));
}

function needsEngineRestart(files) {
  return files.some((file) => file === "game.project" || file.startsWith("defold_hermes/") || file.endsWith("/ext.manifest") || file === "ext.manifest");
}

export function sessionLogEvent(event) {
  if (event.type !== "component-snapshot") return event;
  let propertyCount = 0;
  for (const instance of event.instances ?? []) propertyCount += Array.isArray(instance?.properties) ? instance.properties.length : 0;
  return {
    schemaVersion: event.schemaVersion,
    type: event.type,
    id: event.id,
    connectionEpoch: event.connectionEpoch,
    runtimeId: event.runtimeId,
    sequence: event.sequence,
    sampledAt: event.sampledAt,
    complete: event.complete,
    omitted: event.omitted ? { ...event.omitted } : undefined,
    instanceCount: event.instances?.length ?? 0,
    propertyCount
  };
}

export function devStateSnapshot(model) {
  const snapshot = snapshotDevModel(model);
  const result = {
    schemaVersion: 1,
    kind: "deherm-dev-state",
    modelVersion: snapshot.version,
    targets: snapshot.targets.map((target) => ({
      id: target.id,
      runtime: target.runtime,
      status: target.status,
      connectionEpoch: target.connectionEpoch,
      telemetry: target.telemetry,
      instances: [],
      instanceProjection: {
        complete: true,
        totalInstances: target.instances?.length ?? 0,
        omittedInstances: 0
      },
      // `instances` above is the authoritative server-enriched projection.
      // Keep only snapshot freshness/identity metadata here: returning the raw
      // instances as well would duplicate up to 512 KiB per target and could
      // push an otherwise valid native+browser response past the editor's
      // bounded 2 MiB intake.
      componentSnapshot: target.componentSnapshot ? {
        schemaVersion: target.componentSnapshot.schemaVersion,
        type: target.componentSnapshot.type,
        runtimeId: target.componentSnapshot.runtimeId,
        sequence: target.componentSnapshot.sequence,
        sampledAt: target.componentSnapshot.sampledAt,
        complete: target.componentSnapshot.complete,
        omitted: target.componentSnapshot.omitted
      } : null
    }))
  };
  // The editor intake is deliberately bounded at 2 MiB. Generated source and
  // proxy paths are server-enriched onto every runtime row and can be much
  // larger than the producer frame, so divide the available body budget fairly
  // across targets and omit only whole rows. The TUI still owns the complete
  // in-process model; this is the separate editor projection.
  const maximumBytes = 2 * 1024 * 1024;
  const envelopeReserve = 32 * 1024;
  const baseBytes = Buffer.byteLength(JSON.stringify(result));
  const targetBudget = Math.max(0, Math.floor(
    (maximumBytes - envelopeReserve - baseBytes) / Math.max(1, result.targets.length)));
  for (let targetIndex = 0; targetIndex < result.targets.length; ++targetIndex) {
    const sourceInstances = snapshot.targets[targetIndex].instances ?? [];
    const projected = result.targets[targetIndex];
    let used = 0;
    for (const instance of sourceInstances) {
      const rowBytes = Buffer.byteLength(JSON.stringify(instance)) + (projected.instances.length ? 1 : 0);
      if (used + rowBytes > targetBudget) {
        projected.instanceProjection.omittedInstances += 1;
        continue;
      }
      projected.instances.push(instance);
      used += rowBytes;
    }
    projected.instanceProjection.complete = projected.instanceProjection.omittedInstances === 0;
  }
  return result;
}

export async function prepareDebugWebBundle(builder, options = {}) {
  const webBundle = options.webBundle ? path.resolve(options.webBundle) : undefined;
  return builder.bundle({
    platform: "wasm-web",
    variant: "debug",
    ...(webBundle ? { bundleOutput: path.dirname(webBundle) } : {}),
    reason: options.reason ?? "development browser launch"
  });
}

export async function runDevSession(options = {}) {
  const services = options.services ?? {};
  const projectRoot = path.resolve(options.project ?? process.cwd());
  const generatedRoot = path.resolve(options.generatedRoot ?? path.join(projectRoot, options.outDir ?? ".deherm"));
  const componentPolicy = JSON.parse(await readFile(
    path.join(generatedRoot, "ir", "defold-component-proxy-contract.json"),
    "utf8"
  ));
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
  const listeners = new Set();
  // The session log is truncated per session, so defects are classified as they
  // happen and accumulated into a pool that survives across sessions. The pool
  // records this software's own runtime behaviour; it is never conformance
  // evidence and must not reach a completion-matrix row.
  const bugPool = options.bugPool === false ? undefined : createBugPoolRecorder({
    file: path.resolve(options.bugPoolFile ?? defaultBugPoolFile(projectRoot)),
    onError: () => { /* Harvesting must never interrupt a development session. */ }
  });
  const model = createDevModel({ bugPoolFile: bugPool?.file });
  const lineOutput = options.headless || (!options.json && (!process.stdin.isTTY || !process.stdout.isTTY));
  let compilerGeneration = 0;
  let compilerReloadSignalled = false;
  const emit = (event) => {
    if (event.type === "build-succeeded") {
      compilerGeneration = event.generation;
      compilerReloadSignalled = false;
    } else if (event.type === "reload-signalled" &&
        event.id === "local-engine" && event.generation === compilerGeneration) {
      compilerReloadSignalled = true;
    }
    applyDevEvent(model, event);
    bugPool?.record(event);
    if (!sessionLogFailed && !sessionLog.destroyed) {
      const timestamp = new Date(event.at ?? Date.now()).toISOString();
      const line = event.type === "log"
        ? `${timestamp} [${String(event.level ?? "info").toUpperCase()}] ${event.source ?? "deherm"} ${event.message}`
        : `${timestamp} [EVENT] ${event.type} ${JSON.stringify(sessionLogEvent(event))}`;
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
  const generatedProxyPaths = new Set();
  let componentProxyChanged = false;
  let reportedArtifactRecordingFailure = false;
  let reportedMissingSymbolIndexes = false;
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
    // Hermes parses JavaScript on every load unless handed bytecode. hermesc is
    // published per host precisely so this costs the user no native toolchain,
    // and until now nothing invoked it - every build shipped source. Dev keeps
    // -Og -g2 so a stack trace still names a line; a release build optimises.
    bytecode: options.bytecode !== false,
    bytecodeOptimize: options.bytecodeOptimize === true,
    // Bob archives the mirrored bundle without knowing what produced it. Each
    // successful build therefore rewrites the binding in deherm.lock, so the
    // relation between the artifact on Bob's input path and the sources it came
    // from is recorded at the moment it is true rather than inferred later.
    // Recording hashes the files the bundler just read; it never recompiles.
    afterRebuild: options.recordBuildArtifacts === false ? undefined : async (build) => {
      // Reporting only. The development extension keeps the complete linked
      // surface whatever this says, so a new API call never forces a relink.
      try {
        const reachability = await readReleaseReachability(projectRoot);
        if (reachability) emit({ type: "reachability", reachability });
      } catch {
        // A console that cannot read the manifest simply shows nothing.
      }
      try {
        await recordBundleBuild({ projectRoot, build });
      } catch (error) {
        // Reported once: a project whose lock cannot be written fails every
        // rebuild the same way, and the edit loop is not the place to repeat it.
        if (reportedArtifactRecordingFailure) return;
        reportedArtifactRecordingFailure = true;
        emit({
          type: "log",
          level: "warn",
          source: "dev",
          message: `could not record the bundle freshness binding in deherm.lock: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    },
    beforeRebuild: options.components === false ? undefined : async (changedSources) => {
      if (generatedComponents && !changedSources.some(isComponentSource)) return;
      const components = await generateComponentProxies({ projectRoot, outputRoot: projectRoot, componentPolicy });
      generatedProxyPaths.clear();
      for (const component of components.manifest.components) generatedProxyPaths.add(component.proxy);
      emit({
        type: "component-catalog",
        components: components.manifest.components.map((component) => ({
          componentId: component.componentId,
          schemaFingerprint: component.schemaFingerprint,
          source: component.source,
          proxy: component.proxy,
          contextKind: component.contextKind,
          properties: component.properties.map(({ name, slot, kind }) => ({ name, slot, kind }))
        }))
      });
      // Sticky until the watcher batch consumes it. A forced/manual build may
      // join the coordinator loop after this build and must not erase the fact
      // that the component batch changed a Defold resource.
      componentProxyChanged ||= components.defoldResourceStale.length > 0;
      const indexes = await refreshProjectSymbolIndexes(projectRoot, generatedRoot);
      if (indexes.unavailable.length && !reportedMissingSymbolIndexes) {
        reportedMissingSymbolIndexes = true;
        emit({
          type: "log",
          level: "warn",
          source: "compiler",
          message: `some project API IR inputs are absent; ${indexes.unavailable.join(", ")} compile-time indexes are disabled (run 'deherm generate' to enable them)`
        });
      }
      generatedComponents = true;
    }
  });
  const coordinator = services.createCoordinator
    ? services.createCoordinator({ compiler, targets, emit })
    : new HotReloadCoordinator({ compiler, targets, emit });
  const servicePort = options.servicePort ?? 8001;
  const localTargetUrl = `http://127.0.0.1:${servicePort}`;
  const browserBundleRoot = options.webBundle
    ? path.resolve(options.webBundle)
    : defaultDefoldBundleOutput(projectRoot, { env: options.env });
  // `--once` never launches an engine and must not bind background ports. A
  // normal dev session owns both sides of the local inspector bridge before
  // spawning Defold, so the engine's synchronous loopback connect is bounded.
  const inspectorBridge = options.once
    ? undefined
    : await (services.createInspectorBridge ?? createInspectorBridge)({
        emit,
        title: path.basename(projectRoot),
        projectRoot,
        targetId: "local-engine",
        getDevState: () => devStateSnapshot(model),
        sessionFile: path.resolve(options.inspectorSession ?? defaultInspectorSessionFile(projectRoot)),
        bundleUrl: `deherm://${resourcePath}`,
        sourceMapFile: `${outputFile}.map`
      });
  // The resource server starts later in this function, so the engine resolves
  // its content root lazily at launch time.
  let resourceServer;
  const engine = (services.createEngineController ?? createEngineController)({
    projectRoot,
    emit,
    targetId: "local-engine",
    resourceUri: () => resourceServer?.baseUrl,
    inspectorPort: inspectorBridge?.enginePort,
    env: { DM_SERVICE_PORT: String(servicePort) }
  });
  // The HTML5 target of the same session. It is a peer of the native engine,
  // not a mode of it: both can run at once, each reports its own generation and
  // its own telemetry, and the console lists both. A browser page has no engine
  // service, so this one is reloaded by pushing the built bundle into the page;
  // the page acknowledges with the same fingerprint event the engine logs.
  const browser = (services.createBrowserTarget ?? createBrowserTarget)({
    projectRoot,
    emit,
    targetId: BROWSER_TARGET_ID,
    bundleFile: outputFile,
    sourceMapFile: `${outputFile}.map`,
    sessionFile: path.resolve(options.browserInspectorSession ?? defaultBrowserInspectorSessionFile(projectRoot)),
    bundleDirectory: browserBundleRoot,
    allowNestedBundleDirectory: !options.webBundle,
    chromeBinary: options.chrome,
    headless: options.browserHeadless,
    telemetryIntervalMs: options.telemetryIntervalMs
  });
  // A build the browser target is running must reach the page, and only a
  // build that succeeded may be pushed. This is the browser's equivalent of the
  // coordinator's resource-reload post, kept out of the coordinator because it
  // is a different transport with a different acknowledgement path.
  listeners.add((event) => {
    if (event.type !== "build-succeeded" || !browser.running()) return;
    void browser.activate(event.generation).catch((error) => emit({
      type: "log",
      level: "error",
      source: "browser",
      message: `pushing bundle generation ${event.generation} into the page failed: ${error instanceof Error ? error.message : String(error)}`
    }));
  });
  await coordinator.requestBuild([path.relative(projectRoot, entryPoint).split(path.sep).join("/") || path.basename(entryPoint)]);
  // Startup generation is followed by the explicit initial Bob build below;
  // only watcher-driven component changes participate in the incremental gate.
  componentProxyChanged = false;

  if (options.once) {
    await coordinator.close();
    await bugPool?.close();
    await closeSessionLog();
    return snapshotDevModel(model);
  }


  if (![...targets.values()].some(({ url }) => url === localTargetUrl)) {
    targets.set("local-engine", { url: localTargetUrl, name: `local:${servicePort}` });
    emit({ type: "target-configured", id: "local-engine", name: `local:${servicePort}`, url: localTargetUrl });
  }

  let builder;
  let builderPromise;
  let browserBundleReady = false;
  let developmentLoop = Promise.resolve();
  // A rejected promise must not be cached: a transient failure (a busy port, a
  // temporary filesystem error) would otherwise make every later build and
  // launch rethrow the same stale error for the lifetime of the session.
  const ensureBuilder = () => builderPromise ??= (services.createDefoldBuilder ?? createDefoldBuilder)({
    projectRoot,
    outputRoot: buildRoot,
    buildServer: options.buildServer,
    emit
  }).then((value) => (builder = value), (error) => {
    builderPromise = undefined;
    throw error;
  });
  const ensureDebugBrowserBundle = async (reason) => {
    if (browserBundleReady) return;
    const activeBuilder = await ensureBuilder();
    await prepareDebugWebBundle(activeBuilder, { webBundle: options.webBundle, reason });
    browserBundleReady = true;
  };
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
  const processChanges = (batch) => enqueue(async () => {
    const files = buildRelevantChanges(batch);
    if (!files.length) return;
    await coordinator.requestBuild(files);
    const requiresDefoldBuild = needsDefoldBuild(files, componentProxyChanged);
    componentProxyChanged = false;
    if (!requiresDefoldBuild) return;
    const activeBuilder = await ensureBuilder();
    const result = await activeBuilder.build(`changed ${files.length} file(s)`);
    if (needsEngineRestart(files)) {
      const wasRunning = engine.running();
      if (wasRunning) await engine.stop();
      if (wasRunning || options.autoLaunch !== false) await engine.launch();
    } else if (engine.running() && result.resources.length) {
      const resources = resourcesForBobReload(result.resources, [resourcePath], compilerReloadSignalled);
      if (resources.length) await coordinator.reloadResources(resources);
    }
  });

  await mkdir(buildRoot, { recursive: true });
  resourceServer = options.serve === false ? undefined : await (services.startResourceServer ?? startResourceServer)({
    root: buildRoot,
    host: options.serveHost,
    port: options.servePort,
    onError: (error) => emit({ type: "log", level: "error", source: "resource-server", message: error.message })
  });
  if (resourceServer) {
    emit({ type: "log", source: "resource-server", message: `serving ${buildRoot} at ${resourceServer.baseUrl}` });
  }
  const watcher = await (services.watchProject ?? watchProject)({
    root: options.watchRoot
      ? (path.isAbsolute(options.watchRoot) ? options.watchRoot : path.resolve(projectRoot, options.watchRoot))
      : projectRoot,
    debounceMs: options.debounceMs,
    ...createDevWatchOptions({
      projectRoot,
      outputFile,
      sourceMirror,
      buildMirror,
      lockFile: path.join(projectRoot, "deherm.lock"),
      generatedRoot,
      generatedProxyPaths
    }),
    onBatch: (files) => processChanges(files),
    onError: (error) => emit({ type: "log", level: "error", source: "watcher", message: error.message })
  });
  const startup = buildDefoldAndMaybeLaunch("initial dev startup", false).catch((error) => emit({
    type: "log",
    level: "error",
    source: "dev",
    message: `automatic Defold build/launch failed: ${error instanceof Error ? error.message : String(error)}`
  }));
  // The HTML5 target is opt-in at startup and always available on the `w`
  // intent. Launching it here is what lets a non-interactive session drive the
  // browser edit loop, and it waits for the first bundle so the page is pushed
  // a generation that exists.
  const webStartup = options.web
    ? startup.then(() => ensureDebugBrowserBundle("initial development browser launch"))
      .then(() => browser.launch())
      .then((started) => started && browser.activate(model.lastSuccessfulGeneration || undefined))
      .catch((error) => emit({
        type: "log",
        level: "error",
        source: "browser",
        message: `HTML5 target could not start: ${error instanceof Error ? error.message : String(error)}`
      }))
    : Promise.resolve();
  const close = async () => {
    watcher.close();
    await startup;
    await webStartup;
    await developmentLoop;
    await browser.stop();
    await engine.stop();
    await inspectorBridge?.close();
    await coordinator.close();
    await builder?.close();
    await resourceServer?.close();
    await bugPool?.close();
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
          else if (intent.type === "web") {
            // Launching serves the packaged wasm-web bundle on a scoped
            // loopback port, opens it in a dedicated headless Chrome profile,
            // and pushes the current bundle in. Stopping releases all three.
            //
            // A missing bundle is BUILT rather than reported, matching `play`,
            // which builds before launching when the build is not ready. The
            // asymmetry was a papercut: pressing this key on a fresh checkout
            // said a bundle was missing and left the user to work out which
            // command produces one. It is a slow operation - a bundle resolves
            // native extensions through an Extender - so it is announced.
            const launchBrowser = async () => {
              if (!browserBundleReady) {
                emit({ type: "log", source: "browser", message: "preparing a debug wasm-web bundle (this resolves native extensions and takes a while)" });
                await ensureDebugBrowserBundle("manual development browser launch");
              }
              return await browser.launch();
            };
            const action = browser.running()
              ? browser.stop()
              : launchBrowser().then(async (started) => {
                if (started) await browser.activate(model.lastSuccessfulGeneration || undefined);
                return started;
              });
            void action.catch((error) => emit({
              type: "log",
              level: "error",
              source: "browser",
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
          // Targets, generations, instances, the palette, and help are console
          // views over this session's own snapshot; they need no session work.
          // Anything else reaching here is a console/session contract drift.
          else emit({ type: "log", level: "warn", source: "tui", message: `unhandled console intent: ${intent.type}` });
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
