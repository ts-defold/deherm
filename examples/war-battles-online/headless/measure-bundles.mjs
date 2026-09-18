#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { build, version as esbuildVersion } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const headless = await bundle(join(root, "headless/run-match.mjs"), {
  platform: "node",
  target: "node22",
  external: [],
});
const defold = await bundle(join(root, "defold/src/controller.script.ts"), {
  platform: "neutral",
  target: "es2020",
  external: ["@deherm/project"],
});
const sourceFiles = await collectFiles(root, ["core", "integration", "headless", "defold"]);
let sourceBytes = 0;
for (const path of sourceFiles) sourceBytes += (await readFile(path)).byteLength;

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  observedOn: "2026-09-18",
  esbuildVersion,
  scope: "JavaScript bundle evidence only; not a Defold package or Hermes bytecode measurement",
  sourceFileCount: sourceFiles.length,
  sourceBytes,
  artifacts: {
    headlessNodeBundle: metrics(headless),
    defoldControllerDiagnosticBundle: metrics(defold),
  },
}, null, 2)}\n`);

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
    if (entry.isDirectory() && entry.name === ".deherm") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else output.push(path);
  }
}
