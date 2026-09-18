import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { buildProjectBindingIr, buildScriptContextCapabilities, generateExtensionTypes, verifyGeneratedProject, writeGeneratedProject } from "../packages/cli/src/generate.mjs";
import { inspectDefoldProject, parseGameProject, resolveEngineProfiles } from "../packages/cli/src/project.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "defold-hermes-cli-"));
  await mkdir(path.join(root, "camera", "src"), { recursive: true });
  await mkdir(path.join(root, "camera", "include"), { recursive: true });
  await mkdir(path.join(root, ".internal", "lib"), { recursive: true });
  await writeFile(path.join(root, "game.project"), `[project]\ntitle = Fixture\ndependencies#0 = https://token:secret@example.com/math.zip?signature=private#fragment\n`);
  await writeFile(path.join(root, "camera", "ext.manifest"), `name: Camera\nplatforms:\n  arm64-osx: {}\n`);
  await writeFile(path.join(root, "camera", "include", "camera.h"), "bool CameraStart(void);\n");
  await writeFile(path.join(root, "camera", "src", "camera.cpp"), "// fixture\n");
  await writeFile(path.join(root, "camera", "camera.script_api"), `
- name: camera
  type: table
  desc: Camera access.
  members:
    - name: start
      type: function
      parameters:
        - name: facing
          type: string
      return:
        type: boolean
    - name: focus_target
      type: function
      parameters:
        - name: target
          type: string|hash|url
`);
  const archive = zipSync({
    "math/ext.manifest": strToU8("name: XMath\n"),
    "math/include/xmath.h": strToU8("double XMathDot(double left, double right);\n"),
    "math/src/xmath.cpp": strToU8("// fixture\n"),
    "math/xmath.script_api": strToU8(`
- name: xmath
  type: table
  members:
    - name: dot
      type: function
      parameters:
        - name: left
          type: number
        - name: right
          type: number
      return:
        type: number
`)
  });
  await writeFile(path.join(root, ".internal", "lib", "math.zip"), archive);
  return root;
}

test("game.project parser preserves indexed dependency keys", () => {
  const parsed = parseGameProject("[project]\ndependencies#0 = a\ndependencies#1 = b\n");
  assert.equal(parsed.project["dependencies#0"], "a");
  assert.equal(parsed.project["dependencies#1"], "b");
});

test("project inspection finds local and resolved dependency extensions", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  assert.deepEqual(inventory.summary, {
    localExtensions: 1,
    dependencyExtensions: 1,
    scriptApiFiles: 2,
    scriptModules: 2,
    publicHeaders: 2,
    extensionsRequiringNativeSchema: 2,
    extensionsWithoutApiMetadata: 0
  });
  assert.deepEqual(inventory.extensions.map(({ kind, name }) => [kind, name]), [
    ["local", "Camera"],
    ["dependency", "XMath"]
  ]);
  assert.deepEqual(inventory.dependencyUrls, ["https://example.com/math.zip"]);
  assert.deepEqual(inventory.engineProfiles, {
    source: "defold-default",
    manifest: null,
    manifestSha256: null,
    defaultProfileId: "default-legacy-bullet",
    platforms: {}
  });
  assert.deepEqual(inventory.extensions[0].publicHeaders, ["camera/include/camera.h"]);
  assert.deepEqual(inventory.extensions[0].sourceFiles, ["camera/src/camera.cpp"]);
  assert.deepEqual(inventory.extensions[1].publicHeaders, ["math.zip:math/include/xmath.h"]);
  assert.deepEqual(inventory.extensions.map(({ bindingStatus: status }) => status), [
    "script-api+native-schema-required",
    "script-api+native-schema-required"
  ]);
  assert.deepEqual(inventory.diagnostics, []);
});

