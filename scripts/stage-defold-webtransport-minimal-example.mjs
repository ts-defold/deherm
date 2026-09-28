#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function stageMinimalWebTransportExample({
  exampleRoot = path.join(root, "examples/defold-webtransport-minimal"),
  extensionRoot,
  outputRoot,
}) {
  if (!extensionRoot) throw new Error("extensionRoot is required");
  if (!outputRoot) throw new Error("outputRoot is required");
  const sourceExtension = path.join(path.resolve(extensionRoot), "defold_webtransport");
  const destination = path.resolve(outputRoot);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(path.join(exampleRoot, "main"), path.join(destination, "main"), { recursive: true });
  const project = (await readFile(path.join(exampleRoot, "game.project"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => !/^dependencies#\d+\s*=/u.test(line))
    .join("\n");
  await writeFile(path.join(destination, "game.project"), project.endsWith("\n") ? project : `${project}\n`);
  await cp(sourceExtension, path.join(destination, "defold_webtransport"), { recursive: true });
  return destination;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`${name} requires a value`);
  return path.resolve(argv[index + 1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = await stageMinimalWebTransportExample({
    extensionRoot: argument(process.argv, "--extension"),
    outputRoot: argument(process.argv, "--output"),
  });
  console.log(destination);
}
