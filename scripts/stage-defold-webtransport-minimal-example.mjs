#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function stageMinimalWebTransportExample({
  exampleRoot = path.join(root, "examples/defold-webtransport-minimal"),
  archive,
  outputRoot,
}) {
  if (!archive) throw new Error("archive is required");
  if (!outputRoot) throw new Error("outputRoot is required");
  const members = unzipSync(new Uint8Array(await readFile(path.resolve(archive))));
  const names = Object.keys(members).sort();
  const extensionPrefix = "defold_webtransport/";
  const unexpected = names.filter((name) => name !== "game.project" && !name.startsWith(extensionPrefix));
  if (unexpected.length) throw new Error(`archive has unexpected members: ${unexpected.join(", ")}`);
  if (!members["game.project"]) throw new Error("archive has no root game.project");
  for (const name of names) {
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`archive has unsafe member path: ${name}`);
    }
  }
  const extensionMembers = names.filter((name) => name.startsWith(extensionPrefix));
  if (!extensionMembers.includes(`${extensionPrefix}ext.manifest`)) {
    throw new Error("archive has no defold_webtransport/ext.manifest");
  }
  const destination = path.resolve(outputRoot);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(path.join(exampleRoot, "main"), path.join(destination, "main"), { recursive: true });
  await cp(path.join(exampleRoot, "input"), path.join(destination, "input"), { recursive: true });
  const project = (await readFile(path.join(exampleRoot, "game.project"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => !/^dependencies#\d+\s*=/u.test(line))
    .join("\n");
  await writeFile(path.join(destination, "game.project"), project.endsWith("\n") ? project : `${project}\n`);
  for (const member of extensionMembers) {
    const relative = member.slice(extensionPrefix.length);
    if (!relative || relative.split("/").some((segment) => !segment || segment === ".")) {
      throw new Error(`archive has invalid extension member path: ${member}`);
    }
    const target = path.join(destination, "defold_webtransport", ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, members[member]);
  }
  return destination;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`${name} requires a value`);
  return path.resolve(argv[index + 1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = await stageMinimalWebTransportExample({
    archive: argument(process.argv, "--archive"),
    outputRoot: argument(process.argv, "--output"),
  });
  console.log(destination);
}
