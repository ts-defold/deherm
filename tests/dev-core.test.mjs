import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { applyDevEvent, createDevModel, snapshotDevModel } from "../packages/cli/src/dev/model.mjs";
import {
  encodeResourceReload,
  encodeResourceReloadBatches,
  normalizeResourcePaths,
  postResourceReload,
} from "../packages/cli/src/dev/protocol.mjs";
import { startResourceServer } from "../packages/cli/src/dev/resource-server.mjs";
import { createWatchPathFilter } from "../packages/cli/src/dev/watcher.mjs";
import {
  compilerRelevantChanges,
  createDevWatchOptions,
  resourcesForBobReload,
  restartRequiredDefoldChanges,
} from "../packages/cli/src/dev/session.mjs";
import {
  createEngineController,
  parseEngineControlEvent,
  resolveBuiltEngine,
} from "../packages/cli/src/dev/engine-process.mjs";
import {
  changedCompiledResources,
  ensureBob,
  extractBobFailureDiagnostics,
  snapshotCompiledResources,
} from "../packages/cli/src/dev/defold-builder.mjs";
import { hostDefoldPlatform } from "../packages/cli/src/toolchains.mjs";

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
    "/z.texturec",
  ]);
  assert.deepEqual(decodeReload(encodeResourceReload(["z.texturec", "/main/player.scriptc"])), [
    "/main/player.scriptc",
    "/z.texturec",
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
  const resources = Array.from(
    { length: 40 },
    (_, index) => `/assets/${index.toString().padStart(2, "0")}-${"x".repeat(30)}.texturec`,
  );
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
    },
  });
  assert.deepEqual(
    requests.map(({ body }) => body.byteLength),
    encoded.map(({ byteLength }) => byteLength),
  );
  assert.deepEqual(
    requests.flatMap(({ body }) => decodeReload(body)),
    normalizeResourcePaths(resources),
  );
  assert.throws(() => encodeResourceReloadBatches([`/${"x".repeat(1_024)}`]), /exceeds 1024-byte reload payload limit/);
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
    shouldIgnore: (_file, relative) => relative.endsWith(".deherm-self"),
  });
  assert.equal(filterPath(path.join(root, "generated", "proxy.script")), undefined);
  assert.equal(filterPath(path.join(root, "generated", "proxy.script", "nested")), undefined);
  assert.equal(filterPath(path.join(root, "ignored.deherm-self")), undefined);
  assert.equal(filterPath(path.join(root, "artifact.a.deherm-replace-1234-abcdef0123")), undefined);
  assert.equal(filterPath(path.join(root, ".deherm", "dev", "app.js")), undefined);
  assert.equal(filterPath(path.join(root, ".internal", "cache", "digest")), undefined);
  assert.equal(filterPath(path.join(root, "player.script.ts")), "player.script.ts");
});

