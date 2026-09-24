import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Project-local tooling that can never be a Defold resource or native
 * extension input. Bob recursively discovers extensions below its project
 * root, so leaving any of these trees visible is both wasteful and unsafe: an
 * installed npm package can contain its own revision-neutral extension seed.
 *
 * Keep this list conservative. Authored resource directories do not belong
 * here merely because a particular game does not currently reference them.
 */
export const BOB_TOOLING_IGNORE_ENTRIES = Object.freeze([
  "/node_modules",
  "/.deherm",
  "/.internal",
  "/build",
  "/.git",
  "/.github",
  "/.vscode",
  "/.idea"
]);

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
  const required = [
    ...BOB_TOOLING_IGNORE_ENTRIES,
    ...(options.includeEntries ?? [])
  ].map(normalizeManagedEntry);
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
  const seen = new Set();
  const next = [];
  for (const line of parseLines(existing)) {
    const rawEntry = line.trim();
    const entry = rawEntry.startsWith("/") ? rawEntry.replace(/\/+$/u, "") : rawEntry;
    if (removed.has(entry)) continue;
    if (requiredSet.has(entry)) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      next.push(entry);
      continue;
    }
    next.push(line);
  }
  for (const entry of required) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry);
  }

  while (next.at(-1) === "") next.pop();
  const output = `${next.join("\n")}\n`;
  const changed = output !== existing;
  if (changed) await writeFile(defignore, output);
  return {
    projectRoot,
    defignore,
    changed,
    entries: [...seen]
  };
}
