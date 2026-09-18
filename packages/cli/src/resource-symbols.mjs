import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildResourceSymbolTable,
  readResource,
  resourcePath
} from "../../compiler/src/resource-symbol-table.mjs";
import { componentProxyConstants } from "../../compiler/src/component-proxy-contract.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { sourceKinds } = componentProxyConstants;
const ignoredDirectories = new Set([".deherm", ".git", ".internal", "build", "dist", "node_modules", "upstream"]);

function portable(value) {
  return value.split(path.sep).join("/");
}

function schemaExtensions(schema) {
  return [...schema.resources].map(({ extension }) => extension).sort((left, right) => right.length - left.length);
}

const generatedBindings = path.join(packageRoot, "packages", "bindings", "generated");

/** Pinned inputs the symbol table is derived from. */
export async function loadResourceClassification({
  schemaPath = path.join(generatedBindings, "defold-resource-declaration-schema.json"),
  classificationPath = path.join(generatedBindings, "defold-script-resource-namespaces.json")
} = {}) {
  const [schema, classification] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(classificationPath, "utf8")
  ]);
  return { schema: JSON.parse(schema), classification: JSON.parse(classification) };
}

async function walkProject(projectRoot) {
  const resources = [];
  const componentSources = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = portable(path.relative(projectRoot, absolute));
      if (sourceKinds.some(({ suffix }) => entry.name.endsWith(suffix))) {
        componentSources.push(relative);
        continue;
      }
      resources.push({ relative, absolute });
    }
  }
  await visit(path.resolve(projectRoot));
  return { resources, componentSources };
}

/**
 * Build the project symbol table from the resources on disk.
 *
 * Unreadable or unparsable resources become diagnostics rather than failures:
 * a project that cannot be fully read still compiles, it simply loses the
 * checks that would have come from the missing declarations.
 */
export async function buildProjectResourceSymbols(projectRoot, options = {}) {
  const { schema, classification } = options.pinned ?? await loadResourceClassification();
  const extensions = schemaExtensions(schema);
  const { resources, componentSources } = await walkProject(projectRoot);
  const diagnostics = [];
  const parsed = [];
  for (const { relative, absolute } of resources) {
    const name = relative.split("/").pop() ?? "";
    if (!extensions.some((extension) => name.endsWith(extension))) continue;
    let source;
    try {
      source = await readFile(absolute, "utf8");
    } catch (error) {
      diagnostics.push({ severity: "warning", path: relative, message: `unreadable resource: ${error.message}` });
      continue;
    }
    try {
      parsed.push(readResource({ path: relative, source, schema }));
    } catch (error) {
      diagnostics.push({ severity: "warning", path: relative, message: `unparsable resource: ${error.message}` });
    }
  }
  const componentTexts = new Map();
  for (const relative of componentSources) {
    try {
      componentTexts.set(relative, await readFile(path.join(projectRoot, relative), "utf8"));
    } catch (error) {
      diagnostics.push({ severity: "warning", path: relative, message: `unreadable component source: ${error.message}` });
    }
  }
  const table = buildResourceSymbolTable({ schema, classification, resources: parsed, componentSources, componentTexts });
  return {
    ...table,
    projectFile: "game.project",
    projectRootFrom: options.projectRootFrom ?? ".",
    resourceCount: parsed.length,
    componentCount: componentSources.length,
    diagnostics
  };
}

/** Write `<outputRoot>/generated/resource-symbols.json` for the ttsc transform. */
export async function writeProjectResourceSymbols(projectRoot, outputRoot, options = {}) {
  const directory = path.join(outputRoot, "generated");
  const table = await buildProjectResourceSymbols(projectRoot, {
    ...options,
    projectRootFrom: portable(path.relative(directory, path.resolve(projectRoot))) || "."
  });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "resource-symbols.json");
  await writeFile(file, `${JSON.stringify(table, null, 2)}\n`);
  return { file, table };
}

export { resourcePath };
