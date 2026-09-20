#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hermesRoot = path.join(repositoryRoot, "upstream", "hermes");
const extensionInclude = path.join(repositoryRoot, "defold", "defold_hermes", "include");

const lock = await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8");
const expectedRevision = /^HERMES_REV=(.+)$/m.exec(lock)?.[1];
if (!expectedRevision) throw new Error("upstream.lock does not declare HERMES_REV");
let actualRevision;
try {
  actualRevision = execFileSync("git", ["-C", hermesRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  throw new Error("Hermes upstream is unavailable; run pnpm bootstrap:upstreams before packing.");
}
if (actualRevision !== expectedRevision) {
  throw new Error(`Hermes public headers are at ${actualRevision}, expected pinned revision ${expectedRevision}`);
}

await rm(path.join(extensionInclude, "hermes"), { recursive: true, force: true });
await rm(path.join(extensionInclude, "jsi"), { recursive: true, force: true });

const copies = Object.freeze([
  ["API/hermes/hermes.h", "hermes/hermes.h"],
  ["API/jsi/jsi", "jsi"],
  ["public/hermes/Public", "hermes/Public"],
]);

for (const [sourceRelative, destinationRelative] of copies) {
  const source = path.join(hermesRoot, sourceRelative);
  const destination = path.join(extensionInclude, destinationRelative);
  let information;
  try {
    information = await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Hermes public headers are unavailable at ${sourceRelative}; run pnpm bootstrap:upstreams before packing.`
      );
    }
    throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  if (information.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".h")) {
        await cp(path.join(source, entry.name), path.join(destination, entry.name));
      }
    }
  } else {
    await cp(source, destination);
  }
}

console.error("ok staged Hermes public headers for the Defold extension");
