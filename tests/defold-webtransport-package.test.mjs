import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { unzipSync } from "fflate";

import {
  describeDefoldWebtransportPackage,
  packageDefoldWebtransport,
  repositoryRoot
} from "../scripts/package-defold-webtransport.mjs";
import { nativeArtifactAbiSha256 } from "../packages/cli/src/webtransport-artifacts.mjs";

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "defold-webtransport-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(root, { version = "1.2.3" } = {}) {
  const extension = path.join(root, "defold_webtransport");
  await mkdir(path.join(extension, "include/defold_webtransport"), { recursive: true });
  await mkdir(path.join(extension, "script"), { recursive: true });
  await mkdir(path.join(extension, "src"), { recursive: true });
  await mkdir(path.join(extension, "lib/web"), { recursive: true });
  await mkdir(path.join(extension, "webtransport"), { recursive: true });
  await writeFile(path.join(root, "VERSION"), `${version}\n`);
  await writeFile(path.join(root, "game.project"), `[project]\ntitle = Defold WebTransport\nversion = ${version}\n`);
  await writeFile(path.join(extension, "ext.manifest"), "name: DefoldWebTransport\nplatforms: {}\n");
  await writeFile(
    path.join(extension, "include/defold_webtransport/defold_webtransport.h"),
    "#pragma once\nunsigned int defold_webtransport_abi_version(void);\n"
  );
  await writeFile(
    path.join(extension, "script/defold_webtransport.script_api"),
    "- name: defold_webtransport\n  type: table\n"
  );
  await writeFile(path.join(extension, "src/extension.cpp"), "// fixture\n");
  await writeFile(path.join(extension, "lib/web/library_defold_webtransport.js"), "// browser backend fixture\n");
  await writeFile(
    path.join(extension, "webtransport/defold-hermes.bindings.json"),
    `${JSON.stringify({ schemaVersion: 1, publicHeader: "include/defold_webtransport/defold_webtransport.h" })}\n`
  );
  await writeFile(
    path.join(extension, "webtransport/public-api-compatibility.json"),
    `${JSON.stringify({ schemaVersion: 1, contractVersion: version })}\n`
  );
  const fingerprint = "a".repeat(64);
  await writeFile(
    path.join(extension, "webtransport/native-artifacts.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      repository: "ts-defold/deherm",
      tag: `defold-webtransport-native-${fingerprint.slice(0, 12)}`,
      fingerprint,
      abiSha256: await nativeArtifactAbiSha256(extension),
      assets: []
    }, null, 2)}\n`
  );
  await writeFile(path.join(root, "README.md"), "source-only release instructions\n");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("standalone package has Defold dependency layout and its own version", async (t) => {
  const directory = await scratch(t);
  const source = path.join(directory, "source");
  await fixture(source);
  const result = await packageDefoldWebtransport({ sourceRoot: source, outputRoot: path.join(directory, "out") });

  assert.equal(result.assetName, "defold-webtransport-1.2.3.zip");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  const members = Object.keys(unzipSync(await readFile(result.archivePath))).sort();
  assert.deepEqual(members, [
    "defold_webtransport/ext.manifest",
    "defold_webtransport/include/defold_webtransport/defold_webtransport.h",
    "defold_webtransport/lib/web/library_defold_webtransport.js",
    "defold_webtransport/script/defold_webtransport.script_api",
    "defold_webtransport/src/extension.cpp",
    "defold_webtransport/webtransport/defold-hermes.bindings.json",
    "defold_webtransport/webtransport/native-artifacts.json",
    "defold_webtransport/webtransport/public-api-compatibility.json",
    "game.project"
  ]);
  assert.ok(members.every((member) => member === "game.project" || member.startsWith("defold_webtransport/")));
});

test("package bytes ignore source location, creation order, permissions, and timestamps", async (t) => {
  const directory = await scratch(t);
  const firstSource = path.join(directory, "first");
  const secondSource = path.join(directory, "second");
  await fixture(firstSource);
  await fixture(secondSource);

  const changedTime = new Date("2035-06-07T08:09:10Z");
  await utimes(path.join(secondSource, "game.project"), changedTime, changedTime);
  await utimes(path.join(secondSource, "defold_webtransport/src/extension.cpp"), changedTime, changedTime);

  const first = await packageDefoldWebtransport({ sourceRoot: firstSource, outputRoot: path.join(directory, "one") });
  const second = await packageDefoldWebtransport({ sourceRoot: secondSource, outputRoot: path.join(directory, "two") });
  assert.equal(digest(await readFile(second.archivePath)), digest(await readFile(first.archivePath)));
});

test("dogfood staging tree contains the exact bytes represented by the archive", async (t) => {
  const directory = await scratch(t);
  const source = path.join(directory, "source");
  const stage = path.join(directory, "dogfood");
  await fixture(source);
  const result = await packageDefoldWebtransport({
    sourceRoot: source,
    outputRoot: path.join(directory, "out"),
    stageRoot: stage
  });
  const archive = unzipSync(await readFile(result.archivePath));
  for (const member of result.members) {
    assert.deepEqual(new Uint8Array(await readFile(path.join(stage, ...member.split("/")))), archive[member]);
  }
});

test("version override verifies VERSION rather than renaming unrelated bytes", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await assert.rejects(
    describeDefoldWebtransportPackage({ sourceRoot: directory, requestedVersion: "1.2.4" }),
    /does not match VERSION 1\.2\.3/u
  );
});

test("game.project and release authority cannot carry different versions", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await writeFile(path.join(directory, "game.project"), "[project]\ntitle = Defold WebTransport\nversion = 9.9.9\n");
  await assert.rejects(
    describeDefoldWebtransportPackage({ sourceRoot: directory }),
    /game\.project version 9\.9\.9 does not match VERSION 1\.2\.3/u
  );
});

test("package fails closed when public API metadata is absent", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await rm(path.join(directory, "defold_webtransport/script/defold_webtransport.script_api"));
  await assert.rejects(describeDefoldWebtransportPackage({ sourceRoot: directory }), /script_api documentation/u);
});

test("package refuses a source-only extension without the functional HTML5 backend", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await rm(path.join(directory, "defold_webtransport/lib/web/library_defold_webtransport.js"));
  await assert.rejects(describeDefoldWebtransportPackage({ sourceRoot: directory }), /functional HTML5 backend/u);
});

test("every bundled native library declared by ext.manifest must be staged for its target", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await writeFile(path.join(directory, "defold_webtransport/ext.manifest"), `
name: DefoldWebTransport
platforms:
  arm64-osx:
    context:
      libs: [defold_webtransport_core, picoquic-core]
