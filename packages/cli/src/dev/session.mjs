import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  componentProxyConstants,
  generateComponentProxies
} from "../../../../scripts/lib/component-proxy-generator.mjs";
import { createIncrementalCompiler } from "./compiler.mjs";
import { HotReloadCoordinator } from "./coordinator.mjs";
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

async function resolveEntry(projectRoot, requested) {
  if (requested) return path.resolve(requested);
  const candidates = [
    path.join(projectRoot, "src", "main.ts")
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("deherm dev needs --entry <file>; no src/main.ts was found");
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

const componentSourceSuffixes = componentProxyConstants.sourceKinds.map(({ suffix }) => suffix);
const componentProxySuffixes = componentSourceSuffixes.map((suffix) => suffix.slice(0, -3));

function isComponentSource(file) {
  return componentSourceSuffixes.some((suffix) => file.endsWith(suffix));
}

function isComponentProxy(file) {
  return componentProxySuffixes.some((suffix) => file.endsWith(suffix));
}

export function createDevWatchOptions({ outputFile, sourceMirror, buildMirror }) {
  return {
    ignoredPaths: [outputFile, sourceMirror, buildMirror].flatMap((file) => [file, `${file}.map`]),
    shouldIgnore: (_file, relative) => isComponentProxy(relative) || relative.includes(".deherm-tmp-")
  };
}

export async function runDevSession(options = {}) {
  const projectRoot = path.resolve(options.project ?? process.cwd());
  const entryPoint = await resolveEntry(projectRoot, options.entry);
  const outputFile = path.resolve(options.outputFile ?? path.join(projectRoot, ".deherm", "dev", "app.dehermc"));
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
    if (options.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, event })}\n`);
    else if (lineOutput) {
      const detail = event.diagnostic ? `: ${event.diagnostic}` : "";
      process.stdout.write(`[deherm] ${event.type} generation=${event.generation ?? "-"}${detail}\n`);
    }
    for (const listener of listeners) listener(event);
  };
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
  const compiler = await createIncrementalCompiler({
    entryPoint,
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
  const coordinator = new HotReloadCoordinator({ compiler, targets, emit });
  await coordinator.requestBuild([path.relative(projectRoot, entryPoint).split(path.sep).join("/") || path.basename(entryPoint)]);

  if (options.once) {
    await coordinator.close();
    return snapshotDevModel(model);
  }

  await mkdir(buildRoot, { recursive: true });
  const resourceServer = options.serve === false ? undefined : await startResourceServer({
    root: buildRoot,
    host: options.serveHost,
    port: options.servePort,
    onError: (error) => emit({ type: "log", level: "error", source: "resource-server", message: error.message })
  });
  if (resourceServer) {
    emit({ type: "log", source: "resource-server", message: `serving ${buildRoot} at ${resourceServer.baseUrl}` });
  }
  const watcher = await watchProject({
    root: path.resolve(options.watchRoot ?? projectRoot),
    debounceMs: options.debounceMs,
    ...createDevWatchOptions({ outputFile, sourceMirror, buildMirror }),
    onBatch: (files) => coordinator.requestBuild(files),
    onError: (error) => emit({ type: "log", level: "error", source: "watcher", message: error.message })
  });
  const close = async () => {
    watcher.close();
    await coordinator.close();
    await resourceServer?.close();
  };
  if (!options.headless && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const { runDevTui } = await import("./tui.mjs");
    try {
      await runDevTui({
        snapshot: () => snapshotDevModel(model),
        onIntent(intent) {
          if (intent.type === "reload" || intent.type === "rebuild") {
            void coordinator.requestBuild([]).catch((error) => emit({
              type: "log",
              level: "error",
              source: "coordinator",
              message: error.message
            }));
          }
          else emit({ type: "log", source: "tui", message: `${intent.type} panel is staged but not implemented` });
        }
      });
    } finally {
      await close();
    }
  } else {
    await waitForSignal();
    await close();
  }
  return snapshotDevModel(model);
}
