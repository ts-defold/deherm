import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  devStateSnapshot,
  prepareDebugWebBundle,
  runDevSession,
  sessionLogEvent
} from "../packages/cli/src/dev/session.mjs";
import {
  bobFailureLogFile,
  defaultDefoldBundleBuildOutput,
  defaultDefoldBundleOutput
} from "../packages/cli/src/dev/defold-builder.mjs";
import { applyDevEvent, createDevModel } from "../packages/cli/src/dev/model.mjs";

const componentPolicySource = new URL(
  "../packages/bindings/generated/defold-component-proxy-contract.json",
  import.meta.url
);

async function installComponentPolicy(generatedRoot) {
  const irRoot = path.join(generatedRoot, "ir");
  await mkdir(irRoot, { recursive: true });
  await writeFile(
    path.join(irRoot, "defold-component-proxy-contract.json"),
    await readFile(componentPolicySource)
  );
}

test("normal session logs summarize component snapshots without property values", () => {
  const event = {
    schemaVersion: 1,
    type: "component-snapshot",
    id: "local-engine",
    connectionEpoch: 2,
    runtimeId: 9,
    sequence: 5,
    complete: false,
    omitted: { instances: 1, properties: 2 },
    instances: [{ properties: [{ name: "secret", value: "do-not-persist" }] }]
  };
  assert.deepEqual(sessionLogEvent(event), {
    schemaVersion: 1,
    type: "component-snapshot",
    id: "local-engine",
    connectionEpoch: 2,
    runtimeId: 9,
    sequence: 5,
    sampledAt: undefined,
    complete: false,
    omitted: { instances: 1, properties: 2 },
    instanceCount: 1,
    propertyCount: 1
  });
  assert.equal(JSON.stringify(sessionLogEvent(event)).includes("do-not-persist"), false);
});

test("authenticated dev state projects every target without credentials", () => {
  const model = createDevModel();
  applyDevEvent(model, { type: "target-configured", id: "local-engine", runtime: "hermes" });
  applyDevEvent(model, { type: "target-configured", id: "browser-host", runtime: "browser" });
  applyDevEvent(model, {
    type: "component-catalog",
    components: [{
      componentId: "player",
      schemaFingerprint: "schema-v1",
      source: "main/player.script.ts",
      proxy: "main/player.script",
      properties: [{ name: "health", kind: "number" }]
    }]
  });
  applyDevEvent(model, {
    schemaVersion: 1,
    type: "component-snapshot",
    id: "browser-host",
    connectionEpoch: 1,
    runtimeId: 2,
    sequence: 1,
    complete: true,
    instances: [{
      instanceId: { slot: 3, generation: 2 },
      componentId: "player",
      schemaFingerprint: "schema-v1",
      contextKind: "game-object",
      properties: [{ name: "health", value: { kind: "number", value: 100 } }]
    }]
  });
  const state = devStateSnapshot(model);
  assert.deepEqual(state.targets.map(({ id }) => id), ["local-engine", "browser-host"]);
  assert.equal(state.targets[0].componentSnapshot, null);
  assert.equal(state.targets[1].componentSnapshot.runtimeId, 2);
  assert.equal("instances" in state.targets[1].componentSnapshot, false,
    "the authenticated projection must not duplicate the bounded raw runtime rows");
  assert.equal(state.targets[1].instances[0].source, "main/player.script.ts");
  assert.equal(state.targets[1].instances[0].schemaStatus, "current");
  assert.equal(state.targets[1].instances[0].properties[0].declaredKind, "number");
  assert.equal("authToken" in state, false);
});