`);
  await mkdir(path.join(directory, "defold_webtransport/lib/arm64-osx"), { recursive: true });
  await writeFile(path.join(directory, "defold_webtransport/lib/arm64-osx/libdefold_webtransport_core.a"), "fixture\n");
  await assert.rejects(describeDefoldWebtransportPackage({ sourceRoot: directory }), /libpicoquic-core\.a/u);
});

test("package requires the additive deherm descriptor inside the shipped extension directory", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await rm(path.join(directory, "defold_webtransport/webtransport/defold-hermes.bindings.json"));
  await assert.rejects(describeDefoldWebtransportPackage({ sourceRoot: directory }), /additive .* descriptor/u);
});

test("package refuses a stale public API compatibility contract", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  await writeFile(
    path.join(directory, "defold_webtransport/webtransport/public-api-compatibility.json"),
    `${JSON.stringify({ schemaVersion: 1, contractVersion: "1.2.2" })}\n`
  );
  await assert.rejects(
    describeDefoldWebtransportPackage({ sourceRoot: directory }),
    /public API contract version 1\.2\.2 does not match VERSION 1\.2\.3/u
  );
});

test("package refuses symlinks so archive inputs cannot escape the extension root", async (t) => {
  const directory = await scratch(t);
  await fixture(directory);
  const outside = path.join(directory, "outside.cpp");
  await writeFile(outside, "// outside\n");
  await symlink(outside, path.join(directory, "defold_webtransport/src/linked.cpp"));
  await assert.rejects(describeDefoldWebtransportPackage({ sourceRoot: directory }), /symbolic links/u);
});

test("release workflow keys the immutable asset to the extension version", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/defold-webtransport-release.yml"),
    "utf8"
  );
  assert.match(workflow, /defold-webtransport-v\$\{version\}/u);
  assert.match(workflow, /defold-webtransport-\$\{version\}\.zip/u);
  assert.match(workflow, /cmp --silent/u);
  assert.doesNotMatch(workflow, /--clobber/u);
});
