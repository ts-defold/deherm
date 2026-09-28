import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stageMinimalWebTransportExample } from "../scripts/stage-defold-webtransport-minimal-example.mjs";

test("minimal community example stages as an ordinary Defold project without deherm", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "defold-webtransport-minimal-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const extensionRoot = path.join(scratch, "release");
  await mkdir(path.join(extensionRoot, "defold_webtransport"), { recursive: true });
  await writeFile(path.join(extensionRoot, "defold_webtransport/ext.manifest"), "name: DefoldWebTransport\n");
  const outputRoot = path.join(scratch, "project");
  await stageMinimalWebTransportExample({ extensionRoot, outputRoot });
  const project = await readFile(path.join(outputRoot, "game.project"), "utf8");
  assert.doesNotMatch(project, /dependencies#/u);
  assert.doesNotMatch(project, /deherm/iu);
  await access(path.join(outputRoot, "defold_webtransport/ext.manifest"));
  const script = await readFile(path.join(outputRoot, "main/client.script"), "utf8");
  assert.match(script, /defold_webtransport\.connect/u);
  assert.match(script, /defold_webtransport\.send_datagram/u);
  assert.match(script, /defold_webtransport\.create_bidirectional_stream/u);
});
