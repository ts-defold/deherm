import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const BOB_MANAGED_IGNORE_BEGIN = "# BEGIN deherm managed Bob exclusions";
export const BOB_MANAGED_IGNORE_END = "# END deherm managed Bob exclusions";

/**
 * Project-local tooling that must never be a Defold resource or native
 * extension input. Bob recursively discovers extensions below its project
 * root, so leaving any of these trees visible is both wasteful and unsafe: an
 * installed npm package can contain its own revision-neutral extension seed.
 *
 * Keep this list conservative. Authored resource directories do not belong
 * here merely because a particular game does not currently reference them.
 */
export const BOB_TOOLING_IGNORE_DIRECTORIES = Object.freeze([
  "/node_modules",
  "/.deherm",
  "/.internal",
  "/build",
  "/.git",
  "/.github",
  "/.vscode",
  "/.idea",
  "/.agents"
]);

export const BOB_TOOLING_IGNORE_ENTRIES = Object.freeze([
  ...BOB_TOOLING_IGNORE_DIRECTORIES,
  "/package.json",
  "/package-lock.json",
  "/npm-shrinkwrap.json",
  "/pnpm-lock.yaml",
  "/pnpm-workspace.yaml",
  "/yarn.lock",
  "/bun.lock",
  "/bun.lockb",
  "/.npmrc",
  "/.nvmrc",
  "/.node-version",
  "/tsconfig.json",
  "/tsconfig.deherm.json",
  "/tsconfig.deherm.base.json",
  "/tsconfig.deherm.shared.json",
  "/tsconfig.deherm.game-object.json",
  "/tsconfig.deherm.gui.json",
  "/tsconfig.deherm.render.json",
  "/tsconfig.deherm.bundle.json",
  "/tsconfig.deherm.release.json",
  "/deherm.lock",
  "/AGENTS.md",
  "/CHANGELOG.md",
  "/LICENSE",
  "/README.md"
]);

// Every file kind the TypeScript compiler/bundler can consume as authoring
// input. Defold does not consume these directly: déherm emits the corresponding
// proxy resource and/or app.dehermc. Keep this explicit because `.defignore`
// accepts path prefixes, not globs, at the pinned Defold revision.
const BOB_AUTHORING_SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);

const bobWalkPrunedDirectories = new Set(
  BOB_TOOLING_IGNORE_DIRECTORIES.map((entry) => entry.slice(1))
);

function normalizeManagedEntry(entry) {
  if (typeof entry !== "string" || !entry.startsWith("/") || /[\r\n]/u.test(entry)) {
    throw new Error(`Bob ignore entries must be absolute project paths: ${String(entry)}`);
  }
  const normalized = entry.replace(/\/+$/u, "");
  if (!normalized) throw new Error("Bob cannot ignore the project root");
  return normalized;
}

