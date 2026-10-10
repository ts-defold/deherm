import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const uploader = path.join(root, "scripts/ci/upload-release-asset.sh");
const asset = "hermes-arm64-osx.tar.gz";
const tag = "libs-test-apple";

const mockGh = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.MOCK_GH_STATE;
const [family, command, ...args] = process.argv.slice(2);
if (family !== "release") process.exit(2);
const release = path.join(state, "release");
const assets = path.join(state, "assets");
if (command === "view") {
  if (!fs.existsSync(release)) process.exit(1);
  if (args.includes("--json") && fs.existsSync(assets)) process.stdout.write(fs.readFileSync(assets));
  process.exit(0);
}
if (command === "create") {
  fs.writeFileSync(path.join(state, "create-args"), JSON.stringify(args));
  if (process.env.MOCK_GH_CREATE_FAIL === "1") process.exit(1);
  fs.writeFileSync(release, "created");
  process.exit(0);
}
if (command === "upload") {
  if (process.env.MOCK_GH_UPLOAD_FAIL === "1") process.exit(1);
  if (process.env.MOCK_GH_HIDE_UPLOAD !== "1") fs.appendFileSync(assets, path.basename(args[1]) + "\\n");
  process.exit(0);
}
process.exit(2);
`;

async function runUpload(t, extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deherm-apple-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const member = path.join(directory, "member");
  const archive = path.join(directory, asset);
  await writeFile(member, "Hermes test library");
  const tar = spawnSync("tar", ["--format", "ustar", "-czf", archive, "-C", directory, "member"], {
    encoding: "utf8",
  });
  assert.equal(tar.status, 0, tar.stderr);
  await writeFile(path.join(directory, "gh"), mockGh, { mode: 0o755 });
  await writeFile(path.join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync("/bin/bash", [uploader, tag, "ts-defold/deherm", archive, asset], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      MOCK_GH_STATE: directory,
      RELEASE_TITLE: "Test Apple release",
      RELEASE_FINGERPRINT: "a".repeat(64),
      ...extraEnv,
    },
  });
  return { ...result, directory };
}

test("Apple Bash publishes archive and sidecar without an optional release target", async (t) => {
  const result = await runUpload(t);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const args = JSON.parse(await readFile(path.join(result.directory, "create-args"), "utf8"));
  assert.ok(!args.includes("--target"));
  const assets = (await readFile(path.join(result.directory, "assets"), "utf8")).trim().split("\n");
  assert.deepEqual(assets, [`${asset}.integrity.json`, asset]);
});

test("an explicit release target is passed through", async (t) => {
  const result = await runUpload(t, { RELEASE_TARGET: "abc123" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const args = JSON.parse(await readFile(path.join(result.directory, "create-args"), "utf8"));
  assert.deepEqual(args.slice(args.indexOf("--target"), args.indexOf("--target") + 2), ["--target", "abc123"]);
});

test("release creation failure cannot produce a green upload job", async (t) => {
  const result = await runUpload(t, { MOCK_GH_CREATE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not create or find release/u);
});

test("a successful CLI exit without published assets fails the upload job", async (t) => {
  const result = await runUpload(t, { MOCK_GH_HIDE_UPLOAD: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain/u);
});

test("failed uploads cannot produce a green job", async (t) => {
  const result = await runUpload(t, { MOCK_GH_UPLOAD_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed after 5 attempts/u);
});
