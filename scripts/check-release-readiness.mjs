#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = "0.1.0";

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

async function requireFile(relative) {
  await access(path.join(root, relative));
}

async function workspaceManifests() {
  const files = ["package.json"];
  for (const parent of ["packages", "editors", "examples"]) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(parent, entry.name, "package.json");
      try {
        await requireFile(relative);
        files.push(relative);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return files.sort();
}

const failures = [];
for (const manifestFile of await workspaceManifests()) {
  const manifest = await json(manifestFile);
  if (manifest.version !== releaseVersion) {
    failures.push(`${manifestFile}: expected version ${releaseVersion}, received ${manifest.version ?? "<missing>"}`);
  }
}

const standaloneVersion = (await readFile(path.join(root, "extensions/defold-webtransport/VERSION"), "utf8")).trim();
if (standaloneVersion !== releaseVersion) failures.push(`Defold WebTransport VERSION is ${standaloneVersion}`);
const standaloneProject = await readFile(path.join(root, "extensions/defold-webtransport/game.project"), "utf8");
if (!new RegExp(`^version\\s*=\\s*${releaseVersion.replaceAll(".", "\\.")}\\s*$`, "mu").test(standaloneProject)) {
  failures.push("Defold WebTransport game.project does not match VERSION");
}

for (const changelog of [
  "CHANGELOG.md",
  "editors/vscode/CHANGELOG.md",
  "extensions/defold-webtransport/defold_webtransport/CHANGELOG.md",
]) {
  const source = await readFile(path.join(root, changelog), "utf8");
  if (!source.includes(`## ${releaseVersion} - Unreleased`))
    failures.push(`${changelog}: missing ${releaseVersion} entry`);
}

for (const required of [
  "extensions/defold-webtransport/defold_webtransport/licenses/LICENSE.txt",
  "extensions/defold-webtransport/defold_webtransport/licenses/THIRD_PARTY_NOTICES.md",
  "extensions/defold-webtransport/defold_webtransport/licenses/Apache-2.0-Mbed-TLS.txt",
  "extensions/defold-webtransport/defold_webtransport/licenses/BSD-2-Clause-micro-ecc.txt",
  "extensions/defold-webtransport/defold_webtransport/licenses/CC0-1.0-cifra.txt",
  "extensions/defold-webtransport/defold_webtransport/licenses/MIT-picoquic.txt",
  "extensions/defold-webtransport/defold_webtransport/licenses/MIT-picotls.txt",
  "examples/defold-webtransport-minimal/deno.json",
  "examples/defold-webtransport-minimal/server.ts",
  "examples/defold-webtransport-minimal/main/client.script",
]) {
  try {
    await requireFile(required);
  } catch {
    failures.push(`missing release input ${required}`);
  }
}

if (failures.length > 0) {
  throw new Error(`release readiness failed:\n- ${failures.join("\n- ")}`);
}
console.log(
  `release-readiness: ${releaseVersion}; ${await workspaceManifests().then((files) => files.length)} workspace packages aligned`,
);
