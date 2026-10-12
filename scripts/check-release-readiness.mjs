#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const rootPackage = await json("package.json");
const workspaceVersion = rootPackage.version;
if (!workspaceVersion) failures.push("package.json: missing root workspace version");
for (const manifestFile of await workspaceManifests()) {
  const manifest = await json(manifestFile);
  if (manifest.version !== workspaceVersion) {
    failures.push(
      `${manifestFile}: expected workspace version ${workspaceVersion ?? "<missing>"}, received ${manifest.version ?? "<missing>"}`,
    );
  }
}

const standaloneVersion = (await readFile(path.join(root, "extensions/defold-webtransport/VERSION"), "utf8")).trim();
const standaloneProject = await readFile(path.join(root, "extensions/defold-webtransport/game.project"), "utf8");
const standaloneProjectVersion = /^version\s*=\s*([^\s#]+)\s*$/mu.exec(standaloneProject)?.[1];
if (standaloneProjectVersion !== standaloneVersion) {
  failures.push("Defold WebTransport game.project does not match VERSION");
}
const expectedDependencyUrl = `https://github.com/ts-defold/deherm/releases/download/defold-webtransport-v${standaloneVersion}/defold-webtransport-${standaloneVersion}.zip`;
const standaloneReadme = await readFile(path.join(root, "extensions/defold-webtransport/README.md"), "utf8");
if (!standaloneReadme.includes(expectedDependencyUrl)) {
  failures.push("Defold WebTransport README dependency URL does not match VERSION");
}

for (const changelog of ["CHANGELOG.md", "editors/vscode/CHANGELOG.md"]) {
  const source = await readFile(path.join(root, changelog), "utf8");
  if (!source.includes(`## ${workspaceVersion} - Unreleased`))
    failures.push(`${changelog}: missing ${workspaceVersion} entry`);
}
const standaloneChangelog = "extensions/defold-webtransport/defold_webtransport/CHANGELOG.md";
if (!(await readFile(path.join(root, standaloneChangelog), "utf8")).includes(`## ${standaloneVersion} - Unreleased`)) {
  failures.push(`${standaloneChangelog}: missing ${standaloneVersion} entry`);
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
  `release-readiness: workspace ${workspaceVersion}, Defold WebTransport ${standaloneVersion}; ${await workspaceManifests().then((files) => files.length)} workspace packages aligned`,
);
