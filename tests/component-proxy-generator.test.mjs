import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  componentProxyConstants,
  compileComponentSources,
  discoverComponentSources,
  generateComponentProxies
} from "../scripts/lib/component-proxy-generator.mjs";

const fixtureRoot = path.resolve("tests/fixtures/component-proxy");
const fixtureSource = path.join(fixtureRoot, "player.script.ts");
const fixtureRenderSource = path.join(fixtureRoot, "render.render.ts");
const classFixtureRoot = path.resolve("tests/fixtures/component-class");
const classFixtureSource = path.join(classFixtureRoot, "class-player.script.ts");
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

function minimalContextComponent() {
  return `
import { defineComponent } from "@ts-defold/deherm/component";
export default defineComponent({ update(_self: unknown, _dt: number): void {} });
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

  const player = result.manifest.components.find(({ source }) => source === "player.script.ts");
  const playerSpecialization = result.specializations.components.find(({ componentId }) => componentId === player.componentId);
  assert.equal(result.manifest.components.length, 2);
  assert.equal(player.lifecycleMask, 0b11_1111);
  assert.equal(player.reloadPolicy, "preserve-instance-state");
  assert.equal(playerSpecialization.reloadPolicy, "preserve-instance-state");
  assert.deepEqual(playerSpecialization.propertySlots.map(({ codecId }) => codecId), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(result.manifest.proxyRuntimeCapability.state, "native-dynamic-hermes-harness-executable");
  assert.equal(result.manifest.proxyRuntimeCapability.runtimeConformant, false);
  const proxy = await readFile(path.join(outputRoot, "player.script"), "utf8");
  assert.match(proxy, /local COMPONENT_CONTEXT = "game-object"/);
  assert.match(proxy, /\{ "speed", 1 \}/);
  assert.match(proxy, /function on_reload\(self\)\n    _deherm_\.dispatchReload\(self, COMPONENT_ID\)\nend/);
  assert.doesNotMatch(proxy.match(/function on_reload[\s\S]*?\nend/)?.[0] ?? "", /attachComponent|detachComponent/);
  const registry = await readFile(path.join(outputRoot, ".deherm/generated/components/registry.ts"), "utf8");
  assert.match(registry, /import component0 from "\.\.\/\.\.\/\.\.\/player\.script\.js";/);
  assert.match(registry, /import component1 from "\.\.\/\.\.\/\.\.\/render\.render\.js";/);
  assert.match(registry, /__defoldComponentsV1 = registry;/);
  assert.equal((registry.match(/definition: component/g) ?? []).length, result.manifest.components.length);
});

test("render source generates the exact supported proxy without an unavailable final detach", async () => {
  const outputRoot = await temporaryProject();
  const result = await generateComponentProxies({ projectRoot: fixtureRoot, sourceFiles: [fixtureRenderSource], outputRoot });
  const proxy = await readFile(path.join(outputRoot, "render.render_script"), "utf8");
  assert.equal(proxy, await readFile(path.join(fixtureRoot, "expected/render.render_script"), "utf8"));
  assert.doesNotMatch(proxy, /function final|function on_input|detachComponent/);
  assert.match(proxy, /teardown-policy: provider-required-unimplemented-no-final-callback/);
  assert.match(proxy, /proxy-runtime: native-dynamic-hermes-harness-executable/);
  const render = result.manifest.components.find(({ source }) => source === "render.render.ts");
  const renderSpecialization = result.specializations.components.find(({ componentId }) => componentId === render.componentId);
  assert.deepEqual(render.supportedLifecycles, ["init", "update", "onMessage", "onReload"]);
  assert.equal(render.teardownPolicy, "provider-required-unimplemented-no-final-callback");
  assert.equal(renderSpecialization.teardownPolicy, "provider-required-unimplemented-no-final-callback");
  assert.equal(result.specializations.proxyRuntimeCapability.state, "native-dynamic-hermes-harness-executable");
});

test("class authoring lowers through the same proxy ABI with static properties and lifecycle slots", async () => {
  const outputRoot = await temporaryProject();
  const result = await generateComponentProxies({
    projectRoot: classFixtureRoot,
    sourceFiles: [classFixtureSource],
    outputRoot
  });
  const component = result.manifest.components[0];
  const specialization = result.specializations.components[0];
  assert.equal(component.authoringStyle, "class");
  assert.equal(component.className, "ClassPlayer");
  assert.equal(component.lifecycleMask, 0b11_0011);
  assert.deepEqual(component.properties.map(({ name, kind }) => ({ name, kind })), [
    { name: "speed", kind: "number" },
    { name: "team", kind: "hash" }
  ]);
  assert.equal(specialization.authoringStyle, "class");
  assert.equal(specialization.className, "ClassPlayer");
  const proxy = await readFile(path.join(outputRoot, "class-player.script"), "utf8");
  assert.match(proxy, /go\.property\("speed", 90\)/);
  assert.match(proxy, /dispatchLifecycle\(self, COMPONENT_ID, "update", dt\)/);
  assert.match(proxy, /dispatchInput\(self, COMPONENT_ID, action_id, action\)/);
  assert.match(proxy, /dispatchReload\(self, COMPONENT_ID\)/);

  const checked = spawnSync(process.execPath, [
    path.resolve("node_modules/typescript/bin/tsc"),
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
    "--target", "ES2020", "--module", "ESNext", "--moduleResolution", "Bundler",
    classFixtureSource,
    path.resolve("packages/sdk/src/component.ts")
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("class authoring rejects context mismatch, allocating lifecycle fields, and constructor arguments", async (t) => {
  const cases = [
    {
      name: "wrong context base",
      body: `
        import { component, GuiComponent } from "@ts-defold/deherm/component";
        class Player extends GuiComponent {}
        export default component(Player);
      `,
      error: /class components must extend ScriptComponent/
    },
    {
      name: "lifecycle instance field",
      body: `
        import { component, ScriptComponent } from "@ts-defold/deherm/component";
        class Player extends ScriptComponent { update = (_dt: number): void => {}; }
        export default component(Player);
      `,
      error: /lifecycle "update" must be a prototype method/
    },
    {
      name: "constructor arguments",
      body: `
        import { component, ScriptComponent } from "@ts-defold/deherm/component";
        class Player extends ScriptComponent { constructor(_value: number) { super(); } }
        export default component(Player);
      `,
      error: /constructor must accept zero arguments/
    }
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const projectRoot = await temporaryProject();
    const source = await componentSource(projectRoot, "player.script.ts", fixture.body);
    await assert.rejects(compileComponentSources({ projectRoot, sourceFiles: [source] }), fixture.error);
  });
});

test("class authoring always emits the attach-time initializer needed to construct per-instance state", async () => {
  const projectRoot = await temporaryProject();
  const source = await componentSource(projectRoot, "constructor-only.script.ts", `
    import { component, ScriptComponent } from "@ts-defold/deherm/component";
    class ConstructorOnly extends ScriptComponent { value = 1; }
    export default component(ConstructorOnly);
  `);
  const [compiled] = await compileComponentSources({ projectRoot, sourceFiles: [source] });
  assert.equal(compiled.authoringStyle, "class");
  assert.equal(compiled.lifecycles.init, true);
  assert.equal(compiled.lifecycleMask, 1);
  const outputRoot = await temporaryProject();
  await generateComponentProxies({ projectRoot, outputRoot });
  assert.match(
    await readFile(path.join(outputRoot, "constructor-only.script"), "utf8"),
    /dispatchLifecycle\(self, COMPONENT_ID, "init"\)/
  );
});

test("GUI and render lifecycle contracts match pinned Defold function tables", async () => {
  const extract = (source, name) => {
    const body = source.match(new RegExp(`(?:const|static const) char\\* ${name}\\[[^\\]]*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`))?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/"([a-z_]+)"/g)].map(([, value]) => ({ on_message: "onMessage", on_input: "onInput", on_reload: "onReload" })[value] ?? value);
  };
  const [guiSource,renderSource]=await Promise.all([
    readFile(path.resolve("upstream/defold/engine/gui/src/gui.cpp"),"utf8"),
    readFile(path.resolve("upstream/defold/engine/render/src/render/render_script.cpp"),"utf8")
  ]);
  const gui=componentProxyConstants.sourceKinds.find(({suffix})=>suffix===".gui.ts");
  const render=componentProxyConstants.sourceKinds.find(({suffix})=>suffix===".render.ts");
  assert.deepEqual(extract(guiSource,"SCRIPT_FUNCTION_NAMES"),gui.lifecycle.supported);
  assert.deepEqual(extract(renderSource,"RENDER_SCRIPT_FUNCTION_NAMES"),render.lifecycle.supported);
});

test("render components reject lifecycle hooks Defold never calls", async (t) => {
  for(const lifecycle of ["final","onInput"])await t.test(lifecycle,async()=>{
    const projectRoot=await temporaryProject();
    const source=await componentSource(projectRoot,"invalid.render.ts",`
      import { defineComponent } from "@ts-defold/deherm/component";
      export default defineComponent({ ${lifecycle}(): void {} });
    `);
    await assert.rejects(compileComponentSources({projectRoot,sourceFiles:[source]}),new RegExp(`render_script components do not support lifecycle "${lifecycle}"`));
  });
});

test("authored suffixes route deterministically to Defold component proxies and plain TypeScript stays plain", async () => {
  const projectRoot = await temporaryProject();
  const files = [
    await componentSource(projectRoot, "game/player.script.ts", minimalComponent()),
    await componentSource(projectRoot, "game/hud.gui.ts", minimalContextComponent()),
    await componentSource(projectRoot, "game/legacy.gui_script.ts", minimalContextComponent()),
    await componentSource(projectRoot, "game/main.render.ts", minimalContextComponent())
  ];
  await componentSource(projectRoot, "game/math.ts", "export const add = (a: number, b: number) => a + b;\n");

  const discovered = await discoverComponentSources(projectRoot);
  assert.deepEqual(discovered.map((file) => path.relative(projectRoot, file)), [
    "game/hud.gui.ts", "game/legacy.gui_script.ts", "game/main.render.ts", "game/player.script.ts"
  ]);
  const firstOutput = await temporaryProject();
  const secondOutput = await temporaryProject();
  const first = await generateComponentProxies({ projectRoot, sourceFiles: files.toReversed(), outputRoot: firstOutput });
  const second = await generateComponentProxies({ projectRoot, sourceFiles: files, outputRoot: secondOutput });
  assert.equal(
    await readFile(path.join(firstOutput, ".deherm/generated/components/manifest.json"), "utf8"),
    await readFile(path.join(secondOutput, ".deherm/generated/components/manifest.json"), "utf8")
  );
  assert.equal(
    await readFile(path.join(firstOutput, ".deherm/generated/components/registry.ts"), "utf8"),
    await readFile(path.join(secondOutput, ".deherm/generated/components/registry.ts"), "utf8")
  );
  assert.deepEqual(first.manifest.sourceConventions, componentProxyConstants.sourceKinds.map(({ suffix, canonicalSuffix, proxySuffix, proxyKind, contextKind, supportsProperties, legacy, lifecycle }) => ({
    authoredSuffix: suffix, canonicalAuthoredSuffix: canonicalSuffix, proxySuffix, proxyKind, contextKind, supportsProperties, legacy,
    supportedLifecycles: lifecycle.supported, teardownPolicy: lifecycle.teardownPolicy, ...(lifecycle.evidence ? { lifecycleEvidence: lifecycle.evidence } : {})
  })));
  assert.deepEqual(first.manifest.components.map(({ source, proxy, proxyKind, contextKind, legacyAuthoredSuffix }) => ({ source, proxy, proxyKind, contextKind, legacyAuthoredSuffix })), [
    { source: "game/hud.gui.ts", proxy: "game/hud.gui_script", proxyKind: "gui_script", contextKind: "gui-scene", legacyAuthoredSuffix: false },
    { source: "game/legacy.gui_script.ts", proxy: "game/legacy.gui_script", proxyKind: "gui_script", contextKind: "gui-scene", legacyAuthoredSuffix: true },
    { source: "game/main.render.ts", proxy: "game/main.render_script", proxyKind: "render_script", contextKind: "render-instance+graphics", legacyAuthoredSuffix: false },
    { source: "game/player.script.ts", proxy: "game/player.script", proxyKind: "script", contextKind: "game-object", legacyAuthoredSuffix: false }
  ]);
  for(const proxy of ["game/player.script", "game/hud.gui_script", "game/legacy.gui_script", "game/main.render_script"]) {
    assert.match(await readFile(path.join(firstOutput, proxy), "utf8"), /^-- @generated by/);
  }
  await assert.rejects(
    compileComponentSources({ projectRoot, sourceFiles: [path.join(projectRoot, "game/math.ts")] }),
    /must end in \.script\.ts, \.gui\.ts, \.render\.ts, or legacy \.gui_script\.ts/
  );
  assert.equal(second.manifest.components.length, 4);
});

test("canonical .gui.ts and legacy .gui_script.ts may not target the same proxy", async () => {
  const projectRoot = await temporaryProject();
  const canonical = await componentSource(projectRoot, "hud.gui.ts", minimalContextComponent());
  const legacy = await componentSource(projectRoot, "hud.gui_script.ts", minimalContextComponent());
  await assert.rejects(
    compileComponentSources({ projectRoot, sourceFiles: [legacy, canonical] }),
    /both generate hud\.gui_script; prefer canonical hud\.gui\.ts/
  );
});

test("explicit inputs still compile the full inventory and cannot hide proxy collisions", async () => {
  const projectRoot = await temporaryProject();
  const first = await componentSource(projectRoot, "first.script.ts", minimalComponent());
  await componentSource(projectRoot, "second.script.ts", minimalComponent());
  const outputRoot = await temporaryProject();
  const generated = await generateComponentProxies({ projectRoot, sourceFiles: [first], outputRoot });
  assert.deepEqual(generated.manifest.components.map(({ source }) => source), ["first.script.ts", "second.script.ts"]);

  await componentSource(projectRoot, "hud.gui.ts", minimalContextComponent());
  const legacy = await componentSource(projectRoot, "hud.gui_script.ts", minimalContextComponent());
  await assert.rejects(
    generateComponentProxies({ projectRoot, sourceFiles: [legacy], outputRoot }),
    /both generate hud\.gui_script; prefer canonical hud\.gui\.ts/
  );
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
  const outputRoot = await temporaryProject("deherm-war-battles-proxies-");
  const generated = await generateComponentProxies({
    projectRoot: warBattlesRoot,
    outputRoot
  });
  assert.equal(generated.manifest.components.length, 3);
  for (const component of generated.manifest.components) {
    assert.equal(
      await readFile(path.join(outputRoot, component.proxy), "utf8"),
      await readFile(path.join(warBattlesRoot, component.proxy), "utf8"),
      component.proxy
    );
  }
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

test("component body edits update provenance without invalidating the Defold proxy", async () => {
  const projectRoot = await temporaryProject();
  const source = await componentSource(projectRoot, "player.script.ts", minimalComponent());
  const first = await generateComponentProxies({ projectRoot });
  assert.ok(first.defoldResourceStale.some((file) => file.endsWith("player.script")));
  const proxy = path.join(projectRoot, "player.script");
  const originalProxy = await readFile(proxy, "utf8");

  await writeFile(source, minimalComponent("property.number(1)", "const implementationOnly = 2; void implementationOnly;"), "utf8");
  const implementationEdit = await generateComponentProxies({ projectRoot });
  assert.deepEqual(implementationEdit.defoldResourceStale, []);
  assert.ok(implementationEdit.stale.some((file) => file.endsWith("manifest.json")));
  assert.equal(await readFile(proxy, "utf8"), originalProxy);

  await writeFile(source, minimalComponent("property.number(2)"), "utf8");
  const schemaEdit = await generateComponentProxies({ projectRoot });
  assert.deepEqual(schemaEdit.defoldResourceStale, [proxy]);
  assert.notEqual(await readFile(proxy, "utf8"), originalProxy);
});

test("full-inventory reconciliation reports and removes only owned orphan proxies", async () => {
  const projectRoot = await temporaryProject();
  const source = await componentSource(projectRoot, "retired.script.ts", minimalComponent());
  await generateComponentProxies({ projectRoot });
  const proxy = path.join(projectRoot, "retired.script");
  await rm(source);

  await assert.rejects(
    generateComponentProxies({ projectRoot, check: true }),
    /component proxy outputs are missing or stale:[\s\S]*retired\.script/
  );
  await generateComponentProxies({ projectRoot });
  await assert.rejects(readFile(proxy, "utf8"), /ENOENT/);
  await generateComponentProxies({ projectRoot, check: true });
});

test("orphan reconciliation never deletes a proxy whose ownership headers were removed", async () => {
  const projectRoot = await temporaryProject();
  const source = await componentSource(projectRoot, "retired.script.ts", minimalComponent());
  await generateComponentProxies({ projectRoot });
  const proxy = path.join(projectRoot, "retired.script");
  await rm(source);
  await writeFile(proxy, "-- user-owned replacement\n", "utf8");

  await assert.rejects(
    generateComponentProxies({ projectRoot }),
    /refusing to delete a \.script, \.gui_script, or \.render_script file without complete Deherm ownership headers/
  );
  assert.equal(await readFile(proxy, "utf8"), "-- user-owned replacement\n");
});

test("all output ownership checks finish before any stale file is rewritten", async () => {
  const projectRoot = await temporaryProject();
  await componentSource(projectRoot, "a.script.ts", minimalComponent());
  await componentSource(projectRoot, "z.script.ts", minimalComponent());
  await generateComponentProxies({ projectRoot });
  const firstProxy = path.join(projectRoot, "a.script");
  const blockedProxy = path.join(projectRoot, "z.script");
  const staleFirst = `${await readFile(firstProxy, "utf8")}-- intentionally stale\n`;
  await writeFile(firstProxy, staleFirst, "utf8");
  await writeFile(blockedProxy, "-- user-owned replacement\n", "utf8");

  await assert.rejects(generateComponentProxies({ projectRoot }), /refusing to overwrite/);
  assert.equal(await readFile(firstProxy, "utf8"), staleFirst);
  assert.equal(await readFile(blockedProxy, "utf8"), "-- user-owned replacement\n");
});

test("generator refuses to overwrite user-owned script, GUI, and render proxies", async (t) => {
  for (const fixture of [
    { source: "player.script.ts", proxy: "player.script", body: minimalComponent() },
    { source: "hud.gui.ts", proxy: "hud.gui_script", body: minimalContextComponent() },
    { source: "main.render.ts", proxy: "main.render_script", body: minimalContextComponent() }
  ]) await t.test(fixture.proxy, async () => {
    const projectRoot = await temporaryProject();
    const source = await componentSource(projectRoot, fixture.source, fixture.body);
    await writeFile(path.join(projectRoot, fixture.proxy), "-- user-owned gameplay\n", "utf8");
    await assert.rejects(
      generateComponentProxies({ projectRoot, sourceFiles: [source] }),
      /refusing to overwrite a \.script, \.gui_script, or \.render_script file without complete Deherm ownership headers/
    );
    assert.equal(await readFile(path.join(projectRoot, fixture.proxy), "utf8"), "-- user-owned gameplay\n");
  });
});

test("generator refuses to transfer a marked proxy between component owners", async () => {
  const projectRoot = await temporaryProject();
  await componentSource(projectRoot, "player.script.ts", minimalComponent());
  const proxy = path.join(projectRoot, "player.script");
  await writeFile(proxy, [
    componentProxyConstants.generatedMarker,
    "-- source: another.script.ts",
    `-- component-id: ${componentProxyConstants.componentIdNamespace}/${"0".repeat(64)}`,
    ""
  ].join("\n"), "utf8");
  await assert.rejects(
    generateComponentProxies({ projectRoot }),
    /refusing to overwrite proxy owned by another\.script\.ts/
  );
  assert.match(await readFile(proxy, "utf8"), /source: another\.script\.ts/);
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
  await componentSource(projectRoot, "plain.ts", "export {};\n");
  await componentSource(projectRoot, "build/ignored.script.ts", minimalComponent());
  await componentSource(projectRoot, "node_modules/ignored.script.ts", minimalComponent());

  const discovered = await discoverComponentSources(projectRoot);
  assert.deepEqual(discovered.map((file) => path.relative(projectRoot, file)), ["nested/a.script.ts", "z.script.ts"]);
});

test("inventory ordering uses locale-independent code-unit order", async () => {
  const projectRoot = await temporaryProject();
  const names = ["a_thing.script.ts", "a-thing.script.ts", "A.script.ts", "ä.script.ts", "z.script.ts"];
  for (const name of names) await componentSource(projectRoot, name, minimalComponent());
  const generated = await generateComponentProxies({ projectRoot, sourceFiles: names.toReversed().map((name) => path.join(projectRoot, name)) });
  assert.deepEqual(generated.manifest.components.map(({ source }) => source), [
    "A.script.ts",
    "a-thing.script.ts",
    "a_thing.script.ts",
    "z.script.ts",
    "ä.script.ts"
  ]);
});