test("session watcher suppresses generated outputs without hiding authored Lua", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-session-watcher-"));
  const outputFile = path.join(root, ".deherm", "dev", "app.dehermc");
  const sourceMirror = path.join(root, "deherm", "app.dehermc");
  const buildMirror = path.join(root, "build", "default", "deherm", "app.dehermc");
  const lockFile = path.join(root, "deherm.lock");
  const generatedRoot = path.join(root, "generated-sdk");
  const generatedProxyPaths = new Set(["scripts/player.script", "gui/hud.gui_script"]);
  const filterPath = createWatchPathFilter(
    root,
    createDevWatchOptions({
      projectRoot: root,
      outputFile,
      sourceMirror,
      buildMirror,
      lockFile,
      generatedRoot,
      generatedProxyPaths,
    }),
  );
  for (const artifact of [outputFile, sourceMirror, buildMirror]) {
    assert.equal(filterPath(artifact), undefined);
    assert.equal(filterPath(`${artifact}.map`), undefined);
    assert.equal(filterPath(`${artifact}.hbc`), undefined);
    assert.equal(filterPath(`${artifact}.hbc.map`), undefined);
  }
  assert.equal(filterPath(lockFile), undefined);
  assert.equal(filterPath(path.join(generatedRoot, "generated", "resource-symbols.json")), undefined);
  assert.equal(filterPath(path.join(root, ".defignore")), undefined);
  assert.equal(filterPath(path.join(root, "defold_hermes", "include", "libhermesvm-config.h")), undefined);
  assert.equal(
    filterPath(path.join(root, "defold_hermes", "include", "defold_hermes", "generated_runtime_variant.h")),
    undefined,
  );
  assert.equal(filterPath(path.join(root, "defold_hermes", "lib", "arm64-osx", ".deherm-artifact.json")), undefined);
  assert.equal(filterPath(path.join(root, "defold_hermes", "lib", "arm64-osx", "libhermes.a")), undefined);
  assert.equal(
    filterPath(path.join(root, "defold_hermes", "include", "defold_hermes", "script_adapter.hpp")),
    "defold_hermes/include/defold_hermes/script_adapter.hpp",
  );
  assert.equal(filterPath(path.join(root, "defold_hermes", "src", "extension.cpp")), "defold_hermes/src/extension.cpp");
  assert.equal(filterPath(path.join(root, "scripts", "player.script")), undefined);
  assert.equal(filterPath(path.join(root, "gui", "hud.gui_script")), undefined);
  assert.equal(filterPath(path.join(root, "scripts", "authored.script")), "scripts/authored.script");
  assert.equal(filterPath(path.join(root, "gui", "authored.gui_script")), "gui/authored.gui_script");
  assert.equal(filterPath(path.join(root, "scripts", "player.script.ts")), "scripts/player.script.ts");
  assert.equal(filterPath(path.join(root, "gui", "hud.gui_script.ts")), "gui/hud.gui_script.ts");
});

test("Bob resource snapshots content-check same-size writes even when mtime is restored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-resources-"));
  const resource = path.join(root, "main", "player.scriptc");
  await mkdir(path.dirname(resource), { recursive: true });
  await writeFile(resource, "first-v1");
  const originalStat = await stat(resource);
  const first = await snapshotCompiledResources(root);

  await writeFile(resource, "other-v2");
  await utimes(resource, originalStat.atime, originalStat.mtime);
  const changed = await snapshotCompiledResources(root, first);
  assert.deepEqual(changedCompiledResources(first, changed), ["/main/player.scriptc"]);

  await writeFile(resource, "other-v2");
  await utimes(resource, originalStat.atime, originalStat.mtime);
  const rewrittenSame = await snapshotCompiledResources(root, changed);
  assert.deepEqual(changedCompiledResources(changed, rewrittenSame), []);
});

test("Bob only omits compiler resources after the engine accepted that generation", () => {
  const resources = ["/deherm/app.dehermc", "/deherm/app.dehermc.hbc", "/main/player.scriptc"];
  assert.deepEqual(resourcesForBobReload(resources, ["/deherm/app.dehermc"], true), ["/main/player.scriptc"]);
  assert.deepEqual(resourcesForBobReload(resources, ["/deherm/app.dehermc"], false), resources);
});

test("dev restarts for Defold resources that cannot update a live collection", () => {
  assert.deepEqual(
    restartRequiredDefoldChanges([
      "main/player.script.ts",
      "main/arena.tilemap",
      "input/game.input_binding",
      "game.project",
      "defold_hermes/src/extension.cpp",
      "vendor/example/ext.manifest",
    ]),
    ["input/game.input_binding", "game.project", "defold_hermes/src/extension.cpp", "vendor/example/ext.manifest"],
  );
});

test("input binding changes do not signal an unchanged compiler bundle", () => {
  assert.deepEqual(compilerRelevantChanges(["input/game.input_binding"]), []);
  assert.deepEqual(compilerRelevantChanges(["input/game.input_binding", "main/player.script.ts"]), [
    "main/player.script.ts",
  ]);
});

