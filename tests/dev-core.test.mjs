import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyDevEvent, createDevModel, snapshotDevModel } from "../packages/cli/src/dev/model.mjs";
import { encodeResourceReload, encodeResourceReloadBatches, normalizeResourcePaths, postResourceReload } from "../packages/cli/src/dev/protocol.mjs";
import { startResourceServer } from "../packages/cli/src/dev/resource-server.mjs";
import { createWatchPathFilter } from "../packages/cli/src/dev/watcher.mjs";
import { createDevWatchOptions } from "../packages/cli/src/dev/session.mjs";

function decodeVarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7;
  }
  throw new Error("truncated varint");
}

function decodeReload(bytes) {
  const resources = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.equal(bytes[offset++], 0x0a);
    const [length, next] = decodeVarint(bytes, offset);
    offset = next;
    resources.push(bytes.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
  return resources;
}

test("Defold reload protobuf is deterministic and normalizes resource paths", () => {
  assert.deepEqual(normalizeResourcePaths(["main\\player.scriptc", "/main/player.scriptc", "z.texturec"]), [
    "/main/player.scriptc",
    "/z.texturec"
  ]);
  assert.deepEqual(decodeReload(encodeResourceReload(["z.texturec", "/main/player.scriptc"])), [
    "/main/player.scriptc",
    "/z.texturec"
  ]);
  assert.throws(() => normalizeResourcePaths(["../outside"]), /invalid Defold resource path/);
});

test("reload client posts the exact protobuf to the Defold engine route", async (t) => {
  let observed;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = { method: request.method, url: request.url, body: Buffer.concat(chunks) };
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await postResourceReload(`http://127.0.0.1:${port}`, ["/app.js"]);
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/post/@resource/reload");
  assert.deepEqual(decodeReload(observed.body), ["/app.js"]);
});

test("reload client chunks payloads to Defold's 1024-byte request buffer", async () => {
  const resources = Array.from({ length: 40 }, (_, index) => `/assets/${index.toString().padStart(2, "0")}-${"x".repeat(30)}.texturec`);
  assert.ok(encodeResourceReload(resources).byteLength > 1_024);
  const encoded = encodeResourceReloadBatches(resources);
  assert.ok(encoded.length > 1);
  assert.ok(encoded.every((batch) => batch.byteLength <= 1_024));
  assert.deepEqual(encoded.flatMap(decodeReload), normalizeResourcePaths(resources));

  const requests = [];
  await postResourceReload("http://127.0.0.1:8001", resources, {
    fetch: async (url, init) => {
      requests.push({ url: url.href, body: Buffer.from(init.body) });
      return new Response(null, { status: 200 });
    }
  });
  assert.deepEqual(requests.map(({ body }) => body.byteLength), encoded.map(({ byteLength }) => byteLength));
  assert.deepEqual(requests.flatMap(({ body }) => decodeReload(body)), normalizeResourcePaths(resources));
  assert.throws(
    () => encodeResourceReloadBatches([`/${"x".repeat(1_024)}`]),
    /exceeds 1024-byte reload payload limit/
  );
});

test("resource server serves ETagged build artifacts and blocks traversal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-resources-"));
  await mkdir(path.join(root, "main"));
  await writeFile(path.join(root, "main", "player.scriptc"), "compiled");
  const service = await startResourceServer({ root });
  t.after(() => service.close());

  const first = await fetch(`${service.baseUrl}/main/player.scriptc`);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "compiled");
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  const cached = await fetch(`${service.baseUrl}/main/player.scriptc`, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${service.baseUrl}/%2e%2e%2fsecret`)).status, 400);
});

test("resource server blocks escaping symlinks and hashes current content", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-resources-"));
  const outside = await mkdtemp(path.join(tmpdir(), "deherm-outside-"));
  const artifact = path.join(root, "same-size.js");
  const secret = path.join(outside, "secret.js");
  await writeFile(artifact, "first-v1");
  await writeFile(secret, "outside!");
  await symlink(secret, path.join(root, "escape.js"));
  const initialMetadata = await stat(artifact);
  const service = await startResourceServer({ root });
  t.after(() => service.close());

  const first = await fetch(`${service.baseUrl}/same-size.js`);
  const firstEtag = first.headers.get("etag");
  assert.equal(await first.text(), "first-v1");
  await writeFile(artifact, "other-v2");
  await utimes(artifact, initialMetadata.atime, initialMetadata.mtime);
  const changed = await fetch(`${service.baseUrl}/same-size.js`, { headers: { "if-none-match": firstEtag } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), "other-v2");
  assert.notEqual(changed.headers.get("etag"), firstEtag);
  assert.equal((await fetch(`${service.baseUrl}/escape.js`)).status, 400);
});

test("watcher suppresses declared generated outputs without hiding source edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-watcher-"));
  const filterPath = createWatchPathFilter(root, {
    ignoredPaths: ["generated/proxy.script"],
    shouldIgnore: (_file, relative) => relative.endsWith(".deherm-self")
  });
  assert.equal(filterPath(path.join(root, "generated", "proxy.script")), undefined);
  assert.equal(filterPath(path.join(root, "generated", "proxy.script", "nested")), undefined);
  assert.equal(filterPath(path.join(root, "ignored.deherm-self")), undefined);
  assert.equal(filterPath(path.join(root, ".deherm", "dev", "app.js")), undefined);
  assert.equal(filterPath(path.join(root, "player.script.ts")), "player.script.ts");
});

test("session watcher suppresses bundle maps and both generated proxy kinds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-session-watcher-"));
  const outputFile = path.join(root, ".deherm", "dev", "app.dehermc");
  const sourceMirror = path.join(root, "deherm", "app.dehermc");
  const buildMirror = path.join(root, "build", "default", "deherm", "app.dehermc");
  const filterPath = createWatchPathFilter(root, createDevWatchOptions({ outputFile, sourceMirror, buildMirror }));
  for (const artifact of [outputFile, sourceMirror, buildMirror]) {
    assert.equal(filterPath(artifact), undefined);
    assert.equal(filterPath(`${artifact}.map`), undefined);
  }
  assert.equal(filterPath(path.join(root, "scripts", "player.script")), undefined);
  assert.equal(filterPath(path.join(root, "gui", "hud.gui_script")), undefined);
  assert.equal(filterPath(path.join(root, "scripts", "player.script.ts")), "scripts/player.script.ts");
  assert.equal(filterPath(path.join(root, "gui", "hud.gui_script.ts")), "gui/hud.gui_script.ts");
});

test("dev model rejects stale generations and bounds noisy data", () => {
  const model = createDevModel({ logCapacity: 2, historyCapacity: 2, now: 1 });
  assert.equal(applyDevEvent(model, { type: "build-started", generation: 1, at: 10 }), true);
  assert.equal(applyDevEvent(model, { type: "build-succeeded", generation: 1, resources: ["/app.js"], at: 15 }), true);
  assert.equal(applyDevEvent(model, { type: "target-configured", id: "local", url: "http://localhost:8001", at: 15 }), true);
  assert.equal(model.targets.get("local").status, "unverified");
  assert.equal(applyDevEvent(model, { type: "target-connected", id: "local", url: "http://localhost:8001", at: 16 }), true);
  assert.equal(applyDevEvent(model, { type: "reload-started", id: "local", generation: 1 }), true);
  assert.equal(applyDevEvent(model, { type: "reload-signalled", id: "local", generation: 0 }), false);
  assert.equal(applyDevEvent(model, { type: "reload-signalled", id: "local", generation: 1, at: 17 }), true);
  assert.equal(model.phase, "awaiting-activation");
  assert.equal(applyDevEvent(model, { type: "activation-succeeded", id: "local", generation: 1, at: 18 }), true);
  applyDevEvent(model, { type: "log", message: "one" });
  applyDevEvent(model, { type: "log", message: "two" });
  applyDevEvent(model, { type: "log", message: "three" });
  const snapshot = snapshotDevModel(model);
  assert.equal(snapshot.phase, "ready");
  assert.deepEqual(snapshot.logs.map(({ message }) => message), ["two", "three"]);
  assert.equal(snapshot.targets[0].appliedGeneration, 1);
});