test("project inspection follows symlinked extensions without duplicate traversal", async () => {
  const project = await fixture();
  const external = await mkdtemp(path.join(tmpdir(), "defold-hermes-linked-extension-"));
  await writeFile(path.join(external, "ext.manifest"), "name: LinkedPhysics\n");
  await writeFile(path.join(external, "physics.script_api"), `
- name: linked_physics
  type: table
  members:
    - name: step
      type: function
      parameters:
        - name: dt
          type: number
`);
  await symlink(external, path.join(project, "linked-physics"), "dir");

  const inventory = await inspectDefoldProject({ project });
  const linked = inventory.extensions.find(({ name }) => name === "LinkedPhysics");
  assert.ok(linked);
  assert.equal(linked.root, "linked-physics");
  assert.equal(linked.scriptApis[0].path, "linked-physics/physics.script_api");
  assert.deepEqual(inventory.diagnostics, []);
});

test("extension script APIs produce deterministic TypeScript declarations", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  const types = generateExtensionTypes(inventory);
  assert.match(types, /from "\.\/sdk\/address\.js"/);
  assert.match(types, /export interface CameraExtension/);
  assert.match(types, /start\(facing: string\): boolean/);
  assert.match(types, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\): void/);
  assert.match(types, /export interface XmathExtension/);
  assert.match(types, /dot\(left: number, right: number\): number/);

  const ir = buildProjectBindingIr(inventory);
  assert.equal(ir.modules[0].id, "script:camera");
  assert.equal(ir.modules[0].members[0].id, "script:camera.start");
  assert.equal(ir.modules[0].members[0].lowering.dynamicHermes, "lua-compatibility");
  assert.equal(ir.modules[0].members[1].rawName, "focus_target");
  assert.equal(ir.modules[0].members[1].jsName, "focusTarget");

  const output = await writeGeneratedProject(inventory);
  const saved = await readFile(path.join(output.root, "extensions.d.ts"), "utf8");
  assert.equal(saved, types);
  assert.deepEqual(JSON.parse(await readFile(path.join(output.root, "bindings.ir.json"), "utf8")), ir);
  const camera = await readFile(path.join(output.root, "sdk", "modules", "camera.ts"), "utf8");
  assert.match(camera, /export const camera: CameraExtension/);
  assert.match(camera, /callExtension\("camera", "start", \[facing\]\)/);
  assert.match(camera, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\)/);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  assert.match(index, /export \* from "\.\/generated\/script\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/scalar\.js"/);
  assert.match(index, /export \{ camera \} from "\.\/modules\/camera\.js"/);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.match(manifest.defoldRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.coverage.script.functions, 926);
  assert.equal(manifest.coverage.script.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.script.runtimeImplemented, 93);
  assert.equal(manifest.coverage.script.runtimePending, 833);
  assert.deepEqual(manifest.coverage.script.runtimeLanes, {
    specializedLuaCompatibility: 3,
    generatedScalarDispatch: 90
  });
  assert.equal(manifest.coverage.dmsdk.declarations, 2140);
  assert.equal(manifest.coverage.dmsdk.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.dmsdk.runtimeImplemented, 26);
  assert.equal(manifest.coverage.dmsdk.runtimePending, 1335);
  assert.deepEqual(manifest.coverage.dmsdk.runtimeLanes, { generatedScalarThunks: 26 });
  assert.equal(manifest.platform, "arm64-macos");
  assert.equal(manifest.coverage.dmsdk.diagnosticHeaders, 35);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "script", "types.ts"), "utf8"), /export interface MsgApi/);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "dmsdk", "types.ts"), "utf8"), /export interface DmSdkCalls/);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "script-scalar-dispatch.json"), "utf8")).bindingCount, 90);
  const profiles = JSON.parse(await readFile(path.join(output.root, "ir", "script-route-profiles.json"), "utf8"));
  const loweringPlan = JSON.parse(await readFile(path.join(output.root, "ir", "binding-lowering-plan.json"), "utf8"));
  assert.ok(profiles.profiles["default-legacy-bullet"]);
  assert.ok(profiles.profiles["v3-bullet"]);
  assert.equal(manifest.engineProfiles.source, "defold-default");
  assert.equal(manifest.engineProfiles.defaultProfileId, "default-legacy-bullet");
  assert.equal(manifest.engineProfiles.catalogSha256, profiles.catalogSha256);
  assert.equal(manifest.engineProfiles.handshakeSchema, "deherm.script-route-capabilities/v1");
  assert.deepEqual(manifest.loweringPlan, {
    sha256: loweringPlan.planSha256,
    units: 2287,
    backendRecords: 11435
  });
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "dmsdk-scalar-thunks.json"), "utf8")).coverage.generated, 26);
  const lock = JSON.parse(await readFile(path.join(project, "deherm.lock"), "utf8"));
  assert.equal(lock.defoldRevision, manifest.defoldRevision);
  assert.equal(lock.platform, manifest.platform);
  assert.deepEqual(lock.inputs, manifest.inputs);
  assert.deepEqual(lock.generatedOutputs, manifest.generatedOutputs);
  assert.deepEqual(lock.engineProfiles, manifest.engineProfiles);
  const verified = await verifyGeneratedProject(project);
  assert.equal(verified.checkedFiles, 19);
  assert.equal(verified.planSha256, loweringPlan.planSha256);
  const verifiedCli = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "verify-generated", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(verifiedCli.status, 0, `${verifiedCli.stdout}\n${verifiedCli.stderr}`);
  assert.equal(JSON.parse(verifiedCli.stdout).planSha256, loweringPlan.planSha256);

  const dispatchPath = path.join(output.root, "ir", "script-scalar-dispatch.json");
  await writeFile(dispatchPath, `${await readFile(dispatchPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /does not match generated manifest/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const forgedManifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  const forgedLock = JSON.parse(await readFile(path.join(project, "deherm.lock"), "utf8"));
  forgedManifest.inputs.scriptDispatchSha256 = "0".repeat(64);
  forgedLock.inputs.scriptDispatchSha256 = "0".repeat(64);
  await writeFile(path.join(output.root, "manifest.json"), `${JSON.stringify(forgedManifest, null, 2)}\n`);
  await writeFile(path.join(project, "deherm.lock"), `${JSON.stringify(forgedLock, null, 2)}\n`);
  await assert.rejects(verifyGeneratedProject(project), /do not match this installed deherm package/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const escaped = await mkdtemp(path.join(tmpdir(), "deherm-escaped-ir-"));
  const escapedDispatch = path.join(escaped, "script-scalar-dispatch.json");
  await writeFile(escapedDispatch, await readFile(dispatchPath));
  await unlink(dispatchPath);
  await symlink(escapedDispatch, dispatchPath);
  await assert.rejects(verifyGeneratedProject(project), /must be a regular file, not a symlink/);
  await unlink(dispatchPath);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  await rm(escaped, { recursive: true, force: true });

  await writeFile(path.join(output.root, "sdk", "modules", "stale.ts"), "export {};\n");
  await writeFile(path.join(output.root, "sdk", "generated", "stale.ts"), "export {};\n");
  await writeFile(path.join(output.root, "sdk", "contexts", "stale.ts"), "export {};\n");
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  await assert.rejects(readFile(path.join(output.root, "sdk", "modules", "stale.ts"), "utf8"));
  await assert.rejects(readFile(path.join(output.root, "sdk", "generated", "stale.ts"), "utf8"));
  await assert.rejects(readFile(path.join(output.root, "sdk", "contexts", "stale.ts"), "utf8"));

  const guiContextPath = path.join(output.root, "sdk", "contexts", "gui.ts");
  await writeFile(guiContextPath, `${await readFile(guiContextPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /sdk\/contexts\/gui\.ts does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  const guiConfigPath = path.join(project, "tsconfig.deherm.gui.json");
  await writeFile(guiConfigPath, `${await readFile(guiConfigPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /tsconfig\.deherm\.gui\.json does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const config = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.json"), "utf8"));
  assert.deepEqual(config.references.map(({ path: reference }) => reference), [
    "./tsconfig.deherm.shared.json",
    "./tsconfig.deherm.game-object.json",
    "./tsconfig.deherm.gui.json",
    "./tsconfig.deherm.render.json"
  ]);
  const baseConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.base.json"), "utf8"));
  assert.equal(baseConfig.compilerOptions.plugins[0].transform, "@ts-defold/deherm/ttsc");
  assert.equal(baseConfig.compilerOptions.plugins[0].enabled, false);
  const guiConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.gui.json"), "utf8"));
  assert.deepEqual(guiConfig.include, ["**/*.ts", ".deherm/**/*.ts"]);
  assert.deepEqual(guiConfig.exclude, ["**/*.script.ts", "**/*.render.ts", "node_modules/**", ".internal/**", "build/**", "dist/**", ".deherm/generated/components/registry.ts"]);
  assert.deepEqual(guiConfig.compilerOptions.paths["@deherm/project"], ["./.deherm/sdk/contexts/gui.ts"]);
  const contextManifest = JSON.parse(await readFile(path.join(output.root, "script-contexts.json"), "utf8"));
  assert.equal(contextManifest.source, "defold-binding-lowering-plan.contract.context");
  assert.equal(contextManifest.routeCount, 926);
  assert.ok(contextManifest.unknownContextTokens.includes("script-instance"));
  assert.ok(contextManifest.unknownContextTokens.includes("captured-script-instance"));
  assert.equal(contextManifest.unresolvedPolicy.routeCount, contextManifest.routeContextCounts.unresolved);
  assert.equal(contextManifest.contexts.gui.suffix, ".gui.ts");
  assert.equal(contextManifest.contexts.render.suffix, ".render.ts");
  assert.ok(contextManifest.contexts.gui.namespaces.includes("gui"));
  assert.ok(!contextManifest.contexts.shared.namespaces.includes("gui"));
  assert.ok(contextManifest.contexts.render.namespaces.includes("render"));
  assert.ok(!contextManifest.contexts["game-object"].namespaces.includes("render"));
  assert.match(await readFile(path.join(output.root, "sdk", "contexts", "game-object.ts"), "utf8"), /projectExtensions = \{/);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, ".vscode", "extensions.json"), "utf8")), {
    recommendations: ["samchon.ttsc"]
  });

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--build", path.join(project, "tsconfig.deherm.json"), "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("project binding identities survive normalized-name collisions and reserved parameters", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  inventory.extensions[0].scriptApis[0].declarations.push(
    {
      name: "my_ext",
      type: "table",
      members: [{
        name: "invoke",
        type: "function",
        parameters: [
          { name: "function", type: "function" },
          { name: "default", type: "number" },
          { name: "var", type: "string" }
        ]
      }]
    },
    { name: "myExt", type: "table", members: [{ name: "ping", type: "function" }] },
    { name: "project_extensions", type: "table", members: [{ name: "ping", type: "function" }] }
  );

  const ir = buildProjectBindingIr(inventory);
  const colliding = ir.modules.filter(({ runtimeName }) => runtimeName === "my_ext" || runtimeName === "myExt");
  assert.equal(colliding.length, 2);
  assert.equal(new Set(colliding.map(({ jsName }) => jsName)).size, 2);
  assert.equal(new Set(colliding.map(({ typeName }) => typeName)).size, 2);
  assert.ok(colliding.every(({ jsName }) => /^myExt_[a-f0-9]{8}$/.test(jsName)));
  assert.deepEqual(
    colliding.find(({ runtimeName }) => runtimeName === "my_ext").members[0].parameters.map(({ jsName }) => jsName),
    ["callback", "defaultValue", "value"]
  );
  const reserved = ir.modules.find(({ runtimeName }) => runtimeName === "project_extensions");
  assert.match(reserved.jsName, /^projectExtensions_[a-f0-9]{8}$/);

  const output = await writeGeneratedProject(inventory);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  for (const module of colliding) {
    assert.match(index, new RegExp(`export \\{ ${module.jsName} \\} from "\\./modules/${module.fileName}\\.js"`));
    await readFile(path.join(output.root, "sdk", "modules", `${module.fileName}.ts`), "utf8");
  }
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--build", path.join(project, "tsconfig.deherm.json"), "--pretty", "false", "--force"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("project generation uses an input key and does not rewrite current outputs", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  const first = await writeGeneratedProject(inventory);
  assert.equal(first.cached, false);
  const manifestPath = path.join(first.root, "manifest.json");
  const before = await stat(manifestPath);
  const second = await writeGeneratedProject(inventory);
  const after = await stat(manifestPath);
  assert.equal(second.cached, true);
  assert.equal(second.generationKey, first.generationKey);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("script context projection requires an exact route-id bijection and records unknown tokens as unresolved", async () => {
  const scriptIr = JSON.parse(await readFile(path.resolve("bindings/generated/defold-script-api-ir.json"), "utf8"));
  const loweringPlan = JSON.parse(await readFile(path.resolve("bindings/generated/defold-binding-lowering-plan.json"), "utf8"));
  const scriptUnits = loweringPlan.units.filter(({ identity }) => identity.surface === "script");
  assert.throws(() => buildScriptContextCapabilities(scriptIr, { ...loweringPlan, schemaVersion: 1 }), /schema v2/);
  const duplicated = structuredClone(loweringPlan);
  const first = scriptUnits[0].identity.id;
  const omitted = scriptUnits.at(-1).identity.id;
  duplicated.units.find(({ identity }) => identity.surface === "script" && identity.id === omitted).identity.id = first;
  delete duplicated.planSha256;
  duplicated.planSha256 = createHash("sha256").update(JSON.stringify(duplicated)).digest("hex");
  assert.throws(() => buildScriptContextCapabilities(scriptIr, duplicated), /duplicate route id|exactly match/i);

  const unknown = structuredClone(loweringPlan);
  unknown.units.find(({ identity }) => identity.surface === "script").contract.context = "future-context-token";
  delete unknown.planSha256;
  unknown.planSha256 = createHash("sha256").update(JSON.stringify(unknown)).digest("hex");
  const projected = buildScriptContextCapabilities(scriptIr, unknown);
  assert.ok(projected.unknownContextTokens.includes("future-context-token"));
  assert.ok(projected.routeContextCounts.unresolved > 0);
});

test("suffix projects type-check legal APIs and reject APIs from other Defold contexts", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  await writeGeneratedProject(inventory);
  const sourceRoot = path.join(project, "src");
  await mkdir(sourceRoot, { recursive: true });
  const componentRoot = path.join(project, "components", "ui");
  await mkdir(componentRoot, { recursive: true });
  const sources = {
    "utility.ts": "export const sharedValue = true;\n",
    "shared.ts": 'import { vmath } from "@deherm/project"; void vmath;\n',
    "player.script.ts": 'import { go, vmath } from "@deherm/project"; import { sharedValue } from "./utility.js"; void go; void vmath; void sharedValue;\n',
    "hud.gui.ts": 'import { go, gui, vmath } from "@deherm/project"; import { sharedValue } from "./utility.js"; void go.PLAYBACK_ONCE_FORWARD; void gui; void vmath; void sharedValue;\n',
    "legacy.gui_script.ts": 'import { gui } from "@deherm/project"; void gui;\n',
    "main.render.ts": 'import { render, vmath } from "@deherm/project"; void render; void vmath;\n'
  };
  for (const [name, source] of Object.entries(sources)) await writeFile(path.join(sourceRoot, name), source);
  await writeFile(path.join(componentRoot, "menu.gui.ts"), 'import { gui } from "@deherm/project"; void gui;\n');
  await writeFile(path.join(project, "bootstrap.script.ts"), 'import { go } from "@deherm/project"; void go;\n');

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const compile = (...arguments_) => spawnSync(process.execPath, [tsc, ...arguments_, "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const legal = compile("--build", path.join(project, "tsconfig.deherm.json"), "--force");
  assert.equal(legal.status, 0, `${legal.stdout}\n${legal.stderr}`);
  const cliTypecheck = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(cliTypecheck.status, 0, `${cliTypecheck.stdout}\n${cliTypecheck.stderr}`);
  assert.equal(JSON.parse(cliTypecheck.stdout).passed, true);

  const negativeCases = [
    ["player.script.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.game-object.json", "gui"],
    ["hud.gui.ts", 'import { render } from "@deherm/project"; void render;\n', "tsconfig.deherm.gui.json", "render"],
    ["main.render.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.render.json", "gui"],
    ["shared.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.shared.json", "gui"],
    ["shared.ts", 'import { gui } from "@deherm/project/generated/script/modules"; void gui;\n', "tsconfig.deherm.shared.json", "@deherm/project/generated"],
    ["shared.ts", 'import { gui } from "@deherm/project/contexts/gui"; void gui;\n', "tsconfig.deherm.shared.json", "@deherm/project/contexts"]
  ];
  for (const [name, invalidSource, config, symbol] of negativeCases) {
    const target = path.join(sourceRoot, name);
    const original = sources[name];
    await writeFile(target, invalidSource);
    const rejected = compile("--project", path.join(project, config), "--noEmit");
    assert.notEqual(rejected.status, 0, `${name} unexpectedly accepted ${symbol}`);
    assert.match(rejected.stdout + rejected.stderr, symbol.startsWith("@") ? /cannot find module/i : new RegExp(`no exported member '${symbol}'`, "i"));
    await writeFile(target, original);
  }

  const boundaryCases = [
    ["shared.ts", 'import { gui } from "../.deherm/sdk/contexts/gui.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "../.deherm/sdk/contexts/../contexts/gui.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "../.deherm/sdk/generated/script/modules.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "@deherm/project/contexts/gui"; void gui;\n', /private deep import/],
    ["shared.ts", 'import { gui } from "@ts-defold/deherm"; void gui;\n', /bypasses the context-filtered/],
    ["hud.gui.ts", 'import { playerOnly } from "./player.script.js"; void playerOnly;\n', /gui source cannot import game-object source/]
  ];
  await writeFile(path.join(sourceRoot, "player.script.ts"), "export const playerOnly = true;\n");
  for (const [name, invalidSource, message] of boundaryCases) {
    const target = path.join(sourceRoot, name);
    const original = await readFile(target, "utf8");
    await writeFile(target, invalidSource);
    const rejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(rejected.status, 1, `${name} unexpectedly crossed the authored context boundary`);
    const diagnostic = JSON.parse(rejected.stdout);
    assert.equal(diagnostic.passed, false);
    assert.match(diagnostic.stderr, message);
    await writeFile(target, original);
  }

  await writeFile(path.join(sourceRoot, "barrel.ts"), 'export { gui } from "@ts-defold/deherm";\n');
  await writeFile(path.join(sourceRoot, "shared.ts"), 'import { gui } from "./barrel.js"; void gui;\n');
  const reexportRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(reexportRejected.status, 1, "shared barrel unexpectedly re-exported the package-root SDK");
  assert.match(JSON.parse(reexportRejected.stdout).stderr, /barrel\.ts:1:.*bypasses the context-filtered/);
  await writeFile(path.join(sourceRoot, "barrel.ts"), "export const barrel = true;\n");
  await writeFile(path.join(sourceRoot, "shared.ts"), sources["shared.ts"]);

  const outsideGui = path.join(componentRoot, "menu.gui.ts");
  await writeFile(outsideGui, 'import { render } from "@deherm/project"; void render;\n');
  const outsideRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(outsideRejected.status, 1, "GUI resource outside src unexpectedly used render APIs");
  assert.match(JSON.parse(outsideRejected.stdout).stdout, /no exported member 'render'/i);
  await writeFile(outsideGui, 'import { gui } from "@deherm/project"; void gui;\n');

  const contextEntry = path.join(project, ".deherm", "sdk", "contexts", "gui.ts");
  await writeFile(contextEntry, `${await readFile(contextEntry, "utf8")} `);
  const staleRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(staleRejected.status, 1);
  assert.match(staleRejected.stderr, /does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  await writeFile(path.join(sourceRoot, "hud.gui.ts"), 'import { playerOnly } from "./player.script.js"; void playerOnly;\n');
  const crossContext = compile("--project", path.join(project, "tsconfig.deherm.gui.json"), "--noEmit");
  assert.notEqual(crossContext.status, 0, "GUI project unexpectedly accepted a game-object script import");
  assert.match(crossContext.stdout + crossContext.stderr, /not listed within the file list of project|must list all files/i);
});

test("generation migrates only the exact legacy generated root tsconfig", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "tsconfig.json"), `${JSON.stringify({ extends: "./tsconfig.deherm.json" }, null, 2)}\n`);
  const inventory = await inspectDefoldProject({ project });
  const migrated = await writeGeneratedProject(inventory);
  assert.equal(migrated.created.tsconfig, false);
  assert.equal(migrated.migrated.tsconfig, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(project, "tsconfig.json"), "utf8")),
    JSON.parse(await readFile(path.join(project, "tsconfig.deherm.json"), "utf8"))
  );

  await writeFile(path.join(project, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: false }, include: ["custom/**/*.ts"] }, null, 2)}\n`);
  const preserved = await writeGeneratedProject(inventory);
  assert.equal(preserved.migrated.tsconfig, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, "tsconfig.json"), "utf8")), {
    compilerOptions: { strict: false },
    include: ["custom/**/*.ts"]
  });
});