test("dev model rejects stale generations and bounds noisy data", () => {
  const model = createDevModel({ logCapacity: 2, historyCapacity: 2, now: 1 });
  assert.equal(applyDevEvent(model, { type: "build-started", generation: 1, at: 10 }), true);
  assert.equal(applyDevEvent(model, { type: "build-succeeded", generation: 1, resources: ["/app.js"], at: 15 }), true);
  assert.equal(
    applyDevEvent(model, { type: "target-configured", id: "local", url: "http://localhost:8001", at: 15 }),
    true,
  );
  assert.equal(model.targets.get("local").status, "unverified");
  assert.equal(
    applyDevEvent(model, { type: "target-connected", id: "local", url: "http://localhost:8001", at: 16 }),
    true,
  );
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
  assert.deepEqual(
    snapshot.logs.map(({ message }) => message),
    ["two", "three"],
  );
  assert.equal(snapshot.targets[0].appliedGeneration, 1);
});

test("component snapshots reject stale sequences, replace runtimes atomically, and deep-copy values", () => {
  const model = createDevModel();
  const first = {
    schemaVersion: 1,
    type: "component-snapshot",
    id: "local-engine",
    connectionEpoch: 1,
    runtimeId: 10,
    sequence: 2,
    sampledAt: 1,
    complete: true,
    omitted: { instances: 0, properties: 0 },
    instances: [
      {
        instanceId: { slot: 1, generation: 1 },
        componentId: "player",
        schemaFingerprint: "one",
        contextKind: "script",
        properties: [{ name: "health", value: { current: 100 } }],
      },
    ],
  };
  assert.equal(applyDevEvent(model, first), true);
  first.instances[0].properties[0].value.current = -1;
  assert.equal(model.targets.get("local-engine").instances[0].properties[0].value.current, 100);

  assert.equal(applyDevEvent(model, { ...first, sequence: 1, instances: [] }), false);
  assert.equal(model.targets.get("local-engine").instances.length, 1);
  assert.equal(
    applyDevEvent(model, {
      ...first,
      runtimeId: 11,
      sequence: 0,
      instances: [{ componentId: "replacement", properties: [] }],
    }),
    true,
  );
  assert.deepEqual(model.targets.get("local-engine").instances, [
    {
      componentId: "replacement",
      properties: [],
      schemaStatus: "unknown-component",
    },
  ]);

  const snapshot = snapshotDevModel(model);
  snapshot.targets[0].instances[0].componentId = "mutated";
  snapshot.targets[0].componentSnapshot.instances[0].componentId = "also-mutated";
  assert.equal(model.targets.get("local-engine").instances[0].componentId, "replacement");
  assert.equal(model.targets.get("local-engine").componentSnapshot.instances[0].componentId, "replacement");

  for (const instances of [
    [null],
    [{ componentId: "broken" }],
    [
      {
        componentId: "broken",
        properties: [null],
      },
    ],
  ]) {
    assert.equal(
      applyDevEvent(model, { ...first, runtimeId: 12, sequence: 1, instances }),
      false,
      "malformed nested rows must fail closed before enrichment",
    );
  }
  assert.equal(model.targets.get("local-engine").componentSnapshot.instances[0].componentId, "replacement");
});

