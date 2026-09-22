import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const defaultIgnored = new Set([".deherm", ".git", ".internal", "build", "dist", "node_modules", "upstream"]);

// Atomic writers create a scratch file, write it, then rename it onto the real
// path. Watching the scratch name schedules work against a file that no longer
// exists by the time the build runs, so a rebuild fails for a reason the author
// never caused. Covers `<name>.tmp`, `<name>.tmp-<pid>[-<digest>]`,
// `<name>.tmp.<pid>.<digest>`, `<name>.deherm-tmp-<pid>[-<sequence>]`,
// `<name>.deherm-replace-<pid>-<digest>`, and the usual editor scratch and
// backup names.
const temporaryArtifact = /(?:\.(?:deherm-)?tmp(?:[-.](?:\d+|[0-9a-f]{6,}))*|\.deherm-replace-\d+-[0-9a-f]{6,}|\.sw[a-p]|~|\.orig|\.rej|\.bak)$/i;
const editorScratch = /^(?:\.#|#|\.~lock\.)/;

export function isTemporaryArtifact(relative) {
  const name = relative.split(/[\\/]/).at(-1) ?? "";
  return temporaryArtifact.test(name) || editorScratch.test(name);
}

function ignored(relative, ignoredNames) {
  return relative.split(path.sep).some((part) => ignoredNames.has(part));
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
}

function ignoredPath(relative, ignoredPaths) {
  return ignoredPaths.some((candidate) => relative === candidate || relative.startsWith(`${candidate}/`));
}

export function createWatchPathFilter(rootValue, options = {}) {
  const root = path.resolve(rootValue);
  const ignoredNames = new Set([...defaultIgnored, ...(options.ignoredNames ?? [])]);
  const ignoredPaths = (options.ignoredPaths ?? []).map((file) => {
    const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
    return normalizeRelative(relative);
  }).filter((relative) => relative && relative !== ".." && !relative.startsWith("../"));
  return (file) => {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || ignored(relative, ignoredNames)) return undefined;
    if (isTemporaryArtifact(relative)) return undefined;
    const normalized = normalizeRelative(relative);
    if (ignoredPath(normalized, ignoredPaths) || options.shouldIgnore?.(file, normalized)) return undefined;
    return normalized;
  };
}

async function directories(root, ignoredNames) {
  const found = [root];
  for (let index = 0; index < found.length; index += 1) {
    const directory = found[index];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (!ignored(path.relative(root, child), ignoredNames)) found.push(child);
    }
  }
  return found;
}

export async function watchProject(options) {
  const root = path.resolve(options.root);
  const ignoredNames = new Set([...defaultIgnored, ...(options.ignoredNames ?? [])]);
  const filterPath = createWatchPathFilter(root, options);
  const watchers = new Map();
  const changed = new Set();
  let timer;
  let closed = false;

  const flush = () => {
    timer = undefined;
    if (!changed.size || closed) return;
    const batch = [...changed].sort();
    changed.clear();
    Promise.resolve(options.onBatch(batch)).catch(options.onError ?? (() => {}));
  };
  const queue = (file) => {
    const normalized = filterPath(file);
    if (!normalized) return;
    changed.add(normalized);
    clearTimeout(timer);
    timer = setTimeout(flush, options.debounceMs ?? 40);
  };
  const addDirectory = (directory) => {
    if (watchers.has(directory) || closed) return;
    const handle = watch(directory, (event, filename) => {
      if (!filename) return;
      queue(path.join(directory, filename.toString()));
      if (event === "rename") void refresh().catch(options.onError ?? (() => {}));
    });
    handle.on("error", options.onError ?? (() => {}));
    watchers.set(directory, handle);
  };
  const refresh = async () => {
    const current = new Set(await directories(root, ignoredNames));
    for (const directory of current) addDirectory(directory);
    for (const [directory, handle] of watchers) {
      if (current.has(directory)) continue;
      handle.close();
      watchers.delete(directory);
    }
  };

  await refresh();
  return {
    root,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const handle of watchers.values()) handle.close();
      watchers.clear();
    }
  };
}