test("typecheck command fails cleanly before generation", async () => {
  const project = await fixture();
  const result = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run 'deherm generate' first/);
});

test("project generation rejects output outside the project", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  await assert.rejects(
    writeGeneratedProject(inventory, "../outside"),
    /subdirectory of the Defold project/
  );
});

test("project inspection derives per-platform engine profiles from Defold's app manifest", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [physics, box2d_defold, script_box2d_defold]
      libs: [physics_2d, box2d, script_box2d, physics_3d]
  wasm-web:
    context:
      excludeLibs: [physics, box2d, box2d_defold, script_box2d, script_box2d_defold]
      excludeSymbols: [ScriptBox2DExt]
      libs: [physics_3d]
  x86_64-linux:
    context:
      excludeLibs: [physics, LinearMath, BulletDynamics, BulletCollision]
      libs: [physics_2d_defold]
`);

  const inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.source, "app-manifest");
  assert.equal(inventory.engineProfiles.manifest, "game.appmanifest");
  assert.match(inventory.engineProfiles.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.engineProfiles.defaultProfileId, "default-legacy-bullet");
  assert.deepEqual(inventory.engineProfiles.platforms, {
    "arm64-ios": "v3-bullet",
    "wasm-web": "bullet-only",
    "x86_64-linux": "legacy-no-bullet"
  });

  const output = await writeGeneratedProject(inventory);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.engineProfiles.platforms, inventory.engineProfiles.platforms);
});

test("project inspection rejects contradictory app-manifest physics selections", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: []
      libs: [physics_2d_defold, physics_2d, script_box2d]
`);
  await assert.rejects(inspectDefoldProject({ project }), /both legacy Box2D and Box2D v3/);
});