test("component catalog joins live instances only on an exact schema fingerprint", () => {
  const model = createDevModel();
  applyDevEvent(model, {
    type: "component-catalog",
    components: [
      {
        componentId: "player",
        schemaFingerprint: "schema-one",
        source: "main/player.script.ts",
        proxy: "main/player.script",
        contextKind: "game-object",
        properties: [{ name: "health", slot: 0, kind: "number" }],
      },
    ],
  });
  applyDevEvent(model, {
    schemaVersion: 1,
    type: "component-snapshot",
    id: "local-engine",
    connectionEpoch: 1,
    runtimeId: 1,
    sequence: 1,
    complete: true,
    instances: [
      {
        componentId: "player",
        schemaFingerprint: "schema-one",
        properties: [{ name: "health", value: { kind: "number", value: 100 } }],
      },
    ],
  });
  const current = model.targets.get("local-engine").instances[0];
  assert.equal(current.source, "main/player.script.ts");
  assert.equal(current.schemaStatus, "current");
  assert.equal(current.properties[0].declaredKind, "number");

  applyDevEvent(model, {
    type: "component-catalog",
    components: [
      {
        componentId: "player",
        schemaFingerprint: "schema-two",
        source: "main/player.script.ts",
        properties: [],
      },
    ],
  });
  const stale = model.targets.get("local-engine").instances[0];
  assert.equal(stale.schemaStatus, "stale");
  assert.equal(stale.expectedSchemaFingerprint, "schema-two");
  assert.equal(snapshotDevModel(model).componentCatalog, undefined);
});

test("component instances clear on epoch changes, target disconnect, and engine stop", () => {
  const model = createDevModel();
  const componentSnapshot = (connectionEpoch, sequence = 1) => ({
    schemaVersion: 1,
    type: "component-snapshot",
    id: "local-engine",
    connectionEpoch,
    runtimeId: 1,
    sequence,
    complete: true,
    instances: [{ componentId: "player", properties: [] }],
  });
  applyDevEvent(model, componentSnapshot(1));
  assert.equal(
    applyDevEvent(model, { type: "component-snapshot-connected", id: "local-engine", connectionEpoch: 2 }),
    true,
  );
  assert.equal(model.targets.get("local-engine").instances, undefined);
  assert.equal(applyDevEvent(model, componentSnapshot(1, 2)), false, "an older connection cannot repopulate state");
  applyDevEvent(model, componentSnapshot(2));
  applyDevEvent(model, { type: "target-disconnected", id: "local-engine" });
  assert.equal(model.targets.get("local-engine").componentSnapshot, undefined);
  assert.equal(applyDevEvent(model, componentSnapshot(2, 2)), false, "a disconnected epoch cannot repopulate state");
  applyDevEvent(model, { type: "component-snapshot-connected", id: "local-engine", connectionEpoch: 3 });
  applyDevEvent(model, componentSnapshot(3));
  assert.equal(
    applyDevEvent(model, {
      type: "target-disconnected",
      id: "local-engine",
      connectionEpoch: 2,
    }),
    false,
    "an older target exit cannot clear a replacement connection",
  );
  assert.equal(model.targets.get("local-engine").instances.length, 1);
  assert.equal(
    applyDevEvent(model, {
      type: "target-disconnected",
      id: "local-engine",
      connectionEpoch: 3,
    }),
    true,
  );
  applyDevEvent(model, { type: "component-snapshot-connected", id: "local-engine", connectionEpoch: 4 });
  applyDevEvent(model, componentSnapshot(4));
  applyDevEvent(model, { type: "engine-stopped", code: 0 });
  assert.equal(model.targets.get("local-engine").instances, undefined);
});