test("authenticated dev state fairly bounds schema-enriched rows below the editor intake", () => {
  const model = createDevModel();
  const source = `${"deep/".repeat(600)}player.script.ts`;
  applyDevEvent(model, {
    type: "component-catalog",
    components: [{
      componentId: "player",
      schemaFingerprint: "schema-v1",
      source,
      proxy: `${source.slice(0, -3)}script`,
      properties: []
    }]
  });
  for (const [id, runtimeId] of [["local-engine", 1], ["browser-host", 2]]) {
    applyDevEvent(model, { type: "target-configured", id, runtime: id === "local-engine" ? "hermes" : "browser" });
    applyDevEvent(model, {
      schemaVersion: 1,
      type: "component-snapshot",
      id,
      connectionEpoch: 1,
      runtimeId,
      sequence: 1,
      sampledAt: 1,
      complete: true,
      omitted: { instances: 0, properties: 0 },
      instances: Array.from({ length: 1_024 }, (_, slot) => ({
        instanceId: { slot, generation: 1 },
        componentId: "player",
        schemaFingerprint: "schema-v1",
        contextKind: "game-object",
        properties: []
      }))
    });
  }
  const state = devStateSnapshot(model);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024);
  for (const target of state.targets) {
    assert.ok(target.instances.length > 0, "each live target receives a fair projection share");
    assert.ok(target.instanceProjection.omittedInstances > 0);
    assert.equal(target.instanceProjection.totalInstances, 1_024);
    assert.equal(target.instanceProjection.complete, false);
    assert.equal(target.instances.every((instance) => instance.source === source), true,
      "only complete server-enriched rows are projected");
  }
});

test("development browser launch always requests a fresh debug wasm-web bundle", async () => {
  const calls = [];
  const webBundle = path.join(tmpdir(), "custom-web-output", "War Battles");
  const result = await prepareDebugWebBundle({
    async bundle(options) {
      calls.push(options);
      return { bundleOutput: options.bundleOutput, platform: options.platform };
    }
  }, { webBundle, reason: "test browser launch" });
  assert.deepEqual(calls, [{
    platform: "wasm-web",
    variant: "debug",
    bundleOutput: path.dirname(webBundle),
    reason: "test browser launch"
  }]);
  assert.equal(result.platform, "wasm-web");
});

test("default development bundles use a project-keyed native cache outside Defold", () => {
  const project = path.resolve("/workspace/game");
  const output = defaultDefoldBundleOutput(project, {
    env: { XDG_CACHE_HOME: "/cache" },
    hostPlatform: "linux",
    userHome: "/home/player"
  });
  assert.match(output, /^\/cache\/deherm\/dev-bundles\/[a-f0-9]{24}$/u);
  assert.equal(path.relative(project, output).startsWith(".."), true);
  assert.equal(defaultDefoldBundleOutput(project, {
    env: { XDG_CACHE_HOME: "/cache" },
    hostPlatform: "linux",
    userHome: "/home/player"
  }), output, "the same project reuses its cached bundle root");
  assert.notEqual(defaultDefoldBundleOutput("/workspace/other", {
    env: { XDG_CACHE_HOME: "/cache" },
    hostPlatform: "linux",
    userHome: "/home/player"
  }), output, "sibling projects do not overwrite one another");

  const browserBuild = defaultDefoldBundleBuildOutput(project, "wasm-web");
  assert.equal(browserBuild, path.join(project, "build", "deherm-wasm-web"));
  assert.equal(bobFailureLogFile(browserBuild), path.join(browserBuild, "log.txt"),
    "bundle diagnostics follow Bob's actual --output tree");
  assert.notEqual(browserBuild, path.join(project, "build", "default"),
    "browser compilation never mutates the live native resource tree");
  assert.throws(() => defaultDefoldBundleBuildOutput(project, "../../outside"), /Invalid Defold bundle platform/u);
});

test("one-shot dev session compiles a typed resource generation without claiming activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-session-"));
  const entry = path.join(root, "src", "main.ts");
  const generatedRoot = path.join(root, "generated-sdk");
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.join(generatedRoot, "generated"), { recursive: true });
  await installComponentPolicy(generatedRoot);
  for (const file of ["resource-symbols.json", "script-route-symbol-index.json", "dmsdk-call-symbol-index.json"]) {
    await writeFile(path.join(generatedRoot, "generated", file), '{"stale":true}\n');
  }
  await writeFile(entry, 'declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string; console.log(`bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`);\n');
  const snapshot = await runDevSession({ project: root, entry, generatedRoot, once: true, useTtsc: false });
  assert.equal(snapshot.phase, "built");
  assert.equal(snapshot.lastSuccessfulGeneration, 1);
  assert.equal(snapshot.targets.length, 0);
  assert.ok(snapshot.logs.some(({ source, message }) => source === "compiler" && /some project API IR inputs are absent/.test(message)));
  for (const file of ["resource-symbols.json", "script-route-symbol-index.json", "dmsdk-call-symbol-index.json"]) {
    await assert.rejects(readFile(path.join(generatedRoot, "generated", file)), /ENOENT/u);
  }
  assert.match(await readFile(path.join(root, "deherm", "app.dehermc"), "utf8"), /bundle:/);
  assert.match(await readFile(path.join(root, "build", "default", "deherm", "app.dehermc"), "utf8"), /bundle:/);
});