test("a uniform app manifest becomes the project default API profile", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [physics, LinearMath, BulletDynamics, BulletCollision, script_box2d_defold]
      libs: [physics_2d, box2d, script_box2d]
`);
  const inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.platforms["arm64-ios"], "v3-no-bullet");
  assert.equal(inventory.engineProfiles.defaultProfileId, "v3-no-bullet");
});

test("project profile resolution respects extension-symbol removal and rejects partial Box2D replacement", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeSymbols: [ScriptBullet3DExt]
      excludeLibs: []
      libs: []
`);
  let inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.platforms["arm64-ios"], "legacy-no-bullet");

  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [script_box2d_defold]
      libs: []
`);
  await assert.rejects(inspectDefoldProject({ project }), /without selecting Box2D v3/);
});

test("project inspection rejects app manifests outside the project", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = ../outside.appmanifest\n`);
  await assert.rejects(inspectDefoldProject({ project }), /inside the Defold project/);
});

test("project profile resolution agrees with all six pinned Defold app-manifest choices", async () => {
  const root = path.resolve("upstream/defold/editor/test/resources/test_project/app_manifest");
  const fixtures = {
    "default.appmanifest": "default-legacy-bullet",
    "physics_box2dv3_3d.appmanifest": "v3-bullet",
    "exclude_physics_3d.appmanifest": "legacy-no-bullet",
    "physics_2d_box2dv3.appmanifest": "v3-no-bullet",
    "exclude_physics_2d.appmanifest": "bullet-only",
    "exclude_physics.appmanifest": "no-physics"
  };
  for (const [manifest, expected] of Object.entries(fixtures)) {
    const resolved = await resolveEngineProfiles(root, { native_extension: { app_manifest: manifest } });
    assert.ok(Object.keys(resolved.platforms).length > 0, `${manifest} has no resolved platforms`);
    assert.deepEqual(new Set(Object.values(resolved.platforms)), new Set([expected]), manifest);
  }
});
