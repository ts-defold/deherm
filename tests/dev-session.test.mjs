import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDevSession } from "../packages/cli/src/dev/session.mjs";

test("one-shot dev session compiles a typed resource generation without claiming activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-session-"));
  const entry = path.join(root, "src", "main.ts");
  const generatedRoot = path.join(root, "generated-sdk");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.join(generatedRoot, "generated"), { recursive: true });
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
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(entry), { recursive: true });
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
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "main"), { recursive: true });
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
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "main"), { recursive: true });
  await mkdir(path.join(root, ".deherm", "sdk"), { recursive: true });
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