test("one-shot dev session composes the generated component registry into the runtime bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-components-"));
  const entry = path.join(root, "main", "battle.gui.ts");
  await mkdir(path.dirname(entry), { recursive: true });
  await installComponentPolicy(path.join(root, ".deherm"));
  await writeFile(entry, [
    "function defineComponent<T>(definition: T): T { return definition; }",
    "export default defineComponent({ init() {} });",
    ""
  ].join("\n"));

  const snapshot = await runDevSession({ project: root, entry, once: true, useTtsc: false });
  assert.equal(snapshot.phase, "built");
  const bundle = await readFile(path.join(root, "deherm", "app.dehermc"), "utf8");
  assert.match(bundle, /__defoldComponentsV1/);
  assert.match(bundle, /deherm\.component\/v1\/[a-f0-9]{64}/);
});

test("dev resolves an explicit GUI entry relative to the project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-gui-entry-"));
  await mkdir(path.join(root, "main"), { recursive: true });
  await installComponentPolicy(path.join(root, ".deherm"));
  await writeFile(path.join(root, "main", "battle.gui.ts"), [
    "function defineComponent<T>(definition: T): T { return definition; }",
    "export default defineComponent({ init() {} });",
    ""
  ].join("\n"));

  const snapshot = await runDevSession({ project: root, entry: "main/battle.gui.ts", once: true, useTtsc: false });
  assert.equal(snapshot.phase, "built");
  assert.match(await readFile(path.join(root, "deherm", "app.dehermc"), "utf8"), /__defoldComponentsV1/);
});

test("one-shot dev session bundles mixed component contexts through the unfiltered SDK with ttsc", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-mixed-components-"));
  await mkdir(path.join(root, "main"), { recursive: true });
  await mkdir(path.join(root, ".deherm", "sdk"), { recursive: true });
  await installComponentPolicy(path.join(root, ".deherm"));
  await writeFile(path.join(root, ".deherm", "sdk", "index.ts"), [
    "export const go = Object.freeze({});",
    "export const gui = Object.freeze({});",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "tsconfig.deherm.base.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      plugins: [{ transform: "@ts-defold/deherm/ttsc", enabled: true, profile: "development" }]
    }
  }, null, 2)}\n`);
  await writeFile(path.join(root, "tsconfig.deherm.bundle.json"), `${JSON.stringify({
    extends: "./tsconfig.deherm.base.json",
    compilerOptions: { paths: { "@deherm/project": ["./.deherm/sdk/index.ts"] } },
    include: ["**/*.ts"]
  }, null, 2)}\n`);
  await writeFile(path.join(root, "main", "player.script.ts"), [
    'import { go } from "@deherm/project";',
    "function defineComponent<T>(definition: T): T { return definition; }",
    "void go;",
    "export default defineComponent({ init() {} });",
    ""
  ].join("\n"));
  const entry = path.join(root, "main", "battle.gui.ts");
  await writeFile(entry, [
    'import { gui } from "@deherm/project";',
    "function defineComponent<T>(definition: T): T { return definition; }",
    "void gui;",
    "export default defineComponent({ init() {} });",
    ""
  ].join("\n"));

  const snapshot = await runDevSession({ project: root, entry, once: true });
  assert.equal(snapshot.phase, "built");
  const bundle = await readFile(path.join(root, "deherm", "app.dehermc"), "utf8");
  assert.match(bundle, /__defoldComponentsV1/);
  assert.match(bundle, /player\.script/);
  assert.match(bundle, /battle\.gui/);
});