test("runtime fingerprint acknowledgement is the activation authority", () => {
  const fingerprint = "ab".repeat(32);
  const nextFingerprint = "cd".repeat(32);
  const model = createDevModel();
  applyDevEvent(model, { type: "build-started", generation: 1, at: 1 });
  applyDevEvent(model, { type: "build-succeeded", generation: 1, fingerprint, at: 2 });
  applyDevEvent(model, { type: "target-configured", id: "local-engine", url: "http://127.0.0.1:8001" });
  applyDevEvent(model, { type: "reload-started", id: "local-engine", generation: 1 });
  applyDevEvent(model, { type: "reload-signalled", id: "local-engine", generation: 1 });
  assert.equal(
    applyDevEvent(model, {
      type: "runtime-activation-observed",
      id: "local-engine",
      fingerprint,
      resourceGeneration: 7,
      runtimeId: 12,
      initial: false,
      at: 3,
    }),
    true,
  );
  assert.equal(model.phase, "ready");
  assert.equal(model.targets.get("local-engine").appliedGeneration, 1);
  assert.equal(model.targets.get("local-engine").telemetry.resourceGeneration, 7);

  applyDevEvent(model, { type: "build-started", generation: 2, at: 4 });
  applyDevEvent(model, { type: "build-succeeded", generation: 2, fingerprint: nextFingerprint, at: 5 });
  applyDevEvent(model, { type: "reload-started", id: "local-engine", generation: 2 });
  applyDevEvent(model, { type: "reload-signalled", id: "local-engine", generation: 2 });
  applyDevEvent(model, {
    type: "runtime-activation-observed",
    id: "local-engine",
    fingerprint,
    resourceGeneration: 7,
    runtimeId: 12,
    initial: false,
    at: 6,
  });
  assert.equal(model.phase, "awaiting-activation");
  assert.equal(model.targets.get("local-engine").pendingGeneration, 2);
  applyDevEvent(model, {
    type: "runtime-activation-rejected",
    id: "local-engine",
    fingerprint: nextFingerprint,
    resourceGeneration: 8,
    runtimeId: 13,
    initial: false,
    at: 7,
  });
  assert.equal(model.phase, "failed");
  assert.equal(model.targets.get("local-engine").status, "activation-failed");
});

test("engine control lines decode exact activation identity", () => {
  const fingerprint = "01".repeat(32);
  assert.deepEqual(
    parseEngineControlEvent(
      `INFO:DEFOLD_HERMES: DEHERM_EVENT bundle-activated fingerprint=${fingerprint} resource_generation=3 runtime_id=9 initial=false`,
    ),
    {
      type: "runtime-activation-observed",
      id: "local-engine",
      fingerprint,
      resourceGeneration: 3,
      runtimeId: 9,
      initial: false,
    },
  );
  assert.equal(parseEngineControlEvent("INFO:DEFOLD_HERMES: ordinary log"), undefined);
  assert.deepEqual(
    parseEngineControlEvent(
      "INFO:DEFOLD_HERMES: DEHERM_EVENT telemetry runtime_id=9 frame_dt_us=16667 heap_available=true heap_bytes=1024 heap_size_bytes=4096 heap_peak_bytes=2048 callback_roots=3 component_instances=2 lua_handles=5 lua_handle_capacity=256 arena_high_water_bytes=8192",
    ),
    {
      type: "telemetry",
      id: "local-engine",
      values: {
        runtimeId: 9,
        frameDtMs: 16.667,
        hermesHeapAvailable: true,
        hermesHeapBytes: 1024,
        hermesHeapSizeBytes: 4096,
        hermesPeakBytes: 2048,
        callbackRoots: 3,
        componentInstances: 2,
        luaRegistryUsed: 5,
        luaRegistryCapacity: 256,
        arenaHighWaterBytes: 8192,
      },
    },
  );
});

