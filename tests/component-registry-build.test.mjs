import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { buildComponentRegistry } from "../scripts/build-component-registry.mjs";

const componentPolicy = JSON.parse(await readFile(
  path.resolve("packages/bindings/generated/defold-component-proxy-contract.json"), "utf8"));

async function source(root, relative, context) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const properties = relative.endsWith(".script.ts")
    ? "properties: { speed: property.number(7) },"
    : "";
  await writeFile(file, `
    function defineComponent<const T>(value: T): T { return value; }
    const property = { number(value: number): number { return value; } };
    export default defineComponent({
      ${properties}
      init(self: { context?: string }): void { self.context = ${JSON.stringify(context)}; },
      update(_self: unknown, _dt: number): void {}
    });
  `);
}

test("compiler emits, type-checks, bundles, caches, and verifies the complete component registry", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "deherm-component-registry-"));
  const outputRoot = path.join(projectRoot, ".deherm/build/components");
  await source(projectRoot, "nested/player.script.ts", "game-object");
  await source(projectRoot, "ui/hud.gui.ts", "gui-scene");
  await source(projectRoot, "render/main.render.ts", "render-instance+graphics");

  const first = await buildComponentRegistry({ projectRoot, outputRoot, componentPolicy });
  assert.equal(first.cacheHit, false);
  assert.equal(first.manifest.components.length, 3);
  const registryPath = path.join(projectRoot, ".deherm/generated/components/registry.ts");
  const tsc = spawnSync(process.execPath, [
    path.resolve("node_modules/typescript/bin/tsc"),
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
    "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "Bundler",
    registryPath,
    ...first.manifest.components.map(({ source }) => path.join(projectRoot, source))
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);

  const bundlePath = path.join(outputRoot, "components.js");
  const sentinelPath = path.join(outputRoot, "component-bundle.sentinel.json");
  const before = { bundle: (await stat(bundlePath)).mtimeMs, sentinel: (await stat(sentinelPath)).mtimeMs };
  const second = await buildComponentRegistry({ projectRoot, outputRoot, componentPolicy });
  assert.equal(second.cacheHit, true);
  assert.deepEqual(
    { bundle: (await stat(bundlePath)).mtimeMs, sentinel: (await stat(sentinelPath)).mtimeMs },
    before
  );
  await buildComponentRegistry({ projectRoot, outputRoot, check: true, componentPolicy });

  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(await readFile(bundlePath, "utf8"), context);
  const registrations = Object.values(context.__defoldComponentsV1);
  assert.equal(registrations.length, 3);
  assert.deepEqual(
    registrations.map(({ contextKind }) => contextKind).sort(),
    ["game-object", "gui-scene", "render-instance+graphics"].sort()
  );

  await writeFile(bundlePath, `${await readFile(bundlePath, "utf8")}\n// tampered\n`);
  await assert.rejects(
    buildComponentRegistry({ projectRoot, outputRoot, check: true, componentPolicy }),
    /stale/
  );
});
