import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileComponentSources,
  discoverComponentSources,
  generateComponentProxies
} from "../scripts/lib/component-proxy-generator.mjs";

const fixtureRoot = path.resolve("tests/fixtures/component-proxy");
const fixtureSource = path.join(fixtureRoot, "player.script.ts");
const warBattlesRoot = path.resolve("tests/fixtures/war-battles");

async function temporaryProject(name = "deherm-component-") {
  return mkdtemp(path.join(tmpdir(), name));
}

async function componentSource(root, relative, body) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
  return file;
}

function minimalComponent(propertyExpression = "property.number(1)", extra = "") {
  return `
import { defineComponent, property } from "@ts-defold/deherm/component";
${extra}
export default defineComponent({
  properties: { value: ${propertyExpression} },
  update(_self: unknown, _dt: number): void {},
});
`;
}

test("typed .script.ts source generates exact Lua, manifest, and native specialization goldens", async () => {
  const outputRoot = await temporaryProject();
  const result = await generateComponentProxies({
    projectRoot: fixtureRoot,
    sourceFiles: [fixtureSource],
    outputRoot
  });

  const cases = [
    ["player.script", "expected/player.script"],
    [".deherm/generated/components/manifest.json", "expected/manifest.json"],
    [".deherm/generated/components/specializations.json", "expected/specializations.json"]
  ];
  for (const [actual, expected] of cases) {
    assert.equal(
      await readFile(path.join(outputRoot, actual), "utf8"),
      await readFile(path.join(fixtureRoot, expected), "utf8"),
      actual
    );
  }

  assert.equal(result.manifest.components.length, 1);
  assert.equal(result.manifest.components[0].lifecycleMask, 0b11_1111);
  assert.equal(result.manifest.components[0].reloadPolicy, "preserve-instance-state");
  assert.equal(result.specializations.components[0].reloadPolicy, "preserve-instance-state");
  assert.deepEqual(result.specializations.components[0].propertySlots.map(({ codecId }) => codecId), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const proxy = await readFile(path.join(outputRoot, "player.script"), "utf8");
  assert.match(proxy, /function on_reload\(self\)\n    defold_hermes\.dispatchReload\(self, COMPONENT_ID\)\nend/);
  assert.doesNotMatch(proxy.match(/function on_reload[\s\S]*?\nend/)?.[0] ?? "", /attachComponent|detachComponent/);
});

test("the authored component fixture passes the TypeScript 7 type checker", () => {
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [
    tsc,
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target", "ES2020",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    path.join(fixtureRoot, "component-api.d.ts"),
    fixtureSource
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("War Battles sources type-check against the shipped component API and proxies stay fresh", async () => {
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [
    tsc,
    "--project", path.join(warBattlesRoot, "tsconfig.json"),
    "--pretty", "false"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  const generated = await generateComponentProxies({
    projectRoot: warBattlesRoot,
    outputRoot: warBattlesRoot,
    check: true
  });
  assert.equal(generated.stale.length, 0);
  assert.equal(generated.manifest.components.length, 3);
});

test("check mode is a strict freshness gate and normal generation repairs marked outputs", async () => {
  const outputRoot = await temporaryProject();
  const options = { projectRoot: fixtureRoot, sourceFiles: [fixtureSource], outputRoot };
  await generateComponentProxies(options);
  await generateComponentProxies({ ...options, check: true });

  const proxy = path.join(outputRoot, "player.script");
  await writeFile(proxy, `${await readFile(proxy, "utf8")}-- stale\n`, "utf8");
  await assert.rejects(
    generateComponentProxies({ ...options, check: true }),
    /component proxy outputs are missing or stale:[\s\S]*player\.script/
  );

  await generateComponentProxies(options);
  await generateComponentProxies({ ...options, check: true });
  assert.doesNotMatch(await readFile(proxy, "utf8"), /-- stale/);
});

test("generator refuses to overwrite a user-owned sibling .script", async () => {
  const projectRoot = await temporaryProject();
  const source = await componentSource(projectRoot, "player.script.ts", minimalComponent());
  await writeFile(path.join(projectRoot, "player.script"), "-- user-owned gameplay\n", "utf8");

  await assert.rejects(
    generateComponentProxies({ projectRoot, sourceFiles: [source] }),
    /refusing to overwrite a \.script or \.gui_script file without the Deherm generated marker/
  );
  assert.equal(await readFile(path.join(projectRoot, "player.script"), "utf8"), "-- user-owned gameplay\n");
});

test("property schema parsing fails closed for expressions, unknown codecs, URL defaults, spreads, and unsafe names", async (t) => {
  const cases = [
    {
      name: "nonliteral number",
      source: minimalComponent("property.number(DEFAULT_SPEED)", "const DEFAULT_SPEED = 12;"),
      error: /expected a numeric literal/
    },
    {
      name: "unknown property kind",
      source: minimalComponent('property.color("red")'),
      error: /unsupported property kind/
    },
    {
      name: "nonempty URL default",
      source: minimalComponent('property.url("#enemy")'),
      error: /expected 0 arguments, received 1/
    },
    {
      name: "spread property schema",
      source: `
        import { defineComponent, property } from "@ts-defold/deherm/component";
        const base = { speed: property.number(1) };
        export default defineComponent({ properties: { ...base } });
      `,
      error: /only explicit property assignments and methods are supported/
    },
    {
      name: "unsafe Lua field",
      source: `
        import { defineComponent, property } from "@ts-defold/deherm/component";
        export default defineComponent({ properties: { "bad-name": property.number(1) } });
      `,
      error: /name must be a Lua-safe identifier/
    },
    {
      name: "unknown component member",
      source: `
        import { defineComponent } from "@ts-defold/deherm/component";
        export default defineComponent({ initialise() {} });
      `,
      error: /unsupported component member "initialise"/
    },
    {
      name: "async lifecycle",
      source: `
        import { defineComponent } from "@ts-defold/deherm/component";
        export default defineComponent({ async update() {} });
      `,
      error: /lifecycle must be synchronous/
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const projectRoot = await temporaryProject();
      const source = await componentSource(projectRoot, "invalid.script.ts", fixture.source);
      await assert.rejects(compileComponentSources({ projectRoot, sourceFiles: [source] }), fixture.error);
    });
  }
});

test("component IDs are stable by normalized project path and distinct for different paths", async () => {
  const projectRoot = await temporaryProject();
  const a = await componentSource(projectRoot, "actors/player.script.ts", minimalComponent("property.number(1)"));
  const b = await componentSource(projectRoot, "enemies/player.script.ts", minimalComponent("property.number(1)"));
  const initial = await compileComponentSources({ projectRoot, sourceFiles: [b, a] });

  assert.deepEqual(initial.map(({ source }) => source), ["actors/player.script.ts", "enemies/player.script.ts"]);
  assert.notEqual(initial[0].componentId, initial[1].componentId);
  assert.match(initial[0].componentId, /^deherm\.component\/v1\/[a-f0-9]{64}$/);

  await writeFile(a, minimalComponent("property.number(2)"), "utf8");
  const changed = await compileComponentSources({ projectRoot, sourceFiles: [a] });
  assert.equal(changed[0].componentId, initial[0].componentId);
  assert.notEqual(changed[0].sourceSha256, initial[0].sourceSha256);
  assert.notEqual(changed[0].schemaFingerprint, initial[0].schemaFingerprint);
});

test("discovery is deterministic and skips generated, dependency, build, and symlink trees", async () => {
  const projectRoot = await temporaryProject();
  await componentSource(projectRoot, "z.script.ts", minimalComponent());
  await componentSource(projectRoot, "nested/a.script.ts", minimalComponent());
  await componentSource(projectRoot, "build/ignored.script.ts", minimalComponent());
  await componentSource(projectRoot, "node_modules/ignored.script.ts", minimalComponent());

  const discovered = await discoverComponentSources(projectRoot);
  assert.deepEqual(discovered.map((file) => path.relative(projectRoot, file)), ["nested/a.script.ts", "z.script.ts"]);
});