test("built engine resolution and controller keep engine output inside model events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-engine-controller-"));
  await mkdir(path.join(root, "build", "default"), { recursive: true });
  await mkdir(path.join(root, "build", "arm64-osx"), { recursive: true });
  await writeFile(path.join(root, "build", "default", "game.projectc"), "project");
  await writeFile(path.join(root, "build", "arm64-osx", "dmengine"), "engine");
  const resolved = await resolveBuiltEngine(root, { platform: "darwin", arch: "arm64" });
  assert.equal(resolved.runtimeRoot, path.join(root, "build", "default"));

  const events = [];
  let child;
  let spawnedArguments;
  const controller = createEngineController({
    projectRoot: root,
    inspectorPort: 39229,
    emit: (event) => events.push(event),
    resolveEngine: async () => resolved,
    spawn(_executable, arguments_) {
      spawnedArguments = arguments_;
      child = new EventEmitter();
      child.pid = 42;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        queueMicrotask(() => child.emit("exit", signal === "SIGTERM" ? 0 : null, signal === "SIGTERM" ? null : signal));
        return true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(await controller.launch(), true);
  assert.deepEqual(spawnedArguments, ["--config=defold_hermes.inspector_port=39229"]);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("engine online\n");
  child.stdout.write(
    `INFO:DEFOLD_HERMES: DEHERM_EVENT bundle-activated fingerprint=${"ef".repeat(32)} resource_generation=2 runtime_id=4 initial=true\n`,
  );
  child.stderr.write("warning: fixture\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.running(), true);
  assert.ok(events.some((event) => event.type === "engine-started" && event.pid === 42));
  assert.ok(events.some((event) => event.type === "log" && event.message === "engine online"));
  assert.ok(events.some((event) => event.type === "runtime-activation-observed" && event.runtimeId === 4));
  assert.ok(events.some((event) => event.type === "log" && event.level === "warn"));
  assert.equal(await controller.stop(), true);
  assert.equal(controller.running(), false);
  assert.ok(events.some((event) => event.type === "engine-stopped" && event.code === 0));
});

test("installed CLI caches only checksum-verified Bob bytes for the locked Defold revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-cache-"));
  const bytes = Buffer.from("bob fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let downloads = 0;
  const lock = {
    defoldRevision: "a".repeat(40),
    toolchain: { bob: { url: "https://example.invalid/bob.jar", sha256: digest } },
  };
  const fetch = async () => {
    downloads += 1;
    return new Response(bytes);
  };
  const first = await ensureBob(root, lock, { fetch });
  const second = await ensureBob(root, lock, { fetch });
  assert.equal(first, second);
  assert.equal(downloads, 1);
  assert.deepEqual(await import("node:fs/promises").then(({ readFile }) => readFile(first)), bytes);
  await assert.rejects(
    ensureBob(
      await mkdtemp(path.join(tmpdir(), "deherm-bob-bad-")),
      {
        ...lock,
        toolchain: { bob: { ...lock.toolchain.bob, sha256: "0".repeat(64) } },
      },
      { fetch },
    ),
    /checksum mismatch/,
  );
});

test("Bob failure diagnostics surface bounded unique compiler errors", () => {
  const diagnostics = extractBobFailureDiagnostics(
    [
      "INFO: resolving dependencies",
      "ERROR:EXTENDER: extension build failed",
      "src/runtime.cpp:42:7: error: unknown identifier",
      "src/runtime.cpp:42:7: error: unknown identifier",
      "src/runtime.cpp:44:2: fatal error: missing header",
      "com.defold.extender.ExtenderException: incompatible SDK",
      "Unable to find property 'r8Cmd' on class: com.defold.extender.PlatformConfig",
      "FATAL: build stopped",
    ].join("\n"),
    5,
  );
  assert.deepEqual(diagnostics, [
    "ERROR:EXTENDER: extension build failed",
    "src/runtime.cpp:42:7: error: unknown identifier",
    "src/runtime.cpp:44:2: fatal error: missing header",
    "com.defold.extender.ExtenderException: incompatible SDK",
    "Unable to find property 'r8Cmd' on class: com.defold.extender.PlatformConfig",
  ]);
  assert.throws(() => extractBobFailureDiagnostics("ERROR: nope", -1), /non-negative integer/);
});

test("host platforms map to Defold build and packaged-extension targets", () => {
  assert.equal(hostDefoldPlatform("darwin", "arm64"), "arm64-macos");
  assert.equal(hostDefoldPlatform("darwin", "x64"), "x86_64-macos");
  assert.equal(hostDefoldPlatform("linux", "x64"), "x86_64-linux");
  assert.equal(hostDefoldPlatform("win32", "x64"), "x86_64-win32");
  assert.throws(() => hostDefoldPlatform("win32", "arm64"), /No Defold development platform mapping/);
});
