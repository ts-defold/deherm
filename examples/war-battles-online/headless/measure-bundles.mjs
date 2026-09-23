#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { build, version as esbuildVersion } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const headless = await bundle(join(root, "headless/run-match.mjs"), {
  platform: "node",
  target: "node22",
  external: [],
});
const defold = await bundle(join(root, "defold/reference/battle.gui.ts"), {
  platform: "neutral",
  target: "es2020",
  external: ["@deherm/project"],
});
const sourceFiles = await collectFiles(root, ["core", "integration", "headless", "defold"]);
let sourceBytes = 0;
for (const path of sourceFiles) sourceBytes += (await readFile(path)).byteLength;

const report = {
  schemaVersion: 1,
  observedOn: "2026-09-22",
  esbuildVersion,
  scope: "JavaScript bundle evidence only; not a Defold package or Hermes bytecode measurement",
  sourceFileCount: sourceFiles.length,
  sourceBytes,
  artifacts: {
    headlessNodeBundle: metrics(headless),
    defoldGuiDiagnosticBundle: metrics(defold),
  },
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(new URL("../evidence/bundle-size.json", import.meta.url), serialized);
}
process.stdout.write(serialized);

async function bundle(entryPoint, options) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    target: options.target,
    treeShaking: true,
    legalComments: "none",
    minify: true,
    platform: options.platform,
    external: options.external,
  });
  if (result.outputFiles.length !== 1) throw new Error("expected exactly one bundle output");
  return result.outputFiles[0].contents;
}

function metrics(bytes) {
  return {
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectFiles(base, directories) {
  const output = [];
  for (const directory of directories) await walk(join(base, directory), output);
  return output.sort();
}

async function walk(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Source evidence must not depend on whether this checkout has staged the
    // generated runtime extension or an optional typed-native unit. Both trees
    // are installed build inputs with their own manifests, not War Battles
    // source, and their contents legitimately vary by selected target. The
    // typed-native selector also owns the project-root `.defignore`; its
    // presence changes with the requested Bob target and belongs to that same
    // generated build state rather than the authored source census.
    if (entry.isFile() && entry.name === ".defignore") continue;
    if (entry.isDirectory() && [
      ".deherm",
      ".internal",
      ".vscode",
      "build",
      "deherm",
      "defold_hermes",
      "defold_hermes_typed_native"
    ].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isSymbolicLink()) continue;
    else output.push(path);
  }
}
