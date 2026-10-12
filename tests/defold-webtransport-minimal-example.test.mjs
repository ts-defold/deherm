import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import { stageMinimalWebTransportExample } from "../scripts/stage-defold-webtransport-minimal-example.mjs";

test("minimal community example stages as an ordinary Defold project without deherm", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "defold-webtransport-minimal-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archive = path.join(scratch, "release.zip");
  await writeFile(
    archive,
    zipSync({
      "game.project": strToU8("version = archive-must-not-replace-example\n"),
      "defold_webtransport/ext.manifest": strToU8("name: DefoldWebTransport\n"),
      "defold_webtransport/from-release.txt": strToU8("published archive payload\n"),
    }),
  );
  const outputRoot = path.join(scratch, "project");
  await stageMinimalWebTransportExample({ archive, outputRoot });
  const project = await readFile(path.join(outputRoot, "game.project"), "utf8");
  assert.doesNotMatch(project, /dependencies#/u);
  assert.doesNotMatch(project, /deherm/iu);
  await access(path.join(outputRoot, "defold_webtransport/ext.manifest"));
  await access(path.join(outputRoot, "input/game.input_binding"));
  assert.equal(
    await readFile(path.join(outputRoot, "defold_webtransport/from-release.txt"), "utf8"),
    "published archive payload\n",
  );
  assert.doesNotMatch(project, /archive-must-not-replace-example/u);
  const script = await readFile(path.join(outputRoot, "main/client.script"), "utf8");
  assert.match(script, /defold_webtransport\.connect/u);
  assert.match(script, /defold_webtransport\.send_datagram/u);
  assert.match(script, /defold_webtransport\.create_bidirectional_stream/u);
});

test("minimal example staging rejects archive members outside the exact release layout", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "defold-webtransport-minimal-invalid-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archive = path.join(scratch, "release.zip");
  await writeFile(
    archive,
    zipSync({
      "game.project": strToU8("archive project\n"),
      "defold_webtransport/ext.manifest": strToU8("name: DefoldWebTransport\n"),
      "unexpected.txt": strToU8("not a release member\n"),
    }),
  );
  await assert.rejects(
    stageMinimalWebTransportExample({ archive, outputRoot: path.join(scratch, "project") }),
    /archive has unexpected members: unexpected\.txt/u,
  );
});

test("minimal example staging excludes a competing extension source tree", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "defold-webtransport-minimal-source-exclusion-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const exampleRoot = path.join(scratch, "example");
  await mkdir(path.join(exampleRoot, "main"), { recursive: true });
  await mkdir(path.join(exampleRoot, "input"), { recursive: true });
  await mkdir(path.join(exampleRoot, "defold_webtransport"), { recursive: true });
  await writeFile(path.join(exampleRoot, "game.project"), "[project]\ntitle = Example\n");
  await writeFile(path.join(exampleRoot, "main/client.script"), "-- project input\n");
  await writeFile(path.join(exampleRoot, "input/game.input_binding"), "-- project input binding\n");
  await writeFile(path.join(exampleRoot, "defold_webtransport/ext.manifest"), "name: source-tree-decoy\n");
  const archive = path.join(scratch, "release.zip");
  await writeFile(
    archive,
    zipSync({
      "game.project": strToU8("version = archive-project-is-not-copied\n"),
      "defold_webtransport/ext.manifest": strToU8("name: archive-extension\n"),
    }),
  );
  const outputRoot = path.join(scratch, "project");
  await stageMinimalWebTransportExample({ exampleRoot, archive, outputRoot });
  assert.equal(
    await readFile(path.join(outputRoot, "defold_webtransport/ext.manifest"), "utf8"),
    "name: archive-extension\n",
  );
  assert.equal(await readFile(path.join(outputRoot, "main/client.script"), "utf8"), "-- project input\n");
  assert.equal(await readFile(path.join(outputRoot, "input/game.input_binding"), "utf8"), "-- project input binding\n");
  assert.match(await readFile(path.join(outputRoot, "game.project"), "utf8"), /title = Example/u);
  assert.doesNotMatch(await readFile(path.join(outputRoot, "game.project"), "utf8"), /archive-project/u);
});
