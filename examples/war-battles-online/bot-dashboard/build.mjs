#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const outputArgument = process.argv.find((argument) => argument.startsWith("--outdir="));
const output = path.resolve(root, outputArgument?.slice("--outdir=".length) ?? "dist");

await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "client.ts")],
  outfile: path.join(output, "client.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "silent",
});
await cp(path.join(root, "index.html"), path.join(output, "index.html"));
console.log(`war-battles-network-bot-dashboard:built:${output}`);