function parseLines(source) {
  if (!source) return [];
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function portable(value) {
  return value.split(path.sep).join("/");
}

function customResourceEntries(source) {
  const entries = [];
  let section = "";
  for (const original of source.split(/\r?\n/u)) {
    const line = original.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (section !== "project") continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "custom_resources" && !/^custom_resources#\d+$/u.test(key)) continue;
    for (const value of line.slice(separator + 1).split(",")) {
      const normalized = value.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
      if (normalized.startsWith("/") && normalized !== "/") entries.push(normalized);
    }
  }
  return [...new Set(entries)].sort();
}

async function projectCustomResourceEntries(projectRoot) {
  try {
    return customResourceEntries(await readFile(path.join(projectRoot, "game.project"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function isCustomResource(entry, customResources) {
  return customResources.some((resource) => entry === resource || entry.startsWith(`${resource}/`));
}

/**
 * TypeScript authoring inputs are compiled into `/deherm/app.dehermc` or into
 * generated Lua proxy resources. They are never themselves Defold resources.
 * Discovering their exact paths keeps sibling generated `.script`, `.gui_script`,
 * and `.render_script` files visible instead of excluding a whole source tree.
 */
export async function discoverBobAuthoringIgnoreEntries(projectRoot) {
  const root = path.resolve(projectRoot);
  const entries = [];
  async function visit(directory, relativeDirectory = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      if (child.isDirectory()) {
        if (!relativeDirectory && bobWalkPrunedDirectories.has(child.name)) continue;
        await visit(path.join(directory, child.name), relative);
        continue;
      }
      if (child.isSymbolicLink()) {
        if (BOB_AUTHORING_SOURCE_EXTENSIONS.some((extension) => child.name.endsWith(extension))) {
          entries.push(`/${portable(relative)}`);
        }
        continue;
      }
      // Never follow a symlink out of the project while deriving Bob inputs.
      if (!child.isFile() || !BOB_AUTHORING_SOURCE_EXTENSIONS.some((extension) => child.name.endsWith(extension))) continue;
      entries.push(`/${portable(relative)}`);
    }
  }
  await visit(root);
  return entries;
}

export function renderBobManagedIgnoreBlock(entries) {
  return [BOB_MANAGED_IGNORE_BEGIN, ...entries, BOB_MANAGED_IGNORE_END].join("\n");
}

function withoutManagedBlock(lines) {
  const output = [];
  let inside = false;
  for (const line of lines) {
    if (line === BOB_MANAGED_IGNORE_BEGIN) {
      if (inside) throw new Error("Nested deherm Bob exclusion blocks are invalid");
      inside = true;
      continue;
    }
    if (line === BOB_MANAGED_IGNORE_END) {
      if (!inside) throw new Error("Orphaned deherm Bob exclusion block terminator");
      inside = false;
      continue;
    }
    if (!inside) output.push(line);
  }
  if (inside) throw new Error("Unterminated deherm Bob exclusion block");
  return output;
}

/**
 * Reconcile the package-owned portion of a project's `.defignore`.
 *
 * Unknown line content and order are preserved. Package-owned entries are
 * canonicalized and de-duplicated, optional entries can be toggled in the same
 * write, and the operation is idempotent. This is deliberately a build-time
 * backstop as well as a scaffold default: existing projects and projects made
 * by other tools receive the same safe Bob input boundary.
 */
export async function reconcileBobProjectBoundary(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const defignore = path.join(projectRoot, ".defignore");
  const authored = options.discoverAuthoringSources === false
    ? []
    : await discoverBobAuthoringIgnoreEntries(projectRoot);
  const customResources = await projectCustomResourceEntries(projectRoot);
  const optionalDefaults = BOB_TOOLING_IGNORE_ENTRIES
    .slice(BOB_TOOLING_IGNORE_DIRECTORIES.length)
    .filter((entry) => !isCustomResource(entry, customResources));
  const required = [
    ...BOB_TOOLING_IGNORE_DIRECTORIES,
    ...optionalDefaults,
    ...authored.filter((entry) => !isCustomResource(entry, customResources)),
    ...(options.includeEntries ?? [])
  ].map(normalizeManagedEntry).filter((entry, index, all) => all.indexOf(entry) === index);
  const removed = new Set((options.excludeEntries ?? []).map(normalizeManagedEntry));
  const conflict = required.find((entry) => removed.has(entry));
  if (conflict) throw new Error(`Bob ignore entry cannot be both required and removed: ${conflict}`);

  let existing = "";
  try {
    existing = await readFile(defignore, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const requiredSet = new Set(required);
  const legacyManagedSet = new Set([...BOB_TOOLING_IGNORE_ENTRIES, ...(options.includeEntries ?? []), ...(options.excludeEntries ?? [])]
    .map(normalizeManagedEntry));
  const unmanaged = withoutManagedBlock(parseLines(existing));
  const next = [];
  for (const line of unmanaged) {
    const rawEntry = line.trim();
    const entry = rawEntry.startsWith("/") ? rawEntry.replace(/\/+$/u, "") : rawEntry;
    if (removed.has(entry)) continue;
    // Migrate the unmarked format emitted before the managed block existed.
    if (legacyManagedSet.has(entry) || requiredSet.has(entry)) continue;
    next.push(line);
  }

  while (next.at(-1) === "") next.pop();
  if (next.length) next.push("");
  next.push(renderBobManagedIgnoreBlock(required));
  const output = `${next.join("\n")}\n`;
  const changed = output !== existing;
  if (changed) await writeFile(defignore, output);
  return {
    projectRoot,
    defignore,
    changed,
    entries: required,
    authoredEntries: authored,
    customResources
  };
}
