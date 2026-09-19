import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(process.argv[2]);
const project = path.resolve(process.argv[3]);
const { runDevSession } = await import(pathToFileURL(path.join(
  packageRoot,
  "packages/cli/src/dev/session.mjs"
)).href);
const { HotReloadCoordinator } = await import(pathToFileURL(path.join(
  packageRoot,
  "packages/cli/src/dev/coordinator.mjs"
)).href);
const { createWatchPathFilter } = await import(pathToFileURL(path.join(
  packageRoot,
  "packages/cli/src/dev/watcher.mjs"
)).href);

const events = [];
const builds = [];
const reloadBatches = [];
let running = false;
let launches = 0;
let stops = 0;
let lifecycle = 0;
const tick = setInterval(() => { if (running) lifecycle += 1; }, 10);

async function waitFor(description, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createPollingWatcher(options) {
  const candidates = [
    "src/feature.ts",
    "main/tiles.atlas",
    "main/battle.gui.ts",
    ".internal/cache/digest"
  ];
  const filter = createWatchPathFilter(options.root, options);
  const identity = new Map();
  const readIdentity = async (relative) => {
    try {
      const value = await stat(path.join(options.root, relative));
      return `${value.size}:${value.mtimeMs}`;
    } catch {
      return undefined;
    }
  };
  for (const relative of candidates) identity.set(relative, await readIdentity(relative));
  let closed = false;
  let polling = false;
  const interval = setInterval(async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const changed = [];
      for (const relative of candidates) {
        const next = await readIdentity(relative);
        if (identity.get(relative) === next) continue;
        identity.set(relative, next);
        const included = filter(path.join(options.root, relative));
        if (included) changed.push(included);
      }
      if (changed.length) await options.onBatch(changed.sort());
    } catch (error) {
      options.onError?.(error);
    } finally {
      polling = false;
    }
  }, 10);
  return { root: options.root, close() { closed = true; clearInterval(interval); } };
}

const services = {
  onEvent(event) { events.push(event); },
  watchProject: createPollingWatcher,
  createCoordinator({ compiler, targets, emit }) {
    return new HotReloadCoordinator({
      compiler,
      targets,
      emit,
      async postReload(_url, resources) { reloadBatches.push([...resources]); }
    });
  },
  async createDefoldBuilder({ emit }) {
    return {
      async build(reason) {
        emit({ type: "defold-build-started", reason });
        builds.push(reason);
        const resources = reason.startsWith("changed ")
          ? [`/compiled/change-${builds.length}.resourcec`]
          : [];
        emit({ type: "defold-build-succeeded", reason, resources });
        return { resources, outputRoot: path.join(project, "build", "default"), platform: "test" };
      },
      async close() {}
    };
  },
  createEngineController({ emit }) {
    return {
      running: () => running,
      async launch() {
        if (running) return false;
        running = true;
        launches += 1;
        emit({ type: "engine-started", executable: "fixture-engine", pid: 4242 });
        return true;
      },
      async stop() {
        if (!running) return false;
        running = false;
        stops += 1;
        emit({ type: "engine-stopped", code: 0, signal: "SIGTERM" });
        return true;
      }
    };
  },
  async runDevTui({ onIntent }) {
    await waitFor("startup build", () => builds.includes("initial dev startup"));
    if (launches !== 0) throw new Error("--no-launch started the engine");

    onIntent({ type: "play" });
    await waitFor("manual p launch", () => launches === 1 && running);
    if (builds.includes("manual launch")) throw new Error("p rebuilt an already-ready Defold project");
    const buildsAfterPlay = builds.length;
    const generationAfterPlay = events.filter((event) => event.type === "build-succeeded").length;

    await mkdir(path.join(project, ".internal", "cache"), { recursive: true });
    await writeFile(path.join(project, ".internal", "cache", "digest"), "ignored");
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (builds.length !== buildsAfterPlay ||
        events.filter((event) => event.type === "build-succeeded").length !== generationAfterPlay) {
      throw new Error(".internal/cache triggered work");
    }

    const tsReloadStart = reloadBatches.length;
    const lifecycleBeforeTs = lifecycle;
    await writeFile(path.join(project, "src", "feature.ts"), 'export const value = "second";\n');
    await waitFor(
        "one TS rebuild and reload",
        () => events.some((event) => event.type === "reload-signalled" && event.generation === 2));
    if (builds.length !== buildsAfterPlay) throw new Error("plain TS edit invoked Bob");
    if (reloadBatches.length !== tsReloadStart + 1) {
      throw new Error(`plain TS edit emitted ${reloadBatches.length - tsReloadStart} reload requests`);
    }
    await waitFor("continued lifecycle after TS reload", () => lifecycle > lifecycleBeforeTs);

    const assetBuildStart = builds.length;
    const assetReloadStart = reloadBatches.length;
    await writeFile(path.join(project, "main", "tiles.atlas"), 'images { image: "/main/tile-2.png" }\n');
    await waitFor("asset Bob build", () => builds.length === assetBuildStart + 1);
    await waitFor("asset compiled-resource reload", () => reloadBatches.length >= assetReloadStart + 2);

    const componentBuildStart = builds.length;
    const componentReloadStart = reloadBatches.length;
    await writeFile(path.join(project, "main", "battle.gui.ts"), [
      "function defineComponent(definition) { return definition; }",
      "export default defineComponent({ update(_dt) {}, onReload() {} });",
      ""
    ].join("\n"));
    await waitFor("component Bob build", () => builds.length === componentBuildStart + 1);
    await waitFor(
        "component compiled-resource reload",
        () => reloadBatches.length >= componentReloadStart + 2);
  }
};

try {
  try {
    const snapshot = await runDevSession({
      project,
      entry: path.join(project, "src", "main.ts"),
      autoLaunch: false,
      serve: false,
      servicePort: 38123,
      debounceMs: 20,
      useTtsc: false,
      // Host-compiler distribution is covered by the toolchain matrix. This
      // installed-package fixture owns watcher/coordinator behavior and must be
      // deterministic without a release download.
      bytecode: false,
      services
    });
    console.log(`DEV_LOOP_RESULT ${JSON.stringify({
      builds,
      launches,
      stops,
      lifecycle,
      reloadBatches,
      bundleGenerations: events.filter((event) => event.type === "build-succeeded").map((event) => event.generation),
      bundleFingerprints: events.filter((event) => event.type === "build-succeeded").map((event) => event.fingerprint),
      phase: snapshot.phase
    })}`);
  } catch (error) {
    console.error(`DEV_LOOP_FAILURE ${JSON.stringify({ builds, launches, stops, lifecycle, reloadBatches, events })}`);
    throw error;
  }
} finally {
  clearInterval(tick);
}
